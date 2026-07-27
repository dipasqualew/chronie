import { describe, expect, it } from "vitest";
import {
  cameraFor,
  framingDistance,
  glbBytes,
  previewFor,
  REASONS,
  type Previewable,
} from "./modelPreview";

/** One appearance with only the fields a test cares about spelled out. */
const appearance = (fields: Partial<Previewable> = {}): Previewable => ({
  displayType: 0,
  displayInfoId: 900001,
  iconFileDataId: 130001,
  hasModel: true,
  withheld: false,
  ...fields,
});

describe("previewFor", () => {
  // Every armour slot, head through tabard, is shown on the body — including the two that
  // have a mesh of their own. That is the whole of the decision this used to make: a helm has
  // geometry and the only place that geometry means anything is on a head.
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
  ])("shows the %s slot worn on the character", (_, displayType, hasModel) => {
    expect(previewFor(appearance({ displayType, hasModel }))).toEqual({
      kind: "worn",
      displayInfoId: 900001,
      displayType,
    });
  });

  // What is left on its own is a weapon, which hangs off a hand and is another issue.
  it.each<[string, number]>([
    ["a weapon", 11],
    ["a shield", 15],
  ])("shows %s as a model of its own", (_, displayType) => {
    expect(previewFor(appearance({ displayType }))).toEqual({
      kind: "model",
      displayInfoId: 900001,
    });
  });

  // A weapon slot with no model is not armour painted on a body, so it is not worn on one —
  // and it gets the plainer reason rather than one that would be untrue of it.
  it("does not put a weapon with no model on the character", () => {
    expect(previewFor(appearance({ displayType: 11, hasModel: false })))
      .toEqual({ kind: "icon", iconFileDataId: 130001, note: REASONS.none });
  });

  // An appearance the game encrypts has no icon either — the row knows nothing about it at
  // all — so there is nothing to show and only something to say.
  it("shows nothing at all for an appearance the game withholds", () => {
    expect(previewFor(appearance({ withheld: true, hasModel: false, iconFileDataId: 0 })))
      .toEqual({ kind: "none", note: REASONS.withheld });
  });

  // Withheld wins: a row the game encrypts can still carry a display id from an earlier hop,
  // and asking the backend for its model would be asking about something unknowable.
  it("says nothing rather than guessing about a withheld row that looks modelled", () => {
    expect(previewFor(appearance({ withheld: true }))).toEqual({
      kind: "none",
      note: REASONS.withheld,
    });
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
