/**
 * Writes the game-file fixtures the achievement tests read: the two tables that describe an
 * achievement, the three that get from a faction back to one, and the BLP icons they name.
 *
 * `Faction`, `Criteria` and `CriteriaTree` are here rather than in an area of their own because
 * what they are for is reaching `Achievement`: a faction has no icon column, and the picture the
 * app draws beside a reputation line is the icon of the achievement for reaching Exalted with it.
 * The walk starts at a faction's name and ends at a row of the table above. See `reputations.rs`.
 *
 * The tables below have exactly the shape the game's own do — same columns, same storage per
 * column, same bit offsets, read off a real install and written down in `docs/game-files.md`
 * — and content that is entirely invented. Nothing here is copied from the game. How any of
 * it is actually written out is [`db2-fixtures.ts`], which is shared with the other areas'
 * fixtures and is where the formats themselves are explained.
 *
 *     bun run scripts/make-achievement-fixtures.ts
 */

import {
  AlphaType,
  bgraPixels,
  dxtBlocks,
  emit,
  Encoding,
  palettePixels,
  Storage,
  type IconSpec,
  type TableSpec,
} from "./db2-fixtures";

/** What the game calls each table; the reader asks for them by these numbers. */
const FILE_DATA_ID = {
  achievement: 1260179,
  achievementCategory: 1324299,
  faction: 1361972,
  criteria: 1263817,
  criteriaTree: 1263818,
} as const;

/**
 * The points an achievement can be worth, as the game's own palette stores them.
 *
 * The value in the palette is not the number of points: it is `0x3C00` with the points in
 * its low byte, on every one of the 13,732 rows a real install could read. The reader takes
 * the low byte, and this is where that is held to account — a fixture that stored a plain 10
 * would let a reader which ignored the packing pass.
 */
const points = (value: number): number => 0x3c00 | value;

/**
 * One reputation achievement, as a row of the table below.
 *
 * A helper rather than eight more rows written out, because these differ in only four of their
 * nineteen values and what they are here to exercise is the *walk* to them — every other column is
 * already held to account by the rows above, which vary on purpose. What matters here is the id,
 * the icon, and `Criteria_tree` in column 14.
 */
const reputationAchievement = (
  title: string,
  id: number,
  icon: number,
  criteriaTree: number,
): Array<number | string> => [
  `Earn the regard of ${title}.`,
  title,
  "",
  id,
  -1,
  0,
  0,
  20,
  0,
  points(10),
  0,
  1,
  icon,
  0,
  criteriaTree,
  0,
  0,
  0,
  0,
];

/**
 * `Achievement` — the achievements themselves.
 *
 * Every column of the real table is here, in its place and in its storage, including the
 * four nothing reads: leaving them out would move every column after them and make the
 * fixture agree with a reader that had the offsets wrong. Three of the strings, a signed bit
 * field for the id, two sparse columns, three palettes and a plain bit field between them
 * cover every storage the table actually uses.
 */
const achievement: TableSpec = {
  fileDataId: FILE_DATA_ID.achievement,
  layoutHash: 0x6fc5281b,
  tableHash: 0xd2ee2ca7,
  idColumn: 3,
  flags: 0,
  recordSize: 32,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Description
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // Title
    { storage: Storage.plain, offsetBits: 64, sizeBits: 32 }, // Reward
    { storage: Storage.bitpackedSigned, offsetBits: 96, sizeBits: 17 }, // ID
    { storage: Storage.bitpackedSigned, offsetBits: 113, sizeBits: 13 }, // InstanceID
    {
      // Faction. Nearly every achievement belongs to both, so the table lists only the ones
      // that do not — which is what a sparse column is for.
      storage: Storage.common,
      offsetBits: 126,
      sizeBits: 0,
      default: -1,
      common: new Map([
        [104, 1],
        [105, 0],
      ]),
    },
    { storage: Storage.bitpackedSigned, offsetBits: 126, sizeBits: 17 }, // Supercedes
    { storage: Storage.bitpackedSigned, offsetBits: 143, sizeBits: 15 }, // Category
    {
      storage: Storage.common,
      offsetBits: 158,
      sizeBits: 0,
      default: 0,
      common: new Map([[102, 3]]),
    }, // MinimumCriteria
    {
      storage: Storage.indexed,
      offsetBits: 158,
      sizeBits: 4,
      palette: [points(0), points(10), points(25), points(5)],
    }, // Points
    { storage: Storage.bitpackedSigned, offsetBits: 162, sizeBits: 29 }, // Flags
    { storage: Storage.bitpackedSigned, offsetBits: 191, sizeBits: 12 }, // UiOrder
    {
      storage: Storage.indexed,
      offsetBits: 203,
      sizeBits: 12,
      palette: [250001, 250002, 250003, 250004, 250007, 250008, 250011, 250012],
    }, // IconFileID
    {
      storage: Storage.common,
      offsetBits: 215,
      sizeBits: 0,
      default: 0,
      common: new Map([[103, 4242]]),
    }, // unread
    { storage: Storage.bitpacked, offsetBits: 215, sizeBits: 18 }, // CriteriaTree
    { storage: Storage.bitpackedSigned, offsetBits: 233, sizeBits: 14 }, // SharesCriteria
    { storage: Storage.bitpackedSigned, offsetBits: 247, sizeBits: 2 }, // unread
    { storage: Storage.indexed, offsetBits: 249, sizeBits: 2, palette: [0, 22, 34] }, // unread
    { storage: Storage.indexed, offsetBits: 251, sizeBits: 2, palette: [0, 353] }, // unread
  ],
  sections: [
    {
      key: 0n,
      // Description, Title, Reward, ID, InstanceID, Faction, Supercedes, Category,
      // MinimumCriteria, Points, Flags, UiOrder, IconFileID, then the five the reader never
      // asks for. The sparse columns take no room in a row.
      rows: [
        [
          "Reach the lighthouse at the end of the pier.",
          "Into the Light",
          "",
          101,
          -1,
          0,
          0,
          10,
          0,
          points(10),
          0,
          1,
          250001,
          0,
          5001,
          0,
          0,
          0,
          0,
        ],
        // Earned on top of another, which is what `Supercedes` records, and the one with a
        // reward to show under it.
        [
          "Reach the lighthouse without being seen.",
          "Deeper into the Light",
          "Reward: Title & the lamplighter's coat",
          102,
          -1,
          0,
          101,
          10,
          0,
          points(25),
          1,
          2,
          250002,
          0,
          5002,
          0,
          0,
          22,
          0,
        ],
        // Tied to an instance, which is a map id rather than anything the addon records.
        [
          "Defeat every warden of the Emberforge.",
          "Emberforge Initiate",
          "",
          103,
          4820,
          0,
          0,
          11,
          0,
          points(10),
          0,
          1,
          250003,
          0,
          5003,
          0,
          0,
          0,
          0,
        ],
        // The two faction-specific ones, which is the only column the game keeps sparsely
        // and the only place a row differs from every other.
        [
          "Win the harbour skirmish for the Coalition.",
          "For the Coalition",
          "",
          104,
          -1,
          0,
          0,
          20,
          0,
          points(10),
          0,
          1,
          250004,
          0,
          5004,
          0,
          0,
          0,
          0,
        ],
        [
          "Win the harbour skirmish for the Covenant.",
          "For the Covenant",
          "",
          105,
          -1,
          0,
          0,
          20,
          0,
          points(10),
          0,
          2,
          250004,
          0,
          5005,
          0,
          0,
          0,
          0,
        ],
        // Its category's parent is in the encrypted section, so the trail up the tree stops
        // one short of a root rather than being followed to a name that is not there.
        [
          "Collect every oddment in the ledger.",
          "Keeper of Oddments",
          "",
          106,
          -1,
          0,
          0,
          30,
          0,
          points(5),
          0,
          1,
          250001,
          0,
          5006,
          0,
          0,
          0,
          353,
        ],
        // Worth nothing, which is what the game gives a feat of strength — and its texture
        // is one the install cannot decode.
        [
          "Walk the long road from end to end.",
          "The Long Road",
          "",
          107,
          -1,
          0,
          0,
          20,
          0,
          points(0),
          0,
          3,
          250007,
          0,
          5007,
          0,
          0,
          0,
          0,
        ],
        // Filed under a category no row of the other table names, and pointing at a texture
        // no install holds.
        [
          "Balance a ledger that does not exist.",
          "Ledger of Nothing",
          "",
          108,
          -1,
          0,
          0,
          777,
          0,
          points(0),
          0,
          4,
          250008,
          0,
          5008,
          0,
          0,
          0,
          0,
        ],
        // The reputation achievements, which is what `reputations.rs` walks back to. Each row's
        // `Criteria_tree` in column 14 is the root of a tree in `CriteriaTree` below, and what a
        // faction gets depends entirely on how many factions that tree turns out to name.
        //
        // One faction and one only, so its icon is per-faction artwork worth borrowing.
        reputationAchievement("Emberforge Covenant", 111, 250002, 5011),
        // An aggregate: three factions under one tree. Its icon is a generic pile of tabards, and
        // letting it through would put the same picture on every reputation line in the app.
        reputationAchievement("Twenty Exalted Reputations", 112, 250011, 5012),
        // One faction, reached two levels down rather than one — a tree with a grouping node in
        // the middle, which the real trees are full of.
        reputationAchievement("Tidewrought Wardens", 113, 250004, 5013),
        // The same faction again on a later row, which 38 of the real 138 have: a hidden copy or
        // an unshipped tier. Its icon must lose to 113's, because 113 is the original.
        reputationAchievement("Tidewrought Wardens Tier 2 [DNT]", 114, 250001, 5014),
        // The one that answers for the second of two faction rows sharing a name.
        reputationAchievement("Venture Company", 115, 250003, 5015),
        // Reached only through a criterion of the wrong type, so it answers for nothing: the asset
        // column means whatever the type column beside it says it means.
        reputationAchievement("Ashfall Legion", 116, 250012, 5016),
      ],
    },
    {
      // Encrypted, so its rows arrive as zeroes: a segment that earned achievement 900 can
      // be told nothing about it at all.
      key: 0x4c19d2f6a03b8e57n,
      rows: [
        [
          "Do the thing that has not shipped.",
          "Unreleased Deed",
          "",
          900,
          -1,
          0,
          0,
          10,
          0,
          points(10),
          0,
          9,
          250001,
          0,
          5900,
          0,
          0,
          0,
          0,
        ],
      ],
    },
  ],
};

/**
 * `Achievement_Category` — the tree an achievement is filed in.
 *
 * A category names its parent and nothing else, so the path an achievement reads under is
 * walked up from the leaf. A root says so by naming `-1` as its parent, which a signed bit
 * field is what makes readable at all.
 */
const achievementCategory: TableSpec = {
  fileDataId: FILE_DATA_ID.achievementCategory,
  layoutHash: 0x67b2b4bd,
  tableHash: 0x231b414d,
  idColumn: 1,
  flags: 0,
  recordSize: 12,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name
    { storage: Storage.bitpackedSigned, offsetBits: 32, sizeBits: 15 }, // ID
    { storage: Storage.bitpackedSigned, offsetBits: 47, sizeBits: 15 }, // Parent
    { storage: Storage.bitpackedSigned, offsetBits: 62, sizeBits: 6 }, // UiOrder
  ],
  sections: [
    {
      key: 0n,
      rows: [
        ["Chronicles", 1, -1, 1],
        ["Wayfinding", 2, -1, 2],
        ["Tideglass Deeps", 10, 1, 1],
        ["Emberforge Halls", 11, 1, 2],
        ["Long Roads", 20, 2, 1],
        // Its parent is a category this install cannot read, which is where a path has to
        // stop rather than guess.
        ["Lost Ledgers", 30, 90, 3],
      ],
    },
    {
      key: 0x7e35a80cf1946d22n,
      rows: [["Unreleased Wing", 90, 2, 4]],
    },
  ],
};

/**
 * `Faction` — every faction the game keeps a standing for, and what it is called.
 *
 * The name is in **column 1**, not column 0, and that is the one thing about this table worth
 * knowing: column 0 is 256 bits wide — the four race masks the real table opens with, stored as one
 * column — so a reader that looked for the name where every other table in this app keeps it would
 * find a bit mask. The column is here at its real width for exactly that reason.
 *
 * Its ids sit in a list beside the rows.
 */
const faction: TableSpec = {
  fileDataId: FILE_DATA_ID.faction,
  layoutHash: 0x3d81ce54,
  tableHash: 0x5a207fb1,
  idColumn: 0,
  // Bit 2: the ids are kept in a list beside the rows.
  flags: 4,
  recordSize: 44,
  columns: [
    // ReputationRaceMask[4]. Written as zero on every row — no race is barred from any of these —
    // which is also the one value the fixture writer can put in 256 bits without truncating.
    { storage: Storage.plain, offsetBits: 0, sizeBits: 256 },
    { storage: Storage.plain, offsetBits: 256, sizeBits: 32 }, // Name_lang
    { storage: Storage.plain, offsetBits: 288, sizeBits: 32 }, // Description_lang
    { storage: Storage.bitpackedSigned, offsetBits: 320, sizeBits: 11 }, // ReputationIndex
    { storage: Storage.bitpacked, offsetBits: 331, sizeBits: 12 }, // ParentFactionID
    { storage: Storage.bitpacked, offsetBits: 343, sizeBits: 4 }, // Expansion
  ],
  sections: [
    {
      key: 0n,
      // Race mask, name, description, reputation index, parent, expansion.
      rows: [
        // A faction with an achievement of its very own, which 138 of the real ones have.
        [0, "Emberforge Covenant", "Smiths of the deep forge.", 1, 0, 0],
        // One with two of its own, only the first of which counts.
        [0, "Tidewrought Wardens", "", 2, 0, 0],
        // One only the aggregate achievement names, so it must draw nothing at all.
        [0, "Glasswing Flight", "", 3, 0, 0],
        // One no criterion mentions, which is what every modern renown faction is: renown has no
        // Exalted achievement, so this route reaches none of them.
        [0, "Harborwatch", "", 4, 0, 0],
        // A name on two rows, the first of which reaches nothing. Fourteen of the real table's
        // names are on more than one row — "Venture Company" is on three.
        [0, "Venture Company", "", 5, 0, 0],
        [0, "Venture Company", "", 6, 0, 0],
        // One reached only through a criterion of the wrong type.
        [0, "Ashfall Legion", "", 7, 0, 0],
        // A row with no name at all, which the real table has: nothing can be asked about it, and
        // an empty name must not match a segment filed under nothing either.
        [0, "", "", 8, 0, 0],
      ],
      idList: [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008],
    },
    {
      // Encrypted, so the row is not there at all: a faction from content this install has not
      // been given the key to.
      key: 0x9d271ba46f08c351n,
      rows: [[0, "Unreleased Order", "", 9, 0, 0]],
      idList: [3900],
    },
  ],
};

/**
 * `Criteria` — one row per thing that can be required of a player, and the table that says which
 * faction a reputation requirement is about.
 *
 * Its id sits in **column 0**, unlike the two tables beside it. What makes it worth reading
 * carefully is that **column 2 means whatever column 1 says it means**: on a type-46 row the asset
 * is a faction id, and on the row next to it the same number could be a map or an item. So the
 * fixture holds a row of another type whose asset is a faction id, to be read wrongly.
 */
const criteria: TableSpec = {
  fileDataId: FILE_DATA_ID.criteria,
  layoutHash: 0x1e6b0f27,
  tableHash: 0x62c95d3a,
  idColumn: 0,
  flags: 0,
  recordSize: 10,
  columns: [
    { storage: Storage.bitpackedSigned, offsetBits: 0, sizeBits: 18 }, // ID
    // Type. A palette in the real table too, which is what a column of a hundred-odd distinct
    // values over sixty thousand rows is stored as.
    { storage: Storage.indexed, offsetBits: 18, sizeBits: 8, palette: [46, 17] },
    { storage: Storage.bitpackedSigned, offsetBits: 26, sizeBits: 22 }, // Asset
    { storage: Storage.bitpacked, offsetBits: 48, sizeBits: 19 }, // Modifier_tree_ID
    { storage: Storage.indexed, offsetBits: 67, sizeBits: 4, palette: [0] }, // Start_event
    { storage: Storage.common, offsetBits: 71, sizeBits: 0, default: 0, common: new Map() },
    { storage: Storage.common, offsetBits: 71, sizeBits: 0, default: 0, common: new Map() },
    { storage: Storage.common, offsetBits: 71, sizeBits: 0, default: 0, common: new Map() },
    { storage: Storage.common, offsetBits: 71, sizeBits: 0, default: 0, common: new Map() },
    { storage: Storage.indexed, offsetBits: 71, sizeBits: 5, palette: [0] }, // Flags
    { storage: Storage.common, offsetBits: 76, sizeBits: 0, default: 0, common: new Map() },
    { storage: Storage.common, offsetBits: 76, sizeBits: 0, default: 0, common: new Map() },
  ],
  sections: [
    {
      key: 0n,
      // ID, Type, Asset, Modifier_tree_ID, Start_event, four sparse, Flags, two sparse. A sparse
      // column takes no room in a record and still takes its place in the list.
      rows: [
        [6001, 46, 3001, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [6002, 46, 3002, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [6003, 46, 3003, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [6004, 46, 3006, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        // Type 17 rather than 46, and its asset is a faction id all the same. A reader that took
        // every row whose asset looked like a faction would borrow the wrong achievement's icon.
        [6005, 17, 3007, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        // The second Tidewrought criterion, under the later achievement.
        [6006, 46, 3002, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ],
    },
  ],
};

/**
 * `CriteriaTree` — how criteria are grouped into what an achievement actually asks for.
 *
 * A node names its one parent and nothing else, so the tree is walked *up* from a leaf rather than
 * down from a root — which is the direction `reputations.rs` goes, because the real table is a
 * hundred thousand rows and only a few thousand of them are about a reputation. Its ids sit in a
 * list beside the rows.
 */
const criteriaTree: TableSpec = {
  fileDataId: FILE_DATA_ID.criteriaTree,
  layoutHash: 0x74a9c0e6,
  tableHash: 0x2f1d8b93,
  idColumn: 0,
  flags: 4,
  recordSize: 17,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Description_lang
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // Parent
    { storage: Storage.plain, offsetBits: 64, sizeBits: 32 }, // Amount
    { storage: Storage.indexed, offsetBits: 96, sizeBits: 4, palette: [0, 4] }, // Operator
    { storage: Storage.bitpacked, offsetBits: 100, sizeBits: 17 }, // CriteriaID
    { storage: Storage.indexed, offsetBits: 117, sizeBits: 10, palette: [0, 1, 2] }, // OrderIndex
    { storage: Storage.indexed, offsetBits: 127, sizeBits: 7, palette: [0, 8] }, // Flags
  ],
  sections: [
    {
      key: 0n,
      // Description, Parent, Amount, Operator, CriteriaID, OrderIndex, Flags.
      rows: [
        /* --- 5011: one faction, one level down --- */
        ["Reputation earned", 0, 0, 4, 0, 0, 0],
        ["Exalted with the Emberforge Covenant", 5011, 42000, 0, 6001, 0, 8],
        /* --- 5012: the aggregate, three factions under one root --- */
        ["Reputations at Exalted", 0, 20, 4, 0, 0, 0],
        ["Exalted with the Emberforge Covenant", 5012, 42000, 0, 6001, 0, 8],
        ["Exalted with the Tidewrought Wardens", 5012, 42000, 0, 6002, 1, 8],
        ["Exalted with the Glasswing Flight", 5012, 42000, 0, 6003, 2, 8],
        /* --- 5013: one faction, two levels down through a grouping node --- */
        ["Reputation earned", 0, 0, 4, 0, 0, 0],
        ["Any of the following", 5013, 0, 4, 0, 0, 0],
        ["Exalted with the Tidewrought Wardens", 5115, 42000, 0, 6002, 0, 8],
        /* --- 5014: the same faction under the later achievement --- */
        ["Reputation earned", 0, 0, 4, 0, 0, 0],
        ["Exalted with the Tidewrought Wardens", 5014, 42000, 0, 6006, 0, 8],
        /* --- 5015: the faction whose name is on two rows --- */
        ["Reputation earned", 0, 0, 4, 0, 0, 0],
        ["Exalted with the Venture Company", 5015, 42000, 0, 6004, 0, 8],
        /* --- 5016: the wrong-type criterion, so this tree names no faction at all --- */
        ["Something else entirely", 0, 0, 4, 0, 0, 0],
        ["Not a reputation", 5016, 1, 0, 6005, 0, 8],
        /* --- a pair whose parents point at each other, which only a mis-read table has. The
               climb has to stop rather than run forever, and neither id is any achievement's
               root, so nothing is drawn from it. --- */
        ["Round and round", 5121, 0, 0, 6001, 0, 0],
        ["And back again", 5120, 0, 0, 0, 0, 0],
        /* --- a node whose parent is not in the table, which is a root from here: nothing above
               it can be reached, so nothing above it can be an achievement's. --- */
        ["Orphaned", 7777, 0, 0, 6003, 0, 0],
      ],
      idList: [
        5011, 5111, 5012, 5112, 5113, 5114, 5013, 5115, 5116, 5014, 5117, 5015, 5118, 5016, 5119,
        5120, 5121, 5122,
      ],
    },
    {
      // Encrypted, so this node is not there at all — and that matters more here than anywhere
      // else in these fixtures: it hangs off 5011 and is about the Glasswing Flight, so a reader
      // that saw it would find the Emberforge Covenant's achievement naming two factions and
      // decide it was an aggregate. The Covenant would then draw nothing.
      key: 0x4e0b93d7a25f1c68n,
      rows: [["Exalted with the Glasswing Flight", 5011, 42000, 0, 6003, 1, 8]],
      idList: [5123],
    },
  ],
};

/**
 * The icons the achievements name, one per encoding the client ships.
 *
 * 250001 is named by two achievements, which is the case a decoder that caches has to get
 * right; 250007 and 250008 are the two that cannot be shown at all. 250011 and 250012 belong to
 * the reputation walk: the first is the aggregate achievement's, which must never be drawn for a
 * faction, and the second is the wrong-type one's, which must never be reached at all.
 */
const icons: IconSpec[] = [
  {
    fileDataId: 250001,
    encoding: Encoding.palette,
    alphaBits: 8,
    alphaType: 0,
    body: palettePixels(8),
  },
  {
    fileDataId: 250002,
    encoding: Encoding.dxt,
    alphaBits: 8,
    alphaType: AlphaType.dxt5,
    body: dxtBlocks(AlphaType.dxt5),
  },
  { fileDataId: 250003, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  {
    fileDataId: 250004,
    encoding: Encoding.dxt,
    alphaBits: 0,
    alphaType: AlphaType.dxt1,
    body: dxtBlocks(AlphaType.dxt1),
  },
  // The aggregate achievement's, which no faction may borrow.
  {
    fileDataId: 250011,
    encoding: Encoding.palette,
    alphaBits: 0,
    alphaType: 0,
    body: palettePixels(0),
  },
  // The wrong-type achievement's, which nothing may reach.
  { fileDataId: 250012, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
];

/* ---------- go ---------- */

emit("achievements", {
  tables: [achievement, achievementCategory, faction, criteria, criteriaTree],
  icons,
  // 250007 belongs to content the game has not shipped: its chunk is encrypted, and a chunk
  // only Blizzard holds the key to arrives as zeroes of the right length. 250008 is named by
  // an achievement and installed by nobody, which is the other half of the same story and
  // needs no file at all.
  raw: [
    {
      fileDataId: 250007,
      extension: "blp",
      bytes: new Uint8Array(1172),
      note: "the texture the game keeps encrypted",
    },
  ],
});
