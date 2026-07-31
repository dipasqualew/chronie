/**
 * What else might do, for a look nothing in the game sells around — see `alternatives.ts`.
 *
 * Everything under test here is about a claim's *strength* and who made it. The measure itself
 * is `fingerprints.rs` and `shapes.rs`; what this module owns is that an equality never reads as
 * a percentage, that a percentage never reads as a certainty, and that a person's answer outlives
 * both — the two stores behind them being thrown away and rebuilt from the game every patch.
 */

import { describe, expect, it } from "vitest";

import {
  alternativeRows,
  alternativesSummary,
  CONFIRMED,
  likeness,
  REJECTED,
  verdictOf,
} from "./alternatives";
import type { Alternative, AlternativesPayload, LookalikeVerdict } from "./types";

/** Ulduar's Priest tier head, and the world drop that looks exactly like it. */
const TIER_HEAD = 11678;
const WORLD_DROP = 11366;

function offered(appearanceId: number, over: Partial<Alternative> = {}): Alternative {
  return {
    appearanceId,
    itemId: 40000 + appearanceId,
    name: `Look ${appearanceId}`,
    requiredLevel: 0,
    quality: 3,
    iconFileDataId: 130001,
    classId: 4,
    subclassId: 1,
    ...over,
  };
}

function payload(over: Partial<AlternativesPayload> = {}): AlternativesPayload {
  return {
    appearanceId: TIER_HEAD,
    geometryAnswers: true,
    sameMesh: [],
    lookalikesReady: true,
    lookalikes: [],
    ...over,
  };
}

const said = (alternativeId: number, verdict: string): LookalikeVerdict => ({
  appearanceId: TIER_HEAD,
  alternativeId,
  verdict,
});

describe("likeness", () => {
  // The number the whole ranked half is read by, and the one rule it has: 100% is what somebody
  // would take as a verdict, and a verdict is exactly what a thumbnail distance is not. The
  // worked case behind this feature is 0.0039 apart, which rounds to 100 and must not print it.
  it("never calls two pictures that are not the same picture identical", () => {
    expect(likeness(0.0039)).toBe("99.6% alike");
    expect(likeness(0.00001)).toBe("99.9% alike");
    expect(likeness(0)).toBe("100% alike");
  });

  it("says how alike two pictures measured", () => {
    expect(likeness(0.25)).toBe("75% alike");
    expect(likeness(0.5)).toBe("50% alike");
  });
});

describe("alternativeRows", () => {
  // The distinction the whole panel turns on. A row out of the geometry is two signatures being
  // equal — the same piece of armour, another colour — and a row out of the pictures is a
  // distance under a threshold. The rows carry which, and the exact ones come first.
  it("puts what is certain ahead of what is measured, and says which is which", () => {
    const rows = alternativeRows(
      payload({
        sameMesh: [offered(WORLD_DROP)],
        lookalikes: [offered(11481, { distance: 0.0586 })],
      }),
      [],
    );
    expect(rows.map((row) => [row.appearanceId, row.exact, row.likeness])).toEqual([
      [WORLD_DROP, true, ""],
      [11481, false, "94.1% alike"],
    ]);
  });

  // What a person decided outranks what a store measured, because the stores are rebuilt from
  // the game every patch and the person's answer is not.
  it("lifts a confirmed suggestion above everything measured", () => {
    const rows = alternativeRows(
      payload({
        sameMesh: [offered(WORLD_DROP)],
        lookalikes: [offered(11481, { distance: 0.0586 })],
      }),
      [said(11481, CONFIRMED)],
    );
    expect(rows.map((row) => row.appearanceId)).toEqual([11481, WORLD_DROP]);
    expect(rows[0]?.verdict).toBe(CONFIRMED);
  });

  // And a rejection sinks, which is the whole reason storing one is worth a table: without it
  // the same wrong row climbs back to the top every time the panel is opened.
  it("sinks a rejected suggestion below everything else", () => {
    const rows = alternativeRows(
      payload({
        sameMesh: [offered(WORLD_DROP)],
        lookalikes: [offered(11481, { distance: 0.0586 })],
      }),
      [said(WORLD_DROP, REJECTED)],
    );
    expect(rows.map((row) => row.appearanceId)).toEqual([11481, WORLD_DROP]);
  });

  // The armour type on every row, because the world drop that lifts a class lock nearly always
  // lifts the class and not the kind of armour: a cloth answer is right for a Priest and no use
  // whatever to a Druid, and this is the only place the reader is told.
  it("says which kind of armour each answer is", () => {
    const rows = alternativeRows(
      payload({
        sameMesh: [offered(WORLD_DROP, { subclassId: 1 })],
        lookalikes: [offered(11481, { subclassId: 4, distance: 0.1, requiredLevel: 45 })],
      }),
      [],
    );
    expect(rows.map((row) => [row.kind, row.requirement])).toEqual([
      ["Cloth", ""],
      ["Plate", "Level 45"],
    ]);
  });

  // A look the game never named still gets a row: the appearance is real, the item is real, and
  // the id is what a reader takes to Wowhead.
  it("names a row after the item's id where the game names nothing", () => {
    const rows = alternativeRows(payload({ sameMesh: [offered(WORLD_DROP, { name: "" })] }), []);
    expect(rows[0]?.label).toBe(`Item ${40000 + WORLD_DROP}`);
  });
});

describe("verdictOf", () => {
  // Keyed on the pair rather than on the suggestion, because one look can be offered for several
  // and a verdict is about the two of them together.
  it("finds what was said about one pair and nothing about another", () => {
    const rows = [said(WORLD_DROP, CONFIRMED)];
    expect(verdictOf(rows, TIER_HEAD, WORLD_DROP)).toBe(CONFIRMED);
    expect(verdictOf(rows, 11427, WORLD_DROP)).toBeNull();
    expect(verdictOf(rows, TIER_HEAD, 11481)).toBeNull();
  });
});

describe("alternativesSummary", () => {
  // Four states that all look like an empty list from outside, and only one of them is a reason
  // to come back later. A panel saying "nothing looks like this" while the pictures were still
  // being read would be the app reporting its own unfinished work as a fact about the game.
  it("says the pictures are still being read rather than that nothing matched", () => {
    expect(alternativesSummary(payload({ lookalikesReady: false }))).toBe(
      "Chronie is reading the game's own textures to answer this — about a minute, once per patch",
    );
  });

  it("tells a slot the geometry cannot answer from one it answered and found nothing in", () => {
    expect(alternativesSummary(payload({ geometryAnswers: true }))).toBe(
      "Nothing else in the game is this piece of armour, and nothing looks near enough to offer",
    );
    expect(alternativesSummary(payload({ geometryAnswers: false }))).toBe(
      "Nothing in the game looks near enough to this one to offer",
    );
  });

  it("counts what each measure found", () => {
    expect(alternativesSummary(payload({ sameMesh: [offered(1)] }))).toBe(
      "1 other colour of this same piece of armour",
    );
    expect(alternativesSummary(payload({ lookalikes: [offered(1), offered(2)] }))).toBe(
      "2 looks near enough to be worth your eye",
    );
    expect(alternativesSummary(payload({ sameMesh: [offered(1)], lookalikes: [offered(2)] }))).toBe(
      "1 other colour of this same piece of armour, and 1 look near enough to be worth your eye",
    );
  });

  // The exact half can land while the pictures are still being decoded, and a reader looking at
  // it should know there is more coming rather than think that is the whole answer.
  it("says the pictures are still coming beside whatever the geometry already found", () => {
    expect(alternativesSummary(payload({ sameMesh: [offered(1)], lookalikesReady: false }))).toBe(
      "1 other colour of this same piece of armour · still reading the game's own textures, " +
        "which takes about a minute once per patch",
    );
  });
});
