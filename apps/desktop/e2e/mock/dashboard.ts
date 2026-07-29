/**
 * The timeline's own fixtures: what the account is holding, and the evenings it played.
 *
 * Three segments over two evenings, which is the smallest number that gives the grouping rule
 * something to do — two of them fold into one session and the third cannot — and every kind of
 * thing a segment can record appears in exactly one of them.
 */

import type { E2EMock } from "../../src/types";

import { EVENING, NIGHT_BEFORE } from "./clock";

// The note is the most user-supplied string in the application, and this is the shape that
// proves it: typed by a person, containing markup, and drawn in three places — the tile, the
// viewer, and the tooltip that is handed HTML rather than a value in a React tree.
export const NOTED = "<b>first</b> Yogg kill";

export const dashboard: E2EMock["dashboard"] = {
  generatedAt: "2026-07-26T12:00:00Z",
  knownActivityKinds: ["mythic_plus", "progress_raid", "legacy_raid", "levelling"],
  // What every character was last seen holding, which is the half of the story no single
  // segment can tell: the tokens on the line belong to one character, and "how many of
  // these do I have, everywhere" and "has somebody already finished this grind" are
  // questions about the account.
  holdings: {
    // Two wallets and the one pot the account shares. The pot is what makes the account's
    // worth a different number from either wallet, which is the whole reason it is drawn.
    gold: {
      characters: [
        { character: "Aster-Vale", total: 125000, at: EVENING },
        { character: "Brin-Hearth", total: 400000, at: EVENING - 3 * 86400 },
      ],
      wallets: 525000,
      warband: 1200000,
      warbandAt: EVENING - 3 * 86400,
      total: 1725000,
      oldest: EVENING - 3 * 86400,
    },
    currencies: [
      {
        id: 7,
        name: "Glass Token",
        total: 30000,
        oldest: EVENING - 3 * 86400,
        characters: [
          { character: "Aster-Vale", total: 12450, at: EVENING },
          { character: "Brin-Hearth", total: 17550, at: EVENING - 3 * 86400 },
        ],
      },
      {
        // The warband's one pot: the game hands every character the same balance, so both
        // rows are that balance seen from somewhere else rather than two holdings, the total
        // is the freshest of them rather than their sum, and the wording has to say so.
        id: 10,
        name: "Warband Chit",
        total: 6000,
        accountWide: true,
        oldest: EVENING,
        characters: [
          { character: "Aster-Vale", total: 6000, at: EVENING },
          { character: "Brin-Hearth", total: 6000, at: EVENING - 3 * 86400 },
        ],
      },
    ],
    factions: [
      {
        faction: "Cavern Cartographers",
        best: {
          character: "Brin-Hearth",
          standing: "Revered",
          current: 3000,
          max: 21000,
          rank: 7,
          system: "reaction",
          at: EVENING - 3 * 86400,
        },
        characters: [
          {
            character: "Aster-Vale",
            standing: "Honored",
            current: 4200,
            max: 12000,
            rank: 6,
            system: "reaction",
            at: EVENING,
          },
          {
            character: "Brin-Hearth",
            standing: "Revered",
            current: 3000,
            max: 21000,
            rank: 7,
            system: "reaction",
            at: EVENING - 3 * 86400,
          },
        ],
      },
      // The one the account leader is standing on: nobody is ahead of this character
      // because this character is the one out in front, and there is nothing to say.
      {
        faction: "Deepwater Wardens",
        best: {
          character: "Brin-Hearth",
          standing: "Exalted",
          rank: 8,
          system: "reaction",
          at: EVENING,
        },
        characters: [
          {
            character: "Brin-Hearth",
            standing: "Exalted",
            rank: 8,
            system: "reaction",
            at: EVENING,
          },
        ],
      },
    ],
  },
  segments: [
    {
      id: "synthetic-003",
      segmentId: 3,
      activities: [],
      encounters: [],
      character: "Brin-Hearth",
      classFile: "DRUID",
      level: 9,
      day: "2026-07-26",
      instance: "Copperwood Depths",
      difficulty: "",
      instanceType: "none",
      startedAt: EVENING + 1920,
      endedAt: EVENING + 3120,
      seconds: 1200,
      lootValue: 15000,
      goldDiff: 900,
      currencyTotal: 2,
      reputationTotal: 50,
      housingXP: 0,
      // Two more sources in the same evening, one of each sort, and neither of them a piece
      // this install can describe — which is what the name the addon caught at the time is the
      // fallback for. The new one is what keeps the evening's "2 new appearances" standing for
      // two once the two sorts are counted apart, so the summary still unfolds into pieces; and
      // it is the piece only the addon ever named, drawn beside one the game names itself.
      transmogs: [
        { id: 4200, name: "Storm Cloak", at: EVENING + 2200, newAppearance: false },
        { id: 4300, name: "Bramble Wrap", at: EVENING + 2400, newAppearance: true },
      ],
      // The other half of the story: gains the client said nothing else about. An
      // item-based currency counted before its first change has no holding to report, and
      // a faction read off a chat line on a character that has never met it has no
      // standing. Neither is a holding of zero or a standing at the bottom of a bar, so
      // neither may draw as one.
      // A third case sits beside them: a faction the client named a level for and gave no
      // length to. That is a standing worth printing and a bar with nothing to draw, and a
      // bar at zero would announce the character as nowhere in a level they are inside.
      // The alt's own picture, so an evening's fold has captures from more than one of its
      // segments and the grid is a session's rather than a segment's.
      captures: [
        {
          id: 33,
          sourceId: "TEST|3|33",
          at: EVENING + 2000,
          imageState: "stored",
          byteSize: 2_411_902,
          sourceName: "WoWScrnShot_072626_190000.jpg",
        },
      ],
      currencies: [{ id: 8, name: "Rustward Scrip", amount: 2 }],
      reputation: [
        { faction: "Lamplighters", amount: 10 },
        { faction: "Deepwater Wardens", amount: 40, standing: "Exalted" },
      ],
      achievements: [],
      levelUps: [{ level: 9, at: EVENING + 3000 }],
      mounts: [],
      pets: [],
      quests: [],
      toys: [],
      housingItems: [],
      housingLevelUps: [],
    },
    {
      id: "synthetic-001",
      segmentId: 1,
      activities: [
        {
          id: 11,
          kind: "mythic_plus",
          source: "inferred",
          confidence: 1,
          metadata: { dungeon: "Glass Caverns", keystoneLevel: 14, timed: true },
        },
      ],
      // Three captures covering everything a tile has to be able to say: a picture with a
      // note somebody typed, an automatic one Chronie took by itself, and a marker whose
      // file was never found — which is a row to explain rather than a blank tile.
      captures: [
        {
          id: 11,
          sourceId: "TEST|1|11",
          at: EVENING + 1400,
          imageState: "stored",
          note: NOTED,
          byteSize: 3_204_112,
          sourceName: "WoWScrnShot_072626_183020.jpg",
        },
        {
          id: 12,
          sourceId: "TEST|1|12",
          at: EVENING + 1450,
          imageState: "stored",
          trigger: "accountFirstAchievement",
          achievementId: 77,
          byteSize: 3_100_000,
        },
        { id: 13, sourceId: "TEST|1|13", at: EVENING + 1500, imageState: "missing" },
      ],
      keystone: { level: 14, completed: true, onTime: true, upgrades: 1 },
      // Two fights, and the game has a portrait for one of them: 900 resolves through the journal
      // and 901 is a fight this install has never heard of, which is what a boss from a build
      // newer than the reader's tables looks like. A wipe as well as a kill, because the modal
      // says which each was.
      encounters: [
        { id: 900, name: "The Curator", at: EVENING + 400, success: true },
        { id: 901, name: "Sand-Wrought Colossus", at: EVENING + 700, success: false },
      ],
      character: "Aster-Vale",
      classFile: "MAGE",
      level: 12,
      day: "2026-07-26",
      instance: "Glass Caverns",
      difficulty: "Expedition",
      instanceType: "scenario",
      startedAt: EVENING,
      endedAt: EVENING + 1800,
      seconds: 1800,
      lootValue: 245000,
      goldDiff: 32000,
      currencyTotal: 4,
      reputationTotal: 25,
      housingXP: 0,
      equipsetChanges: [
        {
          setId: 3,
          name: "Raid",
          kind: "updated",
          at: EVENING + 1700,
          items: [
            {
              slot: 1,
              itemId: 4101,
              itemLevel: 639,
              itemName: "Deepwater Crown",
              previousItemId: 4100,
              previousItemLevel: 623,
              previousItemName: "Tideglass Crown",
            },
            // A slot the edit cleared, which has to draw as an emptied slot rather than as
            // a row with nothing in it.
            {
              slot: 15,
              previousItemId: 4200,
              previousItemLevel: 620,
              previousItemName: "Storm Cloak",
            },
          ],
        },
      ],
      transmogs: [{ id: 101, at: EVENING + 1400, newAppearance: true }],
      // Both gains carry where they left the character: the tokens now in the bag, and the
      // level the faction now sits at with the distance into it. Those are the numbers a
      // gain on its own cannot give — whether there is enough to buy anything, and how far
      // "+25" actually moved the standing.
      currencies: [
        { id: 7, name: "Glass Token", amount: 4, total: 12450 },
        { id: 10, name: "Warband Chit", amount: 100, total: 6000 },
      ],
      // Two factions, and the game has a picture for one of them. The cartographers have an
      // Exalted achievement whose icon the line can borrow; the Council is a renown faction, and
      // renown has no Exalted tier to earn an achievement for — so it keeps the medal it always
      // had. That is the split a real history has, and the modern half is the larger one.
      reputation: [
        {
          faction: "Cavern Cartographers",
          amount: 25,
          standing: "Honored",
          current: 4200,
          max: 12000,
        },
        {
          faction: "Council of Dornogal",
          amount: 60,
          standing: "Renown 4",
          current: 1400,
          max: 2500,
        },
      ],
      achievements: [
        { id: 9, name: "Into the Light", at: EVENING + 1400, accountFirst: false },
        // One the install can say nothing about, which is what an achievement earned on a
        // build newer than the one on disk looks like: the addon's own name and no more.
        { id: 77, name: "Quiet Ascent", at: EVENING + 1450, accountFirst: true },
        // A second character first, so the two sorts of achievement do not each stand for one
        // thing apiece: the quiet mark counts two and is therefore a mark that unfolds, which
        // is what the roster's and the timeline's "a summary of several comes apart" steps ask.
        { id: 10, name: "Tideglass Delver", at: EVENING + 1420, accountFirst: false },
      ],
      levelUps: [{ level: 12, at: EVENING + 1500 }],
      mounts: [{ id: 11, name: "Clockwork Glider", at: EVENING + 1600 }],
      pets: [],
      quests: [{ id: 81, at: EVENING + 1650 }],
      toys: [],
      housingItems: [],
      housingLevelUps: [],
    },
    {
      id: "synthetic-002",
      segmentId: 2,
      activities: [],
      encounters: [],
      character: "Brin-Hearth",
      classFile: "DRUID",
      level: 8,
      day: "2026-07-25",
      instance: "Copperwood",
      difficulty: "",
      instanceType: "none",
      startedAt: NIGHT_BEFORE,
      endedAt: NIGHT_BEFORE + 900,
      seconds: 900,
      lootValue: 50000,
      goldDiff: -1200,
      currencyTotal: 0,
      reputationTotal: 0,
      housingXP: 30,
      transmogs: [],
      currencies: [],
      reputation: [],
      achievements: [],
      levelUps: [],
      mounts: [],
      // The same critter twice, which is the shape only a battle pet can take: the
      // collection grew by one and the second catch is another of something already
      // held. A card that counted two would be reporting a collection that did not move.
      pets: [
        { id: 12, name: "Mossling", at: NIGHT_BEFORE + 800, speciesFirst: true },
        { id: 12, name: "Mossling", at: NIGHT_BEFORE + 820, speciesFirst: false },
      ],
      quests: [],
      toys: [{ id: 13, name: "Pocket Orrery", at: NIGHT_BEFORE + 850 }],
      housingItems: [
        { id: 14, name: "Carved Reading Chair", at: NIGHT_BEFORE + 860, warbandFirst: true },
      ],
      housingLevelUps: [{ level: 2, at: NIGHT_BEFORE + 870 }],
    },
  ],
};
