/**
 * Writes the game-file fixtures the transmog tests read: the DB2 tables, and the BLP icons
 * those tables point at.
 *
 * The game describes its transmog sets across a chain of WDC5 tables, and the reader that
 * pulls them apart has to cope with every way that format squeezes a column: bit fields that stop on
 * no particular byte, palettes of distinct values, sparse maps of the rows that differ from
 * a default, ids kept beside the rows rather than in them, rows that are another row under
 * a second id, and whole sections Blizzard encrypted because they belong to content it has
 * not shipped. A fixture that skipped any of that would leave the interesting half of the
 * reader untested. The icons are the same argument in a second format: one BLP per encoding
 * the client actually ships, so the decoder is tested against all of them.
 *
 * So these files have exactly the shape the real ones do — same columns, same storage per
 * column, same bit offsets, same texture headers — and content that is entirely invented.
 * Nothing here is copied from the game.
 *
 *     bun run scripts/make-transmog-fixtures.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop", "fixtures", "transmog");

/** What the game calls each table; the reader asks for them by these numbers. */
const FILE_DATA_ID = {
  transmogSet: 1376213,
  transmogSetItem: 1376212,
  transmogSetGroup: 1576116,
  itemModifiedAppearance: 982457,
  itemAppearance: 982462,
  itemDisplayInfo: 1266429,
  itemDisplayInfoMaterialRes: 1280614,
} as const;

/** How a column was stored, using the file format's own numbering. */
const Storage = {
  plain: 0,
  bitpacked: 1,
  common: 2,
  indexed: 3,
  indexedArray: 4,
  bitpackedSigned: 5,
} as const;

type StorageKind = (typeof Storage)[keyof typeof Storage];

interface ColumnSpec {
  storage: StorageKind;
  /** Where the column starts, in bits from the front of a row. */
  offsetBits: number;
  /** How wide it is. Zero for a sparse column, which is not in the row at all. */
  sizeBits: number;
  /** The value a sparse column takes when it does not list a row. */
  default?: number;
  /** The distinct values a palette column indexes into. */
  palette?: number[];
  /** How many values one palette index names, for a column stored as runs. */
  arrayCount?: number;
  /** The rows a sparse column does list, as id to value. */
  common?: Map<number, number>;
}

interface SectionSpec {
  /** Nonzero marks the section encrypted, and its rows are then written as zeroes. */
  key: bigint;
  /**
   * One entry per row: the value for each column. Strings are given as strings, and a
   * column holding a fixed-size array is given as an array of its elements.
   */
  rows: Array<Array<number | string | number[]>>;
  /** Row ids, when the table keeps them beside the rows rather than inside them. */
  idList?: number[];
  /** Rows that are another row under a second id, as `[new id, row copied]`. */
  copies?: Array<[number, number]>;
  /**
   * The foreign key each record belongs to, as `[foreign id, record index]`, for a table
   * that keeps one outside the row entirely. The record index counts within the section.
   */
  relationships?: Array<[number, number]>;
}

interface TableSpec {
  fileDataId: number;
  layoutHash: number;
  tableHash: number;
  /** Which column holds the row id, when it is stored inside the row. */
  idColumn: number;
  /** Bit 2 is what the game sets on a table that keeps its ids beside the rows. */
  flags: number;
  recordSize: number;
  columns: ColumnSpec[];
  sections: SectionSpec[];
}

/* ---------- the tables ---------- */

/**
 * `TransmogSet` — the sets themselves, and the one table with a string in it.
 *
 * The column storages below are the ones the shipping game uses, down to the bit offsets:
 * a plain string offset, six signed bit fields of awkward widths, three palettes and three
 * sparse columns.
 */
const transmogSet: TableSpec = {
  fileDataId: FILE_DATA_ID.transmogSet,
  layoutHash: 0xc6875c71,
  tableHash: 0x15380bd8,
  idColumn: 1,
  flags: 0,
  recordSize: 16,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name
    { storage: Storage.bitpackedSigned, offsetBits: 32, sizeBits: 14 }, // ID
    { storage: Storage.bitpackedSigned, offsetBits: 46, sizeBits: 16 }, // ClassMask
    { storage: Storage.common, offsetBits: 62, sizeBits: 0, default: 0, common: new Map([[204, 8801]]) }, // TrackingQuestID
    { storage: Storage.indexed, offsetBits: 62, sizeBits: 6, palette: [0, 1, 2, 16] }, // Flags
    { storage: Storage.bitpackedSigned, offsetBits: 68, sizeBits: 10 }, // GroupID
    { storage: Storage.bitpackedSigned, offsetBits: 78, sizeBits: 15 }, // ItemNameDescriptionID
    { storage: Storage.bitpackedSigned, offsetBits: 93, sizeBits: 14 }, // ParentID
    { storage: Storage.common, offsetBits: 107, sizeBits: 0, default: 1, common: new Map() }, // CompleteWorldStateID
    { storage: Storage.bitpackedSigned, offsetBits: 107, sizeBits: 5 }, // ExpansionID
    { storage: Storage.indexed, offsetBits: 112, sizeBits: 7, palette: [0, 100200, 100300, 110000] }, // PatchIntroduced
    { storage: Storage.indexed, offsetBits: 119, sizeBits: 9, palette: [0, 5, 10, 15, 20, 25] }, // UiOrder
    { storage: Storage.common, offsetBits: 128, sizeBits: 0, default: 0, common: new Map([[206, 44]]) }, // ConditionID
  ],
  sections: [
    {
      key: 0n,
      // Name, ID, ClassMask, TrackingQuest, Flags, Group, ItemNameDesc, Parent, WorldState,
      // Expansion, Patch, UiOrder, Condition. The sparse columns take no room in a row.
      rows: [
        ["Tideglass Regalia", 201, 0x0190, 0, 1, 1, 0, 0, 0, 3, 100200, 5, 0],
        ["Tideglass Hide", 202, 0x0e08, 0, 1, 1, 0, 201, 0, 3, 100200, 10, 0],
        ["Emberforge Plate", 203, 0x0023, 0, 2, 2, 0, 0, 0, 4, 100300, 5, 0],
        ["Emberforge Scales", 204, 0x1044, 0, 2, 2, 0, 203, 0, 4, 100300, 10, 0],
        ["Duskwoven Shroud", 205, 0x0000, 0, 0, 3, 0, 0, 0, 5, 110000, 15, 0],
        ["Lantern-Keeper's Coat", 206, 0x7fff, 0, 16, 3, 0, 0, 0, 5, 110000, 20, 0],
      ],
    },
    {
      // Encrypted, so its rows arrive as zeroes and the reader has to leave them out while
      // still reporting that the table declares more than it could show.
      key: 0x5f2c9a41d3b70e88n,
      rows: [
        ["Unreleased Alpha", 900, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0],
        ["Unreleased Beta", 901, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0],
      ],
    },
  ],
};

/** `TransmogSetGroup` — just a name per collection, with the ids kept beside the rows. */
const transmogSetGroup: TableSpec = {
  fileDataId: FILE_DATA_ID.transmogSetGroup,
  layoutHash: 0xeda13de2,
  tableHash: 0x2b9f1c04,
  idColumn: 0,
  flags: 4,
  recordSize: 4,
  columns: [{ storage: Storage.plain, offsetBits: 0, sizeBits: 32 }],
  sections: [
    {
      key: 0n,
      rows: [["Tideglass Wardrobe"], ["Emberforge Armory"], ["Duskwoven Attire"]],
      idList: [1, 2, 3],
      // Group 7 is group 1 again, which is how the game avoids storing a row twice.
      copies: [[7, 1]],
    },
    {
      key: 0x7d41b6ce22f0a915n,
      rows: [["Unreleased Collection"]],
      idList: [9],
    },
  ],
};

/**
 * `TransmogSetItem` — one row per appearance, keyed to its set.
 *
 * The sets get different-sized wardrobes because the grid counts these rows, and the
 * appearance ids are the first hop of the chain the detail view walks. The game gives that
 * column 19 bits, so every id here fits inside one — an id wider than the column reads back
 * with its top bit gone and joins against nothing.
 */
const transmogSetItem: TableSpec = {
  fileDataId: FILE_DATA_ID.transmogSetItem,
  layoutHash: 0xe6eff061,
  tableHash: 0x3c50ae77,
  idColumn: 0,
  flags: 4,
  recordSize: 5,
  columns: [
    { storage: Storage.bitpacked, offsetBits: 0, sizeBits: 13 }, // TransmogSetID
    { storage: Storage.bitpacked, offsetBits: 13, sizeBits: 19 }, // ItemModifiedAppearanceID
    { storage: Storage.indexed, offsetBits: 32, sizeBits: 3, palette: [0, 1] }, // Flags
  ],
  sections: [
    {
      key: 0n,
      rows: [
        [201, 71001, 0],
        [201, 71002, 0],
        [201, 71003, 1],
        [202, 71004, 0],
        [202, 71005, 0],
        // Set 203 is the one whose appearances span several slots, which is what a detail
        // view grouped by slot has to get right.
        [203, 71006, 0],
        [203, 71007, 0],
        [203, 71008, 0],
        [203, 71009, 1],
        [204, 71010, 0],
        // 71012 is only described in an encrypted section of `ItemModifiedAppearance`, so
        // set 205 has two appearances and can only name one of them.
        [205, 71011, 0],
        [205, 71012, 0],
        [206, 71013, 0],
      ],
      idList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      // A fourteenth appearance for set 201, stored as row 1 again — so the set holds the
      // same appearance twice, and a detail view has to show four rows rather than three.
      copies: [[14, 1]],
    },
    {
      key: 0x91ce07b4a2d5f36en,
      rows: [[900, 71900, 0]],
      idList: [15],
    },
  ],
};

/**
 * `ItemModifiedAppearance` — the hop from an appearance of a set to an actual item.
 *
 * One row per way an item can look, keyed by the id `TransmogSetItem` points at, and
 * carrying the item id and the `ItemAppearance` the look is described by. Its own id is
 * stored inside the row rather than beside it, which is the other half of the pair with
 * `ItemAppearance` below.
 */
const itemModifiedAppearance: TableSpec = {
  fileDataId: FILE_DATA_ID.itemModifiedAppearance,
  layoutHash: 0x1d3f70b2,
  tableHash: 0x58a2ce19,
  idColumn: 0,
  flags: 0,
  recordSize: 9,
  columns: [
    { storage: Storage.bitpackedSigned, offsetBits: 0, sizeBits: 20 }, // ID
    { storage: Storage.bitpacked, offsetBits: 20, sizeBits: 20 }, // ItemID
    { storage: Storage.indexed, offsetBits: 40, sizeBits: 2, palette: [0, 1, 3] }, // Modifier
    { storage: Storage.bitpacked, offsetBits: 42, sizeBits: 20 }, // ItemAppearanceID
    { storage: Storage.bitpacked, offsetBits: 62, sizeBits: 4 }, // OrderIndex
    { storage: Storage.indexed, offsetBits: 66, sizeBits: 3, palette: [0, 1, 2, 3] }, // SourceType
  ],
  sections: [
    {
      key: 0n,
      rows: [
        [71001, 30001, 0, 80001, 0, 1],
        [71002, 30002, 0, 80002, 1, 1],
        [71003, 30003, 1, 80003, 2, 2],
        [71004, 30004, 0, 80004, 0, 1],
        [71005, 30005, 0, 80005, 1, 1],
        [71006, 30006, 0, 80006, 0, 1],
        [71007, 30007, 0, 80007, 1, 1],
        [71008, 30008, 0, 80008, 2, 1],
        [71009, 30009, 3, 80009, 3, 3],
        [71010, 30010, 0, 80010, 0, 2],
        [71011, 30011, 0, 80011, 0, 1],
        [71013, 30013, 0, 80013, 0, 1],
      ],
    },
    {
      // Encrypted, so one of set 205's two appearances cannot be named at all.
      key: 0x2f7a5cd0b1934e6an,
      rows: [
        [71012, 30012, 0, 80012, 1, 1],
        [71900, 30900, 0, 80900, 0, 1],
      ],
    },
  ],
};

/**
 * `ItemAppearance` — what an appearance looks like: which slot, which display, which icon.
 *
 * The game keeps this table's ids beside the rows rather than in them, so a reader that
 * only knows how to find an id inside a record cannot read it at all.
 */
const itemAppearance: TableSpec = {
  fileDataId: FILE_DATA_ID.itemAppearance,
  layoutHash: 0x8c14ba05,
  tableHash: 0x40de7b31,
  idColumn: 0,
  flags: 4,
  recordSize: 8,
  columns: [
    { storage: Storage.bitpacked, offsetBits: 0, sizeBits: 5 }, // DisplayType
    { storage: Storage.bitpacked, offsetBits: 5, sizeBits: 20 }, // ItemDisplayInfoID
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // DefaultIconFileDataID
  ],
  sections: [
    {
      key: 0n,
      // DisplayType is the slot: 0 head, 1 shoulder, 2 chest, 4 legs, 5 feet, 7 hands,
      // 10 shirt, 11 a weapon. Only head, shoulder and the weapons carry a model.
      rows: [
        [0, 900001, 130001],
        [1, 900002, 130002],
        [2, 900003, 130003],
        [5, 900004, 130004],
        [7, 900005, 130005],
        [0, 900001, 130001],
        [1, 900009, 130002],
        [2, 900003, 130003],
        [4, 900006, 130006],
        [11, 900007, 130007],
        // Its display is in an encrypted section of `ItemDisplayInfo`, so the row knows
        // which slot it fills and nothing about how it is drawn.
        [2, 900900, 130008],
        // An appearance the table gives no icon at all.
        [10, 900008, 0],
      ],
      idList: [80001, 80002, 80003, 80004, 80005, 80006, 80007, 80008, 80009, 80010, 80011, 80013],
    },
    {
      key: 0x6b02e9f43d78a1c5n,
      rows: [
        [3, 900004, 130009],
        [0, 900001, 130010],
      ],
      idList: [80012, 80900],
    },
  ],
};

/**
 * `ItemDisplayInfo` — how one appearance is drawn, and the table of array columns.
 *
 * The game keeps a display's two model slots, its two material slots, its six geoset groups
 * and its two model types as fixed-size arrays inside single columns, stored two different
 * ways: the first four plainly, elements laid end to end, and the last as a palette of whole
 * runs. Reading either as one number gets the first element and quietly loses the rest, so
 * the fixture gives every one of them a distinguishable tail.
 *
 * **Two of the column positions below are the game's own and the rest are not.**
 * `ModelResourcesID` at 10 and `ModelMaterialResourcesID` at 11 were read off a real install
 * and are written down in `docs/game-files.md`; the columns before them are filler of the
 * right shape, and `GeosetGroup` and `ModelType` sit where they do only so that something
 * reads them. Nothing outside a test may depend on those two positions until they are
 * verified the way 10 and 11 were.
 */
const itemDisplayInfo: TableSpec = {
  fileDataId: FILE_DATA_ID.itemDisplayInfo,
  layoutHash: 0x9f3ab8a9,
  tableHash: 0x71c40e52,
  idColumn: 0,
  flags: 4,
  recordSize: 57,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Flags
    { storage: Storage.bitpacked, offsetBits: 32, sizeBits: 10 }, // ItemVisual
    { storage: Storage.bitpacked, offsetBits: 42, sizeBits: 10 }, // ParticleColorID
    { storage: Storage.bitpacked, offsetBits: 52, sizeBits: 10 }, // ItemRangedDisplayInfoID
    { storage: Storage.bitpacked, offsetBits: 62, sizeBits: 10 }, // OverrideSwooshSoundKitID
    { storage: Storage.bitpacked, offsetBits: 72, sizeBits: 10 }, // SheatheTransformMatrixID
    { storage: Storage.bitpacked, offsetBits: 82, sizeBits: 10 }, // StateSpellVisualKitID
    { storage: Storage.bitpacked, offsetBits: 92, sizeBits: 10 }, // SheathedSpellVisualKitID
    { storage: Storage.bitpacked, offsetBits: 102, sizeBits: 10 }, // UnsheathedSpellVisualKitID
    { storage: Storage.indexed, offsetBits: 112, sizeBits: 3, palette: [0, 1, 2, 3] }, // HelmetGeosetVis
    { storage: Storage.plain, offsetBits: 128, sizeBits: 64 }, // ModelResourcesID[2]
    { storage: Storage.plain, offsetBits: 192, sizeBits: 64 }, // ModelMaterialResourcesID[2]
    { storage: Storage.plain, offsetBits: 256, sizeBits: 192 }, // GeosetGroup[6]
    {
      storage: Storage.indexedArray,
      offsetBits: 448,
      sizeBits: 3,
      arrayCount: 2,
      // Three runs of two: no model, a one-handed model, a two-handed one.
      palette: [0, 0, 1, 0, 2, 3],
    }, // ModelType[2]
  ],
  sections: [
    {
      key: 0n,
      // Flags, then the eight scalars nothing reads, HelmetGeosetVis, and then the four
      // arrays: models, materials, geoset groups, model types.
      rows: [
        // A helm: one model slot, and the two geoset groups a helm drives.
        [1, 11, 0, 0, 0, 0, 0, 0, 0, 1, [41001, 0], [51001, 0], [27, 21, 0, 0, 0, 0], [1, 0]],
        // Shoulders: both model slots used, left and right.
        [0, 12, 0, 0, 0, 0, 0, 0, 0, 0, [41002, 41003], [51002, 51003], [26, 0, 0, 0, 0, 0], [2, 3]],
        // A chestpiece: no model at all, and five geoset groups it does drive.
        [16, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51004, 0], [8, 10, 13, 22, 28, 0], [0, 0]],
        // Boots, gloves and legs: armour, so no model either.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51005, 0], [5, 20, 0, 0, 0, 0], [0, 0]],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51006, 0], [4, 23, 0, 0, 0, 0], [0, 0]],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51007, 0], [11, 9, 13, 0, 0, 0], [0, 0]],
        // A weapon, which is geometry and nothing else.
        [0, 13, 0, 0, 0, 0, 0, 0, 0, 0, [41004, 0], [51008, 0], [0, 0, 0, 0, 0, 0], [1, 0]],
        // A shirt: nothing at all beyond its material.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51009, 0], [0, 0, 0, 0, 0, 0], [0, 0]],
        // Shoulders that keep their model in the second slot only, which is exactly what a
        // reader that stops at element zero calls "no model at all".
        [0, 14, 0, 0, 0, 0, 0, 0, 0, 0, [0, 41005], [51010, 51011], [26, 0, 0, 0, 0, 0], [2, 3]],
      ],
      idList: [900001, 900002, 900003, 900004, 900005, 900006, 900007, 900008, 900009],
    },
    {
      // Encrypted, so an appearance pointing here knows its slot and nothing more.
      key: 0x5d38af0c9e142b76n,
      rows: [
        [4, 15, 0, 0, 0, 0, 0, 0, 0, 0, [41900, 0], [51900, 0], [27, 0, 0, 0, 0, 0], [1, 0]],
      ],
      idList: [900900],
    },
  ],
};

/**
 * `ItemDisplayInfoMaterialRes` — which texture goes on which part of the body.
 *
 * This is the table that forces the relationship map to be read. Its rows say only "this
 * material, on this section of the body"; which appearance they belong to is not a column
 * of the row at all, and lives in a block of its own beside them. A reader that skipped
 * that block would have the rows and no way to tell whose they are.
 */
const itemDisplayInfoMaterialRes: TableSpec = {
  fileDataId: FILE_DATA_ID.itemDisplayInfoMaterialRes,
  layoutHash: 0x4a2b91c7,
  tableHash: 0x6d18f3a0,
  idColumn: 0,
  flags: 4,
  recordSize: 4,
  columns: [
    { storage: Storage.bitpacked, offsetBits: 0, sizeBits: 5 }, // ComponentSection
    { storage: Storage.bitpacked, offsetBits: 5, sizeBits: 22 }, // MaterialResourcesID
  ],
  sections: [
    {
      key: 0n,
      // Section numbers are the game's own: 0 arms upper, 1 arms lower, 2 hands,
      // 3 torso upper, 4 torso lower, 5 legs upper, 6 legs lower, 7 feet.
      rows: [
        [3, 52001],
        [0, 52002],
        [4, 52003],
        [5, 52004],
        [6, 52005],
        [7, 52006],
        [2, 52007],
      ],
      idList: [1, 2, 3, 4, 5, 6, 7],
      // The chestpiece owns four of these, the boots two and the gloves one — and the
      // display they belong to is only ever written here.
      relationships: [
        [900003, 0],
        [900003, 1],
        [900003, 2],
        [900002, 3],
        [900002, 4],
        [900001, 5],
        [900003, 6],
      ],
    },
    {
      // Encrypted, so the block is reserved at full size and written as zeroes.
      key: 0x3ab8c17d5e920f44n,
      rows: [[3, 52900]],
      idList: [8],
      relationships: [[900900, 0]],
    },
  ],
};

/* ---------- writing one out ---------- */

/** A growable little-endian byte buffer. */
class Bytes {
  private parts: number[] = [];

  get length(): number {
    return this.parts.length;
  }

  u8(value: number): void {
    this.parts.push(value & 0xff);
  }

  u16(value: number): void {
    this.u8(value);
    this.u8(value >>> 8);
  }

  u32(value: number): void {
    this.u16(value);
    this.u16(value >>> 16);
  }

  u64(value: bigint): void {
    this.u32(Number(value & 0xffffffffn));
    this.u32(Number((value >> 32n) & 0xffffffffn));
  }

  bytes(values: Uint8Array | number[]): void {
    for (const value of values) this.parts.push(value & 0xff);
  }

  zeros(count: number): void {
    for (let i = 0; i < count; i += 1) this.parts.push(0);
  }

  toBuffer(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** Lays one row's columns into `recordSize` bytes, at the bit offsets the table declares. */
function packRow(
  table: TableSpec,
  values: Array<number | string | number[]>,
  stringOffsets: Map<number, number>,
): Uint8Array {
  const record = new Uint8Array(table.recordSize);

  /** Bit fields ignore byte boundaries, so a value goes in a bit at a time. */
  const write = (offsetBits: number, sizeBits: number, value: number): void => {
    for (let bit = 0; bit < sizeBits; bit += 1) {
      if (((value >>> bit) & 1) === 0) continue;
      const at = offsetBits + bit;
      record[at >>> 3] |= 1 << (at & 7);
    }
  };

  table.columns.forEach((column, index) => {
    // A sparse column keeps its values in a map at the top of the file, not in the row.
    if (column.storage === Storage.common) return;

    const raw = values[index];

    if (Array.isArray(raw)) {
      // A palette column of runs keeps the elements out in the palette and only the run
      // number in the row, so the row has to name which run holds exactly these values.
      if (column.storage === Storage.indexedArray) {
        const count = column.arrayCount ?? raw.length;
        const palette = column.palette ?? [];
        let run = -1;
        for (let at = 0; at * count + count <= palette.length; at += 1) {
          if (raw.every((value, element) => palette[at * count + element] === value)) {
            run = at;
            break;
          }
        }
        if (run < 0) throw new Error(`Column ${index} has no palette run for [${raw}].`);
        write(column.offsetBits, column.sizeBits, run);
        return;
      }

      // A plainly stored array lays its elements end to end across the column's own width,
      // which is the layout `ItemDisplayInfo` uses for its model slots and geoset groups.
      const elementBits = column.sizeBits / raw.length;
      if (!Number.isInteger(elementBits)) {
        throw new Error(`Column ${index} cannot hold ${raw.length} elements in ${column.sizeBits} bits.`);
      }
      raw.forEach((element, at) => write(column.offsetBits + at * elementBits, elementBits, element));
      return;
    }

    let value: number;
    if (typeof raw === "string") {
      value = stringOffsets.get(index) ?? 0;
    } else if (column.storage === Storage.indexed || column.storage === Storage.indexedArray) {
      const at = (column.palette ?? []).indexOf(raw);
      if (at < 0) throw new Error(`Column ${index} has no palette entry for ${raw}.`);
      value = at;
    } else {
      value = raw;
    }
    write(column.offsetBits, column.sizeBits, value);
  });
  return record;
}

function writeTable(table: TableSpec): Uint8Array {
  const columnCount = table.columns.length;

  // Every section's rows come first in the file, then its strings, and a string offset is
  // written as the distance from the column holding it to the string — counted in a space
  // that runs across every section. So the layout has to be settled before a row can be
  // packed.
  const totalRows = table.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const rowAreaSize = totalRows * table.recordSize;

  // Lay out each section's strings, sharing identical ones the way the game does. Offset 0
  // means "no string", so every string table opens with a spare NUL.
  const sectionStrings: Array<{ blob: Bytes; offsets: Map<string, number>; base: number }> = [];
  let stringsBase = 0;
  for (const section of table.sections) {
    const blob = new Bytes();
    const offsets = new Map<string, number>();
    blob.u8(0);
    for (const row of section.rows) {
      for (const value of row) {
        if (typeof value !== "string" || offsets.has(value)) continue;
        offsets.set(value, blob.length);
        blob.bytes(new TextEncoder().encode(value));
        blob.u8(0);
      }
    }
    sectionStrings.push({ blob, offsets, base: stringsBase });
    stringsBase += blob.length;
  }

  // Pack every row, now that the string positions are known.
  const packed: Uint8Array[][] = [];
  let rowsBefore = 0;
  table.sections.forEach((section, sectionIndex) => {
    const strings = sectionStrings[sectionIndex]!;
    const rows: Uint8Array[] = [];
    section.rows.forEach((values, rowIndex) => {
      const stringOffsets = new Map<number, number>();
      table.columns.forEach((column, columnIndex) => {
        const value = values[columnIndex];
        if (typeof value !== "string") return;
        const target = strings.base + (strings.offsets.get(value) ?? 0);
        const columnAt = rowsBefore + rowIndex * table.recordSize + column.offsetBits / 8;
        // The reader adds this to the column's own position, then counts from the end of
        // the whole row area — so undo exactly that.
        stringOffsets.set(columnIndex, target + rowAreaSize - columnAt);
      });
      rows.push(packRow(table, values, stringOffsets));
    });
    packed.push(rows);
    rowsBefore += section.rows.length * table.recordSize;
  });

  const palette = new Bytes();
  const common = new Bytes();
  for (const column of table.columns) {
    if (column.storage !== Storage.indexed && column.storage !== Storage.indexedArray) continue;
    for (const value of column.palette ?? []) palette.u32(value);
  }
  for (const column of table.columns) {
    if (column.storage !== Storage.common) continue;
    for (const [id, value] of column.common ?? new Map()) {
      common.u32(id);
      common.u32(value);
    }
  }

  const ids = table.sections.flatMap(
    (section) => section.idList ?? section.rows.map((row) => Number(row[table.idColumn])),
  );

  const out = new Bytes();
  out.bytes(new TextEncoder().encode("WDC5"));
  out.u32(5);
  const build = new TextEncoder().encode("CHRONIE_FIXTURE_1_0_0");
  out.bytes(build);
  out.zeros(128 - build.length);

  out.u32(totalRows);
  out.u32(columnCount);
  out.u32(table.recordSize);
  out.u32(stringsBase);
  out.u32(table.tableHash);
  out.u32(table.layoutHash);
  out.u32(Math.min(...ids));
  out.u32(Math.max(...ids));
  out.u32(0); // locale
  out.u16(table.flags);
  out.u16(table.idColumn);
  out.u32(columnCount); // total column count
  out.u32(0); // bitpacked data offset
  out.u32(1); // lookup column count
  out.u32(columnCount * 24);
  out.u32(common.length);
  out.u32(palette.length);
  out.u32(table.sections.length);

  // Section headers. `file_offset` is not read back, so it is left at zero.
  table.sections.forEach((section, sectionIndex) => {
    out.u64(section.key);
    out.u32(0);
    out.u32(section.rows.length);
    out.u32(sectionStrings[sectionIndex]!.blob.length);
    out.u32(0); // offset records end
    out.u32((section.idList?.length ?? 0) * 4);
    // A relationship block is a count, the range it spans, and then its pairs.
    out.u32(section.relationships ? 12 + section.relationships.length * 8 : 0);
    out.u32(0); // offset map entries
    out.u32(section.copies?.length ?? 0);
  });

  // Where each column would sit in an uncompressed row, which the storage descriptions
  // below supersede; the reader skips it, and the game writes it anyway.
  for (const column of table.columns) {
    out.u16(32 - column.sizeBits);
    out.u16(column.offsetBits / 8);
  }

  for (const column of table.columns) {
    out.u16(column.offsetBits);
    out.u16(column.sizeBits);
    out.u32(
      column.storage === Storage.common
        ? (column.common?.size ?? 0) * 8
        : column.palette
          ? column.palette.length * 4
          : 0,
    );
    out.u32(column.storage);
    out.u32(column.storage === Storage.common ? (column.default ?? 0) : column.offsetBits);
    out.u32(column.sizeBits);
    // The last word is how many values one palette index names, for a column of runs.
    out.u32(column.arrayCount ?? 0);
  }

  out.bytes(palette.toBuffer());
  out.bytes(common.toBuffer());

  // A run of per-section counts WDC4 added that nothing reads back.
  for (let i = 0; i < table.sections.length - 1; i += 1) out.u32(0);

  table.sections.forEach((section, sectionIndex) => {
    const encrypted = section.key !== 0n;
    for (const row of packed[sectionIndex]!) {
      // An encrypted section arrives as zeroes, because only Blizzard holds the key.
      out.bytes(encrypted ? new Uint8Array(row.length) : row);
    }
    const strings = sectionStrings[sectionIndex]!;
    out.bytes(encrypted ? new Uint8Array(strings.blob.length) : strings.blob.toBuffer());
    for (const id of section.idList ?? []) out.u32(encrypted ? 0 : id);
    for (const [newId, copied] of section.copies ?? []) {
      out.u32(newId);
      out.u32(copied);
    }
    // The relationship map. An encrypted section still reserves the full block and writes
    // it as zeroes, which is what makes a count of zero the ordinary case there.
    if (section.relationships) {
      const keys = section.relationships.map(([foreign]) => foreign);
      out.u32(encrypted ? 0 : section.relationships.length);
      out.u32(encrypted ? 0 : Math.min(...keys));
      out.u32(encrypted ? 0 : Math.max(...keys));
      for (const [foreign, record] of section.relationships) {
        out.u32(encrypted ? 0 : foreign);
        out.u32(encrypted ? 0 : record);
      }
    }
  });

  return out.toBuffer();
}

/* ---------- the icons ---------- */

/**
 * How a BLP2 stores its pixels, in the format's own numbering.
 *
 * The client ships all three. Which one a given icon uses is not something the tables say,
 * so the decoder meets whichever it is handed and has to read them all.
 */
const Encoding = {
  /** One byte per pixel, indexing a 256-entry palette the header carries. */
  palette: 1,
  /** S3TC blocks of 4×4 pixels; `AlphaType` then picks between BC1, BC2 and BC3. */
  dxt: 2,
  /** Four bytes per pixel, in the order the format writes them: blue, green, red, alpha. */
  bgra: 3,
} as const;

/** Which S3TC flavour a DXT-encoded texture is in, which the header spells as `AlphaType`. */
const AlphaType = {
  /** BC1: colour only. */
  dxt1: 0,
  /** BC2: four explicit bits of alpha per pixel. */
  dxt3: 1,
  /** BC3: interpolated alpha, two endpoints and a three-bit index per pixel. */
  dxt5: 7,
} as const;

/**
 * The four colours every icon fixture is painted in, one per quadrant, as `[r, g, b]`.
 *
 * Each channel is a value 5-6-5 can hold exactly, so a DXT block decodes back to the colour
 * it was written as and the tests can name it rather than allow for rounding. No two
 * channels of a colour are equal, which is what makes a decoder that mixed red up with blue
 * — the trap the palette format sets, since its entries are stored blue first — fail rather
 * than quietly pass.
 */
const QUADRANTS: ReadonlyArray<readonly [number, number, number]> = [
  [66, 130, 198], // top left
  [198, 65, 66], // top right
  [255, 0, 132], // bottom left
  [0, 195, 255], // bottom right
];

/** Icons are square. Eight pixels is two DXT blocks each way, which is the smallest size
 * that puts one whole quadrant in each block. */
const ICON_SIZE = 8;

/** The quadrant a pixel falls in, numbered the way `QUADRANTS` lists them. */
function quadrantAt(x: number, y: number): number {
  return (y < ICON_SIZE / 2 ? 0 : 2) + (x < ICON_SIZE / 2 ? 0 : 1);
}

/**
 * How opaque a quadrant is, for the encodings that carry alpha at all.
 *
 * The bottom right corner is fully transparent so that a decoder which drops the alpha
 * channel, or fills it with the ever-plausible 255, is caught.
 */
function alphaAt(quadrant: number): number {
  return quadrant === 3 ? 0 : 255;
}

/** A colour packed into the 5-6-5 bits a DXT block gives its two endpoints. */
function to565([red, green, blue]: readonly [number, number, number]): number {
  return ((red >>> 3) << 11) | ((green >>> 2) << 5) | (blue >>> 3);
}

/** The palette a palettized icon indexes into: one entry per quadrant, stored blue first. */
function iconPalette(): Bytes {
  const palette = new Bytes();
  for (const [red, green, blue] of QUADRANTS) {
    palette.u8(blue);
    palette.u8(green);
    palette.u8(red);
    palette.u8(0xff);
  }
  palette.zeros(1024 - QUADRANTS.length * 4);
  return palette;
}

/** A palettized icon's pixels: the indices, then a plane of alpha when the header says so. */
function palettePixels(alphaBits: number): Bytes {
  const body = new Bytes();
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) body.u8(quadrantAt(x, y));
  }
  if (alphaBits === 8) {
    for (let y = 0; y < ICON_SIZE; y += 1) {
      for (let x = 0; x < ICON_SIZE; x += 1) body.u8(alphaAt(quadrantAt(x, y)));
    }
  }
  return body;
}

/** An uncompressed icon's pixels, in the blue-green-red-alpha order the format stores. */
function bgraPixels(): Bytes {
  const body = new Bytes();
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const quadrant = quadrantAt(x, y);
      const [red, green, blue] = QUADRANTS[quadrant]!;
      body.u8(blue);
      body.u8(green);
      body.u8(red);
      body.u8(alphaAt(quadrant));
    }
  }
  return body;
}

/**
 * A DXT icon's blocks, one 4×4 block per quadrant.
 *
 * Every block is a flat colour, which is the one case S3TC reproduces exactly: both
 * endpoints are the quadrant's colour and every pixel takes the first of them, so nothing
 * is interpolated and nothing is rounded twice.
 */
function dxtBlocks(alphaType: number): Bytes {
  const body = new Bytes();
  for (let blockY = 0; blockY < ICON_SIZE / 4; blockY += 1) {
    for (let blockX = 0; blockX < ICON_SIZE / 4; blockX += 1) {
      const quadrant = quadrantAt(blockX * 4, blockY * 4);
      const alpha = alphaAt(quadrant);
      if (alphaType === AlphaType.dxt3) {
        // Four bits per pixel, two to a byte. A nibble is expanded by repeating it, so 0xf
        // is fully opaque and 0x0 fully transparent.
        const nibble = alpha === 0 ? 0x00 : 0xff;
        for (let byte = 0; byte < 8; byte += 1) body.u8(nibble);
      }
      if (alphaType === AlphaType.dxt5) {
        // Two endpoints and a three-bit index per pixel; equal endpoints and index zero
        // give every pixel the first endpoint exactly.
        body.u8(alpha);
        body.u8(alpha);
        body.zeros(6);
      }
      const colour = to565(QUADRANTS[quadrant]!);
      body.u16(colour);
      body.u16(colour);
      body.zeros(4); // two bits of index per pixel, all naming the first endpoint
    }
  }
  return body;
}

interface IconSpec {
  fileDataId: number;
  encoding: number;
  /** How many bits of alpha the pixels carry; the DXT flavours declare 0 or 8. */
  alphaBits: number;
  /** Which S3TC flavour, for a DXT icon. Ignored by the other encodings. */
  alphaType: number;
  body: Bytes;
}

/**
 * One BLP2 texture: a 148-byte header, the palette region the format always reserves, and
 * the level-0 pixels.
 *
 * No mipmaps. The header's mipmap sizes are wrong for small levels in the real files, and
 * an icon only ever needs level 0 — so the fixtures declare what the reader is entitled to
 * ask for and nothing else.
 */
function writeIcon(icon: IconSpec): Uint8Array {
  const HEADER = 148;
  const PALETTE = 1024;
  const out = new Bytes();
  out.bytes(new TextEncoder().encode("BLP2"));
  out.u32(1); // content: pixels rather than a JPEG
  out.u8(icon.encoding);
  out.u8(icon.alphaBits);
  out.u8(icon.alphaType);
  out.u8(0); // no mipmaps
  out.u32(ICON_SIZE);
  out.u32(ICON_SIZE);
  // Offsets are counted from the front of the file, and only level 0 is there.
  out.u32(HEADER + PALETTE);
  out.zeros(15 * 4);
  out.u32(icon.body.length);
  out.zeros(15 * 4);
  out.bytes(icon.encoding === Encoding.palette ? iconPalette().toBuffer() : new Uint8Array(PALETTE));
  out.bytes(icon.body.toBuffer());
  return out.toBuffer();
}

/**
 * The icons `ItemAppearance` names, one per encoding the client ships.
 *
 * Which set a given one lands in is worth reading off `itemAppearance` above: sets 201 and
 * 203 share three of these between them, which is the case a decoder that caches has to get
 * right, and 204 and 205 are the two sets whose icons cannot be shown at all.
 */
const icons: IconSpec[] = [
  { fileDataId: 130001, encoding: Encoding.palette, alphaBits: 0, alphaType: 0, body: palettePixels(0) },
  { fileDataId: 130002, encoding: Encoding.palette, alphaBits: 8, alphaType: 0, body: palettePixels(8) },
  {
    fileDataId: 130003, encoding: Encoding.dxt, alphaBits: 0,
    alphaType: AlphaType.dxt1, body: dxtBlocks(AlphaType.dxt1),
  },
  {
    fileDataId: 130004, encoding: Encoding.dxt, alphaBits: 8,
    alphaType: AlphaType.dxt3, body: dxtBlocks(AlphaType.dxt3),
  },
  {
    fileDataId: 130005, encoding: Encoding.dxt, alphaBits: 8,
    alphaType: AlphaType.dxt5, body: dxtBlocks(AlphaType.dxt5),
  },
  { fileDataId: 130006, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
];

/* ---------- go ---------- */

mkdirSync(OUT, { recursive: true });
for (const table of [
  transmogSet,
  transmogSetGroup,
  transmogSetItem,
  itemModifiedAppearance,
  itemAppearance,
  itemDisplayInfo,
  itemDisplayInfoMaterialRes,
]) {
  const bytes = writeTable(table);
  const path = join(OUT, `${table.fileDataId}.db2`);
  writeFileSync(path, bytes);
  console.log(`${path}  ${bytes.length} bytes`);
}

for (const icon of icons) {
  const bytes = writeIcon(icon);
  const path = join(OUT, `${icon.fileDataId}.blp`);
  writeFileSync(path, bytes);
  console.log(`${path}  ${bytes.length} bytes`);
}

// Icon 130007 belongs to content the game has not shipped. Its chunk is encrypted, and a
// chunk only Blizzard holds the key to arrives as zeroes of the right length — so this is
// what a reader is actually handed rather than an error it can act on. 130008 is named by
// an appearance and installed by nobody, which is the other half of the same story.
const withheld = join(OUT, "130007.blp");
writeFileSync(withheld, new Uint8Array(1172));
console.log(`${withheld}  1172 bytes`);
