/**
 * What the game's own pictures say about a look, as against what the game's words say about it.
 *
 * The other half of `marks.ts`, and the same shape of feature seen from the other side. A mark is
 * what one reader typed; a quality is what somebody's copy of the game *looks like*, measured out
 * of the textures and the meshes by `qualities.rs` and committed to this repository as
 * `data/qualities/`. Both hang off the same appearance id and both are drawn on the same row, and
 * the window is careful to say which is which — see [`BUILT_IN`].
 *
 * **Nothing here reads a game install.** The files are imported, not fetched: a reader who has
 * never pointed Chronie at a World of Warcraft folder still gets the colours, and a reader who
 * has pays nothing at startup for them. What it costs is a chunk of JavaScript per slot, which is
 * why they are imported on demand rather than up front — see [`loadQualities`].
 *
 * Two things are worked out here rather than stored, and both for the same reason: they are
 * *readings* of a measurement rather than the measurement, so they belong where they can be
 * changed without regenerating four megabytes of file.
 *
 * - **The name of a colour.** The store holds `#4a3b2c`; a reader searching for "brown" is not
 *   going to type that. [`colourName`] is the whole of what turns one into the other, and it is
 *   the piece most likely to want improving.
 * - **What a row is searchable by.** The browsers already search the words on a row, and these
 *   are words on a row — see [`qualityWords`], which is [`markWords`]'s opposite number.
 */

import type { Facet } from "./terms";
import type { Quality, QualitiesFile, SetQualitiesFile } from "./types";

/**
 * What the window calls these, wherever it has room to call them anything.
 *
 * One phrase in one place, because it appears on a chip's tooltip in two browsers and the whole
 * point of it is that a reader meets the same words both times: this was not typed by anybody,
 * and it is not a fact the game states either — it was measured off the game's own artwork.
 */
export const BUILT_IN = "Measured from the game's own artwork — Chronie worked this out, nobody typed it";

/**
 * Every look of one slot, indexed by the appearance it was measured of.
 *
 * The same shape [`MarkIndex`] has and for the same reason: a file is a list because that is what
 * a JSON array is, and a browser drawing a page of a hundred rows wants a lookup per row rather
 * than a scan of five thousand per keystroke of the search box.
 */
export interface QualityIndex {
  /** What was measured of one subject, or nothing — which is a look the store could not read. */
  of: (id: number) => Quality | undefined;
  /** How many subjects the file holds, which is what says whether it arrived at all. */
  count: number;
  /** The build of the game it was measured off, for the one place that says so out loud. */
  build: string;
}

/** An index over nothing, which is what a browser holds until its slot's file has arrived. */
export const NO_QUALITIES: QualityIndex = { of: () => undefined, count: 0, build: "" };

export function indexQualities(file: QualitiesFile | SetQualitiesFile | null): QualityIndex {
  if (!file) return NO_QUALITIES;
  const rows = "appearances" in file ? file.appearances : file.sets;
  const byId = new Map<number, Quality>();
  for (const row of rows) byId.set(row.id, row);
  return { of: (id) => byId.get(id), count: byId.size, build: file.build };
}

/**
 * The committed store, as modules to be loaded when something wants one.
 *
 * `import.meta.glob` rather than sixteen `import`s, so that adding a slot to the store is a file
 * in a folder and not an edit here. Every one of them is lazy: the whole store is several
 * megabytes and a reader browsing helms should download the helms.
 */
const SLOTS = import.meta.glob<QualitiesFile>("../data/qualities/[0-9]*.json", {
  import: "default",
});
const SETS = import.meta.glob<SetQualitiesFile>("../data/qualities/sets.json", {
  import: "default",
});

/**
 * One slot's file, or nothing where the store holds none.
 *
 * Nothing is an ordinary answer rather than a failure. The store is written by somebody running
 * `dump_qualities` against an install, and a slot the game holds no appearance for — or one added
 * to the game since the store was last regenerated — simply has no file. The rows draw exactly as
 * they drew before any of this existed.
 */
export function loadQualities(displayType: number): Promise<QualitiesFile | null> {
  const load = SLOTS[`../data/qualities/${displayType}.json`];
  return load ? load() : Promise.resolve(null);
}

/** The same for the sets, which are one small file rather than one per slot. */
export function loadSetQualities(): Promise<SetQualitiesFile | null> {
  const load = SETS["../data/qualities/sets.json"];
  return load ? load() : Promise.resolve(null);
}

/**
 * The hues a colour can be called, and where each of them starts.
 *
 * Eight names over the wheel, at the boundaries a person would put them: everything from 345°
 * round to 15° is red, and the pair of narrow bands at teal and purple are there because a reader
 * looking at a teal tabard will not call it either green or blue.
 *
 * The list is walked from the top, so each entry claims from its own degree up to the next one's.
 */
const HUES: Array<[number, string]> = [
  [345, "red"], [290, "pink"], [255, "purple"], [195, "blue"],
  [160, "teal"], [70, "green"], [45, "yellow"], [15, "orange"], [0, "red"],
];

/** Below this a colour has no hue worth naming and is called grey, black or white instead. */
const COLOURLESS = 0.12;

/** Where "dark" gives way to a plain name, and a plain name to "pale". */
const DARK = 0.3;
const PALE = 0.7;

/**
 * What a person would call a colour, in one or two words.
 *
 * For the tooltip, and — much more usefully — for the search box: the browsers search the words
 * on a row, so naming a colour is what makes "dark red gloves" a thing a reader can type. Two
 * words rather than one because both halves are worth typing, and a search that splits on
 * whitespace matches either of them.
 *
 * **Brown is the one name that is not a hue.** There is no brown on the colour wheel — it is a
 * dark orange, and a great deal of the game's armour is exactly that. Calling it "dark orange"
 * would be true and would find nothing, because nobody in the world calls a leather jerkin
 * orange.
 */
export function colourName(hex: string): string {
  const { hue, saturation, lightness } = hsl(hex);
  if (lightness <= 0.08) return "black";
  if (lightness >= 0.92) return "white";
  if (saturation < COLOURLESS) {
    if (lightness < DARK) return "dark grey";
    return lightness > PALE ? "pale grey" : "grey";
  }
  const named = HUES.find(([from]) => hue >= from)?.[1] ?? "red";
  if ((named === "orange" || named === "yellow") && lightness < 0.42) return "brown";
  if (lightness < DARK) return `dark ${named}`;
  if (lightness > PALE) return `pale ${named}`;
  return named;
}

/**
 * A `#rrggbb` as hue, saturation and lightness — the three a name is picked out of.
 *
 * The ordinary conversion. Hue comes back in degrees and the other two as fractions, and a string
 * that is not a colour comes back as black, because the store is a file and a window that threw
 * on a malformed one would be a window that will not open.
 */
function hsl(hex: string): { hue: number; saturation: number; lightness: number } {
  const digits = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = digits ? Number.parseInt(digits[1]!, 16) : 0;
  const red = ((value >> 16) & 0xff) / 255;
  const green = ((value >> 8) & 0xff) / 255;
  const blue = (value & 0xff) / 255;

  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const lightness = (high + low) / 2;
  const spread = high - low;
  if (spread === 0) return { hue: 0, saturation: 0, lightness };

  const saturation = spread / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (high === red) hue = ((green - blue) / spread) % 6;
  else if (high === green) hue = (blue - red) / spread + 2;
  else hue = (red - green) / spread + 4;
  hue *= 60;
  return { hue: hue < 0 ? hue + 360 : hue, saturation, lightness };
}

/**
 * What a measured look adds to the words a search reads, lowercased.
 *
 * [`markWords`]'s opposite number, and it earns its keep the same way: a reader who can see
 * "brown" and "large" on a row will type them into the box above it, and a search that read only
 * names would show them nothing. The hex is not among them — nobody searches for `#4a3b2c`, and
 * the six characters would match a name by accident often enough to be a nuisance.
 */
export function qualityWords(quality: Quality | undefined): string {
  if (!quality) return "";
  return [
    colourName(quality.primary),
    quality.accent ? colourName(quality.accent) : "",
    quality.size ?? "",
  ].join(" ").trim().toLowerCase();
}

/** The two keys a measurement is asked for under, in the box and on a clicked chip alike. */
export const COLOUR = "colour";
export const SIZE = "size";

/**
 * And what it adds to the terms a search reads: `colour:brown`, `size:large`.
 *
 * [`qualityWords`]'s other half, and what the issue behind all of this actually asked for — the
 * words were always there to be typed, but "brown" typed as a word finds the Brownhide Vest too,
 * and there was no way to say that the brown was the thing being asked about.
 *
 * Both colours come back under the one key rather than as `primary` and `accent`. A reader looking
 * at two swatches is looking at a thing that is brown and gold; which of the two the measurement
 * called the fuller is a detail of `qualities.rs` and not a question anybody types.
 */
export function qualityFacets(quality: Quality | undefined): Facet[] {
  if (!quality) return [];
  const facets: Facet[] = [{ key: COLOUR, value: colourName(quality.primary) }];
  if (quality.accent) facets.push({ key: COLOUR, value: colourName(quality.accent) });
  if (quality.size) facets.push({ key: SIZE, value: quality.size });
  return facets;
}

/** How a quality reads on a chip, which is the two colours named and the size word. */
export function qualitySummary(quality: Quality): string {
  const colours = quality.accent
    ? `${colourName(quality.primary)} and ${colourName(quality.accent)}`
    : colourName(quality.primary);
  return quality.size ? `${quality.size}, ${colours}` : colours;
}
