/**
 * Human names for sampled colours.
 *
 * Deliberately NOT Pantone: those values are licensed, and matching a spot ink to a
 * frame whose white balance we cannot even read would claim a precision that does not
 * exist. This is a curated designer vocabulary — honest about being approximate.
 *
 * Matching happens in CIE Lab, not RGB. RGB distance does not track perception, so
 * nearest-RGB reliably picks names that look wrong to the eye.
 */

type Named = { hex: string; name: string };

const NAMES: Named[] = [
  { hex: "#FFFFFF", name: "White" },        { hex: "#F7F4EF", name: "Chalk" },
  { hex: "#EFE8DC", name: "Bone" },         { hex: "#E4DCCB", name: "Oat" },
  { hex: "#D9CDB6", name: "Sand" },         { hex: "#C8B896", name: "Wheat" },
  { hex: "#B39B72", name: "Camel" },        { hex: "#9C7E52", name: "Tobacco" },
  { hex: "#7A5C3A", name: "Walnut" },       { hex: "#5C422A", name: "Cocoa" },
  { hex: "#3E2C1C", name: "Espresso" },     { hex: "#2A1F16", name: "Bitter Chocolate" },
  { hex: "#E8E6E1", name: "Paper" },        { hex: "#CFCCC5", name: "Ash" },
  { hex: "#B0ADA6", name: "Pebble" },       { hex: "#918E88", name: "Stone" },
  { hex: "#6F6D69", name: "Graphite" },     { hex: "#4E4C49", name: "Charcoal" },
  { hex: "#2E2D2B", name: "Soot" },         { hex: "#141414", name: "Ink" },
  { hex: "#C9CDD2", name: "Mist" },         { hex: "#A7AEB6", name: "Silver" },
  { hex: "#7E8894", name: "Slate" },        { hex: "#5C6672", name: "Gunmetal" },
  { hex: "#3D4651", name: "Payne's Grey" }, { hex: "#252C35", name: "Onyx" },
  { hex: "#D8E3EC", name: "Frost" },        { hex: "#AFC7DA", name: "Powder Blue" },
  { hex: "#7FA6C4", name: "Cornflower" },   { hex: "#5C7C91", name: "Steel Blue" },
  { hex: "#3F6480", name: "Denim" },        { hex: "#2A4A63", name: "Prussian Blue" },
  { hex: "#16324A", name: "Navy" },         { hex: "#0C1F30", name: "Midnight" },
  { hex: "#9BD3D6", name: "Aqua" },         { hex: "#6BB2B8", name: "Lagoon" },
  { hex: "#3F8C93", name: "Teal" },         { hex: "#2A6A70", name: "Deep Teal" },
  { hex: "#17484D", name: "Petrol" },       { hex: "#B8D6BE", name: "Eucalyptus" },
  { hex: "#8DBB98", name: "Celadon" },      { hex: "#6D9A78", name: "Sage" },
  { hex: "#4E7A57", name: "Fern" },         { hex: "#35603E", name: "Forest" },
  { hex: "#20452A", name: "Pine" },         { hex: "#C7D6A0", name: "Pistachio" },
  { hex: "#A9C06F", name: "Chartreuse" },   { hex: "#87A24A", name: "Moss" },
  { hex: "#6A7F35", name: "Olive" },        { hex: "#4E5E26", name: "Loden" },
  { hex: "#F2E5A8", name: "Butter" },       { hex: "#E8D06A", name: "Straw" },
  { hex: "#D9B23F", name: "Mustard" },      { hex: "#BF9526", name: "Ochre" },
  { hex: "#9C7715", name: "Amber" },        { hex: "#7A5C0F", name: "Bronze" },
  { hex: "#F6D9B0", name: "Apricot" },      { hex: "#EEBE85", name: "Peach" },
  { hex: "#DE9C55", name: "Tangerine" },    { hex: "#C57B33", name: "Copper" },
  { hex: "#A65E21", name: "Sienna" },       { hex: "#82441A", name: "Umber" },
  { hex: "#F3C9BE", name: "Blush" },        { hex: "#E5A08F", name: "Salmon" },
  { hex: "#D2725C", name: "Terracotta" },   { hex: "#B85340", name: "Brick" },
  { hex: "#96382C", name: "Rust" },         { hex: "#73261E", name: "Oxblood" },
  { hex: "#F0BFC6", name: "Rose Quartz" },  { hex: "#DE8FA0", name: "Rose" },
  { hex: "#C4637C", name: "Raspberry" },    { hex: "#A2415B", name: "Wine" },
  { hex: "#7C2B41", name: "Claret" },       { hex: "#E3C8DE", name: "Lilac" },
  { hex: "#C39CC4", name: "Wisteria" },     { hex: "#9E74A6", name: "Orchid" },
  { hex: "#7A5286", name: "Amethyst" },     { hex: "#583A63", name: "Plum" },
  { hex: "#3B2743", name: "Aubergine" },    { hex: "#CBC3E0", name: "Periwinkle" },
  { hex: "#A79BC9", name: "Heather" },      { hex: "#8073AC", name: "Iris" },
  { hex: "#5D5288", name: "Indigo" },       { hex: "#3E3660", name: "Blackcurrant" },
];

/** sRGB hex -> CIE Lab (D65). */
function toLab(hex: string): number[] {
  const f = (v: number) => (v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92);
  const r = f(parseInt(hex.substr(1, 2), 16) / 255);
  const g = f(parseInt(hex.substr(3, 2), 16) / 255);
  const b = f(parseInt(hex.substr(5, 2), 16) / 255);

  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

  const k = (v: number) => (v > 0.008856 ? Math.pow(v, 1 / 3) : 7.787 * v + 16 / 116);
  x = k(x); y = k(y); z = k(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

let LAB: number[][] = null;

export function nameOf(hex: string): string {
  if (!hex || hex.length < 7) return "";
  if (!LAB) {
    LAB = [];
    for (let i = 0; i < NAMES.length; i++) LAB.push(toLab(NAMES[i].hex));
  }
  const t = toLab(hex);
  let best = 0, bestD = -1;
  for (let i = 0; i < LAB.length; i++) {
    const d0 = t[0] - LAB[i][0], d1 = t[1] - LAB[i][1], d2 = t[2] - LAB[i][2];
    const d = d0 * d0 + d1 * d1 + d2 * d2;
    if (bestD < 0 || d < bestD) { bestD = d; best = i; }
  }
  return NAMES[best].name;
}
