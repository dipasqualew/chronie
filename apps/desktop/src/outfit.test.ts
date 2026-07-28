import { describe, expect, it } from "vitest";

import {
  NOTHING_ON, isWorn, onlyWearable, outfitSummary, piecesOf, placeName, placeOf, takeOff, toggle,
  wear, wearSet, wearable, wornPieces,
} from "./outfit";
import type { AppearanceRow } from "./transmogModal";
import type { TransmogSet } from "./types";

/** A row with only the fields a test cares about spelled out. */
const row = (fields: Partial<AppearanceRow> = {}): AppearanceRow => ({
  slot: "Chest",
  label: "Something",
  itemId: 1,
  appearanceId: 1,
  displayType: 3,
  inventoryType: 0,
  displayInfoId: 100,
  iconFileDataId: 0,
  hasModel: false,
  sources: [{
    label: "Something", itemId: 1, modifiedAppearanceId: 1, inventoryType: 0,
    allowableClass: 0xffff, requiredLevel: 0, quality: 4, itemCount: 1,
  }],
  liftsRestriction: false,
  withheld: false,
  ...fields,
});

const someSet = (fields: Partial<TransmogSet> = {}): TransmogSet => ({
  id: 7,
  name: "Tideglass Regalia",
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

/** The three appearances the rules below are actually about. */
const HELM = row({ displayType: 0, displayInfoId: 900_001, label: "A helm" });
const ROBE = row({ displayType: 3, displayInfoId: 900_012, label: "A robe" });
const SWORD = row({ displayType: 11, inventoryType: 13, displayInfoId: 900_007, label: "A sword" });

describe("placeOf", () => {
  // The armour slots are the one case where the place and the kind of item coincide: the game
  // files a helm under the head and the head is where it goes.
  it.each<[string, number]>([
    ["head", 0], ["shoulder", 1], ["shirt", 2], ["chest", 3], ["waist", 4], ["legs", 5],
    ["feet", 6], ["wrist", 7], ["hands", 8], ["back", 9], ["tabard", 10],
  ])("puts a %s appearance in the slot the game files it under", (_what, displayType) => {
    expect(placeOf(row({ displayType }))).toBe(`armour-${displayType}`);
  });

  // And the case where they come apart, which is the whole reason a place is not a slot. Four
  // display types cover every weapon and shield in the game and distinguish none of them; the
  // hand comes from the item, and the hand is the place.
  it.each<[string, number, string]>([
    ["a one-hander", 13, "hand-right"],
    ["a two-hander", 17, "hand-right"],
    ["a main hand", 21, "hand-right"],
    ["a shield", 14, "hand-left"],
    ["an off hand", 22, "hand-left"],
    ["something held in the off hand", 23, "hand-left"],
  ])("puts %s in the hand the game says it is held in", (_what, inventoryType, place) => {
    expect(placeOf(row({ displayType: 11, inventoryType }))).toBe(place);
  });

  // Two ways there is nowhere to put something, and neither is this app failing: the game
  // encrypts what it has not shipped, and it files arrows under a weapon slot nobody holds.
  it.each<[string, Partial<AppearanceRow>]>([
    ["an appearance the game withholds", { withheld: true }],
    ["ammunition, which no hand holds", { displayType: 11, inventoryType: 24 }],
    ["a weapon the game says no inventory type for", { displayType: 11, inventoryType: 0 }],
    ["a slot past the ones this build knows", { displayType: 40 }],
  ])("has nowhere to put %s", (_what, fields) => {
    expect(placeOf(row(fields))).toBeNull();
    expect(wearable(row(fields))).toBe(false);
  });
});

describe("onlyWearable", () => {
  // The two the game itself has nothing to put anywhere, in among the pieces they cannot be
  // worn beside. Both are dead weight in a list a reader is clicking down — a disabled button
  // and a sentence apologising for it — which is why the browser leaves them out by default.
  it("drops the rows there is nowhere on her to put, and keeps the rest in the set's order", () => {
    const arrows = row({ displayType: 11, inventoryType: 24, label: "A quiver of arrows" });
    const encrypted = row({ withheld: true, label: "Something the game encrypts" });
    expect(onlyWearable([HELM, arrows, ROBE, encrypted, SWORD]).map((kept) => kept.label))
      .toEqual(["A helm", "A robe", "A sword"]);
  });

  // Which is nearly every set there is: on 12.0.5.67823 three rows in the whole game have no
  // place against the 72,141 the sets name, so hiding must cost an ordinary set nothing.
  it("leaves a set with a place for everything exactly as it was", () => {
    expect(onlyWearable([HELM, ROBE, SWORD])).toEqual([HELM, ROBE, SWORD]);
  });
});

describe("placeName", () => {
  it("names an armour slot the way the row already does", () => {
    expect(placeName("armour-0")).toBe("Head");
    expect(placeName("armour-10")).toBe("Tabard");
  });

  // No display type names a hand, so these two are named here or nowhere.
  it("names the two hands, which no display type does", () => {
    expect(placeName("hand-right")).toBe("Main hand");
    expect(placeName("hand-left")).toBe("Off hand");
  });
});

describe("wear", () => {
  it("puts an appearance on, and says which set it came out of", () => {
    const outfit = wear(NOTHING_ON, HELM, someSet());
    expect(wornPieces(outfit)).toEqual([
      { place: "armour-0", row: HELM, setId: 7, setName: "Tideglass Regalia" },
    ]);
  });

  // The point of the whole module: pieces come out of whichever set the reader was looking at,
  // and they all end up on the same body.
  it("keeps pieces taken out of different sets at once", () => {
    const outfit = wear(
      wear(NOTHING_ON, HELM, someSet({ id: 1, name: "One" })),
      ROBE,
      someSet({ id: 2, name: "Two" }),
    );
    expect(wornPieces(outfit).map((piece) => piece.setName)).toEqual(["One", "Two"]);
  });

  // A second helm cannot go on over the first. A reader clicking down a set trying hats
  // expects each one to be *the* hat.
  it("replaces whatever was already in that place", () => {
    const other = row({ displayType: 0, displayInfoId: 900_099, label: "Another helm" });
    const outfit = wear(wear(NOTHING_ON, HELM, someSet()), other, someSet());
    expect(wornPieces(outfit)).toHaveLength(1);
    expect(wornPieces(outfit)[0]?.row.label).toBe("Another helm");
  });

  // And the same rule where the place and the slot do not coincide: a two-hander is a
  // different item from a one-hander and the same right hand, so it takes it.
  it("treats the hand as the place, so a two-hander takes the one-hander's hand", () => {
    const twoHander = row({ displayType: 11, inventoryType: 17, displayInfoId: 900_014 });
    const outfit = wear(wear(NOTHING_ON, SWORD, someSet()), twoHander, someSet());
    expect(wornPieces(outfit)).toHaveLength(1);
    expect(wornPieces(outfit)[0]?.row.displayInfoId).toBe(900_014);
  });

  // A shield is the other hand, so the two coexist rather than replacing each other.
  it("leaves the other hand alone", () => {
    const shield = row({ displayType: 13, inventoryType: 14, displayInfoId: 900_015 });
    const outfit = wear(wear(NOTHING_ON, SWORD, someSet()), shield, someSet());
    expect(wornPieces(outfit)).toHaveLength(2);
  });

  it("leaves the outfit alone for an appearance with nowhere to go", () => {
    const nowhere = row({ withheld: true });
    expect(wear(NOTHING_ON, nowhere, someSet())).toBe(NOTHING_ON);
  });

  // State that is replaced rather than mutated, because the panel redraws on the identity.
  it("answers with a new outfit and leaves the old one as it was", () => {
    const before = wear(NOTHING_ON, HELM, someSet());
    const after = wear(before, ROBE, someSet());
    expect(wornPieces(before)).toHaveLength(1);
    expect(after).not.toBe(before);
  });
});

describe("takeOff", () => {
  it("takes one piece off and leaves the rest on", () => {
    const outfit = wear(wear(NOTHING_ON, HELM, someSet()), ROBE, someSet());
    expect(wornPieces(takeOff(outfit, "armour-0")).map((piece) => piece.place)).toEqual(["armour-3"]);
  });

  it("leaves an outfit that has nothing in that place exactly as it was", () => {
    const outfit = wear(NOTHING_ON, HELM, someSet());
    expect(takeOff(outfit, "hand-left")).toBe(outfit);
  });
});

describe("wornPieces", () => {
  // Head downwards, which is not the order the reader put them on in and not the order the
  // backend paints them in either.
  it("reads down the body whatever order the pieces went on in", () => {
    const boots = row({ displayType: 6, displayInfoId: 900_004 });
    let outfit = wear(NOTHING_ON, SWORD, someSet());
    outfit = wear(outfit, boots, someSet());
    outfit = wear(outfit, HELM, someSet());
    expect(wornPieces(outfit).map((piece) => piece.place))
      .toEqual(["armour-0", "armour-6", "hand-right"]);
  });
});

describe("isWorn", () => {
  // By the display rather than by the row, because a collection's tier variants share most of
  // their pieces: the robe put on from one set is still the robe when found in its neighbour.
  it("marks the same appearance found in another set as the one that is on", () => {
    const outfit = wear(NOTHING_ON, ROBE, someSet({ id: 1 }));
    const elsewhere = row({ ...ROBE, appearanceId: 55, itemId: 999 });
    expect(isWorn(outfit, elsewhere)).toBe(true);
  });

  it("does not mark a different appearance in the same place", () => {
    const outfit = wear(NOTHING_ON, ROBE, someSet());
    expect(isWorn(outfit, row({ displayType: 3, displayInfoId: 900_003 }))).toBe(false);
  });

  it("does not mark an appearance that could never go on", () => {
    expect(isWorn(wear(NOTHING_ON, ROBE, someSet()), row({ withheld: true }))).toBe(false);
  });
});

describe("toggle", () => {
  // Clicking a row a second time is how a reader takes one piece off without going to the
  // list beside the character.
  it("puts an appearance on, and takes the same one off again", () => {
    const on = toggle(NOTHING_ON, HELM, someSet());
    expect(wornPieces(on)).toHaveLength(1);
    expect(wornPieces(toggle(on, HELM, someSet()))).toHaveLength(0);
  });

  // A different helm is not the one being worn, so clicking it swaps rather than undressing.
  it("swaps when the thing clicked is not the one already in that place", () => {
    const other = row({ displayType: 0, displayInfoId: 900_099, label: "Another helm" });
    const on = toggle(NOTHING_ON, HELM, someSet());
    expect(wornPieces(toggle(on, other, someSet()))[0]?.row.label).toBe("Another helm");
  });
});

describe("wearSet", () => {
  // A set is a set of clothes and seeing all of it at once is the ordinary thing to want.
  it("puts every piece of a set on at once", () => {
    const outfit = wearSet(NOTHING_ON, [HELM, ROBE, SWORD], someSet());
    expect(wornPieces(outfit).map((piece) => piece.place))
      .toEqual(["armour-0", "armour-3", "hand-right"]);
  });

  // The rows the game gives no place on a body keep their place in the list and stay off her.
  it("leaves out the rows there is nowhere to put", () => {
    const arrows = row({ displayType: 11, inventoryType: 24 });
    expect(wornPieces(wearSet(NOTHING_ON, [HELM, arrows], someSet()))).toHaveLength(1);
  });

  // A set naming two things for one slot comes out wearing the last of them rather than an
  // arbitrary one, and what is already on elsewhere is left alone.
  it("keeps the last of two pieces for one place, and everything else on", () => {
    const other = row({ displayType: 0, displayInfoId: 900_099, label: "Another helm" });
    const outfit = wearSet(wear(NOTHING_ON, SWORD, someSet()), [HELM, other], someSet());
    expect(wornPieces(outfit).map((piece) => piece.row.label))
      .toEqual(["Another helm", "A sword"]);
  });
});

describe("piecesOf", () => {
  it("sends the three numbers the backend dresses her from", () => {
    const outfit = wear(wear(NOTHING_ON, SWORD, someSet()), HELM, someSet());
    expect(piecesOf(outfit)).toEqual([
      { displayInfoId: 900_001, displayType: 0, inventoryType: 0 },
      { displayInfoId: 900_007, displayType: 11, inventoryType: 13 },
    ]);
  });
});

describe("outfitSummary", () => {
  it("says what to do when nothing is on", () => {
    expect(outfitSummary(NOTHING_ON)).toBe("Nothing on yet. Pick an appearance from any set.");
  });

  it("counts what is on against what could be", () => {
    expect(outfitSummary(wear(NOTHING_ON, HELM, someSet()))).toBe("1 of 13 slots filled");
  });
});
