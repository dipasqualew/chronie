import { describe, expect, it } from "vitest";
import { WHOLE, focusOf } from "./gallery";
import {
  cameraFor,
  frameOn,
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

describe("frameOn", () => {
  /**
   * The corners of a body standing on the floor, the way one arrives out of this pipeline: the
   * feet on Y zero, the scalp at 2, and the middle of her a little off the origin in the two
   * flat axes — which is what makes "did it centre her" a question with an answer.
   */
  const FEET: [number, number, number] = [0.1, 0, -0.5];
  const SCALP: [number, number, number] = [0.5, 2, 0.7];

  // The whole of issue #142. The pane orbits its target and its target is the origin, so what
  // the offset puts there is what a drag turns and what a scroll zooms towards. A helm framed
  // as a whole body put her pelvis there, a metre below the thing the reader had clicked, and
  // the helm swung off the pane at the first degree of the first drag.
  it("puts the part being looked at on the origin, whatever else arrived with it", () => {
    const { offset } = frameOn(FEET, SCALP, focusOf(0), "default", FOV, 0.75);
    // A head is at 0.92 of her height, so the origin lands there and not at her middle.
    expect(offset[1]).toBeCloseTo(-1.84);
    // And across the two flat axes she is centred, because there is no part of "left" or
    // "in front" that a slot picks out.
    expect(offset[0]).toBeCloseTo(-0.3);
    expect(offset[2]).toBeCloseTo(-0.1);
  });

  // The other half of the same report. A slot's framing holds a slice of her rather than all of
  // her, which is the difference between a helm and four pixels of hat.
  it("stands close enough to a slot to see it, and back to see the whole body", () => {
    const head = frameOn(FEET, SCALP, focusOf(0), "default", FOV, 0.75);
    const feet = frameOn(FEET, SCALP, focusOf(6), "default", FOV, 0.75);
    const all = frameOn(FEET, SCALP, WHOLE, "default", FOV, 0.75);

    expect(head.distance).toBeLessThan(all.distance / 2);
    expect(feet.distance).toBeLessThan(all.distance / 2);
    // A cloak is most of her, so its framing is nearly the whole-body one — the table says so
    // and the arithmetic has to carry that through rather than flatten every slot to one.
    expect(frameOn(FEET, SCALP, focusOf(9), "default", FOV, 0.75).distance)
      .toBeGreaterThan(head.distance * 2);
  });

  // The character pane frames whatever it is given and has no slot to point at, so this is the
  // path everything that is not one appearance takes. It has to come out where it came out
  // before there was a focus at all, or a body somebody was looking at moves under them.
  it("frames the whole of a model exactly as a bare framing does", () => {
    const size: [number, number, number] = [0.4, 2, 1.2];
    const all = frameOn([-0.2, 0, -0.6], [0.2, 2, 0.6], WHOLE, "default", FOV, 0.75);

    // Which is to say the middle of the box, exactly as subtracting its centre would give.
    for (const [axis, where] of all.offset.entries()) expect(where).toBeCloseTo([0, -1, 0][axis]!);
    expect(all.distance).toBeCloseTo(framingDistance(onScreen(size, "default"), FOV, 0.75));
    expect(all.leash).toBeCloseTo(Math.hypot(...size) / 2);
  });

  // A weapon is its own mesh with no body under it, and a polearm is three times as long as it
  // is tall. `holds: 1` means all of it, so nothing may be clipped to the height — which is the
  // one case where framing a slice of the model would put the camera inside it.
  it("holds all of something wider than it is tall", () => {
    const long = frameOn([-3, -0.2, -0.2], [3, 0.2, 0.2], WHOLE, "front", FOV, 0.75);
    expect(long.distance)
      .toBeCloseTo(framingDistance(onScreen([6, 0.4, 0.4], "front"), FOV, 0.75));
  });

  // The leash is what stops a pan carrying the model off the pane, and it is about what is in
  // view: a helm's is a helm's, not a whole body's.
  it("leashes a pan to what is being looked at", () => {
    const head = frameOn(FEET, SCALP, focusOf(0), "default", FOV, 0.75);
    expect(head.leash).toBeLessThan(frameOn(FEET, SCALP, WHOLE, "default", FOV, 0.75).leash);
    expect(head.leash).toBeGreaterThan(0);
  });

  // A `.glb` that parsed into a single point, which is a thing an install can produce.
  it("keeps its distance from a model with no size at all", () => {
    const nothing = frameOn([0, 0, 0], [0, 0, 0], focusOf(0), "default", FOV, 0.75);
    expect(nothing.distance).toBeGreaterThan(0);
    expect(nothing.offset.every(Number.isFinite)).toBe(true);
  });
});
