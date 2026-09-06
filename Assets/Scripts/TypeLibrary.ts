/**
 * The typefaces a board can use.
 *
 * All Google Fonts, on purpose: the same family exists in the Lens *and* in Figma, so a
 * specimen exported as live SVG text renders in the real face rather than being
 * silently substituted. A board that showed one typeface and exported another would be
 * worse than having no type feature at all.
 */
@component
export class TypeLibrary extends BaseScriptComponent {
  // Individually, not as an array: asset arrays do not resolve through scene wiring.
  @input fontA: Asset;
  @input fontB: Asset;
  @input fontC: Asset;
  @input fontD: Asset;
  @input fontE: Asset;

  private list(): Asset[] {
    const out: Asset[] = [];
    [this.fontA, this.fontB, this.fontC, this.fontD, this.fontE].forEach((f) => {
      if (f) out.push(f);
    });
    return out;
  }

  @input
  @hint("Family names exactly as Google Fonts spells them - this string is what goes into the SVG.")
  names: string[];

  @input
  @hint("One-word character notes, shown under each name in the picker.")
  notes: string[];

  count(): number {
    return this.list().length;
  }

  fontAt(i: number): Asset {
    const l = this.list();
    return i >= 0 && i < l.length ? l[i] : null;
  }

  nameAt(i: number): string {
    return this.names && i >= 0 && i < this.names.length ? this.names[i] : "";
  }

  /** "high-contrast display" - the character note shown under the name on a specimen. */
  noteAt(i: number): string {
    return this.notes && i >= 0 && i < this.notes.length ? this.notes[i] : "";
  }

  /** "DM Serif Display  ·  high-contrast" for the picker. */
  labelAt(i: number): string {
    const n = this.nameAt(i);
    const c = this.notes && i < this.notes.length ? this.notes[i] : "";
    return c ? n + "   ·   " + c : n;
  }

  indexOfName(family: string): number {
    if (!this.names) return -1;
    for (let i = 0; i < this.names.length; i++) {
      if (this.names[i] === family) return i;
    }
    return -1;
  }
}
