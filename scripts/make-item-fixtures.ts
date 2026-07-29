/**
 * Writes the game-file fixtures the item tests read: the two tables that describe an item.
 *
 * `Item` is the small one — what kind of thing an item is, where it is worn, the picture
 * beside it — and `ItemSparse` is the sixty-three megabyte one the name comes out of. Both
 * have exactly the shape the game's own do, down to which columns are palettes and how wide
 * each bit field is, read off build 12.0.5.67 with `examples/dump_item_facts` and written
 * down in `docs/game-files.md`. The contents are entirely invented; nothing here is copied
 * from the game. How any of it is written out is [`db2-fixtures.ts`].
 *
 *     bun run scripts/make-item-fixtures.ts
 */

import { emit, Storage, type TableSpec } from "./db2-fixtures";
import { FILE_DATA_ID } from "./tables";

/**
 * What the game calls each table, out of `docs/game-tables.json`.
 *
 * Only the FileDataIDs are shared with the reader. Every column position, storage and bit offset
 * below is decided here and nowhere else, deliberately: a fixture that took its layout from the
 * same registry the reader reads would move both halves together when a number in that registry
 * was wrong, and the suite would prove only that two generated halves agree.
 */

/**
 * Where the columns this app reads sit in `ItemSparse`, as the install keeps them.
 *
 * The fixture's own decision, held here rather than taken from `docs/game-tables.json`, and that
 * is the point: the reader's positions come out of the registry, these lay the bytes out, and a
 * wrong number in the registry therefore moves one of the two and not both.
 */
const SPARSE = {
  name: 5,
  allowableClass: 52,
  requiredLevel: 65,
  inventoryType: 66,
  quality: 67,
} as const;

/** The two classes of thing this app names by hand. */
const ARMOR = 4;
const WEAPON = 2;

/** A class mask nobody is excluded by, which is what nearly every item carries. */
const ANY_CLASS = 0xffff;

/**
 * `Item` — what kind of thing an item is.
 *
 * Every column of the real table is here in its place and in its storage, including the seven
 * nothing reads: leaving them out would move the ones that follow and let a reader with the
 * wrong offsets pass. The install stores this table almost entirely as palettes — a game with
 * two hundred thousand items has twenty classes and thirty slots between them — and the icon
 * as a signed 24-bit field, which is what has to be mirrored for the fixture to prove
 * anything. The ids are kept in a list beside the rows rather than in a column, which is the
 * other thing about this table a reader has to get right.
 */
const item: TableSpec = {
  fileDataId: FILE_DATA_ID.item,
  layoutHash: 0x4f8b21c6,
  tableHash: 0x50238ec2,
  idColumn: 0,
  // Bit 2: the ids are in a list of their own.
  flags: 4,
  recordSize: 8,
  columns: [
    { storage: Storage.indexed, offsetBits: 0, sizeBits: 5, palette: [ARMOR, WEAPON, 15] }, // ClassID
    { storage: Storage.indexed, offsetBits: 5, sizeBits: 5, palette: [0, 1, 2, 3, 4, 7] }, // SubclassID
    { storage: Storage.bitpacked, offsetBits: 10, sizeBits: 4 }, // Material
    {
      storage: Storage.indexed,
      offsetBits: 14,
      sizeBits: 6,
      palette: [0, 1, 3, 5, 12, 13, 16],
    }, // InventoryType
    { storage: Storage.indexed, offsetBits: 20, sizeBits: 4, palette: [0, 1, 3] }, // SheatheType
    { storage: Storage.indexed, offsetBits: 24, sizeBits: 5, palette: [255] }, // SoundOverrideSubclassID
    { storage: Storage.bitpackedSigned, offsetBits: 29, sizeBits: 24 }, // IconFileDataID
    { storage: Storage.indexed, offsetBits: 53, sizeBits: 5, palette: [0, 9, 11] }, // ItemGroupSoundsID
    { storage: Storage.bitpacked, offsetBits: 58, sizeBits: 3 }, // unread, from here down
    { storage: Storage.bitpacked, offsetBits: 61, sizeBits: 3 },
  ],
  sections: [
    {
      key: 0n,
      // ClassID, SubclassID, Material, InventoryType, SheatheType, SoundOverride, Icon,
      // GroupSounds, and the two nothing reads.
      rows: [
        // Leather shoulders, which is the ordinary case: an armour class and a slot.
        [ARMOR, 2, 8, 3, 0, 255, 260001, 11, 0, 0],
        // Plate, and the only item some classes may not wear.
        [ARMOR, 4, 6, 1, 0, 255, 260002, 11, 0, 0],
        // A one-handed sword: the slot is the only thing that says which hand it goes in.
        [WEAPON, 7, 1, 13, 1, 255, 260003, 9, 0, 0],
        // A cloak. Cloth by subclass and worn on the back, which is a pair nothing else is.
        [ARMOR, 1, 7, 16, 0, 255, 260004, 11, 0, 0],
        // Held in `Item` and named nowhere: a trinket the big table has no readable row for.
        [ARMOR, 0, 0, 12, 0, 255, 260004, 0, 0, 0],
        // Not worn at all, and not armour either.
        [15, 0, 0, 0, 0, 255, 260001, 0, 0, 0],
        // Cloth, worn on the chest. The big table has a row for this one and cannot name it,
        // which is the pair the reader has to be careful with — see `itemSparse` below.
        [ARMOR, 1, 7, 5, 0, 255, 260003, 11, 0, 0],
      ],
      idList: [201, 202, 203, 204, 205, 206, 207],
    },
    {
      // Encrypted, so its rows arrive as zeroes: a segment that collected item 900 can be
      // told nothing about it at all.
      key: 0x51e7c3a9b2064d18n,
      rows: [[ARMOR, 3, 5, 5, 0, 255, 260002, 11, 0, 0]],
      idList: [900],
    },
  ],
};

/**
 * One row of `ItemSparse`, as the game lays one out: the columns this app reads, and filler
 * of the right shape in between.
 *
 * The filler is not padding for its own sake. `ItemSparse` writes its strings into the record,
 * so nothing past them sits at a fixed place, and the columns after a name are what say a
 * reader walked the record rather than trusting an offset — which is why two of the rows
 * below carry a description and the rest do not.
 */
function sparseRow(
  name: string,
  description: string,
  {
    quality,
    requiredLevel,
    inventoryType,
    allowableClass = ANY_CLASS,
  }: {
    quality: number;
    requiredLevel: number;
    inventoryType: number;
    allowableClass?: number;
  },
): Array<number | string> {
  const row: Array<number | string> = [0, description, "", "", "", name];
  while (row.length < SPARSE.allowableClass) row.push(row.length);
  row.push(allowableClass);
  while (row.length < SPARSE.requiredLevel) row.push(row.length);
  row.push(requiredLevel, inventoryType, quality);
  return row;
}

/**
 * `ItemSparse` — what an item is called, what it is worth, and who may wear it.
 *
 * The one table in the game whose records vary in length, whose ids are kept beside them, and
 * whose strings are written inside the record. The four columns this app reads are at the
 * positions the install keeps them at, with the sixty-odd in between written out so a reader
 * that walked the record wrongly would arrive somewhere else.
 */
const itemSparse: TableSpec = {
  fileDataId: FILE_DATA_ID.itemSparse,
  layoutHash: 0x0bd4e7a2,
  tableHash: 0x2a7f9061,
  idColumn: 0,
  // Bit 0: the records vary in length. Bit 2: the ids are in a list of their own.
  flags: 5,
  recordSize: 0,
  textColumns: [1, 2, 3, 4, 5],
  // The offsets are what the game writes for a table like this and what nothing reads: a
  // record of variable length is walked from its front, and a column is wherever the columns
  // in front of it left off.
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 64 }, // AllowableRace
    { storage: Storage.plain, offsetBits: 64, sizeBits: 32 }, // Description_lang
    { storage: Storage.plain, offsetBits: 96, sizeBits: 32 }, // Display3_lang
    { storage: Storage.plain, offsetBits: 128, sizeBits: 32 }, // Display2_lang
    { storage: Storage.plain, offsetBits: 160, sizeBits: 32 }, // Display1_lang
    { storage: Storage.plain, offsetBits: 192, sizeBits: 32 }, // Display_lang
    // Everything between the name and the class mask, then the mask, then everything up to
    // the three the table ends on: the level it takes, where it is worn, and what it is worth.
    ...Array.from({ length: SPARSE.allowableClass - 6 }, (_, index) => ({
      storage: Storage.plain,
      offsetBits: 224 + index * 32,
      sizeBits: 32,
    })),
    {
      storage: Storage.plain,
      offsetBits: 224 + (SPARSE.allowableClass - 6) * 32,
      sizeBits: 16,
    }, // AllowableClass
    ...Array.from({ length: SPARSE.requiredLevel - SPARSE.allowableClass - 1 }, (_, index) => ({
      storage: Storage.plain,
      offsetBits: 240 + (SPARSE.allowableClass - 6) * 32 + index * 32,
      sizeBits: 32,
    })),
    {
      storage: Storage.plain,
      offsetBits: 240 + (SPARSE.requiredLevel - 7) * 32,
      sizeBits: 8,
    }, // RequiredLevel
    {
      storage: Storage.plain,
      offsetBits: 248 + (SPARSE.requiredLevel - 7) * 32,
      sizeBits: 8,
    }, // InventoryType
    {
      storage: Storage.plain,
      offsetBits: 256 + (SPARSE.requiredLevel - 7) * 32,
      sizeBits: 8,
    }, // OverallQualityID
  ],
  sections: [
    {
      key: 0n,
      rows: [
        sparseRow("Wanderer's Mantle", "", { quality: 3, requiredLevel: 25, inventoryType: 3 }),
        // The plate helm, which is the one item that says who may wear it: the three classes
        // that wear plate, as a bit each — warrior, paladin, death knight.
        sparseRow("Bulwark Helm", "Stamped in the Emberforge, and never dented.", {
          quality: 4,
          requiredLevel: 60,
          inventoryType: 1,
          allowableClass: 0b10_0011,
        }),
        sparseRow("Tideglass Edge", "", { quality: 5, requiredLevel: 60, inventoryType: 13 }),
        // A description on a second row, so that two rows of the same shape are still
        // different lengths and the offset map is doing something.
        sparseRow("Cloak of the Long Night", "Frayed at the hem, and warm regardless.", {
          quality: 3,
          requiredLevel: 30,
          inventoryType: 16,
        }),
        // Worn nowhere, needing no level, and common: a token rather than a piece of gear.
        sparseRow("Hearth Token", "", { quality: 1, requiredLevel: 0, inventoryType: 0 }),
        // A row that names the item nothing at all, and carries numbers regardless.
        //
        // This is the shape of a real misreading rather than of a real item: when the strings
        // in this record are read from the wrong place the name comes back empty, and the
        // numbers a few columns further on come back as whatever they landed on — a quality
        // where a level should be, which is how the window came to show "Level 4" beside an
        // item it could not name. The numbers here are deliberately the ones that would be
        // believed: a plausible quality, a plausible level, and a restriction.
        sparseRow("", "", {
          quality: 4,
          requiredLevel: 60,
          inventoryType: 5,
          allowableClass: 0b10_0011,
        }),
      ],
      // 205 is missing on purpose: the trinket `Item` describes and this table cannot name.
      idList: [201, 202, 203, 204, 206, 207],
    },
    {
      // Encrypted, so item 900 cannot be named either — the other half of the row `Item`
      // withholds.
      key: 0x51e7c3a9b2064d18n,
      rows: [
        sparseRow("Unreleased Hauberk", "", { quality: 4, requiredLevel: 80, inventoryType: 5 }),
      ],
      idList: [900],
    },
  ],
};

/* ---------- go ---------- */

emit("items", { tables: [item, itemSparse] });
