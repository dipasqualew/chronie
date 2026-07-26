/**
 * Writes the game-file fixtures the transmog tests read: the DB2 tables that describe a set,
 * the BLP icons its appearances name, and the M2 models and skin profiles behind the four
 * slots that have geometry of their own.
 *
 * The tables below have exactly the shape the game's own do — same columns, same storage per
 * column, same bit offsets — and content that is entirely invented. Nothing here is copied
 * from the game. How the tables and textures are actually written out is
 * [`db2-fixtures.ts`], which is shared with the other areas' fixtures and is where those
 * formats are explained; the model writer is here, because nothing else needs one.
 *
 *     bun run scripts/make-transmog-fixtures.ts
 */

import {
  AlphaType,
  bgraPixels,
  Bytes,
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
  transmogSet: 1376213,
  transmogSetItem: 1376212,
  transmogSetGroup: 1576116,
  itemModifiedAppearance: 982457,
  itemAppearance: 982462,
  itemDisplayInfo: 1266429,
  itemDisplayInfoMaterialRes: 1280614,
  modelFileData: 1337833,
  textureFileData: 982459,
} as const;

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
        // A display naming a model resource no file in this install belongs to, which is what
        // a partial download looks like from here.
        [0, 16, 0, 0, 0, 0, 0, 0, 0, 0, [41006, 0], [51012, 0], [27, 0, 0, 0, 0, 0], [1, 0]],
        // One whose file is there and is not a model, which is the other kind of wrong and
        // has to read differently: an install missing a file is ordinary, an unreadable file
        // is this app being wrong about the format.
        [0, 17, 0, 0, 0, 0, 0, 0, 0, 0, [41007, 0], [51013, 0], [27, 0, 0, 0, 0, 0], [1, 0]],
      ],
      idList: [
        900001, 900002, 900003, 900004, 900005, 900006, 900007, 900008, 900009, 900010, 900011,
      ],
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

/**
 * `ModelFileData` — every `.m2` the client owns, keyed by the resource that names it.
 *
 * The row id is the FileDataID, which is the whole trick of this table: it answers "what file
 * is model resource 41001" by being a list of files that each say which resource they are.
 * One resource can name several files — a model and its lower levels of detail — and 41001
 * has two here, so a reader that took whichever came first would sometimes draw the coarse
 * one.
 */
const modelFileData: TableSpec = {
  fileDataId: FILE_DATA_ID.modelFileData,
  layoutHash: 0x2f7c40b1,
  tableHash: 0x5e07a9c3,
  idColumn: 0,
  flags: 4,
  recordSize: 8,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 8 }, // Flags
    { storage: Storage.bitpacked, offsetBits: 8, sizeBits: 4 }, // LodCount
    { storage: Storage.bitpacked, offsetBits: 12, sizeBits: 4 }, // ModelType
    { storage: Storage.bitpacked, offsetBits: 16, sizeBits: 8 }, // GeoBox
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // ModelResourcesID
  ],
  sections: [
    {
      key: 0n,
      rows: [
        [0, 0, 0, 0, 41001], // the helm
        [0, 3, 0, 0, 41001], // the same helm at a coarser level of detail
        [0, 0, 0, 0, 41002], // a shoulder's left pad
        [0, 0, 0, 0, 41003], // and its right one
        [0, 0, 0, 0, 41004], // the weapon
        [0, 0, 0, 0, 41005], // the shoulder whose display fills only the second slot
        [0, 0, 0, 0, 41007], // the file that is there and is not a model
      ],
      // The client numbers a file's coarser variants above the file itself, which is why the
      // helm's two rows are 140001 and 140101 and why the lower of them is the one to draw.
      idList: [140001, 140101, 140002, 140006, 140004, 140005, 140007],
    },
    {
      // Encrypted, so the model an unreleased appearance names cannot be found at all.
      key: 0x1c4f77ab3d0e5921n,
      rows: [[0, 0, 0, 0, 41900]],
      idList: [140900],
    },
  ],
};

/** `TextureFileData` — the same, for the `.blp`s a material resource names. */
const textureFileData: TableSpec = {
  fileDataId: FILE_DATA_ID.textureFileData,
  layoutHash: 0x83b1e5d0,
  tableHash: 0x11ca6f38,
  idColumn: 0,
  flags: 4,
  recordSize: 8,
  columns: [
    { storage: Storage.bitpacked, offsetBits: 0, sizeBits: 8 }, // UsageType
    { storage: Storage.bitpacked, offsetBits: 8, sizeBits: 8 }, // Flags
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // MaterialResourcesID
  ],
  sections: [
    {
      key: 0n,
      rows: [
        [0, 0, 51001], // the helm's own material, which its model never asks for
        [0, 0, 51002], // the shoulder's, which its model does
        [1, 0, 51002], // the same material at a second usage, numbered above the first
        [0, 0, 51008], // the weapon's
        [0, 0, 51011], // the second-slot shoulder's
      ],
      idList: [150004, 150002, 150102, 150005, 150003],
    },
    {
      key: 0x6e2d90c4ba175f83n,
      rows: [[0, 0, 51900]],
      idList: [150900],
    },
  ],
};

/* ---------- the models ---------- */

/**
 * The corners of a unit cube, in the axes the game uses: X forward, Y left, **Z up**.
 *
 * A cube is the smallest thing that says whether a reader got the format right — it has
 * vertices in every octant, so an axis swapped or a sign dropped shows up as a coordinate in
 * the wrong place rather than as something that still looks like a box.
 */
const CORNERS: ReadonlyArray<readonly [number, number, number]> = Array.from(
  { length: 8 },
  (_, corner) => [corner & 1 ? 1 : -1, corner & 2 ? 1 : -1, corner & 4 ? 1 : -1] as const,
);

/** Two triangles per face, wound anticlockwise seen from outside the cube. */
const CUBE_TRIANGLES = [
  0, 2, 3, 0, 3, 1, // -Z
  4, 5, 7, 4, 7, 6, // +Z
  0, 1, 5, 0, 5, 4, // -Y
  2, 6, 7, 2, 7, 3, // +Y
  0, 4, 6, 0, 6, 2, // -X
  1, 3, 7, 1, 7, 5, // +X
];

/** One texture a model declares. Type 0 is a file of the model's own; anything else is the
 * item's, which is what makes one helm mesh serve every recolour of it. */
interface ModelTexture {
  kind: number;
  /** What `TXID` says for it, which is zero for the slots the item fills. */
  fileDataId: number;
}

/** One submesh, and the batch that draws it. */
interface ModelPart {
  /** Which of the model's cubes the submesh covers. */
  cube: number;
  /** Where in that cube's 36 triangle indices the submesh starts, and how many it takes. */
  from: number;
  count: number;
  material: number;
  /**
   * The level of the index list the submesh sits in. A submesh above zero starts past
   * `level << 16` triangles, which is the field the game splits across two numbers because
   * the one it lives in is 16 bits wide.
   */
  level: number;
}

interface ModelSpec {
  fileDataId: number;
  skinFileDataId: number;
  cubes: number;
  textures: ModelTexture[];
  /** Material flags and blending mode. Flag `0x04` is two-sided; blend 0 opaque, 1 alpha
   * tested, 2 alpha blended. */
  materials: Array<[number, number]>;
  parts: ModelPart[];
  /** A second layer drawn over the first part, which a reader has to leave out. */
  overlay?: boolean;
}

/** The vertices of a model: one cube per `cubes`, each shifted along X so two are two. */
function modelVertices(cubes: number): Bytes {
  const body = new Bytes();
  for (let cube = 0; cube < cubes; cube += 1) {
    for (const [x, y, z] of CORNERS) {
      body.f32(x + cube * 3);
      body.f32(y);
      body.f32(z);
      body.bytes([255, 0, 0, 0]); // bone weights: all on the root, which nothing reads
      body.bytes([0, 0, 0, 0]); // bone indices
      // A cube's normals point out of its top and bottom faces, so the one axis that has to
      // survive the Z-up to Y-up turn is the one a wrong turn ruins.
      body.f32(0);
      body.f32(0);
      body.f32(z);
      body.f32((x + 1) / 2);
      body.f32((y + 1) / 2);
      body.f32(0); // the second texture coordinate set, which drives effects nothing renders
      body.f32(0);
    }
  }
  return body;
}

/**
 * One `.m2`, as the retail client writes them: a chunked file whose first chunk holds the
 * whole pre-Legion model, followed by the file ids that replaced its filenames.
 *
 * The offsets inside `MD21` count from the chunk's own data rather than from the file, which
 * is the trap the reader has to dodge — so the fixture has to lay them that way or it proves
 * nothing.
 */
function writeModel(model: ModelSpec): Uint8Array {
  // The header the game writes. Only the handful of lists a still render needs are filled in;
  // the rest are empty arrays, which is what a count and offset of zero means.
  const HEADER = 0x144;
  const header = new Uint8Array(HEADER);
  const view = new DataView(header.buffer);
  const array = (at: number, count: number, offset: number): void => {
    view.setUint32(at, count, true);
    view.setUint32(at + 4, offset, true);
  };

  const body = new Bytes();
  const append = (bytes: Bytes): number => {
    while ((HEADER + body.length) % 4 !== 0) body.u8(0);
    const at = HEADER + body.length;
    body.bytes(bytes.toBuffer());
    return at;
  };

  // The name is a single NUL on every retail model, and the texture records point their
  // filename at it. `TXID` is what actually names the files.
  const name = new Bytes();
  name.u8(0);
  const nameAt = append(name);

  const vertices = modelVertices(model.cubes);
  const verticesAt = append(vertices);

  const textures = new Bytes();
  for (const texture of model.textures) {
    textures.u32(texture.kind);
    textures.u32(0); // flags: neither wrapping bit
    textures.u32(1); // the filename, which is the single NUL above
    textures.u32(nameAt);
  }
  const texturesAt = append(textures);

  const materials = new Bytes();
  for (const [flags, blend] of model.materials) {
    materials.u16(flags);
    materials.u16(blend);
  }
  const materialsAt = append(materials);

  // A batch names its texture through this list rather than directly, and the fixture keeps
  // it one-to-one so that a reader that skipped the indirection would still be wrong: it
  // would read the combo index as a texture index, which is only the same thing by accident.
  const combos = new Bytes();
  for (let index = model.textures.length - 1; index >= 0; index -= 1) combos.u16(index);
  const combosAt = append(combos);

  view.setUint32(0x00, 0x3032_444d, true); // "MD20", written the way the file stores it
  view.setUint32(0x04, 272, true); // the version retail has used since Legion
  array(0x08, 1, nameAt);
  array(0x3c, model.cubes * 8, verticesAt);
  view.setUint32(0x44, 1, true); // one skin profile
  array(0x50, model.textures.length, texturesAt);
  array(0x70, model.materials.length, materialsAt);
  array(0x80, model.textures.length, combosAt);

  const md21 = new Bytes();
  md21.bytes(header);
  md21.bytes(body.toBuffer());

  const out = new Bytes();
  const chunk = (magic: string, payload: Bytes): void => {
    out.bytes(new TextEncoder().encode(magic));
    out.u32(payload.length);
    out.bytes(payload.toBuffer());
  };
  chunk("MD21", md21);

  const skins = new Bytes();
  skins.u32(model.skinFileDataId);
  chunk("SFID", skins);

  const textureFiles = new Bytes();
  for (const texture of model.textures) textureFiles.u32(texture.fileDataId);
  chunk("TXID", textureFiles);
  return out.toBuffer();
}

/**
 * One `.skin`: which vertices a submesh uses, in which order, and what draws it.
 *
 * The triangle list is where the level trap lives. A submesh above level zero starts past
 * index 65,536, and the field holding that start is 16 bits wide — so the list has to
 * actually be that long for a reader that ignores the level to land somewhere else. The
 * padding in between is what makes the weapon fixture the only large file here.
 */
function writeSkin(model: ModelSpec): Uint8Array {
  const lookup: number[] = Array.from({ length: model.cubes * 8 }, (_, index) => index);
  const triangles: number[] = [];
  const submeshes: Array<{ part: ModelPart; start: number }> = [];

  for (const part of [...model.parts].sort((left, right) => left.level - right.level)) {
    const floor = part.level * 0x10000;
    while (triangles.length < floor) triangles.push(0);
    const start = triangles.length - floor;
    for (let index = part.from; index < part.from + part.count; index += 1) {
      triangles.push(part.cube * 8 + (CUBE_TRIANGLES[index] as number));
    }
    submeshes.push({ part, start });
  }

  const body = new Bytes();
  const HEADER = 48;
  const append = (bytes: Bytes): number => {
    const at = HEADER + body.length;
    body.bytes(bytes.toBuffer());
    return at;
  };

  const lookupBytes = new Bytes();
  for (const vertex of lookup) lookupBytes.u16(vertex);
  const lookupAt = append(lookupBytes);

  const triangleBytes = new Bytes();
  for (const index of triangles) triangleBytes.u16(index);
  const trianglesAt = append(triangleBytes);

  const sections = new Bytes();
  for (const { part, start } of submeshes) {
    sections.u16(0); // skinSectionId: the geoset, which nothing on an item's own model reads
    sections.u16(part.level);
    sections.u16(part.cube * 8); // vertexStart
    sections.u16(8); // vertexCount
    sections.u16(start);
    sections.u16(part.count);
    sections.u16(0); // boneCount
    sections.u16(0); // boneComboIndex
    sections.u16(1); // boneInfluences
    sections.u16(0); // centerBoneIndex
    for (let axis = 0; axis < 7; axis += 1) sections.f32(0); // the two centres and the radius
  }
  const sectionsAt = append(sections);

  const batches = new Bytes();
  const batch = (section: number, part: ModelPart, layer: number): void => {
    batches.u8(0); // flags
    batches.u8(0); // priorityPlane
    batches.u16(0); // shaderID
    batches.u16(section);
    batches.u16(0); // flags2
    batches.u16(0xffff); // colorIndex: none
    batches.u16(part.material);
    batches.u16(layer);
    batches.u16(1); // textureCount
    // Combo zero, and the combo list is written backwards — so on the helm, which declares
    // two textures, this reaches the second. A reader that took the combo index for a texture
    // index would land on the first, which is the slot the item fills.
    batches.u16(0);
    batches.u16(0); // textureCoordComboIndex
    batches.u16(0); // textureWeightComboIndex
    batches.u16(0); // textureTransformComboIndex
  };
  submeshes.forEach(({ part }, section) => batch(section, part, 0));
  // The overlay a shader would composite on top of the base layer. Drawn as-is it is the same
  // triangles a second time, fighting with themselves for the same depth.
  if (model.overlay) batch(0, submeshes[0]!.part, 1);
  const batchesAt = append(batches);

  const out = new Bytes();
  out.bytes(new TextEncoder().encode("SKIN"));
  out.u32(lookup.length);
  out.u32(lookupAt);
  out.u32(triangles.length);
  out.u32(trianglesAt);
  out.u32(0); // properties, which say which bones a submesh needs
  out.u32(0);
  out.u32(submeshes.length);
  out.u32(sectionsAt);
  out.u32(submeshes.length + (model.overlay ? 1 : 0));
  out.u32(batchesAt);
  out.u32(1); // boneCountMax
  out.bytes(body.toBuffer());
  return out.toBuffer();
}

/**
 * The models the displays point at, one per thing a reader has to get right.
 *
 * Between them: a model that paints itself out of its own texture, one that leaves the
 * texture to the item, one with three differently composited parts and an overlay on top of
 * them, and one whose second half sits past the first 64k of the index list.
 */
const models: ModelSpec[] = [
  {
    // A helm: one submesh, and two texture slots of which it fills the second itself. The
    // first is the item's, so a reader that mixed the two lists up would paint the helm with
    // the wrong picture rather than fail.
    fileDataId: 140001,
    skinFileDataId: 141001,
    cubes: 1,
    textures: [
      { kind: 2, fileDataId: 0 },
      { kind: 0, fileDataId: 150001 },
    ],
    materials: [[0, 0]],
    parts: [{ cube: 0, from: 0, count: 36, material: 0, level: 0 }],
  },
  {
    // A shoulder's left pad. Its texture is the item's, which is why a wardrobe of recolours
    // is one mesh and twenty pictures.
    fileDataId: 140002,
    skinFileDataId: 141002,
    cubes: 1,
    textures: [{ kind: 2, fileDataId: 0 }],
    materials: [[0, 0]],
    parts: [{ cube: 0, from: 0, count: 36, material: 0, level: 0 }],
  },
  {
    // A cloak: three parts, composited three different ways, with an overlay over the first.
    fileDataId: 140003,
    skinFileDataId: 141003,
    cubes: 1,
    textures: [{ kind: 2, fileDataId: 0 }],
    materials: [
      [0, 0], // opaque
      [0x04, 1], // alpha tested and two-sided, which is what a fringe or a plume is
      [0, 2], // alpha blended
    ],
    parts: [
      { cube: 0, from: 0, count: 12, material: 0, level: 0 },
      { cube: 0, from: 12, count: 12, material: 1, level: 0 },
      { cube: 0, from: 24, count: 12, material: 2, level: 0 },
    ],
    overlay: true,
  },
  {
    // A weapon whose second submesh starts past the first 64k indices.
    fileDataId: 140004,
    skinFileDataId: 141004,
    cubes: 2,
    textures: [{ kind: 0, fileDataId: 150005 }],
    materials: [[0, 0]],
    parts: [
      { cube: 0, from: 0, count: 36, material: 0, level: 0 },
      { cube: 1, from: 0, count: 36, material: 0, level: 1 },
    ],
  },
  {
    fileDataId: 140005,
    skinFileDataId: 141005,
    cubes: 1,
    textures: [{ kind: 2, fileDataId: 0 }],
    materials: [[0, 0]],
    parts: [{ cube: 0, from: 0, count: 36, material: 0, level: 0 }],
  },
  {
    // The right pad of the shoulder above, which nothing shows: an item's two model slots are
    // a left and a right, and where either sits on the body is the character's business.
    fileDataId: 140006,
    skinFileDataId: 141006,
    cubes: 1,
    textures: [{ kind: 2, fileDataId: 0 }],
    materials: [[0, 0]],
    parts: [{ cube: 0, from: 0, count: 36, material: 0, level: 0 }],
  },
];

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
  // The textures the models are painted with. Same format, different job: 150001 is named by
  // a model's own `TXID`, and the rest by `TextureFileData` for the items that supply one.
  {
    fileDataId: 150001, encoding: Encoding.dxt, alphaBits: 0,
    alphaType: AlphaType.dxt1, body: dxtBlocks(AlphaType.dxt1),
  },
  { fileDataId: 150002, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  { fileDataId: 150003, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  {
    fileDataId: 150005, encoding: Encoding.dxt, alphaBits: 8,
    alphaType: AlphaType.dxt5, body: dxtBlocks(AlphaType.dxt5),
  },
];


/* ---------- go ---------- */

emit("transmog", {
  tables: [
    transmogSet,
    transmogSetGroup,
    transmogSetItem,
    itemModifiedAppearance,
    itemAppearance,
    itemDisplayInfo,
    itemDisplayInfoMaterialRes,
    modelFileData,
    textureFileData,
  ],
  icons,
  raw: [
    // Every model is a pair: the geometry, and the skin profile that says which of it is
    // drawn in which batch.
    ...models.flatMap((model) => [
      { fileDataId: model.fileDataId, extension: "m2", bytes: writeModel(model) },
      { fileDataId: model.skinFileDataId, extension: "skin", bytes: writeSkin(model) },
    ]),
    // Icon 130007 belongs to content the game has not shipped. Its chunk is encrypted, and a
    // chunk only Blizzard holds the key to arrives as zeroes of the right length — so this is
    // what a reader is actually handed rather than an error it can act on. 130008 is named by
    // an appearance and installed by nobody, which is the other half of the same story.
    {
      fileDataId: 130007,
      extension: "blp",
      bytes: new Uint8Array(1172),
      note: "the texture the game keeps encrypted",
    },
    // Model 140007 is a file that is there and is not a model — a chunked file whose chunks
    // are nothing this reader knows. An install missing a file is ordinary and shows the
    // icon; a file that will not parse is this app being wrong about the format, and has to
    // say so.
    {
      fileDataId: 140007,
      extension: "m2",
      bytes: new Uint8Array(32),
      note: "a file that is there and is not a model",
    },
  ],
});
