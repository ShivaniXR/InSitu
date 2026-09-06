import { InSituUI } from "./InSituUI";
import { Rect } from "./CameraFeed";
import { Template, Slot, TEMPLATES, hueOf } from "./Templates";
import { Store } from "./Store";
import { nameOf } from "./ColorNames";
import { TypeLibrary } from "./TypeLibrary";
import { SurfacePlacementController } from "SurfacePlacement.lspkg/Scripts/SurfacePlacementController";
import { PlacementMode, PlacementSettings } from "SurfacePlacement.lspkg/Scripts/PlacementSettings";

export type Placed = {
  id: number;          // identity of the capture this came from
  slot: number;        // -1 on a blank board
  free: Rect;          // board-space rect when there is no slot; null otherwise
  hex?: string;
  texture?: Texture;
  crop?: Rect;
  tiling?: boolean;     // a material sample, which repeats; not a one-off photo
  obj: SceneObject;
  label: SceneObject;   // hex caption for a colour, family name for a typeface
  glyph: SceneObject;   // the family name on a type specimen; null otherwise
  rule: SceneObject;    // hairline between name and style note; null otherwise
  meta: SceneObject;    // family name under the hero glyph; null otherwise
  family: string;       // typeface name; "" for everything else
  // tween
  t: number;
  fromPos: vec3;
  toPos: vec3;
  fromScale: vec3;
  toScale: vec3;
};

/**
 * The composed board: a world-anchored panel carrying template slots.
 *
 * Deliberately NOT parented to the camera — the tray and chips are HUD, the board
 * is a thing hanging in the room. Walk toward it and it grows; step back and you
 * take the whole composition in.
 */
@component
export class Board extends BaseScriptComponent {
  @input ui: InSituUI;
  @input types: TypeLibrary;
  @input camObject: SceneObject;

  @input
  @hint("Board width in cm. ~160 reads as wall scale at conversational distance.")
  boardWidth: number = 160;

  @input boardHeight: number = 105;

  @input
  @hint("Distance in cm from the origin the board is hung at")
  boardDistance: number = 210;

  @input
  @hint("On a floor or table, stand the board up at the hit point instead of laying it flat.")
  standUpright: boolean = true;

  private cam: Camera;
  private root: SceneObject;
  private panel: SceneObject;
  private slotFrames: SceneObject[] = [];
  private placed: Placed[] = [];
  private template: Template = TEMPLATES[0];
  private slots: Slot[] = [];
  private ready = false;
  private hung = false;
  private placing = false;

  private readonly PANEL = new vec4(0.90, 0.89, 0.85, 1);
  private readonly SLOT = new vec4(0.82, 0.81, 0.77, 1);
  private readonly SLOT_HOT = new vec4(0.36, 0.58, 0.60, 1);

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => this.ensureInit());
    this.createEvent("UpdateEvent").bind(() => this.tick());
  }

  ensureInit() {
    if (this.ready) return;
    this.ui.ensureInit();
    this.cam = this.camObject.getComponent("Component.Camera") as Camera;
    if (!this.cam) { print("[Board] no camera"); return; }

    this.root = global.scene.createSceneObject("BoardRoot");

    this.applySavedPose();

    this.panel = this.ui.makeQuad("BoardPanel", this.root);
    this.panel.getTransform().setLocalPosition(new vec3(0, 0, 0));
    this.panel.getTransform().setLocalScale(
      new vec3(this.boardWidth, this.boardHeight, 1));
    this.ui.matOf(this.panel).baseColor = this.PANEL;
    this.dressPanel();

    this.ready = true;
    this.setTemplate(TEMPLATES[0]);
    print("[Board] " + this.boardWidth + "x" + this.boardHeight
          + "cm at " + this.boardDistance + "cm, template=" + this.template.name);
  }

  /** Cycle to the next layout, carrying whatever is already on the board across. */
  nextTemplate(): string {
    let i = 0;
    for (let k = 0; k < TEMPLATES.length; k++) {
      if (TEMPLATES[k].name === this.template.name) { i = k; break; }
    }
    const next = TEMPLATES[(i + 1) % TEMPLATES.length];
    this.setTemplate(next);
    this.reflow();
    return next.name;
  }

  /**
   * Re-seat everything on the board into the current template.
   *
   * Spectrum orders by hue rather than by capture time; the others keep the order
   * things were placed in. Frames and palette slots are filled independently, so a
   * tile never lands in a swatch slot.
   */
  /**
   * Re-solve the layout for the current contents and ease everything into place.
   *
   * Called after every add and remove: the template is a rule, so the arrangement is
   * recomputed rather than items being fitted into a fixed grid. There is no longer
   * any such thing as a full board.
   */
  setTemplate(t: Template) {
    this.ensureInit();
    if (!this.ready) return;

    const old = this.template;
    if (t.freeform && old && !old.freeform) {
      // switching to a blank board keeps the arrangement and simply unlocks it
      for (let i = 0; i < this.placed.length; i++) {
        const pl = this.placed[i];
        if (pl.free) continue;
        const sl = this.slots[pl.slot];
        pl.free = sl ? { x: sl.x, y: sl.y, w: sl.w, h: sl.h }
                     : { x: 0.42, y: 0.42, w: 0.16, h: 0.16 };
        pl.slot = -1;
      }
    } else if (!t.freeform && old && old.freeform) {
      // going back to a layout: hand the positions back to the generator
      for (let i = 0; i < this.placed.length; i++) this.placed[i].free = null;
    }

    this.template = t;
    this.relayout();
  }

  getTemplate(): Template { return this.template; }
  isHung(): boolean { return this.hung; }
  isPlacing(): boolean { return this.placing; }
  isFreeform(): boolean { return !!this.template.freeform; }

  /**
   * Where a screen point lands on the board plane, in normalized board space.
   *
   * Casts the viewer's ray at the board and intersects it rather than inverting a slot
   * projection — a drop needs a position, not a nearest slot.
   */
  screenToBoardUV(p: vec2): vec2 {
    if (!this.ready) return null;
    const camPos = this.camObject.getTransform().getWorldPosition();
    const through = this.ui.worldPointAt(p.x, p.y);
    const dir = through.sub(camPos).normalize();

    const t = this.root.getTransform();
    const origin = t.getWorldPosition();
    const normal = t.forward.normalize();

    const denom = dir.dot(normal);
    if (Math.abs(denom) < 0.0001) return null;
    const dist = origin.sub(camPos).dot(normal) / denom;
    if (dist <= 0) return null;

    const hit = camPos.add(dir.uniformScale(dist));
    const local = t.getInvertedWorldTransform().multiplyPoint(hit);
    return new vec2(local.x / this.boardWidth + 0.5, 0.5 - local.y / this.boardHeight);
  }

  /** Footprint for something dropped on a blank board. */
  freeRectAt(p: vec2, isPalette: boolean): Rect {
    const uv = this.screenToBoardUV(p);
    if (!uv) return null;
    const w = isPalette ? 0.11 : 0.26;
    const h = isPalette ? 0.14 : 0.30;
    return { x: uv.x - w / 2, y: uv.y - h / 2, w: w, h: h };
  }

  /** Which placed item is under this screen point, or null. */
  pickAt(p: vec2): Placed {
    let best: Placed = null;
    let bestD = 0.10;
    for (let i = 0; i < this.placed.length; i++) {
      const it = this.placed[i];
      if (!it.obj.enabled) continue;
      const sp = it.free ? this.freeScreenPos(it) : this.slotScreenPos(it.slot);
      if (!sp) continue;
      const d = Math.sqrt((sp.x - p.x) * (sp.x - p.x) + (sp.y - p.y) * (sp.y - p.y));
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  pickAtId(id: number): Placed {
    for (let i = 0; i < this.placed.length; i++) {
      if (this.placed[i].id === id) return this.placed[i];
    }
    return null;
  }

  /** Take an item off the board. The capture itself survives, in the tray. */
  removePlaced(target: Placed) {
    for (let i = 0; i < this.placed.length; i++) {
      if (this.placed[i] !== target) continue;
      if (target.label) target.label.destroy();
      if (target.glyph) target.glyph.destroy();
      if (target.rule) target.rule.destroy();
      if (target.meta) target.meta.destroy();
      target.obj.destroy();
      this.placed.splice(i, 1);
      this.relayout();
      print("[Board] removed; on board=" + this.placed.length);
      return;
    }
  }

  /** Provisional pose: hanging in front of the viewer until a surface is chosen. */
  private faceViewer() {
    const camT = this.camObject.getTransform();
    const rot = camT.getWorldRotation();
    const offset = rot.multiplyVec3(new vec3(0, 16, -this.boardDistance));
    this.root.getTransform().setWorldPosition(camT.getWorldPosition().add(offset));
    this.root.getTransform().setWorldRotation(rot);
  }

  /**
   * Insurance against a surface that is not the wall it claimed to be.
   *
   * Placement asks for vertical planes only, so this is normally a no-op - the guard
   * fires only if the detector hands back a floor-like normal anyway, and lifts the
   * board to standing height instead of leaving it face-up and edge-on. Cheap, and the
   * failure it prevents is one where the board is technically placed and completely
   * invisible.
   */
  private standAt(pos: vec3, surfaceRot: quat): vec3 {
    if (!this.standUpright) return pos;
    const normal = surfaceRot.multiplyVec3(vec3.up()).normalize();
    if (Math.abs(normal.dot(vec3.up())) < 0.7) return pos;
    return pos.add(vec3.up().uniformScale(this.boardHeight / 2 + 8));
  }

  /**
   * Turn a surface pose into a board pose. The picker returns a rotation whose UP is
   * the surface normal — right for standing an object on a table, wrong for a board,
   * which has to face the room.
   */
  private faceOutOf(pos: vec3, surfaceRot: quat): quat {
    const camPos = this.camObject.getTransform().getWorldPosition();
    const toCam = camPos.sub(pos).normalize();

    let fwd = surfaceRot.multiplyVec3(vec3.up()).normalize();
    if (fwd.dot(toCam) < 0) fwd = fwd.uniformScale(-1);

    let up = vec3.up();
    if (Math.abs(fwd.dot(up)) > 0.7) {
      if (this.standUpright) {
        let flat = new vec3(toCam.x, 0, toCam.z);
        if (flat.length < 0.001) flat = vec3.forward();
        fwd = flat.normalize();
        up = vec3.up();
      } else {
        let planar = toCam.sub(fwd.uniformScale(toCam.dot(fwd)));
        if (planar.length < 0.001) planar = vec3.forward();
        up = planar.normalize().uniformScale(-1);
      }
    }

    const r = quat.lookAt(fwd, up);
    const probe = r.multiplyVec3(vec3.forward()).normalize();
    if (probe.dot(fwd) < 0) return r.multiply(quat.angleAxis(Math.PI, vec3.up()));
    return r;
  }

  /**
   * Move to wherever this board is kept, or in front of the viewer if it has no place
   * yet. Called at start-up and again on every board switch, because each board owns
   * its own spot on its own wall - that separation is the point of having more than
   * one, and a switch that left the board where the last one hung would collapse it.
   */
  applySavedPose() {
    if (Store.hasPose()) {
      const p = Store.loadPose();
      this.root.getTransform().setWorldPosition(p.pos);
      this.root.getTransform().setWorldRotation(p.rot);
      this.hung = true;
      print("[Board] restored to its saved place");
    } else {
      this.hung = false;
      this.faceViewer();
      print("[Board] no saved place; in front of the viewer");
    }
  }

  /** Copy that matches the surface actually being detected. */
  placementHint(): string {
    return "Look at a wall to hang the board";
  }

  /** Put the board on a real surface and remember where. */
  hangOnWall(onDone: (ok: boolean) => void) {
    this.ensureInit();
    if (!this.ready || this.placing) return;
    this.placing = true;

    let controller: SurfacePlacementController;
    try {
      controller = SurfacePlacementController.getInstance();
    } catch (e) {
      print("[Board] surface placement unavailable: " + e);
      this.placing = false;
      onDone(false);
      return;
    }

    this.placeCtl = controller;
    this.placeDone = onDone;
    this.beginPlacement();
  }

  private placeCtl: SurfacePlacementController = null;
  private placeDone: (ok: boolean) => void = null;
  private placeDeadline = 0;

  /**
   * Ask for a wall, and stop asking if the room does not offer one.
   *
   * Walls only. A board is a thing you hang, and a mood board lying flat on a table is
   * a different object with different manners - so there is no horizontal fallback,
   * even though horizontal is the mode that resolves more readily.
   *
   * The timeout stays, because a detector that finds nothing never calls back: without
   * it, asking for a wall in a room with no detectable wall left the feature waiting
   * with a hint on screen and no way out. Eight seconds is long enough to look up from
   * the floor and turn towards a wall, and short enough that failure is still an
   * answer rather than an absence.
   */
  private beginPlacement() {
    this.placeDeadline = getTime() + 8;
    print("[Board] placement started, mode=VERTICAL");
    this.placeCtl.startSurfacePlacement(
      new PlacementSettings(PlacementMode.VERTICAL),
      (pos: vec3, rot: quat) => {
        const at = this.standAt(pos, rot);
        this.root.getTransform().setWorldPosition(at);
        this.root.getTransform().setWorldRotation(this.faceOutOf(at, rot));
        this.hung = true;
        this.placing = false;
        this.placeDeadline = 0;
        Store.savePose(at, this.root.getTransform().getWorldRotation());
        print("[Board] placed at " + at.x.toFixed(0) + "," + at.y.toFixed(0)
              + "," + at.z.toFixed(0) + (this.standUpright ? " (standing)" : ""));
        if (this.placeDone) this.placeDone(true);
      }
    );
  }

  /** Called every frame: give up on a wall that is never going to arrive. */
  private watchPlacement() {
    if (!this.placing || this.placeDeadline === 0) return;
    if (getTime() < this.placeDeadline) return;

    try { this.placeCtl.stopSurfacePlacement(); } catch (e) { /* already stopped */ }
    this.placing = false;
    this.placeDeadline = 0;
    print("[Board] no wall found; board left where it was");
    if (this.placeDone) this.placeDone(false);
  }

  relayout() {
    if (!this.ready) return;
    if (this.template.freeform) { this.redrawPlaced(); return; }

    const frames: Placed[] = [];
    const pal: Placed[] = [];
    for (let i = 0; i < this.placed.length; i++) {
      const pl = this.placed[i];
      (pl.texture || pl.family ? frames : pal).push(pl);
    }

    if (this.template.sortByHue) {
      const byHue = (a: Placed, b: Placed) =>
        hueOf(a.hex ? a.hex : "") - hueOf(b.hex ? b.hex : "");
      frames.sort(byHue);
      pal.sort(byHue);
    }

    this.slots = this.template.build(frames.length, pal.length,
                                     this.boardWidth / this.boardHeight);

    const fIdx: number[] = [], pIdx: number[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      (this.slots[i].role === "palette" ? pIdx : fIdx).push(i);
    }

    const seat = (list: Placed[], idx: number[]) => {
      for (let k = 0; k < list.length; k++) {
        const pl = list[k];
        if (k >= idx.length) {
        pl.obj.enabled = false;
        if (pl.label) pl.label.enabled = false;
        if (pl.glyph) pl.glyph.enabled = false;
        if (pl.rule) pl.rule.enabled = false;
        if (pl.meta) pl.meta.enabled = false;
        continue;
      }
        pl.slot = idx[k];
        const sl = this.slots[pl.slot];
        const tr = pl.obj.getTransform();
        pl.obj.enabled = true;
        pl.fromPos = tr.getLocalPosition();
        pl.fromScale = tr.getLocalScale();
        pl.toPos = this.contentLocal(sl, this.liftOf(pl));
        pl.toScale = this.contentScale(sl);
        pl.t = 0;
        tr.setLocalRotation(Board.slotRot(sl));
        this.seatExtras(pl, sl);
      }
    };
    seat(frames, fIdx);
    seat(pal, pIdx);

    this.dressPanel();

    print("[Board] " + this.template.name + " re-solved for "
          + frames.length + " frames + " + pal.length + " colours"
          + (this.template.sortByHue ? " (by hue)" : ""));
  }

  /**
   * An empty board should suggest itself, not assert itself.
   *
   * Paper is the right ground for a board with work on it and the wrong one for a board
   * with nothing on it: a blank cream slab hanging in the room is the first thing
   * anyone sees, and it reads as a bug rather than an invitation. Because this display
   * adds light rather than blocking it, near-black is very nearly transparent - so an
   * empty board dims almost out of existence, leaving the room, and fades up to paper
   * the moment it has something to hold.
   */
  private dressPanel() {
    if (!this.panel) return;
    this.ui.matOf(this.panel).baseColor =
      this.placed.length === 0 ? new vec4(0.055, 0.055, 0.050, 1) : this.PANEL;
  }

  /** How many frames and colours are on the board - what a layout has to solve for. */
  contentCounts(): { frames: number; palette: number } {
    let f = 0, p = 0;
    for (let i = 0; i < this.placed.length; i++) {
      if (this.placed[i].texture || this.placed[i].family) f++; else p++;
    }
    return { frames: f, palette: p };
  }

  /** Kept for callers that used the old name. */
  reflow() { this.relayout(); }

  /** Re-seat everything from its current rect, slotted or free. */
  redrawPlaced() {
    if (!this.ready) return;
    this.dressPanel();
    for (let i = 0; i < this.placed.length; i++) {
      const pl = this.placed[i];
      const s = this.rectOf(pl);
      const tr = pl.obj.getTransform();
      pl.obj.enabled = true;
      pl.fromPos = tr.getLocalPosition();
      pl.fromScale = tr.getLocalScale();
      pl.toPos = this.contentLocal(s, this.liftOf(pl));
      pl.toScale = this.contentScale(s);
      pl.t = 0;
      tr.setLocalRotation(Board.slotRot(s));
      this.seatExtras(pl, s);
    }
  }

  /** Put a caption, and a specimen's glyph, where its card is. */
  /**
   * Every tile used to sit at exactly the same distance off the board, so wherever two
   * overlapped they were coplanar and the depth test could not order them - the pair
   * interleaved and read as translucent. Collage is the layout that overlaps on
   * purpose, so it is the one that showed it. Each item gets its own lift instead.
   */
  private static readonly LIFT = 3.2;
  private static readonly STACK = 0.06;
  private liftOf(pl: Placed): number {
    const i = this.placed.indexOf(pl);
    return Board.LIFT + (i < 0 ? 0 : i) * Board.STACK;
  }

  private seatExtras(pl: Placed, s: Slot) {
    // captions ride above their own tile, or the tile they belong to hides them
    const z = this.liftOf(pl) + 0.2;
    // Type is sized from the tile, not fixed: the same specimen has to hold a wide
    // Contact Sheet cell and a narrow Bento one, and a constant that fills the first
    // overflows the second. Measured against the rendered glyph - roughly 0.0195 cm of
    // drawn height per unit of Text size at this board scale.
    const tileCm = s.h * this.boardHeight;
    if (pl.glyph) {
      pl.glyph.enabled = true;
      const gt = pl.glyph.getComponent("Component.Text") as Text;
      gt.size = Math.max(60, Math.round(23.1 * tileCm));
      pl.glyph.getTransform().setLocalPosition(this.typeLocal(s, 0.5, 0.42, z));
      pl.glyph.getTransform().setLocalRotation(Board.slotRot(s));
    }
    if (pl.meta) {
      pl.meta.enabled = true;
      const mt = pl.meta.getComponent("Component.Text") as Text;
      mt.size = Math.max(18, Math.round(2.05 * tileCm));
      pl.meta.getTransform().setLocalPosition(this.typeLocal(s, 0.5, 0.75, z));
      pl.meta.getTransform().setLocalRotation(Board.slotRot(s));
    }
    if (pl.rule) {
      pl.rule.enabled = true;
      const rt = pl.rule.getTransform();
      rt.setLocalPosition(this.typeLocal(s, 0.5, 0.825, z - 0.05));
      rt.setLocalRotation(Board.slotRot(s));
      rt.setLocalScale(new vec3(s.w * 0.46 * this.boardWidth, 0.3, 1));
    }
    if (pl.label) {
      pl.label.enabled = true;
      if (pl.family) {
        /*
         * Legible or absent, never a smudge.
         *
         * The note scaled all the way down with its tile, so on a six-column board it
         * arrived as a grey smear that cost contrast and gave nothing back. Below the
         * size where it can actually be read it is dropped instead: a specimen that
         * shows the face and its name is still a specimen, and an unreadable third line
         * is worse than a missing one.
         */
        const lt = pl.label.getComponent("Component.Text") as Text;
        const readable = tileCm >= 17;
        pl.label.enabled = readable;
        if (readable) lt.size = Math.max(22, Math.round(0.92 * tileCm));
      }
      const at = pl.family
        ? this.typeLocal(s, 0.5, 0.90, z)
        : this.captionLocal(s, z);
      pl.label.getTransform().setLocalPosition(at);
      pl.label.getTransform().setLocalRotation(Board.slotRot(s));
    }
  }

  /** A slot's in-plane tilt. Collage leans things; every other layout sits square. */
  private static slotRot(s: Slot): quat {
    if (!s.rot) return quat.quatIdentity();
    return quat.angleAxis(s.rot * Math.PI / 180, vec3.forward());
  }

  /** Slot centre in board-local cm. */
  private slotLocal(s: Slot, zLift: number): vec3 {
    return new vec3(
      (s.x + s.w / 2 - 0.5) * this.boardWidth,
      (0.5 - (s.y + s.h / 2)) * this.boardHeight,
      zLift
    );
  }

  private slotScale(s: Slot): vec3 {
    return new vec3(s.w * this.boardWidth, s.h * this.boardHeight, 1);
  }

  /**
   * A palette swatch does not fill its slot — the chip takes the top 72% and the hex
   * caption sits underneath, the same split the exported SVG uses, so the wall and
   * the file read identically.
   */
  private static readonly CHIP = 0.72;

  /**
   * A type specimen is the one thing on a board that is not a photograph, so it should
   * not pretend to be one. Set on ink it stops competing with the captures and starts
   * anchoring them - and, practically, a near-white card on a near-white board reads as
   * a tile that failed to load rather than as a designed object.
   */
  private static readonly INK = new vec4(0.102, 0.098, 0.090, 1);
  private static readonly PAPER = new vec4(0.953, 0.941, 0.914, 1);
  private static readonly PAPER_DIM = new vec4(0.729, 0.706, 0.647, 1);
  private static readonly RULE = new vec4(0.34, 0.33, 0.30, 1);

  /** A point inside a specimen tile, as fractions of its width and height. */
  private typeLocal(s: Slot, fx: number, fy: number, zLift: number): vec3 {
    return new vec3(
      (s.x + s.w * fx - 0.5) * this.boardWidth,
      (0.5 - (s.y + s.h * fy)) * this.boardHeight,
      zLift
    );
  }

  private rectOf(pl: Placed): Slot {
    if (pl.free) {
      return { x: pl.free.x, y: pl.free.y, w: pl.free.w, h: pl.free.h,
               role: (pl.texture || pl.family) ? "frame" : "palette" };
    }
    const s = this.slots[pl.slot];
    // a slot index can outlive the layout it belonged to; never hand back undefined
    return s ? s : { x: 0.45, y: 0.45, w: 0.1, h: 0.1,
                     role: pl.texture ? "frame" : "palette" };
  }

  private contentLocal(s: Slot, zLift: number): vec3 {
    if (s.role !== "palette") return this.slotLocal(s, zLift);
    const ch = s.h * Board.CHIP;
    return new vec3(
      (s.x + s.w / 2 - 0.5) * this.boardWidth,
      (0.5 - (s.y + ch / 2)) * this.boardHeight,
      zLift
    );
  }

  private contentScale(s: Slot): vec3 {
    if (s.role !== "palette") return this.slotScale(s);
    return new vec3(s.w * this.boardWidth, s.h * Board.CHIP * this.boardHeight, 1);
  }

  /** Centre of a type specimen's card, where the "Aa" sits. */
  private glyphLocal(s: Slot, zLift: number): vec3 {
    return new vec3(
      (s.x + s.w / 2 - 0.5) * this.boardWidth,
      (0.5 - (s.y + s.h * 0.44)) * this.boardHeight,
      zLift
    );
  }

  private captionLocal(s: Slot, zLift: number): vec3 {
    const ch = s.h * Board.CHIP;
    const ly = s.y + ch + (s.h - ch) * 0.52;
    return new vec3(
      (s.x + s.w / 2 - 0.5) * this.boardWidth,
      (0.5 - ly) * this.boardHeight,
      zLift
    );
  }

  /** Screen position of a freely-placed item's centre. */
  private freeScreenPos(pl: Placed): vec2 {
    const s = this.rectOf(pl);
    const world = this.root.getTransform().getWorldTransform()
      .multiplyPoint(this.contentLocal(s, 0));
    return this.cam.worldSpaceToScreenSpace(world);
  }

  /** Normalized screen position of a slot centre, or null if behind the camera. */
  slotScreenPos(i: number): vec2 {
    const s = this.slots[i];
    const world = this.root.getTransform().getWorldTransform()
      .multiplyPoint(this.slotLocal(s, 0));
    return this.cam.worldSpaceToScreenSpace(world);
  }

  /**
   * Nearest free slot to a screen point that accepts this kind, within reach.
   * Returns -1 when nothing is close enough.
   */
  /**
   * -2 = blank board, take it at this exact point.
   * -3 = slotted board, take it and re-solve. There is no "full" any more, so the only
   *      question is whether the pointer is over the board at all.
   */
  slotHitTest(p: vec2, kind: string): number {
    const uv = this.screenToBoardUV(p);
    const inside = uv && uv.x > 0.02 && uv.x < 0.98 && uv.y > 0.02 && uv.y < 0.98;
    if (this.template.freeform) return inside ? -2 : -1;
    return inside ? -3 : -1;
  }

  /** Highlight the slot an in-flight drag would land in. */
  highlight(slotIndex: number) {
    for (let i = 0; i < this.slotFrames.length; i++) {
      if (!this.slotFrames[i].enabled) continue;
      this.ui.matOf(this.slotFrames[i]).baseColor =
        i === slotIndex ? this.SLOT_HOT : this.SLOT;
    }
  }

  /** Drop a capture into a slot; it eases in from where the pointer released. */
  place(slotIndex: number, item: { id?: number; hex?: string; texture?: Texture; crop?: Rect;
                                   family?: string; tiling?: boolean },
        fromScreen: vec2, animate: boolean = true, free: Rect = null) {
    this.ensureInit();
    const s: Slot = free
      ? { x: free.x, y: free.y, w: free.w, h: free.h,
          role: item.texture ? "frame" : "palette" }
      : (this.slots[slotIndex] || { x: 0.45, y: 0.45, w: 0.12, h: 0.12,
                                    role: item.texture ? "frame" : "palette" });
    const isType = !!item.family;
    const textured = !!item.texture;
    const obj = this.ui.makeQuad("placed" + this.placed.length, this.root, isType ? false : textured);

    const pass = this.ui.matOf(obj);
    if (isType) {
      // a specimen is a card with the face set on it, not a picture of type
      pass.baseColor = Board.INK;
    } else if (textured && item.crop) {
      // A material repeats and a photograph does not - that is the whole difference
      // between the two, so it is the difference the board should show. A texture is
      // sampled 3x3 across its slot, which reads instantly as a swatch of stuff
      // rather than a picture of a thing.
      const c = item.crop;
      const rep = item.tiling ? 3 : 1;
      pass.baseColor = new vec4(1, 1, 1, 1);
      pass.baseTex = item.texture;
      pass.uv2Scale = new vec2(c.w * rep, c.h * rep);
      pass.uv2Offset = new vec2(c.x, 1 - (c.y + c.h));
    } else if (item.hex) {
      pass.baseColor = InSituUI.hexToVec4(item.hex);
    }

    // start small, near where the pointer let go, then ease into the slot
    const target = this.contentLocal(s, Board.LIFT + this.placed.length * Board.STACK);
    const start = animate
      ? new vec3(target.x, target.y - 14, target.z + 26)
      : target;
    const startScale = animate
      ? this.contentScale(s).uniformScale(0.55)
      : this.contentScale(s);

    let glyph: SceneObject = null;
    let rule: SceneObject = null;
    let meta: SceneObject = null;
    const fi = isType && this.types ? this.types.indexOfName(item.family) : -1;
    if (isType) {
      /*
       * Built like a foundry's specimen card: one glyph at a size nothing else on the
       * board comes near, then the particulars set small and precisely under it. The
       * drama is entirely in the scale jump - a card where everything is medium-sized
       * reads as a label, and a label is what this tile looked like before.
       *
       * The ampersand is the glyph type foundries actually lead with, and for good
       * reason: it carries more of a face's personality than any letter, being the one
       * character designers are still allowed to be strange with.
       */
      const fa = this.types ? this.types.fontAt(fi) : null;

      glyph = this.ui.makeLabel("glyph" + this.placed.length, 420, this.root);
      const gt = glyph.getComponent("Component.Text") as Text;
      gt.text = "&";
      gt.textFill.color = Board.PAPER;
      if (fa) (gt as any).font = fa;

      meta = this.ui.makeLabel("meta" + this.placed.length, 58, this.root);
      const mt = meta.getComponent("Component.Text") as Text;
      mt.text = item.family;
      mt.textFill.color = Board.PAPER;
      if (fa) (mt as any).font = fa;

      rule = this.ui.makeQuad("rule" + this.placed.length, this.root);
      this.ui.matOf(rule).baseColor = Board.RULE;
    }

    // the hex is the point of a swatch - a colour you cannot read is not a reference
    let label: SceneObject = null;
    if (isType) {
      const note = this.types ? this.types.noteAt(fi) : "";
      label = this.ui.makeLabel("fam" + this.placed.length, 34, this.root);
      const lt = label.getComponent("Component.Text") as Text;
      lt.text = (note ? note : "typeface").toUpperCase();
      lt.textFill.color = Board.PAPER_DIM;
    } else if (item.tiling) {
      // the tiling carries it, but a caption removes any doubt at a glance
      label = this.ui.makeLabel("tex" + this.placed.length, 62, this.root);
      const tt = label.getComponent("Component.Text") as Text;
      tt.text = "TEXTURE";
      tt.textFill.color = new vec4(0.34, 0.34, 0.32, 1);
      label.getTransform().setLocalPosition(
        this.captionLocal(s, Board.LIFT + this.placed.length * Board.STACK + 0.2));
      label.getTransform().setLocalRotation(Board.slotRot(s));
    } else if (!item.texture && item.hex) {
      // Keyed off the item, not off `s.role`. During a restore the slot array is
      // re-solved after every insert, so an item is placed against the *previous*
      // solve - and since a photo carries an average hex (it is what lets Spectrum
      // sort tiles beside swatches), reading the momentary role captioned photos
      // with colour names and left them there once relayout moved them.
      label = this.ui.makeLabel("hex" + this.placed.length, 86, this.root);
      const nm = nameOf(item.hex);
      (label.getComponent("Component.Text") as Text).text =
        (nm ? nm + "\n" : "") + item.hex.toUpperCase();
      (label.getComponent("Component.Text") as Text).textFill.color =
        new vec4(0.22, 0.22, 0.21, 1);
      label.getTransform().setLocalPosition(
        this.captionLocal(s, Board.LIFT + this.placed.length * Board.STACK + 0.2));
      label.getTransform().setLocalRotation(Board.slotRot(s));
    }

    const tr = obj.getTransform();
    tr.setLocalPosition(start);
    tr.setLocalRotation(Board.slotRot(s));
    tr.setLocalScale(startScale);

    this.placed.push({
      id: item.id === undefined ? -1 : item.id,
      slot: slotIndex, free: free,
      hex: item.hex, texture: item.texture, crop: item.crop,
      tiling: !!item.tiling,
      glyph: glyph, rule: rule, meta: meta, family: item.family ? item.family : "",
      obj: obj, label: label, t: animate ? 0 : 1,
      fromPos: start, toPos: target,
      fromScale: startScale,
      toScale: this.contentScale(s),
    });

    if (!free) this.relayout();
    print(free
      ? "[Board] placed freely (" + s.role + ")  on board=" + this.placed.length
      : "[Board] placed in slot " + slotIndex + " (" + s.role + ")"
        + "  filled=" + this.placed.length + "/" + this.slots.length);
  }

  private loggedSlots = false;

  private tick() {
    if (!this.ready) return;
    this.watchPlacement();

    if (!this.loggedSlots) {
      this.loggedSlots = true;
      const out: string[] = [];
      for (let i = 0; i < this.slots.length; i++) {
        const sp = this.slotScreenPos(i);
        out.push(i + ":" + this.slots[i].role.charAt(0)
                 + "(" + sp.x.toFixed(2) + "," + sp.y.toFixed(2) + ")");
      }
      print("[Board] slot screen positions " + out.join(" "));
    }

    const dt = getDeltaTime();
    const DUR = 0.45;
    for (let i = 0; i < this.placed.length; i++) {
      const pl = this.placed[i];
      if (pl.t >= 1) continue;
      pl.t = Math.min(1, pl.t + dt / DUR);
      const e = 1 - Math.pow(1 - pl.t, 3);   // easeOutCubic
      const tr = pl.obj.getTransform();
      tr.setLocalPosition(vec3.lerp(pl.fromPos, pl.toPos, e));
      tr.setLocalScale(vec3.lerp(pl.fromScale, pl.toScale, e));
    }
  }

  getPlaced(): Placed[] { return this.placed; }
  getSlots(): Slot[] { return this.slots; }
}
