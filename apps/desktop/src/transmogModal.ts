/**
 * What one transmog set is made of, as rows a list can be drawn from.
 *
 * The grid can only count a set's appearances, because that is all `TransmogSetItem` holds.
 * Following one of them to an actual item takes three more of the game's tables, which the
 * backend walks on demand. Everything decidable from what it answers with is decided here;
 * the dialog over it is `transmogDetail.tsx`.
 *
 * A row is named by the item the appearance belongs to, which comes out of a fifth table the
 * backend reads for it. The game withholds the items of content it has not shipped, like
 * everything else along that chain, so a row can arrive without one — and then says which
 * item it is instead, because an id and a link out is still worth opening a set for.
 *
 * The icons arrive after the rows do. Decoding a set's worth of textures takes longer than
 * reading the tables that named them, and a list of slots is worth looking at while that
 * happens — so a row draws an empty frame and fills it in when its picture turns up, or
 * leaves it empty for good if the install has nothing to put there.
 */

import { plural } from "./format";
import type { TransmogAppearance, TransmogSetItemsPayload } from "./types";

/**
 * The slot an appearance fills, as `ItemAppearance.DisplayType` numbers them.
 *
 * Read off an install item by item, and recorded in `docs/game-files.md`: a shirt is 2 and a
 * chestpiece 3, where the community's list puts a chestpiece at 2 and a shirt last. The
 * values past this list are the weapons and the shields, and this is where the numbering runs
 * out — 11 is a sword and a two-hander alike, 15 is a tome and a shield is 13.
 */
const SLOTS = [
  "Head", "Shoulder", "Shirt", "Chest", "Waist", "Legs", "Feet", "Wrist", "Hands", "Back",
  "Tabard",
] as const;

/**
 * What the game calls each place a weapon can be worn, as `ItemSparse.InventoryType` says it.
 *
 * **This is what four display types cannot tell a reader.** `DisplayType` files every weapon
 * and shield in the game under 11, 12, 13 and 15, and nothing in the community's definitions
 * pins down which is a main hand and which an off hand — which is why all four used to be
 * shown as "Weapon or shield" rather than as four labelled guesses. `InventoryType` is the
 * game's own answer to "where does this go" and needs no guessing: counted on 12.0.5.67 with
 * `examples/dump_inventory_types`, display type 13 is 1,749 shields and nothing else, and the
 * 8,280 one-handers and 5,573 two-handers filed under 11 say which they are here.
 *
 * `docs/game-files.md` has the whole cross-tab. A hand of `null` is a thing the game files
 * under a weapon slot and nobody holds — arrows, and an item the game withholds.
 */
const WORN_IN: Record<number, { readonly name: string; readonly hand: "right" | "left" | null }> = {
  13: { name: "One-hand", hand: "right" },
  14: { name: "Shield", hand: "left" },
  15: { name: "Ranged", hand: "left" },
  17: { name: "Two-hand", hand: "right" },
  21: { name: "Main hand", hand: "right" },
  22: { name: "Off hand", hand: "left" },
  23: { name: "Held in off hand", hand: "left" },
  24: { name: "Ammo", hand: null },
  25: { name: "Thrown", hand: "right" },
  26: { name: "Ranged", hand: "right" },
  29: { name: "Profession tool", hand: "right" },
  30: { name: "Profession accessory", hand: "left" },
};

/** The display types that are a weapon or a shield rather than a piece of armour. */
const WEAPONRY = new Set([11, 12, 13, 14, 15]);

/**
 * What a row calls its slot: the armour slot it fills, or where a weapon is worn.
 *
 * A weapon the game says nothing about falls back to what the display type says on its own,
 * which is only that it is a weapon of some kind — the same sentence the view used to give all
 * four of them.
 */
export function slotName(displayType: number, inventoryType = 0): string {
  const armour = SLOTS[displayType];
  if (armour) return armour;
  if (!WEAPONRY.has(displayType)) return `Slot ${displayType}`;
  return WORN_IN[inventoryType]?.name ?? "Weapon or shield";
}

/**
 * Whether the character can be shown holding this, which is not the same as it being a weapon.
 *
 * The hand comes out of the same table as the name and is the backend's `worn::held_in` read
 * from the other end: it puts a one-hander on the right hand's attachment, an off-hand on the
 * left's and a shield on the forearm's. Where the game says nothing there is nowhere to put
 * the model, and the window shows it on its own instead.
 */
export function isHeld(displayType: number, inventoryType: number): boolean {
  return WEAPONRY.has(displayType) && (WORN_IN[inventoryType]?.hand ?? null) !== null;
}

/** One appearance as a row reads it, with everything the markup needs already decided. */
export interface AppearanceRow {
  slot: string;
  /** What names the row: the item's own name, its id where the game gives none, and a plain
   * apology where the appearance itself is withheld. */
  label: string;
  itemId: number;
  appearanceId: number;
  /** Which slot the game says it fills, which is what decides whether it has geometry. */
  displayType: number;
  /** And where it is worn, which for a weapon is what decides which hand holds it. */
  inventoryType: number;
  /** What the backend is asked for when the row is picked, and how a model is keyed. */
  displayInfoId: number;
  /** Which texture is the row's picture, or zero when the game names none for it. */
  iconFileDataId: number;
  hasModel: boolean;
  /** True when the game encrypts a hop of the chain, so nothing can be said about it. */
  withheld: boolean;
}

/**
 * The rows a payload draws as, in the order the backend already sorted them.
 *
 * An appearance the game withholds keeps its place rather than being dropped, because the
 * set's own count includes it and a list one shorter than the card promised reads as a bug.
 * An item the game names nothing keeps its id for the same reason: a blank where a name
 * should be reads as this app having lost it, and the id is what a reader can act on.
 */
export function appearanceRows(payload: TransmogSetItemsPayload): AppearanceRow[] {
  return (payload.appearances || []).map((appearance: TransmogAppearance) => {
    const withheld = !appearance.itemId;
    return {
      slot: withheld ? "Unknown slot" : slotName(appearance.displayType, appearance.inventoryType),
      label: withheld
        ? "The game keeps this appearance encrypted"
        : appearance.name || `Item ${appearance.itemId}`,
      itemId: appearance.itemId,
      appearanceId: appearance.appearanceId,
      displayType: appearance.displayType,
      inventoryType: appearance.inventoryType,
      displayInfoId: appearance.displayInfoId,
      iconFileDataId: appearance.iconFileDataId,
      hasModel: appearance.hasModel,
      withheld,
    };
  });
}

/**
 * The textures a set's rows need, without the repeats.
 *
 * A set names the same appearance twice often enough, and two slots of one set can share a
 * picture, so asking per row would ask for the same texture several times over. Zero is what
 * an appearance the tables give no icon carries, and there is no file behind it.
 */
export function iconIds(payload: TransmogSetItemsPayload): number[] {
  const wanted = (payload.appearances || []).map((appearance) => appearance.iconFileDataId);
  return [...new Set(wanted)].filter((id) => id > 0);
}

/** How the set's contents read as one line: how many, and how many could not be named. */
export function appearanceSummary(payload: TransmogSetItemsPayload): string {
  const total = (payload.appearances || []).length;
  if (!total) return "The game lists no appearances for this set.";
  const withheld = payload.withheldCount > 0
    ? ` · ${payload.withheldCount} the game keeps encrypted`
    : "";
  return `${plural(total, "appearance")}${withheld}`;
}
