/**
 * Writes the game-file fixtures the journal tests read: the two tables that draw a *place*, the
 * two that draw a *boss*, and the textures all four name.
 *
 * The place half is two tables and one column of each, which is the whole of what this app asks
 * the game about where a segment happened — everything else about one arrives from the addon as a
 * name. The boss half is a join rather than a lookup: a fight arrives as the `DungeonEncounterID`
 * the client handed `ENCOUNTER_END`, `JournalEncounter` turns that into its own id, and
 * `JournalEncounterCreature` hangs the portrait off it.
 *
 * All four have the shape the game's own do — fixed-size records, strings in a block of their own,
 * and each column in the storage and at the bit offset the real table keeps it at, read off build
 * 12.0.5.67823 with `examples/dump_journal` and written down in `docs/game-files.md`. The two place
 * tables keep their ids in a list beside the rows and the two boss tables keep theirs in a column,
 * which is the one structural difference between the halves. The contents are entirely invented;
 * nothing here is copied from the game. How any of it is written out is [`db2-fixtures.ts`].
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
const JOURNAL_ENCOUNTER = 1240336;
const JOURNAL_ENCOUNTER_CREATURE = 1301155;

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
 * Something in `JournalEncounter`'s 64-bit map column, so that it is not silently empty: a reader
 * that mistook it for the id column beside it comes back with a wildly wrong number rather than a
 * zero. Nothing reads it — the real column is a pair of floats naming where the guide pins the
 * fight on the instance map.
 */
const MAP_PIN = 1052443809;

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
 * `JournalEncounter` — the Adventure Guide's fights, and the way from the id a segment carries to
 * the table that holds a portrait.
 *
 * It draws nothing itself. What it has is `DungeonEncounterID` in column 5, which is the number the
 * client hands `ENCOUNTER_END` and therefore the only thing a recorded fight can be looked up by,
 * and its own id in column 3, which is what the creatures hang off. Every column the real table has
 * is here in the storage it keeps it in, because this table is read by *number* rather than by name
 * — a run that landed a column out would show wrong ids rather than obvious nonsense, so the
 * neighbours have to be there to be read wrongly.
 */
const journalEncounter: TableSpec = {
  fileDataId: JOURNAL_ENCOUNTER,
  layoutHash: 0x2ab41d76,
  tableHash: 0x7f30c185,
  idColumn: 3,
  flags: 0,
  recordSize: 28,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name_lang
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // Description_lang
    // The pin the guide puts on the instance map, as a pair of floats. Nothing reads it; it is
    // here because it is 64 bits wide and every column after it sits behind those bits.
    { storage: Storage.plain, offsetBits: 64, sizeBits: 64 }, // Map
    { storage: Storage.bitpackedSigned, offsetBits: 128, sizeBits: 13 }, // ID
    { storage: Storage.bitpacked, offsetBits: 141, sizeBits: 11 }, // JournalInstanceID
    { storage: Storage.bitpacked, offsetBits: 152, sizeBits: 12 }, // DungeonEncounterID
    { storage: Storage.bitpacked, offsetBits: 164, sizeBits: 7 }, // OrderIndex
    { storage: Storage.bitpacked, offsetBits: 171, sizeBits: 16 }, // FirstSectionID
    { storage: Storage.bitpacked, offsetBits: 187, sizeBits: 12 }, // UiMapID
    { storage: Storage.bitpacked, offsetBits: 199, sizeBits: 17 }, // MapDisplayConditionID
    { storage: Storage.bitpackedSigned, offsetBits: 216, sizeBits: 7 }, // Flags
    {
      // DifficultyMask. Most fights are on every difficulty the instance offers, so the table
      // lists only the ones that are not — which is what a sparse column is for.
      storage: Storage.common,
      offsetBits: 223,
      sizeBits: 0,
      default: 255,
      common: new Map([[503, 1]]),
    },
  ],
  sections: [
    {
      key: 0n,
      // Name, description, map pin, ID, JournalInstanceID, DungeonEncounterID, OrderIndex,
      // FirstSectionID, UiMapID, MapDisplayConditionID, Flags. The sparse column takes no room.
      rows: [
        // The ordinary case, twice: one fight, one creature, one portrait. The instance ids are
        // the same 63 and 64 the place tables above file The Deadmines and Sunken Citadel under,
        // which is what says the two halves of this fixture describe one world.
        [
          "Sludgefang",
          "It came up through the flooded shaft.",
          MAP_PIN,
          501,
          63,
          3101,
          1,
          9001,
          36,
          0,
          0,
        ],
        ["Warden Grask", "", MAP_PIN, 502, 64, 3102, 1, 9002, 643, 0, 0],
        // A council fight: three creatures, and the guide leads with the one stored second. The
        // real table has twenty of these and stores eleven of them out of order.
        ["The Tidewrought Trio", "", MAP_PIN, 503, 65, 3103, 2, 9003, 645, 0, 0],
        // A fight the guide describes and hangs no creature off at all.
        ["Hollow Echo", "", MAP_PIN, 504, 63, 3104, 2, 9004, 36, 0, 0],
        // A fight whose one creature names no portrait.
        ["Silent Warden", "", MAP_PIN, 505, 64, 3105, 2, 9005, 643, 0, 0],
        // A fight whose one creature is in a section the game encrypts.
        ["Sealed Custodian", "", MAP_PIN, 506, 65, 3106, 3, 9006, 645, 0, 0],
        // One `DungeonEncounterID` on two rows, which is a fight the guide describes once per
        // difficulty tier — twelve of the real table's are. The first row reaches no creature and
        // the second does, so a reader that stopped at the first row it matched draws nothing.
        ["Ravener", "", MAP_PIN, 507, 1310, 3107, 1, 9007, 2680, 0, 0],
        ["Ravener", "", MAP_PIN, 508, 1310, 3107, 1, 9008, 2680, 0, 0],
        // A row the table gives no `DungeonEncounterID`, which fifty-eight of the real ones are:
        // named in the guide and not something the client ever reports.
        ["Unsettled Vault", "", MAP_PIN, 509, 2000, 0, 1, 9009, 2680, 0, 0],
        // A fight whose portrait is a file this install has no bytes for.
        ["Gloomtide Herald", "", MAP_PIN, 510, 63, 3109, 3, 9010, 36, 0, 0],
      ],
    },
    {
      // Encrypted, so the whole row arrives as zeroes — a fight from content this install has not
      // been given the key to. Nothing can be looked up by an id that reads as zero.
      key: 0x2f9a4c71d3e58b06n,
      rows: [["Unreleased Warden", "", MAP_PIN, 511, 1400, 3108, 1, 9011, 2680, 0, 0]],
    },
  ],
};

/**
 * `JournalEncounterCreature` — the portraits, one row per creature the guide shows for a fight.
 *
 * Column 5 is the portrait and column 6 is where the guide puts the creature among the fight's
 * others. Both are here in the storage the real table keeps them in, and the portrait's palette
 * holds a zero because 734 of the real table's 1,906 rows name no file at all.
 */
const journalEncounterCreature: TableSpec = {
  fileDataId: JOURNAL_ENCOUNTER_CREATURE,
  layoutHash: 0x63e08b12,
  tableHash: 0x19c4ba7d,
  idColumn: 2,
  flags: 0,
  recordSize: 16,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name_lang
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // Description_lang
    { storage: Storage.bitpackedSigned, offsetBits: 64, sizeBits: 14 }, // ID
    { storage: Storage.bitpacked, offsetBits: 78, sizeBits: 12 }, // JournalEncounterID
    { storage: Storage.bitpacked, offsetBits: 90, sizeBits: 18 }, // CreatureDisplayInfoID
    {
      storage: Storage.indexed,
      offsetBits: 108,
      sizeBits: 11,
      palette: [0, 170011, 170012, 170013, 170014, 170015, 170016, 170018],
    }, // FileDataID
    { storage: Storage.bitpacked, offsetBits: 119, sizeBits: 4 }, // OrderIndex
    {
      // Unread, and sparse in the real table too. Here so that a reader which walked past the
      // order index lands on a column rather than off the end of the record.
      storage: Storage.common,
      offsetBits: 123,
      sizeBits: 0,
      default: 9,
      common: new Map([[604, 12]]),
    },
  ],
  sections: [
    {
      key: 0n,
      // Name, description, ID, JournalEncounterID, CreatureDisplayInfoID, FileDataID, OrderIndex.
      rows: [
        ["Sludgefang", "", 601, 501, 41001, 170011, 0],
        ["Warden Grask", "", 602, 502, 41002, 170012, 0],
        // The council, stored in none of the orders that would make first-row-wins right: the
        // creature the guide leads with is second in the table and third by id.
        ["Mirefin Elder", "", 603, 503, 41003, 170013, 2],
        ["Coilspine", "", 604, 503, 41004, 170014, 0],
        ["Brackwater Adept", "", 605, 503, 41005, 170015, 1],
        // A creature the guide shows and draws no portrait for. Not the same as an absent row:
        // nothing decodes FileDataID zero, and answering with it would have the window asking
        // for a picture that cannot exist.
        ["Silent Warden", "", 606, 505, 41006, 0, 0],
        // The Ravener, hanging off the second of its two journal rows. It shares a portrait with
        // Sludgefang, which the real table does too — Mannoroth and Varo'then are one file.
        ["Ravener", "", 607, 508, 41007, 170011, 0],
        // A portrait this install has no file for, which is what an unshipped texture looks like
        // from here: the row reads perfectly and there are no bytes behind it.
        ["Gloomtide Herald", "", 608, 510, 41008, 170018, 0],
        // A creature belonging to a fight no journal row describes, so nothing can reach it. The
        // real table has rows like this after a patch removes an encounter.
        ["Deepwarden", "", 609, 550, 41009, 170012, 0],
      ],
    },
    {
      // Encrypted, so this row arrives as zeroes and the Sealed Custodian is left undrawn — even
      // though its journal row is perfectly readable. 170016 is named here and nowhere else, and
      // no file is written for it.
      key: 0x8c14f6a09b7e2d53n,
      rows: [["Sealed Custodian", "", 610, 506, 41010, 170016, 0]],
    },
  ],
};

/**
 * The textures the four tables name, one per encoding the client ships.
 *
 * 170001 through 170009 are the place icons, standing in for the 128×128 the real tables name;
 * 170011 upwards are the boss portraits, standing in for their 128×64. Both are written eight
 * pixels square, because what a test can check about a picture is the pixels rather than the shape
 * — the shapes are settled against the install by `examples/dump_journal`, and `icons.rs` is what
 * would refuse one that came back far too large.
 *
 * Three of the ids are deliberately absent. 170005 is named by the encrypted journal row and
 * 170016 by the encrypted creature row, which is what a texture from unshipped content looks like
 * from here. 170018 is named by a perfectly readable creature row and has no bytes behind it, which
 * is what a texture this install never downloaded looks like. So are 180001 through 180005 — the
 * backgrounds and banners beside the place icons, which nothing is meant to be reading.
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
  // The portraits. Sludgefang's is palettized and the Ravener shares it, so one file answers two
  // fights — which is the case the icon cache exists for.
  {
    fileDataId: 170011,
    encoding: Encoding.palette,
    alphaBits: 8,
    alphaType: 0,
    body: palettePixels(8),
  },
  { fileDataId: 170012, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  // The council's three, each in a different encoding, so whichever one the order index picks the
  // test is still reading a real decode rather than the same bytes three times.
  {
    fileDataId: 170013,
    encoding: Encoding.dxt,
    alphaBits: 1,
    alphaType: AlphaType.dxt1,
    body: dxtBlocks(AlphaType.dxt1),
  },
  {
    fileDataId: 170014,
    encoding: Encoding.dxt,
    alphaBits: 8,
    alphaType: AlphaType.dxt5,
    body: dxtBlocks(AlphaType.dxt5),
  },
  {
    fileDataId: 170015,
    encoding: Encoding.palette,
    alphaBits: 0,
    alphaType: 0,
    body: palettePixels(0),
  },
];

/* ---------- go ---------- */

emit("journal", {
  tables: [journalInstance, lfgDungeons, journalEncounter, journalEncounterCreature],
  icons,
});
