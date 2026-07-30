/**
 * The transmog sets the installed game knows about, as names, groups and filters.
 *
 * This is the one view that reads the game's own files rather than the addon's history, so it
 * shows what exists rather than what a character has collected. The backend hands over a flat
 * list; everything here is how it gets folded, grouped, filtered and named. The drawing over it
 * is `transmogView.tsx`, and what a reader puts on out of one is `outfit.ts`.
 *
 * **A card is a family rather than a set** — see [`foldFamilies`]. A shipping install's 4,911
 * rows are 2,766 things anybody would call a set of clothes, and the difference is the game
 * saying so itself: the difficulties of a raid tier and the colours of a recolour are rows with
 * a `ParentTransmogSetID` pointing at the one they are a variant of.
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
  "Warrior",
  "Paladin",
  "Hunter",
  "Rogue",
  "Priest",
  "Death Knight",
  "Shaman",
  "Mage",
  "Warlock",
  "Monk",
  "Druid",
  "Demon Hunter",
  "Evoker",
] as const;

/** Every class at once, which the game writes as a full mask rather than as zero. */
const ALL_CLASSES = (1 << CLASSES.length) - 1;

/** The expansions, indexed by the id the game files use. */
const EXPANSIONS = [
  "Classic",
  "The Burning Crusade",
  "Wrath of the Lich King",
  "Cataclysm",
  "Mists of Pandaria",
  "Warlords of Draenor",
  "Legion",
  "Battle for Azeroth",
  "Shadowlands",
  "Dragonflight",
  "The War Within",
  "Midnight",
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
 * A set and the variants the game itself files under it — see [`foldFamilies`].
 *
 * One card of the grid. `members` holds at least the set shown, and holds it in the order the
 * grid would have drawn the members in had they each had a card of their own.
 */
export interface Family {
  /** The member the card is drawn as until a reader picks another off the rail. */
  shown: TransmogSet;
  members: TransmogSet[];
}

/**
 * How far a walk up the parents will go before deciding it is going in a circle.
 *
 * A shipping install is two deep and no more — 1,956 of the 1,960 children are one — so this is
 * not a depth limit anybody has to defend. It is the guard against a table that says a set is
 * its own ancestor, which is a thing no reader should meet as a hung window.
 */
const HOPS = 8;

/**
 * Folds the game's sets into the families it already says they are.
 *
 * `TransmogSet` carries a `ParentTransmogSetID`, and it is the game's own statement that two
 * rows are one set at another difficulty or in another colour. Read off a 12.x install: 4,475
 * sets reach the grid after the `sameLookAs` fold and fall into **2,751 families** between them.
 * Icecrown Citadel is 30 sets and 10 families, one per class, each a chain of
 * `base → Sanctified (25) → Sanctified (heroic)`; every modern raid tier is 52 sets and 13
 * families. It catches pure recolours as well as difficulties — `Stormrider's Attire` is eight
 * colours under one root and `Earthen Copper Regalia` eighteen.
 *
 * **A family is split where its members are not for the same classes.** Fifteen roots of the
 * whole table gather sets with differing class masks — a plate set whose root also parents the
 * mail version — and a card that stood for both would answer `class:warrior` with a body no
 * Warrior can wear. Splitting them is fifteen extra cards; modelling the exception is a rule
 * every filter here would have to carry.
 *
 * The card is drawn as the root, which is the set the game itself calls the base of the family.
 * Where the root is not among the members — one family of a shipping install, its root folded
 * away by [`filterFamilies`]'s other fold — the first member in the grid's own order stands in.
 *
 * Sets that are another set's clothes never reach a family at all: they are already spoken for
 * by the card carrying them as an alternate, and the fold below would show them twice.
 */
export function foldFamilies(sets: TransmogSet[]): Family[] {
  const byId = new Map(sets.map((set) => [set.id, set]));
  const rootOf = (set: TransmogSet): TransmogSet => {
    let at = set;
    for (let hop = 0; hop < HOPS; hop += 1) {
      const parent = at.parentId ? byId.get(at.parentId) : undefined;
      // A parent the table names and this install cannot read is no parent: the set is its own
      // root rather than the head of a family nobody can see.
      if (!parent || parent.id === at.id) break;
      at = parent;
    }
    return at;
  };
  const drawn = new Map<number, number>();
  const gathered = new Map<string, { root: number; members: TransmogSet[] }>();
  for (const [at, set] of sets.entries()) {
    drawn.set(set.id, at);
    if (set.sameLookAs) continue;
    const root = rootOf(set).id;
    const key = `${root}:${set.classMask}`;
    const family = gathered.get(key);
    if (family) family.members.push(set);
    else gathered.set(key, { root, members: [set] });
  }
  const families = [...gathered.values()].map(({ root, members }) => ({
    shown: members.find((one) => one.id === root) ?? members[0]!,
    members,
  }));
  // Back into the order the backend sorted the sets into, read off the card each family draws —
  // so a grid of families is the grid of sets with the variants taken out of it.
  return families.sort((left, right) => drawn.get(left.shown.id)! - drawn.get(right.shown.id)!);
}

/**
 * How the rail names one member of a family.
 *
 * The set's own name, which is what a reader is looking at everywhere else on the card — and 698
 * of the 1,724 variants a shipping install holds differ by it. The other thousand do not: a raid
 * tier's four difficulties are one name four times, and eighteen `Earthen Copper Regalia` are one
 * name eighteen times. The id is what separates those, being the one thing about a set that is
 * never shared, and it is already what the card's own foot falls back to.
 */
export function variantLabel(member: TransmogSet, family: Family): string {
  const name = member.name || "Unnamed set";
  const shared = family.members.filter((one) => (one.name || "Unnamed set") === name).length > 1;
  return shared ? `${name} · #${member.id}` : name;
}

/** Everything a family answers for by name: every member, and every set folded into one. */
type Named = Pick<
  TransmogSet,
  "id" | "name" | "group" | "classMask" | "expansionId" | "patchIntroduced"
>;

function everyNamed(family: Family): Named[] {
  return family.members.flatMap((member) => [member, ...(member.alternates ?? [])]);
}

/** What the reader themselves said about the members, which only a member can carry. */
interface Said {
  mark: (setId: number) => TransmogMark | undefined;
  quality: (setId: number) => Quality | undefined;
}

/**
 * Everything about a family a search matches against, as one lowercased string.
 *
 * The name and the collection are what a reader types first, and then everything the card
 * itself already shows them: who it is for, where it came from, and which patch — because a
 * reader looking at "Plate · Cataclysm · Patch 4.0.1" and wanting more like it types one of
 * those words, and a search that only reads names sends them hunting for the dropdown that
 * holds it instead. The id is in there too, which is the one thing a reader has when the game
 * withholds the name.
 */
function searchable(family: Family, said: Said): string {
  const game = everyNamed(family)
    .flatMap((one) => [
      one.name,
      one.group,
      classLabel(one.classMask),
      ...classNames(one.classMask),
      expansionName(one.expansionId),
      patchName(one.patchIntroduced),
      String(one.id),
    ])
    .join(" ")
    .toLowerCase();
  // And whatever the reader themselves filed it under, so "horde" or "wishlist" finds the sets
  // they said it about without their having to go near the picker beside the box. And what the
  // artwork was measured to be, which the wardrobe beside this has always searched and this had
  // no way to: the card draws the same chip, so "brown" is a word a reader can see here too.
  const mine = family.members
    .map((member) => `${markWords(said.mark(member.id))} ${qualityWords(said.quality(member.id))}`)
    .join(" ");
  return `${game} ${mine}`;
}

/**
 * And everything a family says under a name, which is what a `key:value` term reads — `terms.ts`.
 *
 * The whole cluster again, for the reason every filter here reads it: a set standing in for two
 * others is standing in for their classes and their expansions, and `class:mage` that missed the
 * folded-away Mage version would hide the look from exactly the reader asking for it.
 *
 * `collection` rather than `group`, because "Tideglass Wardrobe" is what the heading over the card
 * says and a reader types the word they are looking at. The game's facets with nothing in them
 * are dropped — a set out of no collection answers `collection:` with nothing rather than with
 * itself — and the reader's are not, an empty value being what a label is rather than a gap in
 * one. See the same paragraph in `wardrobe.ts`.
 */
function facetsOf(family: Family, said: Said): Facet[] {
  const game = everyNamed(family)
    .flatMap((one): Facet[] => [
      { key: "name", value: one.name },
      { key: "collection", value: one.group },
      { key: "class", value: classLabel(one.classMask) },
      ...classNames(one.classMask).map((name) => ({ key: "class", value: name })),
      { key: "expansion", value: expansionName(one.expansionId) },
      { key: "patch", value: patchName(one.patchIntroduced) },
    ])
    .filter((facet) => facet.value !== "");
  const mine = family.members.flatMap((member) => [
    ...markFacets(said.mark(member.id)),
    ...qualityFacets(said.quality(member.id)),
  ]);
  return [...game, ...mine];
}

/**
 * What a folded set brings with it, which the card it folded into has to answer for.
 *
 * A set shown in place of two others is standing in for their names, their classes and their
 * expansions as well as its own, and a filter that only read its own would hide the look from
 * exactly the reader looking for it — someone typing "Warmongering", or narrowing to the class
 * whose version of the armour got folded away. So every filter reads the whole cluster.
 */
function everyClass(family: Family): number[] {
  return everyNamed(family).map((one) => one.classMask);
}

function everyExpansion(family: Family): number[] {
  return everyNamed(family).map((one) => one.expansionId);
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
  const qualifier =
    wearers !== classLabel(shown.classMask)
      ? wearers
      : alternate.expansionId !== shown.expansionId
        ? expansionName(alternate.expansionId)
        : patchName(alternate.patchIntroduced) !== patchName(shown.patchIntroduced)
          ? `Patch ${patchName(alternate.patchIntroduced)}`
          : "";
  return `${REASONS[alternate.reason]} ${alternate.name}${qualifier ? ` · ${qualifier}` : ""}`;
}

/**
 * The families a filter leaves, in the order the backend already sorted their cards into.
 *
 * The search is every word rather than the whole phrase, so "plate cata" finds what neither
 * word finds on its own — which is how a reader narrows a wardrobe of several thousand sets
 * without learning what order the metadata happens to be written in.
 *
 * **Two folds stand between the game's sets and the cards.** 436 of the game's sets hold exactly
 * the appearances another one holds, and the backend marks those; 1,724 more are a difficulty or
 * a colour of a set the game itself names as their parent, and [`foldFamilies`] gathers those.
 * Between them a shipping install's 4,911 sets are 2,766 cards. Every filter here reads the
 * whole family and every set folded into any of its members — so folding a set away never makes
 * it unfindable, whichever of the two folds took it.
 *
 * The marks are read across the members and not across the alternates, and the difference is
 * real rather than an oversight: a member can be picked off the card's own rail and starred
 * there, and a set that is another set's clothes never reaches the grid at all, so a star
 * against one would be a row that cannot exist.
 */
export function filterFamilies(
  families: Family[],
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
): Family[] {
  const query = parseQuery(filters.search);
  const asked = asksAnything(query);
  const expansion = filters.expansion === "" ? null : Number(filters.expansion);
  const klass = filters.klass === "" ? null : Number(filters.klass);
  const marks = filters.marks;
  const said: Said = {
    mark: (setId) => marks?.of(setId),
    quality: (setId) => filters.qualities?.(setId),
  };
  return families.filter((family) => {
    if (expansion !== null && !everyExpansion(family).includes(expansion)) return false;
    // A set with no class of its own is for everyone, so it survives a class filter.
    const wearers = everyClass(family);
    if (klass !== null && !wearers.some((mask) => mask === 0 || (mask & (1 << klass)) !== 0))
      return false;
    if (marks && !family.members.some((one) => survivesMarks(marks.of(one.id), marks.filter))) {
      return false;
    }
    if (!asked) return true;
    if (query.terms.length && !matchesTerms(query.terms, facetsOf(family, said))) return false;
    return matchesWords(query.words, searchable(family, said));
  });
}

/** Groups families under the collection of the card each draws, keeping the backend's order. */
export function groupFamilies(families: Family[]): Array<{ group: string; families: Family[] }> {
  const groups: Array<{ group: string; families: Family[] }> = [];
  const byName = new Map<string, Family[]>();
  for (const family of families) {
    const name = family.shown.group || "Ungrouped";
    let bucket = byName.get(name);
    if (!bucket) {
      bucket = [];
      byName.set(name, bucket);
      groups.push({ group: name, families: bucket });
    }
    bucket.push(family);
  }
  return groups;
}
