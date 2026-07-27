import { describe, expect, it } from "vitest";
import { evidence, stateSentence } from "./combatLog";
import type { CombatLogStatus } from "./types";

/** The moment every sentence below is reckoned from, so "3 days ago" is a fact, not a clock. */
const NOW = 1_785_000_000;

const HOUR = 3600;
const DAY = 86_400;

/** An install doing the thing properly: asked for, ticked, and writing. */
const status = (overrides: Partial<CombatLogStatus> = {}): CombatLogStatus => ({
  requested: true,
  advanced: true,
  source: "WTF/Account/EXAMPLE/config-cache.wtf",
  log: { name: "WoWCombatLog-072612_183012.txt", bytes: 4_404_019, modified: NOW - HOUR },
  growing: true,
  state: "advanced",
  ...overrides,
});

describe("stateSentence", () => {
  it("says nothing is being written, and nothing costs, when the switch is off", () => {
    const sentence = stateSentence(status({ requested: false, state: "off", growing: false }), NOW);

    expect(sentence).toContain("Combat logging is off");
    expect(sentence).toContain("nothing is using disk");
  });

  // The setting and the install are two different facts, and this is the case where they
  // disagree. Saying only "off" here would have the panel deny a file that is growing on the
  // reader's own disk — which is the one thing a status line must never do.
  it("owns up to an install that is logging without Chronie having asked", () => {
    const sentence = stateSentence(status({ requested: false, state: "off", growing: true }), NOW);

    expect(sentence).toContain("writing a combat log anyway");
    expect(sentence).toContain("outside Chronie");
    expect(sentence).not.toContain("nothing is using disk");
  });

  // A log without the advanced flag has no positions in it, so it is useless for the thing
  // Chronie wants it for — and the fix is a box in the game, named here as the game names it.
  it("names the box to tick when logging is on without the advanced flag", () => {
    const sentence = stateSentence(status({ state: "basic", advanced: false, growing: false }), NOW);

    expect(sentence).toContain("advanced combat logging is off");
    expect(sentence).toContain("no positions");
    expect(sentence).toContain("Advanced Combat Logging");
    expect(sentence).toContain("Network");
    expect(sentence).not.toContain("could not read");
  });

  // Not knowing is its own answer. A config nothing could be read out of is the reason the
  // field is nullable at all, and reporting it as "off" would send a reader to tick a box
  // that may well already be ticked.
  it.each<[string, CombatLogStatus]>([
    ["a config that read back as nothing", status({ state: "basic", advanced: null, growing: false })],
    // The same install described by a backend that left the field out altogether.
    ["a status that never mentioned it", { requested: true, growing: false, state: "basic" }],
  ])("admits it cannot confirm the advanced flag given %s", (_case, unknown) => {
    const sentence = stateSentence(unknown, NOW);

    expect(sentence).toContain("could not read the game's settings");
    expect(sentence).toContain("cannot confirm advanced logging");
    expect(sentence).not.toContain("advanced combat logging is off");
  });

  it("simply confirms an install that is doing it properly", () => {
    expect(stateSentence(status(), NOW))
      .toBe("Advanced combat logging is on, and the game is writing to it.");
  });

  // How long ago is the whole content of this one: "nothing since Tuesday" is a problem and
  // "nothing for ten minutes" is a game that happens to be shut.
  it("carries how long a set-up install has been writing nothing", () => {
    const sentence = stateSentence(
      status({ state: "stale", growing: false, log: { name: "WoWCombatLog.txt", bytes: 12, modified: NOW - 3 * DAY } }),
      NOW,
    );

    expect(sentence).toContain("nothing has been written 3 days ago");
    expect(sentence).toContain("if you have been playing since, the game is not logging");
  });

  // A machine that will not date a file leaves nothing to reckon an age from, and reckoning
  // one from the epoch would put "20659 days ago" on screen — a number that is not only
  // wrong but reads as a catastrophe.
  it("admits it cannot date a log this machine will not date", () => {
    const sentence = stateSentence(
      status({
        state: "stale",
        growing: false,
        log: { name: "WoWCombatLog.txt", bytes: 12, modified: null },
      }),
      NOW,
    );

    expect(sentence).toContain("will not say when the log was last written");
    expect(sentence).not.toContain("ago");
  });

  it("says an install with no log at all has none, rather than dating one that does not exist", () => {
    const sentence = stateSentence(status({ state: "stale", growing: false, log: null }), NOW);

    expect(sentence).toContain("no combat log at all yet");
    expect(sentence).toContain("the next time you log in");
    expect(sentence).not.toContain("ago");
  });
});

describe("evidence", () => {
  it("names the newest log, its size and its age, so the sentence above can be checked", () => {
    expect(evidence(status(), NOW)[0])
      .toBe("Newest log: WoWCombatLog-072612_183012.txt — 4.2 MB, last written an hour ago.");
  });

  it("says outright when the game's Logs folder holds nothing", () => {
    expect(evidence(status({ log: null }), NOW)[0])
      .toBe("No combat log found in the game's Logs folder.");
  });

  // A filesystem that will not date a file still has one, and the row is worth keeping: the
  // name and the size are the two things a reader can go and look at.
  it("keeps a log a filesystem will not date, and says the date is what is missing", () => {
    expect(evidence(status({ log: { name: "WoWCombatLog.txt", bytes: 900, modified: null } }), NOW)[0])
      .toBe("Newest log: WoWCombatLog.txt — 900 bytes, with no date this machine will report.");
  });

  it.each<[boolean, string]>([
    [true, "Advanced logging reads on in WTF/Account/EXAMPLE/config-cache.wtf."],
    [false, "Advanced logging reads off in WTF/Account/EXAMPLE/config-cache.wtf."],
  ])("names the file the advanced flag was read out of, reading %s", (advanced, line) => {
    expect(evidence(status({ advanced }), NOW)[1]).toBe(line);
  });

  it("says the advanced flag is unknown when no config could be read", () => {
    expect(evidence(status({ source: null, advanced: null }), NOW)[1])
      .toBe("No game config could be read, so the advanced setting is unknown.");
  });
});
