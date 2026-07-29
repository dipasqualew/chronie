/**
 * Writes the game-file fixtures the currency tests read: `CurrencyTypes` and the icons it names.
 *
 * One table and one column of it, which is the whole of what this app asks the game about a
 * currency — everything else about one arrives from the addon. The table below has the shape the
 * game's own does: fixed-size records, its two strings in a block of their own, and the icon in
 * column 3, read off build 12.0.5.67823 with `examples/dump_currencies` and written down in
 * `docs/game-files.md`. The contents are entirely invented; nothing here is copied from the game.
 * How any of it is written out is [`db2-fixtures.ts`].
 *
 *     bun run scripts/make-currency-fixtures.ts
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

/** What the game calls the table; the reader asks for it by this number. */
const CURRENCY_TYPES = 1095531;

/**
 * `CurrencyTypes` — every currency the game has, with the picture each is drawn with.
 *
 * The first ten columns of the real table are here in their places, including the eight nothing
 * reads: leaving them out would move the icon and let a reader with the wrong offset pass. The
 * two strings lead, because that is where the real table keeps them, and the icon sits third
 * after the category — which is the one position this fixture exists to hold anything to.
 */
const currencyTypes: TableSpec = {
  fileDataId: CURRENCY_TYPES,
  layoutHash: 0x3ac91e57,
  tableHash: 0x7b1d0426,
  idColumn: 0,
  // Bit 2: the ids are kept in a list beside the rows rather than in a column of their own.
  flags: 4,
  recordSize: 40,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name_lang
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // Description_lang
    { storage: Storage.plain, offsetBits: 64, sizeBits: 32 }, // CategoryID
    { storage: Storage.plain, offsetBits: 96, sizeBits: 32 }, // InventoryIconFileID
    { storage: Storage.plain, offsetBits: 128, sizeBits: 32 }, // SpellWeight
    { storage: Storage.plain, offsetBits: 160, sizeBits: 32 }, // SpellCategory
    { storage: Storage.plain, offsetBits: 192, sizeBits: 32 }, // MaxQty
    { storage: Storage.plain, offsetBits: 224, sizeBits: 32 }, // MaxEarnablePerWeek
    { storage: Storage.plain, offsetBits: 256, sizeBits: 32 }, // Quality
    { storage: Storage.plain, offsetBits: 288, sizeBits: 32 }, // FactionID
  ],
  sections: [
    {
      key: 0n,
      // Name, description, category, icon, and the six after it that nothing reads.
      rows: [
        ["Honor", "Earned in battlegrounds.", 2, 160001, 0, 0, 15000, 0, 3, 0],
        ["Valorstones", "Spent on upgrading gear.", 142, 160002, 0, 0, 2000, 0, 3, 0],
        // A currency the game names and draws nothing for, which several hundred of the real
        // table's rows are: an internal counter rather than something a player is shown.
        ["Warband Tally", "", 142, 0, 0, 0, 0, 0, 1, 0],
        // One whose icon this install has no file for — a currency added by a patch newer than
        // the storage. It resolves to an id and the id resolves to nothing, which is a line
        // that draws without a picture rather than a failure.
        ["Ember Shards", "", 250, 160003, 0, 0, 0, 0, 3, 0],
      ],
      idList: [1792, 3008, 4001, 4002],
    },
    {
      // Encrypted, so its row arrives as zeroes: a currency the addon recorded on a build that
      // has shipped content this install has not.
      key: 0x51e7c3a9b2064d18n,
      rows: [["Unreleased Token", "", 250, 160004, 0, 0, 0, 0, 3, 0]],
      idList: [4900],
    },
  ],
};

/**
 * The icons the currencies name, one per encoding the client ships.
 *
 * 160003 is deliberately absent: `CurrencyTypes` names it and no file is written for it, which
 * is what a currency added by a newer patch looks like from here.
 */
const icons: IconSpec[] = [
  {
    fileDataId: 160001,
    encoding: Encoding.palette,
    alphaBits: 8,
    alphaType: 0,
    body: palettePixels(8),
  },
  {
    fileDataId: 160002,
    encoding: Encoding.dxt,
    alphaBits: 8,
    alphaType: AlphaType.dxt5,
    body: dxtBlocks(AlphaType.dxt5),
  },
  { fileDataId: 160004, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
];

/* ---------- go ---------- */

emit("currencies", { tables: [currencyTypes], icons });
