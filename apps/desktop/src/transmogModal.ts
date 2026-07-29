/**
 * What one transmog set is made of, as rows a list can be drawn from.
 *
 * The grid can only count a set's appearances, because that is all `TransmogSetItem` holds.
 * Following one of them to an actual item takes three more of the game's tables, which the
 * backend walks on demand. Everything decidable from what it answers with is decided here;
 * the card that opens on it is in `transmogView.tsx`, and where a row can be worn is
 * `outfit.ts`.
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
import { classLabel } from "./transmog";
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
  "Head",
  "Shoulder",
  "Shirt",
  "Chest",
  "Waist",
  "Legs",
  "Feet",
  "Wrist",
  "Hands",
  "Back",
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
 * Which hand holds this, or nothing where the game names none — which is not the same
 * question as whether it is a weapon.
 *
 * The hand comes out of the same table as the name and is the backend's `worn::held_in` read
 * from the other end: it puts a one-hander on the right hand's attachment, an off-hand on the
 * left's and a shield on the forearm's. Where the game says nothing there is nowhere to put
 * the model at all.
 *
 * The hand is also the *place*, which is what a wardrobe needs and one set did not: a
 * one-hander and a two-hander are the same hand and cannot both be held, and a shield and an
 * off-hand are the other one. See `outfit.ts`, which keys the two hands by this.
 */
export function heldIn(displayType: number, inventoryType: number): "right" | "left" | null {
  if (!WEAPONRY.has(displayType)) return null;
  return WORN_IN[inventoryType]?.hand ?? null;
}

/** Whether the character can be shown holding this. */
export function isHeld(displayType: number, inventoryType: number): boolean {
  return heldIn(displayType, inventoryType) !== null;
}

/** A class mask nobody is excluded by, which is what nearly every item in the game carries. */
export const ANY_CLASS = 0xffff;

/**
 * One of the items that gives an appearance, as the list under a row reads it.
 *
 * A source is an *item*, and the only reason it is worth drawing separately from the row above
 * it is that it can differ: who may wear it, what it takes to wear it, what the game writes it
 * in. Where several sources agree on all three the list is the same sentence written out
 * repeatedly, which is what [`varyingFacts`] is asked before any of it is drawn.
 */
export interface AppearanceSource {
  /** What the game calls it, or its id where the table holds no name. */
  label: string;
  itemId: number;
  /** Which row of `TransmogSetItem` reached it, which is what makes a source unique. */
  modifiedAppearanceId: number;
  /**
   * Where the game says this item is worn, which is per item rather than per appearance.
   *
   * It is here rather than only on the row because two items giving one look can disagree
   * about it — a weapon listed as a one-hander by one and a main-hand by another, or a real
   * item beside one whose `ItemSparse` row is encrypted and so reads zero. The row takes its
   * copy from the same source it takes its name from, so the slot it claims and the item it
   * is named after are always the same item.
   */
  inventoryType: number;
  allowableClass: number;
  requiredLevel: number;
  quality: number;
  /**
   * How many of the set's items this line stands for, which is one for nearly all of them.
   *
   * A set can hold two items a reader cannot tell apart — same name, same class, same level,
   * same quality, different ids — because the game sold the look twice and `ItemSparse` says
   * the same thing about both. 13.5% of the rows that several items reach hold such a pair,
   * and drawing them as two lines is the same sentence written twice. They are one line, and
   * this is what says the count above still adds up.
   */
  itemCount: number;
}

/**
 * One appearance as a row reads it, with everything the markup needs already decided.
 *
 * **A row is a look, not an item.** The game sells one look through as many items as it likes
 * — a raid set's helm exists at three difficulties, and two unrelated world drops wear the same
 * model — and `TransmogSetItem` names every one of them. Grouping them is what turns a set of
 * 126 rows into a set of 11, and the items are not lost by it: they are [`sources`], one click
 * further in.
 */
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
  /**
   * Every item of this set that gives the look, the one the row is named after included.
   *
   * Never empty: a row with one source is an appearance only one item reaches, which is a
   * little under half of them.
   */
  sources: AppearanceSource[];
  /**
   * True when a class-locked item and an unrestricted one both give this look.
   *
   * The single most useful thing this view can say, and the one that no amount of scrolling
   * makes visible on its own: it happens to 30.8% of the appearances in the game that more
   * than one item reaches, and it means a reader locked out by their class is not locked out
   * of the look.
   */
  liftsRestriction: boolean;
}

/**
 * The words a name is worth matching on, which is not all of them.
 *
 * "of", "the" and the possessive left behind by stripping punctuation match everything and so
 * distinguish nothing, and a set called "Regalia of Celestial Harmony" is looking for
 * "celestial" in the items under it.
 */
const NOISE = new Set(["of", "the", "a", "and", "for"]);

function distinctive(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/);
  return new Set(words.filter((word) => word.length > 1 && !NOISE.has(word)));
}

/**
 * Which of the items that give a look the row is named after.
 *
 * The items disagree about what to call themselves 92.6% of the time, so something has to
 * choose, and the rule is **the name closest to the set's own**. Measured over the 17,799
 * multi-item appearances of a shipping install against six alternatives — the first item, the
 * last, the commonest name, the dearest, the most restricted, the least — this is the one that
 * lands on a name sharing a word with the set 89.6% of the time; the next best manages 79.9%
 * and picking the commonest name manages 72.3%. On *Regalia of Celestial Harmony* it answers
 * "Headpiece of Celestial Harmony" where picking the commonest answers "Crown of Tragic
 * Truth", which is a world drop wearing a tier set's slot.
 *
 * Ties go to the lowest item id, which is the oldest — the piece the set was built around
 * rather than whatever was hung off it later.
 */
function named(sources: AppearanceSource[], setName: string): AppearanceSource {
  const wanted = distinctive(setName);
  let best = sources[0]!;
  let bestScore = -1;
  for (const source of sources) {
    const shared = [...distinctive(source.label)].filter((word) => wanted.has(word)).length;
    if (shared > bestScore || (shared === bestScore && source.itemId < best.itemId)) {
      best = source;
      bestScore = shared;
    }
  }
  return best;
}

/**
 * The sources of a row, in the order a reader wants them: usefulness, not item id.
 *
 * Unrestricted before class-locked, because the reader reading this list is asking whether
 * they can have the look at all. Then the cheapest way in, which is the lowest level it can be
 * worn at. The id breaks the last tie so the order never depends on how the backend sorted.
 */
function byUsefulness(left: AppearanceSource, right: AppearanceSource): number {
  const open = (source: AppearanceSource): number => (source.allowableClass === ANY_CLASS ? 0 : 1);
  return (
    open(left) - open(right) ||
    left.requiredLevel - right.requiredLevel ||
    left.itemId - right.itemId
  );
}

/**
 * Folds together the sources a reader could not tell apart, keeping the order they arrived in.
 *
 * Two items of one set can agree on their name, who may wear them, what they take and what
 * they are worth, and differ only in an id — the game sold one look twice and `ItemSparse`
 * says the same thing about both. That is 13.5% of the rows several items reach, and 7.6% of
 * every line such a row would draw. Drawing both is the same sentence twice.
 *
 * The line keeps the lowest item id, because that is the oldest and the one a link out is best
 * pointed at, and counts what it stands for so the number on the row above still adds up.
 */
function fold(sources: AppearanceSource[]): AppearanceSource[] {
  const folded: AppearanceSource[] = [];
  const seen = new Map<string, AppearanceSource>();
  for (const source of sources) {
    const key = [source.label, source.allowableClass, source.requiredLevel, source.quality].join(
      " ",
    );
    const already = seen.get(key);
    if (already) {
      already.itemCount += 1;
      // The id and the place come off the same item, here as everywhere else on this chain.
      // The key holds everything a line draws and `inventoryType` is not drawn, so two
      // fold-mates can disagree about it — a weapon one row calls a one-hander and another
      // calls a main hand — and taking the lower id without its own answer would give the
      // row one item's slot under another item's id.
      if (source.itemId < already.itemId) {
        already.itemId = source.itemId;
        already.inventoryType = source.inventoryType;
      }
      continue;
    }
    seen.set(key, source);
    folded.push(source);
  }
  return folded;
}

/**
 * How many of the set's items give this look, which is not how many lines it draws.
 *
 * The lines are what a reader can tell apart and this is what the game holds, and they differ
 * wherever a set sold one look twice under one name. The row says this number, because it is
 * the honest answer to "how many items is this", and the lines under it account for it.
 */
export function itemsBehind(row: AppearanceRow): number {
  return row.sources.reduce((total, source) => total + source.itemCount, 0);
}

/**
 * Which facts actually differ between a row's sources, so that only those get drawn.
 *
 * Half of all multi-item appearances differ by nothing but their names — 51.3% of them — and
 * drawing a class, a level and a quality against each of five identical items is five lines
 * saying nothing. This is what the view asks before it draws a column.
 */
export function varyingFacts(row: AppearanceRow): {
  allowableClass: boolean;
  requiredLevel: boolean;
  quality: boolean;
} {
  const many = (pick: (source: AppearanceSource) => number): boolean =>
    new Set(row.sources.map(pick)).size > 1;
  return {
    allowableClass: many((source) => source.allowableClass),
    requiredLevel: many((source) => source.requiredLevel),
    quality: many((source) => source.quality),
  };
}

/**
 * Who may wear an item, as a phrase.
 *
 * The mask an item carries and the mask a *set* carries are the same bits, so this is
 * [`classLabel`] with one translation in front of it: an item open to everybody is stored as a
 * signed 16-bit `-1` and arrives as `0xffff`, where a set open to everybody is stored as zero.
 * Past that the two want the same words — a mask picking out exactly the three cloth classes
 * reads better as "Cloth" than as a list of them, which is as true of a robe as of the set
 * the robe came out of.
 */
export function wearerLabel(allowableClass: number): string {
  return classLabel(allowableClass === ANY_CLASS ? 0 : allowableClass);
}

/** The colour the game writes an item's name in, as the game's own word for it. */
const QUALITIES = [
  "Poor",
  "Common",
  "Uncommon",
  "Rare",
  "Epic",
  "Legendary",
  "Artifact",
  "Heirloom",
] as const;

export function qualityLabel(quality: number): string {
  return QUALITIES[quality] ?? `Quality ${quality}`;
}

/**
 * The rows a payload draws as: one per appearance, in the order the backend sorted them by.
 *
 * The backend answers one row per row of `TransmogSetItem`, which is one per *item*, and this
 * is where that becomes one per *look*. The grouping key is `ItemAppearance.id` — the game's
 * own unit of collection, what the wardrobe records a player as owning — and it agrees with
 * grouping on the display itself on all but three of the 34,133 appearances a shipping install
 * holds, while being the thing a player already has a word for.
 *
 * Two rows resist grouping and both keep their place. An appearance the game **withholds** has
 * no id to group on, so each is its own row, because the set's count includes it and a list
 * shorter than the card promised reads as a bug. An item the game **names nothing** keeps its
 * id, for the same reason: a blank where a name should be reads as this app having lost it.
 *
 * The set's name is here because the rows are named out of it — see [`named`].
 */
export function appearanceRows(payload: TransmogSetItemsPayload, setName = ""): AppearanceRow[] {
  const rows: AppearanceRow[] = [];
  const byAppearance = new Map<number, AppearanceRow>();
  const seenSource = new Set<string>();

  for (const appearance of (payload.appearances || []) as TransmogAppearance[]) {
    const withheld = !appearance.itemId;
    const source: AppearanceSource = {
      label: appearance.name || `Item ${appearance.itemId}`,
      itemId: appearance.itemId,
      modifiedAppearanceId: appearance.modifiedAppearanceId,
      inventoryType: appearance.inventoryType,
      allowableClass: appearance.allowableClass,
      requiredLevel: appearance.requiredLevel,
      quality: appearance.quality,
      itemCount: 1,
    };

    // An appearance the game withholds says nothing to group on, and a set that names the
    // same item twice — which the game stores as one row copied — says it through the same
    // `ItemModifiedAppearance` both times and is one source, not two.
    const existing = withheld ? undefined : byAppearance.get(appearance.appearanceId);
    if (existing) {
      const key = `${appearance.appearanceId}:${appearance.modifiedAppearanceId}`;
      if (!seenSource.has(key)) {
        seenSource.add(key);
        existing.sources.push(source);
      }
      continue;
    }

    const row: AppearanceRow = {
      slot: withheld ? "Unknown slot" : slotName(appearance.displayType, appearance.inventoryType),
      label: withheld ? "The game keeps this appearance encrypted" : source.label,
      itemId: appearance.itemId,
      appearanceId: appearance.appearanceId,
      displayType: appearance.displayType,
      inventoryType: appearance.inventoryType,
      displayInfoId: appearance.displayInfoId,
      iconFileDataId: appearance.iconFileDataId,
      hasModel: appearance.hasModel,
      withheld,
      sources: [source],
      liftsRestriction: false,
    };
    rows.push(row);
    if (!withheld) {
      byAppearance.set(appearance.appearanceId, row);
      seenSource.add(`${appearance.appearanceId}:${appearance.modifiedAppearanceId}`);
    }
  }

  for (const row of rows) {
    row.sources = fold(row.sources.sort(byUsefulness));
    row.liftsRestriction =
      row.sources.some((one) => one.allowableClass === ANY_CLASS) &&
      row.sources.some((one) => one.allowableClass !== ANY_CLASS && one.allowableClass !== 0);
    if (!row.withheld) {
      // The name, the item behind it and the place it is worn all come off the same source.
      // The first two decide what the row says and where its link goes; the third decides
      // which slot it claims and which hand holds it, and a row that took it from a different
      // item than the one it is named after would be two items' answer written as one row.
      const chosen = named(row.sources, setName);
      row.label = chosen.label;
      row.itemId = chosen.itemId;
      row.inventoryType = chosen.inventoryType;
      row.slot = slotName(row.displayType, chosen.inventoryType);
    }
  }
  return rows;
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

/**
 * How the set's contents read as one line: how many looks, out of how many items.
 *
 * Both numbers, because they are both true and they disagree for 65% of the sets in the game.
 * The appearances are what the list below now holds and what a player means by the size of a
 * set; the items are what the card above it counted and what the game's own table holds. Where
 * they agree — which is the other 35% — only the one is worth saying.
 */
export function appearanceSummary(rows: AppearanceRow[], payload: TransmogSetItemsPayload): string {
  if (!rows.length) return "The game lists no appearances for this set.";
  const items = rows.reduce((total, row) => total + itemsBehind(row), 0);
  const from = items > rows.length ? ` from ${plural(items, "item")}` : "";
  const withheld =
    payload.withheldCount > 0 ? ` · ${payload.withheldCount} the game keeps encrypted` : "";
  return `${plural(rows.length, "appearance")}${from}${withheld}`;
}
