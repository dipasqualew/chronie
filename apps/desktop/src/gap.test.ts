import { describe, expect, it } from "vitest";
import { gapEvidence, gapSentence } from "./gap";
import type { SessionGap } from "./types";

/** The moment every sentence below is reckoned from, so "yesterday" is a fact, not a clock. */
const NOW = 1_785_000_000;

const HOUR = 3600;

/** The shape the backend sends when an evening never reached the file. */
const missing = (recordedTo: number, playedTo: number): SessionGap => ({
  kind: "missing",
  gap: { recordedTo, playedTo, log: "WoWCombatLog-072612_183012.txt" },
});

describe("gapSentence", () => {
  // Three of the four answers say nothing at all, and this is the whole reason the notice is
  // worth having: a line that appeared every time somebody opened the window would be one
  // nobody read on the evening it mattered.
  it.each([
    ["nothing was comparable", { kind: "unknown" }],
    ["somebody is still playing", { kind: "live" }],
    ["the history is level with the log", { kind: "complete" }],
  ] as const)("says nothing when %s", (_why, gap) => {
    expect(gapSentence(gap as SessionGap, NOW)).toBeNull();
  });

  it("says nothing before the backend has answered at all", () => {
    expect(gapSentence(null, NOW)).toBeNull();
  });

  it("says how much play is missing and what proves it", () => {
    const sentence = gapSentence(missing(NOW - 5 * HOUR, NOW - 2 * HOUR), NOW);

    expect(sentence).toContain("missing up to 3h 00m");
    expect(sentence).toContain("still writing its combat log 2 hours ago");
    expect(sentence).toContain("last session it saved ended 5 hours ago");
  });

  // The sentence has to name the cause, because the reader's next question is always "did
  // Chronie lose this, or did I never play it" — and the answer is neither.
  it("names the thing that actually happened", () => {
    const sentence = gapSentence(missing(NOW - 5 * HOUR, NOW - 2 * HOUR), NOW);

    expect(sentence).toContain("crash or a force-quit");
  });
});

describe("gapEvidence", () => {
  it("names the file the claim was read out of", () => {
    const lines = gapEvidence(missing(NOW - 5 * HOUR, NOW - 2 * HOUR));

    expect(lines[0]).toContain("WoWCombatLog-072612_183012.txt");
    expect(lines[0]).toContain("Logs folder");
  });

  // The notice must not read as a prompt to go and press something. Nothing recovers a
  // session the game never wrote, and a reader left hunting for a Recover button would be
  // hunting for a button that cannot exist.
  it("says plainly that nothing brings the session back", () => {
    const lines = gapEvidence(missing(NOW - 5 * HOUR, NOW - 2 * HOUR));

    expect(lines.join(" ")).toContain("Nothing recovers those segments");
  });

  it.each([
    ["unknown"],
    ["live"],
    ["complete"],
  ] as const)("has nothing to show for a %s answer", (kind) => {
    expect(gapEvidence({ kind } as SessionGap)).toEqual([]);
  });

  it("has nothing to show before the backend has answered", () => {
    expect(gapEvidence(null)).toEqual([]);
  });
});
