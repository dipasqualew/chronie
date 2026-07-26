/**
 * Writes the DB2 fixtures the transmog tests read.
 *
 * The game keeps its transmog sets in three WDC5 tables, and the reader that pulls them
 * apart has to cope with every way that format squeezes a column: bit fields that stop on
 * no particular byte, palettes of distinct values, sparse maps of the rows that differ from
 * a default, ids kept beside the rows rather than in them, rows that are another row under
 * a second id, and whole sections Blizzard encrypted because they belong to content it has
 * not shipped. A fixture that skipped any of that would leave the interesting half of the
 * reader untested.
 *
 * So these files have exactly the shape the real ones do — same columns, same storage per
 * column, same bit offsets — and content that is entirely invented. Nothing here is copied
 * from the game.
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
  /** The rows a sparse column does list, as id to value. */
  common?: Map<number, number>;
}

interface SectionSpec {
  /** Nonzero marks the section encrypted, and its rows are then written as zeroes. */
  key: bigint;
  /** One entry per row: the value for each column, with strings given as strings. */
  rows: Array<Array<number | string>>;
  /** Row ids, when the table keeps them beside the rows rather than inside them. */
  idList?: number[];
  /** Rows that are another row under a second id, as `[new id, row copied]`. */
  copies?: Array<[number, number]>;
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
 * Nothing reads the appearance ids yet; what the view wants is how many rows point at each
 * set, which is why the fixture gives the sets different-sized wardrobes.
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
        [201, 700001, 0],
        [201, 700002, 0],
        [201, 700003, 1],
        [202, 700004, 0],
        [202, 700005, 0],
        [203, 700006, 0],
        [203, 700007, 0],
        [203, 700008, 0],
        [203, 700009, 1],
        [204, 700010, 0],
        [205, 700011, 0],
        [205, 700012, 0],
        [206, 700013, 0],
      ],
      idList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      // A fourteenth appearance for set 201, stored as row 1 again.
      copies: [[14, 1]],
    },
    {
      key: 0x91ce07b4a2d5f36en,
      rows: [[900, 700900, 0]],
      idList: [15],
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
  values: Array<number | string>,
  stringOffsets: Map<number, number>,
): Uint8Array {
  const record = new Uint8Array(table.recordSize);
  table.columns.forEach((column, index) => {
    // A sparse column keeps its values in a map at the top of the file, not in the row.
    if (column.storage === Storage.common) return;

    const raw = values[index];
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

    // Bit fields ignore byte boundaries, so write the value a bit at a time.
    for (let bit = 0; bit < column.sizeBits; bit += 1) {
      if (((value >>> bit) & 1) === 0) continue;
      const at = column.offsetBits + bit;
      record[at >>> 3] |= 1 << (at & 7);
    }
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
    out.u32(0); // relationship data size
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
    out.u32(0);
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
  });

  return out.toBuffer();
}

/* ---------- go ---------- */

mkdirSync(OUT, { recursive: true });
for (const table of [transmogSet, transmogSetGroup, transmogSetItem]) {
  const bytes = writeTable(table);
  const path = join(OUT, `${table.fileDataId}.db2`);
  writeFileSync(path, bytes);
  console.log(`${path}  ${bytes.length} bytes`);
}
