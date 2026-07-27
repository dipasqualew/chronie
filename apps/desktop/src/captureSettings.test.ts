import { describe, expect, it } from "vitest";

import {
  ALL_TRIGGERS, CAPTURE_QUALITIES, DEFAULT_QUALITY, TRIGGER_GROUPS,
  supersededBy, toggleTrigger, triggerSentence, unknownTriggers,
} from "./captureSettings";
import type { CaptureQuality } from "./types";

const named = (name: string) => {
  const found = ALL_TRIGGERS.find((trigger) => trigger.name === name);
  if (!found) throw new Error(`no trigger called ${name}`);
  return found;
};

describe("the catalogue of rules", () => {
  // The names cross into a Lua file the game executes, and the backend drops anything that is
  // not a plain name on the way. A label invented here with a space in it would reach the
  // settings file, be silently dropped, and leave a box that does nothing.
  it("names every rule the way the addon and the backend will accept", () => {
    for (const trigger of ALL_TRIGGERS) {
      expect(trigger.name, trigger.label).toMatch(/^[A-Za-z]+$/);
    }
  });

  it("names each rule once", () => {
    const names = ALL_TRIGGERS.map((trigger) => trigger.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // A narrower rule that points at a broader one this build does not have would leave the
  // "already covered by" line unable to name what covers it.
  it("points every narrower rule at a broader one that exists", () => {
    const names = new Set(ALL_TRIGGERS.map((trigger) => trigger.name));
    for (const trigger of ALL_TRIGGERS) {
      if (trigger.narrows) expect(names, trigger.name).toContain(trigger.narrows);
    }
  });

  it("gives every rule a label and a line saying what it costs", () => {
    for (const trigger of ALL_TRIGGERS) {
      expect(trigger.label.length, trigger.name).toBeGreaterThan(0);
      expect(trigger.detail.length, trigger.name).toBeGreaterThan(0);
    }
  });

  it("puts every rule in exactly one group", () => {
    const grouped = TRIGGER_GROUPS.flatMap((group) => group.triggers);
    expect(grouped).toHaveLength(ALL_TRIGGERS.length);
  });

  // The three the issue asks for by name, plus the one this change added. Named individually
  // rather than counted, because a rename on either side of the boundary is the failure.
  it.each([
    "accountFirstAchievement",
    "achievement",
    "mount",
    "newAppearance",
  ])("offers %s", (name) => {
    expect(named(name)).toBeDefined();
  });
});

describe("a broader rule covering a narrower one", () => {
  // The addon offers a moment to the narrow rule first and the broad one second, so allowing
  // the broad one already photographs everything the narrow one would.
  it.each<[string, string]>([
    ["accountFirstAchievement", "achievement"],
    ["newAppearance", "transmog"],
    ["keystoneOnTime", "keystone"],
  ])("says %s is already covered when %s is on", (narrow, broad) => {
    expect(supersededBy(named(narrow), [narrow, broad])?.name).toBe(broad);
  });

  it("says nothing when only the narrow rule is on", () => {
    expect(supersededBy(named("accountFirstAchievement"), ["accountFirstAchievement"])).toBeNull();
  });

  it("says nothing about a rule with nothing above it", () => {
    expect(supersededBy(named("mount"), ["mount", "achievement", "transmog"])).toBeNull();
  });
});

describe("turning one rule on or off", () => {
  it("adds a rule without disturbing the others", () => {
    expect(toggleTrigger(["mount"], "levelUp", true)).toEqual(["mount", "levelUp"]);
  });

  it("removes only the rule asked about", () => {
    expect(toggleTrigger(["mount", "levelUp"], "mount", false)).toEqual(["levelUp"]);
  });

  it("is a no-op for a rule that is already where it is being put", () => {
    expect(toggleTrigger(["mount"], "mount", true)).toEqual(["mount"]);
    expect(toggleTrigger(["mount"], "levelUp", false)).toEqual(["mount"]);
  });

  // The panel writes the whole list from its own boxes, so anything it has no box for would
  // vanish the first time somebody ticked something — and the settings file can be edited by
  // hand, and a newer addon may know rules this window does not.
  it("carries a rule this build has no box for through untouched", () => {
    expect(toggleTrigger(["mount", "somethingNewer"], "levelUp", true))
      .toEqual(["mount", "levelUp", "somethingNewer"]);
    expect(toggleTrigger(["mount", "somethingNewer"], "mount", false))
      .toEqual(["somethingNewer"]);
  });

  // The catalogue's order rather than the click order, so ticking two boxes in either sequence
  // writes the same file and a settings file does not reshuffle itself on every change.
  it("writes the rules in the catalogue's order however they were clicked", () => {
    const one = toggleTrigger(toggleTrigger([], "mount", true), "achievement", true);
    const other = toggleTrigger(toggleTrigger([], "achievement", true), "mount", true);
    expect(one).toEqual(other);
    expect(one.indexOf("achievement")).toBeLessThan(one.indexOf("mount"));
  });

  it("finds the names this build has no rule for", () => {
    expect(unknownTriggers(["mount", "somethingNewer"])).toEqual(["somethingNewer"]);
    expect(unknownTriggers(["mount"])).toEqual([]);
  });
});

describe("what the panel says about the rules", () => {
  it("says nothing is automatic, and that the key still works", () => {
    expect(triggerSentence([])).toContain("photographs nothing by itself");
    expect(triggerSentence([])).toContain("keybinding still works");
  });

  it("counts the rules that are on", () => {
    expect(triggerSentence(["mount"])).toContain("one kind of moment");
    expect(triggerSentence(["mount", "levelUp"])).toContain("2 kinds of moment");
  });

  // The answer to the question a broad rule immediately raises. It belongs in the sentence
  // rather than in a note somewhere else on the page.
  it("says how often an automatic screenshot can happen at all", () => {
    expect(triggerSentence(["achievement"])).toContain("at most one a minute");
  });

  it("does not count a name this build has no rule for", () => {
    expect(triggerSentence(["somethingNewer"])).toContain("photographs nothing by itself");
  });
});

describe("the storage levels", () => {
  it("offers exactly the four the backend knows", () => {
    const expected: CaptureQuality[] = ["original", "high", "balanced", "small"];
    expect(CAPTURE_QUALITIES.map((choice) => choice.value)).toEqual(expected);
  });

  // Not "acceptable quality, least space" by accident: the default is a re-encode, and the
  // level that keeps the client's own file is a deliberate choice somebody makes.
  it("defaults to a re-encode rather than to the game's own file", () => {
    expect(DEFAULT_QUALITY).toBe("balanced");
    expect(DEFAULT_QUALITY).not.toBe("original");
  });

  // "Balanced" says nothing on its own to somebody deciding what to do with years of
  // screenshots. The two levels that change the size say what they change it to, and the
  // numbers are the ones `captures::Quality` actually encodes at.
  it("says what the levels that change the size change it to", () => {
    const detail = (value: CaptureQuality): string =>
      CAPTURE_QUALITIES.find((choice) => choice.value === value)?.detail ?? "";
    expect(detail("balanced")).toContain("2560");
    expect(detail("small")).toContain("1600");
    expect(detail("high")).toContain("Every pixel");
    expect(detail("original")).toContain("Every pixel");
  });
});
