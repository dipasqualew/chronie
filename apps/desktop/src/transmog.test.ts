import { describe, expect, it } from "vitest";
import { classLabel, classNames, expansionName, filterSets, groupSets, patchName } from "./transmog";
import type { TransmogSet } from "./types";

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
