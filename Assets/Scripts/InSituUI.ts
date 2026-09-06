import { Rect } from "./CameraFeed";

/**
 * Screen-aligned UI built from camera-parented quads.
 *
 * Everything lives on a plane a fixed distance in front of the camera, so a
 * normalized pointer position maps linearly to local space. Predictable in cm,
 * identical in Preview and on device, and trivial to ease.
 */
@component
export class InSituUI extends BaseScriptComponent {
  @input camObject: SceneObject;
  @input quadMesh: Asset;
  @input uiMaterial: Asset;
  @input tileMaterial: Asset;

  @input
  @hint("Distance in cm from the camera to the UI plane")
  planeDepth: number = 120;

  private cam: Camera;
  root: SceneObject;
  private halfW = 0;
  private halfH = 0;

  private outlineSegs: SceneObject[] = [];
  private introCard: SceneObject = null;
  private introTitle: SceneObject = null;
  private introSteps: SceneObject = null;
  private introFoot: SceneObject = null;
  private introSq: SceneObject[] = [];
  private introCi: SceneObject[] = [];
  private introHx: SceneObject[] = [];
  private introTags: SceneObject[] = [];
  private introOn = false;
  private menuGlyphs: SceneObject[] = [];
  private menuAa: SceneObject[] = [];
  private layoutCards: SceneObject[] = [];
  private layoutNames: SceneObject[] = [];
  private layoutCells: SceneObject[] = [];
  private flashQuad: SceneObject = null;
  private flashUntil = 0;
  private trayLips: SceneObject[] = [];
  private chipPlates: SceneObject[] = [];
  private modeLabel: SceneObject = null;
  private rectIcon: SceneObject[] = [];
  private circleIcon: SceneObject[] = [];
  private exportIcon: SceneObject[] = [];
  private layoutIcon: SceneObject[] = [];
  private textureIcon: SceneObject[] = [];
  private chipsFor = "";
  private chipsAt = -1;
  private hangIcon: SceneObject[] = [];
  private trayItems: SceneObject[] = [];
  private trayCards: SceneObject[] = [];
  private trayKinds: string[] = [];
  private trayCount = 0;
  private ghost: SceneObject = null;
  private toastObj: SceneObject = null;
  private toastCard: SceneObject = null;
  private badgeCard: SceneObject = null;
  private badgeX: SceneObject[] = [];
  private chooserRows: SceneObject[] = [];
  private chooserText: SceneObject[] = [];
  private ghostKind = "";

  private readonly SLOT_N = 0.085;
  private readonly GAP_N = 0.018;
  private readonly TRAY_Y = 0.74;

  private ready = false;

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => this.ensureInit());
  }

  /**
   * Lazily initialise. Another script's OnStart can reach us before ours runs —
   * hierarchy order decides that — so every public entry point calls this first
   * rather than trusting the ordering.
   */
  ensureInit() {
    if (this.ready) return;
    this.cam = this.camObject.getComponent("Component.Camera") as Camera;
    if (!this.cam) { print("[UI] no camera found"); return; }
    this.ready = true;

    this.root = global.scene.createSceneObject("UIRoot");
    this.root.setParent(this.camObject);
    this.root.getTransform().setLocalPosition(new vec3(0, 0, 0));

    this.measure();

    print("[UI] plane " + (this.halfW * 2).toFixed(1) + " x " + (this.halfH * 2).toFixed(1)
          + " cm at " + this.planeDepth + "cm");
  }

  /**
   * Frustum half-extents at planeDepth.
   *
   * Called every frame rather than cached: `cam.fov` is not final at init time,
   * and lazy initialisation can run before the device simulation has configured
   * the camera. Caching it once produced a UI plane at twice the true size.
   */
  private measure() {
    let fov = (this.cam as any).fov;
    if (fov > 3.2) fov = fov * Math.PI / 180;   // editor gives degrees, runtime radians
    let aspect = (this.cam as any).aspect;
    if (!aspect || aspect <= 0) aspect = 0.875; // Spectacles-ish fallback

    this.halfH = this.planeDepth * Math.tan(fov / 2);
    this.halfW = this.halfH * aspect;
  }

  /** Normalized screen (0..1, y down) -> local position on the UI plane. */
  screenToLocal(nx: number, ny: number, zLift: number = 0): vec3 {
    return new vec3(
      (nx - 0.5) * 2 * this.halfW,
      (0.5 - ny) * 2 * this.halfH,
      -this.planeDepth + zLift
    );
  }

  /** World position of a screen point on the UI plane — the basis for ray-casting. */
  worldPointAt(nx: number, ny: number): vec3 {
    this.ensureInit();
    this.measure();
    const local = this.screenToLocal(nx, ny, 0);
    return this.root.getTransform().getWorldTransform().multiplyPoint(local);
  }

  makeQuad(name: string, parent: SceneObject, textured: boolean = false): SceneObject {
    const holder = global.scene.createSceneObject(name);
    holder.setParent(parent);

    const face = global.scene.createSceneObject(name + "_face");
    face.setParent(holder);
    // PlaneMesh lies in XZ; stand it up so it faces the camera along +Z.
    face.getTransform().setLocalRotation(quat.angleAxis(Math.PI / 2, vec3.right()));

    const rmv = face.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    rmv.mesh = this.quadMesh as any;
    rmv.clearMaterials();
    const src = textured ? this.tileMaterial : this.uiMaterial;
    rmv.addMaterial((src as Material).clone());
    return holder;
  }

  matOf(o: SceneObject): any {
    const face = o.getChild(0);
    const rmv = face.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    return rmv.getMaterial(0).mainPass as any;
  }

  // ---------------------------------------------------------------- outline

  /** Stroke a closed loop of normalized screen points into a pool of segment quads. */
  private strokeLoop(
    pool: SceneObject[], tag: string, points: vec2[],
    color: vec4, thicknessCm: number, zLift: number
  ) {
    const need = points.length;
    while (pool.length < need) {
      pool.push(this.makeQuad(tag + pool.length, this.root));
    }
    for (let i = 0; i < pool.length; i++) pool[i].enabled = i < need;
    if (need === 0) return;

    for (let i = 0; i < need; i++) {
      const a = points[i];
      const b = points[(i + 1) % need];
      const pa = this.screenToLocal(a.x, a.y, zLift);
      const pb = this.screenToLocal(b.x, b.y, zLift);

      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const t = pool[i].getTransform();

      t.setLocalPosition(new vec3((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, pa.z));
      t.setLocalRotation(quat.angleAxis(Math.atan2(dy, dx), vec3.forward()));
      t.setLocalScale(new vec3(len + thicknessCm, thicknessCm, 1));

      this.matOf(pool[i]).baseColor = color;
    }
  }

  /** Draw the live drag outline. */
  setOutline(points: vec2[], color: vec4, thicknessCm: number = 0.6) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();
    this.strokeLoop(this.outlineSegs, "seg", points, color, thicknessCm, 0.4);
  }

  clearOutline() {
    if (!this.ready) return;
    this.outlineSegs.forEach((s) => { s.enabled = false; });
  }

  // ------------------------------------------------------------- mode chips

  /**
   * Hit rect for a chip, in normalized screen space.
   *
   * Sized from Snap's guidance rather than by eye: at Z = 120 cm a targetable element
   * wants ~6 cm ("Best"; 4 cm is the floor) and at least 1 degree of spacing, which is
   * ~2.1 cm at that distance. On a 69.5 cm wide plane that is 0.086 and 0.030
   * normalized. The previous row was 5 cm targets with 1.25 cm gaps — undersized and
   * under-spaced on both counts.
   *
   * Five chips, not six: capture modes stay on the bar, board actions moved into a menu.
   */
  static chipRect(which: string): Rect {
    // Three tools then two actions, with a wider gap between the groups than within
    // them. Proximity is the cheapest grouping signal there is, and without it the row
    // reads as five equivalent buttons - which is exactly wrong, since the first three
    // are persistent modes and the last two fire once and are done.
    const w = 0.086, h = 0.076, y = 0.045, gap = 0.030, groupGap = 0.075;
    const total = w * 5 + gap * 3 + groupGap;
    const start = 0.5 - total / 2;
    const i = which === "rect" ? 0
            : which === "circle" ? 1
            : which === "texture" ? 2
            : which === "menu" ? 3 : 4;
    const x = start + i * (w + gap) + (i >= 3 ? groupGap - gap : 0);
    return { x: x, y: y, w: w, h: h };
  }

  /**
   * Three stacked bars.
   *
   * Not a loop: `strokeLoop` closes the path, which turned three bars into a zigzag.
   * Separate segments need their own renderer.
   */
  private strokeBars(pool: SceneObject[], tag: string, r: Rect,
                     color: vec4, thicknessCm: number, zLift: number) {
    const ys = [0.28, 0.5, 0.72];
    while (pool.length < ys.length) pool.push(this.makeQuad(tag + pool.length, this.root));
    for (let i = 0; i < pool.length; i++) pool[i].enabled = i < ys.length;

    const x0 = r.x + r.w * 0.16, x1 = r.x + r.w * 0.84;
    for (let i = 0; i < ys.length; i++) {
      const y = r.y + r.h * ys[i];
      const a = this.screenToLocal(x0, y, zLift);
      const b = this.screenToLocal(x1, y, zLift);
      const t = pool[i].getTransform();
      t.setLocalPosition(new vec3((a.x + b.x) / 2, a.y, a.z));
      t.setLocalRotation(quat.quatIdentity());
      t.setLocalScale(new vec3(Math.abs(b.x - a.x), thicknessCm, 1));
      this.matOf(pool[i]).baseColor = color;
    }
  }

  /** Closed loop shaped like a hexagon: hexagons tessellate, so it reads as tiling. */
  static hexPoints(r: Rect): vec2[] {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const rx = r.w / 2, ry = r.h / 2;
    const out: vec2[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      out.push(new vec2(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
    }
    return out;
  }

  /** Closed loop shaped like a map pin: hang the board on a wall. */
  static pinPoints(r: Rect): vec2[] {
    const pts = [
      [0.5, 0.98], [0.16, 0.42], [0.24, 0.16], [0.5, 0.04],
      [0.76, 0.16], [0.84, 0.42],
    ];
    const out: vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      out.push(new vec2(r.x + pts[i][0] * r.w, r.y + pts[i][1] * r.h));
    }
    return out;
  }

  /** Closed loop shaped like a right-pointing triangle: next layout. */
  static trianglePoints(r: Rect): vec2[] {
    const pts = [[0.22, 0.06], [0.86, 0.5], [0.22, 0.94]];
    const out: vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      out.push(new vec2(r.x + pts[i][0] * r.w, r.y + pts[i][1] * r.h));
    }
    return out;
  }

  /** Closed loop shaped like a download arrow, inscribed in the rect. */
  static arrowPoints(r: Rect): vec2[] {
    const pts = [
      [0.38, 0.02], [0.62, 0.02], [0.62, 0.5], [0.86, 0.5],
      [0.5, 0.98], [0.14, 0.5], [0.38, 0.5],
    ];
    const out: vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      out.push(new vec2(r.x + pts[i][0] * r.w, r.y + pts[i][1] * r.h));
    }
    return out;
  }

  /** Two chips at the top: a square and a circle. The active one is lit. */
  renderModeChips(active: string) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();

    // The chips used to be drawn once at start-up. `cam.fov` is not final then, so if
    // the frustum measurement changed afterwards they stayed at the old scale and slid
    // off screen — which looked like the whole UI vanishing. Redraw when either the
    // mode or the measured plane changes.
    if (active === this.chipsFor && Math.abs(this.halfW - this.chipsAt) < 0.01) return;
    this.chipsFor = active;
    this.chipsAt = this.halfW;
    /*
     * Every chip gets its own ground.
     *
     * A stroked glyph drawn straight onto the world is at the mercy of whatever is
     * behind it - fine on a dark wall, gone against a window. Giving each chip a small
     * opaque plate fixes the contrast locally while occluding almost nothing, which a
     * full-width toolbar bar would not: in AR the world is the content, and a solid
     * band across the top of someone's vision to hold five icons is a poor trade.
     *
     * Selection then inverts the plate rather than thickening the stroke. A brighter
     * outline is a difference you have to look for; ink-on-paper against
     * paper-on-ink is one you cannot miss at arm's length.
     */
    const PLATE_IDLE = new vec4(0.108, 0.112, 0.118, 1);
    const PLATE_ON = new vec4(0.949, 0.937, 0.906, 1);
    const ICON_IDLE = new vec4(0.827, 0.827, 0.792, 1);
    const ICON_ON = new vec4(0.118, 0.118, 0.106, 1);

    /*
     * Actions carry less weight than tools.
     *
     * The three tools are a set with a current member - one of them is always on, and
     * the row has to say so. Menu and export are momentary buttons that are never
     * "selected", so giving them the same plate implies a state they can never enter.
     * The group gap says they are separate; this says they are a different *kind*.
     * Weight only, not size: at 120 cm a chip already sits at Snap's 6 cm "best"
     * target and shrinking one would push it under the 4 cm floor.
     */
    const PLATE_ACTION = new vec4(0.071, 0.075, 0.080, 1);
    const ICON_ACTION = new vec4(0.702, 0.706, 0.678, 1);

    const specs = [
      { mode: "rect", pool: this.rectIcon, tag: "icoR" },
      { mode: "circle", pool: this.circleIcon, tag: "icoC" },
      { mode: "texture", pool: this.textureIcon, tag: "icoX" },
      { mode: "menu", pool: this.layoutIcon, tag: "icoM" },
      { mode: "export", pool: this.exportIcon, tag: "icoE" },
    ];

    while (this.chipPlates.length < specs.length) {
      this.chipPlates.push(this.makeQuad("chipPlate" + this.chipPlates.length, this.root));
    }

    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      const r = InSituUI.chipRect(sp.mode);
      const isMode = sp.mode === "rect" || sp.mode === "circle" || sp.mode === "texture";
      const on = isMode && active === sp.mode;

      // the plate sits behind the glyph; depth ordering, not creation order, since the
      // glyph pools were built on an earlier frame and would otherwise draw underneath
      const plate = this.chipPlates[i];
      plate.enabled = true;
      const pt = plate.getTransform();
      pt.setLocalPosition(this.screenToLocal(r.x + r.w / 2, r.y + r.h / 2, 0.7));
      pt.setLocalRotation(quat.quatIdentity());
      pt.setLocalScale(new vec3(r.w * 2 * this.halfW, r.h * 2 * this.halfH, 1));
      this.matOf(plate).baseColor =
        on ? PLATE_ON : (isMode ? PLATE_IDLE : PLATE_ACTION);

      const ink = on ? ICON_ON : (isMode ? ICON_IDLE : ICON_ACTION);
      const pad = 0.021;
      const g: Rect = { x: r.x + pad, y: r.y + pad, w: r.w - pad * 2, h: r.h - pad * 2 };
      if (sp.mode === "menu") {
        this.strokeBars(sp.pool, sp.tag, g, ink, 0.3, 1.0);
        continue;
      }

      let pts: vec2[];
      if (sp.mode === "rect") pts = InSituUI.rectPoints(g);
      else if (sp.mode === "circle") pts = InSituUI.circlePoints(g, 24);
      else if (sp.mode === "texture") pts = InSituUI.hexPoints(g);
      else pts = InSituUI.arrowPoints(g);

      this.strokeLoop(sp.pool, sp.tag, pts, ink, 0.3, 1.0);
    }

    // Name the live tool. A hexagon meaning "texture" is not something anyone deduces,
    // and the toast only tells you after you have already captured the wrong thing.
    if (!this.modeLabel) this.modeLabel = this.makeLabel("modeName", 38, this.root);
    const names: any = { rect: "OBJECT", circle: "COLOUR", texture: "TEXTURE" };
    const nm = names[active];
    this.modeLabel.enabled = !!nm;
    if (nm) {
      const lt = this.modeLabel.getComponent("Component.Text") as Text;
      lt.text = nm;
      lt.textFill.color = new vec4(0.80, 0.80, 0.76, 1);
      const r = InSituUI.chipRect(active);
      this.modeLabel.getTransform().setLocalPosition(
        this.screenToLocal(r.x + r.w / 2, r.y + r.h + 0.032, 1.0));
      this.modeLabel.getTransform().setLocalRotation(quat.quatIdentity());
    }
  }

  /** Closed loop for a rectangle. */
  static rectPoints(r: Rect): vec2[] {
    return [
      new vec2(r.x, r.y),
      new vec2(r.x + r.w, r.y),
      new vec2(r.x + r.w, r.y + r.h),
      new vec2(r.x, r.y + r.h),
    ];
  }

  /** Closed loop approximating the ellipse inscribed in the rect. */
  static circlePoints(r: Rect, segments: number = 28): vec2[] {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const rx = r.w / 2, ry = r.h / 2;
    const pts: vec2[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new vec2(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
    }
    return pts;
  }

  // ------------------------------------------------------------------- tray

  /**
   * Lay captures out along the bottom edge, newest last.
   * `items` carry either a hex colour or a texture with a crop rect.
   */
  renderTray(items: { hex?: string; texture?: Texture; crop?: Rect; tiling?: boolean }[]) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();
    // material type is fixed when a quad is built, so a slot whose kind changed
    // has to be rebuilt rather than retinted
    for (let i = 0; i < items.length; i++) {
      const kind = items[i].texture ? "tile" : "swatch";
      if (i < this.trayItems.length && this.trayKinds[i] !== kind) {
        this.trayItems[i].destroy();
        this.trayItems[i] = this.makeQuad("tray" + i, this.root, kind === "tile");
        this.trayKinds[i] = kind;
      } else if (i >= this.trayItems.length) {
        this.trayItems.push(this.makeQuad("tray" + i, this.root, kind === "tile"));
        this.trayKinds.push(kind);
      }
    }
    while (this.trayCards.length < items.length) {
      this.trayCards.push(this.makeQuad("card" + this.trayCards.length, this.root));
      this.trayLips.push(this.makeQuad("lip" + this.trayLips.length, this.root));
    }
    for (let i = 0; i < this.trayItems.length; i++) {
      this.trayItems[i].enabled = i < items.length;
    }
    for (let i = 0; i < this.trayCards.length; i++) {
      this.trayCards[i].enabled = i < items.length;
      this.trayLips[i].enabled = i < items.length;
    }
    if (items.length === 0) return;

    this.trayCount = items.length;
    const slotN = this.SLOT_N;
    const yN = this.TRAY_Y;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const o = this.trayItems[i];
      const t = o.getTransform();

      const xN = this.trayItemX(i, items.length);
      t.setLocalPosition(this.screenToLocal(xN, yN, 0.8));
      t.setLocalRotation(quat.quatIdentity());

      const hCm = slotN * 2 * this.halfH;
      t.setLocalScale(new vec3(hCm, hCm, 1));

      // card sits just behind, slightly larger, so the swatch reads as mounted
      const card = this.trayCards[i];
      const ct = card.getTransform();
      ct.setLocalPosition(this.screenToLocal(xN, yN, 0.6));
      ct.setLocalRotation(quat.quatIdentity());
      ct.setLocalScale(new vec3(hCm * 1.16, hCm * 1.16, 1));
      this.matOf(card).baseColor = new vec4(0.97, 0.96, 0.93, 1);

      /*
       * A grip along the top edge.
       *
       * Nothing in the tray said these could be picked up - they read as a row of
       * results, not a row of handles, and the whole model depends on someone thinking
       * to drag one upward. A short bar centred on the top edge is the quietest thing
       * that means "hold here": it borrows the language of a drawer pull rather than
       * instructing with an arrow, so it stops being noticed once it has been
       * understood, which is what an affordance is for.
       */
      const lip = this.trayLips[i];
      const lt = lip.getTransform();
      lt.setLocalPosition(this.screenToLocal(xN, yN - slotN * 0.60, 0.9));
      lt.setLocalRotation(quat.quatIdentity());
      lt.setLocalScale(new vec3(hCm * 0.44, 0.42, 1));
      this.matOf(lip).baseColor = new vec4(0.612, 0.588, 0.529, 1);

      const pass = this.matOf(o);
      if (it.texture && it.crop) {
        // square slot: take a centred square out of the captured crop so the
        // tile is never stretched
        const c = it.crop;
        const side = Math.min(c.w, c.h);
        // a material repeats here too, so the tray tells you what you picked up
        // before you drop it - 2x rather than the board's 3x, at this size
        const rep = it.tiling ? 2 : 1;
        pass.baseColor = new vec4(1, 1, 1, 1);
        pass.baseTex = it.texture;
        pass.uv2Scale = new vec2(side * rep, side * rep);
        pass.uv2Offset = new vec2(
          c.x + (c.w - side) / 2,
          1 - (c.y + c.h) + (c.h - side) / 2
        );
      } else if (it.hex) {
        pass.baseColor = InSituUI.hexToVec4(it.hex);
      }
    }
  }

  /** Centre x of tray slot i, in normalized screen space. */
  private trayItemX(i: number, count: number): number {
    const totalN = count * this.SLOT_N + (count - 1) * this.GAP_N;
    return 0.5 - totalN / 2 + this.SLOT_N / 2 + i * (this.SLOT_N + this.GAP_N);
  }

  /** Which tray item is under this point, or -1. */
  trayHitTest(p: vec2): number {
    if (!this.ready || this.trayCount === 0) return -1;
    const half = this.SLOT_N / 2;
    // the tray is short, so vertical tolerance can be generous
    if (Math.abs(p.y - this.TRAY_Y) > half * 1.3) return -1;
    for (let i = 0; i < this.trayCount; i++) {
      if (Math.abs(p.x - this.trayItemX(i, this.trayCount)) <= half) return i;
    }
    return -1;
  }

  /** The capture riding the pointer mid-drag. */
  setGhost(item: { hex?: string; texture?: Texture; crop?: Rect }, p: vec2) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();
    const kind = item.texture ? "tile" : "swatch";
    if (this.ghost && this.ghostKind !== kind) {
      this.ghost.destroy();
      this.ghost = null;
    }
    if (!this.ghost) {
      this.ghost = this.makeQuad("ghost", this.root, kind === "tile");
      this.ghostKind = kind;
    }
    this.ghost.enabled = true;

    const pass = this.matOf(this.ghost);
    if (item.texture && item.crop) {
      const c = item.crop;
      const side = Math.min(c.w, c.h);
      pass.baseColor = new vec4(1, 1, 1, 1);
      pass.baseTex = item.texture;
      pass.uv2Scale = new vec2(side, side);
      pass.uv2Offset = new vec2(
        c.x + (c.w - side) / 2,
        1 - (c.y + c.h) + (c.h - side) / 2
      );
    } else if (item.hex) {
      pass.baseColor = InSituUI.hexToVec4(item.hex);
    }

    const hCm = this.SLOT_N * 2 * this.halfH * 1.12;   // lifts slightly when carried
    const t = this.ghost.getTransform();
    t.setLocalPosition(this.screenToLocal(p.x, p.y, 2.0));
    t.setLocalRotation(quat.quatIdentity());
    t.setLocalScale(new vec3(hCm, hCm, 1));
  }

  hideGhost() {
    if (this.ghost) this.ghost.enabled = false;
  }

  /**
   * A status line across the bottom of the view.
   *
   * This is where the export result goes. A QR would be unreadable here — the
   * waveguide display is visible only to the wearer, so nothing rendered in-lens
   * can be scanned by a phone. Text the wearer reads is the only thing that works.
   */
  /*
   * Acknowledging the press, which is a different job from showing the state.
   *
   * The three tool chips already say which one is live by inverting, and that is state
   * - it persists because the fact persists. What nothing did was confirm the *tap*:
   * press the menu, a menu card, a layout card or export and the interface simply
   * proceeded, or appeared not to. On a screen that gap is covered by the certainty of
   * the click. Here the input itself is uncertain - a pinch may or may not have
   * registered, and a tap that lands a few millimetres outside a chip does nothing at
   * all - so the absence of a response is ambiguous in a way it never is on a mouse.
   *
   * One quad, moved to whatever was pressed and faded out over 180 ms. Doing it as an
   * overlay rather than by restyling each control means every tappable thing gets the
   * same acknowledgement without any of them having to know about it.
   */
  private static readonly FLASH = 0.18;

  flashAt(r: Rect) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();
    if (!this.flashQuad) this.flashQuad = this.makeQuad("pressFlash", this.root);
    this.flashQuad.enabled = true;
    const t = this.flashQuad.getTransform();
    t.setLocalPosition(this.screenToLocal(r.x + r.w / 2, r.y + r.h / 2, 1.6));
    t.setLocalRotation(quat.quatIdentity());
    t.setLocalScale(new vec3(r.w * 2 * this.halfW, r.h * 2 * this.halfH, 1));
    this.flashUntil = getTime() + InSituUI.FLASH;
  }

  /** Fade the press acknowledgement out. Called every frame; cheap when idle. */
  tickFlash() {
    if (this.flashUntil === 0 || !this.flashQuad) return;
    const left = this.flashUntil - getTime();
    if (left <= 0) {
      this.flashUntil = 0;
      this.flashQuad.enabled = false;
      return;
    }
    // ramp down rather than blink off: a hard cut reads as a glitch, a decay reads
    // as a response
    const k = left / InSituUI.FLASH;
    this.matOf(this.flashQuad).baseColor =
      new vec4(0.98 * k, 0.96 * k, 0.90 * k, 1);
  }

  private toastUntil = 0;

  /**
   * Clear a message once it has been read.
   *
   * Toasts used to persist until something replaced them, so "Deleted" could sit on
   * screen for minutes while the person carried on working - a stale caption that
   * describes a moment long past reads as a status, and it was not one. Called every
   * frame; does nothing until the message is due to go.
   */
  tickToast() {
    if (this.toastUntil === 0 || !this.toastObj) return;
    if (getTime() < this.toastUntil) return;
    this.toastUntil = 0;
    this.toastObj.enabled = false;
    this.toastCard.enabled = false;
  }

  showToast(msg: string) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();
    this.toastUntil = getTime() + 5;

    if (!this.toastObj) {
      this.toastCard = this.makeQuad("toastCard", this.root);
      this.toastObj = this.makeLabel("toast", 64);
    }
    this.toastObj.enabled = true;
    this.toastCard.enabled = true;

    const txt = this.toastObj.getComponent("Component.Text") as Text;
    txt.text = msg;

    const y = 0.86;
    const tt = this.toastObj.getTransform();
    tt.setLocalPosition(this.screenToLocal(0.5, y, 3.4));
    tt.setLocalRotation(quat.quatIdentity());
    tt.setLocalScale(new vec3(1, 1, 1));

    // A pill the width of its own message, in paper. The old toast was a band across
    // the whole view in near-black, which on an additive display is not a band at all -
    // it was a murky smear of room showing through, with the text floating on top of
    // whatever happened to be behind. Sized to the text, it reads as a label.
    const wN = Math.min(0.86, 0.07 + msg.length * 0.0175);
    const ct = this.toastCard.getTransform();
    ct.setLocalPosition(this.screenToLocal(0.5, y, 3.0));
    ct.setLocalRotation(quat.quatIdentity());
    ct.setLocalScale(new vec3(wN * 2 * this.halfW, this.halfH * 0.125, 1));
    this.matOf(this.toastCard).baseColor = new vec4(0.949, 0.937, 0.906, 1);
    txt.textFill.color = new vec4(0.118, 0.118, 0.106, 1);

    print("[UI] toast: " + msg);
  }

  /**
   * Hit rect for chooser row `i`. Rows shrink to fit the count rather than running off
   * the bottom of the view — six layouts did not fit the old fixed pitch.
   */
  /**
   * Where each layout card sits. Four across, then three - seven templates do not
   * divide evenly and a ragged last row centred under the first reads better than a
   * fifth column of empty space.
   */
  static layoutCardRect(i: number, count: number): Rect {
    // Height follows the board's own proportions, not a convenient square: a preview
    // that reshapes the board is showing you a layout you will not get.
    const cols = 4, w = 0.148, h = 0.115, gx = 0.014, gy = 0.016;
    const row = Math.floor(i / cols);
    const rows = Math.ceil(count / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const rowW = inRow * w + (inRow - 1) * gx;
    const x = 0.5 - rowW / 2 + (i - row * cols) * (w + gx);
    return { x: x, y: 0.175 + row * (h + gy), w: w, h: h };
  }

  /**
   * Draw each layout as the arrangement it actually produces.
   *
   * The picker used to be a list of names, which asks the designer to already know what
   * "Bento" looks like - and worse, what it looks like *for the number of things they
   * currently have*, since every template here is a generator rather than a fixed grid.
   * Each card is drawn by running the real generator over the real counts, so the
   * preview is not an illustration of the layout, it is the layout.
   */
  showLayoutPicker(names: string[], slotSets: Rect[][], roles: string[][],
                   current: number, ar: number) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();

    const n = names.length;
    while (this.layoutCards.length < n) {
      const i = this.layoutCards.length;
      this.layoutCards.push(this.makeQuad("layCard" + i, this.root));
      this.layoutNames.push(this.makeLabel("layName" + i, 30, this.root));
    }
    for (let i = 0; i < this.layoutCards.length; i++) {
      this.layoutCards[i].enabled = i < n;
      this.layoutNames[i].enabled = i < n;
    }

    let cell = 0;
    for (let i = 0; i < n; i++) {
      const r = InSituUI.layoutCardRect(i, n);
      const on = i === current;

      const ct = this.layoutCards[i].getTransform();
      ct.setLocalPosition(this.screenToLocal(r.x + r.w / 2, r.y + r.h / 2, 3.0));
      ct.setLocalRotation(quat.quatIdentity());
      ct.setLocalScale(new vec3(r.w * 2 * this.halfW, r.h * 2 * this.halfH, 1));
      this.matOf(this.layoutCards[i]).baseColor =
        on ? new vec4(0.851, 0.816, 0.729, 1) : new vec4(0.949, 0.937, 0.906, 1);

      const nt = this.layoutNames[i].getTransform();
      nt.setLocalPosition(this.screenToLocal(r.x + r.w / 2, r.y + r.h - 0.016, 3.4));
      nt.setLocalRotation(quat.quatIdentity());
      const ntx = this.layoutNames[i].getComponent("Component.Text") as Text;
      ntx.text = names[i];
      ntx.textFill.color = new vec4(0.118, 0.118, 0.106, 1);

      // the drawing area, leaving room for the name along the bottom
      const pad = 0.014;
      const paW = r.w - pad * 2;
      // normalized units are not square on this plane, so convert through centimetres
      const paH = Math.min(r.h - pad - 0.030, paW * this.halfW / (this.halfH * ar));
      const pa: Rect = { x: r.x + pad, y: r.y + pad, w: paW, h: paH };
      const slots = slotSets[i];
      for (let k = 0; k < slots.length && k < 16; k++) {
        while (this.layoutCells.length <= cell) {
          this.layoutCells.push(this.makeQuad("layCell" + this.layoutCells.length, this.root));
        }
        const q = this.layoutCells[cell];
        q.enabled = true;
        const sl = slots[k];
        const cw = Math.max(0.004, sl.w * pa.w), ch = Math.max(0.004, sl.h * pa.h);
        const qt = q.getTransform();
        qt.setLocalPosition(this.screenToLocal(
          pa.x + (sl.x + sl.w / 2) * pa.w, pa.y + (sl.y + sl.h / 2) * pa.h, 3.4));
        qt.setLocalRotation(quat.quatIdentity());
        qt.setLocalScale(new vec3(cw * 2 * this.halfW, ch * 2 * this.halfH, 1));
        this.matOf(q).baseColor = roles[i][k] === "palette"
          ? new vec4(0.639, 0.596, 0.478, 1)
          : new vec4(0.322, 0.325, 0.302, 1);
        cell++;
      }
    }
    for (let k = cell; k < this.layoutCells.length; k++) this.layoutCells[k].enabled = false;
  }

  hideLayoutPicker() {
    for (let i = 0; i < this.layoutCards.length; i++) this.layoutCards[i].enabled = false;
    for (let i = 0; i < this.layoutNames.length; i++) this.layoutNames[i].enabled = false;
    for (let i = 0; i < this.layoutCells.length; i++) this.layoutCells[i].enabled = false;
  }

  /**
   * Menu items fanned on an arc below the chip that opened them.
   *
   * The arc is struck in centimetres and then converted, not laid out in normalized
   * units - the UI plane is 69.5 x 79.3 cm, so a circle drawn in normalized space comes
   * out an ellipse on the wall.
   *
   * The sweep widens with the item count rather than staying fixed, so three items make
   * a shallow fan instead of three points flung to the edges of a semicircle. Item 0
   * sits at the left end, because a fan that opens downward is still read left to
   * right.
   */
  /**
   * The menu as a small grid of cards, three across.
   *
   * An arc was tried first and the geometry refused it: struck from a chip at x 0.64
   * near the top edge, six pills need about six pill-widths of arc, which at any radius
   * that keeps them on screen makes them collide and at any radius that separates them
   * flings them to the edges. A fan wants either few items or short ones, and this menu
   * is neither.
   *
   * A grid gives six large, evenly weighted targets in a quarter of the space a list
   * took, and it matches the layout picker - so the two menus read as one system rather
   * than two unrelated inventions.
   */
  /**
   * A glyph for each menu card, drawn from quads.
   *
   * Not a font: an icon font would have to be shipped and verified for coverage, and
   * these six shapes are a grid, a plus and a cross - cheaper to draw than to depend
   * on. "Aa" is the exception, because a letterform is the one thing quads cannot fake.
   */
  private drawMenuGlyph(i: number, r: Rect, ink: vec4, pool: { n: number }) {
    const cx = r.x + r.w / 2, cy = r.y + r.h * 0.38;
    const take = (): SceneObject => {
      while (this.menuGlyphs.length <= pool.n) {
        this.menuGlyphs.push(this.makeQuad("mg" + this.menuGlyphs.length, this.root));
      }
      const q = this.menuGlyphs[pool.n++];
      q.enabled = true;
      return q;
    };
    const bar = (x: number, y: number, w: number, h: number, rot: number = 0) => {
      const q = take();
      const t = q.getTransform();
      t.setLocalPosition(this.screenToLocal(x, y, 3.4));
      t.setLocalRotation(quat.angleAxis(rot, vec3.forward()));
      t.setLocalScale(new vec3(w * 2 * this.halfW, h * 2 * this.halfH, 1));
      this.matOf(q).baseColor = ink;
    };

    const u = 0.020;   // glyph unit
    if (i === 0) {
      // layout: a small grid, one cell wider - the thing a layout actually is
      bar(cx - u * 0.75, cy - u * 0.5, u * 0.9, u * 0.7);
      bar(cx + u * 0.75, cy - u * 0.5, u * 0.9, u * 0.7);
      bar(cx - u * 0.75, cy + u * 0.5, u * 0.9, u * 0.7);
      bar(cx + u * 0.75, cy + u * 0.5, u * 0.9, u * 0.7);
    } else if (i === 3) {
      // place: a board outline
      bar(cx, cy - u, u * 3.0, u * 0.16);
      bar(cx, cy + u, u * 3.0, u * 0.16);
      bar(cx - u * 1.42, cy, u * 0.16, u * 2.0);
      bar(cx + u * 1.42, cy, u * 0.16, u * 2.0);
    } else if (i === 4) {
      bar(cx, cy, u * 2.4, u * 0.22);
      bar(cx, cy, u * 0.22, u * 2.4);
    } else if (i === 5) {
      bar(cx, cy, u * 2.4, u * 0.22, Math.PI / 4);
      bar(cx, cy, u * 2.4, u * 0.22, -Math.PI / 4);
    }
  }

  menuCardRect(i: number, count: number): Rect {
    const cols = 3, w = 0.145, h = 0.118, gx = 0.014, gy = 0.014;
    const row = Math.floor(i / cols);
    const rows = Math.ceil(count / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const rowW = inRow * w + (inRow - 1) * gx;
    return {
      x: 0.5 - rowW / 2 + (i - row * cols) * (w + gx),
      y: 0.175 + row * (h + gy),
      w: w, h: h,
    };
  }


  /** Rows a group divider should be drawn after, per chooser. -1 for none. */
  static readonly MENU_DIVIDER = 2;

  static chooserRect(i: number, count: number = 4): Rect {
    /*
     * Hung under the menu chip rather than parked in the middle of the view.
     *
     * A modal list dead-centre is a phone menu transplanted into space: it covers the
     * board, which is the one thing you are deciding *about*. Choosing a layout while
     * unable to see what it applies to is backwards. Anchoring it under the control
     * that opened it also gives the panel an origin - it reads as having come from
     * somewhere, instead of appearing over everything.
     *
     * Rows are only as tall as the text needs, and a group divider costs one row's
     * worth of gap so composing actions and board-level ones do not read as one
     * undifferentiated list.
     */
    const w = 0.46, x = 0.325;
    const h = 0.062, gap = 0.0035;
    const extra = InSituUI.MENU_DIVIDER >= 0 && count === 6 ? 0.018 : 0;
    const top = 0.175;
    const past = count === 6 && i > InSituUI.MENU_DIVIDER ? extra : 0;
    return { x: x, y: top + i * (h + gap) + past, w: w, h: h };
  }


  makeLabel(name: string, size: number, parent: SceneObject = null): SceneObject {
    const o = global.scene.createSceneObject(name);
    o.setParent(parent ? parent : this.root);
    const t = o.createComponent("Component.Text") as Text;
    t.horizontalAlignment = HorizontalAlignment.Center;
    t.verticalAlignment = VerticalAlignment.Center;
    t.size = size;
    t.textFill.color = new vec4(1, 0.99, 0.96, 1);
    return o;
  }

  /**
   * A short list of tappable choices, drawn over the board.
   * `highlight` marks the current or recommended row.
   */
  showChooser(lines: string[], highlight: number = 0, arc: boolean = false) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();

    while (this.chooserRows.length < lines.length) {
      const i = this.chooserRows.length;
      this.chooserRows.push(this.makeQuad("choice" + i, this.root));
      this.chooserText.push(this.makeLabel("choiceText" + i, 36));
    }
    const pool = { n: 0 };
    while (this.menuAa.length < 2) {
      this.menuAa.push(this.makeLabel("menuAa" + this.menuAa.length, 62, this.root));
    }
    for (let i = 0; i < this.menuAa.length; i++) this.menuAa[i].enabled = false;

    for (let i = 0; i < this.chooserRows.length; i++) {
      const on = i < lines.length;
      this.chooserRows[i].enabled = on;
      this.chooserText[i].enabled = on;
      if (!on) continue;

      const r = arc ? this.menuCardRect(i, lines.length)
                    : InSituUI.chooserRect(i, lines.length);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;

      const rt = this.chooserRows[i].getTransform();
      rt.setLocalPosition(this.screenToLocal(cx, cy, 3.0));
      rt.setLocalRotation(quat.quatIdentity());
      rt.setLocalScale(new vec3(r.w * 2 * this.halfW, r.h * 2 * this.halfH, 1));
      // Paper, not ink. The Spectacles display adds light rather than blocking it, so
      // a dark panel is a mostly transparent one - the old dark rows let the board read
      // straight through them and the text sat on whatever happened to be behind. A
      // bright panel is the only one that reliably occludes, so the menu is paper with
      // ink on it, and the selected row inverts, which is the same language the chips
      // use for the live tool.
      // The selected row is warmer paper, not ink. Inverting it looked right on a
      // colour picker and wrong on the wall: an ink row adds almost no light, so the
      // board showed straight through the one row that was supposed to stand out. Two
      // bright tones both occlude, and the difference still reads.
      this.matOf(this.chooserRows[i]).baseColor =
        i === highlight ? new vec4(0.851, 0.816, 0.729, 1)
                        : new vec4(0.949, 0.937, 0.906, 1);

      const tt = this.chooserText[i].getTransform();
      tt.setLocalPosition(arc
        ? this.screenToLocal(cx, r.y + r.h - 0.030, 3.4)
        : this.screenToLocal(cx, cy, 3.4));
      tt.setLocalRotation(quat.quatIdentity());
      if (arc) {
        const ink = new vec4(0.208, 0.212, 0.196, 1);
        if (i === 1 || i === 2) {
          // a letterform is the one glyph quads cannot fake
          const aa = this.menuAa[i - 1];
          aa.enabled = true;
          const at = aa.getTransform();
          at.setLocalPosition(this.screenToLocal(cx, r.y + r.h * 0.38, 3.4));
          at.setLocalRotation(quat.quatIdentity());
          const atx = aa.getComponent("Component.Text") as Text;
          atx.text = i === 1 ? "Aa" : "Aa?";
          atx.textFill.color = ink;
        } else {
          this.drawMenuGlyph(i, r, ink, pool);
        }
      }

      const ct = this.chooserText[i].getComponent("Component.Text") as Text;
      ct.text = lines[i];
      // The last row of the six-item menu deletes the board. Giving it the same weight
      // as "Add type..." is how people delete things they meant to keep, so it recedes.
      const destructive = lines.length === 6 && i === 5;
      ct.textFill.color = destructive
        ? new vec4(0.478, 0.302, 0.263, 1)
        : new vec4(0.118, 0.118, 0.106, 1);
    }
    this.retireGlyphs(pool.n);
    print("[UI] chooser: " + lines.join(" | "));
  }

  private retireGlyphs(from: number) {
    for (let k = from; k < this.menuGlyphs.length; k++) this.menuGlyphs[k].enabled = false;
  }

  /**
   * The first-run card.
   *
   * Shown once, dismissed by any tap, and never seen again. Three lines, because the
   * whole model really is three steps - and because nobody reads a tutorial while
   * wearing a pair of glasses for the first time. The tool names sit under the shapes
   * that make them, so the card teaches the chip row rather than describing it.
   */
  private introAt = -1;

  /**
   * The first-run card.
   *
   * It draws the three shapes rather than naming them. The previous version spelled out
   * "square: object   circle: colour   hexagon: texture" in a line of small text, which
   * is a caption for a picture that was never there - and the shapes are the entire
   * interface, so showing them costs one row and teaches the chip row directly.
   *
   * Set in the board's own display face, because the project ships five typefaces and
   * had its welcome screen in the system default.
   */
  showIntro(displayFont: any = null) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();

    // Same trap the chips fell into: `cam.fov` is not final when the camera feed first
    // reports ready, so a card positioned once sits at the old scale for the rest of
    // the session. Re-solve whenever the measured plane moves, and do nothing when it
    // has not.
    if (this.introOn && Math.abs(this.halfW - this.introAt) < 0.01) return;
    this.introAt = this.halfW;

    if (!this.introCard) {
      this.introCard = this.makeQuad("introCard", this.root);
      this.introTitle = this.makeLabel("introTitle", 132, this.root);
      this.introSteps = this.makeLabel("introSteps", 46, this.root);
      this.introFoot = this.makeLabel("introFoot", 32, this.root);
      for (let i = 0; i < 3; i++) {
        this.introTags.push(this.makeLabel("introTag" + i, 34, this.root));
      }
    }
    this.introOn = true;
    this.introCard.enabled = true;
    this.introTitle.enabled = true;
    this.introSteps.enabled = true;
    this.introFoot.enabled = true;
    for (let i = 0; i < this.introTags.length; i++) this.introTags[i].enabled = true;

    const ink = new vec4(0.118, 0.118, 0.106, 1);
    const soft = new vec4(0.408, 0.392, 0.353, 1);
    const faint = new vec4(0.612, 0.588, 0.529, 1);

    // sized to its contents, not to the view
    const w = 0.64, h = 0.375;
    const x = 0.5, top = 0.275;

    const ct = this.introCard.getTransform();
    ct.setLocalPosition(this.screenToLocal(x, top + h / 2, 3.0));
    ct.setLocalRotation(quat.quatIdentity());
    ct.setLocalScale(new vec3(w * 2 * this.halfW, h * 2 * this.halfH, 1));
    this.matOf(this.introCard).baseColor = new vec4(0.949, 0.937, 0.906, 1);

    const put = (o: SceneObject, ny: number, z: number) => {
      const t = o.getTransform();
      t.setLocalPosition(this.screenToLocal(x, ny, z));
      t.setLocalRotation(quat.quatIdentity());
    };

    put(this.introTitle, top + 0.066, 3.4);
    const ttx = this.introTitle.getComponent("Component.Text") as Text;
    ttx.text = "In Situ";
    ttx.textFill.color = ink;
    if (displayFont) (ttx as any).font = displayFont;

    // the three tools, drawn at the size they are actually tapped
    const shapeY = top + 0.175;
    const cols = [x - 0.170, x, x + 0.170];
    const box = (cx: number): Rect =>
      ({ x: cx - 0.037, y: shapeY - 0.033, w: 0.074, h: 0.066 });
    this.strokeLoop(this.introSq, "isq", InSituUI.rectPoints(box(cols[0])), ink, 0.30, 3.4);
    this.strokeLoop(this.introCi, "ici", InSituUI.circlePoints(box(cols[1]), 28), ink, 0.30, 3.4);
    this.strokeLoop(this.introHx, "ihx", InSituUI.hexPoints(box(cols[2])), ink, 0.30, 3.4);

    const tags = ["OBJECT", "COLOUR", "TEXTURE"];
    for (let i = 0; i < 3; i++) {
      const t = this.introTags[i].getTransform();
      t.setLocalPosition(this.screenToLocal(cols[i], shapeY + 0.062, 3.4));
      t.setLocalRotation(quat.quatIdentity());
      const tx = this.introTags[i].getComponent("Component.Text") as Text;
      tx.text = tags[i];
      tx.textFill.color = faint;
    }

    put(this.introSteps, top + 0.285, 3.4);
    const stx = this.introSteps.getComponent("Component.Text") as Text;
    stx.text = "Draw one, drag it onto the board,\nthen export it straight into Figma.";
    stx.textFill.color = soft;

    put(this.introFoot, top + h - 0.036, 3.4);
    const ftx = this.introFoot.getComponent("Component.Text") as Text;
    ftx.text = "TAP TO BEGIN";
    ftx.textFill.color = new vec4(0.478, 0.302, 0.263, 1);
  }

  introVisible(): boolean { return this.introOn; }

  hideIntro() {
    this.introOn = false;
    if (!this.introCard) return;
    this.introCard.enabled = false;
    this.introTitle.enabled = false;
    this.introSteps.enabled = false;
    this.introFoot.enabled = false;
    const pools = [this.introSq, this.introCi, this.introHx, this.introTags];
    for (let p = 0; p < pools.length; p++) {
      for (let i = 0; i < pools[p].length; i++) pools[p][i].enabled = false;
    }
  }

  hideChooser() {
    for (let i = 0; i < this.menuGlyphs.length; i++) this.menuGlyphs[i].enabled = false;
    for (let i = 0; i < this.menuAa.length; i++) this.menuAa[i].enabled = false;
    for (let i = 0; i < this.chooserRows.length; i++) {
      this.chooserRows[i].enabled = false;
      this.chooserText[i].enabled = false;
    }
    this.hideLayoutPicker();
  }

  /**
   * Hold feedback on a tray cell.
   *
   * `armed` is the difference between "you are holding this" and "let go and it is
   * gone" — a destructive action should say so before it happens, not after.
   */
  showDeleteBadge(index: number, count: number, armed: boolean) {
    this.ensureInit();
    if (!this.ready) return;
    this.measure();

    if (!this.badgeCard) {
      this.badgeCard = this.makeQuad("delBadge", this.root);
      this.badgeX.push(this.makeQuad("delX0", this.root));
      this.badgeX.push(this.makeQuad("delX1", this.root));
    }
    this.badgeCard.enabled = true;
    this.badgeX[0].enabled = true;
    this.badgeX[1].enabled = true;

    // sits above the cell rather than covering it - you should still see what you
    // are about to lose
    const xN = this.trayItemX(index, count);
    const yN = this.TRAY_Y - this.SLOT_N * 0.78;
    const side = this.SLOT_N * 2 * this.halfH * 0.46;

    const ct = this.badgeCard.getTransform();
    ct.setLocalPosition(this.screenToLocal(xN, yN, 1.6));
    ct.setLocalRotation(quat.quatIdentity());
    ct.setLocalScale(new vec3(side, side, 1));
    this.matOf(this.badgeCard).baseColor = armed
      ? new vec4(0.72, 0.16, 0.12, 1)     // armed: release and it goes
      : new vec4(0.10, 0.10, 0.11, 1);    // holding

    // a cross, drawn as two bars through the centre
    const bar = side * 0.52;
    const thick = side * 0.10;
    for (let i = 0; i < 2; i++) {
      const t = this.badgeX[i].getTransform();
      t.setLocalPosition(this.screenToLocal(xN, yN, 2.0));
      t.setLocalRotation(quat.angleAxis((i === 0 ? 1 : -1) * Math.PI / 4, vec3.forward()));
      t.setLocalScale(new vec3(bar, thick, 1));
      this.matOf(this.badgeX[i]).baseColor = new vec4(1, 0.97, 0.95, 1);
    }
  }

  hideDeleteBadge() {
    if (this.badgeCard) this.badgeCard.enabled = false;
    for (let i = 0; i < this.badgeX.length; i++) this.badgeX[i].enabled = false;
  }

  hideToast() {
    if (this.toastObj) this.toastObj.enabled = false;
    if (this.toastCard) this.toastCard.enabled = false;
  }

  static hexToVec4(hex: string): vec4 {
    const h = hex.charAt(0) === "#" ? hex.substr(1) : hex;
    const r = parseInt(h.substr(0, 2), 16) / 255;
    const g = parseInt(h.substr(2, 2), 16) / 255;
    const b = parseInt(h.substr(4, 2), 16) / 255;
    return new vec4(r, g, b, 1);
  }
}
