import { describe, expect, it } from "vitest";
import {
  framingDistance,
  glbBytes,
  previewFor,
  REASONS,
  wornNote,
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
  // The four slots with geometry of their own. Everything this app can show in 3D is here.
  it.each<[string, number]>([
    ["a helm", 0],
    ["a shoulder", 1],
    ["a weapon", 11],
    ["a shield", 15],
  ])("shows %s as a model", (_, displayType) => {
    expect(previewFor(appearance({ displayType }))).toEqual({
      kind: "model",
      displayInfoId: 900001,
    });
  });

  // The slots in between have no mesh to show alone — they are texture painted onto the
  // character's body — so they are shown on one. On a full set that is most of the rows, and
  // it is the difference between a wardrobe of icons and a wardrobe.
  it.each<[string, number]>([
    ["chest", 2],
    ["waist", 3],
    ["legs", 4],
    ["feet", 5],
    ["wrist", 6],
    ["hands", 7],
    ["back", 8],
    ["tabard", 9],
    ["shirt", 10],
  ])("shows the %s slot worn on the character", (_, displayType) => {
    expect(previewFor(appearance({ displayType, hasModel: false }))).toEqual({
      kind: "worn",
      displayInfoId: 900001,
      displayType,
    });
  });

  // A weapon slot with no model is not armour painted on a body, so it is not worn on one —
  // and it gets the plainer reason rather than one that would be untrue of it.
  it("does not put a weapon with no model on the character", () => {
    expect(previewFor(appearance({ displayType: 11, hasModel: false })))
      .toEqual({ kind: "icon", iconFileDataId: 130001, note: REASONS.none });
  });

  // The four slots that do have geometry keep showing it. A helm worn on a character would be
  // a bald head until the attachment work lands, which is less than the helm itself.
  it("shows a helm as the helm rather than on the character", () => {
    expect(previewFor(appearance({ displayType: 0, hasModel: true })))
      .toMatchObject({ kind: "model" });
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

describe("wornNote", () => {
  // The ordinary case, which is most of them: it is worn, and there is nothing to explain.
  it("says only that it is worn when the whole appearance was painted", () => {
    expect(wornNote([])).toBe(REASONS.worn);
  });

  // The case this exists for. A body wearing the shape of a piece of armour in the colour of
  // bare skin is indistinguishable from a working one, from an install missing a file, and
  // from a bug — and the reader cannot tell which without being told.
  it("says which parts of the body went unpainted, in the backend's own words", () => {
    const note = wornNote(["the feet: the game's tables name no texture for it"]);
    expect(note).toContain(REASONS.worn);
    expect(note).toContain("One part of the body could not be painted");
    expect(note).toContain("the feet: the game's tables name no texture for it");
  });

  it("counts them when there is more than one", () => {
    expect(wornNote(["the feet: gone", "the hands: gone"]))
      .toContain("2 parts of the body could not be painted — the feet: gone; the hands: gone.");
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
