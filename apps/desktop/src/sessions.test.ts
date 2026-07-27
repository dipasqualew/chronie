import { describe, expect, it } from "vitest";
import { SESSION_GAP_SECONDS, buildSessions, charactersIn, highlights } from "./sessions";
import type { Session } from "./sessions";
import type { Segment } from "./types";

const HOUR = 3600;
const BASE = 1_785_000_000;

let nextSegmentId = 0;

/** A segment with only the fields a test cares about; everything else stays empty. */
function segment(overrides: Partial<Segment> = {}): Segment {
  nextSegmentId += 1;
  const startedAt = overrides.startedAt ?? BASE;
  const seconds = overrides.seconds ?? 600;
  return {
    segmentId: nextSegmentId,
    id: `synthetic-${nextSegmentId}`,
    character: "Aster-Vale",
    classFile: "MAGE",
    level: null,
    day: "2026-07-26",
    instance: "Glass Caverns",
    difficulty: "",
    instanceType: "none",
    startedAt,
    endedAt: startedAt + seconds,
    seconds,
    lootValue: 0,
    goldDiff: 0,
    housingXP: 0,
    activities: [],
    encounters: [],
    transmogs: [],
    currencies: [],
    reputation: [],
    achievements: [],
    levelUps: [],
    mounts: [],
    pets: [],
    quests: [],
    toys: [],
    housingItems: [],
    housingLevelUps: [],
    ...overrides,
  };
}

const kinds = (session: Session): string[] => session.highlights.map((entry) => entry.kind);

describe("buildSessions", () => {
  it("keeps segments separated by less than the gap in one session", () => {
    const first = segment({ startedAt: BASE, seconds: 600 });
    const second = segment({ startedAt: BASE + 600 + 120, seconds: 600 });

    const sessions = buildSessions([second, first]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.map((entry) => entry.segmentId)).toEqual([
      first.segmentId,
      second.segmentId,
    ]);
  });

  it("starts a new session once the silence is longer than the gap", () => {
    const evening = segment({ startedAt: BASE, seconds: 600 });
    const later = segment({ startedAt: BASE + 600 + SESSION_GAP_SECONDS + 1, seconds: 600 });

    expect(buildSessions([evening, later])).toHaveLength(2);
  });

  // Exactly five minutes is still the same evening: the rule is "more than five minutes
  // apart", and a boundary that flips one second early splits sessions arbitrarily.
  it("treats a gap of exactly the threshold as the same session", () => {
    const first = segment({ startedAt: BASE, seconds: 600 });
    const second = segment({ startedAt: BASE + 600 + SESSION_GAP_SECONDS, seconds: 600 });

    expect(buildSessions([first, second])).toHaveLength(1);
  });

  it("hands sessions back newest first, whatever order they arrived in", () => {
    const early = segment({ startedAt: BASE, seconds: 600 });
    const late = segment({ startedAt: BASE + 5 * HOUR, seconds: 600 });

    const sessions = buildSessions([early, late]);

    expect(sessions[0].startedAt).toBe(late.startedAt);
    expect(sessions[1].startedAt).toBe(early.startedAt);
  });

  it("keeps an evening whole across a change of character", () => {
    const main = segment({ startedAt: BASE, seconds: 600, character: "Aster-Vale" });
    const alt = segment({ startedAt: BASE + 660, seconds: 600, character: "Brin-Hearth" });

    const [session] = buildSessions([main, alt]);

    expect(session.segments).toHaveLength(2);
    expect(session.characters.map((entry) => entry.name)).toContain("Brin-Hearth");
  });

  // A short segment nested inside a long one must not make the session look finished: the
  // frontier is the latest end seen, not the end of whichever segment came last by start.
  it("does not split a session on a segment that ended before an earlier one", () => {
    const long = segment({ startedAt: BASE, seconds: 2 * HOUR });
    const brief = segment({ startedAt: BASE + 60, seconds: 60 });
    const after = segment({ startedAt: BASE + 2 * HOUR + 60, seconds: 600 });

    expect(buildSessions([long, brief, after])).toHaveLength(1);
  });

  it("reports played time and elapsed span as different numbers", () => {
    const first = segment({ startedAt: BASE, seconds: 600 });
    const second = segment({ startedAt: BASE + 600 + 120, seconds: 600 });

    const [session] = buildSessions([first, second]);

    expect(session.playedSeconds).toBe(1200);
    expect(session.spanSeconds).toBe(1320);
  });

  it("has nothing to show for no segments", () => {
    expect(buildSessions([])).toEqual([]);
    expect(buildSessions(undefined)).toEqual([]);
  });
});

describe("charactersIn", () => {
  it("orders the cast by time played and keeps the level they finished on", () => {
    const cast = charactersIn([
      segment({ character: "Brin-Hearth", classFile: "DRUID", seconds: 300, level: 8 }),
      segment({ character: "Aster-Vale", classFile: "MAGE", seconds: 900, level: 11 }),
      segment({ character: "Aster-Vale", classFile: "MAGE", seconds: 600, level: 12, instance: "Copperwood" }),
    ]);

    expect(cast.map((entry) => entry.name)).toEqual(["Aster-Vale", "Brin-Hearth"]);
    expect(cast[0]).toMatchObject({ seconds: 1500, segmentCount: 2, level: 12, classFile: "MAGE" });
    expect(cast[0].places).toEqual(["Glass Caverns", "Copperwood"]);
  });
});

describe("highlights", () => {
  it("leads with the achievements and milestones over the running totals", () => {
    const [session] = buildSessions([
      segment({
        goldDiff: 50_000,
        lootValue: 120_000,
        achievements: [{ id: 9, name: "Into the Light", accountFirst: true }],
        mounts: [{ id: 11, name: "Clockwork Glider" }],
      }),
    ]);

    expect(kinds(session).slice(0, 3)).toEqual(["achievement", "mount", "gold"]);
  });

  describe("equipment sets", () => {
    const raidSet = {
      setId: 3, name: "Raid", kind: "updated" as const, at: BASE + 60,
      items: [{ slot: 1, itemId: 101, itemLevel: 639, previousItemId: 100, previousItemLevel: 623 }],
    };

    it("names the set, what happened to it, and where the item level went", () => {
      const [session] = buildSessions([segment({ equipsetChanges: [raidSet] })]);

      const [chip] = session.highlights.filter((entry) => entry.kind === "equipset");
      expect(chip).toMatchObject({ label: "Raid updated", detail: "1 slot, +16 ilvl", count: 1 });
    });

    // One change has somewhere to go; the chip opens the run it happened in.
    it("points a single change at the segment it happened in", () => {
      const [segmentOne] = [segment({ equipsetChanges: [raidSet] })];
      const [session] = buildSessions([segmentOne]);

      const [chip] = session.highlights.filter((entry) => entry.kind === "equipset");
      expect(chip.segmentId).toBe(segmentOne.segmentId);
    });

    it("folds an evening of fiddling into one chip that says what shape it had", () => {
      const [session] = buildSessions([
        segment({
          equipsetChanges: [
            raidSet,
            { setId: 4, name: "Mythic+", kind: "created", at: BASE + 90, items: [] },
          ],
        }),
      ]);

      const [chip] = session.highlights.filter((entry) => entry.kind === "equipset");
      expect(chip).toMatchObject({
        label: "2 equipment set changes",
        detail: "1 edited, 1 created or deleted",
        count: 2,
        segmentId: null,
      });
      expect(chip.items.map((item) => item.label)).toEqual(["Raid updated", "Mythic+ created"]);
    });

    it("is a milestone rather than one of the running totals", () => {
      const [session] = buildSessions([segment({ equipsetChanges: [raidSet] })]);

      const [chip] = session.highlights.filter((entry) => entry.kind === "equipset");
      expect(chip.family).toBe("milestone");
    });

    it("says nothing at all about a session where no set was touched", () => {
      const [session] = buildSessions([segment()]);

      expect(kinds(session)).not.toContain("equipset");
    });
  });

  // Twelve achievements is one thing to read — "it was that kind of evening" — and twelve
  // things to look at afterwards. The summary says the first; its entries hold the second.
  it("counts a kind into one summary rather than naming every one of them", () => {
    const [session] = buildSessions([
      segment({
        achievements: [
          { id: 1, name: "Just Me", accountFirst: false },
          { id: 2, name: "Warband First", accountFirst: true },
          { id: 3, name: "Also Just Me", accountFirst: false },
        ],
      }),
    ]);

    const earned = session.highlights.filter((entry) => entry.kind === "achievement");
    expect(earned).toHaveLength(1);
    expect(earned[0]).toMatchObject({ label: "3 achievements", detail: "1 account first", count: 3 });
  });

  it("names the one thing rather than counting it, when there is only one", () => {
    const [session] = buildSessions([
      segment({ achievements: [{ id: 1, name: "Into the Light", accountFirst: true }] }),
    ]);

    expect(session.highlights[0]).toMatchObject({ label: "Into the Light", detail: "account first" });
  });

  // An account first is the rare one, so it leads the list a summary comes apart into: the
  // reader opening twelve achievements wants the notable one at the top of them.
  it("puts an account first ahead of a character first inside the summary", () => {
    const [session] = buildSessions([
      segment({
        achievements: [
          { id: 1, name: "Just Me", accountFirst: false },
          { id: 2, name: "Warband First", accountFirst: true },
        ],
      }),
    ]);

    expect(session.highlights[0].items.map((item) => item.label)).toEqual(["Warband First", "Just Me"]);
    expect(session.highlights[0].items[0].detail).toBe("account first");
  });

  // Three level ups in an evening is one story — "I got to 12" — not three chips fighting
  // for the same row. The levels passed through on the way are in the list, not the chip.
  it("collapses a character's level ups into the level they reached", () => {
    const [session] = buildSessions([
      segment({ startedAt: BASE, levelUps: [{ level: 10 }, { level: 11 }] }),
      segment({ startedAt: BASE + 700, levelUps: [{ level: 12 }] }),
    ]);

    const levels = session.highlights.filter((entry) => entry.kind === "levelUp");
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ label: "3 levels", detail: "now 12", count: 3 });
    expect(levels[0].items.map((item) => item.label)).toEqual(["Level 10", "Level 11", "Level 12"]);
  });

  // The card names the cast a line above the summary, and a segment row names its one
  // character in its own heading; repeating it on the chip only takes up the row.
  it("names the character on a summary only where somebody else played too", () => {
    const alone = buildSessions([segment({ levelUps: [{ level: 12 }] })]);
    const shared = buildSessions([
      segment({ startedAt: BASE, character: "Aster-Vale", levelUps: [{ level: 11 }, { level: 12 }] }),
      segment({ startedAt: BASE + 700, character: "Brin-Hearth" }),
    ]);

    expect(alone[0].highlights[0]).toMatchObject({ label: "Level 12", detail: "" });
    expect(shared[0].highlights[0]).toMatchObject({ label: "2 levels", detail: "Aster-Vale now 12" });
  });

  // With an alt in the evening too there is no single "now 12" to report, and the number of
  // characters is both all that fits and all that is meant.
  it("says how many characters levelled when it was more than one", () => {
    const [session] = buildSessions([
      segment({ startedAt: BASE, character: "Aster-Vale", levelUps: [{ level: 12 }] }),
      segment({ startedAt: BASE + 700, character: "Brin-Hearth", levelUps: [{ level: 8 }] }),
    ]);

    const levels = session.highlights.filter((entry) => entry.kind === "levelUp");
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ label: "2 levels", detail: "2 characters" });
    expect(levels[0].items.map((item) => item.character)).toEqual(["Aster-Vale", "Brin-Hearth"]);
  });

  // A summary is only worth reading if it can be taken apart again, and taking it apart
  // means knowing when each thing happened and which run to open to see the rest of it.
  it("keeps the time, the character and the segment of everything it counted", () => {
    const first = segment({ startedAt: BASE, mounts: [{ id: 11, name: "Clockwork Glider", at: BASE + 60 }] });
    const second = segment({
      startedAt: BASE + 700, character: "Brin-Hearth",
      mounts: [{ id: 12, name: "Dust Strider", at: BASE + 800 }],
    });
    const [session] = buildSessions([first, second]);

    expect(session.highlights.find((entry) => entry.kind === "mount")).toMatchObject({
      label: "2 mounts",
      items: [
        { label: "Clockwork Glider", detail: "", at: BASE + 60, character: "Aster-Vale", segmentId: first.segmentId },
        { label: "Dust Strider", detail: "", at: BASE + 800, character: "Brin-Hearth", segmentId: second.segmentId },
      ],
    });
  });

  // A mount the client had not loaded the name of is still a mount, and a summary that
  // dropped it would be counting one thing and listing none.
  it("falls back to the id for a thing the game never named", () => {
    const [session] = buildSessions([segment({ mounts: [{ id: 11 }, { id: 12 }] })]);

    expect(session.highlights[0].items.map((item) => item.label)).toEqual(["Mount 11", "Mount 12"]);
  });

  it("counts new appearances apart from the variants of things already owned", () => {
    const [session] = buildSessions([
      segment({
        transmogs: [
          { id: 1, newAppearance: true },
          { id: 2, newAppearance: true },
          { id: 3, newAppearance: false },
        ],
      }),
    ]);

    const transmog = session.highlights.find((entry) => entry.kind === "transmog");
    expect(transmog?.label).toBe("2 new appearances");
    expect(transmog?.detail).toBe("+1 variant");
  });

  it("still reports a session that only turned up variants", () => {
    const [session] = buildSessions([segment({ transmogs: [{ id: 3, newAppearance: false }] })]);

    expect(session.highlights.find((entry) => entry.kind === "transmog")).toMatchObject({
      label: "New transmog source",
      detail: "1 variant",
    });
  });

  it("sums a currency earned across several segments into one line", () => {
    const [session] = buildSessions([
      segment({ startedAt: BASE, currencies: [{ id: 7, name: "Glass Token", amount: 4 }] }),
      segment({ startedAt: BASE + 700, currencies: [{ id: 7, name: "Glass Token", amount: 6 }] }),
    ]);

    const currency = session.highlights.filter((entry) => entry.kind === "currency");
    expect(currency).toHaveLength(1);
    expect(currency[0]).toMatchObject({ label: "Glass Token", value: 10 });
  });

  it("sums reputation by faction", () => {
    const [session] = buildSessions([
      segment({ startedAt: BASE, reputation: [{ faction: "Cartographers", amount: 25 }] }),
      segment({ startedAt: BASE + 700, reputation: [{ faction: "Cartographers", amount: 75 }] }),
    ]);

    expect(session.highlights.find((entry) => entry.kind === "reputation")).toMatchObject({
      label: "Cartographers",
      value: 100,
    });
  });

  it("offers the segment a milestone came from so it can be opened", () => {
    const only = segment({ mounts: [{ id: 11, name: "Clockwork Glider" }] });
    const [session] = buildSessions([only]);

    expect(session.highlights.find((entry) => entry.kind === "mount")?.segmentId).toBe(only.segmentId);
  });

  // Sending a click to whichever segment happened to be first would be a lie about where
  // the thing came from, so a total spanning segments simply is not clickable.
  it("offers no segment for a total that spans several", () => {
    const [session] = buildSessions([
      segment({ startedAt: BASE, quests: [{ id: 1 }] }),
      segment({ startedAt: BASE + 700, quests: [{ id: 2 }] }),
    ]);

    const quests = session.highlights.find((entry) => entry.kind === "quest");
    expect(quests?.label).toBe("2 quests");
    expect(quests?.segmentId).toBeNull();
  });

  it("says nothing at all about a quiet segment", () => {
    expect(highlights([segment()])).toEqual([]);
  });

  it("describes a single segment with the same rules as a whole session", () => {
    const one = segment({ goldDiff: -1200, toys: [{ id: 13, name: "Pocket Orrery" }] });

    expect(highlights([one]).map((entry) => entry.kind)).toEqual(["toy", "gold"]);
  });

  it("gives every highlight an icon and a family to draw it in", () => {
    const [session] = buildSessions([
      segment({ lootValue: 500, achievements: [{ id: 1, name: "Something" }] }),
    ]);

    expect(session.highlights.every((entry) => entry.icon && entry.family)).toBe(true);
    expect(session.highlights.map((entry) => entry.family)).toEqual(["milestone", "tally"]);
  });
});
