import { describe, expect, it } from "vitest";

import {
  COLOUR,
  NO_QUALITIES,
  SIZE,
  colourName,
  indexQualities,
  qualityFacets,
  qualitySummary,
  qualityWords,
} from "./qualities";
import type { Quality, QualitiesFile } from "./types";

const quality = (id: number, fields: Partial<Omit<Quality, "id">> = {}): Quality => ({
  id,
  primary: "#808080",
  ...fields,
});

const file = (appearances: Quality[]): QualitiesFile => ({
  displayType: 0,
  build: "12.0.5.67823",
  sizeCuts: {},
  appearances,
});

describe("finding what was measured of one look", () => {
  it("answers by the appearance the row was measured of", () => {
    const index = indexQualities(
      file([
        quality(321, { primary: "#151515", accent: "#545354", size: "small" }),
        quality(322, { primary: "#a56722" }),
      ]),
    );

    expect(index.of(321)).toEqual({
      id: 321,
      primary: "#151515",
      accent: "#545354",
      size: "small",
    });
    expect(index.of(322)?.accent).toBeUndefined();
  });

  // A look the store says nothing about draws exactly as it drew before any of this existed,
  // which is what lets a store regenerated one patch late still be worth having.
  it("says nothing about a look the store does not hold", () => {
    expect(indexQualities(file([quality(1)])).of(2)).toBeUndefined();
    expect(indexQualities(null).of(1)).toBeUndefined();
    expect(indexQualities(null).count).toBe(0);
    expect(NO_QUALITIES.of(1)).toBeUndefined();
  });

  it("reads the sets' file, which is the same rows under another name", () => {
    const index = indexQualities({ build: "12.0.5.67823", sets: [quality(1834)] });
    expect(index.of(1834)?.primary).toBe("#808080");
    expect(index.count).toBe(1);
  });

  // The one thing the file says about itself that a reader might want out loud: which build of
  // the game somebody measured, which is how old the colours on the screen are.
  it("carries the build it was measured off", () => {
    expect(indexQualities(file([])).build).toBe("12.0.5.67823");
    expect(indexQualities(null).build).toBe("");
  });
});

describe("naming a colour", () => {
  // The eight hues, at the middle of each of their bands, so a shifted boundary is a failure
  // rather than a rounding.
  it.each([
    ["#e02020", "red"],
    ["#e07820", "orange"],
    ["#d8d820", "yellow"],
    ["#20c020", "green"],
    ["#20c8c0", "teal"],
    ["#2060e0", "blue"],
    ["#8020e0", "purple"],
    ["#e020a0", "pink"],
  ])("calls %s %s", (hex, expected) => {
    expect(colourName(hex)).toBe(expected);
  });

  // Brown is the one name that is not a hue: it is a dark orange, it is most of the leather in
  // the game, and nobody looking for it types "orange".
  it.each(["#4a3b2c", "#5a3a10", "#3d2b18"])("calls %s brown rather than dark orange", (hex) => {
    expect(colourName(hex)).toBe("brown");
  });

  // A colour with no hue worth naming is not a very dark red, whatever the arithmetic says.
  it.each([
    ["#000000", "black"],
    ["#050505", "black"],
    ["#ffffff", "white"],
    ["#f8f8f8", "white"],
    ["#808080", "grey"],
    ["#2a2b2a", "dark grey"],
    ["#d6d7d6", "pale grey"],
  ])("calls %s %s", (hex, expected) => {
    expect(colourName(hex)).toBe(expected);
  });

  it("says how dark or pale a colour is, which is half of what a reader would call it", () => {
    expect(colourName("#200a0a")).toBe("dark red");
    expect(colourName("#f8c8c8")).toBe("pale red");
  });

  // The store is a file, and a window that threw on a malformed one would be a window that
  // does not open. Black is the wrong answer and it is on the screen rather than in a crash.
  it.each(["", "not a colour", "#fff", "#gggggg"])("survives %p", (hex) => {
    expect(colourName(hex)).toBe("black");
  });

  it("reads a colour with or without its hash", () => {
    expect(colourName("2060e0")).toBe(colourName("#2060e0"));
  });
});

describe("what a measured look adds to a search", () => {
  // The point of the whole naming exercise: a reader can see "brown" and "large" on the row and
  // will type them into the box above it.
  it("is the words on the row, lowercased", () => {
    expect(qualityWords(quality(1, { primary: "#4a3b2c", accent: "#e0c060", size: "large" }))).toBe(
      "brown yellow large",
    );
  });

  it("leaves out what the row does not say", () => {
    expect(qualityWords(quality(1, { primary: "#e02020" }))).toBe("red");
    expect(qualityWords(undefined)).toBe("");
  });

  // Not the hex: nobody searches for `#4a3b2c`, and six hex characters match a name by accident
  // often enough to be a nuisance.
  it("is not the hex", () => {
    expect(qualityWords(quality(1, { primary: "#e02020" }))).not.toContain("e02020");
  });
});

describe("what a measured look adds to the terms the search box reads", () => {
  // Both colours under the one key a reader would type: somebody looking at two swatches is
  // looking at a thing that is brown and yellow, and which of them the measurement called the
  // fuller is a detail of the measuring rather than a question anybody asks.
  it("puts both colours under the one key, and the size under its own", () => {
    expect(
      qualityFacets(quality(1, { primary: "#4a3b2c", accent: "#e0c060", size: "large" })),
    ).toEqual([
      { key: COLOUR, value: "brown" },
      { key: COLOUR, value: "yellow" },
      { key: SIZE, value: "large" },
    ]);
  });

  // A look that is all one colour has no accent and a slot with no mesh to measure has no size,
  // and neither is a facet with nothing in it — `colour:` is a question about what was measured
  // and would be answered by every row in the store if the gaps were offered as answers.
  it("leaves out what the store could not measure", () => {
    expect(qualityFacets(quality(1, { primary: "#e02020" }))).toEqual([
      { key: COLOUR, value: "red" },
    ]);
  });

  it("says nothing at all about a look the store does not hold", () => {
    expect(qualityFacets(undefined)).toEqual([]);
  });
});

describe("how a measured look reads on a chip", () => {
  it("names both colours and the size", () => {
    expect(
      qualitySummary(quality(1, { primary: "#4a3b2c", accent: "#e0c060", size: "large" })),
    ).toBe("large, brown and yellow");
  });

  it("names one colour where there is one, and no size where there is none", () => {
    expect(qualitySummary(quality(1, { primary: "#e02020" }))).toBe("red");
    expect(qualitySummary(quality(1, { primary: "#e02020", size: "small" }))).toBe("small, red");
  });
});
