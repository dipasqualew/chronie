import { describe, expect, it } from "vitest";

import { DEFAULT_RANGE, RANGES, WIDEST_RANGE, rangeOf, since, within } from "./characterRange";
import type { Segment } from "./types";

/** A fixed moment to reckon every range from, so nothing here depends on when it is run. */
const NOW = 1_800_000_000;
const DAY = 86_400;

const segment = (fields: Partial<Segment> = {}): Segment => ({
  segmentId: 1,
  id: "synthetic-1",
  character: "Aster-Vale",
  day: "2027-01-15",
  instance: "Glass Caverns",
  difficulty: "Normal",
  instanceType: "party",
  startedAt: NOW - DAY,
  endedAt: NOW - DAY + 1800,
  seconds: 1800,
  lootValue: 0,
  goldDiff: 0,
  housingXP: 0,
  ...fields,
});

describe("the ranges on offer", () => {
  it("opens on a fortnight, which is what the section is drawn for", () => {
    expect(rangeOf(DEFAULT_RANGE).days).toBe(14);
    expect(rangeOf(DEFAULT_RANGE).label).toBe("Last 2 weeks");
  });

  /** Every one of them is a phrase somebody would say out loud, and each key is used once. */
  it("names each of them once, shortest first", () => {
    expect(RANGES.map((range) => range.key)).toEqual([
      "week",
      "fortnight",
      "month",
      "quarter",
      "all",
    ]);
    expect(new Set(RANGES.map((range) => range.key)).size).toBe(RANGES.length);
  });

  it("reaches all the way back on the widest one and nowhere else", () => {
    expect(rangeOf(WIDEST_RANGE).days).toBeNull();
    expect(RANGES.filter((range) => range.days === null)).toHaveLength(1);
  });

  /**
   * A key nobody offers is a settings file or a stale link rather than a choice, and falling to
   * nothing would leave the section with no range at all to filter by.
   */
  it("falls back to the default rather than to nothing", () => {
    expect(rangeOf("last-tuesday").key).toBe(DEFAULT_RANGE);
    expect(rangeOf("").key).toBe(DEFAULT_RANGE);
  });
});

describe("where a range starts", () => {
  it.each([
    ["week", 7],
    ["fortnight", 14],
    ["month", 30],
    ["quarter", 90],
  ])("counts %s back as %i whole days from the moment given", (key, days) => {
    expect(since(rangeOf(key), NOW)).toBe(NOW - days * DAY);
  });

  it("starts nowhere for the range that has no start", () => {
    expect(since(rangeOf("all"), NOW)).toBeNull();
  });
});

describe("what a range holds", () => {
  it("keeps a segment inside it and drops one before it", () => {
    const inside = segment({ segmentId: 1, endedAt: NOW - 3 * DAY });
    const outside = segment({ segmentId: 2, endedAt: NOW - 40 * DAY });

    expect(within([inside, outside], rangeOf("fortnight"), NOW)).toEqual([inside]);
  });

  /**
   * A raid that began ten minutes before the window began is not a different fortnight's raid.
   * Judging on the start would drop exactly the longest sessions, which are the ones a reader
   * asking "what have I been doing" most wants to see.
   */
  it("keeps a night that began before the window and ended inside it", () => {
    const long = segment({ startedAt: NOW - 15 * DAY, endedAt: NOW - 13 * DAY });

    expect(within([long], rangeOf("fortnight"), NOW)).toEqual([long]);
  });

  /** A segment the addon never wrote an end for is still a segment, dated by its start. */
  it("falls back to when a segment started where nothing says it ended", () => {
    const unfinished = segment({ startedAt: NOW - 2 * DAY, endedAt: 0 });

    expect(within([unfinished], rangeOf("week"), NOW)).toEqual([unfinished]);
    expect(within([unfinished], rangeOf("week"), NOW + 30 * DAY)).toEqual([]);
  });

  it("hands back everything, in the order given, on the widest range", () => {
    const old = segment({ segmentId: 1, endedAt: NOW - 900 * DAY });
    const recent = segment({ segmentId: 2, endedAt: NOW - DAY });

    expect(within([old, recent], rangeOf("all"), NOW)).toEqual([old, recent]);
  });

  it("holds nothing where nothing happened in it", () => {
    expect(within([segment({ endedAt: NOW - 40 * DAY })], rangeOf("week"), NOW)).toEqual([]);
    expect(within([], rangeOf("all"), NOW)).toEqual([]);
  });
});
