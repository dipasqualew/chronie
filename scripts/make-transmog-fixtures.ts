/**
 * Writes the game-file fixtures the transmog tests read: the DB2 tables that describe a set,
 * the BLP icons its appearances name, the M2 models and skin profiles behind the four slots
 * that have geometry of their own, and the character body the rest of a set is drawn on.
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
  bodyPixels,
  Bytes,
  dxtBlocks,
  emit,
  Encoding,
  palettePixels,
  Storage,
  type IconSpec,
  type Paint,
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
  itemSparse: 1572924,
  modelFileData: 1337833,
  textureFileData: 982459,
  componentTextureFileData: 1278239,
  componentModelFileData: 1349053,
  helmetGeosetData: 2821752,
  chrCustomizationChoice: 3450554,
  chrCustomizationOption: 3384247,
  chrCustomizationElement: 3512765,
  chrCustomizationMaterial: 3459652,
  chrModelTextureLayer: 3548976,
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
      // DisplayType is the slot, as an install numbers them: 0 head, 1 shoulder, 2 shirt,
      // 3 chest, 5 legs, 6 feet, 8 hands, 11 a weapon. Only head, shoulder and the weapons
      // carry a model. These are not the numbers the community's definitions give — a shirt
      // is 2 and everything from the chest down sits one higher than that list says.
      rows: [
        [0, 900001, 130001],
        [1, 900002, 130002],
        // The robe, which is the chest slot and a display of its own: same slot as the
        // breastplate below and a different set of geosets under it.
        [3, 900012, 130003],
        [6, 900004, 130004],
        [8, 900005, 130005],
        [0, 900001, 130001],
        [1, 900009, 130002],
        [3, 900003, 130003],
        [5, 900006, 130006],
        [11, 900007, 130007],
        // Its display is in an encrypted section of `ItemDisplayInfo`, so the row knows
        // which slot it fills and nothing about how it is drawn.
        [3, 900900, 130008],
        // An appearance the table gives no icon at all.
        [2, 900008, 0],
      ],
      idList: [80001, 80002, 80003, 80004, 80005, 80006, 80007, 80008, 80009, 80010, 80011, 80013],
    },
    {
      key: 0x6b02e9f43d78a1c5n,
      rows: [
        [4, 900004, 130009],
        [0, 900001, 130010],
      ],
      idList: [80012, 80900],
    },
  ],
};

/**
 * `ItemDisplayInfo` — how one appearance is drawn, and the table of array columns.
 *
 * The game keeps a display's two model slots, its two material slots, its two model types and
 * its six geoset groups as fixed-size arrays inside single columns, stored two different
 * ways: three of them plainly, elements laid end to end, and one as a palette of whole runs.
 * Reading either as one number gets the first element and quietly loses the rest, so the
 * fixture gives every one of them a distinguishable tail.
 *
 * The install stores all four as palettes of runs. The fixture keeps three of them plain
 * because the reader has both paths and only this table exercises either: the palette one is
 * `ModelType`, the plain one is everything else.
 *
 * **The four array positions below are the game's own; the columns before them are not.**
 * 10, 11, 12 and 13 were read off a real install and are written down in
 * `docs/game-files.md` — including which of 12 and 13 is which, which is the pair the table
 * invites getting backwards. What sits in front of them is filler of the right shape.
 *
 * **`GeosetGroup` holds values, not group numbers.** Which group an element drives is decided
 * by the slot the item fills and the element's position — a chestpiece's first element is
 * sleeves, its second the chest — and the element itself says *which variant* of that group.
 * So the numbers below are small, and `docs/character-rendering.md` is where the two groups
 * that do not follow the ordinary `group × 100 + (1 + value)` are written down.
 */
/**
 * What the two array columns after `GeosetGroup` hold where a display has nothing to say.
 *
 * `AttachmentGeosetGroup` is read by nothing at all and is here because a column between two
 * that *are* read has to be laid out or everything behind it moves. `HelmetGeosetVis` is two
 * `HelmetGeosetData` ids, one per gender, and a pair of zeroes is what the 210 helms in the
 * game that hide nothing carry — along with everything that is not a helm.
 */
const NO_ATTACHMENT_GROUPS = [0, 0, 0, 0, 0, 0];
const NO_HELMET_VIS = [0, 0];

const itemDisplayInfo: TableSpec = {
  fileDataId: FILE_DATA_ID.itemDisplayInfo,
  layoutHash: 0x9f3ab8a9,
  tableHash: 0x71c40e52,
  idColumn: 0,
  flags: 4,
  recordSize: 89,
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
    { storage: Storage.indexed, offsetBits: 112, sizeBits: 3, palette: [0, 1, 2, 3] }, // filler
    { storage: Storage.plain, offsetBits: 128, sizeBits: 64 }, // ModelResourcesID[2]
    { storage: Storage.plain, offsetBits: 192, sizeBits: 64 }, // ModelMaterialResourcesID[2]
    {
      storage: Storage.indexedArray,
      offsetBits: 256,
      sizeBits: 3,
      arrayCount: 2,
      // Three runs of two: no model, a one-handed model, a two-handed one.
      palette: [0, 0, 1, 0, 2, 3],
    }, // ModelType[2]
    { storage: Storage.plain, offsetBits: 264, sizeBits: 192 }, // GeosetGroup[6]
    { storage: Storage.plain, offsetBits: 456, sizeBits: 192 }, // AttachmentGeosetGroup[6]
    { storage: Storage.plain, offsetBits: 648, sizeBits: 64 }, // HelmetGeosetVis[2]
  ],
  sections: [
    {
      key: 0n,
      // Flags, then the eight scalars nothing reads, HelmetGeosetVis, and then the four
      // arrays in the order the install keeps them: models, materials, model types, geoset
      // groups. The last two are the pair worth reading twice — two values then six.
      rows: [
        // A helm: one model slot, the helm group switched to its second variant, and a skull
        // element of -1 — which the game writes where a row drives no geoset at all, and
        // which read as a value would ask the body for its hundred-and-somethingth skull.
        // Its two `HelmetGeosetVis` entries hide different things, which is the trap: 701 is
        // the one an app drawing a male body would take, and it hides the robe group.
        [1, 11, 0, 0, 0, 0, 0, 0, 0, 1, [41001, 0], [51001, 0], [1, 0], [2, -1, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, [701, 700]],
        // Shoulders: both model slots used, left and right.
        [0, 12, 0, 0, 0, 0, 0, 0, 0, 0, [41002, 41003], [51002, 51003], [2, 3], [1, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // A chestpiece: no model at all, and the two of its five groups this body has —
        // sleeves over the bare arms, and a chest piece over the bare torso.
        [16, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51004, 0], [0, 0], [1, 1, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // Boots: the first element is the boot itself, and the second is the feet group whose
        // zero means "booted" rather than "bare" — the exception a reader has to know about.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51005, 0], [0, 0], [1, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // Gloves: a slot this body holds no geoset for at all, so it is texture and nothing
        // else — which is what most of a wardrobe does to most of a mesh.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51006, 0], [0, 0], [1, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // Legs, whose first element is the trousers.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51007, 0], [0, 0], [3, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // A weapon, which is geometry and nothing else.
        [0, 13, 0, 0, 0, 0, 0, 0, 0, 0, [41004, 0], [51008, 0], [1, 0], [0, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // A shirt: nothing at all beyond its material.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51009, 0], [0, 0], [0, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // Shoulders that keep their model in the second slot only, which is exactly what a
        // reader that stops at element zero calls "no model at all".
        [0, 14, 0, 0, 0, 0, 0, 0, 0, 0, [0, 41005], [51010, 51011], [2, 3], [1, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // A display naming a model resource no file in this install belongs to, which is what
        // a partial download looks like from here.
        [0, 16, 0, 0, 0, 0, 0, 0, 0, 0, [41006, 0], [51012, 0], [1, 0], [2, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // One whose file is there and is not a model, which is the other kind of wrong and
        // has to read differently: an install missing a file is ordinary, an unreadable file
        // is this app being wrong about the format.
        [0, 17, 0, 0, 0, 0, 0, 0, 0, 0, [41007, 0], [51013, 0], [1, 0], [2, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // A robe, which is the chest slot again and the one that shows why the groups are
        // worth getting right: it leaves the chest group bare and switches on the robe group
        // instead, which is the skirt that hangs over the legs.
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51014, 0], [0, 0], [1, 0, 1, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
        // A cape, which is the one slot with geometry and no model: both model slots are zero
        // and it names a material anyway, because what it supplies is the picture on a cloak
        // the body already carries. Its geoset value switches that cloak on.
        [0, 18, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0], [51015, 0], [0, 0], [1, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
      ],
      idList: [
        900001, 900002, 900003, 900004, 900005, 900006, 900007, 900008, 900009, 900010, 900011,
        900012, 900013,
      ],
    },
    {
      // Encrypted, so an appearance pointing here knows its slot and nothing more.
      key: 0x5d38af0c9e142b76n,
      rows: [
        [4, 15, 0, 0, 0, 0, 0, 0, 0, 0, [41900, 0], [51900, 0], [1, 0], [2, 0, 0, 0, 0, 0],
          NO_ATTACHMENT_GROUPS, NO_HELMET_VIS],
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
      // 3 torso upper, 4 torso lower, 5 legs upper, 6 legs lower, 7 feet, 8 accessory.
      rows: [
        // The chestpiece: both arms and both halves of the torso.
        [3, 52001],
        [0, 52002],
        [1, 52003],
        [4, 52004],
        // The robe: the torso, and the legs its skirt hangs over.
        [3, 52005],
        [5, 52006],
        [6, 52007],
        // The boots, whose third row is section 8 — a section the layout this app renders
        // has no rectangle for, which is a row to drop rather than an error to raise.
        [7, 52008],
        [6, 52009],
        [8, 52010],
        // The gloves, whose only texture the game keeps for a body this is not.
        [2, 52011],
        // The shirt, whose texture no install here holds.
        [3, 52012],
      ],
      idList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      // Which display each row belongs to is written *only* here, in a block beside the
      // records rather than in a column of them.
      relationships: [
        [900003, 0],
        [900003, 1],
        [900003, 2],
        [900003, 3],
        [900012, 4],
        [900012, 5],
        [900012, 6],
        [900004, 7],
        [900004, 8],
        [900004, 9],
        [900005, 10],
        [900008, 11],
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
 * `ItemSparse` — what an item is called, and the one table whose records vary in length.
 *
 * Every other table here lays each row out at the same width. This one writes its strings
 * into the record, so a row is as long as the text in it, and where each row starts is said
 * by an offset map beside them rather than by arithmetic. That is the shape the game's own
 * `ItemSparse` has — 63 MB of it, one row per item in the game — and it is why item names
 * needed the reader to grow a whole feature rather than merely a bigger read.
 *
 * The names are what the detail view shows. The columns after them are what says the reader
 * walked the strings rather than trusted the offsets the file states: a reader that took a
 * column's declared position would find the quality of an item whose name is short somewhere
 * inside the name of the next one.
 *
 * **The column positions below are the community's rather than this repository's.** The five
 * strings and their order are what [WoWDBDefs] lists for the shipping builds, and unlike the
 * chains in `docs/game-files.md` none of it was read off an install — the columns after them
 * are filler of the right shape. `Display_lang` reading as something other than a name is
 * therefore the first thing to suspect if a patch ever empties the detail view's labels.
 *
 * [WoWDBDefs]: https://github.com/wowdev/WoWDBDefs
 */
const itemSparse: TableSpec = {
  fileDataId: FILE_DATA_ID.itemSparse,
  layoutHash: 0x0bd4e7a2,
  tableHash: 0x2a7f9061,
  // The ids are kept beside the rows, so no column holds one.
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
    { storage: Storage.plain, offsetBits: 224, sizeBits: 32 }, // ItemLevel
    { storage: Storage.plain, offsetBits: 256, sizeBits: 8 }, // OverallQualityID
    { storage: Storage.plain, offsetBits: 264, sizeBits: 8 }, // InventoryType
  ],
  sections: [
    {
      key: 0n,
      // AllowableRace, the four alternate display names the game almost never fills in, the
      // name itself, and then the three numbers that have to survive the walk past them.
      rows: [
        [0, "", "", "", "", "Tideglass Crown", 447, 4, 1],
        [0, "", "", "", "", "Tideglass Mantle", 447, 4, 3],
        // The one item with a description, so that two rows of the same shape are still
        // different lengths and the offset map is doing something.
        [0, "Woven from the glass the tide leaves behind.", "", "", "", "Tideglass Robe", 450, 4, 5],
        [0, "", "", "", "", "Tideglass Sandals", 447, 3, 8],
        [0, "", "", "", "", "Tideglass Gloves", 447, 3, 10],
        [0, "", "", "", "", "Emberforge Helm", 489, 4, 1],
        [0, "", "", "", "", "Emberforge Pauldrons", 489, 4, 3],
        [0, "", "", "", "", "Emberforge Breastplate", 502, 5, 5],
        [0, "", "", "", "", "Emberforge Greaves", 489, 4, 7],
        [0, "", "", "", "", "Emberforge Bulwark", 502, 5, 13],
        // An item the game holds a row for and no name in it, which is what a reader has to
        // fall back from rather than draw as a blank.
        [0, "", "", "", "", "", 421, 1, 4],
      ],
      idList: [30001, 30002, 30003, 30004, 30005, 30006, 30007, 30008, 30009, 30010, 30013],
    },
    {
      // Encrypted, so the items of the sets the game has not released cannot be named — and
      // neither can 30011, whose appearance the readable tables do describe.
      key: 0x4e91d2c73b05a86fn,
      rows: [
        [0, "", "", "", "", "Duskwoven Cowl", 528, 4, 1],
        [0, "", "", "", "", "Duskwoven Wraps", 528, 4, 9],
        [0, "", "", "", "", "Unreleased Trinket", 600, 5, 12],
      ],
      idList: [30011, 30012, 30900],
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
        // The helm, modelled per body: the one this app draws, and the one it does not. The
        // male copy is numbered *below* the female, so a reader that took the lowest id — the
        // rule that is right for a texture and for a level of detail — puts a man's helm on
        // her. Which is which is `componentModelFileData` and nowhere else.
        [0, 0, 0, 0, 41001], // the helm, for a body this app never draws
        [0, 0, 0, 0, 41001], // and the one it does
        [0, 3, 0, 0, 41001], // the same helm at a coarser level of detail, for anybody
        [0, 0, 0, 0, 41002], // a shoulder's left design, mirrored onto the right shoulder
        [0, 0, 0, 0, 41002], // and on the left, which is the one its display asks for
        [0, 0, 0, 0, 41003], // its right design, on the left shoulder
        [0, 0, 0, 0, 41003], // and on the right, which is the one its display asks for
        [0, 0, 0, 0, 41004], // the weapon
        [0, 0, 0, 0, 41005], // the shoulder whose display fills only the second slot
        [0, 0, 0, 0, 41007], // the file that is there and is not a model
      ],
      // The client numbers a file's coarser variants above the file itself, which is why the
      // helm's levels of detail are 140001 and 140101 and why the lower of them is the one to
      // draw. The 139xxx files are the other body's and the other shoulder's, and are named by
      // nothing else here — a reader that took the lowest id would draw every one of them.
      idList: [
        139001, 140001, 140101,
        139002, 140002, 139006, 140006,
        140004, 140005, 140007,
      ],
    },
    {
      // Encrypted, so the model an unreleased appearance names cannot be found at all.
      key: 0x1c4f77ab3d0e5921n,
      rows: [[0, 0, 0, 0, 41900]],
      idList: [140900],
    },
  ],
};

/**
 * `TextureFileData` — the same, for the `.blp`s a material resource names.
 *
 * The 51xxx materials are the items' own, one texture each: a model asks for one picture and
 * that is the picture. The 52xxx ones are the body textures armour is painted on a character
 * with, and they are the reason this table cannot be read as "the file with the lowest id":
 * material 52001 names two files, and the lower of them is the one for a body this app never
 * draws. Which is which is not in this table at all — see `componentTextureFileData` below.
 */
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
        [0, 0, 51002], // the shoulder's left pad, which its model does
        [1, 0, 51002], // the same material at a second usage, numbered above the first
        [0, 0, 51003], // and its right pad's, which is a picture of its own
        [0, 0, 51008], // the weapon's
        [0, 0, 51011], // the second-slot shoulder's
        [0, 0, 51015], // the cape's, which goes on the body's own cloak rather than a model
        // The body textures. 52001 is the material with a picture per body: the lower id is
        // the one this app must not use, so a reader that took the first file, or the
        // smallest, paints the character with somebody else's chest.
        [0, 0, 52001], // the chestpiece's torso, for a body this app never draws
        [0, 0, 52001], // and the one it does
        [0, 0, 52002], // the chestpiece's upper arms, which nothing says a body for
        [0, 0, 52003], // its lower arms
        [0, 0, 52004], // its lower torso
        [0, 0, 52005], // the robe's torso
        [0, 0, 52006], // the robe's upper legs
        [0, 0, 52007], // its lower legs
        [0, 0, 52008], // the boots' feet
        [0, 0, 52009], // the boots' lower legs
        [0, 0, 52010], // the boots' accessory section, which the layout puts nowhere
        [0, 0, 52011], // the gloves' hands, kept for a body this is not
        [0, 0, 52012], // the shirt's torso, which no install here holds the file for
        // The character's own skin, and the two layers her customization paints over it. Not
        // an item's textures at all: these come out of `chrCustomizationMaterial` above, and
        // they are here because that chain ends in this table the same way an item's does.
        [0, 0, 53001], // the base skin
        [0, 0, 53002], // painted over it
        [0, 0, 53003], // and so is this
        [0, 0, 53004], // the other swatch's skin, which this app must not reach
      ],
      idList: [
        150004, 150002, 150102, 150007, 150005, 150003, 150006,
        151001, 151002, 151003, 151004, 151005, 151006, 151007, 151008, 151009, 151010, 151011,
        151012, 151013,
        160001, 160002, 160003, 160004,
      ],
    },
    {
      key: 0x6e2d90c4ba175f83n,
      rows: [[0, 0, 51900]],
      idList: [150900],
    },
  ],
};

/**
 * `ComponentTextureFileData` — which body each of a material's textures was painted for.
 *
 * A material resource can name several files, and this is the only table that says which is
 * which: a gender, a class and a race per file, keyed by the FileDataID itself. A reader that
 * skipped it would paint a Human Female with whichever file happened to be first.
 *
 * `GenderIndex` is 0 male, 1 female, 2 none and 3 any, following wow.export's
 * `DBComponentTextureFileData`; a class of 0 is every class. Most textures have no row here at
 * all, which is not the same as being excluded — it is a texture nothing was said about, and
 * it is what the majority of the game's armour uses.
 *
 * **These column positions are the community's and were not read off an install**, like
 * `ItemSparse`'s and unlike the chains in `docs/game-files.md`.
 */
const componentTextureFileData: TableSpec = {
  fileDataId: FILE_DATA_ID.componentTextureFileData,
  layoutHash: 0xb32b030a,
  tableHash: 0x7f0c4a19,
  idColumn: 0,
  flags: 4,
  recordSize: 4,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 8 }, // GenderIndex
    { storage: Storage.plain, offsetBits: 8, sizeBits: 8 }, // ClassID
    { storage: Storage.plain, offsetBits: 16, sizeBits: 8 }, // RaceID
  ],
  sections: [
    {
      key: 0n,
      rows: [
        // The two halves of the trap: the same material, one texture per body, and the one
        // this app wants is the one with the higher id.
        [0, 0, 1], // 151001, male
        [1, 0, 1], // 151002, female
        // A texture the game marks as fitting any body, which is how most armour that has a
        // row here at all is marked.
        [3, 0, 0], // 151006, the robe's upper legs
        // A texture kept for a body this app never draws, and no female counterpart beside
        // it — so the section it belongs to is one this character simply cannot wear.
        [0, 0, 1], // 151012, the gloves' hands
      ],
      idList: [151001, 151002, 151006, 151012],
    },
    {
      // Encrypted, so the file it describes arrives untagged: nothing says which body it was
      // painted for, and a reader that treated silence as exclusion would drop a texture the
      // game does ship.
      key: 0x2d70b95c14ea836fn,
      rows: [[1, 0, 1]],
      idList: [151007],
    },
  ],
};

/**
 * `ComponentModelFileData` — which body each of a model resource's `.m2`s was modelled for.
 *
 * The same table as `componentTextureFileData` above with meshes behind it, down to the three
 * columns, and the same trap: a helm resource names a file per race and per gender — 31 of
 * them on a real install — and nothing in `ModelFileData` says which is which. A reader that
 * took the lowest id would put a Human Male's helm on a Human Female, which is geometry that
 * fits badly rather than an error.
 *
 * The silence is the same too. A weapon is modelled once and has no row here at all, and that
 * is the fallback rather than a reject.
 *
 * **A fourth column, `PositionIndex`, is which shoulder** — and it is the half of this table
 * that a helm does not use and a pauldron uses instead of the other three. Read off 12.0.5.67:
 * a helm resource's files are `gender 0 or 1, position -1`, and every one of the game's 10,449
 * shoulder resources is `gender 2, positions 0 and 1`. Position 0 is a mesh leaning towards the
 * character's left and position 1 is the same mesh mirrored, so the two are the two sides and
 * not two bodies. Which is why gender **2**, the game's "none", cannot be read as "not this
 * body": read that way there is not a pauldron in the game.
 */
const componentModelFileData: TableSpec = {
  fileDataId: FILE_DATA_ID.componentModelFileData,
  layoutHash: 0x5c1ad4e7,
  tableHash: 0x2b937f60,
  idColumn: 0,
  flags: 4,
  recordSize: 7,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 8 }, // GenderIndex
    { storage: Storage.plain, offsetBits: 8, sizeBits: 8 }, // ClassID
    { storage: Storage.plain, offsetBits: 16, sizeBits: 8 }, // RaceID
    // Wide enough to hold the -1 the game writes for a model that has no side, which is what
    // a reader sees for every helm and which arrives unsigned as a very large number.
    { storage: Storage.plain, offsetBits: 24, sizeBits: 32 }, // PositionIndex
  ],
  sections: [
    {
      key: 0n,
      rows: [
        // The helm: modelled per body, and for no side in particular.
        [0, 0, 1, -1], // 139001, for a Human Male
        [1, 0, 1, -1], // 140001, and for the Human Female this app draws
        // The pads: modelled per side, and for no body in particular. The left pad's design
        // is resource 41002 and the right's is 41003, and each resource holds *both* sides —
        // so which file is drawn is the position rather than the id, and the lower id is the
        // wrong side of both.
        [2, 0, 0, 1], // 139002, the left design mirrored onto the right shoulder
        [2, 0, 0, 0], // 140002, and on the left, where its display puts it
        [2, 0, 0, 0], // 139006, the right design on the left shoulder
        [2, 0, 0, 1], // 140006, and on the right, where its display puts it
      ],
      idList: [139001, 140001, 139002, 140002, 139006, 140006],
    },
    {
      // Encrypted, so the model it describes arrives untagged — which is the fallback rather
      // than an exclusion, exactly as it is for a texture.
      key: 0x71c3e05a9d248bf6n,
      rows: [[1, 0, 1, -1]],
      idList: [140005],
    },
  ],
};

/**
 * `HelmetGeosetData` — which of a body's geoset groups a helm covers up.
 *
 * The only table here that takes geometry away rather than adding it, and the only one that
 * names a *group* rather than a geoset: a helm hides hair, and there is no variant of hair
 * that fits under one, so the whole hundred goes.
 *
 * Which helm a row belongs to is the relationship block, the way it is in
 * `itemDisplayInfoMaterialRes` — the display names two `HelmetGeosetVisDataID`s, one per
 * gender, and the rows underneath one of them cover every race the game ships. Both of those
 * are traps, and this fixture holds each: 701 is the entry an app drawing a male body would
 * take, and 700's second row belongs to a race this app is not. Either mistake hides the robe
 * group, which is a skirt that vanishes rather than an error.
 *
 * **Hair is group 0**, which is the third trap and lives in `character.rs` rather than here:
 * geoset 0 is the body itself, and hiding "group 0" without excepting it is a bald character
 * with no body attached to her.
 */
const helmetGeosetData: TableSpec = {
  fileDataId: FILE_DATA_ID.helmetGeosetData,
  layoutHash: 0x3e70b1c9,
  tableHash: 0x08d5a2f4,
  idColumn: 0,
  flags: 4,
  recordSize: 4,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 8 }, // RaceID
    { storage: Storage.plain, offsetBits: 8, sizeBits: 8 }, // HideGeosetGroup
    { storage: Storage.plain, offsetBits: 16, sizeBits: 8 }, // a column that reads zero
    { storage: Storage.plain, offsetBits: 24, sizeBits: 8 }, // RaceBitSelection
  ],
  sections: [
    {
      key: 0n,
      rows: [
        // 700, the entry for the body this app draws: hair, and nothing else, for a Human.
        [1, 0, 0, 32],
        // The same entry for another race, which this app must not read: it hides the robe
        // group, and a reader that skipped the race would lose the skirt off every robe.
        [2, 13, 0, 32],
        // 701, the entry for the other gender. Same trap, one column over.
        [1, 13, 0, 32],
      ],
      idList: [1, 2, 3],
      relationships: [
        [700, 0],
        [700, 1],
        [701, 2],
      ],
    },
    {
      // Encrypted, so a helm pointing here hides nothing rather than everything.
      key: 0x4f9b26d10c837ae5n,
      rows: [[1, 0, 0, 32]],
      idList: [4],
      relationships: [[702, 0]],
    },
  ],
};

/**
 * `ChrModelTextureLayer` — how a texture layout is composited, one layer at a time.
 *
 * This is the table that says *which* of a choice's materials is the skin, and it is the
 * reason the app reads it rather than assuming a number: a choice paints several targets and
 * only one of them is the body underneath. The base skin is the layer that is **copied**
 * rather than blended — blend mode 1, which wow.export calls blit — and on a real layout there
 * is exactly one of those on the body atlas. The rest blend into the rectangles their section
 * mask names, one bit per `SectionType`: 8 is the upper torso and 32 the upper legs, which is
 * where the two halves of a character's underwear go.
 *
 * Three of the rows below are traps rather than decoration. The hair layer is *also* copied
 * and belongs to another atlas entirely, so a reader that took the blend mode and skipped the
 * texture type paints the body with a hairline. Layout 2's base layer is another body's, and
 * taking it would resolve — to the wrong target. And the item layer between them is a target
 * this choice paints nothing for, which is what most of the table is.
 *
 * The layout each row belongs to is in the relationship block, not in a column.
 */
const chrModelTextureLayer: TableSpec = {
  fileDataId: FILE_DATA_ID.chrModelTextureLayer,
  layoutHash: 0xd0583fb4,
  tableHash: 0x4c19e7a2,
  idColumn: 0,
  flags: 4,
  recordSize: 4,
  columns: [
    { storage: Storage.indexed, offsetBits: 0, sizeBits: 3, palette: [1, 6, 19, 20] }, // TextureType
    { storage: Storage.indexed, offsetBits: 3, sizeBits: 5, palette: [0, 1, 2, 10, 11, 14] }, // Layer
    { storage: Storage.bitpackedSigned, offsetBits: 8, sizeBits: 2 }, // Flags
    { storage: Storage.indexed, offsetBits: 10, sizeBits: 4, palette: [1, 15] }, // BlendMode
    { storage: Storage.indexed, offsetBits: 14, sizeBits: 4, palette: [-1, 512, 32, 8] }, // SectionMask
    { storage: Storage.indexed, offsetBits: 18, sizeBits: 2, palette: [-1] }, // SectionMask2
    // Field_9_0_1_34365_006[3], which nothing has ever needed and which sits between the
    // blend modes and the targets — so a reader that skipped it reads a target as a mask.
    { storage: Storage.indexedArray, offsetBits: 20, sizeBits: 2, arrayCount: 3, palette: [0, 0, 0] },
    // ChrModelTextureTargetID[2]. The game stores it as runs of two and uses only the first.
    {
      storage: Storage.indexedArray,
      offsetBits: 22,
      sizeBits: 6,
      arrayCount: 2,
      palette: [1, 0, 10, 0, 4, 0, 13, 0, 14, 0, 27, 0, 40, 0],
    },
  ],
  sections: [
    {
      key: 0n,
      // TextureType, Layer, Flags, BlendMode, SectionMask, SectionMask2, Field[3], Target[2].
      rows: [
        [1, 0, 0, 1, -1, -1, [0, 0, 0], [1, 0]], // the base skin: the body atlas, copied
        [6, 1, 0, 1, -1, -1, [0, 0, 0], [10, 0]], // hair: copied too, and a different atlas
        [1, 2, 0, 15, 512, -1, [0, 0, 0], [4, 0]], // a layer this choice paints nothing for
        // The two halves of the underwear, blended into one rectangle each: section 5, the
        // upper legs, and section 3, the upper torso. Their masks are what says so.
        [1, 10, 0, 15, 32, -1, [0, 0, 0], [13, 0]],
        [1, 11, 0, 15, 8, -1, [0, 0, 0], [14, 0]],
        [20, 14, 0, 1, -1, -1, [0, 0, 0], [27, 0]], // jewelry: a third atlas, copied as well
        // Another layout's base layer, which is the one row here that would resolve and be
        // wrong: same shape, same blend mode, a target this app must never paint.
        [1, 0, 0, 1, -1, -1, [0, 0, 0], [40, 0]],
      ],
      idList: [29, 30, 31, 39, 64, 339, 900029],
      relationships: [
        [104, 0],
        [104, 1],
        [104, 2],
        [104, 3],
        [104, 4],
        [104, 5],
        [2, 6],
      ],
    },
  ],
};

/**
 * `ChrCustomizationElement` — what one customization choice actually does to a character.
 *
 * A choice is a swatch in the character creation screen; an element is one of the things
 * picking it does. Most drive a geoset or a model and paint nothing, which is why the material
 * column is read with a zero check rather than taken whole.
 *
 * The default skin's three elements are the point: one is the body, and the other two are
 * layers the game paints over it. Nothing in this table says which is which — that is the
 * material's target and the layer table above — so a reader that stopped here and took the
 * first would paint a character with the layer meant to go on top of her.
 */
const chrCustomizationElement: TableSpec = {
  fileDataId: FILE_DATA_ID.chrCustomizationElement,
  layoutHash: 0x6483c37e,
  tableHash: 0x9a2f5c11,
  idColumn: 0,
  flags: 4,
  recordSize: 16,
  columns: [
    { storage: Storage.bitpackedSigned, offsetBits: 0, sizeBits: 17 }, // ChrCustomizationChoiceID
    { storage: Storage.bitpackedSigned, offsetBits: 17, sizeBits: 17 }, // RelatedChrCustomizationChoiceID
    { storage: Storage.bitpackedSigned, offsetBits: 34, sizeBits: 15 }, // ChrCustomizationGeosetID
    { storage: Storage.indexed, offsetBits: 49, sizeBits: 10, palette: [0] }, // SkinnedModelID
    { storage: Storage.bitpackedSigned, offsetBits: 59, sizeBits: 18 }, // ChrCustomizationMaterialID
    { storage: Storage.indexed, offsetBits: 77, sizeBits: 10, palette: [0] }, // BoneSetID
    { storage: Storage.indexed, offsetBits: 87, sizeBits: 2, palette: [0] }, // CondModelID
    { storage: Storage.indexed, offsetBits: 89, sizeBits: 9, palette: [0] }, // DisplayInfoID
    { storage: Storage.indexed, offsetBits: 98, sizeBits: 5, palette: [0] }, // ItemGeoModifyID
    { storage: Storage.indexed, offsetBits: 103, sizeBits: 1, palette: [0] }, // VoiceID
    { storage: Storage.indexed, offsetBits: 104, sizeBits: 3, palette: [0] }, // AnimKitID
    { storage: Storage.indexed, offsetBits: 107, sizeBits: 4, palette: [0] }, // ParticleColorID
    { storage: Storage.indexed, offsetBits: 111, sizeBits: 2, palette: [0] }, // GeoComponentLinkID
  ],
  sections: [
    {
      key: 0n,
      // Choice, Related, Geoset, SkinnedModel, Material, and then nine columns of nothing.
      rows: [
        // The choice this app draws, and everything picking it does.
        [85, 0, 0, 0, 823, 0, 0, 0, 0, 0, 0, 0, 0], // the skin itself
        [85, 0, 0, 0, 824, 0, 0, 0, 0, 0, 0, 0, 0], // a layer painted over it
        [85, 0, 0, 0, 825, 0, 0, 0, 0, 0, 0, 0, 0], // and another
        [85, 0, 0, 0, 826, 0, 0, 0, 0, 0, 0, 0, 0], // one whose texture no install holds
        // The same choice switching a geoset on, which paints nothing at all. A reader that
        // did not check for the zero would look up material 0 and find whatever is first.
        [85, 0, 2410, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        // A second swatch of the same option, whose skin is a different picture. Reading the
        // choice column wrong lands here, and it resolves.
        [86, 0, 0, 0, 827, 0, 0, 0, 0, 0, 0, 0, 0],
      ],
      idList: [2917, 2918, 2919, 2920, 2921, 2922],
    },
    {
      // Encrypted, so a choice belonging to a body the game has not shipped says nothing.
      key: 0x8b13f5a02c9e7d64n,
      rows: [[900, 0, 0, 0, 899, 0, 0, 0, 0, 0, 0, 0, 0]],
      idList: [2990],
    },
  ],
};

/**
 * `ChrCustomizationMaterial` — which layer of the atlas a customization paints, and with what.
 *
 * Two columns and no more, because the id is kept beside the rows: a reader that expected the
 * id inside the row would take the target for an id and the resource for a target, and every
 * material would then be filed under a layer that does not exist.
 */
const chrCustomizationMaterial: TableSpec = {
  fileDataId: FILE_DATA_ID.chrCustomizationMaterial,
  layoutHash: 0xbe9767e9,
  tableHash: 0x7e41a0d3,
  idColumn: 0,
  flags: 4,
  recordSize: 4,
  columns: [
    { storage: Storage.indexed, offsetBits: 0, sizeBits: 6, palette: [1, 13, 14, 20] }, // TextureTargetID
    { storage: Storage.bitpackedSigned, offsetBits: 6, sizeBits: 22 }, // MaterialResourcesID
  ],
  sections: [
    {
      key: 0n,
      rows: [
        [1, 53001], // 823, the default skin: the target the layer table calls the base
        [13, 53002], // 824, painted over it
        [14, 53003], // 825, and so is this
        [20, 53009], // 826, a target whose texture this install does not hold
        [1, 53004], // 827, the *other* swatch's skin — same target, another choice
      ],
      idList: [823, 824, 825, 826, 827],
    },
    {
      key: 0x4f9c2e18d73b06a5n,
      rows: [[1, 53900]],
      idList: [899],
    },
  ],
};

/**
 * `ChrCustomizationChoice` and `ChrCustomizationOption` — the swatch and the thing it is a
 * swatch of.
 *
 * Nothing in the app reads either: the choice is hard-coded, and one Human Female is the whole
 * of what this draws. `examples/dump_customization` reads them so that a run against an
 * install can say *whose* skin it just resolved, which is the difference between a chain that
 * works and a chain that works on the wrong body. They are here so that the same run against
 * the fixtures says it too.
 *
 * Both keep their ids **inside** the row, unlike the three tables above — which is why the
 * option is column 2 here and the material was column 4 there.
 */
const chrCustomizationChoice: TableSpec = {
  fileDataId: FILE_DATA_ID.chrCustomizationChoice,
  layoutHash: 0x1c8f60b3,
  tableHash: 0x2a75d9e0,
  idColumn: 1,
  flags: 0,
  recordSize: 20,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name_lang
    { storage: Storage.bitpackedSigned, offsetBits: 32, sizeBits: 18 }, // ID
    { storage: Storage.bitpackedSigned, offsetBits: 50, sizeBits: 15 }, // ChrCustomizationOptionID
    { storage: Storage.bitpackedSigned, offsetBits: 65, sizeBits: 12 }, // ChrCustomizationReqID
    { storage: Storage.bitpackedSigned, offsetBits: 77, sizeBits: 12 }, // ChrCustomizationVisReqID
    { storage: Storage.bitpackedSigned, offsetBits: 89, sizeBits: 9 }, // OrderIndex
    { storage: Storage.bitpackedSigned, offsetBits: 98, sizeBits: 9 }, // UiOrderIndex
    { storage: Storage.indexed, offsetBits: 107, sizeBits: 3, palette: [0] }, // Flags
    { storage: Storage.indexed, offsetBits: 110, sizeBits: 3, palette: [90001] }, // AddedInPatch
    { storage: Storage.indexed, offsetBits: 113, sizeBits: 3, palette: [0] }, // SoundKitID
    { storage: Storage.indexedArray, offsetBits: 116, sizeBits: 3, arrayCount: 2, palette: [0, 0] },
  ],
  sections: [
    {
      key: 0n,
      // Name, ID, Option, Req, VisReq, OrderIndex, UiOrderIndex, Flags, Patch, Sound, Swatch.
      rows: [
        ["", 85, 14, 318, 0, 0, 40, 0, 90001, 0, [0, 0]],
        ["", 86, 14, 318, 0, 1, 41, 0, 90001, 0, [0, 0]],
      ],
    },
  ],
};

const chrCustomizationOption: TableSpec = {
  fileDataId: FILE_DATA_ID.chrCustomizationOption,
  layoutHash: 0x5d2a1e94,
  tableHash: 0x6b03fc27,
  idColumn: 1,
  flags: 0,
  recordSize: 16,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name_lang
    { storage: Storage.bitpackedSigned, offsetBits: 32, sizeBits: 15 }, // ID
    { storage: Storage.bitpackedSigned, offsetBits: 47, sizeBits: 12 }, // SecondaryID
    { storage: Storage.indexed, offsetBits: 59, sizeBits: 8, palette: [0, 80] }, // Flags
    { storage: Storage.bitpackedSigned, offsetBits: 67, sizeBits: 9 }, // ChrModelID
    { storage: Storage.bitpackedSigned, offsetBits: 76, sizeBits: 6 }, // OrderIndex
    { storage: Storage.indexed, offsetBits: 82, sizeBits: 6, palette: [2] }, // CategoryID
    { storage: Storage.indexed, offsetBits: 88, sizeBits: 3, palette: [0] }, // OptionType
    { storage: Storage.indexed, offsetBits: 91, sizeBits: 3, palette: [0] }, // BarberShopCostModifier
    { storage: Storage.indexed, offsetBits: 94, sizeBits: 3, palette: [1] }, // ChrCustomizationID
    { storage: Storage.indexed, offsetBits: 97, sizeBits: 3, palette: [0] }, // Requirement
    { storage: Storage.indexed, offsetBits: 100, sizeBits: 3, palette: [1] }, // SecondaryOrderIndex
    { storage: Storage.indexed, offsetBits: 103, sizeBits: 3, palette: [90001] }, // AddedInPatch
  ],
  sections: [
    {
      key: 0n,
      rows: [["Skin Color", 14, 14, 80, 2, 2, 2, 0, 0, 1, 0, 1, 90001]],
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
  /**
   * Which geoset the submesh belongs to, as `group × 100 + value`. Only a character model has
   * these: an item's own mesh is drawn whole, and its submeshes all say zero.
   */
  geoset?: number;
  /**
   * Which entry of the texture combo list the batch reaches its texture through. Zero unless
   * the model declares several textures and its parts want different ones — which a body
   * does, because its skin and its hair are supplied separately.
   */
  combo?: number;
}

interface ModelSpec {
  fileDataId: number;
  skinFileDataId: number;
  /**
   * The `.skel` this model keeps its skeleton in, for the one model that has one.
   *
   * A retail character's bone and attachment arrays are both *empty* in the `.m2` itself: the
   * `SKID` chunk names a file beside it, and that is where the attachments a helm and a pair
   * of pauldrons hang off actually live. An item's model has nothing to attach anything to
   * and names no skeleton at all.
   */
  skeletonFileDataId?: number;
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

  if (model.skeletonFileDataId !== undefined) {
    const skeleton = new Bytes();
    skeleton.u32(model.skeletonFileDataId);
    chunk("SKID", skeleton);
  }
  return out.toBuffer();
}

/** One place on a body where a piece of gear hangs, in the game's axes: X forward, Y left,
 * **Z up** — so a helm is up the Z and the two shoulders are a pair either side of Y. */
interface AttachmentSpec {
  /** The community's numbering: 5 and 6 are the shoulders, 11 the helm, 12 the back. */
  id: number;
  at: readonly [number, number, number];
}

/**
 * One `.skel`: chunked like an M2, and holding the arrays the header used to.
 *
 * `SKA1` is the attachments and the lookup table beside them, and its offsets count from the
 * chunk's own data rather than from the file — the same trap `MD21` sets, one file over, which
 * is why the fixture has to lay them that way to prove anything.
 *
 * The records are deliberately not in id order, and their ids are not their indices. An
 * attachment is found by the id in the record; a reader that indexed the array by attachment
 * id would hang the helm off a shoulder, and only a fixture that disagrees about the two can
 * say so.
 */
function writeSkeleton(attachments: readonly AttachmentSpec[]): Uint8Array {
  const HEADER = 16;
  const records = new Bytes();
  for (const attachment of attachments) {
    records.u32(attachment.id);
    records.u16(0); // the bone it hangs off, which a bind pose does not need — see `m2.rs`
    records.u16(0); // and two bytes the format has never named
    for (const axis of attachment.at) records.f32(axis);
    // `M2Track<uint8> animate_attached`: an interpolation type, a global sequence, and two
    // empty arrays. Twenty bytes of nothing, and the reason a record is forty and not twenty.
    records.u16(0);
    records.u16(0);
    for (let word = 0; word < 4; word += 1) records.u32(0);
  }

  const lookup = new Bytes();
  for (let id = 0; id <= 12; id += 1) {
    const at = attachments.findIndex((attachment) => attachment.id === id);
    lookup.u16(at < 0 ? 0xffff : at);
  }

  const ska1 = new Bytes();
  ska1.u32(attachments.length);
  ska1.u32(HEADER);
  ska1.u32(13);
  ska1.u32(HEADER + records.length);
  ska1.bytes(records.toBuffer());
  ska1.bytes(lookup.toBuffer());

  const out = new Bytes();
  const chunk = (magic: string, payload: Bytes): void => {
    out.bytes(new TextEncoder().encode(magic));
    out.u32(payload.length);
    out.bytes(payload.toBuffer());
  };
  // The name chunk a real skeleton opens with, which nothing here reads and which is what
  // makes `SKA1` a chunk to find rather than the first one.
  const name = new Bytes();
  name.u32(1);
  name.u32(8);
  name.u32(0);
  name.u32(0);
  chunk("SKL1", name);
  chunk("SKA1", ska1);
  return out.toBuffer();
}

/**
 * Where the fixture body's gear hangs.
 *
 * The body is a row of cubes along X rather than a person, so these are chosen to be told
 * apart rather than to be anatomical: the helm is highest, the two shoulders are a mirrored
 * pair, and the back is behind. What a test reads is the position after the Z-up to Y-up turn
 * `m2.rs` makes — `(x, y, z)` becomes `(x, z, -y)` — so the helm arrives at `[0, 4, 0]` and
 * the left shoulder, which is up the game's Y, at `[0, 3, -2]`.
 */
const ATTACHMENTS: readonly AttachmentSpec[] = [
  { id: 12, at: [-1, 0, 2] }, // the back, which a quiver hangs off and a cloak does not
  { id: 6, at: [0, 2, 3] }, // the left shoulder
  { id: 11, at: [0, 0, 4] }, // the helm
  { id: 1, at: [6, 0, 0] }, // a hand, which nothing in this app asks for
  { id: 5, at: [0, -2, 3] }, // the right shoulder
];

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
    // skinSectionId: the geoset. Zero on every submesh of an item's own model, and what
    // decides which parts of a body are drawn.
    sections.u16(part.geoset ?? 0);
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
    // The combo list is written backwards, so combo zero reaches the *last* texture the model
    // declares. A reader that took the combo index for a texture index would land on the
    // first one instead, which on the helm is the slot the item fills.
    batches.u16(part.combo ?? 0);
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
 * The character everything is worn on, under the FileDataID the retail client keeps
 * `humanfemale_hd.m2` at.
 *
 * A body is not a bigger item model — it is the three things an item model never exercises,
 * and the fixture exists to hold each of them:
 *
 * - **Geosets.** All but two of the cubes are a group's variants, of which exactly one is what
 *   a body with nothing on it draws. Every group here has a `…01` — bare arms, bare legs, bare
 *   feet, no helm — beside the variant an item would switch on instead. A reader that drew all
 *   of them would put two pairs of legs in the same trousers, which is what doubled geometry
 *   and z-fighting look like from the outside. The groups are the ones the fixture's own items
 *   drive: sleeves, chest, robe, trousers, boot, feet and helm.
 * - **The `level` trap, on a part that has to be there.** The head sits past the first 64k of
 *   the index list, and it is one of the parts a bare body draws — so a reader that ignores
 *   the level does not merely draw something spare, it draws the head from the wrong vertices.
 *   That is the missing limb.
 * - **A texture the caller supplies.** The body's skin is M2 texture **type 1**, which is the
 *   composited atlas rather than a file the model names. The hair beside it is type 6, and is
 *   the reason type 1 has to be told from "not a file": painting hair with the body atlas
 *   would be as wrong as painting it with nothing, and much harder to notice.
 *
 * Nothing here is copied from the game. It is seventeen cubes with the game's own numbering on
 * them.
 */
const characterModel: ModelSpec = {
  fileDataId: 1000764,
  skinFileDataId: 1000765,
  skeletonFileDataId: 1000766,
  cubes: 19,
  // Written backwards into the combo list, so combo 2 reaches the skin, combo 1 the hair and
  // combo 0 the cape.
  textures: [
    { kind: 1, fileDataId: 0 }, // the composited body atlas
    { kind: 6, fileDataId: 0 }, // the hair, which this app composites nothing for
    { kind: 2, fileDataId: 0 }, // the cape, which is the one item picture a body wears itself
  ],
  materials: [
    [0, 0], // the body: opaque
    [0x04, 1], // the hair and the cloak: alpha tested and two-sided, which is what a sheet is
  ],
  parts: [
    // The skin, which is the one geoset with no group of its own — and the one a helm that
    // hides group 0 must leave alone, because hair *is* group 0.
    { cube: 0, from: 0, count: 36, material: 0, level: 0, geoset: 0, combo: 2 },
    // Group 8, sleeves: bare arms, and the variant a chestpiece would switch on.
    { cube: 1, from: 0, count: 36, material: 0, level: 0, geoset: 801, combo: 2 },
    { cube: 2, from: 0, count: 36, material: 0, level: 0, geoset: 802, combo: 2 },
    // Group 11, pants.
    { cube: 3, from: 0, count: 36, material: 0, level: 0, geoset: 1101, combo: 2 },
    { cube: 4, from: 0, count: 36, material: 0, level: 0, geoset: 1104, combo: 2 },
    // Group 20, feet: bare feet, and boots.
    { cube: 5, from: 0, count: 36, material: 0, level: 0, geoset: 2001, combo: 2 },
    { cube: 6, from: 0, count: 36, material: 0, level: 0, geoset: 2002, combo: 2 },
    // Group 27, helm: no helm, and a helm.
    { cube: 7, from: 0, count: 36, material: 0, level: 0, geoset: 2701, combo: 2 },
    { cube: 8, from: 0, count: 36, material: 0, level: 0, geoset: 2702, combo: 2 },
    // Group 0, the hair: the hairstyle a bare body wears and one it does not, both painted
    // with something other than the body atlas. The group is 0 because that is where the
    // retail body keeps it — geosets 1 to 33 on `humanfemale_hd`, read off 12.0.5.67 — which
    // is what puts the hair and the skin in the same hundred and makes a helm's hiding sharp.
    { cube: 9, from: 0, count: 36, material: 1, level: 0, geoset: 1, combo: 1 },
    { cube: 17, from: 0, count: 36, material: 1, level: 0, geoset: 2, combo: 1 },
    // Group 21, the skull, past the first 64k indices.
    { cube: 10, from: 0, count: 36, material: 0, level: 1, geoset: 2101, combo: 2 },
    // Group 10, the chest: bare, and the piece a chestpiece switches on.
    { cube: 11, from: 0, count: 36, material: 0, level: 0, geoset: 1001, combo: 2 },
    { cube: 12, from: 0, count: 36, material: 0, level: 0, geoset: 1002, combo: 2 },
    // Group 13, the robe — the skirt a robe hangs over the legs, and the nothing that is
    // there the rest of the time.
    { cube: 13, from: 0, count: 36, material: 0, level: 0, geoset: 1301, combo: 2 },
    { cube: 14, from: 0, count: 36, material: 0, level: 0, geoset: 1302, combo: 2 },
    // Group 5, the boot. Boots drive this *and* group 20 above, which is the pair that says
    // whether a reader applied every group an item names or stopped at the first.
    { cube: 15, from: 0, count: 36, material: 0, level: 0, geoset: 501, combo: 2 },
    { cube: 16, from: 0, count: 36, material: 0, level: 0, geoset: 502, combo: 2 },
    // Group 15, the cloak — the one piece of gear a body wears out of its own geometry. There
    // is no `1501` beside it, exactly as there is none on the retail body: a bare back is a
    // group with no default in it rather than a default that draws nothing.
    { cube: 18, from: 0, count: 36, material: 1, level: 0, geoset: 1502, combo: 0 },
  ],
};

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
  // The right shoulder pad's, so that a pair of pads is two pictures rather than one drawn
  // twice — and the cape's, which is painted onto geometry the body already carries.
  { fileDataId: 150006, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  { fileDataId: 150007, encoding: Encoding.bgra, alphaBits: 8, alphaType: 0, body: bgraPixels() },
  {
    fileDataId: 150005, encoding: Encoding.dxt, alphaBits: 8,
    alphaType: AlphaType.dxt5, body: dxtBlocks(AlphaType.dxt5),
  },
  // The character's own skin, which is what the body atlas is built on top of. Opaque
  // throughout, unlike the item textures above: a base with a transparent corner would leave
  // a quarter of the body see-through, and the four quadrant colours are what says the whole
  // 2048 × 1024 atlas was covered by it rather than a corner of it.
  {
    fileDataId: 160001, encoding: Encoding.dxt, alphaBits: 0,
    alphaType: AlphaType.dxt1, body: dxtBlocks(AlphaType.dxt1),
  },
  ...skinTextures(),
  ...bodyTextures(),
];

/**
 * The pictures a skin choice paints that are *not* the skin, and the skin of another swatch.
 *
 * Every one of these resolves. That is the whole point of them: the trap in reading a
 * customization is not a lookup that fails, it is three lookups that succeed and hand back a
 * picture meant to go somewhere else. A flat colour each, so that a body painted with the
 * wrong one is a body of the wrong colour rather than a judgement call.
 */
function skinTextures(): IconSpec[] {
  const painted: Array<[number, Paint]> = [
    [160002, [190, 40, 40, 255]], // target 13: her underwear, over the upper legs
    [160003, [40, 190, 40, 255]], // target 14: the other half of it, over the upper torso
    [160004, [40, 40, 190, 255]], // the *other* swatch's skin, on the same target as the first
  ];

  return painted.map(([fileDataId, colour]) => ({
    fileDataId,
    encoding: Encoding.bgra,
    alphaBits: 8,
    alphaType: 0,
    body: bodyPixels(colour, colour),
  }));
}

/**
 * The pictures armour is painted onto a body with: one per row of `ItemDisplayInfoMaterialRes`
 * that resolves to a file, each in colours of its own.
 *
 * A colour per texture is the whole point. Every one of these lands in a *different rectangle*
 * of one 2048 × 1024 atlas, and the ways that goes wrong — a section blitted into its
 * neighbour's rectangle, a texture that never arrived, the wrong body's copy of a material —
 * all produce an atlas rather than an error. Naming the colours is what lets a test say which
 * picture is where.
 *
 * Two of them carry a second band, for the two traps compositing sets:
 *
 * - The chestpiece's upper arms are half transparent, which is the sleeveless chestpiece from
 *   `docs/character-rendering.md`: copied rather than blended, it punches a hole in the arm.
 * - Its torso is two opaque bands, whose seam is a hard edge under a nearest-neighbour scale
 *   and a run of blends under the linear one these need.
 */
function bodyTextures(): IconSpec[] {
  const opaque = ([red, green, blue]: readonly [number, number, number]): Paint =>
    [red, green, blue, 255] as const;
  const CLEAR: Paint = [0, 0, 0, 0];

  const painted: Array<[number, Paint, Paint]> = [
    // The chestpiece's torso, for a body this app never draws, and then for the one it does.
    [151001, opaque([180, 90, 30]), opaque([180, 90, 30])],
    [151002, opaque([40, 160, 220]), opaque([220, 60, 140])],
    [151003, opaque([90, 200, 60]), CLEAR], // its upper arms, half of them not there at all
    [151004, opaque([120, 40, 200]), opaque([120, 40, 200])], // its lower arms
    [151005, opaque([30, 210, 170]), opaque([30, 210, 170])], // its lower torso
    [151006, opaque([240, 130, 20]), opaque([240, 130, 20])], // the robe's torso
    [151007, opaque([70, 20, 190]), opaque([70, 20, 190])], // the robe's upper legs
    [151008, opaque([200, 240, 40]), opaque([200, 240, 40])], // its lower legs
    [151009, opaque([20, 100, 240]), opaque([20, 100, 240])], // the boots' feet
    [151010, opaque([150, 30, 90]), opaque([150, 30, 90])], // the boots' lower legs
    // The boots' accessory section, which the layout has no rectangle for — so this is the
    // one texture here that is resolved, read, and then has nowhere to go.
    [151011, opaque([110, 190, 240]), opaque([110, 190, 240])],
    // The gloves' hands, which `ComponentTextureFileData` keeps for a body this is not — so
    // this one is resolved as far as a file and then excluded by what that table says.
    [151012, opaque([230, 200, 90]), opaque([230, 200, 90])],
  ];

  return painted.map(([fileDataId, top, bottom]) => ({
    fileDataId,
    encoding: Encoding.bgra,
    alphaBits: 8,
    alphaType: 0,
    body: bodyPixels(top, bottom),
  }));
}


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
    itemSparse,
    modelFileData,
    textureFileData,
    componentTextureFileData,
    componentModelFileData,
    helmetGeosetData,
    chrModelTextureLayer,
    chrCustomizationElement,
    chrCustomizationMaterial,
    chrCustomizationChoice,
    chrCustomizationOption,
  ],
  icons,
  raw: [
    // Every model is a pair: the geometry, and the skin profile that says which of it is
    // drawn in which batch.
    ...[...models, characterModel].flatMap((model) => [
      { fileDataId: model.fileDataId, extension: "m2", bytes: writeModel(model) },
      { fileDataId: model.skinFileDataId, extension: "skin", bytes: writeSkin(model) },
    ]),
    // The body's skeleton, which is where a retail character keeps the attachments a helm and
    // a pair of pauldrons hang off — not in the model, whose own arrays are empty.
    {
      fileDataId: 1000766,
      extension: "skel",
      bytes: writeSkeleton(ATTACHMENTS),
      note: "the body's attachments",
    },
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
