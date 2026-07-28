/**
 * The sets the player saved in the *game*, as the transmog view browses them.
 *
 * The fourth thing that screen lists, and the last one it was missing. Blizzard's sets are a
 * table in the game's files; the whole wardrobe is those files cut by the kind of thing; the
 * reader's own sets are rows this app wrote. These are the ones that were already there — put
 * together at a transmogrifier long before Chronie was installed — and until Midnight there was
 * no way to ask the client for them at all. `docs/transmog-sets.md` is the looking that settled
 * that; `ingamesets.rs` is where one is stored; this is the rules over them.
 *
 * **An in-game set names appearances and nothing else**, which is the one way it differs from a
 * set of the reader's own and the reason for almost everything in this file. A `CustomSet`
 * arrives whole, because this app wrote down what the reader was looking at. An in-game set
 * arrives as a list of `ItemModifiedAppearance` ids, because that is the whole of what the game
 * tells the addon — so it has to be *opened*, at the cost of the same four table walks a
 * Blizzard set costs, and on a machine without the game installed it can be listed and not
 * opened. See `0018_in_game_sets.sql`, which argues that trade.
 *
 * The consequence for searching is worth stating, because it is a real loss against the browser
 * next door: [`filterInGameSets`] can match a set's *name* and not what is in it. `customSets.ts`
 * can search the pieces because the pieces are stored; here they are ids until somebody opens
 * the set, and a search that silently only worked on the sets you had already clicked would be
 * worse than one that plainly works on names.
 */

import { ago, plural } from "./format";
import { ANY_CLASS, slotName } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type {
  CharacterInGameSets, InGameSet, InGameSetsPayload, TransmogAppearance,
} from "./types";

/** What the game calls a set it would not name — its own API is documented as sometimes not. */
export const UNNAMED = "Unnamed set";

/** How a set reads under its own name, which is never empty even when the game's answer was. */
export function setLabel(set: InGameSet): string {
  return set.name.trim() || UNNAMED;
}

/**
 * The appearances a set is made of, in slot order, as the ids the backend is asked for.
 *
 * Slot order rather than sorted or deduplicated, because the backend answers one row per id in
 * the order it was asked and this is what makes the answer line up with the slots again. A set
 * wearing one sword in both hands names it twice, and both slots are real.
 */
export function appearanceIds(set: InGameSet): number[] {
  return [...set.slots]
    .sort((left, right) => left.slot - right.slot)
    .map((held) => held.appearanceId);
}

/**
 * One resolved appearance as the row every other part of this view already draws and wears.
 *
 * The same translation `customSets.ts` does for a saved piece, and for the same reason: nothing
 * downstream should have to know where a row came from. What differs is that this one has the
 * game's own answers to hand — the class mask, the level, the quality — because they were read
 * out of the game's files a moment ago rather than remembered from months back. So unlike a
 * saved piece, this claims them.
 *
 * **One row per slot, never grouped.** `appearanceRows` folds a Blizzard set's several items
 * down onto the looks they sell, which is right there: a set names one look through five items
 * and the reader wants the look. An in-game set names one appearance *per place on the body*,
 * so folding two of them together would be losing a slot the player filled — the same sword in
 * both hands would come back as one sword.
 */
export function rowOf(appearance: TransmogAppearance): AppearanceRow {
  const withheld = !appearance.itemId;
  const label = withheld
    ? "The game keeps this appearance encrypted"
    : appearance.name || `Item ${appearance.itemId}`;
  return {
    slot: withheld ? "Unknown slot" : slotName(appearance.displayType, appearance.inventoryType),
    label,
    itemId: appearance.itemId,
    appearanceId: appearance.appearanceId,
    displayType: appearance.displayType,
    inventoryType: appearance.inventoryType,
    displayInfoId: appearance.displayInfoId,
    iconFileDataId: appearance.iconFileDataId,
    hasModel: appearance.hasModel,
    withheld,
    sources: [{
      label: appearance.name || `Item ${appearance.itemId}`,
      itemId: appearance.itemId,
      modifiedAppearanceId: appearance.modifiedAppearanceId,
      inventoryType: appearance.inventoryType,
      // The game's own answers rather than the shrug a saved piece has to give, because these
      // came out of `ItemSparse` on this machine a moment ago. `ANY_CLASS` where the game
      // withheld the item, which is the mask that makes no claim about who may wear it.
      allowableClass: withheld ? ANY_CLASS : appearance.allowableClass,
      requiredLevel: appearance.requiredLevel,
      quality: appearance.quality,
      itemCount: 1,
    }],
    liftsRestriction: false,
  };
}

/** And a whole opened set as rows, which is what the list draws and what she is dressed in. */
export function rowsOf(appearances: TransmogAppearance[]): AppearanceRow[] {
  return appearances.map(rowOf);
}

/**
 * The sets a filter leaves, in the order the backend sorted them — which is by name.
 *
 * Every word rather than the whole phrase, the way every other search in this view works, so
 * "winter horde" finds what neither word finds alone. Names only — see the note at the top of
 * this file, which is where that limit is argued rather than apologised for.
 */
export function filterInGameSets(sets: InGameSet[], search: string): InGameSet[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sets;
  return sets.filter((set) => {
    const against = setLabel(set).toLowerCase();
    return words.every((word) => against.includes(word));
  });
}

/**
 * How a set reads under its name: how much is in it, and when the game last differed about it.
 *
 * "Last changed" rather than "last read", because that is what the addon stores: it moves the
 * moment only when two looks at the wardrobe disagree, so a set nobody has touched for a year
 * says a year even though Chronie has looked at it every evening since.
 *
 * @param now The moment to reckon from; injected so the tests can pin it.
 */
export function setSummary(set: InGameSet, now?: number): string {
  const pieces = plural(set.slots.length, "piece");
  if (!set.observedAt) return pieces;
  return `${pieces} · changed ${ago(set.observedAt, now)}`;
}

/**
 * The characters Chronie has read a wardrobe on, in the order the backend sorted them.
 *
 * A character with no sets is still here, and is not the same as a character that is not: the
 * first has been played since Chronie was installed and saves nothing in game, the second has
 * not been played at all. The window says the first out loud and stays quiet about the second.
 */
export function charactersWithSets(payload: InGameSetsPayload | null): CharacterInGameSets[] {
  return payload?.characters ?? [];
}

/** What one character has, or nothing when Chronie has never read that character's wardrobe. */
export function setsFor(
  payload: InGameSetsPayload | null,
  character: string,
): InGameSet[] | null {
  const found = charactersWithSets(payload).find((entry) => entry.character === character);
  return found ? found.sets : null;
}

/**
 * How a character's wardrobe reads as one line, on the card in the character view.
 *
 * The distinction the return type of [`setsFor`] carries, said out loud: never looked, looked
 * and found none, and found some are three different sentences. The middle one matters most —
 * a player who saves their outfits in the app and not in the game should be told that is what
 * Chronie sees, rather than shown a blank where a number goes.
 */
export function wardrobeSummary(sets: InGameSet[] | null): string {
  if (!sets) return "Chronie has not read this character's wardrobe yet.";
  if (!sets.length) return "No sets saved in game.";
  return `${plural(sets.length, "set")} saved in game`;
}
