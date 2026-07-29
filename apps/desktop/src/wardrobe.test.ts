import { describe, expect, it } from "vitest";

import { NO_MARK_FILTER, indexMarks, tokenOf } from "./marks";
import type { MarkFilter } from "./marks";
import { indexQualities } from "./qualities";
import {
  HELD_IN_HAND,
  KINDS,
  PAGE,
  answerKey,
  filterAppearances,
  isKind,
  kindName,
  kindOf,
  shownSummary,
  wardrobeRow,
} from "./wardrobe";
import type { WardrobeAppearance } from "./types";

/** A look with only the fields a test cares about spelled out. */
const look = (
  fields: Partial<WardrobeAppearance> & Pick<WardrobeAppearance, "appearanceId">,
): WardrobeAppearance => ({
  itemId: 1000 + fields.appearanceId,
  name: "Something",
  displayType: 0,
  inventoryType: 1,
  classId: 4,
  subclassId: 4,
  allowableClass: 0xffff,
  requiredLevel: 0,
  quality: 4,
  displayInfoId: 500,
  iconFileDataId: 0,
  hasModel: false,
  itemCount: 1,
  liftsRestriction: false,
  ...fields,
});

/** A weapon, which is the half of the wardrobe the display type says nothing useful about. */
const weapon = (subclassId: number, fields: Partial<WardrobeAppearance> = {}): WardrobeAppearance =>
  look({
    appearanceId: 900 + subclassId,
    displayType: 11,
    inventoryType: 13,
    classId: 2,
    subclassId,
    ...fields,
  });

describe("the kinds a reader picks between", () => {
  // The whole point of the module. The game files a dagger, a staff and a one-handed axe
  // under one display type, so a picker built on display types could not offer any of them.
  it("cuts one answer up by what the items actually are", () => {
    const held = [weapon(15, { name: "Dagger" }), weapon(10, { name: "Staff" })];
    const daggers = filterAppearances(held, {
      kind: kindOf("weapon-15"),
      search: "",
      klass: "",
    });
    expect(daggers.map((one) => one.name)).toEqual(["Dagger"]);
  });

  // And the same answer serves every one of them, which is what stops a reader flicking
  // between staves and daggers paying the game's storage a second each time.
  it("asks for one answer for everything held in a hand", () => {
    const keys = KINDS.filter((kind) => kind.group !== "Worn on the body").map((kind) =>
      answerKey(kind),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(HELD_IN_HAND.join(","));
  });

  it("asks for one display type per armour slot", () => {
    expect(answerKey(kindOf("armour-0"))).toBe("0");
    expect(answerKey(kindOf("armour-3"))).toBe("3");
  });

  // A shield and a tome are armour in the game's own filing, so a kind that read the display
  // type alone would put them among the swords.
  it.each<[string, number, number]>([
    ["shield", 4, 6],
    ["off-hand", 4, 0],
  ])("keeps %s apart from the weapons beside it", (key, classId, subclassId) => {
    const kind = kindOf(key);
    const held = [look({ appearanceId: 1, displayType: 13, classId, subclassId }), weapon(7)];
    expect(filterAppearances(held, { kind, search: "", klass: "" })).toHaveLength(1);
  });

  // The catch-all, and the reason it is there: an install holds looks belonging to kinds no
  // player has a word for, and without it they would be fetched and then unshowable.
  it("shows everything held under the kind that filters nothing", () => {
    const held = [
      weapon(7),
      look({ appearanceId: 2, displayType: 11, classId: 19, subclassId: 9 }),
    ];
    expect(filterAppearances(held, { kind: kindOf("held"), search: "", klass: "" })).toHaveLength(
      2,
    );
  });

  it("falls back to the first kind for a key it does not know", () => {
    expect(kindOf("nonsense")).toBe(KINDS[0]);
    expect(kindOf("armour-0").label).toBe("Head");
  });

  it("says what kind of thing a look is, and says nothing where it is armour", () => {
    expect(kindName(weapon(10))).toBe("Staff");
    expect(kindName(look({ appearanceId: 1 }))).toBe("");
  });

  it("leaves a look out of a kind it is not filed under", () => {
    expect(isKind(weapon(10), kindOf("weapon-10"))).toBe(true);
    expect(isKind(weapon(10), kindOf("weapon-15"))).toBe(false);
    expect(isKind(weapon(10), kindOf("armour-0"))).toBe(false);
  });
});

describe("filtering a kind's looks", () => {
  const wardrobe = [
    look({ appearanceId: 1, name: "Stormforged Helm", allowableClass: 0b1 }),
    look({ appearanceId: 2, name: "Tideglass Crown", allowableClass: 0xffff }),
    // The game withholds what it has not shipped, and a mask of nothing is the table
    // declining to say rather than a look nobody may wear.
    look({ appearanceId: 3, name: "", itemId: 30011, allowableClass: 0 }),
  ];
  const filter = (search: string, klass = ""): string[] =>
    filterAppearances(wardrobe, { kind: kindOf("armour-0"), search, klass }).map((one) => one.name);

  it("matches every word of a search rather than the phrase", () => {
    expect(filter("storm helm")).toEqual(["Stormforged Helm"]);
    expect(filter("helm storm")).toEqual(["Stormforged Helm"]);
    expect(filter("storm crown")).toEqual([]);
  });

  it("matches what the row shows as well as what it is called", () => {
    // The slot, which is on the row and is not in any of the three names.
    expect(filter("head")).toHaveLength(3);
  });

  // The one thing a reader has when the game has withheld the name.
  it("finds a look the game will not name by its item id", () => {
    expect(
      filterAppearances(wardrobe, {
        kind: kindOf("armour-0"),
        search: "30011",
        klass: "",
      }),
    ).toHaveLength(1);
  });

  it("keeps a look every class may wear whatever class is asked for", () => {
    expect(filter("", "0")).toEqual(["Stormforged Helm", "Tideglass Crown", ""]);
    // Warrior is bit 0 and the Stormforged Helm is the only class-locked one of the three.
    expect(filter("", "1")).toEqual(["Tideglass Crown", ""]);
  });

  it("keeps every look when no class is asked for", () => {
    expect(filter("")).toHaveLength(3);
  });
});

describe("a look as a row", () => {
  it("carries every item behind the look into the count the row draws", () => {
    const row = wardrobeRow(look({ appearanceId: 5, itemCount: 3, liftsRestriction: true }));
    expect(row.sources).toHaveLength(1);
    expect(row.sources[0]?.itemCount).toBe(3);
    expect(row.liftsRestriction).toBe(true);
  });

  it("names a look the game withholds the item of by its id", () => {
    const row = wardrobeRow(look({ appearanceId: 6, name: "", itemId: 30011 }));
    expect(row.label).toBe("Item 30011");
    // Withheld is what a row of a *set* is when nothing could be followed; a row that got
    // this far has an appearance and a place, so it is a row like any other.
    expect(row.withheld).toBe(false);
  });

  // The row is what `outfit.ts` puts on a character, and it decides where a thing goes from
  // the display type and the inventory type — which for a weapon is the only answer there is.
  it("says where a weapon is worn rather than what number the game files it under", () => {
    expect(wardrobeRow(weapon(7)).slot).toBe("One-hand");
    expect(wardrobeRow(weapon(8, { inventoryType: 17 })).slot).toBe("Two-hand");
    expect(wardrobeRow(look({ appearanceId: 7, displayType: 3 })).slot).toBe("Chest");
  });
});

describe("how much of a kind is drawn", () => {
  it("says how far down a list of thousands the reader has got", () => {
    expect(shownSummary(PAGE, 5111, 0)).toBe("100 of 5111 appearances");
    expect(shownSummary(4, 4, 0)).toBe("4 appearances");
  });

  it("says what the game keeps encrypted rather than coming up short in silence", () => {
    expect(shownSummary(4, 4, 591)).toBe("4 appearances · 591 looks the game keeps encrypted");
  });
});

describe("narrowing a kind to what the reader said about it", () => {
  const looks = [
    look({ appearanceId: 11, name: "Tideglass Crown" }),
    look({ appearanceId: 12, name: "Duskwoven Hood" }),
    look({ appearanceId: 13, name: "Emberplate Helm" }),
  ];
  const marks = indexMarks({
    marks: [
      { kind: "appearance", id: 11, favourite: true, tags: [{ key: "faction", value: "horde" }] },
      { kind: "appearance", id: 12, favourite: false, tags: [{ key: "wishlist", value: null }] },
      // A set of the same number, which is a different subject and must not reach this list.
      { kind: "set", id: 13, favourite: true, tags: [] },
    ],
  });
  const marked = (filter: MarkFilter) => ({
    filter,
    of: (id: number) => marks.of("appearance", id),
  });
  const shown = (filter: MarkFilter): number[] =>
    filterAppearances(looks, {
      kind: kindOf("armour-0"),
      search: "",
      klass: "",
      marks: marked(filter),
    }).map((one) => one.appearanceId);

  it("leaves the list alone until it is asked something", () => {
    expect(shown(NO_MARK_FILTER)).toEqual([11, 12, 13]);
  });

  it("keeps only the starred looks", () => {
    expect(shown({ favourite: true, tag: "" })).toEqual([11]);
  });

  it("keeps only the looks under one tag", () => {
    expect(shown({ favourite: false, tag: tokenOf("wishlist", null) })).toEqual([12]);
    expect(shown({ favourite: false, tag: tokenOf("faction", "horde") })).toEqual([11]);
  });

  it("does not read a set's mark as a look's", () => {
    expect(shown({ favourite: true, tag: "" })).not.toContain(13);
  });

  it("finds a look by a word the reader filed it under", () => {
    const found = filterAppearances(looks, {
      kind: kindOf("armour-0"),
      search: "horde",
      klass: "",
      marks: marked(NO_MARK_FILTER),
    });
    expect(found.map((one) => one.appearanceId)).toEqual([11]);
  });

  it("says nothing about marks when it was given none", () => {
    expect(
      filterAppearances(looks, {
        kind: kindOf("armour-0"),
        search: "",
        klass: "",
      }),
    ).toHaveLength(3);
  });
});

describe("searching a wardrobe by what the artwork was measured to be", () => {
  const looks = [look({ appearanceId: 11 }), look({ appearanceId: 12 })];
  const measured = indexQualities({
    displayType: 0,
    build: "12.0.5.67823",
    sizeCuts: {},
    appearances: [
      { id: 11, primary: "#4a3b2c", size: "large" },
      { id: 12, primary: "#2060e0", accent: "#f6f6f6", size: "small" },
    ],
  });
  const found = (search: string): number[] =>
    filterAppearances(looks, {
      kind: kindOf("armour-0"),
      search,
      klass: "",
      qualities: (id) => measured.of(id),
    }).map((one) => one.appearanceId);

  // The whole reason the colours are named at all: "brown" is in no item's name in the game,
  // and it is how somebody looking at five thousand chestpieces asks for the brown ones.
  it("finds a look by the colour nothing in the game calls it", () => {
    expect(found("brown")).toEqual([11]);
    expect(found("blue")).toEqual([12]);
  });

  it("finds a look by its accent as well as by what it mostly is", () => {
    expect(found("white")).toEqual([12]);
  });

  it("finds a look by how big it is for its slot", () => {
    expect(found("large")).toEqual([11]);
  });

  // Every word has to match, which is what makes two of these worth typing together.
  it("reads the words beside the ones the game supplies", () => {
    expect(found("something blue")).toEqual([12]);
    expect(found("something purple")).toEqual([]);
  });

  it("leaves the list alone where nothing was measured", () => {
    expect(
      filterAppearances(looks, {
        kind: kindOf("armour-0"),
        search: "brown",
        klass: "",
      }),
    ).toHaveLength(0);
    expect(found("")).toEqual([11, 12]);
  });
});

describe("asking a wardrobe for one thing a look says", () => {
  const looks = [
    look({ appearanceId: 11, name: "Tideglass Crown" }),
    look({ appearanceId: 12, name: "Duskwoven Hood" }),
    // A colour in the name and another one in the artwork, which is the whole case for asking
    // under a key rather than typing the word and taking what comes.
    look({ appearanceId: 13, name: "Brownhide Cowl" }),
  ];
  const marks = indexMarks({
    marks: [
      {
        kind: "appearance",
        id: 11,
        favourite: false,
        tags: [
          { key: "faction", value: "horde" },
          { key: "wishlist", value: null },
        ],
      },
      {
        kind: "appearance",
        id: 12,
        favourite: false,
        tags: [{ key: "faction", value: "alliance" }],
      },
    ],
  });
  const measured = indexQualities({
    displayType: 0,
    build: "12.0.5.67823",
    sizeCuts: {},
    appearances: [
      { id: 11, primary: "#4a3b2c", size: "large" },
      { id: 12, primary: "#2060e0", accent: "#f6f6f6", size: "small" },
      { id: 13, primary: "#2060e0", size: "small" },
    ],
  });
  const found = (search: string): number[] =>
    filterAppearances(looks, {
      kind: kindOf("armour-0"),
      search,
      klass: "",
      marks: { filter: NO_MARK_FILTER, of: (id) => marks.of("appearance", id) },
      qualities: (id) => measured.of(id),
    }).map((one) => one.appearanceId);

  // Typing "brown" finds the look measured brown and the Brownhide Cowl beside it, and there
  // was no way at all to say which of the two was being asked about.
  it("tells the colour a look is from the colour its name happens to hold", () => {
    expect(found("brown")).toEqual([11, 13]);
    expect(found("colour:brown")).toEqual([11]);
  });

  it("finds a look by how big it was measured to be for its slot", () => {
    expect(found("size:large")).toEqual([11]);
  });

  it("finds a look by a tag the reader wrote against it", () => {
    expect(found("faction:horde")).toEqual([11]);
    expect(found("faction:alliance")).toEqual([12]);
  });

  // The picker beside the box holds one tag at a time, so a bare key is how a reader asks for
  // everything filed under one however they annotated it.
  it("takes a bare key as any value the reader filed under it", () => {
    expect(found("faction:")).toEqual([11, 12]);
  });

  // And a label is a key that was the whole of what the reader said, which is the example both
  // `terms.ts` and `markFacets` give for what a bare key is *for*. It is here because the facets
  // the game supplies drop the empty ones — a look the picker has no word for must not answer
  // `kind:` — and a label's value is empty on purpose, so a filter that dropped those alongside
  // them would leave a reader's own labels reachable only as a bare word.
  it("finds a look under a label the reader wrote no value against", () => {
    expect(found("wishlist:")).toEqual([11]);
  });

  it("asks the game's own words under a name too", () => {
    expect(found("slot:head")).toEqual([11, 12, 13]);
    expect(found("name:cowl")).toEqual([13]);
  });

  // Two questions at once, which is what the dropdown could never have been.
  it("narrows on every term together", () => {
    expect(found("colour:blue size:small")).toEqual([12, 13]);
    expect(found("colour:blue size:large")).toEqual([]);
  });

  it("reads a word beside a term", () => {
    expect(found("colour:blue duskwoven")).toEqual([12]);
    expect(found("colour:blue tideglass")).toEqual([]);
  });

  // An empty list is the wardrobe saying it holds no huge anything, which is true and is what
  // was asked — rather than the term being dropped as a typo and the list left alone.
  it("leaves an empty list for a term nothing carries", () => {
    expect(found("size:huge")).toEqual([]);
    expect(found("faction:alliance colour:brown")).toEqual([]);
  });

  it("asks what a thing held is rather than what number the game files it under", () => {
    const held = [weapon(15, { name: "Emberforge Dagger" }), weapon(10, { name: "Ashen Staff" })];
    const asked = (search: string): string[] =>
      filterAppearances(held, {
        kind: kindOf("held"),
        search,
        klass: "",
      }).map((one) => one.name);

    expect(asked("kind:dagger")).toEqual(["Emberforge Dagger"]);
    expect(asked("kind:staff")).toEqual(["Ashen Staff"]);
  });

  // A facet with nothing in it is left out rather than offered, which is what makes a bare
  // `kind:` the reader asking which of these the picker has a word for at all.
  it("answers a bare kind with only the looks the picker can name", () => {
    const held = [
      weapon(15, { name: "Emberforge Dagger" }),
      look({ appearanceId: 2, displayType: 11, classId: 19, subclassId: 9, name: "Oddity" }),
    ];
    const asked = filterAppearances(held, { kind: kindOf("held"), search: "kind:", klass: "" });

    expect(asked.map((one) => one.name)).toEqual(["Emberforge Dagger"]);
  });
});
