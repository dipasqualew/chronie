/**
 * The subtraction, and the hedges it is only allowed to be stated under.
 *
 * Everything in `collection.ts` is pure and takes its two payloads as arguments, so nothing here
 * mocks anything: a census literal and a catalogue literal are the whole of the world these rules
 * live in. What is worth testing is not the arithmetic — it is the one rule the feature turns on,
 * that an absence means a removal only inside a reading that says it is complete, and the several
 * places where an honest "we do not know" has to survive contact with a number.
 */

import { describe, expect, it } from "vitest";

import {
  ACHIEVEMENTS,
  MOUNTS,
  UNFILED,
  achievementProgress,
  byCategory,
  byYear,
  carriers,
  caveat,
  missingMounts,
  mountProgress,
  pointsEarned,
  readingEvidence,
  readingSentence,
  remaining,
  undated,
  verdictOf,
} from "./collection";
import type { Progress } from "./collection";
import type {
  AccountCensusPayload,
  CatalogueAchievement,
  CensusReading,
  CollectionCataloguePayload,
  EarnedAchievement,
} from "./types";

/** The moment every sentence below is reckoned from, so "4 days ago" is a fact and not a clock. */
const NOW = 1_785_000_000;

const DAY = 86_400;

/** A walk of one domain, spelled out only where a case actually depends on the field. */
const reading = (fields: Partial<CensusReading> = {}): CensusReading => ({
  domain: ACHIEVEMENTS,
  complete: true,
  revision: 4,
  held: 3,
  counted: 3,
  build: "12.0.5.67823",
  walkedBy: "Aster-Vale",
  startedAt: NOW - 4 * DAY - 60,
  completedAt: NOW - 4 * DAY,
  observedAt: NOW - 4 * DAY,
  ...fields,
});

const census = (fields: Partial<AccountCensusPayload> = {}): AccountCensusPayload => ({
  readings: [],
  achievements: [],
  mounts: [],
  ...fields,
});

const catalogue = (
  fields: Partial<CollectionCataloguePayload> = {},
): CollectionCataloguePayload => ({
  achievements: [],
  mounts: [],
  withheldAchievements: 0,
  withheldMounts: 0,
  ...fields,
});

const found = (
  fields: Partial<CatalogueAchievement> & Pick<CatalogueAchievement, "id">,
): CatalogueAchievement => ({
  title: `Achievement ${fields.id}`,
  description: "",
  category: ["Quests"],
  points: 10,
  iconFileDataId: 250000 + fields.id,
  faction: -1,
  ...fields,
});

const earned = (
  fields: Partial<EarnedAchievement> & Pick<EarnedAchievement, "id">,
): EarnedAchievement => ({ points: 10, ...fields });

/** The shape `caveat` and `remaining` are handed, with only the claim under test spelled out. */
const progress = (fields: Partial<Progress> = {}): Progress => ({
  held: 3,
  total: 6,
  withheld: 0,
  verdict: "whole",
  ...fields,
});

describe("what a reading is worth", () => {
  // The three states are the whole feature. Everything downstream is a number, and which of
  // these three it came out of decides whether that number may be subtracted from at all.
  it.each([
    ["nothing has ever walked it", null, "unwalked"],
    ["a walk was cut short", reading({ complete: false }), "partial"],
    ["a walk reached the end", reading({ complete: true }), "whole"],
  ] as const)("calls it %s", (_why, walk, verdict) => {
    expect(verdictOf(walk)).toBe(verdict);
  });
});

describe("caveat", () => {
  // A screen drawing this over an empty list would be claiming the account owns nothing, when
  // what it actually has is a list nobody has looked at.
  it("refuses to read an unwalked domain as an empty account", () => {
    expect(caveat(progress({ verdict: "unwalked" }))?.text).toContain(
      "Nothing has walked this yet",
    );
  });

  // The one that a logout produces every time a thirteen-thousand-call walk is interrupted, and
  // the reason no count off it may be presented as fact.
  it("marks what is left of an unfinished walk as an upper bound", () => {
    expect(caveat(progress({ verdict: "partial" }))?.text).toContain("upper bound");
  });

  // A whole reading still cannot answer for rows the install could not decrypt: they are in the
  // game's table, not in the total, and a reader has no other way of finding that out.
  it("still owns up to rows of the game's table it could not read", () => {
    const hedge = caveat(progress({ withheld: 2 }));

    expect(hedge?.text).toContain("2 rows");
    expect(hedge?.text).toContain("encrypted");
  });

  it("counts a single withheld row as a row rather than as rows", () => {
    expect(caveat(progress({ withheld: 1 }))?.text).toContain("1 row of");
  });

  // The distinction the view draws at two different volumes, and the reason it is a field rather
  // than something the component works out. A reading that did not finish means the number is
  // not what it looks like and somebody has to notice; rows the install could not decrypt mean
  // it is a little low, which is true of every install forever. Drawn alike, the second is a red
  // box that never changes — and that is how a reader learns to stop reading red boxes.
  it.each([
    ["nothing has ever walked it", progress({ verdict: "unwalked" }), true],
    ["a walk was cut short", progress({ verdict: "partial" }), true],
    ["the game withheld some of its own table", progress({ withheld: 2 }), false],
  ] as const)("calls it grave or not when %s", (_why, given, grave) => {
    expect(caveat(given)?.grave).toBe(grave);
  });

  // `null` is not the absence of an answer here — it is the claim that the subtraction under it
  // is sound, and the only condition under which the view draws a bare number.
  it("says nothing at all when the subtraction is sound", () => {
    expect(caveat(progress())).toBeNull();
  });
});

describe("readingSentence", () => {
  it("says what to do about a domain nothing has ever walked", () => {
    const sentence = readingSentence(null, NOW);

    expect(sentence).toContain("never walked this");
    expect(sentence).toContain("Log in with the addon installed");
  });

  // The load-bearing half of the sentence. A reader weighing a count off this walk has to be
  // told the walk stopped, in the same breath as the provenance, or the count reads as complete.
  it("says a walk did not finish, and that what it missed is unasked rather than gone", () => {
    const sentence = readingSentence(reading({ complete: false, completedAt: null }), NOW);

    expect(sentence).toContain("not to the end");
    expect(sentence).toContain("not missing, only unasked");
  });

  it("names who walked it, which build they were on, and how long ago", () => {
    const sentence = readingSentence(reading(), NOW);

    expect(sentence).toBe(
      "Read on Aster-Vale, on build 12.0.5.67823, 4 days ago, all the way through.",
    );
  });
});

describe("readingEvidence", () => {
  // The client's own counter is only news when it disagrees. A line repeating a number the line
  // above it already gave is a line readers learn to skip, and this one has to be read.
  it("says nothing about the client's counter when it agrees with what was written down", () => {
    expect(readingEvidence(reading({ held: 3, counted: 3 }))).toEqual([
      "3 written down, at revision 4.",
    ]);
  });

  // And when it disagrees it is the whole diagnosis: the walk is behind the game, which is
  // exactly the condition the addon's audit provokes a fresh walk on.
  it("says the reading is behind the game when the client counted more", () => {
    const lines = readingEvidence(reading({ held: 3, counted: 4_100 }));

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("4,100");
    expect(lines[1]).toContain("behind the game");
  });

  it("has nothing to show for a domain nothing has walked", () => {
    expect(readingEvidence(null)).toEqual([]);
  });
});

describe("what is held against what there is", () => {
  // The claim this module exists to protect. There is no install, so there is no total — and a
  // screen drawing "3 of 0, none left" would be stating something absurd where the honest answer
  // is "3, and nothing to hold them against".
  it("has no total and nothing left to get on a machine with no catalogue", () => {
    const held = achievementProgress(
      census({ achievements: [earned({ id: 1 })], readings: [reading()] }),
      null,
    );

    expect(held.total).toBeNull();
    expect(remaining(held)).toBeNull();
    expect(held.held).toBe(1);
  });

  it("subtracts the census from the catalogue when there is one", () => {
    const held = achievementProgress(
      census({ achievements: [earned({ id: 1 })], readings: [reading()] }),
      catalogue({ achievements: [found({ id: 1 }), found({ id: 2 })], withheldAchievements: 2 }),
    );

    expect(held).toEqual({ held: 1, total: 2, withheld: 2, verdict: "whole" });
    expect(remaining(held)).toBe(1);
  });

  // An account can hold more than this install can read, because some of the game's rows are
  // encrypted. "-3 still to get" is not a thing to put on a screen.
  it("never counts backwards when the account holds more than the catalogue names", () => {
    expect(remaining(progress({ held: 9, total: 6 }))).toBe(0);
  });

  // The two halves carry their own verdicts: the achievement walk finishing says nothing
  // whatever about the mount walk, and the fixture the whole feature is drawn from has one of
  // each.
  it("reads each domain's verdict off its own walk", () => {
    const both = census({
      readings: [reading({ domain: ACHIEVEMENTS }), reading({ domain: MOUNTS, complete: false })],
      mounts: [{ id: 6, favourite: true, hidden: false }],
    });

    expect(achievementProgress(both, null).verdict).toBe("whole");
    expect(
      mountProgress(both, catalogue({ mounts: [{ id: 6, name: "Brown Horse", source: "" }] })),
    ).toEqual({ held: 1, total: 1, withheld: 0, verdict: "partial" });
  });
});

describe("byCategory", () => {
  const tree = catalogue({
    achievements: [
      found({ id: 1, title: "Cheap", category: ["Chronicles", "Tideglass Deeps"], points: 0 }),
      found({ id: 2, title: "Rich", category: ["Chronicles", "Feats of Strength"], points: 25 }),
      found({ id: 3, title: "Alpha", category: ["Chronicles", "Tideglass Deeps"], points: 10 }),
      found({ id: 4, title: "Beta", category: ["Chronicles", "Tideglass Deeps"], points: 10 }),
      found({ id: 5, title: "Raided", category: ["Dungeons & Raids", "Lich King Raid"] }),
    ],
  });

  // The difference between fifteen rows a player recognises and four hundred they do not. The
  // innermost category is where the achievement really is; the outermost is where a reader
  // looking for it would start.
  it("groups by the outermost branch of the game's tree", () => {
    expect(byCategory(null, tree).map((row) => row.name)).toEqual([
      "Chronicles",
      "Dungeons & Raids",
    ]);
  });

  // Ranked by worth, which is the order somebody choosing what to do next wants — and which
  // sweeps the half of the real table worth nothing at all to the bottom rather than through.
  it("ranks what is left by points, breaking ties by title", () => {
    const [chronicles] = byCategory(null, tree);

    expect(chronicles.missing.map((row) => row.title)).toEqual(["Rich", "Alpha", "Beta", "Cheap"]);
  });

  // "Dungeons & Raids" is not a place anybody can go and look, so each row still has to name the
  // branch it actually sits in.
  it("names the innermost branch on each row it lists", () => {
    const [chronicles] = byCategory(null, tree);

    expect(chronicles.missing.map((row) => row.under)).toEqual([
      "Feats of Strength",
      "Tideglass Deeps",
      "Tideglass Deeps",
      "Tideglass Deeps",
    ]);
  });

  // An install that can read the achievement but not its category leaves the array empty, and a
  // row filed under `""` would sort to the top of the list as though it were a branch.
  it("files an achievement the game will not place under a name that says so", () => {
    const rows = byCategory(null, catalogue({ achievements: [found({ id: 9, category: [] })] }));

    expect(rows[0].name).toBe(UNFILED);
    expect(rows[0].missing[0].under).toBe(UNFILED);
  });

  it("counts what the account has against what the branch holds", () => {
    const [chronicles] = byCategory(census({ achievements: [earned({ id: 2 })] }), tree);

    expect(chronicles).toMatchObject({ held: 1, total: 4, points: 25, pointsTotal: 45 });
    expect(chronicles.missing.map((row) => row.title)).toEqual(["Alpha", "Beta", "Cheap"]);
  });

  // The census knows which ids it earned and nothing at all about the tree they hang in, so
  // there is nothing here to group. An empty list is the honest answer, not fifteen empty rows.
  it("has nothing to group without a catalogue", () => {
    expect(byCategory(census({ achievements: [earned({ id: 1 })] }), null)).toEqual([]);
  });
});

describe("pointsEarned", () => {
  // The earned total and the total available have to come out of the same book, or the fraction
  // between them means nothing — so the game's table wins over whatever the client had loaded.
  it("takes the catalogue's word over the client's when they disagree", () => {
    const total = pointsEarned(
      census({ achievements: [earned({ id: 1, points: 10 })] }),
      catalogue({ achievements: [found({ id: 1, points: 25 })] }),
    );

    expect(total).toBe(25);
  });

  // What a retired achievement comes back as: earned, absent from the current table, and still
  // worth what it was worth. Dropping it would quietly shrink somebody's history.
  it("falls back to the client's points for an achievement the catalogue no longer carries", () => {
    const total = pointsEarned(
      census({ achievements: [earned({ id: 1, points: 10 }), earned({ id: 2, points: 25 })] }),
      catalogue({ achievements: [found({ id: 1, points: 10 })] }),
    );

    expect(total).toBe(35);
  });

  it("counts an achievement neither book prices at nothing", () => {
    expect(pointsEarned(census({ achievements: [{ id: 7 }] }), null)).toBe(0);
  });
});

describe("carriers", () => {
  // The question the census pays for: one character's walk reports the whole account and names
  // the alt that did each, so nothing waits for a character nobody has logged into since 2011.
  it("ranks the roster by points, then by count, then by name", () => {
    const rows = carriers(
      census({
        achievements: [
          earned({ id: 1, points: 25, earnedBy: "Brin-Hearth" }),
          earned({ id: 2, points: 25, earnedBy: "Aster-Vale" }),
          earned({ id: 3, points: 10, earnedBy: "Aster-Vale" }),
          earned({ id: 4, points: 10, earnedBy: "Corrie-Vale" }),
          earned({ id: 5, points: 5, earnedBy: "Corrie-Vale" }),
          earned({ id: 6, points: 10, earnedBy: "Ash-Vale" }),
          earned({ id: 7, points: 5, earnedBy: "Ash-Vale" }),
        ],
      }),
      null,
    );

    expect(rows).toEqual([
      { character: "Aster-Vale", earned: 2, points: 35 },
      { character: "Brin-Hearth", earned: 1, points: 25 },
      { character: "Ash-Vale", earned: 2, points: 15 },
      { character: "Corrie-Vale", earned: 2, points: 15 },
    ]);
  });

  // An "Unknown" row would sort into the middle of that list as though it were somebody with a
  // name. What the client attributed to nobody is not a character.
  it("leaves out what the client named nobody for rather than inventing somebody", () => {
    const rows = carriers(
      census({
        achievements: [earned({ id: 1, earnedBy: "Aster-Vale" }), earned({ id: 2 })],
      }),
      null,
    );

    expect(rows).toEqual([{ character: "Aster-Vale", earned: 1, points: 10 }]);
  });

  it("prices each character's share out of the catalogue", () => {
    const rows = carriers(
      census({ achievements: [earned({ id: 1, points: 10, earnedBy: "Aster-Vale" })] }),
      catalogue({ achievements: [found({ id: 1, points: 25 })] }),
    );

    expect(rows[0].points).toBe(25);
  });
});

describe("byYear", () => {
  // The load-bearing one. A year nobody played is a fact about a person, and two adjacent bars
  // where there should be a hole is the chart telling them something that did not happen.
  it("fills in the years with nothing in them rather than skipping them", () => {
    const rows = byYear(
      census({
        achievements: [
          earned({ id: 1, points: 25, earnedOn: "2009-03-22" }),
          earned({ id: 2, points: 25, earnedOn: "2011-08-04" }),
          earned({ id: 3, points: 10, earnedOn: "2013-01-09" }),
        ],
      }),
      null,
    );

    expect(rows).toEqual([
      { year: 2009, earned: 1, points: 25 },
      { year: 2010, earned: 0, points: 0 },
      { year: 2011, earned: 1, points: 25 },
      { year: 2012, earned: 0, points: 0 },
      { year: 2013, earned: 1, points: 10 },
    ]);
  });

  // The oldest achievements come back with no date at all, and there is no year to put them in
  // that the client ever stated. Guessing one would put invented play on a real timeline.
  it("leaves out what the client dated at nothing, and counts it separately", () => {
    const walked = census({
      achievements: [
        earned({ id: 1, points: 25, earnedOn: "2009-03-22" }),
        earned({ id: 2, points: 10 }),
      ],
    });

    expect(byYear(walked, null)).toEqual([{ year: 2009, earned: 1, points: 25 }]);
    expect(undated(walked)).toBe(1);
  });

  it("has no years at all when nothing carries a date", () => {
    expect(byYear(census({ achievements: [earned({ id: 1 })] }), null)).toEqual([]);
  });
});

describe("missingMounts", () => {
  const stable = catalogue({
    mounts: [
      { id: 1601, name: "Tideglass Drake", source: "Drop: The Tidewarden" },
      { id: 6, name: "Brown Horse", source: "Vendor: Unger Statforth" },
      { id: 1602, name: "Unbroken Skystrider", source: "" },
    ],
  });

  // By name, because that and the source line are the whole of what the game will say about a
  // mount without a hop through `SpellMisc` this app does not make.
  it("names what is left alphabetically, and leaves out what is already ridden", () => {
    const left = missingMounts(
      census({ mounts: [{ id: 6, name: "Brown Horse", favourite: true, hidden: false }] }),
      stable,
    );

    expect(left).toEqual([
      { id: 1601, name: "Tideglass Drake", source: "Drop: The Tidewarden" },
      { id: 1602, name: "Unbroken Skystrider", source: "" },
    ]);
  });

  // The game's own table is the only thing that names a mount nobody owns, so without it there
  // is nothing to list — not "every mount", and not "none left".
  it("has nothing to list without a catalogue", () => {
    expect(missingMounts(census({ mounts: [] }), null)).toEqual([]);
  });
});
