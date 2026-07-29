import { describe, expect, it } from "vitest";

import { pileFiles, pileSize, sweepDetail, sweepSentence, windowDays } from "./retention";
import type { LogPile, LogRetention } from "./types";

/** The moment every "ago" below is reckoned from, so the words are facts rather than a clock. */
const NOW = 1_785_000_000;
const DAY = 86_400;

const pile = (overrides: Partial<LogPile> = {}): LogPile => ({
  count: 2,
  bytes: 402_653_184,
  files: [
    { name: "WoWCombatLog-071026_201500.txt", bytes: 268_435_456, modified: NOW - 30 * DAY },
    { name: "WoWCombatLog-071126_193000.txt", bytes: 134_217_728, modified: NOW - 29 * DAY },
  ],
  ...overrides,
});

const empty = (): LogPile => ({ count: 0, bytes: 0, files: [] });

const status = (overrides: Partial<LogRetention> = {}): LogRetention => ({
  enabled: false,
  days: 7,
  doomed: pile(),
  unread: empty(),
  unfinished: empty(),
  removed: [],
  ...overrides,
});

describe("windowDays", () => {
  it.each([
    ["a day is the floor", 0, 1],
    ["and so is a negative number somebody typed", -30, 1],
    ["a year is the ceiling", 4000, 365],
    ["an ordinary number is itself", 14, 14],
    ["a fraction is rounded rather than refused", 7.4, 7],
    ["and an empty box is the default rather than zero", Number.NaN, 7],
  ])("%s", (_case, typed, expected) => {
    expect(windowDays(typed)).toBe(expected);
  });
});

describe("sweepSentence", () => {
  // The whole decision, before the switch: what this would cost if it were on. A panel that
  // only said what it had already done would be reporting a choice nobody was offered.
  it("says what turning it on would delete while it is still off", () => {
    expect(sweepSentence(status())).toBe(
      "Chronie deletes no combat logs. Turning this on at 7 days would delete 2 logs, " +
        "384.0 MB on the next sync.",
    );
  });

  it("says so plainly when turning it on would delete nothing today", () => {
    expect(sweepSentence(status({ doomed: empty() }))).toContain("would delete nothing today");
  });

  it("says what is going once it is on", () => {
    expect(sweepSentence(status({ enabled: true, days: 30 }))).toBe(
      "Deleting combat logs Chronie has read once they are older than 30 days. " +
        "2 logs, 384.0 MB go on the next sync.",
    );
  });

  it("says nothing is waiting when the folder is already clear", () => {
    expect(sweepSentence(status({ enabled: true, doomed: empty() }))).toContain(
      "Nothing is waiting to be deleted.",
    );
  });

  it("counts one log as one log", () => {
    const one = pile({ count: 1, bytes: 1024, files: [] });
    expect(sweepSentence(status({ enabled: true, days: 1, doomed: one }))).toContain(
      "older than 1 day. 1 log, 1.0 KB go",
    );
  });
});

describe("sweepDetail", () => {
  // The pile that matters. Old, never read, never deleted — and worded as somebody's job
  // rather than as a statistic, because Chronie is not going to do anything about it.
  it("hands the un-ingested logs back to the reader rather than counting them quietly", () => {
    const lines = sweepDetail(status({ unread: pile({ count: 1, bytes: 1_073_741_824 }) }));

    expect(lines[0]).toContain("1 log, 1.0 GB");
    expect(lines[0]).toContain("never been read by Chronie");
    expect(lines[0]).toContain("These are never deleted. Removing them is yours to do.");
  });

  // Different words on purpose: this pile clears itself, and telling somebody to go and deal
  // with a file Chronie is halfway through reading would be telling them to do nothing.
  it("keeps a half-read log apart from one nothing has touched", () => {
    const lines = sweepDetail(status({ unfinished: pile({ count: 3, bytes: 3072 }) }));

    expect(lines[0]).toContain("3 logs, 3.0 KB");
    expect(lines[0]).toContain("only partly read");
    expect(lines[0]).toContain("will not delete one until it has finished");
  });

  // "Chronie deleted my logs" is unanswerable without this line.
  it("says what it last deleted, when, and how much of it had been read", () => {
    const lines = sweepDetail(
      status({
        removed: [
          {
            name: "WoWCombatLog-071026_201500.txt",
            bytes: 268_435_456,
            modified: NOW - 30 * DAY,
            linesRead: 412_009,
            retainDays: 7,
            deletedAt: NOW - 2 * DAY,
          },
        ],
      }),
      NOW,
    );

    expect(lines[0]).toBe(
      "Last deleted: WoWCombatLog-071026_201500.txt — 256.0 MB, 2 days ago, " +
        "after 412009 lines of it had been read.",
    );
  });

  it("says nothing at all about piles that are empty", () => {
    expect(sweepDetail(status())).toEqual([]);
  });
});

describe("pileFiles", () => {
  it("names each file with the size and the date the claim rests on", () => {
    expect(pileFiles(pile(), NOW)).toEqual([
      "WoWCombatLog-071026_201500.txt — 256.0 MB, last written 30 days ago.",
      "WoWCombatLog-071126_193000.txt — 128.0 MB, last written 29 days ago.",
    ]);
  });

  // Only ten names cross from the backend, so a folder with more than ten says so instead of
  // showing a tenth of itself as though that were all of it.
  it("admits to the ones it is not showing", () => {
    const lines = pileFiles(pile({ count: 42 }), NOW);

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("…and 40 others.");
  });

  it("says a file this machine will not date is undated rather than ancient", () => {
    const undated = pile({ files: [{ name: "WoWCombatLog.txt", bytes: 12, modified: null }] });

    expect(pileFiles(undated, NOW)[0]).toBe("WoWCombatLog.txt — 12 bytes, undated.");
  });
});

describe("pileSize", () => {
  it.each([
    ["one of each", 1, 1024, "1 log, 1.0 KB"],
    ["several", 9, 0, "9 logs, 0 bytes"],
    ["none", 0, 0, "0 logs, 0 bytes"],
  ])("%s", (_case, count, bytes, expected) => {
    expect(pileSize({ count, bytes, files: [] })).toBe(expected);
  });
});
