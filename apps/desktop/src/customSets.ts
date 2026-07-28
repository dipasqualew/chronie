/**
 * The sets the reader puts together themselves, going onto the character and coming off it.
 *
 * The transmog view browses the game two ways — Blizzard's sets, and the game's whole wardrobe
 * by the kind of thing — and this is the third: what somebody assembled out of both and saved
 * under a name. `customsets.rs` is where one is stored and `customSetList.tsx` is what draws
 * them; this is the two translations between a saved set and the rest of the view, and what a
 * filter over a list of them leaves.
 *
 * **A saved piece becomes exactly the row a set's piece is.** That is the whole trick, and it is
 * why nothing downstream of here has to know that a set came out of a database rather than out
 * of the game: `outfit.ts` dresses the character from an [`AppearanceRow`] and does not ask
 * where the row came from, and a look inside a saved set carries the same `appearanceId` — so
 * the same star — that it carries in the two browsers beside it.
 *
 * What a saved piece does *not* carry is the three facts a row draws about the *item*: who may
 * wear it, what level it takes, what colour the game writes it in. Those were never stored,
 * because they are facts about one of the several items that sell a look and the thing saved is
 * the look. So the row built here claims none of them and the list draws none of them — see
 * [`rowOf`], which is where the one invented value in this file lives.
 */

import { ago } from "./format";
import { markFacets, markWords, survivesMarks } from "./marks";
import type { MarkFilter } from "./marks";
import { placeOrder, wornPieces } from "./outfit";
import type { Outfit } from "./outfit";
import { asksAnything, matchesTerms, matchesWords, parseQuery } from "./terms";
import type { Facet } from "./terms";
import { ANY_CLASS, slotName } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type { CustomSet, CustomSetPiece, TransmogMark } from "./types";

/**
 * What the character has on, as something to save.
 *
 * Head downwards, which is the order `wornPieces` already answers in and the order the pieces
 * are listed in again when the set is opened. The place is carried across as it is: which hand
 * a one-hander goes in is settled once in `outfit.ts` and stored rather than worked out twice.
 */
export function piecesFrom(outfit: Outfit): CustomSetPiece[] {
  return wornPieces(outfit).map(({ place, row }) => ({
    place,
    appearanceId: row.appearanceId,
    itemId: row.itemId,
    name: row.label,
    displayType: row.displayType,
    inventoryType: row.inventoryType,
    displayInfoId: row.displayInfoId,
    iconFileDataId: row.iconFileDataId,
    hasModel: row.hasModel,
  }));
}

/**
 * One saved piece, as the row every other part of this view already knows how to draw and wear.
 *
 * The single source is invented rather than stored, and is the reason the list beside this
 * draws no class, no level and no quality: a source is an *item* and what was saved is a
 * *look*, so the honest thing to claim about the item is nothing. `ANY_CLASS` is the mask that
 * makes no claim — it is what an item nobody is locked out of carries — and the two zeroes are
 * read by nothing, because the row has one source and every one of those facts is drawn only
 * where a row's sources disagree.
 *
 * `withheld` is false for the same reason it is false on a wardrobe row: a look the game would
 * say nothing about never reached the character, so it was never in an outfit to be saved.
 */
export function rowOf(piece: CustomSetPiece): AppearanceRow {
  return {
    // What the game calls the place, rather than what `outfit.ts` calls it: this is the badge
    // on a row, and a row in a saved set should read the way the same row read in the set it
    // was picked out of — see `wardrobeRow`, which names its slot the same way.
    slot: slotName(piece.displayType, piece.inventoryType),
    label: piece.name || `Item ${piece.itemId}`,
    itemId: piece.itemId,
    appearanceId: piece.appearanceId,
    displayType: piece.displayType,
    inventoryType: piece.inventoryType,
    displayInfoId: piece.displayInfoId,
    iconFileDataId: piece.iconFileDataId,
    hasModel: piece.hasModel,
    withheld: false,
    sources: [{
      label: piece.name || `Item ${piece.itemId}`,
      itemId: piece.itemId,
      modifiedAppearanceId: piece.appearanceId,
      inventoryType: piece.inventoryType,
      allowableClass: ANY_CLASS,
      requiredLevel: 0,
      quality: 0,
      itemCount: 1,
    }],
    liftsRestriction: false,
  };
}

/** The pieces of a saved set in the order the body reads, head downwards. */
export function piecesInOrder(set: CustomSet): CustomSetPiece[] {
  return [...set.pieces].sort((left, right) => placeOrder(left.place) - placeOrder(right.place));
}

/** And those pieces as rows, which is what the list draws and what the character is dressed in. */
export function rowsOf(set: CustomSet): AppearanceRow[] {
  return piecesInOrder(set).map(rowOf);
}

/**
 * Everything a search matches a saved set against, as one lowercased string.
 *
 * The name first, because the reader chose it. Then **what is in it**, which is the thing the
 * two browsers beside this one cannot offer: somebody who remembers putting the Tideglass
 * Mantle in one of their sets and not which one types the mantle, and the set with it in comes
 * back. And then whatever they filed it under, for the reason it is in every other search in
 * this view — a word on the row is a word they will type into the box.
 */
function searchable(set: CustomSet, mark: TransmogMark | undefined): string {
  return [
    set.name,
    ...set.pieces.map((piece) => piece.name),
    markWords(mark),
  ].join(" ").toLowerCase();
}

/**
 * And what one says under a name, which is what a `key:value` term reads — see `terms.ts`.
 *
 * `piece` rather than `name` for what is in it, because both are names and a reader asking
 * `piece:mantle` is asking about the contents rather than about what they called the set. The
 * measured qualities are not here and cannot be: what was saved is a list of looks out of several
 * slots, and the store measures a look at a time.
 */
function facetsOf(set: CustomSet, mark: TransmogMark | undefined): Facet[] {
  const own = [
    { key: "name", value: set.name },
    ...set.pieces.map((piece) => ({ key: "piece", value: piece.name })),
    // The empty ones out of these and out of the tags beside them, which keep theirs: a piece the
    // game withheld the name of answers `piece:` with nothing, and a label's empty value is what
    // a label is. See the same paragraph in `wardrobe.ts`.
  ].filter((facet) => facet.value !== "");
  return [...own, ...markFacets(mark)];
}

/**
 * The saved sets a filter leaves, in the order the backend sorted them — which is by name.
 *
 * Every word rather than the whole phrase, the way both browsers beside it search, so "horde
 * mantle" finds what neither word finds alone — and a `key:value` term beside the words asks
 * about one thing a set says rather than about all of them.
 */
export function filterCustomSets(
  sets: CustomSet[],
  filters: {
    search: string;
    /** What the reader has said about these sets, and what they have narrowed it to. */
    marks?: { filter: MarkFilter; of: (setId: number) => TransmogMark | undefined };
  },
): CustomSet[] {
  const query = parseQuery(filters.search);
  const asked = asksAnything(query);
  return sets.filter((set) => {
    const mark = filters.marks?.of(set.id);
    if (filters.marks && !survivesMarks(mark, filters.marks.filter)) return false;
    if (!asked) return true;
    if (query.terms.length && !matchesTerms(query.terms, facetsOf(set, mark))) return false;
    return matchesWords(query.words, searchable(set, mark));
  });
}

/**
 * How a saved set reads under its name: how much is in it, and when it was last put there.
 *
 * The last save rather than the first, because that is what the set on screen *is* — a set
 * saved over three times is three outfits and the reader is looking at the third.
 *
 * @param now The moment to reckon from; injected so the tests can pin it.
 */
export function savedSummary(set: CustomSet, now?: number): string {
  const pieces = set.pieces.length;
  return `${pieces} ${pieces === 1 ? "piece" : "pieces"} · saved ${ago(set.updatedAt, now)}`;
}

/**
 * The set already saved under a name, if there is one — which is what makes saving a *replace*.
 *
 * Without regard to case, because that is what the database's `COLLATE NOCASE` makes of it: a
 * reader typing "horde look" over the "Horde look" they saved yesterday means that set, and a
 * button offering to save a second one beside it would be lying about what is about to happen.
 */
export function setNamed(sets: CustomSet[], name: string): CustomSet | undefined {
  const wanted = name.trim().replace(/\s+/g, " ").toLowerCase();
  if (!wanted) return undefined;
  return sets.find((set) => set.name.toLowerCase() === wanted);
}
