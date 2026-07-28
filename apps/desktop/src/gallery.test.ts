import { describe, expect, it } from "vitest";

import { PAGE, focusOf, piecesOf, stillWanted, type Thumbnail } from "./gallery";
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
    ["one already drawn", { kind: "model", glb: "data:model/gltf-binary;base64,AA" }],
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
