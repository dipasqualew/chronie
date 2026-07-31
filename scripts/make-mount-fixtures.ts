/**
 * Writes the game-file fixture the mount catalogue is read from: `Mount`, and nothing else.
 *
 * One table, three columns of which two are read — the name and the line the game says a mount
 * comes from — with the ten columns of the real table in their real places around them, because
 * leaving the unread ones out would move the read ones and let a wrong offset pass. The layout
 * is the shape of the game's own: fixed-size records, the three strings leading, the ids kept
 * in a list beside the rows, and one section the client encrypts. The contents are entirely
 * invented; nothing here is copied from the game. How any of it is written out is
 * [`db2-fixtures.ts`].
 *
 *     bun run scripts/make-mount-fixtures.ts
 */

import { emit, Storage, type TableSpec } from "./db2-fixtures";
import { FILE_DATA_ID } from "./tables";

/**
 * What the game calls the table, out of `docs/game-tables.json`.
 *
 * Only the FileDataID is shared with the reader. Every column position and bit offset below is
 * decided here and nowhere else, deliberately: a fixture that took its layout from the same
 * registry the reader reads would move both halves together when a number in that registry was
 * wrong, and the suite would prove only that two generated halves agree.
 */
const MOUNT = FILE_DATA_ID.mount;

/**
 * `Mount` — every mount the game has.
 *
 * Thirteen columns, in the order the real table has them. The three strings lead and the id sits
 * fourth, which is why the source line is column 1 rather than column 2: a reader that counted
 * from the wrong end would find the description where the source belongs, and both are strings,
 * so nothing but the words would say so.
 */
const mount: TableSpec = {
  fileDataId: MOUNT,
  layoutHash: 0x5c2ae091,
  tableHash: 0x1f60b3d4,
  idColumn: 0,
  // Bit 2: the ids are kept in a list beside the rows rather than in a column of their own.
  flags: 4,
  recordSize: 52,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name_lang
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // SourceText_lang
    { storage: Storage.plain, offsetBits: 64, sizeBits: 32 }, // Description_lang
    { storage: Storage.plain, offsetBits: 96, sizeBits: 32 }, // MountTypeID
    { storage: Storage.plain, offsetBits: 128, sizeBits: 32 }, // Flags
    { storage: Storage.plain, offsetBits: 160, sizeBits: 32 }, // SourceTypeEnum
    { storage: Storage.plain, offsetBits: 192, sizeBits: 32 }, // SourceSpellID
    { storage: Storage.plain, offsetBits: 224, sizeBits: 32 }, // PlayerConditionID
    { storage: Storage.plain, offsetBits: 256, sizeBits: 32 }, // MountFlyRideHeight
    { storage: Storage.plain, offsetBits: 288, sizeBits: 32 }, // UiModelSceneID
    { storage: Storage.plain, offsetBits: 320, sizeBits: 32 }, // MountSpecialRiderAnimKitID
    { storage: Storage.plain, offsetBits: 352, sizeBits: 32 }, // MountSpecialSpellVisualKitID
    { storage: Storage.plain, offsetBits: 384, sizeBits: 32 }, // one more, so the run is not the end
  ],
  sections: [
    {
      key: 0n,
      rows: [
        // Written the way the client writes it: the labels made yellow, `|n` between the
        // parts, and a texture escape for the coin. All three have to survive being taken
        // out, and the coin is the one that would otherwise leave `64:64:0:0` on screen.
        [
          "Brown Horse",
          "|cFFFFD200Vendor: |rUnger Statforth|n|cFFFFD200Zone: |rWetlands|n" +
            "|cFFFFD200Cost: |r1|TINTERFACE\\MONEYFRAME\\UI-GOLDICON.BLP:0|t",
          "A patient horse.",
          230,
          0,
          2,
          458,
          0,
          0,
          4,
          0,
          0,
          0,
        ],
        [
          "Tideglass Drake",
          "|cFFFFD200Drop: |rThe Tidewarden|n|cFFFFD200Zone: |rTideglass Deeps",
          "It has been down there a long time.",
          248,
          64,
          1,
          310042,
          0,
          1,
          4,
          0,
          0,
          0,
        ],
        // Eleven rows of the real table say nothing at all about where a mount comes from.
        ["Unbroken Skystrider", "", "", 248, 0, 0, 310043, 0, 1, 4, 0, 0, 0],
      ],
      idList: [6, 1601, 1602],
    },
    {
      // Encrypted, so its row arrives as zeroes — which is a mount with no name, and the one
      // case the reader has to drop rather than draw.
      key: 0x6d21b40e97c5183an,
      rows: [["Unreleased Mount", "", "", 248, 0, 0, 310044, 0, 1, 4, 0, 0, 0]],
      idList: [1900],
    },
  ],
};

/* ---------- go ---------- */

emit("mounts", { tables: [mount] });
