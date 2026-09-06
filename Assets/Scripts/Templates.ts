/**
 * Board layouts, as generators rather than fixed slot lists.
 *
 * A template is a rule, not a grid: given however many frames and colours are on the
 * board, it produces the arrangement. Add a seventh image and the layout re-solves for
 * seven rather than dropping it. This is what lets a board evolve while staying in one
 * visual idea, and it removes the whole "no room in this layout" failure mode.
 *
 * Everything is normalized 0..1 in board space, origin top-left, y down — the same
 * convention as screen space and SVG, so nothing needs converting downstream.
 *
 * `ar` is the board's physical aspect (width/height). Normalized space hides it, so a
 * layout that ignores `ar` produces cells that look square in the numbers and read as
 * letterboxed slots on a 160x105 wall. Every grid here solves in real proportions.
 */

export type SlotRole = "frame" | "palette";

export type Slot = {
  x: number; y: number; w: number; h: number;
  role: SlotRole;
  /** Degrees. Only Collage leans things; everything else sits square. */
  rot?: number;
};

export type Template = {
  name: string;
  /** Lay out exactly this many of each, on a board of aspect `ar`. */
  build: (frames: number, palette: number, ar: number) => Slot[];
  sortByHue?: boolean;
  freeform?: boolean;
};

const f = (x: number, y: number, w: number, h: number, rot?: number): Slot =>
  ({ x: x, y: y, w: w, h: h, role: "frame", rot: rot });
const p = (x: number, y: number, w: number, h: number, rot?: number): Slot =>
  ({ x: x, y: y, w: w, h: h, role: "palette", rot: rot });

/** Evenly divide a span into `n` cells with gaps. Last entry is the cell size. */
function lane(start: number, span: number, n: number, gap: number): number[] {
  const w = (span - gap * (n - 1)) / n;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(start + i * (w + gap));
  return xs.concat([w]);
}

/**
 * Choose a column count for `n` cells in a region, in real proportions.
 *
 * Scored on two things a designer would actually notice: how close each cell lands to
 * the wanted shape, and how full the last row is. Three images across a wide region
 * want one row; three down a narrow column want one column. Picking `ceil(sqrt(n))`
 * blindly — what this used to do — gives 2x2 for three items on any board, which
 * leaves a hole and squashes every cell.
 */
function bestCols(n: number, regionW: number, regionH: number,
                  ar: number, cellAr: number): number {
  if (n <= 1) return 1;
  const W = regionW * ar, H = regionH;   // real proportions
  let best = 1, bestScore = -1;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const a = (W / c) / (H / r);
    const fit = Math.min(a, cellAr) / Math.max(a, cellAr);   // 1 == exactly right
    const fill = n / (c * r);                                // 1 == no ragged row
    const score = fit * 0.72 + fill * 0.28;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** Lay `n` cells into a region as a grid whose shape follows the count. */
function grid(n: number, x: number, y: number, w: number, h: number,
              gap: number, ar: number, cellAr: number, role: SlotRole): Slot[] {
  const out: Slot[] = [];
  if (n <= 0) return out;
  const cols = bestCols(n, w, h, ar, cellAr);
  const rows = Math.ceil(n / cols);
  const lx = lane(x, w, cols, gap);
  const cw = lx[cols];
  const ch = (h - gap * (rows - 1)) / rows;

  // Centre a ragged last row rather than leaving it hanging left.
  const lastCount = n - (rows - 1) * cols;
  const lastPad = (cols - lastCount) * (cw + gap) / 2;

  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const pad = r === rows - 1 ? lastPad : 0;
    out.push({ x: lx[c] + pad, y: y + r * (ch + gap), w: cw, h: ch, role: role });
  }
  return out;
}

/**
 * A palette row needs room for the chip *and* its caption underneath - the chip takes
 * 72% of the slot and the name plus hex live in what is left. Squeeze two rows into the
 * band sized for one and every caption lands on the chips below it. So height is per
 * row, and a wrapped palette costs the frames some space rather than becoming unreadable.
 */
const PAL_ROW = 0.16;

function palRows(np: number): number { return np <= 0 ? 0 : (np > 8 ? 2 : 1); }

function palHeight(np: number, gap: number): number {
  const r = palRows(np);
  return r === 0 ? 0 : PAL_ROW * r + gap * (r - 1);
}

/**
 * Colour chips along the bottom. Wraps to a second row past what fits comfortably,
 * so a twelve-colour palette stays readable instead of becoming twelve slivers.
 */
function bottomPalette(np: number, m: number, gap: number, y: number, h: number,
                       ar: number): Slot[] {
  if (np <= 0) return [];
  const span = 1 - m * 2;
  const rows = palRows(np);
  const per = Math.ceil(np / rows);
  const rh = (h - gap * (rows - 1)) / rows;
  const out: Slot[] = [];
  for (let r = 0; r < rows; r++) {
    const count = Math.min(per, np - r * per);
    if (count <= 0) continue;
    const l = lane(m, span, count, gap);
    for (let i = 0; i < count; i++) out.push(p(l[i], y + r * (rh + gap), l[count], rh));
  }
  return out;
}

/** Uniform grid. The neutral default; shape follows the count and the board. */
const CONTACT_SHEET: Template = {
  name: "Contact Sheet",
  build: (nf, np, ar) => {
    const m = 0.045, gap = 0.022;
    const palH = palHeight(np, gap);
    const hasPal = np > 0;
    const gridH = 1 - m * 2 - (hasPal ? palH + gap : 0);
    const out = grid(nf, m, m, 1 - m * 2, gridH, gap, ar, 1.0, "frame");
    return out.concat(bottomPalette(np, m, gap, m + gridH + gap, palH, ar));
  },
};

/**
 * One dominant frame, the rest beside it, colours down the right edge.
 * The hero's share shrinks as the supporting cast grows — at two images it is the
 * clear subject, at nine it would otherwise crush the rest into slivers.
 */
const HERO: Template = {
  name: "Hero",
  build: (nf, np, ar) => {
    const m = 0.05, gap = 0.025;
    // The palette runs down the edge here, so the column count is set by how many
    // chips fit at a readable height rather than by a taste threshold: at most five
    // per column, then wrap. Six in one column gives 0.129 each and the captions
    // land on the chip below.
    const maxPerCol = Math.max(1, Math.floor((1 - m * 2) / PAL_ROW));
    const palCols = np > 0 ? Math.min(3, Math.ceil(np / maxPerCol)) : 0;
    const chipW = palCols >= 3 ? 0.075 : 0.085;
    const palW = palCols > 0 ? chipW * palCols + gap * (palCols - 1) : 0;
    const H = 1 - m * 2;
    const right = 1 - m - palW - (np > 0 ? gap : 0);
    const out: Slot[] = [];

    if (nf === 1) {
      out.push(f(m, m, right - m, H));
    } else if (nf > 1) {
      const share = Math.max(0.40, 0.62 - (nf - 2) * 0.035);
      const heroW = (right - m) * share;
      out.push(f(m, m, heroW, H));
      const colX = m + heroW + gap;
      out.push.apply(out,
        grid(nf - 1, colX, m, right - colX, H, gap, ar, 1.05, "frame"));
    }

    if (np > 0) {
      const rows = Math.ceil(np / palCols);
      const ph = (H - gap * (rows - 1)) / rows;
      const pw = (palW - gap * (palCols - 1)) / palCols;
      for (let i = 0; i < np; i++) {
        const c = i % palCols, r = Math.floor(i / palCols);
        out.push(p(1 - m - palW + c * (pw + gap), m + r * (ph + gap), pw, ph));
      }
    }
    return out;
  },
};

/**
 * A band ordered by hue. One row while the cells stay wide enough to read as images;
 * past that it wraps, because a nine-across band is nine vertical stripes.
 */
const SPECTRUM: Template = {
  name: "Spectrum",
  sortByHue: true,
  build: (nf, np, ar) => {
    const m = 0.035, gap = 0.014;
    const palH = palHeight(np, gap);
    const hasPal = np > 0;
    const bandH = 1 - m * 2 - (hasPal ? palH + gap * 2 : 0);
    const out: Slot[] = [];
    if (nf > 0) {
      const rows = nf > 6 ? 2 : 1;
      const per = Math.ceil(nf / rows);
      const rh = (bandH - gap * (rows - 1)) / rows;
      for (let r = 0; r < rows; r++) {
        const count = Math.min(per, nf - r * per);
        if (count <= 0) continue;
        const l = lane(m, 1 - m * 2, count, gap);
        for (let i = 0; i < count; i++) out.push(f(l[i], m + r * (rh + gap), l[count], rh));
      }
    }
    return out.concat(bottomPalette(np, m, gap, m + bandH + gap * 2, palH, ar));
  },
};

/** Uneven cells: one large tile, the rest stepping down beside it. */
const BENTO: Template = {
  name: "Bento",
  build: (nf, np, ar) => {
    const m = 0.035, gap = 0.015;
    const palH = palHeight(np, gap);
    const hasPal = np > 0;
    const region = 1 - m * 2 - (hasPal ? palH + gap : 0);
    const out: Slot[] = [];

    if (nf === 1) {
      out.push(f(m, m, 1 - m * 2, region));
    } else if (nf > 1) {
      const share = Math.max(0.34, 0.52 - (nf - 2) * 0.03);
      const bigW = (1 - m * 2) * share;
      out.push(f(m, m, bigW, region));
      const restX = m + bigW + gap;
      out.push.apply(out,
        grid(nf - 1, restX, m, 1 - m - restX, region, gap, ar, 1.0, "frame"));
    }
    return out.concat(bottomPalette(np, m, gap, m + region + gap, palH, ar));
  },
};

/**
 * Overlapping and leaning, the way things land on a real pin board.
 *
 * This used to scatter along a golden-angle spiral of radius 0.30 while each tile was
 * ~0.28 wide, so every tile covered the centre and the board became one pile. A spiral
 * distributes *directions* evenly; it says nothing about whether the things you place
 * along it fit. So the positions now come from a grid — which does guarantee room —
 * and the collage character comes from overlapping the cells slightly and leaning each
 * tile. Jitter and angle are derived from the index, so a given board always looks the
 * same rather than reshuffling on every relayout.
 */
const COLLAGE: Template = {
  name: "Collage",
  build: (nf, np, ar) => {
    const out: Slot[] = [];
    const m = 0.04, gap = 0.02;
    const palH = palHeight(np, gap);
    const region = 1 - m * 2 - (np > 0 ? palH + gap : 0);

    if (nf > 0) {
      const cells = grid(nf, m, m, 1 - m * 2, region, gap, ar, 1.0, "frame");
      // Only overlap when there is something to overlap with, and never grow past
      // the board: a lone frame grown by 13% bleeds off the edge.
      const growth = cells.length > 1 ? 1.13 : 1.0;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const gw = Math.min(c.w * growth, 1 - m);
        const gh = Math.min(c.h * growth, region + palH * 0.5);
        const jx = (((i * 73) % 19) / 19 - 0.5) * c.w * 0.20;
        const jy = (((i * 137) % 23) / 23 - 0.5) * c.h * 0.20;
        out.push(f(
          Math.max(0.01, Math.min(0.99 - gw, c.x - (gw - c.w) / 2 + jx)),
          Math.max(0.01, Math.min(0.99 - gh, c.y - (gh - c.h) / 2 + jy)),
          gw, gh,
          ((i * 37) % 13) - 6
        ));
      }
    }

    if (np > 0) {
      const chips = bottomPalette(np, m, gap, m + region + gap, palH, ar);
      for (let i = 0; i < chips.length; i++) {
        const c = chips[i];
        c.rot = ((i * 53) % 11) - 5;
        c.y += (((i * 97) % 17) / 17 - 0.5) * palH * 0.16;
        out.push(c);
      }
    }
    return out;
  },
};

/** Asymmetric columns and real white space. A spread, not an inventory. */
const EDITORIAL: Template = {
  name: "Editorial",
  build: (nf, np, ar) => {
    const m = 0.06, gap = 0.025;
    const palH = palHeight(np, gap);
    const hasPal = np > 0;
    const region = 1 - m * 2 - (hasPal ? palH + gap * 2 : 0);
    const out: Slot[] = [];

    if (nf === 1) {
      out.push(f(m, m, 1 - m * 2, region));
    } else if (nf > 1) {
      const leftW = (1 - m * 2) * Math.max(0.34, 0.50 - (nf - 2) * 0.03);
      out.push(f(m, m, leftW, region));
      const colX = m + leftW + gap * 2;
      out.push.apply(out,
        grid(nf - 1, colX, m, 1 - m - colX, region, gap, ar, 0.95, "frame"));
    }

    if (np > 0) {
      // colours sit under the left column only - the asymmetry is the point
      const span = (1 - m * 2) * 0.62;
      const rows = palRows(np);
      const per = Math.ceil(np / rows);
      const rh = (palH - gap * 0.6 * (rows - 1)) / rows;
      for (let r = 0; r < rows; r++) {
        const count = Math.min(per, np - r * per);
        if (count <= 0) continue;
        const l = lane(m, span, count, gap * 0.6);
        for (let i = 0; i < count; i++) {
          out.push(p(l[i], m + region + gap * 2 + r * (rh + gap * 0.6), l[count], rh));
        }
      }
    }
    return out;
  },
};

/** No slots: a capture lands where it is dropped and stays there. */
const FREEFORM: Template = {
  name: "Blank board",
  freeform: true,
  build: () => [],
};

export const TEMPLATES: Template[] = [
  CONTACT_SHEET, HERO, SPECTRUM, BENTO, COLLAGE, EDITORIAL, FREEFORM,
];

export function templateByName(name: string): Template {
  for (let i = 0; i < TEMPLATES.length; i++) {
    if (TEMPLATES[i].name === name) return TEMPLATES[i];
  }
  return TEMPLATES[0];
}

/**
 * Hue of a #rrggbb colour, 0..360. Red is 0, so ascending hue reads warm to cool.
 * Near-neutrals return 900 so greys sort to the end instead of landing at red.
 */
export function hueOf(hex: string): number {
  if (!hex || hex.length < 7) return 999;
  const r = parseInt(hex.substr(1, 2), 16) / 255;
  const g = parseInt(hex.substr(3, 2), 16) / 255;
  const b = parseInt(hex.substr(5, 2), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.04) return 900;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
