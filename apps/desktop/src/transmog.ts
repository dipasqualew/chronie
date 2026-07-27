/**
 * The transmog sets the installed game knows about, as names, groups and filters.
 *
 * This is the one view that reads the game's own files rather than the addon's history, so it
 * shows what exists rather than what a character has collected. The backend hands over a flat
 * list; everything here is how it gets grouped, filtered and named. The drawing over it is
 * `transmogView.tsx`, and what a reader puts on out of one is `outfit.ts`.
 */

import type { TransmogSet } from "./types";

/**
 * The classes, in the order the game's class mask numbers them.
 *
 * A set's mask is a bit per class from this list; a mask of zero belongs to no class in
 * particular, which is how the game marks the sets anyone can wear.
 */
export const CLASSES = [
  "Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Death Knight", "Shaman",
  "Mage", "Warlock", "Monk", "Druid", "Demon Hunter", "Evoker",
] as const;

/** Every class at once, which the game writes as a full mask rather than as zero. */
const ALL_CLASSES = (1 << CLASSES.length) - 1;

/** The expansions, indexed by the id the game files use. */
const EXPANSIONS = [
  "Classic", "The Burning Crusade", "Wrath of the Lich King", "Cataclysm",
  "Mists of Pandaria", "Warlords of Draenor", "Legion", "Battle for Azeroth",
  "Shadowlands", "Dragonflight", "The War Within", "Midnight",
] as const;

/**
 * The armour a class wears, used to label the masks that pick out exactly one kind. Those
 * four masks account for most of the sets in the game, and "Cloth" reads better than a list
 * of three class names.
 */
const ARMOUR = new Map<number, string>([
  [0x0190, "Cloth"],
  [0x0e08, "Leather"],
  [0x1044, "Mail"],
  [0x0023, "Plate"],
]);

export function expansionName(id: number): string {
  return EXPANSIONS[id] ?? `Expansion ${id}`;
}

/** The classes a mask picks out, as names. */
export function classNames(mask: number): string[] {
  return CLASSES.filter((_, index) => (mask & (1 << index)) !== 0);
}

/** A short label for who a set is for. */
export function classLabel(mask: number): string {
  if (mask === 0 || mask === ALL_CLASSES) return "Any class";
  const armour = ARMOUR.get(mask);
  if (armour) return armour;
  const names = classNames(mask);
  if (names.length === 0) return "Any class";
  if (names.length <= 2) return names.join(" & ");
  return `${names.length} classes`;
}

/** The patch a set arrived in, which the game stores as one packed number. */
export function patchName(packed: number): string {
  if (!packed) return "";
  const major = Math.floor(packed / 10000);
  const minor = Math.floor(packed / 100) % 100;
  const patch = packed % 100;
  return `${major}.${minor}.${patch}`;
}

/**
 * Everything about a set a search matches against, as one lowercased string.
 *
 * The name and the collection are what a reader types first, and then everything the card
 * itself already shows them: who it is for, where it came from, and which patch — because a
 * reader looking at "Plate · Cataclysm · Patch 4.0.1" and wanting more like it types one of
 * those words, and a search that only reads names sends them hunting for the dropdown that
 * holds it instead. The id is in there too, which is the one thing a reader has when the game
 * withholds the name.
 */
function searchable(set: TransmogSet): string {
  return [
    set.name,
    set.group,
    classLabel(set.classMask),
    ...classNames(set.classMask),
    expansionName(set.expansionId),
    patchName(set.patchIntroduced),
    String(set.id),
  ].join(" ").toLowerCase();
}

/**
 * The sets a filter leaves, in the order the backend already sorted them.
 *
 * The search is every word rather than the whole phrase, so "plate cata" finds what neither
 * word finds on its own — which is how a reader narrows a wardrobe of several thousand sets
 * without learning what order the metadata happens to be written in.
 */
export function filterSets(
  sets: TransmogSet[],
  filters: { search: string; expansion: string; klass: string },
): TransmogSet[] {
  const words = filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const expansion = filters.expansion === "" ? null : Number(filters.expansion);
  const klass = filters.klass === "" ? null : Number(filters.klass);
  return sets.filter((set) => {
    if (expansion !== null && set.expansionId !== expansion) return false;
    // A set with no class of its own is for everyone, so it survives a class filter.
    if (klass !== null && set.classMask !== 0 && (set.classMask & (1 << klass)) === 0) return false;
    if (!words.length) return true;
    const against = searchable(set);
    return words.every((word) => against.includes(word));
  });
}

/** Groups sets under their collection, keeping both orders the backend chose. */
export function groupSets(sets: TransmogSet[]): Array<{ group: string; sets: TransmogSet[] }> {
  const groups: Array<{ group: string; sets: TransmogSet[] }> = [];
  const byName = new Map<string, TransmogSet[]>();
  for (const set of sets) {
    const name = set.group || "Ungrouped";
    let bucket = byName.get(name);
    if (!bucket) {
      bucket = [];
      byName.set(name, bucket);
      groups.push({ group: name, sets: bucket });
    }
    bucket.push(set);
  }
  return groups;
}
