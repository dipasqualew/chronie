/**
 * Writing the game's own file formats, with entirely invented contents.
 *
 * The tests never read a World of Warcraft install, so every fixture they read is written
 * from here: real WDC5 tables and real BLP2 textures, with the shape of the game's own
 * files — same columns, same storage per column, same bit offsets, same encodings — and
 * contents nothing was copied into.
 *
 * That shape is the point. Blizzard packs hard, and a fixture that skipped the awkward
 * halves of the format would leave the awkward halves of the reader untested: bit fields
 * that stop on no particular byte, palettes of distinct values, sparse maps of the rows that
 * differ from a default, ids kept beside the rows rather than in them, rows that are another
 * row under a second id, foreign keys that are in no column at all, records that vary in
 * length with their strings written inside them, and whole sections Blizzard encrypted
 * because they belong to content it has not shipped.
 *
 * Which tables a given area of the game needs is not this file's business. That belongs to
 * the scripts beside it — `make-transmog-fixtures.ts`, `make-achievement-fixtures.ts` — one
 * per area, each ending in a call to [`emit`].
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** How a column was stored, using the file format's own numbering. */
export const Storage = {
  plain: 0,
  bitpacked: 1,
  common: 2,
  indexed: 3,
  indexedArray: 4,
  bitpackedSigned: 5,
} as const;

export type StorageKind = (typeof Storage)[keyof typeof Storage];

export interface ColumnSpec {
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

export interface SectionSpec {
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

export interface TableSpec {
  fileDataId: number;
  layoutHash: number;
  tableHash: number;
  /** Which column holds the row id, when it is stored inside the row. */
  idColumn: number;
  /**
   * Bit 0 is what the game sets on a table whose records vary in length, and bit 2 on one
   * that keeps its ids beside the rows.
   */
  flags: number;
  /** How wide one record is. Zero for a table whose records vary, which says so per record. */
  recordSize: number;
  /**
   * The columns holding text, for a table whose records vary in length.
   *
   * Such a table writes its strings into the record rather than into a block of its own, so
   * how long a row is depends on what is in it — and nothing in the file says which columns
   * those are. Ignored by a table of fixed-size records, which stores every string as an
   * offset regardless.
   */
  textColumns?: number[];
  columns: ColumnSpec[];
  sections: SectionSpec[];
}

/** Whether a table's records vary in length, which is the flag that changes its whole layout. */
function isVariable(table: TableSpec): boolean {
  return (table.flags & 1) !== 0;
}

/* ---------- writing one out ---------- */

/** A growable little-endian byte buffer. */
export class Bytes {
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

  /** A single-precision float, which is how a model stores every position it has. */
  f32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let index = 0; index < 4; index += 1) this.u8(view.getUint8(index));
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

  /**
   * Rewrites four bytes already written.
   *
   * A section of variable-length records has to say where in the file its records start and
   * end, and that is not known until everything in front of them has been written — so the
   * header leaves room and comes back for it.
   */
  patchU32(at: number, value: number): void {
    for (let byte = 0; byte < 4; byte += 1) this.parts[at + byte] = (value >>> (byte * 8)) & 0xff;
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
        throw new Error(
          `Column ${index} cannot hold ${raw.length} elements in ${column.sizeBits} bits.`,
        );
      }
      raw.forEach((element, at) =>
        write(column.offsetBits + at * elementBits, elementBits, element),
      );
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

/**
 * Lays one row of a variable-length table out: its columns end to end, strings and all.
 *
 * Nothing is bitpacked here — the game does not pack a table it cannot address by arithmetic
 * — so every column is a whole number of bytes and a string is simply the text and a NUL.
 * Which is what makes the record as long as its contents, and the offset map necessary.
 */
function packVariableRow(table: TableSpec, values: Array<number | string | number[]>): Uint8Array {
  const record = new Bytes();
  const text = new Set(table.textColumns ?? []);

  table.columns.forEach((column, index) => {
    // A sparse column keeps its values in a map at the top of the file, not in the row.
    if (column.storage === Storage.common) return;

    const raw = values[index];
    if (text.has(index)) {
      record.bytes(new TextEncoder().encode(String(raw ?? "")));
      record.u8(0);
      return;
    }
    if (column.storage !== Storage.plain) {
      throw new Error(`Column ${index} varies in length and cannot be packed as a bit field.`);
    }

    const elements = Array.isArray(raw) ? raw : [Number(raw ?? 0)];
    const width = column.sizeBits / 8 / elements.length;
    if (!Number.isInteger(width)) {
      throw new Error(
        `Column ${index} cannot hold ${elements.length} elements in ${column.sizeBits} bits.`,
      );
    }
    for (const element of elements) {
      // Anything above four bytes wide is written as a word and then zeroes: the values here
      // fit, and the point of such a column is the room it takes rather than what is in it.
      for (let byte = 0; byte < width; byte += 1) {
        record.u8(byte < 4 ? element >>> (byte * 8) : 0);
      }
    }
  });
  return record.toBuffer();
}

export function writeTable(table: TableSpec): Uint8Array {
  const columnCount = table.columns.length;
  const variable = isVariable(table);

  // Every section's rows come first in the file, then its strings, and a string offset is
  // written as the distance from the column holding it to the string — counted in a space
  // that runs across every section. So the layout has to be settled before a row can be
  // packed. A table of variable-length records has no string block at all: the text is in
  // the record, and where a record is comes out of the offset map instead.
  const totalRows = table.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const rowAreaSize = totalRows * table.recordSize;

  // Lay out each section's strings, sharing identical ones the way the game does. Offset 0
  // means "no string", so every string table opens with a spare NUL.
  const sectionStrings: Array<{ blob: Bytes; offsets: Map<string, number>; base: number }> = [];
  let stringsBase = 0;
  for (const section of table.sections) {
    const blob = new Bytes();
    const offsets = new Map<string, number>();
    if (!variable) {
      blob.u8(0);
      for (const row of section.rows) {
        for (const value of row) {
          if (typeof value !== "string" || offsets.has(value)) continue;
          offsets.set(value, blob.length);
          blob.bytes(new TextEncoder().encode(value));
          blob.u8(0);
        }
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
      if (variable) {
        rows.push(packVariableRow(table, values));
        return;
      }
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

  // Section headers. Where a section's records begin and end is only worth stating when they
  // vary in length, and is only known once everything in front of them has been written — so
  // those two words are left blank and filled in below.
  const placeRecords: Array<{ at: number; end: number }> = [];
  table.sections.forEach((section, sectionIndex) => {
    out.u64(section.key);
    placeRecords.push({ at: out.length, end: 0 });
    out.u32(0); // file offset
    out.u32(section.rows.length);
    out.u32(sectionStrings[sectionIndex]!.blob.length);
    placeRecords[sectionIndex]!.end = out.length;
    out.u32(0); // offset records end
    out.u32((section.idList?.length ?? 0) * 4);
    // A relationship block is a count, the range it spans, and then its pairs.
    out.u32(section.relationships ? 12 + section.relationships.length * 8 : 0);
    out.u32(variable ? section.rows.length : 0); // offset map entries
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
    const place = placeRecords[sectionIndex]!;
    out.patchU32(place.at, out.length);
    // Where each record of a variable-length section starts, as the file counts positions,
    // and how long it is. Gathered while the records go down and written out below.
    const map: Array<[number, number]> = [];
    for (const row of packed[sectionIndex]!) {
      map.push([out.length, row.length]);
      // An encrypted section arrives as zeroes, because only Blizzard holds the key.
      out.bytes(encrypted ? new Uint8Array(row.length) : row);
    }
    out.patchU32(place.end, out.length);

    const strings = sectionStrings[sectionIndex]!;
    out.bytes(encrypted ? new Uint8Array(strings.blob.length) : strings.blob.toBuffer());
    for (const id of section.idList ?? []) out.u32(encrypted ? 0 : id);
    for (const [newId, copied] of section.copies ?? []) {
      out.u32(newId);
      out.u32(copied);
    }
    // The offset map, which is what makes records of different lengths addressable at all.
    // An encrypted section reserves it and writes it as zeroes, like everything else it holds.
    if (variable) {
      for (const [at, size] of map) {
        out.u32(encrypted ? 0 : at);
        out.u16(encrypted ? 0 : size);
      }
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
    // The row ids a second time, which every table of variable-length records carries beside
    // the list above and which agrees with it throughout.
    if (variable) {
      for (const id of section.idList ?? []) out.u32(encrypted ? 0 : id);
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
export const Encoding = {
  /** One byte per pixel, indexing a 256-entry palette the header carries. */
  palette: 1,
  /** S3TC blocks of 4×4 pixels; `AlphaType` then picks between BC1, BC2 and BC3. */
  dxt: 2,
  /** Four bytes per pixel, in the order the format writes them: blue, green, red, alpha. */
  bgra: 3,
} as const;

/** Which S3TC flavour a DXT-encoded texture is in, which the header spells as `AlphaType`. */
export const AlphaType = {
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
export function palettePixels(alphaBits: number): Bytes {
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
export function bgraPixels(): Bytes {
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

/** One colour a body texture is painted in, as `[red, green, blue, alpha]`. */
export type Paint = readonly [number, number, number, number];

/**
 * A texture in two horizontal bands, uncompressed, for the pictures armour is painted on a
 * body with.
 *
 * The icons above are four quadrants of the same four colours, which is what says a decoder
 * read them. These are the other job: a body texture is blitted into one rectangle of a
 * 2048 × 1024 atlas, and what has to be provable about it is *where it landed* and *how* — so
 * each one is painted in colours of its own, and in two bands rather than one flat tone.
 *
 * The bands are what hold the two traps in `docs/character-rendering.md` to account, and both
 * of them look like a plausible picture rather than an error:
 *
 * - **A band with no alpha** says whether the layer was blended or copied. A straight copy
 *   erases the body wherever the item is transparent, which is a hole in the arm for every
 *   sleeveless chestpiece.
 * - **Two opaque bands** say whether it was scaled with a linear filter. Nearest-neighbour
 *   leaves the seam between them a hard edge; a linear filter leaves a row of blends, and the
 *   textures are authored eight pixels tall against a rectangle a few hundred deep.
 */
export function bodyPixels(top: Paint, bottom: Paint): Bytes {
  const body = new Bytes();
  for (let y = 0; y < ICON_SIZE; y += 1) {
    const [red, green, blue, alpha] = y < ICON_SIZE / 2 ? top : bottom;
    for (let x = 0; x < ICON_SIZE; x += 1) {
      body.u8(blue);
      body.u8(green);
      body.u8(red);
      body.u8(alpha);
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
export function dxtBlocks(alphaType: number): Bytes {
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

export interface IconSpec {
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
export function writeIcon(icon: IconSpec): Uint8Array {
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
  out.bytes(
    icon.encoding === Encoding.palette ? iconPalette().toBuffer() : new Uint8Array(PALETTE),
  );
  out.bytes(icon.body.toBuffer());
  return out.toBuffer();
}

/* ---------- putting a set of them on disk ---------- */

/**
 * A file written exactly as given: one an area's own writer produced, or one of the cases no
 * encoder produces at all.
 *
 * A texture belonging to content the game has not shipped arrives as zeroes of the right
 * length, because only Blizzard holds the key to the chunk it was in — so what a reader is
 * handed is a well-formed read of nothing, rather than an error it could act on.
 */
export interface RawFixture {
  fileDataId: number;
  extension: string;
  bytes: Uint8Array;
  /** Why the file is what it is, printed beside it so a run says what it wrote. */
  note?: string;
}

/**
 * Where a run puts what it writes. `apps/desktop/fixtures/` unless a caller says otherwise.
 *
 * `CHRONIE_FIXTURE_ROOT` is what lets `check-fixtures.ts` run every generator into a temporary
 * directory and compare the result with what is committed, which is the only way to know that
 * the committed bytes are still the bytes these scripts produce. Overwriting the real ones to
 * find that out would be a check that fixes what it is checking.
 */
export const fixtureRoot = (): string =>
  process.env.CHRONIE_FIXTURE_ROOT ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop", "fixtures");

/** Every area a generator writes, which is what `check-fixtures.ts` walks. */
export const AREAS = ["achievements", "currencies", "items", "journal", "transmog"] as const;

/** Writes one area's tables, textures and raw files into `<root>/<area>`. */
export function emit(
  area: string,
  { tables, icons = [], raw = [] }: { tables: TableSpec[]; icons?: IconSpec[]; raw?: RawFixture[] },
): void {
  const out = join(fixtureRoot(), area);
  mkdirSync(out, { recursive: true });
  const quiet = Boolean(process.env.CHRONIE_FIXTURE_ROOT);
  const write = (name: string, bytes: Uint8Array, note = ""): void => {
    const path = join(out, name);
    writeFileSync(path, bytes);
    if (!quiet) console.log(`${path}  ${bytes.length} bytes${note}`);
  };
  for (const table of tables) write(`${table.fileDataId}.db2`, writeTable(table));
  for (const icon of icons) write(`${icon.fileDataId}.blp`, writeIcon(icon));
  for (const file of raw) {
    write(`${file.fileDataId}.${file.extension}`, file.bytes, file.note ? `  ${file.note}` : "");
  }
}
