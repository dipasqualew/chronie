import { describe, expect, it } from "vitest";
import {
  activityFields,
  activityIcon,
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

  // A kind the app has not registered falls back to "Activity" and a bullet, so registering
  // one is exactly what buys it a name and a mark of its own in the history.
  it("names and marks a delve rather than falling back", () => {
    expect(activityLabel("delve")).toBe("Delve");
    expect(activityIcon("delve")).toBe("🕳️");
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

  it("leads a prey hunt with what was hunted and how hard it was", () => {
    expect(
      activitySummary(activity("prey", { title: "Gorgetusk", difficulty: "Heroic", huntsCompleted: 1 })),
    ).toBe("Gorgetusk · Heroic");
  });

  // The named hunt is the last of the segment, so a count is the only thing that keeps a
  // single title from reading as the whole evening.
  it("counts a segment's hunts only once there was more than one", () => {
    expect(activitySummary(activity("prey", { title: "Gorgetusk", huntsCompleted: 3 })))
      .toBe("Gorgetusk · 3 hunts");
  });

  it("leads a delve with the delve's own name and the tier it was run at", () => {
    expect(
      activitySummary(activity("delve", { delve: "Fungal Folly", tier: 8, completed: true })),
    ).toBe("Fungal Folly · tier 8");
  });

  // The tier is the whole of how hard a delve was — a tier 1 and a tier 11 Fungal Folly are
  // the same instance and nothing alike — so a missing one is said out loud rather than left
  // off, the same reading a keystone of unknown level gets.
  it("says the tier is unknown rather than leaving it off", () => {
    expect(activitySummary(activity("delve", { delve: "Kriegval's Rest" })))
      .toBe("Kriegval's Rest · tier unknown");
  });

  it("calls out a delve the player left part way through", () => {
    expect(activitySummary(activity("delve", { delve: "Fungal Folly", tier: 8, completed: false })))
      .toBe("Fungal Folly · tier 8 · left unfinished");
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

  // The two things the issue behind this kind asked to be kept, and both editable: a hunt is
  // recognised from a localised quest title, so a wrong reading is a thing a user can correct.
  it("offers a prey hunt's own name and difficulty as fields", () => {
    expect(parseMetadata("prey", { title: "Gorgetusk", difficulty: "Heroic" }))
      .toEqual({ title: "Gorgetusk", difficulty: "Heroic" });
  });

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
