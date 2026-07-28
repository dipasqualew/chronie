/**
 * What the reader has put on the character, and the rules about what can go where.
 *
 * The transmog view is a wardrobe rather than a catalogue: appearances are picked out of any
 * number of sets and worn at once, and the character stands there wearing whatever has been
 * assembled. This is the assembly — which place on the body an appearance occupies, what
 * replaces what, and what the backend is handed to draw it. The drawing over it is
 * `outfitPanel.tsx` and the browsing beside it is `transmogView.tsx`.
 *
 * **A place is somewhere on the body, not a kind of item.** That distinction is the whole of
 * this module and it is what a single set never needed: within one set nothing contests
 * anything, and across two of them everything does. A one-hander and a two-hander are
 * different items and the same right hand, so wearing one takes the other off; a shield and an
 * off-hand are the other hand as each other. For armour the place is the slot the game files
 * the appearance under, and there the two coincide.
 *
 * What is *not* here is which of two pieces wins a contested geoset group, or which texture
 * goes over which. Those are arguments between pieces the character is already wearing, and
 * `worn::of_set` settles both out of the game's own tables — see `docs/character-rendering.md`.
 * This decides only what is handed to it.
 */

import { wearable as canBeWorn } from "./modelPreview";
import type { Previewable } from "./modelPreview";
import { heldIn, slotName } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type { TransmogSet, WornPiece } from "./types";

/**
 * The armour slots, as `ItemAppearance.DisplayType` numbers them.
 *
 * Everything above 10 is a weapon or a shield, and where one of those goes is a question the
 * display type does not answer — [`heldIn`] asks the item instead.
 */
const LAST_ARMOUR_SLOT = 10;

/**
 * Every place something can be worn, in the order the list beside the character reads.
 *
 * Head down the body to the feet and then the two hands, which is roughly how the game's own
 * character sheet is laid out. It is deliberately **not** `worn::SLOT_LAYER`: that order is
 * about which texture lands over which, and this one is about where a reader's eye goes.
 */
const PLACES = [
  "armour-0", "armour-1", "armour-9", "armour-2", "armour-3", "armour-10", "armour-4",
  "armour-7", "armour-8", "armour-5", "armour-6", "hand-right", "hand-left",
] as const;

/** What the two hands are called, since no display type names them. */
const HANDS: Record<string, string> = {
  "hand-right": "Main hand",
  "hand-left": "Off hand",
};

/**
 * What a place is worked out from, which is the same reading a row is drawn from.
 *
 * `Previewable` rather than a subset of it, so that "can this be worn" is asked of exactly one
 * shape in exactly one place — [`canBeWorn`] — and this only adds *where*.
 */
export type Placeable = Previewable;

/**
 * Where on the body an appearance goes, or nothing when there is nowhere to put it.
 *
 * Nothing is an ordinary answer twice over, and both are things the game says rather than
 * failures of this app: an appearance it keeps encrypted has no slot anybody can read, and an
 * item filed under a weapon slot that nobody holds — arrows — has no hand. `wearable` in
 * `modelPreview.ts` is what decides that, and is the same reading the row itself is drawn
 * from; this adds the half a wardrobe needs, which is *where* the ones that can be worn go.
 */
export function placeOf(row: Placeable): string | null {
  if (canBeWorn(row).kind !== "worn") return null;
  if (row.displayType >= 0 && row.displayType <= LAST_ARMOUR_SLOT) return `armour-${row.displayType}`;
  const hand = heldIn(row.displayType, row.inventoryType);
  return hand ? `hand-${hand}` : null;
}

/** Whether the character can be dressed in this at all. */
export function wearable(row: Placeable): boolean {
  return placeOf(row) !== null;
}

/**
 * The rows of a set that have a place on the character, in the order the set lists them.
 *
 * What is left out is the two the game itself has nothing to put anywhere — an appearance it
 * keeps encrypted, and a thing filed under a weapon slot that nobody holds — and both are
 * dead weight in a list a reader is clicking down: they are a disabled button and a sentence
 * saying why, repeated among the pieces they cannot be worn beside. Rare, too: on
 * 12.0.5.67823 three rows in the whole game have no place, against 72,141 the sets name. So
 * the browser hides them by default and says how many it hid, and the checkbox is for the
 * reader who wants to see what a set is really made of.
 */
export function onlyWearable(rows: AppearanceRow[]): AppearanceRow[] {
  return rows.filter((row) => wearable(row));
}

/**
 * Where a place sits in the order the body reads, head downwards.
 *
 * Exported because a saved set is a handful of places out of a database, and the order they
 * come back in is the database's rather than a body's. This is the one place that order is
 * written down — see [`PLACES`] — and a saved set is listed by asking it rather than by
 * inventing a second answer. A place nothing here knows sorts to the end rather than being
 * dropped: it would be a set saved by a later Chronie that knew about a place this one does
 * not, and losing a piece silently is worse than listing it last.
 */
export function placeOrder(place: string): number {
  const at = (PLACES as readonly string[]).indexOf(place);
  return at < 0 ? PLACES.length : at;
}

/** What the list beside the character calls a place. */
export function placeName(place: string, row?: Placeable): string {
  if (HANDS[place]) return HANDS[place];
  return slotName(Number(place.slice("armour-".length)), row?.inventoryType ?? 0);
}

/** One appearance the reader has put on, and enough about it to list and to take off again. */
export interface Worn {
  /** Where on the body it is, which is what only one thing at a time can occupy. */
  place: string;
  row: AppearanceRow;
  /**
   * Where the reader took it from, as the line the panel prints under the item's name.
   *
   * A set's name, and **empty for a look picked out of the game at large** — which is the
   * whole of what the two halves of the view differ by once a piece is on. A wardrobe list
   * browses appearances rather than anybody's idea of an outfit, so there is no second name
   * to give, and inventing one ("the wardrobe", the slot it fills) would be a line saying
   * either nothing or what the badge beside it already says.
   */
  from: string;
}

/**
 * The outfit itself: at most one piece per place, keyed by the place.
 *
 * A plain object rather than a Map because it is React state and is replaced rather than
 * mutated — every function here answers with a new one, and the panel redraws on the identity.
 */
export type Outfit = Readonly<Record<string, Worn>>;

export const NOTHING_ON: Outfit = {};

/**
 * Puts one appearance on, taking off whatever was in that place.
 *
 * Replacement is the point rather than a convenience: a second helm cannot go on over the
 * first, and a reader clicking down a set trying hats expects each one to be *the* hat.
 *
 * An appearance with nowhere to go leaves the outfit alone. The row is what says so to the
 * reader — see [`wearable`] — and this is the floor under it.
 */
export function wear(outfit: Outfit, row: AppearanceRow, from = ""): Outfit {
  const place = placeOf(row);
  if (!place) return outfit;
  return { ...outfit, [place]: { place, row, from } };
}

/**
 * Puts a whole set on at once, which is how a player sees one.
 *
 * A set is a set of clothes and looking at all of it together is the ordinary thing to want;
 * picking twelve rows one at a time to get there is not. Later rows win their place, which is
 * what makes a set naming two things for one slot come out wearing the last of them rather
 * than an arbitrary one.
 */
export function wearSet(outfit: Outfit, rows: AppearanceRow[], set: TransmogSet): Outfit {
  return wearAll(outfit, rows, setLabel(set));
}

/**
 * The same, for a set that is not one of the game's — which is what the reader saved.
 *
 * Nothing about wearing a set of clothes depends on who put it together, so this is the whole
 * of the difference: a name to write under each piece, rather than a `TransmogSet` to take one
 * from. [`wearSet`] is this with the game's own naming rule in front of it.
 */
export function wearAll(outfit: Outfit, rows: AppearanceRow[], from: string): Outfit {
  return rows.reduce((worn, row) => wear(worn, row, from), outfit);
}

/** What the panel calls the set a piece came out of, which the game leaves unnamed for some. */
export function setLabel(set: TransmogSet): string {
  return set.name || `Set ${set.id}`;
}

/** Takes off whatever is in one place. A place nothing is in is left as it was. */
export function takeOff(outfit: Outfit, place: string): Outfit {
  if (!(place in outfit)) return outfit;
  const left = { ...outfit };
  delete left[place];
  return left;
}

/** Puts an appearance on, or takes it off again when it is already the one being worn. */
export function toggle(outfit: Outfit, row: AppearanceRow, from = ""): Outfit {
  const place = placeOf(row);
  if (!place) return outfit;
  return isWorn(outfit, row) ? takeOff(outfit, place) : wear(outfit, row, from);
}

/**
 * Whether an appearance is the one currently worn in its place.
 *
 * By the display rather than by the row, because the same appearance turns up in several sets
 * — a collection's tier variants share most of their pieces — and a reader who put the robe on
 * from one set should see it marked as worn when they find it again in its neighbour.
 */
export function isWorn(outfit: Outfit, row: AppearanceRow): boolean {
  const place = placeOf(row);
  if (!place) return false;
  return outfit[place]?.row.displayInfoId === row.displayInfoId;
}

/** The outfit as a list, head downwards, which is how it is drawn beside the character. */
export function wornPieces(outfit: Outfit): Worn[] {
  return PLACES.map((place) => outfit[place]).filter((piece): piece is Worn => Boolean(piece));
}

/**
 * What the backend is asked to dress her in.
 *
 * The order is this module's, head downwards, and the backend does not care: `worn::of_set`
 * lays the pieces out by `SLOT_LAYER` before it does anything else, and `wornSetKey` sorts
 * before it names one. So this is the order a reader would list them in, and nothing depends
 * on it being that one.
 */
export function piecesOf(outfit: Outfit): WornPiece[] {
  return wornPieces(outfit).map(({ row }) => ({
    displayInfoId: row.displayInfoId,
    displayType: row.displayType,
    inventoryType: row.inventoryType,
  }));
}

/** How the outfit reads as one line: how much is on, and how much of her is still bare. */
export function outfitSummary(outfit: Outfit): string {
  const worn = wornPieces(outfit).length;
  if (!worn) return "Nothing on yet. Pick an appearance from any set.";
  return `${worn} of ${PLACES.length} slots filled`;
}
