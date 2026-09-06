/**
 * Persistence for a board.
 *
 * A board that vanishes when you take the glasses off is a screenshot, not a place.
 * This is what turns "I arranged some references" into "my board is on that wall."
 *
 * Swatches are cheap (a hex and a slot). Tiles carry their pixels, so each one is
 * stored as a base64 JPEG and decoded back into a texture on load.
 */

const K = "insitu.v1.";

/*
 * Boards are namespaced; everything else is not.
 *
 * "New board" used to mean "empty this one", which is a different thing and the wrong
 * one - a board is a place in a room, and starting a second project should no more
 * destroy the first than pinning something to a new wall takes the old wall down. So
 * each board owns a prefix and keeps its own contents, layout and pose, while the
 * things that belong to the person rather than to any board - their email, which hints
 * they have seen - stay on the root.
 */
let current = 1;

const idsKey = K + "boards";
const curKey = K + "current";

export type StoredItem = {
  kind: string;          // "tile" | "swatch" | "type"
  tiling: boolean;       // a tile that is a repeating material rather than a photo
  slot: number;
  hex: string;           // "" for tiles
  crop: vec4;            // x, y, w, h in screen-normalized space
  jpeg: string;          // "" for swatches
  free: vec4;            // board-space rect on a blank board; zero w means none
  family: string;        // typeface name for a specimen; "" otherwise
};

export class Store {
  private static get s(): any {
    return (global as any).persistentStorageSystem.store;
  }

  /** Key inside the board currently being worked on. */
  private static bk(name: string): string {
    return K + "b" + current + "." + name;
  }

  /** Board ids in creation order. Always at least one. */
  static boardIds(): number[] {
    const s = Store.s;
    if (!s.has(idsKey)) return [1];
    const raw = s.getIntArray(idsKey);
    return raw && raw.length ? raw : [1];
  }

  static currentId(): number { return current; }

  /** Restore the active board from storage. Called once at start-up. */
  static resume() {
    const s = Store.s;
    current = s.has(curKey) ? s.getInt(curKey) : 1;
    const ids = Store.boardIds();
    if (ids.indexOf(current) < 0) current = ids[0];
    if (!s.has(idsKey)) Store.writeIds(ids);
    print("[Store] board " + current + " of " + ids.length);
  }

  private static writeIds(ids: number[]) {
    try { Store.s.putIntArray(idsKey, ids); } catch (e) { print("[Store] ids failed: " + e); }
  }

  static switchTo(id: number) {
    current = id;
    try { Store.s.putInt(curKey, id); } catch (e) { /* not worth failing over */ }
    print("[Store] switched to board " + id);
  }

  /** A new board beside the others, never instead of them. */
  static createBoard(): number {
    const ids = Store.boardIds();
    let next = 1;
    for (let i = 0; i < ids.length; i++) if (ids[i] >= next) next = ids[i] + 1;
    ids.push(next);
    Store.writeIds(ids);
    Store.switchTo(next);
    print("[Store] created board " + next);
    return next;
  }

  /** Forget this board entirely and fall back to another, making one if it was the last. */
  static dropCurrent(): number {
    const ids = Store.boardIds();
    const gone = current;
    Store.clear();
    const left: number[] = [];
    for (let i = 0; i < ids.length; i++) if (ids[i] !== gone) left.push(ids[i]);
    if (left.length === 0) {
      Store.writeIds([1]);
      Store.switchTo(1);
    } else {
      Store.writeIds(left);
      Store.switchTo(left[0]);
    }
    print("[Store] dropped board " + gone);
    return current;
  }

  static budget(): string {
    const s = Store.s;
    return (s.getSizeInBytes ? s.getSizeInBytes() : -1) + " / "
         + (s.getMaxSizeInBytes ? s.getMaxSizeInBytes() : -1) + " bytes";
  }

  static save(templateName: string, items: StoredItem[]) {
    const s = Store.s;
    try {
      s.putString(Store.bk("template"), templateName);
      s.putInt(Store.bk("count"), items.length);

      const kinds: string[] = [];
      const slots: number[] = [];
      const hexes: string[] = [];
      const crops: vec4[] = [];
      const frees: vec4[] = [];
      const fams: string[] = [];

      for (let i = 0; i < items.length; i++) {
        kinds.push(items[i].tiling ? "texture" : items[i].kind);
        slots.push(items[i].slot);
        hexes.push(items[i].hex);
        crops.push(items[i].crop);
        frees.push(items[i].free);
        fams.push(items[i].family);
        // tiles carry pixels, so they get their own key
        s.putString(Store.bk("jpeg" + i), items[i].jpeg);
      }

      s.putStringArray(Store.bk("kind"), kinds);
      s.putIntArray(Store.bk("slot"), slots);
      s.putStringArray(Store.bk("hex"), hexes);
      s.putVec4Array(Store.bk("crop"), crops);
      s.putVec4Array(Store.bk("free"), frees);
      s.putStringArray(Store.bk("family"), fams);

      print("[Store] saved " + items.length + " items, " + Store.budget());
    } catch (e) {
      print("[Store] save FAILED: " + e);
    }
  }

  /**
   * One-shot flags for things the user only needs telling once.
   *
   * Kept out of the board keys on purpose: clearing a board should not make the Lens
   * start explaining itself again, and deleting a board is not a request for a tutorial.
   */
  static seen(what: string): boolean {
    const s = Store.s;
    return s.has(K + "seen." + what);
  }

  static markSeen(what: string) {
    try { Store.s.putInt(K + "seen." + what, 1); } catch (e) { /* not worth failing over */ }
  }

  static hasBoard(): boolean {
    const s = Store.s;
    return s.has(Store.bk("count")) && s.getInt(Store.bk("count")) > 0;
  }

  static templateName(): string {
    const s = Store.s;
    return s.has(Store.bk("template")) ? s.getString(Store.bk("template")) : "";
  }

  /**
   * Read the board back. Tiles decode asynchronously, so each item is handed to
   * `onItem` as it becomes ready rather than all at once.
   */
  static load(onItem: (it: StoredItem, tex: Texture) => void, onDone: () => void) {
    const s = Store.s;
    if (!Store.hasBoard()) { onDone(); return; }

    let kinds: string[], slots: number[], hexes: string[], crops: vec4[], frees: vec4[], fams: string[];
    try {
      kinds = s.getStringArray(Store.bk("kind"));
      slots = s.getIntArray(Store.bk("slot"));
      hexes = s.getStringArray(Store.bk("hex"));
      crops = s.getVec4Array(Store.bk("crop"));
      frees = s.has(Store.bk("free")) ? s.getVec4Array(Store.bk("free")) : null;
      fams = s.has(Store.bk("family")) ? s.getStringArray(Store.bk("family")) : null;
    } catch (e) {
      print("[Store] load FAILED: " + e);
      onDone();
      return;
    }

    const n = s.getInt(Store.bk("count"));
    let pending = 0;
    let dispatched = false;
    const finish = () => {
      if (pending === 0 && dispatched) onDone();
    };

    for (let i = 0; i < n; i++) {
      const isTex = kinds[i] === "texture";
      const it: StoredItem = {
        kind: isTex ? "tile" : kinds[i], tiling: isTex,
        slot: slots[i], hex: hexes[i],
        crop: crops[i], jpeg: "",
        free: frees && frees[i] ? frees[i] : new vec4(0, 0, 0, 0),
        family: fams && fams[i] ? fams[i] : "",
      };

      if (it.kind === "swatch" || it.kind === "type") {
        onItem(it, null);
        continue;
      }

      const enc = s.has(Store.bk("jpeg" + i)) ? s.getString(Store.bk("jpeg" + i)) : "";
      if (!enc) { continue; }
      it.jpeg = enc;

      pending++;
      (global as any).Base64.decodeTextureAsync(
        enc,
        (tex: Texture) => { pending--; onItem(it, tex); finish(); },
        () => { pending--; print("[Store] decode failed for item " + i); finish(); }
      );
    }

    dispatched = true;
    finish();
  }

  /** Destination email, typed once and remembered. */
  static getEmail(): string {
    const s = Store.s;
    return s.has(K + "email") ? s.getString(K + "email") : "";
  }

  static setEmail(v: string) {
    Store.s.putString(K + "email", v);
    print("[Store] destination saved");
  }

  /**
   * Where the board hangs. Saved so it is still on that wall next session — a board
   * that has to be re-hung every time is a screenshot, not a place.
   */
  static savePose(pos: vec3, rot: quat) {
    const s = Store.s;
    s.putVec3(Store.bk("boardPos"), pos);
    s.putQuat(Store.bk("boardRot"), rot);
    print("[Store] board pose saved");
  }

  static hasPose(): boolean {
    return Store.s.has(Store.bk("boardPos")) && Store.s.has(Store.bk("boardRot"));
  }

  static loadPose(): { pos: vec3; rot: quat } {
    const s = Store.s;
    return { pos: s.getVec3(Store.bk("boardPos")), rot: s.getQuat(Store.bk("boardRot")) };
  }

  /**
   * Clear *this* board and nothing else.
   *
   * Scoped to the current board's prefix, so the other boards and the person's own
   * settings survive. Deleting a board is not a request for a tutorial either, and the
   * one-shot hint flags live on the root where this cannot reach them.
   */
  static clear() {
    const s = Store.s;
    const mine = K + "b" + current + ".";
    const keys = s.getAllKeys();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(mine) === 0) s.remove(keys[i]);
    }
    print("[Store] cleared board " + current);
  }

  /** A true fresh install, hints included. Wired to the `clearOnStart` input. */
  static clearAll() {
    const s = Store.s;
    const keys = s.getAllKeys();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(K) === 0) s.remove(keys[i]);
    }
    current = 1;
    print("[Store] cleared everything, hints included");
  }
}
