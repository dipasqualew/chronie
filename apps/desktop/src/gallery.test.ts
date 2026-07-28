import { describe, expect, it } from "vitest";

import {
  PAGE, SET_PAGE, WHOLE, focusOf, piecesOf, stillWanted, stillWantedSets, turnedBy,
  type Thumbnail,
} from "./gallery";
import type { AppearanceRow } from "./transmogModal";
import type { WornPiece } from "./types";

/** One row of the wardrobe with only the fields a gallery reads spelled out. */
const row = (fields: Partial<AppearanceRow> = {}): AppearanceRow => ({
  slot: "Head",
  label: "Tideglass Crown",
  itemId: 71900,
  appearanceId: 30900,
  displayType: 0,
  inventoryType: 1,
  displayInfoId: 900001,
  iconFileDataId: 130001,
  hasModel: true,
  withheld: false,
  sources: [],
  liftsRestriction: false,
  ...fields,
});

const piece = (fields: Partial<WornPiece> = {}): WornPiece => ({
  displayInfoId: 900001,
  displayType: 0,
  inventoryType: 1,
  ...fields,
});

describe("piecesOf", () => {
  // The armour slots and the weapons both reach a body, and a gallery shows every one of them
  // the same way — which is the point of the module: there is no such thing as showing the item
  // instead, because most of these have no geometry of their own at all.
  it.each<[string, number, number]>([
    ["a helm", 0, 1],
    ["a chestpiece", 3, 5],
    ["a cloak", 9, 16],
    ["a two-hander", 11, 17],
  ])("asks for %s to be shown worn", (_, displayType, inventoryType) => {
    expect(piecesOf([row({ displayType, inventoryType })]))
      .toEqual([piece({ displayType, inventoryType })]);
  });

  // The two the game itself gives no place to. Both keep their row and their icon in the list,
  // and neither is asked about — there is no body to draw and asking would be a page of the
  // game's tables read for nothing.
  it.each<[string, Partial<AppearanceRow>]>([
    ["an appearance the game encrypts", { withheld: true }],
    ["a thing filed under a weapon slot nobody holds", { displayType: 11, inventoryType: 0 }],
  ])("leaves out %s", (_, fields) => {
    expect(piecesOf([row(fields)])).toEqual([]);
  });

  it("keeps the order of the rows it was given", () => {
    const rows = [900003, 900001, 900007].map((displayInfoId) => row({ displayInfoId }));
    expect(piecesOf(rows).map((one) => one.displayInfoId)).toEqual([900003, 900001, 900007]);
  });
});

describe("stillWanted", () => {
  const held = (entries: Array<[number, Thumbnail]>): Map<number, Thumbnail> => new Map(entries);

  it("asks for everything when it holds nothing", () => {
    const pieces = [piece({ displayInfoId: 900001 }), piece({ displayInfoId: 900003 })];
    expect(stillWanted(pieces, held([]))).toEqual(pieces);
  });

  // What is already drawn is not asked for again, and that includes the rows that came back
  // with nothing: an appearance this install can put on nobody answers `null` once, and asking
  // again on every repaint is the whole of a page's cost spent to be told the same thing.
  it.each<[string, Thumbnail]>([
    ["one already drawn", { kind: "model", glb: "data:model/gltf-binary;base64,AA", shows: "worn" }],
    ["one already sent for", { kind: "wanted" }],
    ["one that came back with nothing", { kind: "nothing", note: "no place on her" }],
  ])("leaves out %s", (_, thumbnail) => {
    const pieces = [piece({ displayInfoId: 900001 }), piece({ displayInfoId: 900003 })];
    expect(stillWanted(pieces, held([[900001, thumbnail]])))
      .toEqual([piece({ displayInfoId: 900003 })]);
  });

  // Two rows of one display is one picture. The wardrobe reaches the same look through several
  // items often enough for this to matter — and a page that asked twice would get two identical
  // bodies back and pay for both.
  it("asks once for a display two rows share", () => {
    const twice = [piece({ displayInfoId: 900001 }), piece({ displayInfoId: 900001 })];
    expect(stillWanted(twice, held([]))).toEqual([piece({ displayInfoId: 900001 })]);
  });
});

describe("stillWantedSets", () => {
  const held = (entries: Array<[number, Thumbnail]>): Map<number, Thumbnail> => new Map(entries);

  it("asks for every card when it holds nothing", () => {
    expect(stillWantedSets([201, 203], held([]))).toEqual([201, 203]);
  });

  // What is already drawn is not asked for again, whatever it came back as — the same rule the
  // wardrobe's page keeps, and for the same reason: a set this install can dress nobody in
  // answers `null` once, and asking again on every repaint is a page's cost to hear it twice.
  it.each<[string, Thumbnail]>([
    ["one already drawn", { kind: "model", glb: "data:model/gltf-binary;base64,AA", shows: "worn" }],
    ["one already sent for", { kind: "wanted" }],
    ["one that came back with nothing", { kind: "nothing", note: "nothing to put on her" }],
  ])("leaves out %s", (_, thumbnail) => {
    expect(stillWantedSets([201, 203], held([[201, thumbnail]]))).toEqual([203]);
  });

  // By set rather than by anything the set holds: two sets of exactly the same clothes are
  // still two cards, and the backend answers per set.
  it("asks once for a card named twice", () => {
    expect(stillWantedSets([201, 201], held([]))).toEqual([201]);
  });
});

describe("focusOf", () => {
  // Every armour slot is looked at somewhere different, and none of them is the whole body:
  // a gallery row is a hundred and fifty pixels and a helm framed against two metres of
  // character is four pixels of hat.
  it.each<[string, number]>([
    ["head", 0],
    ["shoulders", 1],
    ["chest", 3],
    ["waist", 4],
    ["legs", 5],
    ["feet", 6],
    ["hands", 8],
  ])("holds less than the whole body for the %s slot", (_, displayType) => {
    expect(focusOf(displayType).holds).toBeLessThan(1);
  });

  // Up the body in the order the parts of a body are up it, which is the one property that
  // makes the table readable as a fact about anatomy rather than as seven tuned numbers.
  it("looks higher for a slot that is higher on her", () => {
    const heights = [6, 5, 4, 3, 1, 0].map((displayType) => focusOf(displayType).height);
    expect(heights).toEqual([...heights].sort((left, right) => left - right));
  });

  // A weapon is the one thing nothing here can frame: where a hand is depends on whether she
  // is holding a dagger or a polearm three times her height, and only the model that arrived
  // can say. So it falls through to the whole body and the stage frames what it is given.
  it.each<[string, number]>([
    ["a one-hander", 11],
    ["a bow", 12],
    ["a shield", 13],
    ["something the game numbers past every slot", 99],
  ])("frames %s as the whole body", (_, displayType) => {
    expect(focusOf(displayType)).toEqual({ height: 0.5, holds: 1 });
  });

  // What came back decides, not the slot. A held row is the item's own mesh with no body under
  // it, so there is no part of a character to point a camera at — and the slot's own framing
  // would crop a sword to the third of it a chest would have occupied.
  it("holds all of a picture the backend drew without a body", () => {
    expect(focusOf(3, "held")).toEqual({ height: 0.5, holds: 1 });
    expect(focusOf(0, "held")).toEqual({ height: 0.5, holds: 1 });
  });

  // And the other way round: a slot's framing is what a body gets, which is the default and is
  // what every caller that says nothing means.
  it("frames a body by its slot", () => {
    expect(focusOf(0, "worn")).toEqual(focusOf(0));
    expect(focusOf(0, "worn").holds).toBeLessThan(1);
  });
});

describe("turnedBy", () => {
  // The rate the whole gesture is: dragging the width of the picture turns the model once
  // round, so a reader who wants the back of a helm drags half a tile and gets exactly that.
  it("turns a full circle across the width of the picture", () => {
    expect(turnedBy(0, 300, 300)).toBeCloseTo(Math.PI * 2);
    expect(turnedBy(0, 150, 300)).toBeCloseTo(Math.PI);
  });

  // Measured against the width rather than in pixels, so a tile the reader has made bigger
  // turns at the same speed under the hand instead of proportionally slower.
  it("turns the same amount for the same fraction of any width", () => {
    expect(turnedBy(0, 50, 100)).toBeCloseTo(turnedBy(0, 200, 400));
  });

  // From where the drag started rather than from zero, which is what lets a reader let go,
  // take hold again and carry on round instead of snapping back to the front.
  it("carries on from the angle it started at", () => {
    expect(turnedBy(Math.PI, 150, 300)).toBeCloseTo(Math.PI * 2);
  });

  // Both ways, because a reader who has gone too far turns back.
  it("turns the other way for a drag the other way", () => {
    expect(turnedBy(0, -150, 300)).toBeCloseTo(-Math.PI);
  });

  // Unclamped: a third turn is a reader who meant it, and a ceiling at one would stop the model
  // dead under a hand that was still moving.
  it("keeps turning past a full circle", () => {
    expect(turnedBy(0, 900, 300)).toBeCloseTo(Math.PI * 6);
  });

  // A canvas that has not been laid out yet has no width, and a division by it is every
  // subsequent angle being `NaN` — which is a picture that goes blank and never comes back.
  it.each([0, -1])("leaves the angle alone for a picture %s wide", (across) => {
    expect(turnedBy(1.5, 200, across)).toBe(1.5);
  });
});

describe("PAGE", () => {
  // Smaller than the same list drawn as names, which is a hundred: a row of names is a string
  // and an icon, and a row of models is a body out of the game's files and a texture on the
  // graphics card. Twenty is what `budget.rs` holds the backend to for a page.
  it("draws fewer looks as models than as names", async () => {
    const { PAGE: NAMES } = await import("./wardrobe");
    expect(PAGE).toBeLessThan(NAMES);
  });
});

describe("SET_PAGE", () => {
  // Smaller than a page of the wardrobe, because a row there is one appearance on a body and a
  // card here is a dozen: the backend shares the body between them either way, so what a card
  // costs over a row is the pieces, and a set is about ten times a row's worth of them.
  it("draws fewer sets at a time than the wardrobe draws looks", () => {
    expect(SET_PAGE).toBeLessThan(PAGE);
  });
});

describe("WHOLE", () => {
  // A set is a body's worth of clothes and there is no part of her it is about — the boots are
  // as much of the answer as the helm. Every armour slot is framed on a part of her, and this
  // is what says a card is not.
  it("holds all of her, from her middle", () => {
    expect(WHOLE).toEqual({ height: 0.5, holds: 1 });
    for (const displayType of [0, 3, 5, 6, 9]) {
      expect(focusOf(displayType).holds).toBeLessThan(WHOLE.holds);
    }
  });
});
