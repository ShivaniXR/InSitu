/**
 * QR encoder — byte mode, error correction level M, versions 1..6.
 *
 * Generated on-device because the whole point of the export is that the board
 * leaves the glasses without a second device in the loop: the Lens uploads the
 * SVG, gets a link back, and draws that link as something you can scan.
 *
 * Versions 1-6 hold up to 106 bytes at level M, which covers any share URL.
 */
export class QrCode {

  // version -> total codewords, EC codewords per block, block count, alignment centres.
  // For v1..v6 at level M every block is the same size, so splitting is uniform.
  private static V = [
    null,
    { total: 26,  ec: 10, blocks: 1, align: [] as number[] },
    { total: 44,  ec: 16, blocks: 1, align: [6, 18] },
    { total: 70,  ec: 26, blocks: 1, align: [6, 22] },
    { total: 100, ec: 18, blocks: 2, align: [6, 26] },
    { total: 134, ec: 24, blocks: 2, align: [6, 30] },
    { total: 172, ec: 16, blocks: 4, align: [6, 34] },
  ];

  // 15-bit format strings for EC level M, one per mask
  private static FORMAT_M = [
    "101010000010010", "101000100100101", "101111001111100", "101101101001011",
    "100010111111001", "100000011001110", "100111110010111", "100101010100000",
  ];

  private static expT: number[] = null;
  private static logT: number[] = null;

  private static initGf() {
    if (QrCode.expT) return;
    const e: number[] = new Array(512);
    const l: number[] = new Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      e[i] = x;
      l[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) e[i] = e[i - 255];
    QrCode.expT = e;
    QrCode.logT = l;
  }

  private static mul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return QrCode.expT[QrCode.logT[a] + QrCode.logT[b]];
  }

  /** Reed-Solomon remainder for one block. */
  private static ecc(data: number[], ecLen: number): number[] {
    QrCode.initGf();
    // generator polynomial
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = new Array(gen.length + 1);
      for (let k = 0; k < next.length; k++) next[k] = 0;
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= QrCode.mul(gen[j], QrCode.expT[i]);
      }
      gen = next;
    }
    const rem: number[] = new Array(ecLen);
    for (let i = 0; i < ecLen; i++) rem[i] = 0;
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (let j = 0; j < ecLen; j++) rem[j] ^= QrCode.mul(gen[j + 1], factor);
    }
    return rem;
  }

  private static smallestVersion(len: number): number {
    for (let v = 1; v <= 6; v++) {
      const info = QrCode.V[v];
      const dataCw = info.total - info.ec * info.blocks;
      if (dataCw * 8 - 12 >= len * 8) return v;   // 4-bit mode + 8-bit count
    }
    return -1;
  }

  /**
   * Encode `text` as a boolean matrix, true = dark.
   * Returns null if the text is too long for version 6.
   */
  static encode(text: string): boolean[][] {
    // UTF-8 bytes
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xc0 | (c >> 6)); bytes.push(0x80 | (c & 63)); }
      else { bytes.push(0xe0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 63)); bytes.push(0x80 | (c & 63)); }
    }

    const version = QrCode.smallestVersion(bytes.length);
    if (version < 0) return null;
    const info = QrCode.V[version];
    const dataCw = info.total - info.ec * info.blocks;

    // ---- bit stream ----
    const bits: number[] = [];
    const push = (val: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    push(4, 4);                    // byte mode
    push(bytes.length, 8);         // count, versions 1..9
    for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);

    const cap = dataCw * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // terminator
    while (bits.length % 8 !== 0) bits.push(0);

    const cw: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      cw.push(b);
    }
    const PAD = [0xec, 0x11];
    let p = 0;
    while (cw.length < dataCw) { cw.push(PAD[p % 2]); p++; }

    // ---- blocks + EC ----
    const perBlock = dataCw / info.blocks;
    const dBlocks: number[][] = [];
    const eBlocks: number[][] = [];
    for (let b = 0; b < info.blocks; b++) {
      const d = cw.slice(b * perBlock, (b + 1) * perBlock);
      dBlocks.push(d);
      eBlocks.push(QrCode.ecc(d, info.ec));
    }

    // ---- interleave ----
    const finalCw: number[] = [];
    for (let i = 0; i < perBlock; i++) {
      for (let b = 0; b < info.blocks; b++) finalCw.push(dBlocks[b][i]);
    }
    for (let i = 0; i < info.ec; i++) {
      for (let b = 0; b < info.blocks; b++) finalCw.push(eBlocks[b][i]);
    }

    return QrCode.layout(version, info, finalCw);
  }

  private static layout(version: number, info: any, cw: number[]): boolean[][] {
    const size = 17 + version * 4;
    const m: boolean[][] = [];
    const fixed: boolean[][] = [];
    for (let r = 0; r < size; r++) {
      m.push(new Array(size));
      fixed.push(new Array(size));
      for (let c = 0; c < size; c++) { m[r][c] = false; fixed[r][c] = false; }
    }

    const setF = (r: number, c: number, v: boolean) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = v; fixed[r][c] = true;
    };

    // finders + separators
    const finder = (fr: number, fc: number) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                         (c >= 0 && c <= 6 && (r === 0 || r === 6));
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          setF(fr + r, fc + c, inRing || inCore);
        }
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // timing
    for (let i = 8; i < size - 8; i++) {
      setF(6, i, i % 2 === 0);
      setF(i, 6, i % 2 === 0);
    }

    // alignment
    const al = info.align;
    for (let i = 0; i < al.length; i++) {
      for (let j = 0; j < al.length; j++) {
        const ar = al[i], ac = al[j];
        if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            setF(ar + r, ac + c, on);
          }
        }
      }
    }

    // dark module + reserve format areas
    setF(size - 8, 8, true);
    for (let i = 0; i <= 8; i++) {
      if (!fixed[8][i]) setF(8, i, false);
      if (!fixed[i][8]) setF(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      if (!fixed[8][size - 1 - i]) setF(8, size - 1 - i, false);
      if (!fixed[size - 1 - i][8]) setF(size - 1 - i, 8, false);
    }

    // ---- data placement, zigzag from bottom right ----
    const bitsOf: number[] = [];
    for (let i = 0; i < cw.length; i++) {
      for (let b = 7; b >= 0; b--) bitsOf.push((cw[i] >> b) & 1);
    }
    let idx = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;      // the timing column is not a data column
      for (let k = 0; k < size; k++) {
        const r = upward ? size - 1 - k : k;
        for (let t = 0; t < 2; t++) {
          const c = right - t;
          if (fixed[r][c]) continue;
          m[r][c] = idx < bitsOf.length ? bitsOf[idx] === 1 : false;
          idx++;
        }
      }
      upward = !upward;
    }

    // ---- choose mask ----
    let best = 0, bestScore = -1;
    let bestM: boolean[][] = null;
    for (let mask = 0; mask < 8; mask++) {
      const t = QrCode.applyMask(m, fixed, size, mask);
      QrCode.writeFormat(t, size, mask);
      const sc = QrCode.penalty(t, size);
      if (bestScore < 0 || sc < bestScore) { bestScore = sc; best = mask; bestM = t; }
    }
    return bestM;
  }

  private static applyMask(src: boolean[][], fixed: boolean[][], size: number, mask: number): boolean[][] {
    const out: boolean[][] = [];
    for (let r = 0; r < size; r++) {
      out.push(new Array(size));
      for (let c = 0; c < size; c++) {
        let v = src[r][c];
        if (!fixed[r][c]) {
          let flip = false;
          if (mask === 0) flip = (r + c) % 2 === 0;
          else if (mask === 1) flip = r % 2 === 0;
          else if (mask === 2) flip = c % 3 === 0;
          else if (mask === 3) flip = (r + c) % 3 === 0;
          else if (mask === 4) flip = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
          else if (mask === 5) flip = ((r * c) % 2) + ((r * c) % 3) === 0;
          else if (mask === 6) flip = ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0;
          else flip = ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
          if (flip) v = !v;
        }
        out[r][c] = v;
      }
    }
    return out;
  }

  private static writeFormat(m: boolean[][], size: number, mask: number) {
    const f = QrCode.FORMAT_M[mask];
    // placement index maps straight onto the table string, read left to right
    const bit = (i: number) => f.charAt(i) === "1";
    // around the top-left finder
    for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
    m[8][7] = bit(6);
    m[8][8] = bit(7);
    m[7][8] = bit(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
    // the duplicate copy
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = bit(i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = bit(i);
    m[size - 8][8] = true;   // dark module
  }

  private static penalty(m: boolean[][], size: number): number {
    let score = 0;

    // rule 1: runs of 5+
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = pass === 0 ? m[a][b] : m[b][a];
          const prv = pass === 0 ? m[a][b - 1] : m[b - 1][a];
          if (cur === prv) run++;
          else { if (run >= 5) score += 3 + (run - 5); run = 1; }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }

    // rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // rule 3: finder-like patterns
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        for (let b = 0; b + 11 <= size; b++) {
          let hit = true;
          for (let k = 0; k < 11; k++) {
            const v = pass === 0 ? m[a][b + k] : m[b + k][a];
            if (v !== pat[k]) { hit = false; break; }
          }
          if (hit) score += 40;
          let hit2 = true;
          for (let k = 0; k < 11; k++) {
            const v = pass === 0 ? m[a][b + k] : m[b + k][a];
            if (v !== pat[10 - k]) { hit2 = false; break; }
          }
          if (hit2) score += 40;
        }
      }
    }

    // rule 4: dark/light balance
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }
}
