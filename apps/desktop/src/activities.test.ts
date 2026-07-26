import { describe, expect, it } from "vitest";
import {
  activityFields,
  activityLabel,
  activitySummary,
  fieldValue,
  isUncertain,
  parseMetadata,
} from "./activities";
import type { ActivityField, PartialActivity } from "./activities";
import type { ActivityMetadata, ActivitySource } from "./types";

const activity = (
  kind: string,
  metadata: ActivityMetadata,
  extra: PartialActivity = {},
): PartialActivity => ({
  kind,
  metadata,
  source: "inferred",
  confidence: 1,
  ...extra,
});

describe("activityLabel", () => {
  it("names a kind the app knows", () => {
    expect(activityLabel("mythic_plus")).toBe("Mythic+ run");
  });

  it.each<[string | undefined, string]>([
    ["transmog_farm", "Transmog farm"],
    ["pet-battles", "Pet battles"],
    ["", "Activity"],
    [undefined, "Activity"],
  ])("makes %s readable as %s", (kind, expected) => {
    expect(activityLabel(kind)).toBe(expected);
  });
});

describe("activitySummary", () => {
  it("leads a keystone run with its level and whether it beat the timer", () => {
    expect(
      activitySummary(
        activity("mythic_plus", {
          keystoneLevel: 14,
          dungeon: "Halls of Atonement",
          timed: true,
        }),
      ),
    ).toBe("+14 · Halls of Atonement · timed");
  });

  // A missing level must never read as "+0": that is a real keystone level, and the two
  // states mean completely different things to someone scanning their history.
  it("says the level is unknown rather than showing a zero", () => {
    const summary = activitySummary(activity("mythic_plus", { dungeon: "Mists" }));
    expect(summary).toContain("level unknown");
    expect(summary).not.toContain("+0");
  });

  it("calls out a depleted key", () => {
    expect(activitySummary(activity("mythic_plus", { keystoneLevel: 9, timed: false })))
      .toContain("depleted");
  });

  it("prefers 'abandoned' over the timer for a run that never finished", () => {
    const summary = activitySummary(
      activity("mythic_plus", { keystoneLevel: 9, completed: false, timed: false }),
    );
    expect(summary).toContain("abandoned");
    expect(summary).not.toContain("depleted");
  });

  it.each<[number, string]>([
    [1, "1 boss"],
    [3, "3 bosses"],
    [0, "0 bosses"],
  ])("pluralises %i boss kills as %s", (bossesKilled, expected) => {
    expect(activitySummary(activity("progress_raid", { bossesKilled }))).toContain(expected);
  });

  it("mentions wipes only when there were any", () => {
    expect(activitySummary(activity("legacy_raid", { bossesKilled: 2, wipes: 0 })))
      .not.toContain("wipe");
    expect(activitySummary(activity("legacy_raid", { bossesKilled: 2, wipes: 1 })))
      .toContain("1 wipe");
  });

  it("reports levelling as a fraction of a level", () => {
    expect(
      activitySummary(activity("levelling", { percentOfLevel: 42.5, levelsGained: 0 })),
    ).toBe("42.5% of a level");
  });

  it("falls back to the raw metadata for a kind the app does not know", () => {
    expect(activitySummary(activity("transmog_farm", { target: "Val'anyr" })))
      .toBe("target: Val'anyr");
  });

  it("survives an activity with no metadata at all", () => {
    expect(activitySummary({ kind: "levelling" })).toBe("");
    expect(activitySummary(undefined)).toBe("");
  });
});

describe("isUncertain", () => {
  it.each<[ActivitySource, number, boolean]>([
    ["inferred", 0.5, true],
    ["inferred", 0.9, false],
    ["inferred", 1, false],
    ["manual", 0.4, false],
  ])("marks a %s guess at confidence %s as %s", (source, confidence, expected) => {
    expect(isUncertain({ source, confidence })).toBe(expected);
  });
});

describe("parseMetadata", () => {
  it("reads the fields the kind declares and ignores the rest", () => {
    expect(
      parseMetadata("mythic_plus", {
        dungeon: "Mists of Tirna Scithe",
        keystoneLevel: "12",
        timed: "yes",
        nonsense: "ignored",
      }),
    ).toEqual({ dungeon: "Mists of Tirna Scithe", keystoneLevel: 12, timed: true });
  });

  // Clearing a field has to mean "I do not know", never "zero" — a stored 0 would claim a
  // +0 key or a raid where nothing died, both of which are assertions the user never made.
  it.each<[string]>([["keystoneLevel"], ["upgrades"], ["durationSeconds"]])(
    "drops %s entirely when it is cleared",
    (key) => {
      expect(parseMetadata("mythic_plus", { [key]: "" })).toEqual({});
    },
  );

  it("drops a number that will not parse", () => {
    expect(parseMetadata("mythic_plus", { keystoneLevel: "twelve" })).toEqual({});
  });

  it("keeps a genuine zero the user typed", () => {
    expect(parseMetadata("progress_raid", { bossesKilled: "0" })).toEqual({ bossesKilled: 0 });
  });

  it("leaves a boolean unset unless it was actually chosen", () => {
    expect(parseMetadata("mythic_plus", { timed: "" })).toEqual({});
    expect(parseMetadata("mythic_plus", { timed: "no" })).toEqual({ timed: false });
  });

  it("stores nothing for a kind with no declared fields", () => {
    expect(parseMetadata("transmog_farm", { whatever: "value" })).toEqual({});
    expect(activityFields("transmog_farm")).toEqual([]);
  });
});

describe("fieldValue", () => {
  const timed: ActivityField = { key: "timed", label: "Beat the timer", type: "boolean" };
  const level: ActivityField = { key: "keystoneLevel", label: "Keystone level", type: "number" };

  it("renders a boolean as a yes/no choice", () => {
    expect(fieldValue({ metadata: { timed: true } }, timed)).toBe("yes");
    expect(fieldValue({ metadata: { timed: false } }, timed)).toBe("no");
  });

  it("renders an unset field as empty, so it stays unknown", () => {
    expect(fieldValue({ metadata: {} }, timed)).toBe("");
    expect(fieldValue({ metadata: { keystoneLevel: null } }, level)).toBe("");
    expect(fieldValue(undefined, level)).toBe("");
  });

  it("renders a zero as a zero rather than as empty", () => {
    expect(fieldValue({ metadata: { keystoneLevel: 0 } }, level)).toBe("0");
  });
});
