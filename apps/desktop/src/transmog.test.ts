import { describe, expect, it } from "vitest";
import {
  alternateLabel, classLabel, classNames, expansionName, filterSets, groupSets, patchName,
} from "./transmog";
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

describe("filterSets", () => {
  const SETS = [
    set({ id: 205, name: "Duskwoven Shroud", group: "Duskwoven Attire", expansionId: 5 }),
    set({ id: 203, name: "Emberforge Plate", group: "Emberforge Armory", classMask: 0x0023, expansionId: 4 }),
    set({ id: 201, name: "Tideglass Regalia", group: "Tideglass Wardrobe", classMask: 0x0190, expansionId: 3 }),
    set({ id: 202, name: "Tideglass Hide", group: "Tideglass Wardrobe", classMask: 0x0e08, expansionId: 3 }),
  ];
  /** The same sets with the metadata a search now reads filled in. */
  const WITH_METADATA = [
    set({ id: 205, name: "Duskwoven Shroud", group: "Duskwoven Attire", expansionId: 5 }),
    set({
      id: 203, name: "Emberforge Plate", group: "Emberforge Armory",
      classMask: 0x0023, expansionId: 3, patchIntroduced: 40001,
    }),
    set({
      id: 201, name: "Tideglass Regalia", group: "Tideglass Wardrobe",
      classMask: 0x0190, expansionId: 4,
    }),
  ];
  const none = { search: "", expansion: "", klass: "" };
  const ids = (sets: TransmogSet[]): number[] => sets.map((found) => found.id);

  it("keeps every set when nothing is filled in", () => {
    expect(ids(filterSets(SETS, none))).toEqual([205, 203, 201, 202]);
  });

  it("searches the collection as well as the set", () => {
    expect(ids(filterSets(SETS, { ...none, search: "tideglass" }))).toEqual([201, 202]);
    expect(ids(filterSets(SETS, { ...none, search: "shroud" }))).toEqual([205]);
    expect(ids(filterSets(SETS, { ...none, search: "  EMBERFORGE  " }))).toEqual([203]);
    expect(filterSets(SETS, { ...none, search: "nothing like it" })).toEqual([]);
  });

  it("narrows to one expansion", () => {
    expect(ids(filterSets(SETS, { ...none, expansion: "3" }))).toEqual([201, 202]);
  });

  // Priest is a cloth class, and a set with no class of its own is for everyone — which is
  // the case a plain mask test gets wrong.
  it("keeps a class-agnostic set alongside the class asked for", () => {
    expect(ids(filterSets(SETS, { ...none, klass: "4" }))).toEqual([205, 201]);
    expect(ids(filterSets(SETS, { ...none, klass: "0" }))).toEqual([205, 203]);
  });

  it("applies search, expansion and class together", () => {
    expect(ids(filterSets(SETS, { search: "tideglass", expansion: "3", klass: "9" }))).toEqual([202]);
    expect(filterSets(SETS, { search: "tideglass", expansion: "4", klass: "" })).toEqual([]);
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
    expect(ids(filterSets(WITH_METADATA, { ...none, search }))).toEqual(expected);
  });

  // Word by word rather than as a phrase, so a reader can narrow by two facts at once without
  // learning what order the metadata happens to be written in.
  it("takes every word of a search, in any order", () => {
    expect(ids(filterSets(WITH_METADATA, { ...none, search: "plate cataclysm" }))).toEqual([203]);
    expect(ids(filterSets(WITH_METADATA, { ...none, search: "cataclysm plate" }))).toEqual([203]);
    expect(filterSets(WITH_METADATA, { ...none, search: "plate pandaria" })).toEqual([]);
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
      id: 301, name: "Wild Combatant's Plate Armor", group: "Wild Gladiator",
      classMask: 0x0023, expansionId: 5, patchIntroduced: 60200,
      alternates: [alternate({
        id: 302, name: "Warmongering Combatant's Plate Armor", group: "Warmongering Gladiator",
        classMask: 0x0023, expansionId: 5, patchIntroduced: 60200, reason: "faction",
      })],
    }),
    set({
      id: 302, name: "Warmongering Combatant's Plate Armor", group: "Warmongering Gladiator",
      classMask: 0x0023, expansionId: 5, patchIntroduced: 60200, sameLookAs: 301,
    }),
    set({
      id: 311, name: "Vestments of the Eternal", group: "Eternal Regalia",
      classMask: 0x0190, expansionId: 6,
      alternates: [alternate({
        id: 312, name: "Ebon Blade Battlegear", group: "Knightly Vanguard",
        classMask: 1 << 9, expansionId: 6, reason: "class",
      })],
    }),
    set({
      id: 312, name: "Ebon Blade Battlegear", group: "Knightly Vanguard",
      classMask: 1 << 9, expansionId: 6, sameLookAs: 311,
    }),
    set({
      id: 321, name: "Sunwarmed Finery", group: "Sunwarmed Attire",
      classMask: 0x0023, expansionId: 5,
      alternates: [alternate({
        id: 322, name: "Sunwarmed Finery", group: "Timerunning Wardrobe",
        classMask: 0, expansionId: 9, reason: "reissue",
      })],
    }),
    set({
      id: 322, name: "Sunwarmed Finery", group: "Timerunning Wardrobe",
      classMask: 0, expansionId: 9, sameLookAs: 321,
    }),
    set({
      id: 331, name: "Duskwoven Shroud", group: "Duskwoven Attire",
      classMask: 0x0190, expansionId: 3,
    }),
  ];

  it("leaves out every set that is another set's clothes", () => {
    expect(ids(filterSets(CLUSTERS, none))).toEqual([301, 311, 321, 331]);
  });

  // A folded set matching a filter on its own account is the case worth pinning down: the grid
  // must answer with the card standing in for it, and never with two rows of the same clothes.
  it.each<[string, { search: string; expansion: string; klass: string }, number[]]>([
    ["by its name", { search: "warmongering", expansion: "", klass: "" }, [301]],
    ["by its expansion", { search: "", expansion: "5", klass: "" }, [301, 321]],
    ["by its class", { search: "", expansion: "", klass: "9" }, [311, 321]],
  ])("never shows a folded set even when it matches %s", (_what, filters, expected) => {
    expect(ids(filterSets(CLUSTERS, filters))).toEqual(expected);
  });

  // The whole risk of folding sets away is a reader typing the name of one and getting nothing.
  // Whatever the game called the folded set — its name, its collection, or the id it falls back
  // to when the game withholds a name — has to reach the card shown in its place.
  it.each<[string, string, number[]]>([
    ["an alternate's name", "warmongering", [301]],
    ["an alternate's collection", "vanguard", [311]],
    ["an alternate's id", "322", [321]],
  ])("finds the set shown in place of one searched by %s", (_what, search, expected) => {
    expect(ids(filterSets(CLUSTERS, { ...none, search }))).toEqual(expected);
  });

  // Every word has to be found somewhere in the cluster rather than all in one set of it, so a
  // reader who half-remembers both halves of a faction pair still lands on the card.
  it("ands the words of a search across the whole cluster", () => {
    expect(ids(filterSets(CLUSTERS, { ...none, search: "wild warmongering" }))).toEqual([301]);
    expect(filterSets(CLUSTERS, { ...none, search: "wild vanguard" })).toEqual([]);
  });

  /**
   * Monk is the case both halves of the class rule have to survive.
   *
   * 311 is a cloth set no Monk can wear and is kept only because the leather version folded
   * into it is a Monk's; 321 is plate and is kept because the set folded into it belongs to no
   * class at all, which the game means as everyone rather than as nobody.
   */
  it("keeps a cluster whose only wearer of the class asked for was folded away", () => {
    expect(ids(filterSets(CLUSTERS, { ...none, klass: "9" }))).toEqual([311, 321]);
  });

  it.each<[string, string, number[]]>([
    ["Warrior", "0", [301, 321]],
    ["Priest", "4", [311, 321, 331]],
  ])("still reads the shown set's own classes when narrowed to %s", (_what, klass, expected) => {
    expect(ids(filterSets(CLUSTERS, { ...none, klass }))).toEqual(expected);
  });

  // A set reissued a few expansions later is the same clothes from a different era, and the
  // reader narrowing to the later one is looking for exactly the card that swallowed it.
  it("keeps a cluster whose only set from an expansion was folded away", () => {
    expect(ids(filterSets(CLUSTERS, { ...none, expansion: "9" }))).toEqual([321]);
  });

  // Four thousand of the game's sets are in no cluster at all, and the fields the backend
  // simply leaves off have to read as "no cluster" rather than as an empty one.
  it("filters a set with neither field exactly as it always did", () => {
    const plain = [set({
      id: 331, name: "Duskwoven Shroud", group: "Duskwoven Attire",
      classMask: 0x0190, expansionId: 3, alternates: undefined, sameLookAs: undefined,
    })];
    expect(ids(filterSets(plain, none))).toEqual([331]);
    expect(ids(filterSets(plain, { search: "duskwoven", expansion: "3", klass: "4" }))).toEqual([331]);
    expect(filterSets(plain, { ...none, search: "warmongering" })).toEqual([]);
    expect(filterSets(plain, { ...none, expansion: "9" })).toEqual([]);
    expect(filterSets(plain, { ...none, klass: "9" })).toEqual([]);
  });
});

describe("alternateLabel", () => {
  /** The card the folded sets below are written under: plate, Warlords, patch 6.2.0. */
  const shown = set({
    id: 301, name: "Wild Combatant's Plate Armor", classMask: 0x0023, expansionId: 5,
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
        id: 322, name: "Sunwarmed Finery", classMask: 0x0023, expansionId: 9,
        patchIntroduced: 100200, reason: "reissue",
      }),
      "released again as Sunwarmed Finery · Dragonflight",
    ],
    [
      "reissue a patch later",
      alternate({
        id: 332, name: "Warmongering Combatant's Plate Armor", classMask: 0x0023, expansionId: 5,
        patchIntroduced: 60201, reason: "reissue",
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
      id: 302, name: "Warmongering Combatant's Plate Armor", classMask: 0x0023, expansionId: 5,
      patchIntroduced: 60200, reason: "faction",
    });
    expect(alternateLabel(folded, shown))
      .toBe("the other faction's Warmongering Combatant's Plate Armor");
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
      id: 341, name: "Sunwarmed Regalia", classMask: foldedMask, expansionId: 9, reason: "reissue",
    });
    // The masks differ as numbers, so this is the label reading them rather than comparing them.
    expect(alternateLabel(folded, anyone)).toBe("released again as Sunwarmed Regalia · Dragonflight");
  });
});

describe("groupSets", () => {
  it("gathers a collection without reordering it", () => {
    const grouped = groupSets([
      set({ id: 205, name: "Duskwoven Shroud", group: "Duskwoven Attire" }),
      set({ id: 201, name: "Tideglass Regalia", group: "Tideglass Wardrobe" }),
      set({ id: 202, name: "Tideglass Hide", group: "Tideglass Wardrobe" }),
    ]);
    expect(grouped.map((group) => group.group)).toEqual(["Duskwoven Attire", "Tideglass Wardrobe"]);
    expect(grouped[1]?.sets.map((found) => found.id)).toEqual([201, 202]);
  });

  // A collection the tables do not name still has to land somewhere on screen.
  it("files a set with no collection under one of its own", () => {
    const grouped = groupSets([set({ id: 900, name: "Orphan" })]);
    expect(grouped.map((group) => group.group)).toEqual(["Ungrouped"]);
  });

  it("has nothing to group when nothing is left", () => {
    expect(groupSets([])).toEqual([]);
  });
});
