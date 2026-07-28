import { describe, expect, it } from "vitest";
import {
  SESSION_GAP_SECONDS, activitiesIn, buildSessions, charactersIn, highlights,
} from "./sessions";
import type { Session } from "./sessions";
import type { Activity, Segment } from "./types";

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

describe("activitiesIn", () => {
  const key = (level: number, dungeon: string): Activity => ({
    id: level,
    kind: "mythic_plus",
    source: "inferred",
    confidence: 1,
    metadata: { keystoneLevel: level, dungeon },
  });

  it("lists what was done in the order it was done, whatever order the segments arrived in", () => {
    const done = activitiesIn([
      segment({ startedAt: BASE + 700, activities: [key(14, "Glass Caverns")] }),
      segment({ startedAt: BASE, activities: [key(9, "Copperwood Depths")] }),
    ]);

    expect(done.map((entry) => entry.activity.metadata.keystoneLevel)).toEqual([9, 14]);
  });

  // Four keys in an evening is four keys. This is the one thing on a session card that is
  // never folded into a count, because the count would throw away every level and dungeon
  // that made the four of them different runs.
  it("keeps every one of several runs of the same kind", () => {
    const done = activitiesIn([
      segment({ activities: [key(14, "Glass Caverns"), key(15, "Copperwood Depths")] }),
    ]);

    expect(done).toHaveLength(2);
  });

  it("carries the segment, the character and the class each one belongs to", () => {
    const only = segment({
      character: "Brin-Hearth", classFile: "DRUID", instance: "Copperwood Depths",
      activities: [key(9, "Copperwood Depths")],
    });

    expect(activitiesIn([only])[0]).toMatchObject({
      segmentId: only.segmentId,
      character: "Brin-Hearth",
      classFile: "DRUID",
      instance: "Copperwood Depths",
      at: only.startedAt,
    });
  });

  it("has nothing to list for an evening nobody labelled", () => {
    expect(activitiesIn([segment()])).toEqual([]);
  });

  it("hangs the evening's activities off the session itself", () => {
    const [session] = buildSessions([
      segment({ startedAt: BASE, activities: [key(14, "Glass Caverns")] }),
      segment({ startedAt: BASE + 700, activities: [key(9, "Copperwood Depths")] }),
    ]);

    expect(session.activities).toHaveLength(2);
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
          { id: 1, name: "Warband First", accountFirst: true },
          { id: 2, name: "Another First", accountFirst: true },
          { id: 3, name: "A Third First", accountFirst: true },
        ],
      }),
    ]);

    const earned = session.highlights.filter((entry) => entry.kind === "achievement");
    expect(earned).toHaveLength(1);
    expect(earned[0]).toMatchObject({ label: "3 achievements", detail: "account firsts", count: 3 });
    expect(earned[0].items.map((item) => item.label))
      .toEqual(["Warband First", "Another First", "A Third First"]);
  });

  it("names the one thing rather than counting it, when there is only one", () => {
    const [session] = buildSessions([
      segment({ achievements: [{ id: 1, name: "Into the Light", accountFirst: true }] }),
    ]);

    expect(session.highlights[0]).toMatchObject({ label: "Into the Light", detail: "account first" });
  });

  /**
   * An account first is the warband earning something for the first time; a character first is
   * one of its characters catching up with something the warband already had. Only the first is
   * news, and one summary counting both made an evening of catching up read as an evening of
   * rare ones — "3 achievements" for one thing worth telling somebody about.
   */
  describe("the two sorts of achievement", () => {
    const mixed = (): Segment => segment({
      achievements: [
        { id: 1, name: "Just Me", accountFirst: false },
        { id: 2, name: "Warband First", accountFirst: true },
        { id: 3, name: "Also Just Me", accountFirst: false },
      ],
    });

    // The rare one keeps its words and its place at the front; the catching up is a mark.
    it("counts them apart, and leads with the rarer of the two", () => {
      const [session] = buildSessions([mixed()]);

      expect(kinds(session)).toEqual(["achievement", "achievementCharacter"]);
    });

    it.each([
      ["the one worth telling somebody about", "achievement",
        { label: "Warband First", detail: "account first", count: 1 }],
      ["the two that only caught this character up", "achievementCharacter",
        { label: "2 achievements", detail: "character firsts", count: 2 }],
    ] as const)("words %s on its own", (_case, kind, expected) => {
      const [session] = buildSessions([mixed()]);

      expect(session.highlights.find((entry) => entry.kind === kind)).toMatchObject(expected);
    });

    it("keeps every one it counted, each saying which sort it was", () => {
      const [session] = buildSessions([mixed()]);

      const marked = session.highlights.find((entry) => entry.kind === "achievementCharacter");
      expect(marked?.items.map((item) => item.label)).toEqual(["Just Me", "Also Just Me"]);
      expect(marked?.items.map((item) => item.detail)).toEqual(["character first", "character first"]);
    });

    // A summary of a sort that did not happen is not an empty summary, it is no summary: a
    // mark reading "0 achievements" is a mark saying nothing happened.
    it.each([
      ["an evening of nothing but account firsts", true, "achievementCharacter"],
      ["an evening of nothing but catching up", false, "achievement"],
    ] as const)("says nothing of the other sort after %s", (_case, accountFirst, absent) => {
      const [session] = buildSessions([
        segment({ achievements: [{ id: 1, name: "Into the Light", accountFirst }] }),
      ]);

      expect(kinds(session)).not.toContain(absent);
    });
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

  /**
   * A brand new appearance is the collection growing; a variant is another colour of something
   * already owned. One summary counting both said "5 new appearances" for an evening that added
   * one — so they are counted apart, and the variants, a wardrobe tidied rather than grown, are
   * the quiet half.
   */
  describe("the two sorts of transmog", () => {
    const both = (): Segment => segment({
      transmogs: [
        { id: 1, name: "Wanderer's Mantle", newAppearance: true },
        { id: 2, name: "Tideglass Cowl", newAppearance: true },
        { id: 3, name: "Storm Cloak", newAppearance: false },
      ],
    });

    it("counts new appearances apart from the variants of things already owned", () => {
      const [session] = buildSessions([both()]);

      expect(kinds(session)).toEqual(["transmog", "transmogVariant"]);
    });

    // The new ones count rather than name: the number is the whole of what a collection
    // growing means, and the addon catches an id far more often than it catches a name.
    it.each([
      ["what the collection gained", "transmog",
        { label: "2 new appearances", detail: "", count: 2 }],
      ["what it merely recoloured", "transmogVariant",
        { label: "Storm Cloak", detail: "variant of one owned", count: 1 }],
    ] as const)("words %s on its own", (_case, kind, expected) => {
      const [session] = buildSessions([both()]);

      expect(session.highlights.find((entry) => entry.kind === kind)).toMatchObject(expected);
    });

    it("keeps every piece it counted, with the item behind it", () => {
      const [session] = buildSessions([both()]);

      const fresh = session.highlights.find((entry) => entry.kind === "transmog");
      expect(fresh?.items.map((item) => item.label)).toEqual(["Wanderer's Mantle", "Tideglass Cowl"]);
      expect(fresh?.items.map((item) => item.itemId)).toEqual([1, 2]);
    });

    // A mark's words are its hover, and there is room there for the piece itself — where
    // "1 variant" would be a hover worth nothing at all.
    it("still reports a session that only turned up variants, by naming the piece", () => {
      const [session] = buildSessions([
        segment({ transmogs: [{ id: 3, name: "Storm Cloak", newAppearance: false }] }),
      ]);

      expect(kinds(session)).toEqual(["transmogVariant"]);
      expect(session.highlights[0]).toMatchObject({
        label: "Storm Cloak",
        detail: "variant of one owned",
      });
    });

    // Several of them have no one piece to name, so the count is what is left to say — and
    // saying "variant of one owned" three times over would be saying it once too often.
    it("counts several variants instead of naming any of them", () => {
      const [session] = buildSessions([
        segment({
          transmogs: [
            { id: 3, name: "Storm Cloak", newAppearance: false },
            { id: 4, name: "Bramble Wrap", newAppearance: false },
          ],
        }),
      ]);

      expect(session.highlights[0]).toMatchObject({ label: "2 variants", detail: "", count: 2 });
    });

    // A source the client said nothing either way about is not a new appearance and not a
    // variant; counting it as either would be inventing the half of the record that is missing.
    it("puts a source the client said nothing about in neither", () => {
      expect(kinds(buildSessions([segment({ transmogs: [{ id: 3, name: "Storm Cloak" }] })])[0]))
        .toEqual([]);
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

  // A battle pet is the one collectible a player can hold several of, so a catch is only
  // news when the collection actually grew by it.
  describe("pets", () => {
    it("counts a pet caught for the first time as a collection growing", () => {
      const [session] = buildSessions([
        segment({ pets: [{ id: 456, name: "Darkmoon Rabbit", speciesFirst: true }] }),
      ]);

      expect(session.highlights.find((entry) => entry.kind === "pet")).toMatchObject({
        label: "Darkmoon Rabbit",
      });
    });

    it("says nothing about another of a species already owned", () => {
      const [session] = buildSessions([
        segment({ pets: [{ id: 456, name: "Darkmoon Rabbit", speciesFirst: false }] }),
      ]);

      expect(kinds(session)).not.toContain("pet");
    });

    it("counts only the new ones out of an evening of catching", () => {
      const [session] = buildSessions([
        segment({
          pets: [
            { id: 456, name: "Darkmoon Rabbit", speciesFirst: true },
            { id: 456, name: "Darkmoon Rabbit", speciesFirst: false },
            { id: 789, name: "Mossling", speciesFirst: true },
          ],
        }),
      ]);

      expect(session.highlights.find((entry) => entry.kind === "pet")).toMatchObject({
        label: "2 pets",
      });
    });

    // A catch from before the addon started asking is not a duplicate, it is unknown — and
    // dropping it would hide a pet that may well have been the first of its species.
    it("keeps a catch nothing could say either way about", () => {
      const [session] = buildSessions([
        segment({ pets: [{ id: 456, name: "Darkmoon Rabbit" }] }),
      ]);

      expect(session.highlights.find((entry) => entry.kind === "pet")).toMatchObject({
        label: "Darkmoon Rabbit",
      });
    });
  });

  // A vendor price for things mostly sold or disenchanted, agreeing with neither the wallet
  // beside it nor anything a player decided. The wallet is the number that means something.
  it("says nothing about what the loot was worth", () => {
    const [session] = buildSessions([segment({ lootValue: 120_000, goldDiff: 400 })]);

    expect(kinds(session)).toEqual(["gold"]);
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
      segment({ goldDiff: 500, achievements: [{ id: 1, name: "Something" }] }),
    ]);

    expect(session.highlights.every((entry) => entry.icon && entry.family)).toBe(true);
    expect(session.highlights.map((entry) => entry.family)).toEqual(["milestone", "tally"]);
  });

  /**
   * Which milestones are marked to be drawn as their icon alone. The flag is the whole of what
   * the view is told, so the rule about which things are not news lives here rather than in a
   * list of kinds kept beside the component — and they stay milestones either way, because a
   * quest handed in did happen and belongs on the card.
   */
  describe("the quiet milestones", () => {
    const summaryOf = (overrides: Partial<Segment>) => highlights([segment(overrides)])[0]!;

    it.each([
      ["a character catching up on one the warband already had",
        { achievements: [{ id: 1, name: "Into the Light", accountFirst: false }] }],
      ["another colour of a piece already owned",
        { transmogs: [{ id: 3, name: "Storm Cloak", newAppearance: false }] }],
      ["a quest handed in", { quests: [{ id: 81 }] }],
      ["a set of gear saved",
        { equipsetChanges: [{ setId: 3, name: "Raid", kind: "created" as const, items: [] }] }],
    ])("has nothing to say out loud about %s", (_case, overrides) => {
      expect(summaryOf(overrides)).toMatchObject({ quiet: true, family: "milestone" });
    });

    // The other side of the same rule: the things somebody would actually mention keep both
    // their words and their place up among the chips.
    it.each([
      ["the warband's first", { achievements: [{ id: 1, name: "Into the Light", accountFirst: true }] }],
      ["an appearance nobody owned",
        { transmogs: [{ id: 1, name: "Wanderer's Mantle", newAppearance: true }] }],
      ["a mount", { mounts: [{ id: 11, name: "Clockwork Glider" }] }],
      ["a level", { levelUps: [{ level: 12 }] }],
    ])("leaves %s its words", (_case, overrides) => {
      expect(summaryOf(overrides).quiet).toBeFalsy();
    });
  });
});
