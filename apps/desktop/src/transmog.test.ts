import { describe, expect, it } from "vitest";
import { NO_MARK_FILTER, indexMarks, tokenOf } from "./marks";
import type { MarkFilter } from "./marks";
import { indexQualities } from "./qualities";
import {
  alternateLabel,
  classLabel,
  classNames,
  expansionName,
  filterFamilies,
  foldFamilies,
  groupFamilies,
  patchName,
  variantLabel,
} from "./transmog";
import type { Family } from "./transmog";
import type { Alternate, TransmogSet } from "./types";

/** A set with only the fields a test cares about spelled out. */
const set = (fields: Partial<TransmogSet> & Pick<TransmogSet, "id" | "name">): TransmogSet => ({
  group: "",
  groupId: 0,
  classMask: 0,
  expansionId: 0,
  parentId: 0,
  flags: 0,
  uiOrder: 0,
  patchIntroduced: 0,
  itemCount: 0,
  ...fields,
});

/** A set folded into another one, with only the fields a test cares about spelled out. */
const alternate = (fields: Partial<Alternate> & Pick<Alternate, "id" | "name">): Alternate => ({
  group: "",
  classMask: 0,
  expansionId: 0,
  patchIntroduced: 0,
  reason: "faction",
  ...fields,
});

/**
 * The grid, as the view builds it: the game's sets folded into families and then filtered.
 *
 * Both halves in one call because they are one answer — a filter reads the whole family, so a
 * test that filtered a list of sets would be testing a thing the window never does.
 */
const filtered = (sets: TransmogSet[], filters: Parameters<typeof filterFamilies>[1]): Family[] =>
  filterFamilies(foldFamilies(sets), filters);

/** The card each surviving family draws, which is what the grid shows. */
const ids = (families: Family[]): number[] => families.map((one) => one.shown.id);

// The four masks below are the game's own armour classes, and between them they cover most
// of the sets in it; the numbers are the ones the fixtures and the real tables both carry.
describe("classLabel", () => {
  it.each<[number, string]>([
    [0x0190, "Cloth"],
    [0x0e08, "Leather"],
    [0x1044, "Mail"],
    [0x0023, "Plate"],
  ])("reads mask %i as the armour it names", (mask, expected) => {
    expect(classLabel(mask)).toBe(expected);
  });

  // The game writes "anyone can wear this" two ways, and both have to read the same.
  it.each<[string, number]>([
    ["no class at all", 0],
    ["every class at once", 0x1fff],
  ])("calls a set for %s any class", (_what, mask) => {
    expect(classLabel(mask)).toBe("Any class");
  });

  it("names one or two classes outright and counts more", () => {
    expect(classLabel(1 << 0)).toBe("Warrior");
    expect(classLabel((1 << 0) | (1 << 12))).toBe("Warrior & Evoker");
    expect(classLabel((1 << 0) | (1 << 1) | (1 << 2))).toBe("3 classes");
  });

  // A bit past the last class is a class this build has never heard of, and a label of "" or
  // "NaN classes" would be worse than saying nothing useful.
  it("falls back to any class for a mask it cannot read", () => {
    expect(classLabel(1 << 20)).toBe("Any class");
  });
});

describe("classNames", () => {
  it("takes the classes out of a mask in the game's order", () => {
    expect(classNames(0x0190)).toEqual(["Priest", "Mage", "Warlock"]);
    expect(classNames(0)).toEqual([]);
  });
});

describe("expansionName", () => {
  it("names an expansion the build knows", () => {
    expect(expansionName(0)).toBe("Classic");
    expect(expansionName(10)).toBe("The War Within");
  });

  // A set from an expansion newer than this build of Chronie still has to render.
  it("says which expansion it was when it cannot name one", () => {
    expect(expansionName(99)).toBe("Expansion 99");
  });
});

describe("patchName", () => {
  it.each<[number, string]>([
    [100200, "10.2.0"],
    [100300, "10.3.0"],
    [110000, "11.0.0"],
    [110107, "11.1.7"],
  ])("unpacks %i as %s", (packed, expected) => {
    expect(patchName(packed)).toBe(expected);
  });

  // The table leaves it at zero for sets old enough to predate the column.
  it("says nothing when the table does not say", () => {
    expect(patchName(0)).toBe("");
  });
});

describe("filtering the grid", () => {
  const SETS = [
    set({ id: 205, name: "Duskwoven Shroud", group: "Duskwoven Attire", expansionId: 5 }),
    set({
      id: 203,
      name: "Emberforge Plate",
      group: "Emberforge Armory",
      classMask: 0x0023,
      expansionId: 4,
    }),
    set({
      id: 201,
      name: "Tideglass Regalia",
      group: "Tideglass Wardrobe",
      classMask: 0x0190,
      expansionId: 3,
    }),
    set({
      id: 202,
      name: "Tideglass Hide",
      group: "Tideglass Wardrobe",
      classMask: 0x0e08,
      expansionId: 3,
    }),
  ];
  /** The same sets with the metadata a search now reads filled in. */
  const WITH_METADATA = [
    set({ id: 205, name: "Duskwoven Shroud", group: "Duskwoven Attire", expansionId: 5 }),
    set({
      id: 203,
      name: "Emberforge Plate",
      group: "Emberforge Armory",
      classMask: 0x0023,
      expansionId: 3,
      patchIntroduced: 40001,
    }),
    set({
      id: 201,
      name: "Tideglass Regalia",
      group: "Tideglass Wardrobe",
      classMask: 0x0190,
      expansionId: 4,
    }),
  ];
  const none = { search: "", expansion: "", klass: "" };

  it("keeps every set when nothing is filled in", () => {
    expect(ids(filtered(SETS, none))).toEqual([205, 203, 201, 202]);
  });

  it("searches the collection as well as the set", () => {
    expect(ids(filtered(SETS, { ...none, search: "tideglass" }))).toEqual([201, 202]);
    expect(ids(filtered(SETS, { ...none, search: "shroud" }))).toEqual([205]);
    expect(ids(filtered(SETS, { ...none, search: "  EMBERFORGE  " }))).toEqual([203]);
    expect(filtered(SETS, { ...none, search: "nothing like it" })).toEqual([]);
  });

  it("narrows to one expansion", () => {
    expect(ids(filtered(SETS, { ...none, expansion: "3" }))).toEqual([201, 202]);
  });

  // Priest is a cloth class, and a set with no class of its own is for everyone — which is
  // the case a plain mask test gets wrong.
  it("keeps a class-agnostic set alongside the class asked for", () => {
    expect(ids(filtered(SETS, { ...none, klass: "4" }))).toEqual([205, 201]);
    expect(ids(filtered(SETS, { ...none, klass: "0" }))).toEqual([205, 203]);
  });

  it("applies search, expansion and class together", () => {
    expect(ids(filtered(SETS, { search: "tideglass", expansion: "3", klass: "9" }))).toEqual([202]);
    expect(filtered(SETS, { search: "tideglass", expansion: "4", klass: "" })).toEqual([]);
  });

  // Everything the card itself already shows is searchable, because a reader looking at
  // "Plate · Cataclysm · Patch 4.0.1" and wanting more like it types one of those words.
  it.each<[string, string, number[]]>([
    ["the armour a class mask names", "plate", [203]],
    ["a class inside a mask", "priest", [201]],
    ["the expansion", "cataclysm", [203]],
    ["the patch", "4.0.1", [203]],
    ["the set's own id", "205", [205]],
  ])("searches %s", (_what, search, expected) => {
    expect(ids(filtered(WITH_METADATA, { ...none, search }))).toEqual(expected);
  });

  // Word by word rather than as a phrase, so a reader can narrow by two facts at once without
  // learning what order the metadata happens to be written in.
  it("takes every word of a search, in any order", () => {
    expect(ids(filtered(WITH_METADATA, { ...none, search: "plate cataclysm" }))).toEqual([203]);
    expect(ids(filtered(WITH_METADATA, { ...none, search: "cataclysm plate" }))).toEqual([203]);
    expect(filtered(WITH_METADATA, { ...none, search: "plate pandaria" })).toEqual([]);
  });

  /**
   * Three clusters as a shipping install has them, and one set that is in none.
   *
   * Each cluster is both ends of the fold: the set shown, carrying the alternates, and the set
   * folded into it, carrying `sameLookAs` and still in the payload. Between them they hold the
   * three reasons the backend gives, and the folded set differs from the one shown by a
   * different thing each time — its name and collection, its class, its expansion — because
   * those are the three ways a reader could go looking for a look that got folded away.
   */
  const CLUSTERS: TransmogSet[] = [
    set({
      id: 301,
      name: "Wild Combatant's Plate Armor",
      group: "Wild Gladiator",
      classMask: 0x0023,
      expansionId: 5,
      patchIntroduced: 60200,
      alternates: [
        alternate({
          id: 302,
          name: "Warmongering Combatant's Plate Armor",
          group: "Warmongering Gladiator",
          classMask: 0x0023,
          expansionId: 5,
          patchIntroduced: 60200,
          reason: "faction",
        }),
      ],
    }),
    set({
      id: 302,
      name: "Warmongering Combatant's Plate Armor",
      group: "Warmongering Gladiator",
      classMask: 0x0023,
      expansionId: 5,
      patchIntroduced: 60200,
      sameLookAs: 301,
    }),
    set({
      id: 311,
      name: "Vestments of the Eternal",
      group: "Eternal Regalia",
      classMask: 0x0190,
      expansionId: 6,
      alternates: [
        alternate({
          id: 312,
          name: "Ebon Blade Battlegear",
          group: "Knightly Vanguard",
          classMask: 1 << 9,
          expansionId: 6,
          reason: "class",
        }),
      ],
    }),
    set({
      id: 312,
      name: "Ebon Blade Battlegear",
      group: "Knightly Vanguard",
      classMask: 1 << 9,
      expansionId: 6,
      sameLookAs: 311,
    }),
    set({
      id: 321,
      name: "Sunwarmed Finery",
      group: "Sunwarmed Attire",
      classMask: 0x0023,
      expansionId: 5,
      alternates: [
        alternate({
          id: 322,
          name: "Sunwarmed Finery",
          group: "Timerunning Wardrobe",
          classMask: 0,
          expansionId: 9,
          reason: "reissue",
        }),
      ],
    }),
    set({
      id: 322,
      name: "Sunwarmed Finery",
      group: "Timerunning Wardrobe",
      classMask: 0,
      expansionId: 9,
      sameLookAs: 321,
    }),
    set({
      id: 331,
      name: "Duskwoven Shroud",
      group: "Duskwoven Attire",
      classMask: 0x0190,
      expansionId: 3,
    }),
  ];

  it("leaves out every set that is another set's clothes", () => {
    expect(ids(filtered(CLUSTERS, none))).toEqual([301, 311, 321, 331]);
  });

  // A folded set matching a filter on its own account is the case worth pinning down: the grid
  // must answer with the card standing in for it, and never with two rows of the same clothes.
  it.each<[string, { search: string; expansion: string; klass: string }, number[]]>([
    ["by its name", { search: "warmongering", expansion: "", klass: "" }, [301]],
    ["by its expansion", { search: "", expansion: "5", klass: "" }, [301, 321]],
    ["by its class", { search: "", expansion: "", klass: "9" }, [311, 321]],
  ])("never shows a folded set even when it matches %s", (_what, filters, expected) => {
    expect(ids(filtered(CLUSTERS, filters))).toEqual(expected);
  });

  // The whole risk of folding sets away is a reader typing the name of one and getting nothing.
  // Whatever the game called the folded set — its name, its collection, or the id it falls back
  // to when the game withholds a name — has to reach the card shown in its place.
  it.each<[string, string, number[]]>([
    ["an alternate's name", "warmongering", [301]],
    ["an alternate's collection", "vanguard", [311]],
    ["an alternate's id", "322", [321]],
  ])("finds the set shown in place of one searched by %s", (_what, search, expected) => {
    expect(ids(filtered(CLUSTERS, { ...none, search }))).toEqual(expected);
  });

  // Every word has to be found somewhere in the cluster rather than all in one set of it, so a
  // reader who half-remembers both halves of a faction pair still lands on the card.
  it("ands the words of a search across the whole cluster", () => {
    expect(ids(filtered(CLUSTERS, { ...none, search: "wild warmongering" }))).toEqual([301]);
    expect(filtered(CLUSTERS, { ...none, search: "wild vanguard" })).toEqual([]);
  });

  /**
   * Monk is the case both halves of the class rule have to survive.
   *
   * 311 is a cloth set no Monk can wear and is kept only because the leather version folded
   * into it is a Monk's; 321 is plate and is kept because the set folded into it belongs to no
   * class at all, which the game means as everyone rather than as nobody.
   */
  it("keeps a cluster whose only wearer of the class asked for was folded away", () => {
    expect(ids(filtered(CLUSTERS, { ...none, klass: "9" }))).toEqual([311, 321]);
  });

  it.each<[string, string, number[]]>([
    ["Warrior", "0", [301, 321]],
    ["Priest", "4", [311, 321, 331]],
  ])("still reads the shown set's own classes when narrowed to %s", (_what, klass, expected) => {
    expect(ids(filtered(CLUSTERS, { ...none, klass }))).toEqual(expected);
  });

  // A set reissued a few expansions later is the same clothes from a different era, and the
  // reader narrowing to the later one is looking for exactly the card that swallowed it.
  it("keeps a cluster whose only set from an expansion was folded away", () => {
    expect(ids(filtered(CLUSTERS, { ...none, expansion: "9" }))).toEqual([321]);
  });

  // Four thousand of the game's sets are in no cluster at all, and the fields the backend
  // simply leaves off have to read as "no cluster" rather than as an empty one.
  it("filters a set with neither field exactly as it always did", () => {
    const plain = [
      set({
        id: 331,
        name: "Duskwoven Shroud",
        group: "Duskwoven Attire",
        classMask: 0x0190,
        expansionId: 3,
        alternates: undefined,
        sameLookAs: undefined,
      }),
    ];
    expect(ids(filtered(plain, none))).toEqual([331]);
    expect(ids(filtered(plain, { search: "duskwoven", expansion: "3", klass: "4" }))).toEqual([
      331,
    ]);
    expect(filtered(plain, { ...none, search: "warmongering" })).toEqual([]);
    expect(filtered(plain, { ...none, expansion: "9" })).toEqual([]);
    expect(filtered(plain, { ...none, klass: "9" })).toEqual([]);
  });
});

/**
 * A raid tier and a recolour, which between them are the whole of what the game's own
 * `ParentTransmogSetID` says.
 *
 * 401 is the shape every modern tier has: one base set with its two harder difficulties under
 * it, all three called the same thing, differing only in the order the game lists them and in
 * what the artwork was measured to be. 411 is the other shape: a colour of a set, named for its
 * colour, out of the same collection. 421 is in no family at all, which two thirds of the game's
 * sets are not.
 */
const FAMILIES: TransmogSet[] = [
  set({
    id: 401,
    name: "Scourgelord's Battlegear",
    group: "Icecrown Citadel",
    classMask: 0x0023,
    expansionId: 2,
    uiOrder: 2510,
  }),
  set({
    id: 402,
    name: "Scourgelord's Battlegear",
    group: "Icecrown Citadel",
    classMask: 0x0023,
    expansionId: 2,
    uiOrder: 2640,
    parentId: 401,
  }),
  set({
    id: 403,
    name: "Scourgelord's Battlegear",
    group: "Icecrown Citadel",
    classMask: 0x0023,
    expansionId: 2,
    uiOrder: 2770,
    parentId: 401,
  }),
  set({
    id: 411,
    name: "Earthen Copper Regalia",
    group: "Earthen Regalia",
    classMask: 0x0190,
    expansionId: 10,
  }),
  set({
    id: 412,
    name: "Stonebound Earthen Regalia",
    group: "Earthen Regalia",
    classMask: 0x0190,
    expansionId: 10,
    parentId: 411,
  }),
  set({
    id: 421,
    name: "Duskwoven Shroud",
    group: "Duskwoven Attire",
    classMask: 0x0190,
    expansionId: 3,
  }),
];

describe("foldFamilies", () => {
  const members = (families: Family[]): number[][] =>
    families.map((one) => one.members.map((member) => member.id));

  // The whole of the change: 4,911 rows of a shipping install are 2,766 things anybody would
  // call a set of clothes, and the game says which is which.
  it("draws one card per family, as the set the game calls its root", () => {
    expect(ids(foldFamilies(FAMILIES))).toEqual([401, 411, 421]);
    expect(members(foldFamilies(FAMILIES))).toEqual([[401, 402, 403], [411, 412], [421]]);
  });

  // Four of the 1,960 children a shipping install holds are a variant of a variant, and a walk
  // that stopped at the first parent would give those a card of their own.
  it("gathers a chain two deep under the root at the top of it", () => {
    const chain = [
      set({ id: 501, name: "Base" }),
      set({ id: 502, name: "Heroic", parentId: 501 }),
      set({ id: 503, name: "Mythic", parentId: 502 }),
    ];
    expect(members(foldFamilies(chain))).toEqual([[501, 502, 503]]);
  });

  // Fifteen roots of the whole table gather sets for different classes. A card standing for
  // both would answer `class:warrior` with a body no Warrior can wear, so they stay two cards —
  // and the mail one keeps the family's *root* out of its own members, which is the case the
  // fallback below exists for.
  it("splits a family whose members are not for the same classes", () => {
    const crossing = [
      set({ id: 601, name: "Brute of the Wastes", classMask: 0x0023 }),
      set({ id: 602, name: "Reshii Brute's Bastion", classMask: 0x1044, parentId: 601 }),
      set({ id: 603, name: "Void-Scarred Captain's Plate", classMask: 0x0023, parentId: 601 }),
    ];
    expect(members(foldFamilies(crossing))).toEqual([[601, 603], [602]]);
  });

  // A set that is another set's clothes is already spoken for by the card carrying it as an
  // alternate, so a family must never pick it up and show it a second time.
  it("leaves out a set that is another set's clothes", () => {
    const folded = [
      set({ id: 701, name: "Wild Combatant's Plate Armor" }),
      set({
        id: 702,
        name: "Warmongering Combatant's Plate Armor",
        parentId: 701,
        sameLookAs: 701,
      }),
    ];
    expect(members(foldFamilies(folded))).toEqual([[701]]);
  });

  // One family of a shipping install is headed by a root the other fold took. The card has to
  // be one of the members that are actually there rather than a set nothing can draw.
  it("shows the first member left when the root itself was folded away", () => {
    const orphaned = [
      set({ id: 711, name: "Root", sameLookAs: 999 }),
      set({ id: 712, name: "Heroic", parentId: 711 }),
      set({ id: 713, name: "Mythic", parentId: 711 }),
    ];
    const folded = foldFamilies(orphaned);
    expect(ids(folded)).toEqual([712]);
    expect(members(folded)).toEqual([[712, 713]]);
  });

  // A parent this install cannot read is no parent. The set is its own root rather than the
  // head of a family with an invisible set in it.
  it("makes a set its own root when the parent it names is not there", () => {
    expect(members(foldFamilies([set({ id: 721, name: "Orphan", parentId: 999 })]))).toEqual([
      [721],
    ]);
  });

  // Nothing in the game's tables promises a set is not its own ancestor. A circle costs a card
  // too many, which is what the grid looked like before any of this; a walk with no end costs a
  // window that never draws.
  it("does not walk for ever up a table that says a set is its own parent", () => {
    const circular = [
      set({ id: 731, name: "Round", parentId: 732 }),
      set({ id: 732, name: "About", parentId: 731 }),
    ];
    expect(ids(foldFamilies(circular))).toEqual([731, 732]);
  });

  // The backend sorts the sets and the grid draws them in that order; folding must leave the
  // cards where they were rather than gathering the families at the end.
  it("keeps the order the backend sorted the cards into", () => {
    const shuffled = [FAMILIES[3]!, FAMILIES[5]!, FAMILIES[0]!, FAMILIES[1]!, FAMILIES[4]!];
    expect(ids(foldFamilies(shuffled))).toEqual([411, 421, 401]);
  });

  it("has nothing to fold when the game read nothing", () => {
    expect(foldFamilies([])).toEqual([]);
  });
});

describe("variantLabel", () => {
  const family = foldFamilies(FAMILIES);

  // 698 of the 1,724 variants a shipping install holds differ from their root by name, and the
  // name is what a reader is looking at everywhere else on the card.
  it("names a variant by what the game calls it", () => {
    expect(variantLabel(FAMILIES[4]!, family[1]!)).toBe("Stonebound Earthen Regalia");
  });

  // The other thousand do not: a raid tier's three difficulties are one name three times, and
  // three buttons reading the same string are three a reader cannot choose between.
  it("adds the id where the family holds two of a name", () => {
    expect(variantLabel(FAMILIES[0]!, family[0]!)).toBe("Scourgelord's Battlegear · #401");
    expect(variantLabel(FAMILIES[2]!, family[0]!)).toBe("Scourgelord's Battlegear · #403");
  });

  // The game withholds the names of sets it has not shipped, and a rail of blanks is a rail
  // nobody can use — so the id carries the whole label rather than none of it.
  it("says what an unnamed set is by its id", () => {
    const unnamed = foldFamilies([
      set({ id: 801, name: "" }),
      set({ id: 802, name: "", parentId: 801 }),
    ]);
    expect(variantLabel(unnamed[0]!.members[1]!, unnamed[0]!)).toBe("Unnamed set · #802");
  });
});

/**
 * A variant is reachable by everything it says, which is the whole risk of folding it away.
 *
 * The same claim the `sameLookAs` fold has to answer, asked of the larger of the two folds: a
 * reader who types the name of a difficulty, or narrows to the expansion a recolour came out
 * in, has to land on the card that swallowed it.
 */
describe("filtering a family by what only a variant says", () => {
  const none = { search: "", expansion: "", klass: "" };
  const REACHED: TransmogSet[] = [
    set({
      id: 401,
      name: "Scourgelord's Battlegear",
      group: "Icecrown Citadel",
      classMask: 0x0023,
      expansionId: 2,
    }),
    // The variant, out of another collection and — as 22 families of a shipping install are —
    // out of another expansion. It also stands in for a set of its own, because the two folds
    // stack: a variant can be the one shown of a `sameLookAs` cluster, and what that cluster
    // says has to reach the family's card as well.
    set({
      id: 402,
      name: "Sanctified Scourgelord's Battlegear",
      group: "Icecrown Trophies",
      classMask: 0x0023,
      expansionId: 9,
      patchIntroduced: 100200,
      parentId: 401,
      alternates: [
        alternate({
          id: 403,
          name: "Ebon Blade Battlegear",
          group: "Knightly Vanguard",
          classMask: 1 << 5,
          expansionId: 9,
          reason: "class",
        }),
      ],
    }),
    set({ id: 421, name: "Duskwoven Shroud", group: "Duskwoven Attire", expansionId: 3 }),
  ];

  it.each<[string, { search: string; expansion: string; klass: string }, number[]]>([
    ["its name", { ...none, search: "sanctified" }, [401]],
    ["its collection", { ...none, search: "trophies" }, [401]],
    ["its id", { ...none, search: "402" }, [401]],
    ["its patch", { ...none, search: "10.2.0" }, [401]],
    ["the expansion it came out in", { ...none, expansion: "9" }, [401]],
    ["the class of a set folded into it", { ...none, klass: "5" }, [401, 421]],
  ])("answers %s with the card standing in for it", (_what, filters, expected) => {
    expect(ids(filtered(REACHED, filters))).toEqual(expected);
  });

  it.each<[string, string, number[]]>([
    ["its name", "name:sanctified", [401]],
    ["its collection", "collection:trophies", [401]],
    ["the class of a set folded into it", "class:death knight", [401]],
    ["its expansion", "expansion:dragonflight", [401]],
  ])("answers a term asking for %s the same way", (_what, search, expected) => {
    expect(ids(filtered(REACHED, { ...none, search }))).toEqual(expected);
  });

  // Every word somewhere in the family rather than all of them in one member, so a reader who
  // half-remembers the base set and half the heroic one still lands on the card.
  it("ands the words of a search across the whole family", () => {
    expect(ids(filtered(REACHED, { ...none, search: "scourgelord trophies" }))).toEqual([401]);
    expect(filtered(REACHED, { ...none, search: "duskwoven trophies" })).toEqual([]);
  });

  // The one thing families do that clusters cannot. A set folded away by `sameLookAs` never
  // reaches the grid, so nobody can star one; a variant is on the card's own rail, so a reader
  // can pick it and star exactly that — and the grid then has to keep the card it is on.
  it("keeps a card whose star is against a variant rather than the set shown", () => {
    const marks = indexMarks({
      marks: [{ kind: "set", id: 402, favourite: true, tags: [{ key: "wishlist", value: null }] }],
    });
    const asked = (filter: MarkFilter, search = ""): number[] =>
      ids(
        filtered(REACHED, {
          ...none,
          search,
          marks: { filter, of: (id) => marks.of("set", id) },
        }),
      );
    expect(asked({ favourite: true, tag: "" })).toEqual([401]);
    expect(asked({ favourite: false, tag: tokenOf("wishlist", null) })).toEqual([401]);
    expect(asked(NO_MARK_FILTER, "wishlist")).toEqual([401]);
  });

  // And the same for what nobody typed: the colours are measured per set, and a family of
  // eighteen shades is eighteen answers to "which of these is brown".
  it("finds a card by the colour measured of one of its variants", () => {
    const measured = indexQualities({
      build: "12.0.5.67823",
      sets: [
        { id: 401, primary: "#2060e0" },
        { id: 402, primary: "#4a3b2c" },
      ],
    });
    const asked = (search: string): number[] =>
      ids(filtered(REACHED, { ...none, search, qualities: (id) => measured.of(id) }));
    expect(asked("colour:brown")).toEqual([401]);
    expect(asked("colour:blue")).toEqual([401]);
    expect(asked("colour:pink")).toEqual([]);
  });
});

describe("alternateLabel", () => {
  /** The card the folded sets below are written under: plate, Warlords, patch 6.2.0. */
  const shown = set({
    id: 301,
    name: "Wild Combatant's Plate Armor",
    classMask: 0x0023,
    expansionId: 5,
    patchIntroduced: 60200,
  });

  it.each<[string, Alternate, string]>([
    [
      "class",
      alternate({ id: 312, name: "Ebon Blade Battlegear", classMask: 1 << 5, reason: "class" }),
      "another class's Ebon Blade Battlegear · Death Knight",
    ],
    [
      "reissue a whole expansion later",
      alternate({
        id: 322,
        name: "Sunwarmed Finery",
        classMask: 0x0023,
        expansionId: 9,
        patchIntroduced: 100200,
        reason: "reissue",
      }),
      "released again as Sunwarmed Finery · Dragonflight",
    ],
    [
      "reissue a patch later",
      alternate({
        id: 332,
        name: "Warmongering Combatant's Plate Armor",
        classMask: 0x0023,
        expansionId: 5,
        patchIntroduced: 60201,
        reason: "reissue",
      }),
      "released again as Warmongering Combatant's Plate Armor · Patch 6.2.1",
    ],
  ])("says a set was folded in because it is a %s", (_reason, folded, expected) => {
    expect(alternateLabel(folded, shown)).toBe(expected);
  });

  // The qualifier is only ever what differs from the card the line is written under. A faction
  // pair is the same armour, for the same classes, out of the same patch — that is what makes
  // it a pair — so naming any of those spends the line repeating the chip directly above it.
  it("names nothing about a set that differs from its card only by faction", () => {
    const folded = alternate({
      id: 302,
      name: "Warmongering Combatant's Plate Armor",
      classMask: 0x0023,
      expansionId: 5,
      patchIntroduced: 60200,
      reason: "faction",
    });
    expect(alternateLabel(folded, shown)).toBe(
      "the other faction's Warmongering Combatant's Plate Armor",
    );
  });

  // The game writes "anyone" as a mask of zero and as every bit at once, and a card for one of
  // them beside a folded set carrying the other is the same audience written two ways — so it
  // is not a difference, and the line falls through to where the set came from instead.
  it.each<[string, number, number]>([
    ["no class at all against every class", 0, 0x1fff],
    ["every class at once against none", 0x1fff, 0],
  ])("treats %s as the same audience", (_what, shownMask, foldedMask) => {
    const anyone = set({ id: 340, name: "Sunwarmed Finery", classMask: shownMask, expansionId: 5 });
    const folded = alternate({
      id: 341,
      name: "Sunwarmed Regalia",
      classMask: foldedMask,
      expansionId: 9,
      reason: "reissue",
    });
    // The masks differ as numbers, so this is the label reading them rather than comparing them.
    expect(alternateLabel(folded, anyone)).toBe(
      "released again as Sunwarmed Regalia · Dragonflight",
    );
  });
});

describe("groupFamilies", () => {
  it("gathers a collection without reordering it", () => {
    const grouped = groupFamilies(
      foldFamilies([
        set({ id: 205, name: "Duskwoven Shroud", group: "Duskwoven Attire" }),
        set({ id: 201, name: "Tideglass Regalia", group: "Tideglass Wardrobe" }),
        set({ id: 202, name: "Tideglass Hide", group: "Tideglass Wardrobe" }),
      ]),
    );
    expect(grouped.map((group) => group.group)).toEqual(["Duskwoven Attire", "Tideglass Wardrobe"]);
    expect(grouped[1]?.families.map((found) => found.shown.id)).toEqual([201, 202]);
  });

  // A collection the tables do not name still has to land somewhere on screen.
  it("files a set with no collection under one of its own", () => {
    const grouped = groupFamilies(foldFamilies([set({ id: 900, name: "Orphan" })]));
    expect(grouped.map((group) => group.group)).toEqual(["Ungrouped"]);
  });

  it("has nothing to group when nothing is left", () => {
    expect(groupFamilies([])).toEqual([]);
  });
});

describe("narrowing the grid to what the reader said about it", () => {
  const sets = [
    set({ id: 201, name: "Tideglass Regalia" }),
    set({ id: 202, name: "Tideglass Hide" }),
    set({ id: 203, name: "Duskwoven Shroud" }),
  ];
  const marks = indexMarks({
    marks: [
      { kind: "set", id: 201, favourite: true, tags: [{ key: "faction", value: "horde" }] },
      { kind: "set", id: 202, favourite: false, tags: [{ key: "wishlist", value: null }] },
      // A look of the same number, which must not reach a grid of sets.
      { kind: "appearance", id: 203, favourite: true, tags: [] },
    ],
  });
  const marked = (filter: MarkFilter) => ({ filter, of: (id: number) => marks.of("set", id) });
  const shown = (filter: MarkFilter): number[] =>
    filtered(sets, {
      search: "",
      expansion: "",
      klass: "",
      marks: marked(filter),
    }).map((one) => one.shown.id);

  it("leaves the grid alone until it is asked something", () => {
    expect(shown(NO_MARK_FILTER)).toEqual([201, 202, 203]);
  });

  it("keeps only the starred sets", () => {
    expect(shown({ favourite: true, tag: "" })).toEqual([201]);
  });

  it("keeps only the sets under one tag", () => {
    expect(shown({ favourite: false, tag: tokenOf("wishlist", null) })).toEqual([202]);
    expect(shown({ favourite: false, tag: tokenOf("faction", "horde") })).toEqual([201]);
    expect(shown({ favourite: false, tag: tokenOf("faction", "alliance") })).toEqual([]);
  });

  // A set and a look can share a number, and only one of the two countings is a grid of sets.
  it("does not read a look's mark as a set's", () => {
    expect(shown({ favourite: true, tag: "" })).not.toContain(203);
  });

  // The whole argument for folding the marks into the searchable text: a reader looking at a
  // chip saying "horde" types the word rather than hunting for the picker beside the box.
  it("finds a set by a word the reader filed it under", () => {
    const found = filtered(sets, {
      search: "horde",
      expansion: "",
      klass: "",
      marks: marked(NO_MARK_FILTER),
    });
    expect(found.map((one) => one.shown.id)).toEqual([201]);
  });

  it("finds the starred sets by the word for them", () => {
    const found = filtered(sets, {
      search: "favourite",
      expansion: "",
      klass: "",
      marks: marked(NO_MARK_FILTER),
    });
    expect(found.map((one) => one.shown.id)).toEqual([201]);
  });

  // Every caller that predates marks passes none, and must keep getting the whole grid.
  it("says nothing about marks when it was given none", () => {
    expect(filtered(sets, { search: "", expansion: "", klass: "" })).toHaveLength(3);
    expect(filtered(sets, { search: "horde", expansion: "", klass: "" })).toHaveLength(0);
  });
});

describe("asking the grid for one thing a set says", () => {
  const sets = [
    set({
      id: 301,
      name: "Wild Combatant's Plate Armor",
      group: "Wild Gladiator",
      classMask: 0x0023,
      expansionId: 5,
      patchIntroduced: 60200,
      alternates: [
        alternate({
          id: 312,
          name: "Ebon Blade Battlegear",
          group: "Knightly Vanguard",
          classMask: 1 << 9,
          expansionId: 9,
          reason: "class",
        }),
      ],
    }),
    set({
      id: 201,
      name: "Tideglass Regalia",
      group: "Tideglass Wardrobe",
      classMask: 0x0190,
      expansionId: 3,
      patchIntroduced: 40001,
    }),
  ];
  const marks = indexMarks({
    marks: [
      {
        kind: "set",
        id: 201,
        favourite: false,
        tags: [
          { key: "faction", value: "horde" },
          { key: "wishlist", value: null },
        ],
      },
    ],
  });
  const measured = indexQualities({
    build: "12.0.5.67823",
    sets: [
      { id: 301, primary: "#4a3b2c" },
      { id: 201, primary: "#2060e0", accent: "#f6f6f6" },
    ],
  });
  const found = (search: string): number[] =>
    filtered(sets, {
      search,
      expansion: "",
      klass: "",
      marks: { filter: NO_MARK_FILTER, of: (id) => marks.of("set", id) },
      qualities: (id) => measured.of(id),
    }).map((one) => one.shown.id);

  // Everything the card already shows, asked for one at a time: a reader looking at "Plate ·
  // Warlords of Draenor · Patch 6.2.0" can now say which of the three they meant.
  it.each<[string, string, number[]]>([
    ["the collection over the card", "collection:tideglass", [201]],
    ["the armour a class mask names", "class:plate", [301]],
    ["a class inside the mask", "class:priest", [201]],
    ["the expansion", "expansion:warlords", [301]],
    ["the patch", "patch:4.0.1", [201]],
    ["the name the game gave it", "name:regalia", [201]],
  ])("finds a set by %s", (_what, search, expected) => {
    expect(found(search)).toEqual(expected);
  });

  // Two names on one card, which the one flattened string it used to search could not tell
  // apart: "Gladiator" is the collection and is no part of what the set itself is called.
  it("keeps what a set is called apart from the collection it is in", () => {
    expect(found("collection:gladiator")).toEqual([301]);
    expect(found("name:gladiator")).toEqual([]);
  });

  // The whole risk of folding a set away, asked the new way: a fact only the folded version
  // carries has to answer for the card standing in its place, or the look is unfindable.
  it.each<[string, string]>([
    ["a class only the folded set is for", "class:monk"],
    ["an expansion only the folded set came out in", "expansion:dragonflight"],
    ["a collection only the folded set is in", "collection:vanguard"],
  ])("answers %s with the card shown in its place", (_what, search) => {
    expect(found(search)).toEqual([301]);
  });

  it("finds a set by a tag the reader wrote against it", () => {
    expect(found("faction:horde")).toEqual([201]);
    expect(found("faction:alliance")).toEqual([]);
  });

  it("takes a bare key as any value the reader filed under it", () => {
    expect(found("faction:")).toEqual([201]);
  });

  // The thing this grid could not do at all: nothing in the game's own words about the Wild
  // Combatant's armour says that it is brown, and now both ways of asking find it.
  it("finds a set by the colour its artwork was measured to be", () => {
    expect(found("brown")).toEqual([301]);
    expect(found("colour:brown")).toEqual([301]);
  });

  it("narrows on every term together", () => {
    expect(found("class:plate expansion:warlords")).toEqual([301]);
    expect(found("class:plate expansion:cataclysm")).toEqual([]);
  });

  it("reads a word beside a term", () => {
    expect(found("colour:blue tideglass")).toEqual([201]);
    expect(found("colour:blue gladiator")).toEqual([]);
  });

  // An empty grid is the answer to "which of these is large", the sets' file measuring no
  // sizes at all — rather than the term being dropped and the grid left as it was.
  it("leaves an empty grid for a term nothing carries", () => {
    expect(found("size:large")).toEqual([]);
    expect(found("colour:pink")).toEqual([]);
  });
});
