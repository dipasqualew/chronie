import { describe, expect, it } from "vitest";
import {
  cameraFor,
  framingDistance,
  glbBytes,
  outfitOf,
  REASONS,
  wearable,
  wornSetKey,
  type Previewable,
} from "./modelPreview";

/** One appearance with only the fields a test cares about spelled out. */
const appearance = (fields: Partial<Previewable> = {}): Previewable => ({
  displayType: 0,
  inventoryType: 1,
  displayInfoId: 900001,
  iconFileDataId: 130001,
  hasModel: true,
  withheld: false,
  ...fields,
});

describe("wearable", () => {
  // Every armour slot, head through tabard, goes on the body — including the two that have a
  // mesh of their own. That is the whole of the decision this makes: a helm has geometry and
  // the only place that geometry means anything is on a head.
  it.each<[string, number, boolean]>([
    ["head", 0, true],
    ["shoulder", 1, true],
    ["shirt", 2, false],
    ["chest", 3, false],
    ["waist", 4, false],
    ["legs", 5, false],
    ["feet", 6, false],
    ["wrist", 7, false],
    ["hands", 8, false],
    ["back", 9, false],
    ["tabard", 10, false],
  ])("wears the %s slot on the character", (_, displayType, hasModel) => {
    expect(wearable(appearance({ displayType, hasModel }))).toEqual({
      kind: "worn",
      piece: { displayInfoId: 900001, displayType, inventoryType: 1 },
    });
  });

  // And a weapon is worn too, once something says which hand — which the display type never
  // does and the item always does. All four of the game's weapon slots reach the character.
  it.each<[string, number, number]>([
    ["a one-hander", 11, 13],
    ["a two-hander", 11, 17],
    ["a shield", 13, 14],
    ["a bow", 12, 15],
    ["a tome in the other hand", 15, 23],
  ])("wears %s held on the character", (_, displayType, inventoryType) => {
    expect(wearable(appearance({ displayType, inventoryType }))).toEqual({
      kind: "worn",
      piece: { displayInfoId: 900001, displayType, inventoryType },
    });
  });

  // What is left off her is a weapon nothing says a place for: an item the game withholds, and
  // the arrows it files under a weapon slot and nobody holds. Neither is a failure of this
  // install, and both keep their row — they simply have nowhere on a body to be.
  it.each<[string, number, number]>([
    ["an item the game withholds", 11, 0],
    ["ammunition", 14, 24],
  ])("gives %s no place on the character", (_, displayType, inventoryType) => {
    expect(wearable(appearance({ displayType, inventoryType })))
      .toEqual({ kind: "nowhere", note: REASONS.nowhere });
  });

  // Having no model of its own says nothing either way. Eight of the eleven armour slots have
  // none and are worn regardless, and a weapon slot with none still fails for the reason it
  // always did, which is that nothing says a hand.
  it("does not read a missing model as a reason not to wear something", () => {
    expect(wearable(appearance({ displayType: 3, hasModel: false })).kind).toBe("worn");
    expect(wearable(appearance({ displayType: 11, inventoryType: 0, hasModel: false })))
      .toEqual({ kind: "nowhere", note: REASONS.nowhere });
  });

  // Withheld wins: a row the game encrypts can still carry a display id from an earlier hop,
  // and asking the backend to put it on her would be asking about something unknowable.
  it("says nothing rather than guessing about a withheld row that looks modelled", () => {
    expect(wearable(appearance({ withheld: true })))
      .toEqual({ kind: "nowhere", note: REASONS.withheld });
  });
});

describe("outfitOf", () => {
  const helm = appearance({ displayType: 0, displayInfoId: 900001 });
  const chest = appearance({ displayType: 3, displayInfoId: 900003 });
  const legs = appearance({ displayType: 5, displayInfoId: 900006 });
  const arrows = appearance({ displayType: 14, inventoryType: 24, displayInfoId: 900020 });

  // The outfit is the rows that are picked, in the order the rows are listed — which is not
  // the order they will be worn in, because that is the game's own table and the backend's.
  it("takes the picked rows in the order the list holds them", () => {
    const picked = outfitOf([helm, chest, legs], new Set([2, 0]));
    expect(picked.map((piece) => piece.displayInfoId)).toEqual([900001, 900006]);
  });

  // A picked row the character cannot wear is not part of the outfit, however it got picked.
  it("leaves out a picked row that has nowhere to go", () => {
    expect(outfitOf([helm, arrows], new Set([0, 1]))).toHaveLength(1);
  });

  it("comes back empty when nothing is picked", () => {
    expect(outfitOf([helm, chest], new Set())).toEqual([]);
  });
});

describe("wornSetKey", () => {
  const piece = (displayInfoId: number) => ({ displayInfoId, displayType: 3, inventoryType: 0 });

  // Two lists of the same pieces are the same outfit and get the same body back, so a reader
  // who takes a piece off and puts it on again pays for the read once.
  it("names an outfit by its pieces rather than by the order they arrived in", () => {
    expect(wornSetKey([piece(3), piece(1), piece(2)])).toBe(wornSetKey([piece(1), piece(2), piece(3)]));
  });

  // And two different outfits are two different names, including the one that differs only by
  // naming the same appearance twice — which the game does, and which is a set of its own.
  it("tells two outfits apart", () => {
    expect(wornSetKey([piece(1), piece(2)])).not.toBe(wornSetKey([piece(1)]));
    expect(wornSetKey([piece(1), piece(1)])).not.toBe(wornSetKey([piece(1)]));
  });

  it("names an empty outfit", () => {
    expect(wornSetKey([])).toBe("");
  });
});

describe("glbBytes", () => {
  it("reads the model out of the data url the backend sends", () => {
    // "glTF" and a version of 2, which is how every .glb starts.
    const glb = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    const url = `data:model/gltf-binary;base64,${btoa(String.fromCharCode(...glb))}`;
    expect([...glbBytes(url)]).toEqual([...glb]);
  });

  // The pictures come across the same bridge in the same shape, and handing one to a model
  // loader would fail somewhere much less obvious than here.
  it("refuses anything that is not a model", () => {
    expect(() => glbBytes("data:image/png;base64,iVBORw0KGgo=")).toThrow(/not a model/);
    expect(() => glbBytes("")).toThrow(/not a model/);
  });
});

describe("framingDistance", () => {
  // The camera has to sit far enough back that the whole model fits the view. At the tangent
  // of half the field of view it exactly touches the edges, so the answer is beyond that.
  it("puts the camera far enough back to hold the whole model", () => {
    const exact = 1 / Math.tan((35 / 2) * (Math.PI / 180));
    expect(framingDistance(1, 35)).toBeGreaterThan(exact);
    expect(framingDistance(1, 35)).toBeLessThan(exact * 2);
  });

  it("backs off further for a bigger model", () => {
    expect(framingDistance(4, 35)).toBeCloseTo(framingDistance(1, 35) * 4);
  });

  // A cloak is a sheet and a dagger is nearly a line; framing either by its own size exactly
  // would put the camera inside it.
  it("keeps its distance from something with almost no size at all", () => {
    expect(framingDistance(0, 35)).toBeGreaterThan(0);
  });
});

describe("cameraFor", () => {
  // The window's own view, unchanged. It is the one a reader sees on every model, and it is
  // deliberately off every axis: an item seen exactly head on reads as a silhouette.
  it("leaves the view the window opens on where it has always been", () => {
    expect(cameraFor("default", 10)).toEqual([4.5, 2.5, 10]);
  });

  // The named ones are square to the axes, which is what makes a render asked for twice the
  // same picture twice — the property the whole point of `scripts/render-model.ts` rests on.
  it("puts a named view square on its axis, the whole distance away", () => {
    expect(cameraFor("front", 3)).toEqual([0, 0, 3]);
    expect(cameraFor("back", 3)).toEqual([0, 0, -3]);
    expect(cameraFor("left", 3)).toEqual([-3, 0, 0]);
    expect(cameraFor("right", 3)).toEqual([3, 0, 0]);
  });

  // Every named view is exactly the framing distance from the middle, so one model photographed
  // from four sides is photographed at one scale. `default` is the exception and is meant to be:
  // it is a direction the window chose rather than a unit vector.
  it("keeps every named view the same distance out", () => {
    const length = (at: [number, number, number]): number => Math.hypot(...at);
    for (const view of ["front", "back", "left", "right"] as const) {
      expect(length(cameraFor(view, 7))).toBeCloseTo(7);
    }
  });
});
