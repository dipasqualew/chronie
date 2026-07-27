import { describe, expect, it } from "vitest";
import { appearanceRows, appearanceSummary, iconIds, slotName } from "./transmogModal";
import type { TransmogAppearance, TransmogSetItemsPayload } from "./types";

/** One appearance with only the fields a test cares about spelled out. */
const appearance = (fields: Partial<TransmogAppearance> = {}): TransmogAppearance => ({
  modifiedAppearanceId: 71001,
  itemId: 30001,
  name: "Tideglass Crown",
  appearanceId: 80001,
  displayType: 0,
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

  // The definitions do not pin the weapon types down well enough to name one by one, so all
  // four read the same rather than four guesses at which is which.
  it.each<[number]>([[11], [12], [13], [15]])(
    "calls display type %i a weapon or shield",
    (displayType) => {
      expect(slotName(displayType)).toBe("Weapon or shield");
    },
  );

  // A slot from a patch newer than this build still has to render as something.
  it("says which slot it was when it cannot name one", () => {
    expect(slotName(14)).toBe("Slot 14");
    expect(slotName(99)).toBe("Slot 99");
  });
});

describe("appearanceRows", () => {
  it("names the slot an appearance fills and the item it came from", () => {
    expect(appearanceRows(payload([
      appearance({ displayType: 1, itemId: 30007, name: "Emberforge Pauldrons", hasModel: true }),
    ])))
      .toEqual([
        {
          slot: "Shoulder",
          label: "Emberforge Pauldrons",
          itemId: 30007,
          appearanceId: 80001,
          displayType: 1,
          displayInfoId: 900001,
          iconFileDataId: 130001,
          hasModel: true,
          withheld: false,
        },
      ]);
  });

  // An appearance the game encrypts arrives with nothing but the id the set named it by, and
  // its display type is zero for want of anything to read — which is the head slot, so
  // labelling it by slot would be inventing one.
  it("says nothing it cannot know about an appearance the game withholds", () => {
    const withheld = appearance({
      modifiedAppearanceId: 71012, itemId: 0, name: "", appearanceId: 0, iconFileDataId: 0,
    });
    expect(appearanceRows(payload([withheld])))
      .toEqual([
        {
          slot: "Unknown slot",
          label: "The game keeps this appearance encrypted",
          itemId: 0,
          appearanceId: 0,
          displayType: 0,
          displayInfoId: 900001,
          iconFileDataId: 0,
          hasModel: false,
          withheld: true,
        },
      ]);
  });

  // The card counts every appearance the set names, so the withheld one keeps its place in
  // the list rather than being dropped for being unnameable.
  it("keeps a withheld appearance in the order the backend sorted it into", () => {
    const rows = appearanceRows(payload(
      [appearance({ displayType: 2, itemId: 30011 }), appearance({ itemId: 0, appearanceId: 0 })],
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

describe("appearanceSummary", () => {
  it.each<[string, TransmogSetItemsPayload, string]>([
    ["one appearance", payload([appearance()]), "1 appearance"],
    ["several", payload([appearance(), appearance(), appearance()]), "3 appearances"],
    [
      "one of which the game withholds",
      payload([appearance(), appearance()], { readCount: 1, withheldCount: 1 }),
      "2 appearances · 1 the game keeps encrypted",
    ],
  ])("reads a set of %s", (_what, given, expected) => {
    expect(appearanceSummary(given)).toBe(expected);
  });

  // A set with nothing under it is the one case the count is not worth printing at all.
  it("says the game lists nothing rather than counting to zero", () => {
    expect(appearanceSummary(payload([]))).toBe("The game lists no appearances for this set.");
  });
});
