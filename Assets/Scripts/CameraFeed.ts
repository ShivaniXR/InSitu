/**
 * Owns the Spectacles camera request and exposes sampling + cropping over it.
 * Preview-safe: the camera texture arrives asynchronously, so callers must
 * check isReady() or wait on onReady before sampling.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export class CameraFeed {
  private texture: Texture = null;
  private ready = false;
  private readyCallbacks: (() => void)[] = [];

  constructor() {
    const G: any = global as any;
    const camModule: any = require("LensStudio:CameraModule");

    const req = G.CameraModule.createCameraRequest();
    req.cameraId = G.CameraModule.CameraId.Default_Color;
    req.imageSmallerDimension = 896;   // device max here; 1024 is rejected

    this.texture = camModule.requestCamera(req);
    const ctrl: any = this.texture.control;

    ctrl.onNewFrame.add(() => {
      if (this.ready) return;
      if (this.texture.getWidth() === 0) return;
      this.ready = true;
      print("[CameraFeed] ready " + this.texture.getWidth() + "x" + this.texture.getHeight());
      this.readyCallbacks.forEach((cb) => cb());
      this.readyCallbacks = [];
    });
  }

  isReady(): boolean { return this.ready; }
  getTexture(): Texture { return this.texture; }
  getWidth(): number { return this.texture ? this.texture.getWidth() : 0; }
  getHeight(): number { return this.texture ? this.texture.getHeight() : 0; }

  onReady(cb: () => void) {
    if (this.ready) { cb(); return; }
    this.readyCallbacks.push(cb);
  }

  /** Snapshot the live camera texture into a readable, frozen provider. */
  private snapshot(): any {
    const frozen = ProceduralTextureProvider.createFromTexture(this.texture);
    return { texture: frozen, control: frozen.control as any };
  }

  /**
   * Average an axis-aligned patch and return it as #rrggbb.
   * `rect` is in normalized SCREEN space (y down). getPixels reads from a
   * bottom-left origin, so y is flipped on the way in.
   */
  sampleColor(rect: Rect): { hex: string; r: number; g: number; b: number } {
    const snap = this.snapshot();
    const tw = snap.texture.getWidth();
    const th = snap.texture.getHeight();

    // clamp to a patch that is always inside the texture
    const px = Math.max(0, Math.min(tw - 1, Math.floor(rect.x * tw)));
    const flippedY = 1 - (rect.y + rect.h);
    const py = Math.max(0, Math.min(th - 1, Math.floor(flippedY * th)));
    const pw = Math.max(1, Math.min(tw - px, Math.floor(rect.w * tw)));
    const ph = Math.max(1, Math.min(th - py, Math.floor(rect.h * th)));

    const buf = new Uint8Array(pw * ph * 4);
    snap.control.getPixels(px, py, pw, ph, buf);

    let r = 0, g = 0, b = 0;
    const n = pw * ph;
    for (let i = 0; i < n; i++) {
      r += buf[i * 4];
      g += buf[i * 4 + 1];
      b += buf[i * 4 + 2];
    }
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);

    return { hex: CameraFeed.toHex(r, g, b), r: r, g: g, b: b };
  }

  /** Diagnostic: sample a grid across the frame to see if real content is arriving. */
  debugSweep() {
    const pts = [0.2, 0.5, 0.8];
    const out: string[] = [];
    for (let j = 0; j < pts.length; j++) {
      for (let i = 0; i < pts.length; i++) {
        const c = this.sampleColor({ x: pts[i] - 0.02, y: pts[j] - 0.02, w: 0.04, h: 0.04 });
        out.push(c.hex);
      }
    }
    print("[CameraFeed] sweep " + out.join(" "));
  }

  /**
   * Cut a patch and mirror it into a seamless 2x2 tile.
   *
   * Mirroring is seamless by construction — no edge matching, no blending seams to
   * tune. The result is a material sample rather than a photograph of one: it repeats,
   * which is the whole difference between a texture and a picture.
   */
  cropToTileable(rect: Rect, maxSide: number = 128): Texture {
    const snap = ProceduralTextureProvider.createFromTexture(this.texture);
    const ctrl: any = snap.control;
    const tw = snap.getWidth(), th = snap.getHeight();

    const flippedY = 1 - (rect.y + rect.h);
    const px = Math.max(0, Math.min(tw - 1, Math.floor(rect.x * tw)));
    const py = Math.max(0, Math.min(th - 1, Math.floor(flippedY * th)));
    const pw = Math.max(2, Math.min(tw - px, Math.floor(rect.w * tw)));
    const ph = Math.max(2, Math.min(th - py, Math.floor(rect.h * th)));

    const src = new Uint8Array(pw * ph * 4);
    ctrl.getPixels(px, py, pw, ph, src);

    // square it off first so the mirrored tile is not stretched
    const side = Math.min(pw, ph);
    const step = Math.max(1, Math.ceil(side / maxSide));
    const q = Math.max(2, Math.floor(side / step));

    const quad = new Uint8Array(q * q * 4);
    for (let y = 0; y < q; y++) {
      for (let x = 0; x < q; x++) {
        const si = ((y * step) * pw + (x * step)) * 4;
        const di = (y * q + x) * 4;
        quad[di] = src[si]; quad[di + 1] = src[si + 1];
        quad[di + 2] = src[si + 2]; quad[di + 3] = 255;
      }
    }

    const D = q * 2;
    const out = new Uint8Array(D * D * 4);
    for (let y = 0; y < D; y++) {
      const sy = y < q ? y : (D - 1 - y);
      for (let x = 0; x < D; x++) {
        const sx = x < q ? x : (D - 1 - x);
        const si = (sy * q + sx) * 4;
        const di = (y * D + x) * 4;
        out[di] = quad[si]; out[di + 1] = quad[si + 1];
        out[di + 2] = quad[si + 2]; out[di + 3] = 255;
      }
    }

    const tex = ProceduralTextureProvider.create(D, D, Colorspace.RGBA);
    (tex.control as any).setPixels(0, 0, D, D, out);
    // The mirrored quad is seamless, but seamless only helps if the sampler is
    // allowed to run off the edge. Textures default to ClampToEdge, which smears
    // the border pixel instead of repeating - so a board tile set to repeat 3x3
    // would show one image in a frame of stretched edge.
    (tex as any).wrapU = WrapMode.Repeat;
    (tex as any).wrapV = WrapMode.Repeat;
    return tex;
  }

  /**
   * Pull the dominant colours out of a region with k-means.
   *
   * One gesture over a whole scene beats circling five surfaces one at a time, and
   * it is the thing designers actually want from a photograph.
   */
  extractPalette(rect: Rect, k: number = 5): string[] {
    const snap = ProceduralTextureProvider.createFromTexture(this.texture);
    const ctrl: any = snap.control;
    const tw = snap.getWidth(), th = snap.getHeight();

    const flippedY = 1 - (rect.y + rect.h);
    const px = Math.max(0, Math.min(tw - 1, Math.floor(rect.x * tw)));
    const py = Math.max(0, Math.min(th - 1, Math.floor(flippedY * th)));
    const pw = Math.max(2, Math.min(tw - px, Math.floor(rect.w * tw)));
    const ph = Math.max(2, Math.min(th - py, Math.floor(rect.h * th)));

    const buf = new Uint8Array(pw * ph * 4);
    ctrl.getPixels(px, py, pw, ph, buf);

    // subsample: a few thousand pixels is plenty and keeps this frame-cheap
    const total = pw * ph;
    const step = Math.max(1, Math.floor(total / 3000));
    const pts: number[][] = [];
    for (let i = 0; i < total; i += step) {
      pts.push([buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]]);
    }
    if (pts.length < k) return [CameraFeed.toHex(pts[0][0], pts[0][1], pts[0][2])];

    // seed spread across the sample rather than randomly, so results are repeatable
    const cent: number[][] = [];
    for (let i = 0; i < k; i++) {
      cent.push(pts[Math.floor((i + 0.5) * pts.length / k)].slice());
    }

    const owner = new Array(pts.length);
    for (let iter = 0; iter < 12; iter++) {
      for (let i = 0; i < pts.length; i++) {
        let best = 0, bestD = -1;
        for (let c = 0; c < k; c++) {
          const d0 = pts[i][0] - cent[c][0];
          const d1 = pts[i][1] - cent[c][1];
          const d2 = pts[i][2] - cent[c][2];
          const d = d0 * d0 + d1 * d1 + d2 * d2;
          if (bestD < 0 || d < bestD) { bestD = d; best = c; }
        }
        owner[i] = best;
      }
      const sum: number[][] = [], n: number[] = [];
      for (let c = 0; c < k; c++) { sum.push([0, 0, 0]); n.push(0); }
      for (let i = 0; i < pts.length; i++) {
        const c = owner[i];
        sum[c][0] += pts[i][0]; sum[c][1] += pts[i][1]; sum[c][2] += pts[i][2];
        n[c]++;
      }
      for (let c = 0; c < k; c++) {
        if (n[c] === 0) continue;
        cent[c][0] = sum[c][0] / n[c];
        cent[c][1] = sum[c][1] / n[c];
        cent[c][2] = sum[c][2] / n[c];
      }
    }

    // biggest clusters first - the colours that actually dominate the scene
    const counts: number[] = [];
    for (let c = 0; c < k; c++) counts.push(0);
    for (let i = 0; i < owner.length; i++) counts[owner[i]]++;

    const order: number[] = [];
    for (let c = 0; c < k; c++) order.push(c);
    order.sort((a, b) => counts[b] - counts[a]);

    const out: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const c = cent[order[i]];
      if (counts[order[i]] === 0) continue;
      out.push(CameraFeed.toHex(Math.round(c[0]), Math.round(c[1]), Math.round(c[2])));
    }
    return out;
  }

  static toHex(r: number, g: number, b: number): string {
    const h = (v: number) => {
      const s = v.toString(16);
      return s.length < 2 ? "0" + s : s;
    };
    return "#" + h(r) + h(g) + h(b);
  }

  /** Freeze the current frame so a captured tile stops updating. */
  freezeFrame(): Texture {
    return ProceduralTextureProvider.createFromTexture(this.texture);
  }

  /**
   * Cut `rect` out of the live frame into its own small texture.
   *
   * Storing whole frames does not work: each one encodes to ~37 KB against a
   * 100 KB persistent store, so a board of eight tiles could never be saved.
   * A cropped, downsampled tile is a fraction of that, and it also means the
   * tile is self-contained — no UV window needed to display it.
   */
  cropToTexture(rect: Rect, maxSide: number = 220): Texture {
    const snap = ProceduralTextureProvider.createFromTexture(this.texture);
    const ctrl: any = snap.control;
    const tw = snap.getWidth(), th = snap.getHeight();

    const flippedY = 1 - (rect.y + rect.h);
    const px = Math.max(0, Math.min(tw - 1, Math.floor(rect.x * tw)));
    const py = Math.max(0, Math.min(th - 1, Math.floor(flippedY * th)));
    const pw = Math.max(1, Math.min(tw - px, Math.floor(rect.w * tw)));
    const ph = Math.max(1, Math.min(th - py, Math.floor(rect.h * th)));

    const src = new Uint8Array(pw * ph * 4);
    ctrl.getPixels(px, py, pw, ph, src);

    // nearest-neighbour stride: cheap, and plenty at mood-board size
    const step = Math.max(1, Math.ceil(Math.max(pw, ph) / maxSide));
    const dw = Math.max(1, Math.floor(pw / step));
    const dh = Math.max(1, Math.floor(ph / step));
    const dst = new Uint8Array(dw * dh * 4);

    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const si = ((y * step) * pw + (x * step)) * 4;
        const di = (y * dw + x) * 4;
        dst[di] = src[si];
        dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2];
        dst[di + 3] = 255;
      }
    }

    const tex = ProceduralTextureProvider.create(dw, dh, Colorspace.RGBA);
    (tex.control as any).setPixels(0, 0, dw, dh, dst);
    return tex;
  }
}
