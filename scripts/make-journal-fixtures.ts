/**
 * Writes the game-file fixtures the place-icon tests read: `JournalInstance`, `LFGDungeons`, and
 * the icons they name.
 *
 * Two tables and one column of each, which is the whole of what this app asks the game about the
 * place a segment happened in — everything else about one arrives from the addon as a name. Both
 * tables below have the shape the game's own do: fixed-size records, ids in a list beside them,
 * strings in a block of their own, and the icon in column 5 — read off build 12.0.5.67823 with
 * `examples/dump_journal` and written down in `docs/game-files.md`. The contents are entirely
 * invented; nothing here is copied from the game. How any of it is written out is
 * [`db2-fixtures.ts`].
 *
 *     bun run scripts/make-journal-fixtures.ts
 */

import {
  AlphaType,
  bgraPixels,
  dxtBlocks,
  emit,
  Encoding,
  palettePixels,
  Storage,
  type ColumnSpec,
  type IconSpec,
  type TableSpec,
} from "./db2-fixtures";

/** What the game calls the tables; the reader asks for them by these numbers. */
const JOURNAL_INSTANCE = 1237438;
const LFG_DUNGEONS = 1361033;

/**
 * Ten plain 32-bit columns in a row, which is the front of both real tables: two strings, a few
 * numbers, and four FileDataIDs among them. Ten because the icon sits at column 5 in each and a
 * fixture that stopped at six would let a reader with the wrong offset pass — the columns after it
 * are here to be read wrongly.
 */
const TEN_PLAIN_COLUMNS: ColumnSpec[] = Array.from({ length: 10 }, (_, index) => ({
  storage: Storage.plain,
  offsetBits: index * 32,
  sizeBits: 32,
}));

/**
 * `JournalInstance` — the Encounter Journal's dungeons and raids.
 *
 * The four files the real table holds side by side are all here, in their places: a background, a
 * wide button banner, the small button icon, and a lore illustration. Only the third of them is an
 * icon, and a reader that took one of its neighbours would hand the window a picture several times
 * too large — so the neighbours hold plausible FileDataIDs of their own that this fixture writes
 * no file for.
 */
const journalInstance: TableSpec = {
  fileDataId: JOURNAL_INSTANCE,
  layoutHash: 0x5c02a91f,
  tableHash: 0x1e77b304,
  idColumn: 0,
  // Bit 2: the ids are kept in a list beside the rows rather than in a column of their own.
  flags: 4,
  recordSize: 40,
  columns: TEN_PLAIN_COLUMNS,
  sections: [
    {
      key: 0n,
      // Name, description, map, background, banner, icon, lore, flags, area, covenant.
      rows: [
        [
          "The Deadmines",
          "A mine the brotherhood took.",
          36,
          180001,
          180002,
          170001,
          180003,
          1,
          1581,
          0,
        ],
        [
          "Sunken Citadel",
          "Drowned and still occupied.",
          643,
          180001,
          180002,
          170002,
          180003,
          1,
          5382,
          0,
        ],
        // A place the group finder knows too, and draws differently. The journal's picture is
        // hand-drawn for this one dungeon and is the one to show.
        ["Tideglass Hollow", "", 645, 180001, 180002, 170004, 180003, 0, 0, 0],
        // An instance the journal lists and draws nothing for, which the real table has two of.
        ["Zekvir's Lair", "", 2680, 0, 0, 0, 0, 0, 0, 0],
        // The same name on a second row, later. First one wins, so this icon is never answered
        // with — the real table has two such pairs.
        [
          "The Deadmines",
          "The same place, listed twice.",
          36,
          180001,
          180002,
          170009,
          180003,
          1,
          1581,
          0,
        ],
      ],
      idList: [63, 64, 65, 1310, 2000],
    },
    {
      // Encrypted, so its row arrives as zeroes: an instance from content this install has not
      // been given the key to.
      key: 0x2f9a4c71d3e58b06n,
      rows: [["Unreleased Halls", "", 0, 0, 0, 170005, 0, 0, 0, 0]],
      idList: [1400],
    },
  ],
};

/**
 * `LFGDungeons` — everything the group finder can put a player in.
 *
 * Where the delves are, and the several hundred places the journal has no row for. The real table
 * repeats a dungeon once per difficulty it offers, so two rows here carry the same name; and it
 * draws a good many entries with one generic icon, which is why the two delves below share theirs.
 */
const lfgDungeons: TableSpec = {
  fileDataId: LFG_DUNGEONS,
  layoutHash: 0x71b3ce40,
  tableHash: 0x4d9012af,
  idColumn: 0,
  flags: 4,
  recordSize: 40,
  columns: TEN_PLAIN_COLUMNS,
  sections: [
    {
      key: 0n,
      // Name, description, type, subtype, faction, icon, rewards background, popup background,
      // expansion, map.
      rows: [
        // The two delves, drawn with the one icon the finder gives every entry of the kind.
        ["Grubwarden's Burrow", "", 1, 3, 0, 170003, 180004, 180005, 0, 2680],
        ["Mistvault Shafts", "", 1, 3, 0, 170003, 180004, 180005, 0, 2681],
        // The disputed one: the journal draws it its own way, and this is what the finder shows.
        ["Tideglass Hollow", "", 1, 1, 0, 170006, 180004, 180005, 3, 645],
        // A dungeon the finder lists twice, once per difficulty. Same picture either way.
        ["The Deadmines", "", 1, 1, 0, 170001, 180004, 180005, 0, 36],
        ["The Deadmines", "", 1, 1, 0, 170001, 180004, 180005, 3, 36],
        // A row the finder names and draws nothing for, which several hundred of the real
        // table's rows are: a random-dungeon bucket rather than a place.
        ["Random Delve", "", 6, 3, 0, 0, 0, 0, 0, 0],
      ],
      idList: [2522, 2500, 2210, 6, 326, 2790],
    },
  ],
};

/**
 * The icons the two tables name, one per encoding the client ships.
 *
 * 170005 is deliberately absent: the encrypted journal row names it and no file is written for it,
 * which is what an instance from unshipped content looks like from here. So are 180001 through
 * 180005 — the backgrounds and banners beside the icons, which nothing is meant to be reading.
 */
const icons: IconSpec[] = [
  {
    fileDataId: 170001,
    encoding: Encoding.palette,
    alphaBits: 8,
    alphaType: 0,
    body: palettePixels(8),
  },
  {
    fileDataId: 170002,
    encoding: Encoding.dxt,
    alphaBits: 8,
    alphaType: AlphaType.dxt5,
    body: dxtBlocks(AlphaType.dxt5),
  },
  { fileDataId: 170003, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  {
    fileDataId: 170004,
    encoding: Encoding.palette,
    alphaBits: 0,
    alphaType: 0,
    body: palettePixels(0),
  },
  {
    fileDataId: 170006,
    encoding: Encoding.dxt,
    alphaBits: 1,
    alphaType: AlphaType.dxt1,
    body: dxtBlocks(AlphaType.dxt1),
  },
  { fileDataId: 170009, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
];

/* ---------- go ---------- */

emit("journal", { tables: [journalInstance, lfgDungeons], icons });
