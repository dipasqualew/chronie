import { describe, expect, it } from "vitest";
import { buildCharacters, byDay } from "./characters";
import type { AccountHoldings, Segment } from "./types";

const BASE = 1_785_000_000;

let nextSegmentId = 0;

/** A segment with only the fields a profile is folded from; everything else stays empty. */
function segment(overrides: Partial<Segment> = {}): Segment {
  nextSegmentId += 1;
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
    startedAt: BASE,
    endedAt: BASE + 600,
    seconds: 600,
    lootValue: 0,
    goldDiff: 0,
    housingXP: 0,
    ...overrides,
  };
}

/** One character's segments, oldest first, so a test can name only what it is about. */
const played = (character: string, parts: Array<Partial<Segment>>): Segment[] =>
  parts.map((part) => segment({ character, ...part }));

describe("buildCharacters", () => {
  it("folds a history into one profile per character", () => {
    const profiles = buildCharacters([
      ...played("Aster-Vale", [{ startedAt: BASE, endedAt: BASE + 600 }]),
      ...played("Brin-Hearth", [{ startedAt: BASE + 900, endedAt: BASE + 1500, classFile: "DRUID" }]),
      ...played("Aster-Vale", [{ startedAt: BASE + 1800, endedAt: BASE + 2400 }]),
    ]);

    expect(profiles.map((entry) => entry.name)).toEqual(["Aster-Vale", "Brin-Hearth"]);
    expect(profiles[0].segmentCount).toBe(2);
    expect(profiles[1].classFile).toBe("DRUID");
  });

  // Recency, not hours: the character somebody logged out of an hour ago is the one they
  // came back for, however much time the bank alt has technically accumulated.
  it("puts the most recently played first, however long the others were played for", () => {
    const profiles = buildCharacters([
      ...played("Long-Serving", [{ startedAt: BASE, endedAt: BASE + 36_000, seconds: 36_000 }]),
      ...played("Just-Now", [{ startedAt: BASE + 40_000, endedAt: BASE + 40_060, seconds: 60 }]),
    ]);

    expect(profiles.map((entry) => entry.name)).toEqual(["Just-Now", "Long-Serving"]);
  });

  it("adds up the numbers and remembers when they were first and last seen", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [
      { startedAt: BASE, endedAt: BASE + 600, seconds: 600, lootValue: 15_000, goldDiff: 900, day: "2026-07-25" },
      { startedAt: BASE + 86_400, endedAt: BASE + 87_600, seconds: 1200, lootValue: 5000, goldDiff: -1200, day: "2026-07-26" },
      // Same day as the one before it, so the day count is three segments over two days.
      { startedAt: BASE + 90_000, endedAt: BASE + 90_300, seconds: 300, day: "2026-07-26" },
    ]));

    expect(profile.seconds).toBe(2100);
    expect(profile.segmentCount).toBe(3);
    expect(profile.dayCount).toBe(2);
    expect(profile.firstSeen).toBe(BASE);
    expect(profile.lastSeen).toBe(BASE + 90_300);
    expect(profile.lootValue).toBe(20_000);
    expect(profile.goldDiff).toBe(-300);
  });

  it("keeps the segments newest first, which is the order the modal walks", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [
      { startedAt: BASE, instance: "First" },
      { startedAt: BASE + 600, instance: "Second" },
      { startedAt: BASE + 1200, instance: "Third" },
    ]));

    expect(profile.segments.map((entry) => entry.instance)).toEqual(["Third", "Second", "First"]);
  });

  // A level only ever goes up, and a segment recorded before the addon was reading one says
  // nothing rather than saying zero.
  it("takes the highest level ever seen, ignoring the segments that name none", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [
      { level: 11 },
      { level: null },
      { level: 12 },
    ]));

    expect(profile.level).toBe(12);
  });

  it("says nothing about the level of a character no segment has ever levelled", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [{ level: null }]));

    expect(profile.level).toBeNull();
  });

  // A class never changes, but a segment recorded before the addon collected one has none —
  // so the newest segment that names a class is the one to believe.
  it("believes the newest segment that names a class", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [
      { startedAt: BASE, classFile: null },
      { startedAt: BASE + 600, classFile: "MAGE" },
      { startedAt: BASE + 1200, classFile: null },
    ]));

    expect(profile.classFile).toBe("MAGE");
  });

  // Where the hours went, not where the most separate visits happen to have been recorded.
  it("names the places by the time spent in them", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [
      { instance: "Copperwood", seconds: 120 },
      { instance: "Copperwood", seconds: 120 },
      { instance: "Copperwood", seconds: 120 },
      { instance: "Glass Caverns", seconds: 1800 },
    ]));

    expect(profile.places).toEqual(["Glass Caverns", "Copperwood"]);
  });

  it("summarises everything the character ever earned", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [
      { mounts: [{ id: 11, name: "Clockwork Glider" }] },
      { levelUps: [{ level: 12 }] },
    ]));

    expect(profile.highlights.map((entry) => entry.label)).toContain("Clockwork Glider");
    expect(profile.highlights.map((entry) => entry.label)).toContain("Level 12");
  });
});

describe("buildCharacters against what the account holds", () => {
  const holdings: AccountHoldings = {
    currencies: [
      {
        id: 7,
        name: "Glass Token",
        total: 30_000,
        oldest: BASE,
        characters: [
          { character: "Aster-Vale", total: 12_450, at: BASE + 100 },
          { character: "Brin-Hearth", total: 17_550, at: BASE },
        ],
      },
      // Held by this character alone, and by more of it than the shared one — so it leads,
      // and it is the case where naming the account total would only repeat the line.
      {
        id: 8,
        name: "Rustward Scrip",
        total: 20_000,
        characters: [{ character: "Aster-Vale", total: 20_000, at: BASE + 100 }],
      },
      // Nobody this profile is about, so it must not appear on it at all.
      {
        id: 9,
        name: "Deepwater Mark",
        total: 400,
        characters: [{ character: "Brin-Hearth", total: 400, at: BASE }],
      },
      // One pot the whole warband reads: the total is the pot, not the sum of the rows, and
      // every character's row is the same number seen from a different place.
      {
        id: 10,
        name: "Warband Chit",
        total: 6_000,
        accountWide: true,
        oldest: BASE + 100,
        characters: [
          { character: "Aster-Vale", total: 6_000, at: BASE + 100 },
          { character: "Brin-Hearth", total: 6_000, at: BASE },
        ],
      },
    ],
    // What the roster is sitting on: both wallets and the one pot they share, which is added
    // to the account's worth once rather than once per character.
    gold: {
      characters: [
        { character: "Aster-Vale", total: 125_000, at: BASE + 100 },
        { character: "Brin-Hearth", total: 40_000, at: BASE },
      ],
      wallets: 165_000,
      warband: 500_000,
      warbandAt: BASE,
      total: 665_000,
      oldest: BASE,
    },
    factions: [
      {
        faction: "Cavern Cartographers",
        best: { character: "Brin-Hearth", standing: "Revered", rank: 7, system: "reaction" },
        characters: [
          { character: "Aster-Vale", standing: "Honored", current: 4200, max: 12_000, rank: 6, system: "reaction" },
          { character: "Brin-Hearth", standing: "Revered", current: 3000, max: 21_000, rank: 7, system: "reaction" },
        ],
      },
      {
        faction: "Deepwater Wardens",
        best: { character: "Aster-Vale", standing: "Exalted", rank: 8, system: "reaction" },
        characters: [{ character: "Aster-Vale", standing: "Exalted", rank: 8, system: "reaction" }],
      },
      // Met, but the client never placed it on a ladder — which is no rank, not a rank of nought.
      {
        faction: "Lamplighters",
        best: null,
        characters: [{ character: "Aster-Vale", standing: null }],
      },
    ],
  };

  const profileFor = (name: string) =>
    buildCharacters(played(name, [{}]), holdings)[0];

  it("gives a character only what they are holding themselves, biggest first", () => {
    expect(profileFor("Aster-Vale").currencies).toEqual([
      { id: 8, name: "Rustward Scrip", total: 20_000, accountTotal: 20_000, at: BASE + 100, accountWide: false },
      { id: 7, name: "Glass Token", total: 12_450, accountTotal: 30_000, at: BASE + 100, accountWide: false },
      { id: 10, name: "Warband Chit", total: 6_000, accountTotal: 6_000, at: BASE + 100, accountWide: true },
    ]);
  });

  // Without the flag the line reads as this character's own 6,000 next to an account total
  // that happens to match — which is exactly what a share of a pot does not look like.
  it("says which of them are the warband's one pot rather than the character's own", () => {
    const chit = profileFor("Brin-Hearth").currencies.find((held) => held.id === 10);

    expect(chit?.accountWide).toBe(true);
    expect(chit?.total).toBe(6_000);
    expect(chit?.accountTotal).toBe(6_000);
  });

  it("carries the account's total beside the character's own", () => {
    const [held] = profileFor("Brin-Hearth").currencies;

    expect(held.total).toBe(17_550);
    expect(held.accountTotal).toBe(30_000);
  });

  // The balance is the character's, the total is the account's, and the profile carries both
  // because the interesting question is what this one is holding against what the roster has.
  it("gives a character its own balance beside what the whole account is worth", () => {
    expect(profileFor("Aster-Vale").gold).toEqual({
      total: 125_000,
      accountTotal: 665_000,
      wallets: 165_000,
      warband: 500_000,
      at: BASE + 100,
      oldest: BASE,
    });
  });

  // The account's total is real and this character's share of it is simply unknown. A profile
  // drawing an empty pocket would be inventing a reading nobody ever took.
  it("says nothing about a character the account's gold has never included", () => {
    expect(profileFor("Never-Read").gold).toBeNull();
  });

  it("says nothing about gold at all on a history that never reported any", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [{}]));

    expect(profile.gold).toBeNull();
  });

  it("gives them the standings they have, furthest along first", () => {
    const factions = profileFor("Aster-Vale").factions;

    expect(factions.map((entry) => entry.faction))
      .toEqual(["Deepwater Wardens", "Cavern Cartographers", "Lamplighters"]);
    expect(factions[1].standing).toBe("Honored");
  });

  // Which is the thing the roster can say and a segment cannot: whether grinding this
  // faction here is starting from behind somebody else on the same account.
  it("says which of them nobody on the account has got further with", () => {
    const factions = profileFor("Aster-Vale").factions;

    expect(factions.find((entry) => entry.faction === "Deepwater Wardens")?.leads).toBe(true);
    expect(factions.find((entry) => entry.faction === "Cavern Cartographers")?.leads).toBe(false);
  });

  it("has nothing to say about holdings on a history that never reported any", () => {
    const [profile] = buildCharacters(played("Aster-Vale", [{}]));

    expect(profile.currencies).toEqual([]);
    expect(profile.factions).toEqual([]);
  });
});

describe("byDay", () => {
  it("groups the segments under the day they happened on, keeping their order", () => {
    const groups = byDay([
      segment({ day: "2026-07-26", instance: "Third" }),
      segment({ day: "2026-07-26", instance: "Second" }),
      segment({ day: "2026-07-25", instance: "First" }),
    ]);

    expect(groups.map((group) => group.day)).toEqual(["2026-07-26", "2026-07-25"]);
    expect(groups[0].segments.map((entry) => entry.instance)).toEqual(["Third", "Second"]);
    expect(groups[1].segments).toHaveLength(1);
  });

  it("has no groups at all for no segments", () => {
    expect(byDay([])).toEqual([]);
  });
});
