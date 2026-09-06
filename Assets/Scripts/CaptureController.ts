import { CameraFeed, Rect } from "./CameraFeed";
import { InSituUI } from "./InSituUI";
import { Board } from "./Board";
import { TEMPLATES, templateByName, Slot } from "./Templates";
import { Store, StoredItem } from "./Store";
import { nameOf } from "./ColorNames";
import { TypeLibrary } from "./TypeLibrary";
import { TypeVision, TypeReading } from "./TypeVision";
import { SvgExport, ExportItem } from "./SvgExport";
import { Uploader } from "./Uploader";
import { EmailPrompt } from "./EmailPrompt";

/**
 * "" is a real state, not a missing one: nothing is selected yet.
 *
 * The Lens used to open with the colour tool already armed, which quietly decided for
 * the wearer what their first gesture would mean - and the welcome card teaches three
 * tools, so having one of them pre-chosen contradicted the thing it had just said.
 */
export type ShapeMode = "" | "rect" | "circle" | "texture";

export type Capture = {
  id: number;             // stable identity; slot+hex is not unique enough to match on
  kind: "tile" | "swatch" | "type";
  rect: Rect;              // normalized screen space
  hex?: string;            // swatch only
  texture?: Texture;       // tile only
  createdAt: number;
  slot?: number;
  free?: Rect;            // board-space rect on a blank board
  uv?: Rect;              // window into `texture`; identity for cropped tiles
  tiling?: boolean;       // a mirrored material sample rather than an object cutout
  family?: string;        // typeface name, for a type specimen
  placed?: boolean;
  jpeg?: string;          // base64, filled asynchronously after a tile capture
};

/**
 * Drives both capture gestures from one pointer path.
 * Preview: mouse drag. Device: pinch drag (same events).
 *
 *   rect   -> cuts an object out of the world as a tile
 *   circle -> pulls the colour off a surface as a swatch
 */
@component
export class CaptureController extends BaseScriptComponent {

  @input ui: InSituUI;
  @input board: Board;
  @input types: TypeLibrary;

  @input
  @hint("Wipe the saved board on start. Dev only.")
  clearOnStart: boolean = false;

  @input
  @hint("Show the welcome card every start, without touching the board. For rehearsing.")
  replayIntro: boolean = false;

  @input
  @hint("Board server base URL, e.g. https://insitu.vercel.app")
  endpoint: string = "";

  @input
  @hint("Which board this Lens writes to. Your view page is <endpoint>/b/<key>.")
  boardKey: string = "board";

  @input
  @hint("Pre-fill the remembered address. Dev convenience; leave blank to be prompted.")
  seedEmail: string = "";

  private readonly OUTLINE = new vec4(1.0, 0.98, 0.94, 1.0);
  private ringHex = "";
  private ringAt = 0;

  /**
   * The sampled colour, lifted until it can be seen.
   *
   * A ring showing a near-black wall in near-black is a ring you cannot find, and on an
   * additive display it is worse than that - dark adds no light at all, so the outline
   * would simply vanish against the thing it is measuring. Hue and its relationship to
   * the surface survive; only the brightness is a lie, and it is a lie in the one
   * direction that keeps the ring visible.
   */
  private static readableRing(hex: string): vec4 {
    const c = InSituUI.hexToVec4(hex);
    const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    if (lum >= 0.45) return c;
    const k = 0.45 / Math.max(0.04, lum);
    return new vec4(Math.min(1, c.r * k), Math.min(1, c.g * k),
                    Math.min(1, c.b * k), 1);
  }

  private feed: CameraFeed;
  private mode: ShapeMode = "";
  private dragging = false;
  private start: vec2 = null;
  private current: vec2 = null;
  private captures: Capture[] = [];
  private nextId = 1;
  private carrying = -1;          // index into captures, or -1
  private carryStart: vec2 = null;
  private chooserKind = "";       // "" | "email" | "template"
  private pressAt = 0;            // when the current press started
  private pressPos: vec2 = null;
  private draggingOffBoard = -1;  // capture index being pulled off the board
  private pressFromTray = false;
  private lastPointer: vec2 = null;
  /** One-shot: the next rectangle is read for type instead of becoming a tile. */
  private readingType = false;
  private reading: TypeReading = null;

  /** Hold this long on a tray item, without dragging it, to delete it. */
  private readonly HOLD_SECONDS = 0.6;
  /** Show the badge before the action arms, so the hold is discoverable. */
  private readonly HOLD_HINT = 0.22;
  private readonly HOLD_SLOP = 0.04;
  private chooserCount = 0;
  private pendingSvg = "";

  onAwake() {
    this.mode = "";   // nothing armed until a tool is chosen
    this.createEvent("OnStartEvent").bind(() => this.start_());
  }

  private start_() {
    this.feed = new CameraFeed();
    Store.resume();
    if (this.clearOnStart) Store.clearAll();   // rehearsal switch: replays onboarding
    if (this.seedEmail && !Store.getEmail()) Store.setEmail(this.seedEmail);
    this.restoreBoard();

    this.feed.onReady(() => {
      print("[Capture] feed ready - draw to capture");
      this.feed.debugSweep();
      // only once the camera is live, or the card sits over a black frame
      // Replaying the intro used to mean wiping the board, which is a poor trade when
      // the board is the thing you spent ten minutes building to film.
      if (this.replayIntro || !Store.seen("intro")) {
        this.ui.showIntro(this.types ? this.types.fontAt(0) : null);
      }
    });

    this.createEvent("TouchStartEvent").bind((e) => this.onDown(e.getTouchPosition()));
    this.createEvent("TouchMoveEvent").bind((e) => this.onMove(e.getTouchPosition()));
    this.createEvent("TouchEndEvent").bind((e) => this.onUp(e.getTouchPosition()));

    this.createEvent("UpdateEvent").bind(() => this.onUpdate());

    if (this.ui) this.ui.renderModeChips(this.mode);
    print("[Capture] mode=" + this.mode);
  }

  private onUpdate() {
    if (!this.ui) return;
    this.ui.renderModeChips(this.mode);   // cheap: returns immediately unless something moved
    this.ui.tickToast();
    this.ui.tickFlash();

    if (this.ui.introVisible()) {
      this.ui.showIntro(this.types ? this.types.fontAt(0) : null);   // no-op unless the plane moved
    }

    if (this.pendingHint && getTime() >= this.pendingHintAt) {
      this.ui.showToast(this.pendingHint);
      this.pendingHint = "";
    }

    // holding a tray item: show what letting go will do
    if (this.carrying >= 0 && this.pressFromTray && this.pressPos) {
      const held = getTime() - this.pressAt;
      const cur = this.lastPointer;
      const moved = cur
        ? Math.sqrt((cur.x - this.pressPos.x) * (cur.x - this.pressPos.x) +
                    (cur.y - this.pressPos.y) * (cur.y - this.pressPos.y))
        : 0;
      if (held >= this.HOLD_HINT && moved <= this.HOLD_SLOP) {
        const vis = this.visible();
        let slot = -1;
        for (let i = 0; i < vis.length; i++) if (vis[i] === this.carrying) { slot = i; break; }
        if (slot >= 0) {
          this.ui.hideGhost();
          this.ui.showDeleteBadge(slot, vis.length, held >= this.HOLD_SECONDS);
          return;
        }
      }
      this.ui.hideDeleteBadge();
    } else {
      this.ui.hideDeleteBadge();
    }

    const r = this.getDragRect();
    if (!r) { this.ui.clearOutline(); this.ringHex = ""; return; }

    // Drawing an outline with no tool armed would promise a capture that is not going
    // to happen. Better to draw nothing and let the empty chip row explain itself.
    if (!this.mode) { this.ui.clearOutline(); return; }

    const pts = this.mode === "circle"
      ? InSituUI.circlePoints(r)
      : this.mode === "texture"
        ? InSituUI.hexPoints(r)
        : InSituUI.rectPoints(r);

    /*
     * The colour ring wears the colour it is about to take.
     *
     * Drawing a circle used to give the same bone-white outline whatever was under it,
     * so the only way to find out what you had sampled was to let go and read the
     * toast - and then delete it and try again if it was the shadow rather than the
     * wall. Tinting the ring live turns sampling into aiming.
     *
     * Throttled: `sampleColor` reads pixels, and it does not need to run every frame to
     * feel immediate.
     */
    let ink = this.OUTLINE;
    if (this.mode === "circle" && r.w > 0.02 && r.h > 0.02) {
      const now = getTime();
      if (now - this.ringAt > 0.08) {
        this.ringAt = now;
        this.ringHex = this.feed.sampleColor(r).hex;
      }
      if (this.ringHex) ink = CaptureController.readableRing(this.ringHex);
    }
    this.ui.setOutline(pts, ink, this.mode === "circle" ? 0.62 : 0.5);
  }

  /** Indices of captures still sitting in the tray. */
  private visible(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.captures.length; i++) {
      if (!this.captures[i].placed) out.push(i);
    }
    return out;
  }

  private static FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

  /**
   * Say a thing once, the first time it becomes true, and never again.
   *
   * A card at start-up is forgotten by the second gesture. What people actually need is
   * the next step named at the moment it becomes the next step - so the hint about
   * dragging arrives when there is finally something to drag, and the one about layouts
   * when the board first has anything to lay out. Queued behind whatever toast is
   * already showing, so a capture still reports itself first.
   */
  private hintOnce(key: string, msg: string) {
    if (Store.seen("hint." + key)) return;
    Store.markSeen("hint." + key);
    this.pendingHint = msg;
    this.pendingHintAt = getTime() + 1.6;
  }

  private pendingHint = "";
  private pendingHintAt = 0;

  /** Remove a capture for good. Only reachable from the tray, never from the board. */
  private deleteCapture(idx: number) {
    if (idx < 0 || idx >= this.captures.length) return;
    const c = this.captures[idx];
    this.captures.splice(idx, 1);
    print("[Capture] deleted " + c.kind + (c.hex ? " " + c.hex : "")
          + "   remaining=" + this.captures.length);
    this.ui.showToast("Deleted");
    this.refreshTray();
    this.saveBoard();
  }

  private indexOfPlaced(pl: any): number {
    for (let i = 0; i < this.captures.length; i++) {
      if (this.captures[i].id === pl.id) return i;
    }
    return -1;
  }

  private asItem(c: Capture) {
    return { id: c.id, hex: c.hex, texture: c.texture,
             crop: c.uv ? c.uv : c.rect, family: c.family,
             tiling: !!c.tiling };
  }

  private refreshTray() {
    if (!this.ui) return;
    this.ui.renderTray(this.visible().map((i) => {
      const c = this.captures[i];
      // a specimen has no pixels; show it as a pale card so it reads as "type"
      return c.kind === "type"
        ? { hex: "#efece6", texture: undefined, crop: c.rect }
        : this.asItem(c);
    }));
  }

  setMode(m: ShapeMode) {
    this.mode = m;
    if (this.ui) this.ui.renderModeChips(m);
    print("[Capture] mode=" + m);
  }

  private static inRect(p: vec2, r: Rect): boolean {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  private busy(): boolean {
    return !!this.board && this.board.isPlacing();
  }

  private swallowUp = false;

  private onDown(p: vec2) {
    if (this.busy()) return;
    if (this.ui.introVisible()) {
      this.ui.hideIntro();
      Store.markSeen("intro");
      // the press that dismissed the card must not also start a capture
      this.swallowUp = true;
      // First run: hang the board before asking anyone to fill it. A board that is
      // merely "already in front of you" is a board nobody chose the place for.
      if (!Store.hasPose()) this.hangBoard();
      return;
    }
    // An open chooser owns the pointer: its lower rows overlap the tray, and grabbing
    // a tray item here made the third layout unselectable whenever the tray was full.
    // Still record the press - onUp needs `dragging` set to reach the chooser at all.
    if (this.chooserKind) {
      this.dragging = true;
      this.start = p;
      this.current = p;
      return;
    }
    this.pressAt = getTime();
    this.pressPos = p;
    this.lastPointer = p;

    // an item already on the board can be pulled back off it
    this.pressFromTray = false;

    if (this.board) {
      const onBoard = this.board.pickAt(p);
      if (onBoard) {
        const idx = this.indexOfPlaced(onBoard);
        if (idx >= 0) {
          this.board.removePlaced(onBoard);
          this.captures[idx].placed = false;
          this.captures[idx].slot = undefined;
          this.carrying = idx;
          this.draggingOffBoard = idx;
          this.ui.setGhost(this.asItem(this.captures[idx]), p);
          this.refreshTray();
          return;
        }
      }
    }

    const hit = this.ui ? this.ui.trayHitTest(p) : -1;
    if (hit >= 0) {
      const idx = this.visible()[hit];
      if (idx !== undefined) {
        this.carrying = idx;
        this.carryStart = p;
        this.pressFromTray = true;
        this.ui.setGhost(this.asItem(this.captures[idx]), p);
        return;
      }
    }
    this.dragging = true;
    this.start = p;
    this.current = p;
  }

  private onMove(p: vec2) {
    if (this.busy()) return;
    this.lastPointer = p;
    if (this.carrying >= 0) {
      this.ui.setGhost(this.asItem(this.captures[this.carrying]), p);
      if (this.board) {
        const kind = this.captures[this.carrying].kind;
        this.board.highlight(this.board.slotHitTest(p, kind));
      }
      return;
    }
    if (!this.dragging) return;
    this.current = p;
  }

  private onUp(p: vec2) {
    if (this.busy()) return;
    if (this.swallowUp) { this.swallowUp = false; return; }
    if (this.carrying >= 0) {
      const cap = this.captures[this.carrying];

      // held still on a tray item: delete it outright
      const held = getTime() - this.pressAt;
      const moved = this.pressPos
        ? Math.sqrt((p.x - this.pressPos.x) * (p.x - this.pressPos.x) +
                    (p.y - this.pressPos.y) * (p.y - this.pressPos.y))
        : 1;
      this.ui.hideDeleteBadge();
      if (this.pressFromTray && held >= this.HOLD_SECONDS && moved <= this.HOLD_SLOP) {
        this.deleteCapture(this.carrying);
        this.ui.hideGhost();
        this.carrying = -1;
        this.pressFromTray = false;
        return;
      }

      const slot = this.board ? this.board.slotHitTest(p, cap.kind) : -1;
      if (slot === -2) {
        // blank board: it lands exactly where it was let go
        const free = this.board.freeRectAt(p, cap.kind === "swatch");
        if (free) {
          this.board.place(-1, this.asItem(cap), p, true, free);
          cap.placed = true;
          cap.slot = -1;
          cap.free = free;
          print("[Capture] dropped " + cap.kind + " freely at "
                + free.x.toFixed(2) + "," + free.y.toFixed(2));
          this.saveBoard();
        }
        this.ui.hideGhost();
        this.carrying = -1;
        this.pressFromTray = false;
        this.refreshTray();
        return;
      }
      if (slot === -3) {
        // slotted board: it is taken and the layout re-solves around it
        this.board.place(-1, this.asItem(cap), p);
        cap.placed = true;
        this.syncSlots();
        print("[Capture] added " + cap.kind + " to " + this.board.getTemplate().name);
        this.saveBoard();
        this.hintOnce("layout", "Menu, then Layout, to rearrange the board");
      } else {
        print("[Capture] released off-board, back to tray");
        if (this.board) this.board.highlight(-1);
      }
      this.draggingOffBoard = -1;
      this.ui.hideGhost();
      this.carrying = -1;
      this.pressFromTray = false;
      this.refreshTray();
      return;
    }

    if (!this.dragging) return;
    this.dragging = false;
    this.current = p;

    if (this.chooserKind) {
      for (let i = 0; i < this.chooserCount; i++) {
        const hit = this.chooserKind === "template"
          ? InSituUI.layoutCardRect(i, this.chooserCount)
          : this.chooserKind === "menu"
            ? this.ui.menuCardRect(i, this.chooserCount)
            : InSituUI.chooserRect(i, this.chooserCount);
        if (!CaptureController.inRect(p, hit)) continue;
        this.ui.flashAt(hit);
        if (this.chooserKind === "email") this.pickDestination(i);
        else if (this.chooserKind === "menu") this.pickMenu(i);
        else if (this.chooserKind === "type") this.pickType(i);
        else if (this.chooserKind === "reading") this.pickReading(i);
        else if (this.chooserKind === "boards") this.pickBoard(i);
        else if (this.chooserKind === "menu2") {
          this.closeChooser();
          if (i === 0) this.deleteBoard();
          return;
        }
        else this.pickTemplate(i);
        return;
      }
      // a tap anywhere else dismisses
      const kind = this.chooserKind;
      this.closeChooser();
      this.ui.showToast(kind === "email" ? "Export cancelled" : "Layout unchanged");
      return;
    }

    const chips = ["rect", "circle", "texture", "menu", "export"];
    for (let c = 0; c < chips.length; c++) {
      const cr = InSituUI.chipRect(chips[c]);
      if (!CaptureController.inRect(p, cr)) continue;
      this.ui.flashAt(cr);
      if (chips[c] === "menu") this.openMenu();
      else if (chips[c] === "export") this.exportBoard();
      else this.setMode(chips[c] as ShapeMode);
      return;
    }

    const r = this.currentRect();
    if (r.w < 0.02 || r.h < 0.02) {
      print("[Capture] too small, ignored");
      return;
    }
    if (!this.feed.isReady()) {
      print("[Capture] feed not ready yet");
      return;
    }

    if (this.readingType) { this.readTypeFrom(r); return; }

    // No tool armed. The old dispatch ended in a bare `else`, so this would have cut an
    // object - the most expensive capture of the three - for someone who had not asked
    // for anything at all.
    if (!this.mode) {
      this.ui.showToast("Pick a tool first");
      return;
    }

    if (this.mode === "circle") this.commitSwatch(r);
    else if (this.mode === "texture") this.commitTexture(r);
    else this.commitTile(r);
    this.hintOnce("drag", "Now drag it up onto the board");
  }

  /** Normalized screen rect from the two drag corners. */
  private currentRect(): Rect {
    const x0 = Math.min(this.start.x, this.current.x);
    const y0 = Math.min(this.start.y, this.current.y);
    const x1 = Math.max(this.start.x, this.current.x);
    const y1 = Math.max(this.start.y, this.current.y);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * A small circle picks one colour; a large one pulls the whole palette out of what
   * it encloses. Same gesture, scaled — sampling a point versus sampling a region.
   */
  private readonly PALETTE_AREA = 0.035;

  private commitSwatch(r: Rect) {
    if (r.w * r.h >= this.PALETTE_AREA) { this.commitPalette(r); return; }
    // sample the middle of the circle, not its bounding box
    const inner: Rect = {
      x: r.x + r.w * 0.35,
      y: r.y + r.h * 0.35,
      w: r.w * 0.30,
      h: r.h * 0.30,
    };
    const c = this.feed.sampleColor(inner);
    this.captures.push({ id: this.nextId++, kind: "swatch", rect: r, hex: c.hex, createdAt: getTime() });
    print("[Capture] SWATCH " + c.hex + " " + nameOf(c.hex)
          + "   total=" + this.captures.length);
    this.ui.showToast(nameOf(c.hex) + "   " + c.hex.toUpperCase());
    this.refreshTray();
  }

  private commitPalette(r: Rect) {
    const hexes = this.feed.extractPalette(r, 5);
    for (let i = 0; i < hexes.length; i++) {
      this.captures.push({
        id: this.nextId++, kind: "swatch", rect: r, hex: hexes[i], createdAt: getTime(),
      });
    }
    const names: string[] = [];
    for (let i = 0; i < hexes.length; i++) names.push(nameOf(hexes[i]));
    print("[Capture] PALETTE " + hexes.join(" ") + "  (" + names.join(", ") + ")");
    this.ui.showToast("Palette: " + names.join("  ·  "));
    this.refreshTray();
  }

  private commitTexture(r: Rect) {
    const tex = this.feed.cropToTileable(r);
    const dominant = this.feed.sampleColor(r);
    const cap: Capture = {
      id: this.nextId++, kind: "tile", rect: r, texture: tex, hex: dominant.hex,
      uv: CaptureController.FULL, tiling: true, createdAt: getTime(),
    };
    this.captures.push(cap);

    (global as any).Base64.encodeTextureAsync(
      tex,
      (enc: string) => { cap.jpeg = enc; },
      () => print("[Capture] texture encode failed - will not persist"),
      CompressionQuality.LowQuality,
      EncodingType.Jpg
    );

    print("[Capture] TEXTURE " + dominant.hex + " " + nameOf(dominant.hex)
          + " tile=" + tex.getWidth() + "x" + tex.getHeight()
          + "   total=" + this.captures.length);
    this.ui.showToast(nameOf(dominant.hex) + " texture");
    this.refreshTray();
  }

  private commitTile(r: Rect) {
    const frozen = this.feed.cropToTexture(r);
    // a tile's average colour is what lets Spectrum sort it alongside swatches
    const dominant = this.feed.sampleColor(r);
    const cap: Capture = {
      id: this.nextId++,
      kind: "tile", rect: r, texture: frozen, hex: dominant.hex,
      uv: CaptureController.FULL, createdAt: getTime(),
    };
    this.captures.push(cap);

    (global as any).Base64.encodeTextureAsync(
      frozen,
      (enc: string) => {
        cap.jpeg = enc;
        print("[Capture] tile encoded, base64 length=" + enc.length);
      },
      () => print("[Capture] tile encode failed - will not persist"),
      CompressionQuality.LowQuality,
      EncodingType.Jpg
    );
    print("[Capture] TILE " + dominant.hex + " " + Math.round(r.w * 100) + "%x" + Math.round(r.h * 100) + "%"
          + " frozen=" + frozen.getWidth() + "x" + frozen.getHeight()
          + "   total=" + this.captures.length);
    this.refreshTray();
  }

  /** Set only by the two actions that are *meant* to empty the board. */
  private clearingOnPurpose = false;

  private saveBoard() {
    if (!this.board) return;
    const items: StoredItem[] = [];
    for (let i = 0; i < this.captures.length; i++) {
      const c = this.captures[i];
      if (!c.placed || c.slot === undefined) continue;
      if (c.kind === "tile" && !c.jpeg) continue;   // encode not back yet
      items.push({
        kind: c.kind,
        tiling: !!c.tiling,
        slot: c.slot,
        hex: c.hex ? c.hex : "",
        crop: new vec4(c.rect.x, c.rect.y, c.rect.w, c.rect.h),
        jpeg: c.jpeg ? c.jpeg : "",
        family: c.family ? c.family : "",
        free: c.free
          ? new vec4(c.free.x, c.free.y, c.free.w, c.free.h)
          : new vec4(0, 0, 0, 0),
      });
    }
    /*
     * Never let an empty board overwrite a saved one that has contents.
     *
     * Watched this destroy a twenty-item board: something brought the Lens up with an
     * empty board, then the next ordinary action - changing the layout - autosaved
     * zero items over the top of it. Every individual step was behaving correctly,
     * which is what made it so quiet. An empty save is only ever legitimate when the
     * user asked for an empty board, so that is the only time it is allowed.
     */
    if (items.length === 0 && !this.clearingOnPurpose && Store.hasBoard()) {
      print("[Capture] refusing to save an empty board over a saved one");
      return;
    }

    let jb = 0;
    for (let i = 0; i < items.length; i++) jb += items[i].jpeg.length;
    print("[Capture] saving " + items.length + " items, jpeg bytes=" + jb);
    Store.save(this.board.getTemplate().name, items);

  }

  private restoreBoard() {
    if (!this.board) return;
    if (!Store.hasBoard()) { print("[Capture] no saved board"); return; }
    print("[Capture] restoring board...");

    // the layout is part of the board - restoring items into the default template
    // silently reverted the board to Contact Sheet on every reload
    const savedTemplate = Store.templateName();
    if (savedTemplate) {
      this.board.setTemplate(templateByName(savedTemplate));
      print("[Capture] restored layout: " + savedTemplate);
    }
    Store.load(
      (it, tex) => {
        const rect: Rect = { x: it.crop.x, y: it.crop.y, w: it.crop.z, h: it.crop.w };
        const cap: Capture = {
          id: this.nextId++,
          kind: it.kind === "type" ? "type" : (it.kind === "tile" ? "tile" : "swatch"),
          tiling: it.tiling,
          family: it.family ? it.family : undefined,
          rect: rect,
          uv: CaptureController.FULL,
          hex: it.hex ? it.hex : undefined,
          texture: tex ? tex : undefined,
          createdAt: getTime(),
          placed: true,
          slot: it.slot,
          jpeg: it.jpeg,          // carry it forward so re-saving keeps this tile
        };
        const freeRect: Rect = (it.free && it.free.z > 0)
          ? { x: it.free.x, y: it.free.y, w: it.free.z, h: it.free.w }
          : null;
        cap.free = freeRect;
        this.captures.push(cap);
        this.board.place(it.slot, this.asItem(cap), new vec2(0.5, 0.5), false, freeRect);
      },
      () => print("[Capture] restore complete")
    );
  }

  private hangBoard() {
    if (!this.board) return;
    this.ui.showToast(this.board.placementHint());
    this.board.hangOnWall((ok) => {
      this.ui.showToast(ok ? "Placed - it will be here next time"
                           : "No wall found - board left where it is");
    });
  }

  /** Compose the placed board into an SVG. */
  exportBoard() {
    if (!this.board) return;
    const items: ExportItem[] = [];
    for (let i = 0; i < this.captures.length; i++) {
      const c = this.captures[i];
      if (!c.placed || c.slot === undefined) continue;
      items.push({
        kind: c.kind,
        slot: c.slot,
        hex: c.hex ? c.hex : "",
        jpeg: c.jpeg ? c.jpeg : "",
        tiling: !!c.tiling,
        family: c.family ? c.family : "",
        note: c.family && this.types ? this.types.noteAt(this.types.indexOfName(c.family)) : "",
      });
    }
    if (items.length === 0) { print("[Export] board is empty"); return; }

    const svg = SvgExport.build(
      this.board.getTemplate(), this.board.getSlots(), items,
      this.board.boardWidth, this.board.boardHeight
    );

    print("[Export] " + this.board.getTemplate().name + ", " + items.length
          + " items, " + svg.length + " chars");

    if (!this.endpoint) {
      // still useful without a server: the file can be recovered from the log
      const CHUNK = 1800;
      const parts = Math.ceil(svg.length / CHUNK);
      print("[Export] no endpoint set - dumping instead. BEGIN " + parts);
      for (let i = 0; i < parts; i++) print("[SVG" + i + "]" + svg.substr(i * CHUNK, CHUNK));
      print("[Export] END");
      if (this.ui) this.ui.showToast("Exported - no server configured");
      return;
    }

    // Saving the link never requires typing - emailing is opt-in. Blocking every
    // export behind a keyboard made the common case the slow one.
    this.pendingSvg = svg;
    const saved = Store.getEmail();
    const lines = saved
      ? ["Just save the link", "Send to " + saved, "Use a different email"]
      : ["Just save the link", "Add an email address"];
    this.chooserKind = "email";
    this.chooserCount = lines.length;
    this.ui.showChooser(lines, 0);
  }

  /** Copy slot assignments back from the board after a reflow. */
  private syncSlots() {
    const placed = this.board.getPlaced();
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      for (let k = 0; k < this.captures.length; k++) {
        if (this.captures[k].id !== p.id) continue;
        this.captures[k].slot = p.slot;
        this.captures[k].free = p.free;
        break;
      }
    }
  }

  private closeChooser() {
    this.chooserKind = "";
    this.chooserCount = 0;
    this.ui.hideChooser();
  }

  /** Board-level actions, kept off the capture bar so the bar stays modes-only. */
  private openMenu() {
    this.chooserKind = "menu";
    this.chooserCount = 6;
    // Short labels, because an arc has no room for sentences - and a menu of six
    // commands never needed them. "Read type from a photo" was describing the
    // mechanism; "Read type" names the thing you get.
    this.ui.showChooser(
      ["Layout", "Add type", "Read type",
       "Place board", "Boards", "Delete board"], -1, true);
  }

  private pickMenu(i: number) {
    this.closeChooser();
    if (i === 0) { this.openTemplatePicker(); return; }
    if (i === 1) { this.openTypePicker(); return; }
    if (i === 2) { this.armTypeReading(); return; }
    if (i === 3) { this.hangBoard(); return; }
    if (i === 4) { this.openBoardPicker(); return; }
    if (i === 5) { this.confirmDeleteBoard(); return; }
  }

  /** Take everything off the board and out of the tray, touching no storage. */
  private emptyWorkingSet() {
    for (let i = 0; i < this.captures.length; i++) {
      const c = this.captures[i];
      if (c.placed) {
        const pl = this.board.pickAtId(c.id);
        if (pl) this.board.removePlaced(pl);
      }
    }
    this.captures = [];
    this.refreshTray();
  }

  /**
   * Every board that exists, and the option of one more.
   *
   * The current board is marked rather than hidden, so the list is a picture of what
   * you have rather than a list of somewhere else to go.
   */
  private openBoardPicker() {
    const ids = Store.boardIds();
    const cur = Store.currentId();
    const lines: string[] = ["New board"];
    let mark = -1;
    for (let i = 0; i < ids.length; i++) {
      const isCur = ids[i] === cur;
      if (isCur) mark = i + 1;
      lines.push("Board " + ids[i] + (isCur ? "   (current)" : ""));
    }
    this.boardIds = ids;
    this.chooserKind = "boards";
    this.chooserCount = lines.length;
    this.ui.showChooser(lines, mark);
  }

  private boardIds: number[] = [];

  private pickBoard(i: number) {
    this.closeChooser();
    if (i === 0) { this.newBoard(); return; }
    const id = this.boardIds[i - 1];
    if (id === undefined || id === Store.currentId()) return;
    this.switchBoard(id);
  }

  /**
   * A second board beside the first, not instead of it.
   *
   * This used to empty the current board, which is a different action wearing the same
   * name - and the destructive one. Starting a second project should no more destroy
   * the first than pinning something to a new wall takes the old wall down.
   */
  private newBoard() {
    this.saveBoard();
    Store.createBoard();
    this.emptyWorkingSet();
    this.board.setTemplate(TEMPLATES[0]);
    this.board.applySavedPose();   // a new board has no wall yet, so it comes to you
    print("[Capture] new board " + Store.currentId());
    this.ui.showToast("Board " + Store.currentId() + " - a fresh wall");
  }

  /** Put this board away and bring another one out. */
  private switchBoard(id: number) {
    this.saveBoard();
    this.emptyWorkingSet();
    Store.switchTo(id);
    this.board.applySavedPose();   // each board keeps its own wall
    this.restoreBoard();
    this.ui.showToast("Board " + id);
  }

  /** Wipe everything, including what is saved and where the board hangs. */
  private deleteBoard() {
    const gone = Store.currentId();
    this.emptyWorkingSet();
    const now = Store.dropCurrent();
    this.board.setTemplate(TEMPLATES[0]);
    this.board.applySavedPose();
    this.restoreBoard();
    print("[Capture] board " + gone + " deleted, now on " + now);
    this.ui.showToast("Board " + gone + " deleted");
  }

  private confirmDeleteBoard() {
    this.chooserKind = "menu2";
    this.chooserCount = 2;
    this.ui.showChooser(["Delete board and saved copy", "Keep it"], 1);
  }

  /**
   * Show every layout as the arrangement it would actually produce.
   *
   * Each card is solved by the real generator against the board's real contents, so
   * what you are choosing between is not seven names but seven pictures of your own
   * board. This is only possible because the templates are generators: a fixed grid
   * could be illustrated once in advance, but "what Bento does with nine images and
   * seven colours" is a question only the generator can answer.
   */
  private openTemplatePicker() {
    if (!this.board) return;
    const current = this.board.getTemplate().name;
    const real = this.board.contentCounts();
    // An empty board solves to nothing, so every card would render blank and the picker
    // would look broken at exactly the moment someone is choosing how to start. Show a
    // representative handful instead - the arrangement is the information here, and
    // once there is anything on the board the previews go back to being literal.
    const empty = real.frames + real.palette === 0;
    const counts = empty ? { frames: 5, palette: 4 } : real;
    const ar = this.board.boardWidth / this.board.boardHeight;

    const names: string[] = [];
    const slotSets: Rect[][] = [];
    const roles: string[][] = [];
    let currentIndex = 0;

    for (let i = 0; i < TEMPLATES.length; i++) {
      const t = TEMPLATES[i];
      if (t.name === current) currentIndex = i;
      names.push(t.name);

      // a blank board has no slots to draw; show a suggestion of scattered pieces
      const solved = t.freeform
        ? CaptureController.freeformPreview(counts.frames + counts.palette)
        : t.build(counts.frames, counts.palette, ar);
      const rs: Rect[] = [], rr: string[] = [];
      for (let k = 0; k < solved.length; k++) {
        rs.push({ x: solved[k].x, y: solved[k].y, w: solved[k].w, h: solved[k].h });
        rr.push(solved[k].role);
      }
      slotSets.push(rs);
      roles.push(rr);
    }

    this.chooserKind = "template";
    this.chooserCount = names.length;
    this.ui.showLayoutPicker(names, slotSets, roles, currentIndex, ar);
  }

  /** A blank board has no solve, so its card shows loosely scattered pieces. */
  private static freeformPreview(n: number): Slot[] {
    const out: Slot[] = [];
    const many = Math.max(3, Math.min(7, n));
    for (let i = 0; i < many; i++) {
      const a = i * 2.399963;
      const r = 0.30 * Math.sqrt((i + 0.5) / many);
      const w = 0.22, h = 0.20;
      out.push({
        x: Math.max(0.02, Math.min(0.98 - w, 0.5 + Math.cos(a) * r - w / 2)),
        y: Math.max(0.02, Math.min(0.98 - h, 0.5 + Math.sin(a) * r - h / 2)),
        w: w, h: h, role: i % 3 === 2 ? "palette" : "frame",
      });
    }
    return out;
  }

  /** Typefaces a board can use. Google Fonts, so the export renders in the real face. */
  private openTypePicker() {
    if (!this.types || this.types.count() === 0) {
      this.ui.showToast("No typefaces loaded");
      return;
    }
    const lines: string[] = [];
    for (let i = 0; i < this.types.count(); i++) lines.push(this.types.labelAt(i));
    this.chooserKind = "type";
    this.chooserCount = lines.length;
    this.ui.showChooser(lines, -1);
  }

  /** Arm a one-shot: draw a rectangle over lettering and it gets read, not captured. */
  private armTypeReading() {
    if (!this.types || this.types.count() === 0) {
      this.ui.showToast("No typefaces loaded");
      return;
    }
    this.readingType = true;
    this.setMode("rect");
    this.ui.showToast("Draw a box over some lettering");
  }

  private readTypeFrom(r: Rect) {
    this.readingType = false;
    if (!this.feed.isReady()) { this.ui.showToast("Camera not ready"); return; }

    // a bigger crop than a board tile: downsampling that is fine for storage would
    // throw away exactly the stroke detail this needs
    const crop = this.feed.cropToTexture(r, 512);
    this.ui.showToast("Reading the lettering...");

    const names: string[] = [];
    for (let i = 0; i < this.types.count(); i++) names.push(this.types.nameAt(i));

    (global as any).Base64.encodeTextureAsync(
      crop,
      (enc: string) => {
        TypeVision.read(
          enc, names,
          (res) => {
            this.reading = res;
            if (res.families.length === 0) {
              this.ui.showToast(res.style ? res.style + " - no close match" : "No match found");
              return;
            }
            print("[Capture] read type: " + res.style + " -> " + res.families.join(", "));
            const lines: string[] = [];
            for (let i = 0; i < res.families.length; i++) lines.push(res.families[i]);
            this.chooserKind = "reading";
            this.chooserCount = lines.length;
            this.ui.showChooser(lines, 0);
            this.ui.showToast(res.style + (res.note ? "  -  " + res.note : ""));
          },
          (msg) => {
            // The gateway can be down or the token stale, and neither is the
            // designer's problem mid-board. Fall back to choosing by hand
            // rather than dead-ending on a toast they can only dismiss.
            print("[Capture] type reading failed: " + msg);
            this.ui.showToast("Could not read that - pick one yourself");
            this.openTypePicker();
          }
        );
      },
      () => this.ui.showToast("Could not encode the crop"),
      CompressionQuality.HighQuality,
      EncodingType.Jpg
    );
  }

  private pickReading(i: number) {
    this.closeChooser();
    if (!this.reading || i >= this.reading.families.length) return;
    const family = this.reading.families[i];
    const idx = this.types.indexOfName(family);
    if (idx >= 0) this.pickTypeAt(idx);
  }

  private pickType(i: number) {
    this.closeChooser();
    this.pickTypeAt(i);
  }

  private pickTypeAt(i: number) {
    const family = this.types.nameAt(i);
    if (!family) return;
    this.captures.push({
      id: this.nextId++, kind: "type", rect: CaptureController.FULL,
      family: family, createdAt: getTime(),
    });
    print("[Capture] TYPE " + family + "   total=" + this.captures.length);
    this.ui.showToast(family);
    this.refreshTray();
    this.saveBoard();
  }

  private pickTemplate(i: number) {
    this.closeChooser();
    if (!this.board || i >= TEMPLATES.length) return;
    this.board.setTemplate(TEMPLATES[i]);
    this.board.reflow();
    this.board.redrawPlaced();
    this.syncSlots();
    this.ui.showToast(TEMPLATES[i].name);
    this.saveBoard();
  }

  /** Row 0 is always "just the link"; the rest depend on whether an address is saved. */
  private pickDestination(i: number) {
    const saved = Store.getEmail();
    this.closeChooser();
    if (i === 0) { this.upload(""); return; }
    if (saved && i === 1) { this.upload(saved); return; }
    this.askForEmail();
  }

  private askForEmail() {
    this.ui.showToast("Type an email, then Done");
    EmailPrompt.ask(
      Store.getEmail(),
      (partial) => this.ui.showToast(partial.length ? partial : "Type an email, then Done"),
      (email) => {
        Store.setEmail(email);
        this.upload(email);
      },
      () => {
        // no usable address - still upload, the board lives at its stable URL
        print("[Export] no email given, sending to the link only");
        this.upload("");
      }
    );
  }

  private upload(email: string) {
    const svg = this.pendingSvg;
    if (!svg) return;
    this.ui.showToast(email ? "Sending to " + email + "..." : "Sending board...");
    Uploader.send(
      this.endpoint, this.boardKey, email, svg,
      (view, mailed, why) => {
        print("[Export] live at " + view + (email ? "  mailed=" + mailed + " (" + why + ")" : ""));
        // never claim an email went out that did not; the link always did
        this.ui.showToast(
          !email ? view.replace("https://", "")
          : mailed ? "Sent to " + email
          : "Saved - email off, open " + view.replace("https://", ""));
      },
      (msg) => {
        print("[Export] upload failed: " + msg);
        this.ui.showToast("Export failed - " + msg);
      }
    );
  }

  getCaptures(): Capture[] { return this.captures; }

  /** Live drag rect for the selection overlay, or null when not dragging. */
  getDragRect(): Rect { return this.dragging ? this.currentRect() : null; }
  getMode(): ShapeMode { return this.mode; }
}
