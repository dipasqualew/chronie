import { describe, expect, it } from "vitest";

import {
  filterCustomSets,
  piecesFrom,
  piecesInOrder,
  rowOf,
  rowsOf,
  savedSummary,
  setNamed,
} from "./customSets";
import { NO_MARK_FILTER } from "./marks";
import { NOTHING_ON, wear } from "./outfit";
import type { AppearanceRow } from "./transmogModal";
import type { CustomSet, CustomSetPiece, TransmogMark } from "./types";

/** A row with only what a test cares about spelled out. */
const row = (fields: Partial<AppearanceRow> = {}): AppearanceRow => ({
  slot: "Chest",
  label: "Robe of Tides",
  itemId: 2,
  appearanceId: 22,
  displayType: 3,
  inventoryType: 0,
  displayInfoId: 900_012,
  iconFileDataId: 130_001,
  hasModel: false,
  sources: [
    {
      label: "Robe of Tides",
      itemId: 2,
      modifiedAppearanceId: 22,
      inventoryType: 0,
      allowableClass: 0xffff,
      requiredLevel: 0,
      quality: 4,
      itemCount: 1,
    },
  ],
  liftsRestriction: false,
  withheld: false,
  ...fields,
});

const HELM = row({
  slot: "Head",
  label: "Crown of Tides",
  itemId: 1,
  appearanceId: 11,
  displayType: 0,
  displayInfoId: 900_001,
  hasModel: true,
});
const SWORD = row({
  slot: "One-hand",
  label: "Emberforge Blade",
  itemId: 3,
  appearanceId: 33,
  displayType: 11,
  inventoryType: 13,
  displayInfoId: 900_007,
  hasModel: true,
});

/** A stored piece with only what a test cares about spelled out. */
const piece = (fields: Partial<CustomSetPiece> = {}): CustomSetPiece => ({
  place: "armour-3",
  appearanceId: 22,
  itemId: 2,
  name: "Robe of Tides",
  displayType: 3,
  inventoryType: 0,
  displayInfoId: 900_012,
  iconFileDataId: 130_001,
  hasModel: false,
  ...fields,
});

const set = (fields: Partial<CustomSet> = {}): CustomSet => ({
  id: 1,
  name: "Horde look",
  createdAt: 2_100_000_000,
  updatedAt: 2_100_000_000,
  pieces: [piece()],
  ...fields,
});

describe("piecesFrom", () => {
  it("writes down every number the row it came from carried", () => {
    const outfit = wear(NOTHING_ON, HELM, "Tideglass Regalia");

    expect(piecesFrom(outfit)).toEqual([
      {
        place: "armour-0",
        appearanceId: 11,
        itemId: 1,
        name: "Crown of Tides",
        displayType: 0,
        inventoryType: 0,
        displayInfoId: 900_001,
        iconFileDataId: 130_001,
        hasModel: true,
      },
    ]);
  });

  // The place is the answer `outfit.ts` worked out and not the display type, which is the
  // whole reason it is stored: nothing about display type 11 says which hand holds it.
  it("keeps the place the outfit put a weapon in rather than its slot", () => {
    expect(piecesFrom(wear(NOTHING_ON, SWORD))[0]?.place).toBe("hand-right");
  });

  it("lists what she has on head downwards, whatever order it went on in", () => {
    const outfit = wear(wear(wear(NOTHING_ON, SWORD), row()), HELM);

    expect(piecesFrom(outfit).map((one) => one.place)).toEqual([
      "armour-0",
      "armour-3",
      "hand-right",
    ]);
  });

  it("has nothing to say about a character wearing nothing", () => {
    expect(piecesFrom(NOTHING_ON)).toEqual([]);
  });
});

describe("rowOf", () => {
  it("comes back as the row it was saved from", () => {
    const there = rowOf(piecesFrom(wear(NOTHING_ON, HELM))[0]!);

    // Everything the character is drawn from, the look is marked by, and the row is drawn as.
    expect(there).toMatchObject({
      slot: "Head",
      label: "Crown of Tides",
      itemId: 1,
      appearanceId: 11,
      displayType: 0,
      displayInfoId: 900_001,
      iconFileDataId: 130_001,
      hasModel: true,
      withheld: false,
    });
  });

  // The badge is the game's word for the place, the way every other row in this view reads —
  // and for a weapon that is a question only the inventory type answers.
  it.each<[string, number, number]>([
    ["Head", 0, 1],
    ["Chest", 3, 5],
    ["One-hand", 11, 13],
    ["Two-hand", 11, 17],
    ["Shield", 13, 14],
    ["Held in off hand", 15, 23],
  ])("names its slot %s", (slot, displayType, inventoryType) => {
    expect(rowOf(piece({ displayType, inventoryType })).slot).toBe(slot);
  });

  // The one invented value in the module, and the reason the list draws no class, level or
  // quality: what was saved is a look, and those are facts about the items behind one.
  it("claims nothing about the item beyond what was saved", () => {
    const one = rowOf(piece());

    expect(one.sources).toHaveLength(1);
    expect(one.sources[0]).toMatchObject({ allowableClass: 0xffff, itemCount: 1 });
    expect(one.liftsRestriction).toBe(false);
  });

  it("falls back to the id where the game gave the item no name", () => {
    expect(rowOf(piece({ name: "", itemId: 4200 })).label).toBe("Item 4200");
  });
});

describe("piecesInOrder", () => {
  // The database answers in its own order, and the body has one — which lives in `outfit.ts`
  // and is asked for rather than written down again here.
  it("puts a saved set's pieces in the order the body reads", () => {
    const saved = set({
      pieces: [
        piece({ place: "hand-right" }),
        piece({ place: "armour-6" }),
        piece({ place: "armour-0" }),
      ],
    });

    expect(piecesInOrder(saved).map((one) => one.place)).toEqual([
      "armour-0",
      "armour-6",
      "hand-right",
    ]);
  });

  // A set saved by a later Chronie that knew about a place this one does not: listed last
  // rather than dropped, because losing a piece silently is the worse of the two.
  it("keeps a place it has never heard of, at the end", () => {
    const saved = set({
      pieces: [piece({ place: "tail" }), piece({ place: "armour-0" })],
    });

    expect(piecesInOrder(saved).map((one) => one.place)).toEqual(["armour-0", "tail"]);
  });

  it("leaves the set it was given alone", () => {
    const saved = set({ pieces: [piece({ place: "hand-right" }), piece({ place: "armour-0" })] });
    piecesInOrder(saved);
    expect(saved.pieces.map((one) => one.place)).toEqual(["hand-right", "armour-0"]);
  });
});

describe("rowsOf", () => {
  it("is the pieces, in the body's order, as rows", () => {
    const saved = set({
      pieces: [piece({ place: "hand-right", name: "Emberforge Blade" }), piece()],
    });

    expect(rowsOf(saved).map((one) => one.label)).toEqual(["Robe of Tides", "Emberforge Blade"]);
  });
});

describe("filterCustomSets", () => {
  const HORDE = set({ id: 1, name: "Horde look" });
  const ALLIANCE = set({
    id: 2,
    name: "Alliance look",
    pieces: [piece({ name: "Crown of Tides" })],
  });
  const names = (sets: CustomSet[]): string[] => sets.map((one) => one.name);

  it("leaves every set alone when nothing is asked of it", () => {
    expect(names(filterCustomSets([HORDE, ALLIANCE], { search: "" }))).toEqual([
      "Horde look",
      "Alliance look",
    ]);
  });

  it("matches the name the reader chose", () => {
    expect(names(filterCustomSets([HORDE, ALLIANCE], { search: "horde" }))).toEqual(["Horde look"]);
  });

  // The thing neither browser beside this one can offer: somebody who remembers the piece and
  // not which of their sets it went into.
  it("matches what is in the set", () => {
    expect(names(filterCustomSets([HORDE, ALLIANCE], { search: "crown" }))).toEqual([
      "Alliance look",
    ]);
  });

  it("wants every word rather than the whole phrase", () => {
    expect(names(filterCustomSets([HORDE, ALLIANCE], { search: "alliance crown" }))).toEqual([
      "Alliance look",
    ]);
    expect(filterCustomSets([HORDE, ALLIANCE], { search: "horde crown" })).toEqual([]);
  });

  const starred: TransmogMark = { kind: "custom", id: 1, favourite: true, tags: [] };
  const tagged: TransmogMark = {
    kind: "custom",
    id: 2,
    favourite: false,
    tags: [{ key: "faction", value: "alliance" }],
  };
  const marks = (filter = NO_MARK_FILTER) => ({
    filter,
    of: (id: number) => [starred, tagged].find((mark) => mark.id === id),
  });

  it("narrows to what the reader starred", () => {
    expect(
      names(
        filterCustomSets([HORDE, ALLIANCE], {
          search: "",
          marks: marks({ favourite: true, tag: "" }),
        }),
      ),
    ).toEqual(["Horde look"]);
  });

  it("narrows to one tag", () => {
    expect(
      names(
        filterCustomSets([HORDE, ALLIANCE], {
          search: "",
          marks: marks({ favourite: false, tag: "faction" }),
        }),
      ),
    ).toEqual(["Alliance look"]);
  });

  // The same argument every search in this view makes: a word on the card is a word the reader
  // will type into the box, whether the game wrote it or they did.
  it("matches a word the reader filed it under", () => {
    expect(
      names(filterCustomSets([HORDE, ALLIANCE], { search: "alliance", marks: marks() })),
    ).toEqual(["Alliance look"]);
  });
});

describe("asking a saved set for one thing it says", () => {
  const HORDE = set({ id: 1, name: "Horde look" });
  const ALLIANCE = set({
    id: 2,
    name: "Alliance look",
    pieces: [piece({ name: "Crown of Tides" })],
  });
  const tagged: TransmogMark = {
    kind: "custom",
    id: 2,
    favourite: false,
    tags: [
      { key: "faction", value: "alliance" },
      { key: "wishlist", value: null },
    ],
  };
  const found = (search: string): string[] =>
    filterCustomSets([HORDE, ALLIANCE], {
      search,
      marks: { filter: NO_MARK_FILTER, of: (id) => (id === tagged.id ? tagged : undefined) },
    }).map((one) => one.name);

  // Two kinds of name on one card — the one the reader chose and the ones the game gave the
  // pieces — which the one flattened string this used to search could not tell apart.
  it("keeps what a set is called apart from what is in it", () => {
    expect(found("piece:crown")).toEqual(["Alliance look"]);
    expect(found("name:crown")).toEqual([]);
    expect(found("name:alliance")).toEqual(["Alliance look"]);
  });

  it("finds a saved set by a tag the reader wrote against it", () => {
    expect(found("faction:alliance")).toEqual(["Alliance look"]);
    expect(found("faction:horde")).toEqual([]);
  });

  it("takes a bare key as any value the reader filed under it", () => {
    expect(found("faction:")).toEqual(["Alliance look"]);
  });

  it("narrows on two terms together", () => {
    expect(found("faction:alliance piece:crown")).toEqual(["Alliance look"]);
    expect(found("faction:alliance piece:robe")).toEqual([]);
  });

  // Both sets hold something of the Tides, so the word beside the term is what picks one.
  it("reads a word beside a term", () => {
    expect(found("piece:tides alliance")).toEqual(["Alliance look"]);
    expect(found("piece:tides horde")).toEqual(["Horde look"]);
  });

  // The measured colours are not here and cannot be: what was saved is a body's worth of looks
  // out of several slots, and the store measures one look at a time.
  it("leaves an empty list for a term nothing carries", () => {
    expect(found("colour:brown")).toEqual([]);
  });
});

describe("savedSummary", () => {
  const NOW = 2_100_000_000;

  it.each<[number, string]>([
    [1, "1 piece · saved just now"],
    [2, "2 pieces · saved just now"],
  ])("counts %i", (count, said) => {
    const saved = set({
      updatedAt: NOW,
      pieces: Array.from({ length: count }, (_, at) => piece({ place: `armour-${at}` })),
    });
    expect(savedSummary(saved, NOW)).toBe(said);
  });

  // The last save rather than the first: a set saved over three times is three outfits, and
  // the reader is looking at the third.
  it("dates a set by when it was last saved over", () => {
    expect(savedSummary(set({ createdAt: NOW - 864_000, updatedAt: NOW - 86_400 }), NOW)).toBe(
      "1 piece · saved yesterday",
    );
  });
});

describe("setNamed", () => {
  const SETS = [set({ id: 1, name: "Horde look" }), set({ id: 2, name: "Alliance look" })];

  it.each<[string, string]>([
    ["the name as saved", "Horde look"],
    ["another case of it", "horde LOOK"],
    ["a name typed with stray whitespace", "  Horde   look  "],
  ])("finds the set behind %s", (_what, typed) => {
    expect(setNamed(SETS, typed)?.id).toBe(1);
  });

  it.each<[string, string]>([
    ["a name nobody has used", "Nightborne"],
    ["nothing at all", ""],
    ["only whitespace", "   "],
  ])("finds nothing for %s", (_what, typed) => {
    expect(setNamed(SETS, typed)).toBeUndefined();
  });
});
