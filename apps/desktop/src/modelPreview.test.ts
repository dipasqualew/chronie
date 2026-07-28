import { describe, expect, it } from "vitest";
import {
  cameraFor,
  framingDistance,
  glbBytes,
  onScreen,
  outfitOf,
  REASONS,
  wearable,
  wornSetKey,
  type Previewable,
  type View,
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

/**
 * A body's bounding box, in the axes a `.glb` out of this pipeline uses: X is the way she
 * faces, Y is up, Z is shoulder to shoulder. Roughly the proportions of `humanfemale_hd`,
 * which is the model every one of these numbers is really about.
 */
const BODY: [number, number, number] = [0.4, 2, 1.2];

/** The field of view the window's stage uses, which is the only one worth testing against. */
const FOV = 35;

/**
 * How much of the pane's height and width a model actually covers, once framed.
 *
 * The property "as close as it can be and still fit" is about the picture rather than about
 * the distance, and this is the picture: the fraction of the frame the model takes up on each
 * axis. Anything over 1 has gone off the edge.
 */
function fills(size: [number, number, number], view: View, aspect: number): [number, number] {
  const seen = onScreen(size, view);
  const distance = framingDistance(seen, FOV, aspect);
  // The near face of the model is what a frustum has to hold, which is where the depth goes.
  const half = Math.tan((FOV / 2) * (Math.PI / 180)) * (distance - seen.deep);
  return [seen.up / half, seen.across / (half * aspect)];
}

describe("onScreen", () => {
  // Face to face with her: what has to fit across the pane is her shoulders and what has to
  // fit up it is her height. Her depth shows as nothing at all, and still costs — see below.
  it("measures a body by the two sides that face the camera", () => {
    expect(onScreen(BODY, "default")).toEqual({ across: 0.6, up: 1, deep: 0.2 });
  });

  // The same body a quarter turn round: now it is her depth that has to fit across the pane,
  // and her shoulders that are pointed at the camera.
  it("swaps them when the view is round the side", () => {
    expect(onScreen(BODY, "front")).toEqual({ across: 0.2, up: 1, deep: 0.6 });
  });

  // A view and the view opposite it see the same silhouette. Nothing chooses a camera by this,
  // but it is the cheapest statement of "these are extents and not positions".
  it("sees the same size from either end of an axis", () => {
    expect(onScreen(BODY, "back")).toEqual(onScreen(BODY, "front"));
    expect(onScreen(BODY, "left")).toEqual(onScreen(BODY, "right"));
  });
});

describe("framingDistance", () => {
  // The whole of the change: a body framed in a square pane fills nearly the whole of its
  // height. The framing this replaced went by the radius of the sphere around her — nearly her
  // full height in every direction — and left her at about two thirds of the pane with the rest
  // of it empty. Only the taller axis is expected to be full; nothing can fill both.
  it("frames a body as closely as the pane will hold it", () => {
    const [tall, wide] = fills(BODY, "default", 1);
    expect(tall).toBeGreaterThan(0.9);
    expect(tall).toBeLessThanOrEqual(1);
    expect(wide).toBeLessThanOrEqual(1);
  });

  // The pane is a column beside the sets, so it is usually taller than it is wide, and the
  // width is then what decides the distance. A model framed against the height alone — which
  // is what a single field of view amounts to — hangs off both sides of a pane like that.
  it("holds the model in a pane narrower than it is tall", () => {
    for (const aspect of [0.4, 0.7, 1, 1.6]) {
      const [tall, wide] = fills(BODY, "default", aspect);
      expect(tall).toBeLessThanOrEqual(1);
      expect(wide).toBeLessThanOrEqual(1);
      expect(Math.max(tall, wide)).toBeGreaterThan(0.9);
    }
  });

  // Twice the model, twice the distance, same picture. What makes a set of renders comparable.
  it("backs off in proportion to the model", () => {
    const twice: [number, number, number] = [0.8, 4, 2.4];
    expect(framingDistance(onScreen(twice, "default"), FOV, 1))
      .toBeCloseTo(framingDistance(onScreen(BODY, "default"), FOV, 1) * 2);
  });

  // A cloak is a sheet and a dagger is nearly a line; framing either by its own size exactly
  // would put the camera inside it.
  it("keeps its distance from something with almost no size at all", () => {
    expect(framingDistance({ across: 0, up: 0, deep: 0 }, FOV, 1)).toBeGreaterThan(0);
  });
});

describe("cameraFor", () => {
  // What the window opens on, and the reason this file has a view called `default` at all: it
  // is her front, so the reader meets her face on rather than over her left shoulder.
  it("opens face to face with the character", () => {
    expect(cameraFor("default", 10)).toEqual(cameraFor("right", 10));
    expect(cameraFor("default", 10)).toEqual([10, 0, 0]);
  });

  // The named ones are square to the axes, which is what makes a render asked for twice the
  // same picture twice — the property the whole point of `scripts/render-model.ts` rests on.
  it("puts a named view square on its axis, the whole distance away", () => {
    expect(cameraFor("front", 3)).toEqual([0, 0, 3]);
    expect(cameraFor("back", 3)).toEqual([0, 0, -3]);
    expect(cameraFor("left", 3)).toEqual([-3, 0, 0]);
    expect(cameraFor("right", 3)).toEqual([3, 0, 0]);
  });

  // Every view is exactly the framing distance from the middle, so one model photographed from
  // four sides is photographed at one scale — and the distance a caller worked out is the
  // distance it gets, which is what lets the framing above be reasoned about at all.
  it("keeps every view the same distance out", () => {
    const length = (at: [number, number, number]): number => Math.hypot(...at);
    for (const view of ["default", "front", "back", "left", "right"] as const) {
      expect(length(cameraFor(view, 7))).toBeCloseTo(7);
    }
  });
});
