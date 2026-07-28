/**
 * Browsing the game by the kind of thing rather than by the set it came in.
 *
 * A set is somebody at Blizzard's idea of an outfit, and most of the looks in the game belong
 * to none — a world drop, a quest reward, the tabard of a faction nobody remembers. So the
 * transmog view has a second half: pick a kind of place, get every appearance the game holds
 * for it, and put them on the same character the sets are tried on. What that costs to read is
 * `wardrobe.rs`; this is what a *kind* is, what a filter leaves, and how much of it is drawn.
 *
 * **A kind is not a display type, and that is the whole reason this file exists.** The game
 * numbers the places an appearance can fill, and above the armour those numbers stop
 * dividing anything a player would divide: a dagger, a staff and a one-handed axe are display
 * type 11 alike, a bow and a wand are both 12, and a shield is filed as armour. What separates
 * them is the item's own subclass, which is why a kind is a display type *and* a class and
 * subclass, and why everything held in a hand is fetched in one go and sorted out here.
 *
 * The rows come out as the same [`AppearanceRow`] an opened set draws, so a look picked out of
 * this list goes on the character through exactly the code a look picked out of a set does —
 * see `outfit.ts`, which is indifferent to which half of the view a row came from.
 */

import { plural } from "./format";
import { ANY_CLASS, slotName } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type { WardrobeAppearance } from "./types";

/**
 * The display types everything held in a hand is filed under, asked for as one.
 *
 * Five of them, because the game splits weapons by nothing a reader recognises: 11 is every
 * sword, axe, mace, staff and dagger in the game, 12 the ranged ones, 13 the shields, 14 the
 * ammunition nobody holds and 15 the tomes and orbs. A reader asking for staves is asking
 * about one slice of 11, and a reader asking for shields about all of 13 — so the fetch is the
 * five together and the kinds below are what cut it up.
 */
export const HELD_IN_HAND = [11, 12, 13, 14, 15];

/** What the game files armour and weapons under, out of the twenty classes of thing it has. */
const ARMOUR_CLASS = 4;
const WEAPON_CLASS = 2;

/** One choice in the picker above the list: a place on the body, or a kind of thing held. */
export interface Kind {
  /** What the picker holds and what a fetched payload is remembered by. */
  key: string;
  label: string;
  /** The heading the choice sits under, which is also what makes the picker readable. */
  group: string;
  /** Which display types the backend is asked for. Several kinds can share one answer. */
  displayTypes: number[];
  /** What the answer is then narrowed to, where the display types hold more than this kind. */
  classId?: number;
  subclassId?: number;
}

/** The armour slots, in the order they are worn down the body. */
const ARMOUR: Array<[number, string]> = [
  [0, "Head"], [1, "Shoulder"], [9, "Back"], [2, "Shirt"], [3, "Chest"], [10, "Tabard"],
  [4, "Waist"], [5, "Legs"], [6, "Feet"], [7, "Wrist"], [8, "Hands"],
];

/**
 * The weapons, as `Item.SubclassID` numbers them.
 *
 * Read off a 12.0.5.67 install with `examples/dump_wardrobe`, which is what to run again
 * after a patch: every subclass listed here is one that install actually holds appearances
 * for, and the three the community's definitions name and it holds none of — the two exotic
 * slots and the spear — are left out rather than offered as empty choices. Fishing poles are
 * absent for the same reason: the game gives them no transmog appearance at all.
 */
const WEAPONS: Array<[number, string]> = [
  [0, "One-handed axe"], [1, "Two-handed axe"], [4, "One-handed mace"], [5, "Two-handed mace"],
  [7, "One-handed sword"], [8, "Two-handed sword"], [15, "Dagger"], [13, "Fist weapon"],
  [9, "Warglaive"], [10, "Staff"], [6, "Polearm"], [2, "Bow"], [3, "Gun"], [18, "Crossbow"],
  [19, "Wand"], [16, "Thrown"], [14, "Miscellaneous"],
];

/**
 * Every kind a reader can browse, in the order the picker offers them.
 *
 * The last group is the two the game calls armour and nobody thinks of as armour — a shield
 * and the tome, orb or lantern held in the other hand — and the catch-all under them. That
 * catch-all is not tidiness: an install holds a hundred-odd looks belonging to kinds no
 * player has a word for, profession tools among them, and without a choice that filters
 * nothing they would be in a payload the window fetched and could not show.
 */
export const KINDS: Kind[] = [
  ...ARMOUR.map(([displayType, label]): Kind => ({
    key: `armour-${displayType}`,
    label,
    group: "Worn on the body",
    displayTypes: [displayType],
  })),
  ...WEAPONS.map(([subclassId, label]): Kind => ({
    key: `weapon-${subclassId}`,
    label,
    group: "Held in a hand",
    displayTypes: HELD_IN_HAND,
    classId: WEAPON_CLASS,
    subclassId,
  })),
  {
    key: "shield",
    label: "Shield",
    group: "Held and not a weapon",
    displayTypes: HELD_IN_HAND,
    classId: ARMOUR_CLASS,
    subclassId: 6,
  },
  {
    key: "off-hand",
    label: "Held in off hand",
    group: "Held and not a weapon",
    displayTypes: HELD_IN_HAND,
    classId: ARMOUR_CLASS,
    subclassId: 0,
  },
  {
    key: "held",
    label: "Anything held",
    group: "Held and not a weapon",
    displayTypes: HELD_IN_HAND,
  },
];

/** The kind a key names, or the first one — which is what the view opens on. */
export function kindOf(key: string): Kind {
  return KINDS.find((kind) => kind.key === key) ?? KINDS[0]!;
}

/**
 * What a fetched answer is remembered by: the display types it covers, ascending.
 *
 * By the answer rather than by the kind, because seventeen kinds of weapon are one answer —
 * a reader going from staves to daggers is filtering what the window already holds, and
 * asking the game again for it would be a second of nothing.
 */
export function answerKey(kind: Kind): string {
  return [...kind.displayTypes].sort((left, right) => left - right).join(",");
}

/**
 * One look out of the wardrobe, as the same row an opened set draws.
 *
 * The single source is the item the backend named the look after, and it carries the count of
 * every item that gives the look — so `itemsBehind` answers what it answers for a set's row.
 * What is *not* here is the other items themselves: a set is a dozen looks and can afford to
 * name the eight items behind each, and a slot is five thousand and cannot.
 */
export function wardrobeRow(appearance: WardrobeAppearance): AppearanceRow {
  const label = appearance.name || `Item ${appearance.itemId}`;
  return {
    slot: slotName(appearance.displayType, appearance.inventoryType),
    label,
    itemId: appearance.itemId,
    appearanceId: appearance.appearanceId,
    displayType: appearance.displayType,
    inventoryType: appearance.inventoryType,
    displayInfoId: appearance.displayInfoId,
    iconFileDataId: appearance.iconFileDataId,
    hasModel: appearance.hasModel,
    // Nothing here is withheld: a look the install could say nothing whatever about never
    // reaches the window, having been counted and left behind by the backend.
    withheld: false,
    sources: [{
      label,
      itemId: appearance.itemId,
      // A wardrobe row is reached from the appearance rather than from one set's naming of
      // it, so there is no `ItemModifiedAppearance` in the story: the appearance is what
      // makes the row unique, and is what a list keys on.
      modifiedAppearanceId: appearance.appearanceId,
      inventoryType: appearance.inventoryType,
      allowableClass: appearance.allowableClass,
      requiredLevel: appearance.requiredLevel,
      quality: appearance.quality,
      itemCount: appearance.itemCount,
    }],
    liftsRestriction: appearance.liftsRestriction,
  };
}

/** Whether a look is one of the kind asked for, which is what the fetched answer holds more of. */
export function isKind(appearance: WardrobeAppearance, kind: Kind): boolean {
  if (!kind.displayTypes.includes(appearance.displayType)) return false;
  if (kind.classId !== undefined && appearance.classId !== kind.classId) return false;
  return kind.subclassId === undefined || appearance.subclassId === kind.subclassId;
}

/**
 * Everything a search matches a look against, as one lowercased string.
 *
 * The name first, because that is what a reader types. Then the two things the row itself
 * already shows them — where it goes and what colour the game writes it in — because a reader
 * looking at a list of everything held in a hand and wanting the daggers types "dagger", and
 * a search that only read names would send them back to the picker for it. The id is in
 * there because it is the one thing a reader has when the game withholds the name.
 */
function searchable(appearance: WardrobeAppearance): string {
  return [
    appearance.name,
    slotName(appearance.displayType, appearance.inventoryType),
    kindName(appearance),
    String(appearance.itemId),
  ].join(" ").toLowerCase();
}

/** What kind of thing a look is, as the picker would have called it, or nothing it knows. */
export function kindName(appearance: WardrobeAppearance): string {
  const kind = KINDS.find((one) => one.classId !== undefined && isKind(appearance, one));
  return kind?.label ?? "";
}

/**
 * The looks a filter leaves, in the order the backend sorted them — which is by name.
 *
 * The search is every word rather than the whole phrase, the way the set browser's is, so
 * "dagger storm" finds what neither word finds alone. The class filter reads the item's own
 * mask: an item nobody is locked out of survives every class, and so does one the game
 * withholds the mask of — a row whose facts this install cannot read is not evidence that a
 * class may not wear it.
 */
export function filterAppearances(
  appearances: WardrobeAppearance[],
  filters: { kind: Kind; search: string; klass: string },
): WardrobeAppearance[] {
  const words = filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const klass = filters.klass === "" ? null : Number(filters.klass);
  return appearances.filter((appearance) => {
    if (!isKind(appearance, filters.kind)) return false;
    if (klass !== null
      && appearance.allowableClass !== ANY_CLASS
      && appearance.allowableClass !== 0
      && (appearance.allowableClass & (1 << klass)) === 0) return false;
    if (!words.length) return true;
    const against = searchable(appearance);
    return words.every((word) => against.includes(word));
  });
}

/**
 * How many rows are drawn before a reader has to ask for more.
 *
 * A kind of place is a few thousand looks — 5,111 heads and 11,322 things held in a hand on a
 * shipping install — and every row is a button, an icon and three chips. Drawing them all
 * costs a second of stutter to show a reader forty screens they did not ask for, and the
 * search above is the actual way through a list this size.
 */
export const PAGE = 100;

/** How the list says what it is showing, and whether there is more of it behind the button. */
export function shownSummary(shown: number, total: number, withheld: number): string {
  const kept = withheld > 0
    ? ` · ${plural(withheld, "look")} the game keeps encrypted`
    : "";
  if (shown >= total) return `${plural(total, "appearance")}${kept}`;
  return `${shown} of ${plural(total, "appearance")}${kept}`;
}
