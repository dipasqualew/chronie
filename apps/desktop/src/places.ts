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
 * The picture of a place, which is the header the segment modal opens with.
 *
 * A second book rather than more of the first, because the two pictures are wanted at different
 * times and in different numbers: an icon goes beside every row of the timeline, a header above
 * the one segment somebody opened. One book for both would have a page of forty evenings decoding
 * forty headers nobody asked to see — and, for the zones among them, assembling forty maps.
 *
 * Unlike an icon, this always answers. A dungeon comes back with the banner the game paints it
 * with; an open-world zone, which is where most segments happened and for which the game paints
 * nothing at all, comes back with the map it draws of the place — put together out of the fragments
 * a map is stored in, with the towns and roads a player only sees once they have been there painted
 * on top of it. Only a place with neither gets a stand-in. See `heroes::heroes_of`.
 */
export type PlaceHeroes = IconBook<string>;

export function createPlaceHeroes(options: PlaceIconsOptions): PlaceHeroes {
  return createIconBook<string>(options);
}
