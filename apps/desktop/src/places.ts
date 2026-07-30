/**
 * The pictures the game draws a place with, kept for as long as the window is open.
 *
 * Every segment this app shows is filed under the place it happened in, and a place arrives from
 * the addon as a name and nothing else — the client reports where a player is standing by its
 * localised name, so a name is the whole of what there is to key on. The Encounter Journal and the
 * group finder are both keyed by that same name and both draw a picture beside it, which is the
 * hop the backend makes. See `journal.rs`.
 *
 * Most of what this is asked about comes back with nothing, and that is the ordinary case rather
 * than a failure: an evening in Durotar is a place the game draws no icon for anywhere. A dungeon,
 * a raid and a delve have one, and those are the rows that end up with a picture beside them.
 *
 * The batching and the remembering are [`iconBook`]'s, which the currency holdings share.
 */

import { createIconBook } from "./iconBook";
import type { IconBook, IconBookOptions } from "./iconBook";

export type PlaceIconsOptions = IconBookOptions<string>;
export type PlaceIcons = IconBook<string>;

export function createPlaceIcons(options: PlaceIconsOptions): PlaceIcons {
  return createIconBook<string>(options);
}

/**
 * The wide banner a place is drawn across, which is the header the segment modal opens with.
 *
 * A second book rather than more of the first, because the two pictures are wanted at different
 * times and in different numbers: an icon goes beside every row of the timeline, a banner above
 * the one segment somebody opened. One book for both would have a page of forty evenings decoding
 * forty headers nobody asked to see.
 *
 * Unlike an icon, this always answers: the places the game draws no art for — which is most of
 * them — come back with the banner it shows when it will not say which dungeon. See
 * `journal::heroes_of`.
 */
export type PlaceHeroes = IconBook<string>;

export function createPlaceHeroes(options: PlaceIconsOptions): PlaceHeroes {
  return createIconBook<string>(options);
}
