import { describe, expect, it } from "vitest";
import type { AppearanceRow } from "./transmogModal";
import {
  ANY_CLASS, appearanceRows, appearanceSummary, heldIn, iconIds, isHeld, qualityLabel, slotName,
  varyingFacts, wearerLabel,
} from "./transmogModal";
import type { TransmogAppearance, TransmogSetItemsPayload } from "./types";

/** One appearance with only the fields a test cares about spelled out. */
const appearance = (fields: Partial<TransmogAppearance> = {}): TransmogAppearance => ({
  modifiedAppearanceId: 71001,
  itemId: 30001,
  name: "Tideglass Crown",
  appearanceId: 80001,
  displayType: 0,
  inventoryType: 1,
  allowableClass: ANY_CLASS,
  requiredLevel: 0,
  quality: 4,
  displayInfoId: 900001,
  iconFileDataId: 130001,
  hasModel: false,
  ...fields,
});

/**
 * A payload the backend could have answered with. `readCount` and `withheldCount` are given
 * rather than derived, because the backend counts them and the rows are drawn from what it
 * said as much as from the list itself.
 */
const payload = (
  appearances: TransmogAppearance[],
  counts: Partial<Pick<TransmogSetItemsPayload, "readCount" | "withheldCount">> = {},
): TransmogSetItemsPayload => ({
  setId: 201,
  appearances,
  readCount: appearances.length,
  withheldCount: 0,
  ...counts,
});

/**
 * Several items reaching one look, which is the case a row exists to collapse.
 *
 * Each gets an `ItemModifiedAppearance` of its own, because that is what the game makes a
 * source distinct by, and an item id of its own, because that is what the link out uses.
 */
const oneLook = (items: Array<Partial<TransmogAppearance>>): TransmogSetItemsPayload =>
  payload(items.map((fields, index) => appearance({
    modifiedAppearanceId: 71001 + index,
    itemId: 30001 + index,
    appearanceId: 80001,
    ...fields,
  })));

/** The single row a set of items reaching one look comes to. */
const lookRow = (items: Array<Partial<TransmogAppearance>>, setName = ""): AppearanceRow =>
  appearanceRows(oneLook(items), setName)[0]!;

describe("slotName", () => {
  // The eleven armour slots as an install numbers them, which is not as the community's list
  // does: a shirt is 2, and everything from the chest down sits one higher than that list says.
  it.each<[number, string]>([
    [0, "Head"],
    [1, "Shoulder"],
    [2, "Shirt"],
    [3, "Chest"],
    [4, "Waist"],
    [5, "Legs"],
    [6, "Feet"],
    [7, "Wrist"],
    [8, "Hands"],
    [9, "Back"],
    [10, "Tabard"],
  ])("reads display type %i as the %s slot", (displayType, expected) => {
    expect(slotName(displayType)).toBe(expected);
  });

  // The display type gets a weapon as far as "a weapon" and no further: 11 is a one-hander
  // and a two-hander alike, and 15 covers a shield's neighbours. Where the item is worn is
  // what names it, and it comes from a different table entirely.
  it.each<[number, number, string]>([
    [11, 13, "One-hand"],
    [11, 17, "Two-hand"],
    [11, 21, "Main hand"],
    [11, 22, "Off hand"],
    [13, 14, "Shield"],
    [15, 23, "Held in off hand"],
    [12, 15, "Ranged"],
    [12, 25, "Thrown"],
    [14, 24, "Ammo"],
  ])("names display type %i worn at %i the %s slot", (displayType, inventoryType, expected) => {
    expect(slotName(displayType, inventoryType)).toBe(expected);
  });

  // And where the game says nothing — an item it withholds — the old sentence is what is
  // left, because it is still true and a guess would not be.
  it("calls a weapon the game says nothing about a weapon or shield", () => {
    for (const displayType of [11, 12, 13, 15]) {
      expect(slotName(displayType, 0)).toBe("Weapon or shield");
      expect(slotName(displayType)).toBe("Weapon or shield");
    }
  });

  // A slot from a patch newer than this build still has to render as something.
  it("says which slot it was when it cannot name one", () => {
    expect(slotName(16, 0)).toBe("Slot 16");
    expect(slotName(99, 13)).toBe("Slot 99");
  });
});

describe("heldIn", () => {
  // The hand is the *place* rather than the item, which is what a wardrobe needs: a one-hander
  // and a two-hander are the same hand and cannot both be held, and a shield and an off-hand
  // are the other one.
  it.each<[string, number, number, "right" | "left" | null]>([
    ["a one-hander", 11, 13, "right"],
    ["a two-hander", 11, 17, "right"],
    ["a main hand", 11, 21, "right"],
    ["an off hand", 11, 22, "left"],
    ["a shield", 13, 14, "left"],
    ["something held in the other hand", 15, 23, "left"],
    ["a bow", 12, 15, "left"],
    ["a gun", 12, 26, "right"],
    // Arrows are filed under a weapon slot and nobody holds them, and an item the game
    // withholds arrives with nothing to say where it goes.
    ["arrows", 14, 24, null],
    ["a weapon the game withholds", 11, 0, null],
    ["a helm", 0, 1, null],
    ["a chestpiece", 3, 5, null],
  ])("puts %s in the %s hand", (_what, displayType, inventoryType, expected) => {
    expect(heldIn(displayType, inventoryType)).toBe(expected);
    expect(isHeld(displayType, inventoryType)).toBe(expected !== null);
  });
});

describe("appearanceRows", () => {
  it("names the slot an appearance fills and the item it came from", () => {
    expect(appearanceRows(payload([
      appearance({
        modifiedAppearanceId: 71007, displayType: 1, inventoryType: 3, itemId: 30007,
        name: "Emberforge Pauldrons", hasModel: true,
      }),
    ])))
      .toEqual([
        {
          slot: "Shoulder",
          label: "Emberforge Pauldrons",
          itemId: 30007,
          appearanceId: 80001,
          displayType: 1,
          inventoryType: 3,
          displayInfoId: 900001,
          iconFileDataId: 130001,
          hasModel: true,
          withheld: false,
          sources: [
            {
              label: "Emberforge Pauldrons",
              itemId: 30007,
              modifiedAppearanceId: 71007,
              inventoryType: 3,
              allowableClass: ANY_CLASS,
              requiredLevel: 0,
              quality: 4,
            },
          ],
          liftsRestriction: false,
        },
      ]);
  });

  // The whole point of the module: the game sells one look through as many items as it likes,
  // `TransmogSetItem` names every one of them, and a row is a look. A set of 126 rows is a set
  // of 11 looks, and the items are not lost by it — they are the sources one click further in.
  it("draws one row per look however many items reach it", () => {
    const rows = appearanceRows(payload([
      appearance({
        modifiedAppearanceId: 71020, itemId: 30020, name: "Stormforged Helm",
        appearanceId: 80020, allowableClass: 0b1, requiredLevel: 60,
      }),
      appearance({
        modifiedAppearanceId: 71021, itemId: 30021, name: "Stormforged Greathelm",
        appearanceId: 80020, requiredLevel: 60,
      }),
      appearance({
        modifiedAppearanceId: 71022, itemId: 30022, name: "Helm of the Tempest",
        appearanceId: 80020, requiredLevel: 45, quality: 3,
      }),
      appearance({
        modifiedAppearanceId: 71023, itemId: 30023, name: "Stormforged Breastplate",
        appearanceId: 80023, displayType: 3, inventoryType: 5,
      }),
    ]));

    expect(rows.map((row) => row.appearanceId)).toEqual([80020, 80023]);
    expect(rows[0]!.sources.map((source) => source.itemId)).toEqual([30022, 30021, 30020]);
    expect(rows[1]!.sources.map((source) => source.itemId)).toEqual([30023]);
  });

  // The game stores a set's fourteenth appearance as a copy of its first, so the backend
  // answers the same `ItemModifiedAppearance` twice — but one item named twice is one item,
  // and listing it twice under the look would be the app inventing a way to get it.
  it("counts an item the set names twice as one source", () => {
    const rows = appearanceRows(payload([
      appearance({ modifiedAppearanceId: 71001, itemId: 30001 }),
      appearance({ modifiedAppearanceId: 71001, itemId: 30001 }),
      appearance({ modifiedAppearanceId: 71002, itemId: 30002, name: "Tideglass Mantle" }),
    ]));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources.map((source) => source.modifiedAppearanceId)).toEqual([71001, 71002]);
  });

  // The backend sorted the set into the order it did for a reason, and a look that turns up
  // again later belongs where it was first seen rather than at the bottom.
  it("keeps the rows in the order the backend sorted them into", () => {
    const rows = appearanceRows(payload([
      appearance({ modifiedAppearanceId: 71005, itemId: 30005, appearanceId: 80005, displayType: 5 }),
      appearance({ modifiedAppearanceId: 71000, itemId: 30000, appearanceId: 80000 }),
      appearance({ modifiedAppearanceId: 71015, itemId: 30015, appearanceId: 80005, displayType: 5 }),
    ]));

    expect(rows.map((row) => row.appearanceId)).toEqual([80005, 80000]);
    expect(rows[0]!.sources).toHaveLength(2);
  });

  // An appearance the game encrypts arrives with nothing but the id the set named it by, and
  // its display type is zero for want of anything to read — which is the head slot, so
  // labelling it by slot would be inventing one.
  it("says nothing it cannot know about an appearance the game withholds", () => {
    const withheld = appearance({
      modifiedAppearanceId: 71012, itemId: 0, name: "", appearanceId: 0, iconFileDataId: 0,
      inventoryType: 0, allowableClass: 0, quality: 0,
    });
    expect(appearanceRows(payload([withheld])))
      .toEqual([
        {
          slot: "Unknown slot",
          label: "The game keeps this appearance encrypted",
          itemId: 0,
          appearanceId: 0,
          displayType: 0,
          inventoryType: 0,
          displayInfoId: 900001,
          iconFileDataId: 0,
          hasModel: false,
          withheld: true,
          sources: [
            {
              label: "Item 0",
              itemId: 0,
              modifiedAppearanceId: 71012,
              inventoryType: 0,
              allowableClass: 0,
              requiredLevel: 0,
              quality: 0,
            },
          ],
          liftsRestriction: false,
        },
      ]);
  });

  // Two withheld appearances share an appearance id of zero and are not thereby the same look
  // — nothing is known about either. Collapsing them would hide one behind the other, and the
  // set's count includes both, so the list would be shorter than the card promised.
  it("does not collapse two withheld appearances into one row", () => {
    const rows = appearanceRows(payload(
      [
        appearance({ modifiedAppearanceId: 71012, itemId: 0, name: "", appearanceId: 0 }),
        appearance({ modifiedAppearanceId: 71014, itemId: 0, name: "", appearanceId: 0 }),
      ],
      { readCount: 0, withheldCount: 2 },
    ));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.label))
      .toEqual(["The game keeps this appearance encrypted", "The game keeps this appearance encrypted"]);
    expect(rows.map((row) => row.withheld)).toEqual([true, true]);
  });

  // Where an item is worn comes out of `ItemSparse` and so belongs to the item rather than to
  // the look, and two items giving one look can disagree about it — most often because the
  // game encrypts one of them and its row reads zero. The name, the link out and the place
  // all have to come off the same item, or the row claims one item's slot under another
  // item's name and `outfit.ts` holds it in a hand nothing said it went in.
  it("takes the slot from the item it took the name from", () => {
    const row = lookRow(
      [
        // Listed first and withheld, so its slot reads as nothing at all.
        { modifiedAppearanceId: 71030, itemId: 30030, name: "", displayType: 11, inventoryType: 0 },
        { modifiedAppearanceId: 71031, itemId: 30031, name: "Tideglass Edge", displayType: 11, inventoryType: 17 },
      ],
      "Tideglass Regalia",
    );

    expect(row.label).toBe("Tideglass Edge");
    expect(row.itemId).toBe(30031);
    expect(row.inventoryType).toBe(17);
    expect(row.slot).toBe("Two-hand");
  });

  // The card counts every appearance the set names, so the withheld one keeps its place in
  // the list rather than being dropped for being unnameable.
  it("keeps a withheld appearance in the order the backend sorted it into", () => {
    const rows = appearanceRows(payload(
      [
        appearance({ modifiedAppearanceId: 71011, displayType: 2, itemId: 30011 }),
        appearance({ modifiedAppearanceId: 71012, itemId: 0, name: "", appearanceId: 0 }),
      ],
      { readCount: 1, withheldCount: 1 },
    ));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.withheld)).toEqual([false, true]);
  });

  // The game holds a row for the item and no name in it, or holds no row this install can
  // read. Either way the row is worth drawing, and the id is what a reader can act on: it is
  // what the link out of the app is addressed by.
  it("falls back to the item's id when the game names it nothing", () => {
    const rows = appearanceRows(payload([appearance({ itemId: 30013, name: "" })]));
    expect(rows.map((row) => row.label)).toEqual(["Item 30013"]);
  });

  it("has no rows to draw for a set the game lists nothing for", () => {
    expect(appearanceRows(payload([]))).toEqual([]);
  });
});

describe("appearanceRows naming", () => {
  // The items disagree about what to call themselves nine times out of ten, so something has
  // to choose, and the rule is the name closest to the set's own. The tier helm and the world
  // drop wearing its slot is the case that rules out picking the commonest name.
  it.each<[string, string, Array<[number, string]>, string]>([
    [
      "the set's own piece over a world drop wearing its slot",
      "Regalia of Celestial Harmony",
      [[30001, "Headpiece of Celestial Harmony"], [30002, "Crown of Tragic Truth"]],
      "Headpiece of Celestial Harmony",
    ],
    [
      // "of" and "the" are in every second name in the game and so tell two items apart never.
      "the one word that is not in every name in the game",
      "Vestments of the Fallen",
      [[30003, "Robes of the Sun"], [30009, "Fallen Shoulderpads"]],
      "Fallen Shoulderpads",
    ],
    [
      "the oldest item where two names are equally close",
      "Tideglass Regalia",
      [[30005, "Tideglass Crown"], [30002, "Tideglass Cowl"]],
      "Tideglass Cowl",
    ],
    [
      // Nothing to be close to leaves the tie-break holding the whole decision, which is the
      // oldest item — the piece the set was built around rather than what was hung off it.
      "the oldest item where the set has no name to match",
      "",
      [[30008, "Cowl of the Tempest"], [30004, "Stormforged Helm"]],
      "Stormforged Helm",
    ],
  ])("names a row after %s", (_what, setName, items, expected) => {
    const named = items.map(([itemId, name]) => ({ itemId, name }));
    expect(lookRow(named, setName).label).toBe(expected);
  });

  // The name and the id have to come from the same item, because the row's link out is
  // addressed by the id and a link to a differently named item reads as the wrong item.
  it("links out to the item it named the row after", () => {
    const row = lookRow(
      [
        { itemId: 30001, name: "Headpiece of Celestial Harmony" },
        { itemId: 30002, name: "Crown of Tragic Truth" },
      ],
      "Regalia of Celestial Harmony",
    );
    expect(row).toMatchObject({ label: "Headpiece of Celestial Harmony", itemId: 30001 });
  });
});

describe("appearanceRows source order", () => {
  // The reader opening this list is asking whether they can have the look at all, so whatever
  // anybody can wear comes first; then the cheapest way in; then the id, so that the order
  // never depends on how the backend happened to sort.
  it.each<[string, Array<Partial<TransmogAppearance>>, number[]]>([
    [
      "what anybody can wear before what a class is locked to",
      [
        { itemId: 30020, allowableClass: 0b1 },
        { itemId: 30021, allowableClass: ANY_CLASS },
      ],
      [30021, 30020],
    ],
    [
      "the lowest level two items can both be worn at",
      [
        { itemId: 30020, requiredLevel: 60 },
        { itemId: 30021, requiredLevel: 45 },
      ],
      [30021, 30020],
    ],
    [
      "the oldest item where nothing else separates them",
      [
        { itemId: 30030 },
        { itemId: 30020 },
      ],
      [30020, 30030],
    ],
    [
      "the open item first even when it is dearer and newer",
      [
        { itemId: 30020, allowableClass: 0b1, requiredLevel: 10 },
        { itemId: 30099, allowableClass: ANY_CLASS, requiredLevel: 60 },
      ],
      [30099, 30020],
    ],
  ])("lists %s", (_what, items, expected) => {
    expect(lookRow(items).sources.map((source) => source.itemId)).toEqual(expected);
  });
});

describe("appearanceRows liftsRestriction", () => {
  // The single most useful thing this view can say and the one no amount of scrolling makes
  // visible: a reader locked out of the set's own piece by their class is not locked out of
  // the look. It takes both halves — an open item and a locked one — to be worth saying.
  it.each<[string, number[], boolean]>([
    ["a class-locked item and an open one", [0b1, ANY_CLASS], true],
    ["a class-locked item alone", [0b1], false],
    ["two class-locked items and nothing open", [0b1, 0b10], false],
    ["an open item alone", [ANY_CLASS], false],
    ["nothing but open items", [ANY_CLASS, ANY_CLASS], false],
    // Zero is what an item the game withholds carries, and nobody is locked out by a fact
    // this install could not read — counting it would announce a restriction that is not there.
    ["an open item and one the game withholds", [ANY_CLASS, 0], false],
    ["an open item, a withheld one and a class-locked one", [ANY_CLASS, 0, 0b1], true],
  ])("says a look is reachable another way for %s", (_what, classes, expected) => {
    const items = classes.map((allowableClass) => ({ allowableClass }));
    expect(lookRow(items).liftsRestriction).toBe(expected);
  });
});

describe("varyingFacts", () => {
  // Half of all multi-item appearances differ by nothing but their names, and a class, a level
  // and a quality drawn identically against each of five items is five lines saying nothing.
  it.each<[string, Partial<TransmogAppearance>, Record<string, boolean>]>([
    [
      "nothing but their names",
      { name: "Crown of Tragic Truth" },
      { allowableClass: false, requiredLevel: false, quality: false },
    ],
    [
      "who may wear them",
      { allowableClass: 0b1 },
      { allowableClass: true, requiredLevel: false, quality: false },
    ],
    [
      "what it takes to wear them",
      { requiredLevel: 45 },
      { allowableClass: false, requiredLevel: true, quality: false },
    ],
    [
      "what the game writes them in",
      { quality: 3 },
      { allowableClass: false, requiredLevel: false, quality: true },
    ],
    [
      "all three at once",
      { allowableClass: 0b1, requiredLevel: 45, quality: 3 },
      { allowableClass: true, requiredLevel: true, quality: true },
    ],
  ])("draws a column for two items differing by %s", (_what, second, expected) => {
    expect(varyingFacts(lookRow([{}, second]))).toEqual(expected);
  });

  // A little under half of the game's appearances are reached by one item, and one item
  // disagrees with nothing.
  it("draws no columns for a look only one item reaches", () => {
    expect(varyingFacts(lookRow([{}])))
      .toEqual({ allowableClass: false, requiredLevel: false, quality: false });
  });
});

describe("appearanceSummary", () => {
  // Both numbers, because they are both true and they disagree for 65% of the sets in the
  // game: the card above counted items and the list below holds looks. It is the sentence
  // that explains why a set of five items opened as a list of two.
  it.each<[string, TransmogSetItemsPayload, string]>([
    ["one appearance", payload([appearance()]), "1 appearance"],
    [
      "several, one item each",
      payload([
        appearance({ modifiedAppearanceId: 71001, appearanceId: 80001 }),
        appearance({ modifiedAppearanceId: 71002, appearanceId: 80002 }),
        appearance({ modifiedAppearanceId: 71003, appearanceId: 80003 }),
      ]),
      "3 appearances",
    ],
    [
      "five items over two looks",
      payload([
        appearance({ modifiedAppearanceId: 71020, itemId: 30020, appearanceId: 80020 }),
        appearance({ modifiedAppearanceId: 71021, itemId: 30021, appearanceId: 80020 }),
        appearance({ modifiedAppearanceId: 71022, itemId: 30022, appearanceId: 80020 }),
        appearance({ modifiedAppearanceId: 71023, itemId: 30023, appearanceId: 80023 }),
        appearance({ modifiedAppearanceId: 71024, itemId: 30024, appearanceId: 80023 }),
      ]),
      "2 appearances from 5 items",
    ],
    [
      "one the game withholds",
      payload(
        [
          appearance({ modifiedAppearanceId: 71011 }),
          appearance({ modifiedAppearanceId: 71012, itemId: 0, name: "", appearanceId: 0 }),
        ],
        { readCount: 1, withheldCount: 1 },
      ),
      "2 appearances · 1 the game keeps encrypted",
    ],
  ])("reads a set of %s", (_what, given, expected) => {
    expect(appearanceSummary(appearanceRows(given), given)).toBe(expected);
  });

  // A set with nothing under it is the one case the count is not worth printing at all.
  it("says the game lists nothing rather than counting to zero", () => {
    const empty = payload([]);
    expect(appearanceSummary(appearanceRows(empty), empty))
      .toBe("The game lists no appearances for this set.");
  });
});

describe("wearerLabel", () => {
  // An item open to everybody is stored as a signed 16-bit -1 and arrives as 0xffff, where a
  // set open to everybody is stored as zero — and zero is also what an item the game withholds
  // carries. All three want the same sentence.
  it.each<[string, number, string]>([
    ["an item anybody may wear", ANY_CLASS, "Any class"],
    ["an item the game withholds", 0, "Any class"],
    ["a mask with every class set", 0x1fff, "Any class"],
    ["the three cloth classes", 0x0190, "Cloth"],
    ["the leather classes", 0x0e08, "Leather"],
    ["the mail classes", 0x1044, "Mail"],
    ["the plate classes", 0x0023, "Plate"],
    ["one class", 0b1, "Warrior"],
    ["two classes", 0b11, "Warrior & Paladin"],
    ["more classes than are worth naming", 0b1011, "3 classes"],
  ])("says who may wear %s", (_what, mask, expected) => {
    expect(wearerLabel(mask)).toBe(expected);
  });
});

describe("qualityLabel", () => {
  it.each<[number, string]>([
    [0, "Poor"],
    [1, "Common"],
    [2, "Uncommon"],
    [3, "Rare"],
    [4, "Epic"],
    [5, "Legendary"],
    [6, "Artifact"],
    [7, "Heirloom"],
  ])("calls quality %i %s", (quality, expected) => {
    expect(qualityLabel(quality)).toBe(expected);
  });

  // A colour from a patch newer than this build still has to render as something.
  it("says which quality it was when it cannot name one", () => {
    expect(qualityLabel(9)).toBe("Quality 9");
  });
});

describe("iconIds", () => {
  // Every read of the game's storage costs a couple of hundred megabytes of transient memory,
  // so a set that names one texture four times has to ask for it once.
  it.each<[string, number[], number[]]>([
    ["one per appearance", [130001, 130002, 130003], [130001, 130002, 130003]],
    ["the same appearance listed twice", [130001, 130001, 130002], [130001, 130002]],
    ["two slots sharing a picture", [130004, 130002, 130004], [130004, 130002]],
    // Zero is what an appearance the tables give no icon carries, and what the game
    // withholds outright comes across the same way. Neither is a file to go looking for.
    ["appearances the game gives no icon", [0, 130001, 0], [130001]],
    ["nothing at all", [], []],
  ])("asks for the textures of a set naming %s", (_what, icons, expected) => {
    const appearances = icons.map((iconFileDataId) => appearance({ iconFileDataId }));
    expect(iconIds(payload(appearances))).toEqual(expected);
  });
});
