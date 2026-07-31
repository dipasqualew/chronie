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
import type {
  Alternate,
  Quality,
  SameLookReason,
  SetWearers,
  TransmogMark,
  TransmogSet,
} from "./types";

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

/**
 * Who can really wear a set, as a phrase — the three kinds of statement the mask above is not.
 *
 * [`classLabel`] reads `TransmogSet.ClassMask`, and that mask answers two different questions
 * with the same shape. This reads what the *items* behind the set allow, which the backend
 * works out of every item in the game that gives one of its looks — see `wearers.rs` — and it
 * comes out as one of three sentences:
 *
 * - **Anyone**, which is a set nothing about restricts: a rack of weapons, a tabard, a cloak.
 * - **Any plate wearer**, which is the interesting one. The class lock lifted — something in
 *   the game sells every one of the set's looks to everybody — and what is left is the armour,
 *   because the game will not transmogrify plate into cloth. 586 of the game's single-class
 *   sets land here, and a reader whose class was not on the card is being told they can have
 *   the clothes after all.
 * - **Paladin only**, which is the lock standing: nothing in the game gives one of these looks
 *   to anybody else. 2,019 sets, and the card is now saying so rather than saying "Paladin"
 *   in the same voice it says "Cloth".
 *
 * The masks it recognises are the game's own: a mask of exactly the three plate classes is
 * what a plate item leaves, which is why [`ARMOUR`] does for both. "Nobody" is not a hedge
 * either — two sets of a shipping install are internal bundles holding every class's tier at
 * once, and no class can wear the whole of one.
 */
export function whoWears(mask: number): string {
  if (mask === ALL_CLASSES) return "Anyone";
  const armour = ARMOUR.get(mask);
  if (armour) return `Any ${armour.toLowerCase()} wearer`;
  const names = classNames(mask);
  if (names.length === 0) return "Nobody";
  if (names.length <= 2) return `${names.join(" & ")} only`;
  return `${names.length} classes only`;
}

/**
 * How much of a set anybody can have, as the words `open:` narrows the grid by.
 *
 * [`whoWears`] is a verdict on a whole body's worth of clothes, so it says the same thing about a
 * set seven of whose eight slots some world drop sells to everybody and a set nothing of which
 * does. The counts behind it say which — see `wearers.rs` — and this is the vocabulary a reader
 * asks them in:
 *
 * - **`open:all`** — every slot has a way in. `open:all class:paladin` is the whole of "tier
 *   looks I can put on anything that wears plate", which was one question and no way to ask it.
 * - **`open:most`** — three quarters of them or more, `all` included: a set with one obstacle in
 *   eight is a set worth chasing, and a reader looking for those does not want to have to
 *   remember to ask twice.
 * - **`open:some`** — at least one, which is the band between the two and would otherwise be
 *   unreachable.
 * - **`open:none`** — nothing. The genuinely class-locked, which is 47% of the game's
 *   single-class sets.
 *
 * A set whose slots this install can read nothing of carries no `open:` facet at all, and so
 * answers none of these — the same silence the chip on its card falls back from. "Nothing is
 * known" is not "nothing is open", and `open:none` claiming it would be this app reporting its
 * own blindness as a wall.
 */
export function opennessWords(about: SetWearers): string[] {
  const slots = about.openSlots + about.blockedSlots.length;
  if (!slots) return [];
  if (!about.openSlots) return ["none"];
  const words = about.blockedSlots.length ? [] : ["all"];
  if (about.openSlots / slots >= MOSTLY) words.push("most");
  words.push("some");
  return words;
}

/** Where "most of it" starts, which is the three quarters the issue that asked for it named. */
const MOSTLY = 0.75;

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
  /**
   * And what the items say about one, where the backend has answered — see `wearers.rs`.
   *
   * The whole row rather than the mask, because it carries two different answers a filter
   * wants: who can wear the set, and how much of it anybody can — see [`whoWears`] and
   * [`opennessWords`].
   */
  wearers: (setId: number) => SetWearers | undefined;
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
      // Who the items say, which is the chip the card actually draws once the backend has
      // answered: a reader looking at "Any plate wearer" types "plate", and a Warrior looking
      // for what a Warrior can wear types their class and means this rather than the mask.
      ...wearerWords(one, said),
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
      ...classFacets(one, said),
      // And how much of it anybody can have, which is the one thing about a set neither the
      // game's mask nor the chip drawn from it can be asked — see [`opennessWords`].
      ...openWords(one, said).map((word) => ({ key: "open", value: word })),
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
 * Who a set is for, in the words the card itself prints.
 *
 * **The items where they have been read, and the game's own mask until then** — see `wearers.rs`,
 * and the chip in `transmogView.tsx` that makes exactly this choice. The two disagree about a
 * fifth of the game's single-class sets, and in both directions: a Paladin set whose every look
 * something else sells to everybody is a set a Warrior can wear, and a set filed under the
 * leather mask whose sandals are the Druid's own is not a set any Rogue can. Saying both would
 * answer for a class the card has already told the reader is shut out.
 */
function wearerWords(one: Named, said: Said): string[] {
  const about = said.wearers(one.id);
  if (about === undefined) return [classLabel(one.classMask), ...classNames(one.classMask)];
  return [whoWears(about.classMask), ...classNames(about.classMask)];
}

/**
 * And the same, as the facets `class:` reads — which is the whole of what the dropdown was.
 *
 * The one thing a term has to say that the printed words do not: **a mask of nothing is the game
 * writing "anybody"**, and `classNames` reads no class at all out of it. A tabard or a weapon
 * rack answering `class:mage` with silence would hide from a reader narrowing to their own class
 * exactly the sets that were never keeping them out. Only where the items have said nothing,
 * because a mask the backend worked out is a count of real items and zero there means what it
 * says — the two internal bundles of a shipping install that hold every class's tier at once and
 * that no class can wear the whole of.
 *
 * They stay out of [`searchable`], where a bare word is matched against everything a set says: a
 * reader typing "mage" wants Mage sets, not every tabard in the game.
 */
function classFacets(one: Named, said: Said): Facet[] {
  const words = wearerWords(one, said);
  const anybody = said.wearers(one.id) === undefined && one.classMask === 0 ? CLASSES : [];
  return [...words, ...anybody].map((value) => ({ key: "class", value }));
}

/** And how much of it they can have, in the words the box asks for that — [`opennessWords`]. */
function openWords(one: Named, said: Said): string[] {
  const about = said.wearers(one.id);
  return about === undefined ? [] : opennessWords(about);
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
 * **The box is the whole of it.** There were two dropdowns over the grid as well, an expansion
 * and a class, and both asked something [`facetsOf`] already answers under a name — so the same
 * question had two controls, one of which a reader had to notice and the other of which every
 * chip on every card already writes. `expansion:cataclysm class:priest` is what the pair of them
 * came to, and it is one thing to read, one thing to clear, and a thing that can be asked twice.
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
    /** What the reader has said about these sets, and what they have narrowed it to. Absent
     * where no mark is in play, which is what every caller that predates them passes. */
    marks?: { filter: MarkFilter; of: (setId: number) => TransmogMark | undefined };
    /** What the committed store measured a whole set to be — see `qualities.ts`. Absent where
     * the file has not arrived, which is what the first draw of the view passes. */
    qualities?: (setId: number) => Quality | undefined;
    /** What the items behind a set say — who can wear it, and how much of it anybody can, see
     * [`whoWears`] and [`opennessWords`]. Absent for a set the install can describe no item of,
     * and for every set until that read lands. */
    wearers?: (setId: number) => SetWearers | undefined;
  },
): Family[] {
  const query = parseQuery(filters.search);
  const asked = asksAnything(query);
  const marks = filters.marks;
  const said: Said = {
    mark: (setId) => marks?.of(setId),
    quality: (setId) => filters.qualities?.(setId),
    wearers: (setId) => filters.wearers?.(setId),
  };
  return families.filter((family) => {
    if (marks && !family.members.some((one) => survivesMarks(marks.of(one.id), marks.filter))) {
      return false;
    }
    if (!asked) return true;
    if (query.terms.length && !matchesTerms(query.terms, facetsOf(family, said))) return false;
    return matchesWords(query.words, searchable(family, said));
  });
}

/**
 * Groups families under the collection of the card each draws, keeping the backend's order.
 *
 * A set the tables file under no collection falls back to [`whenItArrived`] rather than to one
 * "Ungrouped" heading over a third of the grid — see there for why that heading was not a
 * section anybody could read.
 *
 * The buckets are keyed by where the heading came from and not by the heading itself, so a
 * collection the game happens to have named after an expansion cannot swallow the sets that
 * landed under that expansion for want of a collection of their own.
 */
export function groupFamilies(families: Family[]): Array<{ group: string; families: Family[] }> {
  const groups: Array<{ group: string; families: Family[] }> = [];
  const byKey = new Map<string, Family[]>();
  for (const family of families) {
    const named = family.shown.group !== "";
    const name = named ? family.shown.group : whenItArrived(family.shown);
    const key = `${named ? "collection" : "when"}:${name}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
      groups.push({ group: name, families: bucket });
    }
    bucket.push(family);
  }
  return groups;
}

/**
 * The heading a set out of no collection is gathered under: when the game let anybody have it.
 *
 * `TransmogSetGroup` names 2,993 of a 12.x install's sets and says nothing about the other
 * **1,482**, and a third of the grid under a single "Ungrouped" is a pile rather than a section.
 * Folding by parent barely touches it either — those 1,482 sets are 1,476 families — because
 * what is unnamed is mostly one-offs rather than the variant chains a raid tier makes.
 *
 * They are also not spread evenly: 566 of them are Dragonflight's, 382 Shadowlands', 243 Battle
 * for Azeroth's. So the fallback is the expansion **and the patch**, both of which the game
 * states about every set it has. The expansion alone would leave the largest pile very nearly
 * whole; a patch is what a content release actually was, and it is the granularity at which
 * these one-offs arrived — a holiday's worth of costumes, a season's worth of rewards.
 *
 * Neither half is invented. A build too old to know an expansion's name still gets a heading,
 * [`expansionName`] saying which number it was, and a set whose patch the tables leave at zero
 * gets the expansion on its own rather than a heading with a hole in it.
 */
function whenItArrived(set: TransmogSet): string {
  const expansion = expansionName(set.expansionId);
  const patch = patchName(set.patchIntroduced);
  return patch ? `${expansion} · Patch ${patch}` : expansion;
}
