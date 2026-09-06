import { Template, Slot } from "./Templates";

export type ExportItem = {
  kind: string;    // "tile" | "swatch"
  slot: number;
  hex: string;
  jpeg: string;    // base64, no data: prefix
  tiling?: boolean;// export as a repeating pattern rather than a single image
  family?: string; // typeface name; exported as live text, not a picture of type
  note?: string;   // character note under the name on a specimen
};

/**
 * Renders a board as a single SVG string.
 *
 * SVG rather than PNG because Figma imports it as a real layer tree — every capture
 * arrives as a named, movable, recolourable object instead of one flat picture. Tiles
 * ride along as base64 data URIs, which is exactly the shape `encodeTextureAsync`
 * already returns, so the whole file is generated on-device with no server compositing.
 *
 * Slot rects come straight from Templates, so the exported file and the board on the
 * wall are laid out by the same numbers and cannot drift apart.
 */
export class SvgExport {
  static readonly WIDTH = 1600;

  private static n(v: number): string {
    return (Math.round(v * 100) / 100).toString();
  }

  private static pad2(i: number): string {
    return i < 9 ? "0" + (i + 1) : "" + (i + 1);
  }

  static build(
    template: Template,
    slots: Slot[],
    items: ExportItem[],
    boardW: number,
    boardH: number,
    ground: string = "#f2f0eb"
  ): string {
    const W = SvgExport.WIDTH;
    const H = Math.round(W * (boardH / boardW));
    const n = SvgExport.n;

    const frames: string[] = [];
    const swatches: string[] = [];
    const defs: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const s: Slot = slots[it.slot];
      if (!s) continue;

      const x = s.x * W, y = s.y * H, w = s.w * W, h = s.h * H;

      if (it.kind === "type" && it.family) {
        // A foundry specimen card: one glyph at a scale nothing else on the board
        // approaches, then the particulars set small beneath it. Live SVG text in the
        // real Google family throughout, so Figma renders the actual face and the type
        // stays editable - and the same numbers as the board, which must not drift.
        const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const fam = esc(it.family);
        const note = esc((it.note ? it.note : "typeface").toUpperCase());
        frames.push(
          '    <g id="type-' + SvgExport.pad2(frames.length) + '">\n' +
          '      <rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '"\n' +
          '            fill="#1a1917"/>\n' +
          '      <text x="' + n(x + w / 2) + '" y="' + n(y + h * 0.52) + '"\n' +
          '            font-family="' + fam + '" font-size="' + n(h * 0.46) + '"\n' +
          '            text-anchor="middle" fill="#f3f0e9">&amp;</text>\n' +
          '      <text x="' + n(x + w / 2) + '" y="' + n(y + h * 0.755) + '"\n' +
          '            font-family="' + fam + '" font-size="' + n(h * 0.085) + '"\n' +
          '            text-anchor="middle" fill="#f3f0e9">' + fam + '</text>\n' +
          '      <rect x="' + n(x + w * 0.27) + '" y="' + n(y + h * 0.805) + '"\n' +
          '            width="' + n(w * 0.46) + '" height="1.2" fill="#57544d"/>\n' +
          '      <text x="' + n(x + w / 2) + '" y="' + n(y + h * 0.885) + '"\n' +
          '            font-family="Helvetica, Arial, sans-serif" font-size="' + n(h * 0.048) + '"\n' +
          '            letter-spacing="' + n(h * 0.013) + '"\n' +
          '            text-anchor="middle" fill="#99948a">' + note + '</text>\n' +
          '    </g>'
        );
      } else if (it.kind === "tile" && it.jpeg && it.tiling) {
        // a real SVG pattern, so it stays a resizable repeating fill in Figma
        // rather than one flat picture of a texture
        const pid = "tex-" + SvgExport.pad2(frames.length);
        const cell = Math.max(40, Math.round(Math.min(w, h) / 3));
        defs.push(
          '    <pattern id="' + pid + '" patternUnits="userSpaceOnUse"' +
          ' width="' + cell + '" height="' + cell + '">\n' +
          '      <image width="' + cell + '" height="' + cell + '"\n' +
          '             href="data:image/jpeg;base64,' + it.jpeg + '"/>\n' +
          '    </pattern>'
        );
        frames.push(
          '    <g id="texture-' + SvgExport.pad2(frames.length) + '">\n' +
          '      <rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '"\n' +
          '            fill="url(#' + pid + ')"/>\n' +
          '    </g>'
        );
      } else if (it.kind === "tile" && it.jpeg) {
        frames.push(
          '    <g id="frame-' + SvgExport.pad2(frames.length) + '">\n' +
          '      <image x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '"\n' +
          '             preserveAspectRatio="xMidYMid slice"\n' +
          '             href="data:image/jpeg;base64,' + it.jpeg + '"/>\n' +
          '    </g>'
        );
      } else if (it.kind === "swatch" && it.hex) {
        // chip on top, hex label beneath it, both inside the slot
        const chipH = h * 0.72;
        const labelY = y + chipH + (h - chipH) * 0.62;
        const label = it.hex.toUpperCase();
        swatches.push(
          '    <g id="swatch-' + SvgExport.pad2(swatches.length) + '">\n' +
          '      <rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(chipH) + '"\n' +
          '            fill="' + it.hex + '"/>\n' +
          '      <text x="' + n(x) + '" y="' + n(labelY) + '"\n' +
          '            font-family="Helvetica, Arial, sans-serif" font-size="' + n(h * 0.16) + '"\n' +
          '            fill="#4a4a46" letter-spacing="1">' + label + '</text>\n' +
          '    </g>'
        );
      }
    }

    const doc = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"' +
           ' viewBox="0 0 ' + W + ' ' + H + '">\n' +
           '  <title>' + template.name + '</title>\n' +
           (defs.length ? '  <defs>\n' + defs.join("\n") + '\n  </defs>\n' : '') +
           '  <rect id="ground" width="' + W + '" height="' + H + '" fill="' + ground + '"/>\n' +
           '  <g id="frames">\n' + frames.join("\n") + '\n  </g>\n' +
           '  <g id="palette">\n' + swatches.join("\n") + '\n  </g>\n' +
           '</svg>';

    // emit as a single line: newlines survive fine in a file, but any transport that
    // is line-oriented (the log, a POST body echoed back) mangles a multi-line dump
    return doc.split("\n").join("");
  }
}
