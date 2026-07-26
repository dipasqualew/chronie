/**
 * Writes the game-file fixtures the achievement tests read: the two tables that describe an
 * achievement, and the BLP icons they name.
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
      storage: Storage.common, offsetBits: 126, sizeBits: 0, default: -1,
      common: new Map([[104, 1], [105, 0]]),
    },
    { storage: Storage.bitpackedSigned, offsetBits: 126, sizeBits: 17 }, // Supercedes
    { storage: Storage.bitpackedSigned, offsetBits: 143, sizeBits: 15 }, // Category
    {
      storage: Storage.common, offsetBits: 158, sizeBits: 0, default: 0,
      common: new Map([[102, 3]]),
    }, // MinimumCriteria
    {
      storage: Storage.indexed, offsetBits: 158, sizeBits: 4,
      palette: [points(0), points(10), points(25), points(5)],
    }, // Points
    { storage: Storage.bitpackedSigned, offsetBits: 162, sizeBits: 29 }, // Flags
    { storage: Storage.bitpackedSigned, offsetBits: 191, sizeBits: 12 }, // UiOrder
    {
      storage: Storage.indexed, offsetBits: 203, sizeBits: 12,
      palette: [250001, 250002, 250003, 250004, 250007, 250008],
    }, // IconFileID
    {
      storage: Storage.common, offsetBits: 215, sizeBits: 0, default: 0,
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
        ["Reach the lighthouse at the end of the pier.", "Into the Light", "",
          101, -1, 0, 0, 10, 0, points(10), 0, 1, 250001, 0, 5001, 0, 0, 0, 0],
        // Earned on top of another, which is what `Supercedes` records, and the one with a
        // reward to show under it.
        ["Reach the lighthouse without being seen.", "Deeper into the Light",
          "Reward: Title & the lamplighter's coat",
          102, -1, 0, 101, 10, 0, points(25), 1, 2, 250002, 0, 5002, 0, 0, 22, 0],
        // Tied to an instance, which is a map id rather than anything the addon records.
        ["Defeat every warden of the Emberforge.", "Emberforge Initiate", "",
          103, 4820, 0, 0, 11, 0, points(10), 0, 1, 250003, 0, 5003, 0, 0, 0, 0],
        // The two faction-specific ones, which is the only column the game keeps sparsely
        // and the only place a row differs from every other.
        ["Win the harbour skirmish for the Coalition.", "For the Coalition", "",
          104, -1, 0, 0, 20, 0, points(10), 0, 1, 250004, 0, 5004, 0, 0, 0, 0],
        ["Win the harbour skirmish for the Covenant.", "For the Covenant", "",
          105, -1, 0, 0, 20, 0, points(10), 0, 2, 250004, 0, 5005, 0, 0, 0, 0],
        // Its category's parent is in the encrypted section, so the trail up the tree stops
        // one short of a root rather than being followed to a name that is not there.
        ["Collect every oddment in the ledger.", "Keeper of Oddments", "",
          106, -1, 0, 0, 30, 0, points(5), 0, 1, 250001, 0, 5006, 0, 0, 0, 353],
        // Worth nothing, which is what the game gives a feat of strength — and its texture
        // is one the install cannot decode.
        ["Walk the long road from end to end.", "The Long Road", "",
          107, -1, 0, 0, 20, 0, points(0), 0, 3, 250007, 0, 5007, 0, 0, 0, 0],
        // Filed under a category no row of the other table names, and pointing at a texture
        // no install holds.
        ["Balance a ledger that does not exist.", "Ledger of Nothing", "",
          108, -1, 0, 0, 777, 0, points(0), 0, 4, 250008, 0, 5008, 0, 0, 0, 0],
      ],
    },
    {
      // Encrypted, so its rows arrive as zeroes: a segment that earned achievement 900 can
      // be told nothing about it at all.
      key: 0x4c19d2f6a03b8e57n,
      rows: [
        ["Do the thing that has not shipped.", "Unreleased Deed", "",
          900, -1, 0, 0, 10, 0, points(10), 0, 9, 250001, 0, 5900, 0, 0, 0, 0],
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
 * The icons the achievements name, one per encoding the client ships.
 *
 * 250001 is named by two achievements, which is the case a decoder that caches has to get
 * right; 250007 and 250008 are the two that cannot be shown at all.
 */
const icons: IconSpec[] = [
  { fileDataId: 250001, encoding: Encoding.palette, alphaBits: 8, alphaType: 0, body: palettePixels(8) },
  {
    fileDataId: 250002, encoding: Encoding.dxt, alphaBits: 8,
    alphaType: AlphaType.dxt5, body: dxtBlocks(AlphaType.dxt5),
  },
  { fileDataId: 250003, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  {
    fileDataId: 250004, encoding: Encoding.dxt, alphaBits: 0,
    alphaType: AlphaType.dxt1, body: dxtBlocks(AlphaType.dxt1),
  },
];

/* ---------- go ---------- */

emit("achievements", {
  tables: [achievement, achievementCategory],
  icons,
  // 250007 belongs to content the game has not shipped: its chunk is encrypted, and a chunk
  // only Blizzard holds the key to arrives as zeroes of the right length. 250008 is named by
  // an achievement and installed by nobody, which is the other half of the same story and
  // needs no file at all.
  raw: [{
    fileDataId: 250007,
    extension: "blp",
    bytes: new Uint8Array(1172),
    note: "the texture the game keeps encrypted",
  }],
});
