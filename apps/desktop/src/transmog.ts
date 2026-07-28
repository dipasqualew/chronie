/**
 * The transmog sets the installed game knows about, as names, groups and filters.
 *
 * This is the one view that reads the game's own files rather than the addon's history, so it
 * shows what exists rather than what a character has collected. The backend hands over a flat
 * list; everything here is how it gets grouped, filtered and named. The drawing over it is
 * `transmogView.tsx`, and what a reader puts on out of one is `outfit.ts`.
 */

import { markFacets, markWords, survivesMarks } from "./marks";
import type { MarkFilter } from "./marks";
import { qualityFacets, qualityWords } from "./qualities";
import { asksAnything, matchesTerms, matchesWords, parseQuery } from "./terms";
import type { Facet } from "./terms";
import type { Alternate, Quality, SameLookReason, TransmogMark, TransmogSet } from "./types";

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
function searchable(
  set: TransmogSet, mark: TransmogMark | undefined, quality: Quality | undefined,
): string {
  const game = [set, ...(set.alternates ?? [])].flatMap((one) => [
    one.name,
    one.group,
    classLabel(one.classMask),
    ...classNames(one.classMask),
    expansionName(one.expansionId),
    patchName(one.patchIntroduced),
    String(one.id),
  ]).join(" ").toLowerCase();
  // And whatever the reader themselves filed it under, so "horde" or "wishlist" finds the sets
  // they said it about without their having to go near the picker beside the box. And what the
  // artwork was measured to be, which the wardrobe beside this has always searched and this had
  // no way to: the card draws the same chip, so "brown" is a word a reader can see here too.
  return `${game} ${markWords(mark)} ${qualityWords(quality)}`;
}

/**
 * And everything a set says under a name, which is what a `key:value` term reads — `terms.ts`.
 *
 * The whole cluster again, for the reason every filter here reads it: a set standing in for two
 * others is standing in for their classes and their expansions, and `class:mage` that missed the
 * folded-away Mage version would hide the look from exactly the reader asking for it.
 *
 * `collection` rather than `group`, because "Tideglass Wardrobe" is what the heading over the card
 * says and a reader types the word they are looking at. Facets with nothing in them are dropped —
 * a set out of no collection answers `collection:` with nothing rather than with itself.
 */
function facetsOf(
  set: TransmogSet, mark: TransmogMark | undefined, quality: Quality | undefined,
): Facet[] {
  const game = [set, ...(set.alternates ?? [])].flatMap((one): Facet[] => [
    { key: "name", value: one.name },
    { key: "collection", value: one.group },
    { key: "class", value: classLabel(one.classMask) },
    ...classNames(one.classMask).map((name) => ({ key: "class", value: name })),
    { key: "expansion", value: expansionName(one.expansionId) },
    { key: "patch", value: patchName(one.patchIntroduced) },
  ]);
  return [...game, ...markFacets(mark), ...qualityFacets(quality)]
    .filter((facet) => facet.value !== "");
}

/**
 * What a folded set brings with it, which the card it folded into has to answer for.
 *
 * A set shown in place of two others is standing in for their names, their classes and their
 * expansions as well as its own, and a filter that only read its own would hide the look from
 * exactly the reader looking for it — someone typing "Warmongering", or narrowing to the class
 * whose version of the armour got folded away. So every filter reads the whole cluster.
 */
function everyClass(set: TransmogSet): number[] {
  return [set.classMask, ...(set.alternates ?? []).map((one) => one.classMask)];
}

function everyExpansion(set: TransmogSet): number[] {
  return [set.expansionId, ...(set.alternates ?? []).map((one) => one.expansionId)];
}

/** How a card says why the set it stands in for is a separate set. */
const REASONS: Record<SameLookReason, string> = {
  faction: "the other faction's",
  class: "another class's",
  reissue: "released again as",
};

/**
 * One line naming a set folded into this one, and what makes it its own set.
 *
 * The qualifier is **only what differs from the card it is written under**. A faction pair is
 * the same armour for the same classes out of the same patch, so "the other faction's Deepglass
 * Hide · Leather" spends its last two words repeating the chip directly above it; a class
 * variant genuinely is another class, and a reissue genuinely is another expansion or patch.
 * Naming the first difference there is one keeps every line worth reading.
 */
export function alternateLabel(alternate: Alternate, shown: TransmogSet): string {
  // The labels rather than the masks, because the label is what would be printed and the game
  // writes "anyone" two ways — a mask of zero and every bit at once. Those are the same
  // audience, and a line saying "Any class" under a card already saying it is a wasted line.
  const wearers = classLabel(alternate.classMask);
  const qualifier = wearers !== classLabel(shown.classMask)
    ? wearers
    : alternate.expansionId !== shown.expansionId
      ? expansionName(alternate.expansionId)
      : patchName(alternate.patchIntroduced) !== patchName(shown.patchIntroduced)
        ? `Patch ${patchName(alternate.patchIntroduced)}`
        : "";
  return `${REASONS[alternate.reason]} ${alternate.name}${qualifier ? ` · ${qualifier}` : ""}`;
}

/**
 * The sets a filter leaves, in the order the backend already sorted them.
 *
 * The search is every word rather than the whole phrase, so "plate cata" finds what neither
 * word finds on its own — which is how a reader narrows a wardrobe of several thousand sets
 * without learning what order the metadata happens to be written in.
 *
 * **A set that is another set's clothes never reaches the grid.** 436 of the game's sets hold
 * exactly the appearances another one holds, and showing all of them is showing the same
 * wardrobe up to six times over. The one shown says who else wears it, and every filter here
 * reads the whole cluster — so folding a set away never makes it unfindable.
 *
 * The marks are the exception to that last rule, and have to be: a folded set never reaches
 * the grid, so nobody can ever star one, so a star can only ever be against the set shown.
 * Reading the cluster there would be reading rows that cannot exist.
 */
export function filterSets(
  sets: TransmogSet[],
  filters: {
    search: string;
    expansion: string;
    klass: string;
    /** What the reader has said about these sets, and what they have narrowed it to. Absent
     * where no mark is in play, which is what every caller that predates them passes. */
    marks?: { filter: MarkFilter; of: (setId: number) => TransmogMark | undefined };
    /** What the committed store measured a whole set to be — see `qualities.ts`. Absent where
     * the file has not arrived, which is what the first draw of the view passes. */
    qualities?: (setId: number) => Quality | undefined;
  },
): TransmogSet[] {
  const query = parseQuery(filters.search);
  const asked = asksAnything(query);
  const expansion = filters.expansion === "" ? null : Number(filters.expansion);
  const klass = filters.klass === "" ? null : Number(filters.klass);
  return sets.filter((set) => {
    if (set.sameLookAs) return false;
    if (expansion !== null && !everyExpansion(set).includes(expansion)) return false;
    // A set with no class of its own is for everyone, so it survives a class filter.
    const wearers = everyClass(set);
    if (klass !== null
      && !wearers.some((mask) => mask === 0 || (mask & (1 << klass)) !== 0)) return false;
    const mark = filters.marks?.of(set.id);
    if (filters.marks && !survivesMarks(mark, filters.marks.filter)) return false;
    if (!asked) return true;
    const quality = filters.qualities?.(set.id);
    if (query.terms.length && !matchesTerms(query.terms, facetsOf(set, mark, quality))) {
      return false;
    }
    return matchesWords(query.words, searchable(set, mark, quality));
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
