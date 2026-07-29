/**
 * What happened to a character's equipment sets, in words.
 *
 * The addon files a set that appeared, one that went away, or one whose items were edited,
 * along with what each changed slot holds afterwards. The backend hands back what each slot
 * replaced by reading the row behind it in the ledger. This is the arithmetic and the
 * wording over that pair — pure, so both the session chip and the detail list can read the
 * same change the same way without either of them owning the rule.
 */

import type { EquipsetChangeEvent, EquipsetSlotChange } from "./types";

/**
 * What the game calls each inventory slot an equipment set can name.
 *
 * The ledger stores the client's slot number, which is the only thing that survives a locale
 * change; the names are this window's own, in the order the character sheet lays them out.
 * Slot 18 is the old ranged slot, kept because a set recorded on a classic client can still
 * name it, and 4 the shirt, which is not armour but is part of an outfit.
 */
const SLOT_NAMES: Record<number, string> = {
  1: "Head",
  2: "Neck",
  3: "Shoulder",
  4: "Shirt",
  5: "Chest",
  6: "Waist",
  7: "Legs",
  8: "Feet",
  9: "Wrist",
  10: "Hands",
  11: "Ring 1",
  12: "Ring 2",
  13: "Trinket 1",
  14: "Trinket 2",
  15: "Back",
  16: "Main hand",
  17: "Off hand",
  18: "Ranged",
  19: "Tabard",
};

/** What the character sheet calls a slot, or its number where this build has no name. */
export const slotName = (slot: number): string => SLOT_NAMES[slot] || `Slot ${slot}`;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * What a change did to the set's item level, or null when it cannot be said.
 *
 * Only the slots that changed are in the event, and that is enough: every other slot holds
 * what it held, so the difference across the changed ones *is* the difference across the
 * whole set. A slot holding nothing contributes nothing on its side, which is what makes a
 * created set's total come out as the set's own item level.
 *
 * A slot holding an item whose level never reached the ledger makes the sum unanswerable,
 * and null is the answer then. Adding up only the ones that are known would quietly report
 * a drop of several hundred as though the missing items had been worth nothing at all.
 */
export function equipsetLevelChange(
  change: EquipsetChangeEvent,
): { before: number; after: number } | null {
  let before = 0;
  let after = 0;
  for (const item of change.items || []) {
    if (item.itemId != null) {
      if (item.itemLevel == null) return null;
      after += item.itemLevel;
    }
    if (item.previousItemId != null) {
      if (item.previousItemLevel == null) return null;
      before += item.previousItemLevel;
    }
  }
  return { before, after };
}

/** How the change names itself: the set, and what became of it. */
export const equipsetTitle = (change: EquipsetChangeEvent): string =>
  `${change.name || `Set ${change.setId}`} ${change.kind}`;

/**
 * The quieter half of the line: how much was touched, and where the item level went.
 *
 * A created or deleted set has nothing to have moved from or to, so its items are reported
 * as a level rather than as a change of one — "+639 ilvl" for a set made out of nothing is
 * arithmetic nobody asked for. An edit is the opposite: the delta is the whole point, and
 * the levels on either side are only worth printing as the distance between them.
 */
export function equipsetDetail(change: EquipsetChangeEvent): string {
  const slots = (change.items || []).length;
  const levels = equipsetLevelChange(change);
  if (change.kind !== "updated") {
    if (slots === 0) return "no items";
    const total = levels && (change.kind === "created" ? levels.after : levels.before);
    return `${plural(slots, "item")}${total ? `, ${Math.round(total / slots)} ilvl` : ""}`;
  }
  if (!levels || levels.after === levels.before) return plural(slots, "slot");
  const moved = levels.after - levels.before;
  return `${plural(slots, "slot")}, ${moved > 0 ? "+" : "−"}${Math.abs(moved)} ilvl`;
}

/**
 * One slot of a change, as a row reads it: what was there, and what is there now.
 *
 * The items themselves are ids rather than words. Naming an item — its own name, the picture
 * beside it, the colour of its quality — is `GameItem`'s business and is the same everywhere
 * in the app; what belongs to a slot of an equipment set, and to nothing else, is what the
 * piece was worth.
 */
export interface EquipsetSlotLine {
  slot: string;
  /** The item currently in the slot, or null where the change emptied it. */
  itemId: number | null;
  previousItemId: number | null;
  /** What the piece in the slot is worth, upgrades and all. Empty where nothing said. */
  level: string;
  previousLevel: string;
}

/**
 * How one slot's change reads.
 *
 * A level arrives where the client could be asked and is absent where it could not, which is
 * the ordinary shape of this data: saving a set saves what is equipped, so the item that went
 * in was on the character and could be asked its real level. A change only noticed at a later
 * login has the id alone, and the row still says what it knows.
 */
export function equipsetSlotLine(item: EquipsetSlotChange): EquipsetSlotLine {
  const worth = (id?: number | null, level?: number | null): string =>
    id == null || level == null ? "" : String(level);
  return {
    slot: slotName(item.slot),
    itemId: item.itemId ?? null,
    previousItemId: item.previousItemId ?? null,
    level: worth(item.itemId, item.itemLevel),
    previousLevel: worth(item.previousItemId, item.previousItemLevel),
  };
}
