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
import { itemName } from "./items";
import { wearable } from "./modelPreview";
import { wornPieces } from "./outfit";
import type { Outfit } from "./outfit";
import { ANY_CLASS, heldIn, slotName } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type {
  CharacterInGameSets,
  InGameSet,
  InGameSetSlot,
  InGameSetsPayload,
  SetRequest,
  TransmogAppearance,
  WornPiece,
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
    : itemName(appearance.itemId, appearance.name);
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
    sources: [
      {
        label: itemName(appearance.itemId, appearance.name),
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
      },
    ],
    liftsRestriction: false,
  };
}

/** And a whole opened set as rows, which is what the list draws and what she is dressed in. */
export function rowsOf(appearances: TransmogAppearance[]): AppearanceRow[] {
  return appearances.map(rowOf);
}

/**
 * The same set as an outfit to be drawn on a body, which is what the character view asks for.
 *
 * The other thing an opened set is good for, and the shorter road: the transmog view resolves a
 * set into rows so that a reader can put pieces on one at a time, and the character view has
 * nobody to dress but the character whose page it is — so it takes the set whole.
 *
 * **A piece the character has nowhere to put is left out rather than sent.** Those are exactly
 * the two [`wearable`] refuses — an appearance the game encrypts, and a thing filed under a
 * weapon slot nobody holds — and sending one would ask the backend to put a look somewhere no
 * body has. The set is still what the set is; it simply has one fewer thing showing.
 *
 * At most one of each, because a picture of a set naming the same sword twice is the picture of
 * it naming the sword once: the two hands are a fact about the *set*, which the list next door
 * draws, and not a fact about the body.
 */
export function wornFrom(appearances: TransmogAppearance[]): WornPiece[] {
  const worn: WornPiece[] = [];
  for (const row of rowsOf(appearances)) {
    const wanted = wearable(row);
    if (wanted.kind !== "worn") continue;
    const already = worn.some(
      (one) =>
        one.displayInfoId === wanted.piece.displayInfoId &&
        one.displayType === wanted.piece.displayType &&
        one.inventoryType === wanted.piece.inventoryType,
    );
    if (!already) worn.push(wanted.piece);
  }
  return worn;
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

/* ---------- and the one thing this app sends the other way ---------- */

/**
 * `ItemAppearance.DisplayType` to the client's `TransmogSlot`, which are two different numberings
 * of the same eleven places and agree about six of them.
 *
 * The disagreements are the reason this table is written out rather than computed: a shirt is
 * display type 2 and transmog slot 4, a back is 9 and 2, a tabard 10 and 5, a waist 4 and 8, and
 * legs and feet and wrists and hands all differ too. Nothing in either numbering hints at the
 * other, and getting one wrong would put a cloak where the shirt goes and be discovered by a
 * player looking at their own character wearing it.
 *
 * The index is the display type; the value is the transmog slot. Both are read off the game
 * rather than guessed — `docs/game-files.md` for the first and `docs/transmog-sets.md` for the
 * second, which took it from the client's own `TransmogSlot` enumeration.
 */
const TRANSMOG_SLOT_OF_DISPLAY = [0, 1, 4, 3, 8, 9, 10, 6, 7, 2, 5] as const;

/** What the client calls the two hands, which no display type says — see `heldIn`. */
const MAIN_HAND = 11;
const OFF_HAND = 12;

/**
 * Where the game would put one of these, as the client's own `TransmogSlot`, or nothing.
 *
 * Nothing for exactly the things `outfit.ts` has nowhere to put either — an appearance the game
 * withholds, a thing filed under a weapon slot that nobody holds — so a row that cannot be worn
 * on the character in this app is a row that is not sent to the game either.
 */
export function transmogSlotOf(row: AppearanceRow): number | null {
  // Before the table, not after it. A row the game withholds arrives as zeroes — the backend
  // has nothing to fill it in with — and zero is a perfectly good display type, so a withheld
  // row read off the table comes back as a *head*. The promise above is that this refuses
  // exactly what `outfit.ts` refuses, and `placeOf` asks `canBeWorn` first for the same reason.
  if (row.withheld) return null;
  const armour = TRANSMOG_SLOT_OF_DISPLAY[row.displayType];
  if (armour !== undefined) return armour;
  const hand = heldIn(row.displayType, row.inventoryType);
  if (hand === "right") return MAIN_HAND;
  if (hand === "left") return OFF_HAND;
  return null;
}

/**
 * Where on the character a slot the game named goes, in this app's own words.
 *
 * The way back from `TransmogSlot` to a place, which only a set read out of the game ever needs:
 * it is the one thing that knows which hand a one-hander is in, and `placeOf` — which works it
 * out from the inventory type — cannot, because an off-hand sword and a main-hand sword are the
 * same item. See `wearAllAt`.
 *
 * Derived from the same table as [`transmogSlotOf`] rather than written out again, so the two
 * directions cannot drift apart.
 */
export function placeOfSlot(slot: number): string | null {
  if (slot === MAIN_HAND) return "hand-right";
  if (slot === OFF_HAND) return "hand-left";
  const displayType = TRANSMOG_SLOT_OF_DISPLAY.indexOf(slot as never);
  return displayType < 0 ? null : `armour-${displayType}`;
}

/**
 * What the character has on, as slots the game would understand.
 *
 * The translation the whole send rests on. Everything in this app describes a place the way
 * `outfit.ts` does — `armour-3`, `hand-right` — and the game has never heard of any of it, so
 * this is where an outfit stops being Chronie's idea of one and becomes the game's.
 *
 * Ascending by slot, and at most one per slot: a place holds one thing in `outfit.ts` and one
 * thing in the game, so there is nothing to reconcile and the last writer would win anyway.
 */
export function slotsFrom(outfit: Outfit): InGameSetSlot[] {
  return placed(outfit).map(({ slot, row }) => ({ slot, appearanceId: row.appearanceId }));
}

/**
 * What she has on, paired with the slot the game would file each piece under, in the game's
 * order.
 *
 * The game's order and not the rail's, which is the whole reason this is one function rather
 * than repeated at each of its two callers. `wornPieces` answers in `outfit.ts`'s `PLACES` —
 * head downwards, the order a reader's eye goes — and the game numbers the same eleven places
 * differently enough that a shirt and a chestpiece swap over between the two. Anything that
 * claims to do what the game does has to walk them the game's way.
 *
 * At most one per slot: a place holds one thing in `outfit.ts` and one thing in the game, so
 * there is nothing to reconcile.
 */
function placed(outfit: Outfit): { slot: number; row: AppearanceRow }[] {
  const found = new Map<number, AppearanceRow>();
  for (const { row } of wornPieces(outfit)) {
    const slot = transmogSlotOf(row);
    if (slot === null) continue;
    found.set(slot, row);
  }
  return [...found.entries()]
    .map(([slot, row]) => ({ slot, row }))
    .sort((left, right) => left.slot - right.slot);
}

/**
 * The picture to give a set being sent, which is the first piece's.
 *
 * Blizzard's own `WardrobeCustomSetManager:NewCustomSet` picks it exactly this way — it walks
 * the slots in order and takes the icon of the first one holding an appearance — so a set sent
 * from here ends up wearing the same picture it would have worn if it had been saved in game.
 * *The game's* order, which is why this walks [`placed`] rather than the rail: a reader wearing
 * a shirt and a chestpiece would otherwise be given the shirt's picture where the game would
 * have taken the chest's.
 *
 * Not optional, whatever it looks like: the client's `NewCustomSet` documents `icon` as a
 * `fileID` that may not be nil, so there is no "let the game decide" to fall back on. Nothing
 * is the honest answer only when the outfit has no picture anywhere in it, and the caller has
 * to decide what to do about that rather than send a nil the game will refuse.
 */
export function iconFrom(outfit: Outfit): number | null {
  return placed(outfit).find(({ row }) => row.iconFileDataId > 0)?.row.iconFileDataId ?? null;
}

/**
 * How a request reads once the game has answered it, or while it has not.
 *
 * Four sentences and a wait, because the wait is the ordinary state and the one somebody needs
 * explaining: nothing this app does reaches a running game, so an outfit sent now is saved the
 * next time that character logs in, and a line that said only "sent" would have people opening
 * the game to look for something that is not there yet.
 */
export function requestSummary(request: SetRequest): string {
  switch (request.outcome) {
    case "created":
      return `Saved in game as ${request.name}.`;
    case "updated":
      return `Saved over the in-game set called ${request.name}.`;
    case "full":
      return `Not saved: the account's transmog sets are full. Delete one in game and ${request.name} goes in next login.`;
    case "refused":
      return `Not saved: the game would not accept the name ${request.name}.`;
    case null:
    case undefined:
      return `Waiting for ${request.name} to be saved — it goes in next time you log that account in.`;
    default:
      return `Could not save ${request.name} in game.`;
  }
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
export function setsFor(payload: InGameSetsPayload | null, character: string): InGameSet[] | null {
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
