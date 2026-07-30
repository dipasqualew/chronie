/**
 * Writes the game-file fixtures the map tests read: the seven tables a zone map is assembled out
 * of, and the fragment textures they name.
 *
 * A map is the one picture in this app that is not a file. The game stores it as a grid of
 * fragments, one texture each, with four tables saying which fragment goes where and how large the
 * finished picture is — and two more holding the towns, roads and labels that only appear on a map
 * once somebody has walked there. The client puts the whole thing together every time a player opens
 * the map. So the fixtures here are shaped around the choices that assembly involves and the one
 * measurement: which of several rows of a name to believe, which art of a map, which layer of a
 * style, which areas to paste on top of it, and how much of a grid is picture rather than overhang.
 *
 * All seven have the shape the game's own do — fixed-size records, ids inside the row for `UiMap`
 * and beside them for the rest, foreign keys in a block of their own where the real tables keep
 * them there, and two float columns in the middle of the style layers where a reader that counted
 * past its last column would land. Read off build 12.0.5.67823 with `examples/dump_maps` and
 * written down in `docs/game-files.md`. The contents are entirely invented; nothing here is copied
 * from the game. How any of it is written out is [`db2-fixtures.ts`].
 *
 *     bun run scripts/make-map-fixtures.ts
 */

import {
  Encoding,
  emit,
  flatPixels,
  Storage,
  type IconSpec,
  type Paint,
  type TableSpec,
} from "./db2-fixtures";
import { FILE_DATA_ID } from "./tables";

/**
 * What the game calls each table, out of `docs/game-tables.json`.
 *
 * Only the FileDataIDs are shared with the reader. Every column position, storage and bit offset
 * below is decided here and nowhere else, deliberately: a fixture that took its layout from the
 * same registry the reader reads would move both halves together when a number in that registry
 * was wrong, and the suite would prove only that two generated halves agree.
 */
const UI_MAP = FILE_DATA_ID.uiMap;
const UI_MAP_X_MAP_ART = FILE_DATA_ID.uiMapXMapArt;
const UI_MAP_ART = FILE_DATA_ID.uiMapArt;
const UI_MAP_ART_STYLE_LAYER = FILE_DATA_ID.uiMapArtStyleLayer;
const UI_MAP_ART_TILE = FILE_DATA_ID.uiMapArtTile;
const WORLD_MAP_OVERLAY = FILE_DATA_ID.worldMapOverlay;
const WORLD_MAP_OVERLAY_TILE = FILE_DATA_ID.worldMapOverlayTile;

/**
 * How large a fragment is, and therefore how large the grid holding one is.
 *
 * Eight, because that is the size every texture `db2-fixtures.ts` writes is: the real ones are 256
 * and nothing in the reader knows either number — it takes the fragment size out of the style.
 */
const FRAGMENT = 8;

/**
 * The classic grid: four fragments across, three down, making a picture of 30×20.
 *
 * The picture is deliberately smaller than the 32×24 the grid holds, in the same proportion the
 * real thing is: a classic zone map is 1,002×668 painted into a 4×3 grid of 256-pixel fragments,
 * which holds 1,024×768. A reader that handed over the grid's own size would hand over a margin of
 * nothing down one side and along the bottom.
 */
const CLASSIC_WIDTH = 30;
const CLASSIC_HEIGHT = 20;
const CLASSIC_COLUMNS = 4;
const CLASSIC_ROWS = 3;

/** The FileDataID of the fragment at one place in the classic grid. */
const gridFragment = (row: number, column: number): number =>
  190001 + row * CLASSIC_COLUMNS + column;

/**
 * The colour of that fragment, which is what a test reads to say where it landed.
 *
 * The red channel counts the fragments in the order the grid holds them, so every one of the twelve
 * is a different colour and no two positions can be confused. A grid read with its row and column
 * the wrong way round puts the fourth fragment of the top row three rows down, which is off the
 * bottom of a three-row picture — so a transposed read shows nothing there rather than the wrong
 * colour, and the test says so either way.
 */
const gridPaint = (row: number, column: number): Paint => [
  10 * (row * CLASSIC_COLUMNS + column + 1),
  64,
  128,
  255,
];

/**
 * The fragments the rest of the fixture's places are drawn with, one apiece.
 *
 * Each is a flat colour of its own and nothing else, because what these places are here to settle
 * is *which row, which art and which layer answered* rather than how a grid is laid out — so the
 * test reads one pixel and the colour names the answer.
 */
const ONE_FRAGMENT: Record<string, { file: number; paint: Paint }> = {
  /** The dungeon row of a name that is also a zone. Ranked behind the zone. */
  tideglassDungeon: { file: 190021, paint: [200, 20, 20, 255] },
  /** The zone row of it, which is the one to draw. */
  tideglassZone: { file: 190022, paint: [20, 200, 20, 255] },
  /** The Adventure Guide's copy of the zone: a better kind on a lower row id, wrong system. */
  tideglassAdventure: { file: 190023, paint: [20, 20, 200, 255] },
  /** A name whose only row is a continent, which is drawn all the same. */
  sunderReach: { file: 190024, paint: [200, 200, 20, 255] },
  /** The art a phased map is drawn with the rest of the time. */
  ashvaultUnphased: { file: 190025, paint: [20, 200, 200, 255] },
  /** And the art it is drawn with during a campaign nothing here can ask about. */
  ashvaultPhased: { file: 190026, paint: [200, 20, 200, 255] },
  /** The base layer of a style that has two. */
  cavernsBase: { file: 190027, paint: [120, 200, 40, 255] },
  /** The other layer's fragment for the same place in the grid. */
  cavernsOther: { file: 190028, paint: [40, 120, 200, 255] },
  /** And the other layer's fragment for a place the base layer leaves empty. */
  cavernsElsewhere: { file: 190029, paint: [200, 120, 40, 255] },
  /** The one fragment of a map whose other fragment this install does not hold. */
  burrow: { file: 190030, paint: [90, 90, 200, 255] },
  /** The one fragment of a map assembled wider than a window is handed one. */
  palace: { file: 190031, paint: [200, 90, 90, 255] },
};

/** A fragment a row names and no install here holds, which is what tears a map. */
const ABSENT_FRAGMENT = 190999;

/**
 * A highlight texture, which is what `UiMapArt` holds in the two columns before the style.
 *
 * Nothing reads it, and that is the point of it being here and being a plausible FileDataID: a
 * reader that took column 0 or column 1 for the style would ask for a style that does not exist
 * rather than come back with a zero.
 */
const HIGHLIGHT = 190900;

/** `MinScale` and `MaxScale`, as the bits of the floats the real columns hold: 1.0 and 4.0. */
const MIN_SCALE = 0x3f800000;
const MAX_SCALE = 0x40800000;

/* ---------- the places ---------- */

/**
 * `UiMap` — every place the game will draw a map of.
 *
 * Its id is **inside** the row, which is the one structural difference between this table and the
 * four below it, and the name is the only thing a segment arrives carrying. Eight columns because
 * `System` and `Type` sit at 4 and 5 with more behind them: a reader one column out reads a flag
 * mask or a parent map id and believes it.
 */
const uiMap: TableSpec = {
  fileDataId: UI_MAP,
  layoutHash: 0x4bd1a207,
  tableHash: 0x51d0c39e,
  idColumn: 1,
  flags: 0,
  recordSize: 26,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // Name_lang
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // ID
    { storage: Storage.plain, offsetBits: 64, sizeBits: 32 }, // ParentUiMapID
    { storage: Storage.plain, offsetBits: 96, sizeBits: 32 }, // Flags
    { storage: Storage.plain, offsetBits: 128, sizeBits: 8 }, // System
    { storage: Storage.plain, offsetBits: 136, sizeBits: 8 }, // Type
    { storage: Storage.plain, offsetBits: 144, sizeBits: 32 }, // BountySetID
    { storage: Storage.plain, offsetBits: 176, sizeBits: 32 }, // VisibilityPlayerConditionID
  ],
  sections: [
    {
      key: 0n,
      // Name, id, parent, flags, system, type, bounty set, visibility condition.
      rows: [
        // A zone with one row and one art: the ordinary case, and the grid that says a map was
        // assembled rather than a fragment handed over whole.
        ["Emberfall Marches", 10, 90, 6, 0, 3, 0, 0],
        // One name on three rows. The dungeon comes first in the table and has the lowest id of
        // the two world rows, so a reader that took the first row met, or the lowest id, would
        // draw it; the zone is the one an evening was spent in. The third is the Adventure
        // Guide's copy, which has the best kind *and* the lowest id of all three — it is here to
        // be beaten by the system column alone.
        ["Tideglass Hollow", 11, 90, 0, 0, 4, 0, 0],
        ["Tideglass Hollow", 12, 90, 0, 0, 3, 0, 0],
        ["Tideglass Hollow", 9, 90, 0, 2, 3, 0, 0],
        // A name whose only row is a continent — the kind ranked behind zones, dungeons and the
        // caves inside them, and still a picture of somewhere.
        ["Sunder Reach", 14, 0, 0, 0, 2, 0, 0],
        // A map with art of its own for a phase of a campaign, beside the art it is drawn with
        // the rest of the time.
        ["Ashvault", 15, 90, 0, 0, 3, 0, 0],
        // A map whose style has two layers.
        ["Glass Caverns", 16, 90, 0, 0, 3, 0, 0],
        // A map whose art is drawn in a style no layer describes, which is one of the two ways a
        // row that names art still reaches no picture.
        ["Zekvir's Lair", 17, 90, 0, 0, 4, 0, 0],
        // A map one of whose fragments this install does not hold.
        ["Grubwarden's Burrow", 18, 90, 0, 0, 4, 0, 0],
        // A map assembled wider than a window is ever handed one.
        ["Nerub-ar Palace", 19, 90, 0, 0, 4, 0, 0],
        // The other way a row reaches no picture: art with no fragments at all. It is the
        // best-ranked row of its name, and the dungeon row behind it shares Emberfall's art — so
        // this pair is what says the ranking is walked rather than resolved once.
        ["Hollowmere", 21, 90, 0, 0, 3, 0, 0],
        ["Hollowmere", 22, 90, 0, 0, 4, 0, 0],
        // A map that names no art at all, which is a row of zero rather than a missing row.
        ["Blank Hollow", 24, 90, 0, 0, 3, 0, 0],
      ],
    },
    {
      // Encrypted, so its row arrives as zeroes: a place from content this install has not been
      // given the key to. Its name reads as empty and nothing can be looked up by it.
      key: 0x6b12f4a97d3e5c80n,
      rows: [["Unreleased Vale", 25, 90, 0, 0, 3, 0, 0]],
    },
  ],
};

/* ---------- the art of a place ---------- */

/**
 * `UiMapXMapArt` — which art a map is drawn with, and when.
 *
 * The map is in the relationship block rather than in a column, and the ids are in a list beside
 * the rows: both are how the real table keeps them, and between them they leave this table two
 * columns wide.
 */
const uiMapXMapArt: TableSpec = {
  fileDataId: UI_MAP_X_MAP_ART,
  layoutHash: 0x1f7ca934,
  tableHash: 0x2c8b71d5,
  idColumn: 0,
  // Bit 2: the ids are kept in a list beside the rows rather than in a column of their own.
  flags: 4,
  recordSize: 8,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // PhaseID
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // UiMapArtID
  ],
  sections: [
    {
      key: 0n,
      // Phase, art.
      rows: [
        [0, 20], // Emberfall Marches
        [0, 21], // Tideglass Hollow, the dungeon
        [0, 22], // Tideglass Hollow, the zone
        [0, 23], // Tideglass Hollow, the Adventure Guide's
        [0, 24], // Sunder Reach
        // Ashvault's phased art comes first and on the lower row id, so an assembly that took
        // the first row met would draw the campaign's version of the place.
        [7, 26],
        [0, 25],
        [0, 27], // Glass Caverns
        [0, 28], // Zekvir's Lair
        [0, 29], // Grubwarden's Burrow
        [0, 30], // Nerub-ar Palace
        [0, 32], // Hollowmere, the zone
        [0, 20], // Hollowmere, the dungeon — one art drawn for two maps, as the real ones are
        [0, 0], // Blank Hollow, which names no art
      ],
      idList: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113],
      relationships: [
        [10, 0],
        [11, 1],
        [12, 2],
        [9, 3],
        [14, 4],
        [15, 5],
        [15, 6],
        [16, 7],
        [17, 8],
        [18, 9],
        [19, 10],
        [21, 11],
        [22, 12],
        [24, 13],
      ],
    },
    {
      // Encrypted, so the row and the block beside it arrive as zeroes: the art of a place from
      // content this install has not been given the key to. It belongs to map zero and names art
      // zero, which is what the reader has to walk past rather than follow.
      key: 0x6b12f4a97d3e5c80n,
      rows: [[0, 40]],
      idList: [120],
      relationships: [[25, 0]],
    },
  ],
};

/**
 * `UiMapArt` — one map's art, which is almost nothing but the style it is drawn in.
 *
 * Its two other columns hold a highlight texture and that texture's atlas entry. Both are here,
 * and both hold something, so that a reader which took either of them for the style asks for a
 * style rather than for nothing.
 */
const uiMapArt: TableSpec = {
  fileDataId: UI_MAP_ART,
  layoutHash: 0x73ba1c20,
  tableHash: 0x5e01d4a8,
  idColumn: 0,
  flags: 4,
  recordSize: 12,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // HighlightFileDataID
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // HighlightAtlasID
    { storage: Storage.plain, offsetBits: 64, sizeBits: 32 }, // UiMapArtStyleID
  ],
  sections: [
    {
      key: 0n,
      // Highlight, highlight atlas, style.
      rows: [
        [HIGHLIGHT, 4001, 1], // 20, the classic grid
        [HIGHLIGHT, 4002, 1], // 21
        [HIGHLIGHT, 4003, 1], // 22
        [HIGHLIGHT, 4004, 1], // 23
        [HIGHLIGHT, 4005, 1], // 24
        [HIGHLIGHT, 4006, 1], // 25
        [HIGHLIGHT, 4007, 1], // 26
        [HIGHLIGHT, 4008, 2], // 27, the style with two layers
        // 28, drawn in a style no layer row describes — which is a style the game shipped and
        // this install's layer table has nothing for.
        [HIGHLIGHT, 4009, 99],
        [HIGHLIGHT, 4010, 1], // 29
        [HIGHLIGHT, 4011, 3], // 30, the style assembled wider than a window is handed
        [HIGHLIGHT, 4012, 1], // 32, whose art has no fragments
      ],
      idList: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32],
    },
    {
      // Encrypted: an art whose row arrives as zeroes, so it names no style and nothing can be
      // laid out from it. Its id is in the list beside the rows and survives, which is the shape
      // that makes this worth having — the id resolves and the row behind it says nothing.
      key: 0x6b12f4a97d3e5c80n,
      rows: [[HIGHLIGHT, 4013, 1]],
      idList: [40],
    },
  ],
};

/**
 * `UiMapArtStyleLayer` — how a style's fragments make a picture.
 *
 * The two floats in the middle of it are the trap this table sets and they are here holding real
 * float bits: a reader that counted one column past the fragment height would come back with
 * 1,065,353,216 and lay out a grid of a billion fragments. The style with two layers keeps them the
 * other way round from the order they should be read in, so taking the first row met draws the
 * wrong one.
 */
const uiMapArtStyleLayer: TableSpec = {
  fileDataId: UI_MAP_ART_STYLE_LAYER,
  layoutHash: 0x0d95e731,
  tableHash: 0x62af18c3,
  idColumn: 0,
  flags: 4,
  recordSize: 21,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 8 }, // LayerIndex
    { storage: Storage.plain, offsetBits: 8, sizeBits: 16 }, // LayerWidth
    { storage: Storage.plain, offsetBits: 24, sizeBits: 16 }, // LayerHeight
    { storage: Storage.plain, offsetBits: 40, sizeBits: 16 }, // TileWidth
    { storage: Storage.plain, offsetBits: 56, sizeBits: 16 }, // TileHeight
    { storage: Storage.plain, offsetBits: 72, sizeBits: 32 }, // MinScale
    { storage: Storage.plain, offsetBits: 104, sizeBits: 32 }, // MaxScale
    { storage: Storage.plain, offsetBits: 136, sizeBits: 32 }, // AdditionalZoomSteps
  ],
  sections: [
    {
      key: 0n,
      // Layer, width, height, fragment width, fragment height, min scale, max scale, zoom steps.
      rows: [
        // Style 2's second layer, first in the table and on the lower row id.
        [1, 2 * FRAGMENT, FRAGMENT, FRAGMENT, FRAGMENT, MIN_SCALE, MAX_SCALE, 0],
        [0, 2 * FRAGMENT, FRAGMENT, FRAGMENT, FRAGMENT, MIN_SCALE, MAX_SCALE, 0],
        // Style 1: the classic grid, whose picture is smaller than the fragments holding it.
        [0, CLASSIC_WIDTH, CLASSIC_HEIGHT, FRAGMENT, FRAGMENT, MIN_SCALE, MAX_SCALE, 2],
        // Style 3: a picture far wider than a window is handed one.
        [0, 2048, 1024, FRAGMENT, FRAGMENT, MIN_SCALE, MAX_SCALE, 6],
      ],
      idList: [200, 201, 202, 203],
      relationships: [
        [2, 0],
        [2, 1],
        [1, 2],
        [3, 3],
      ],
    },
    {
      // Encrypted, so a style this install cannot read comes back stating a picture of no size out
      // of fragments of no size — which is the one arrangement that cannot be drawn at all, and
      // has to be dropped rather than divided by.
      key: 0x6b12f4a97d3e5c80n,
      rows: [[0, CLASSIC_WIDTH, CLASSIC_HEIGHT, FRAGMENT, FRAGMENT, MIN_SCALE, MAX_SCALE, 0]],
      idList: [204],
      relationships: [[4, 0]],
    },
  ],
};

/* ---------- the fragments ---------- */

/** Which fragment goes where, as `[art, row, column, layer, file]`. */
const FRAGMENTS: Array<[number, number, number, number, number]> = [
  // The classic grid, twelve fragments in the order the table holds them.
  ...Array.from(
    { length: CLASSIC_ROWS * CLASSIC_COLUMNS },
    (_, at): [number, number, number, number, number] => {
      const row = Math.floor(at / CLASSIC_COLUMNS);
      const column = at % CLASSIC_COLUMNS;
      return [20, row, column, 0, gridFragment(row, column)];
    },
  ),
  // The three rows of one name, one fragment each, so the colour says which row answered.
  [21, 0, 0, 0, ONE_FRAGMENT.tideglassDungeon!.file],
  [22, 0, 0, 0, ONE_FRAGMENT.tideglassZone!.file],
  // A row naming no texture at all, on the art that answers for that name so that it is a row the
  // reader actually reaches. Nothing is drawn where it points and the place still has its map. No
  // row of the real table is like this on 12.0.5.67823 — all 66,704 name a texture — so this is
  // the guard being held to account rather than a case the game has been seen to hold.
  [22, 0, 1, 0, 0],
  [23, 0, 0, 0, ONE_FRAGMENT.tideglassAdventure!.file],
  [24, 0, 0, 0, ONE_FRAGMENT.sunderReach!.file],
  [25, 0, 0, 0, ONE_FRAGMENT.ashvaultUnphased!.file],
  [26, 0, 0, 0, ONE_FRAGMENT.ashvaultPhased!.file],
  // The style with two layers. The base layer paints the left half of the picture; the other
  // layer paints the same half a different colour and the right half as well, so a reader that
  // mixed the layers shows the wrong colour on the left or a painted right half, and one that
  // took the wrong layer shows both.
  [27, 0, 0, 0, ONE_FRAGMENT.cavernsBase!.file],
  [27, 0, 0, 1, ONE_FRAGMENT.cavernsOther!.file],
  [27, 0, 1, 1, ONE_FRAGMENT.cavernsElsewhere!.file],
  // A map with a fragment this install does not hold, beside one it does.
  [29, 0, 0, 0, ONE_FRAGMENT.burrow!.file],
  [29, 0, 1, 0, ABSENT_FRAGMENT],
  [30, 0, 0, 0, ONE_FRAGMENT.palace!.file],
];

/**
 * `UiMapArtTile` — the fragments themselves, one row per texture.
 *
 * Which art a row belongs to is in the relationship block, and the row and column indices are 8
 * bits each in the order the game's own names put them: row, then column. The real table is 66,704
 * rows and this is fifteen, but the shape is the same and so is the errand — which of them belong
 * to the handful of arts a window is showing.
 */
const uiMapArtTile: TableSpec = {
  fileDataId: UI_MAP_ART_TILE,
  layoutHash: 0x2da5b77b,
  tableHash: 0x4f1e6820,
  idColumn: 0,
  flags: 4,
  recordSize: 7,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 8 }, // RowIndex
    { storage: Storage.plain, offsetBits: 8, sizeBits: 8 }, // ColIndex
    { storage: Storage.plain, offsetBits: 16, sizeBits: 8 }, // LayerIndex
    { storage: Storage.plain, offsetBits: 24, sizeBits: 32 }, // FileDataID
  ],
  sections: [
    {
      key: 0n,
      rows: FRAGMENTS.map(([, row, column, layer, file]) => [row, column, layer, file]),
      idList: FRAGMENTS.map((_, at) => 300 + at),
      relationships: FRAGMENTS.map(([art], at): [number, number] => [art, at]),
    },
    {
      // Encrypted, so the fragment of a place from unshipped content arrives as zeroes: no
      // position, no texture, and a relationship block of nothing. It belongs to no art any place
      // reaches, which is what the reader walks past.
      key: 0x6b12f4a97d3e5c80n,
      rows: [[0, 0, 0, ABSENT_FRAGMENT]],
      idList: [400],
      relationships: [[40, 0]],
    },
  ],
};

/* ---------- what exploring a place reveals ---------- */

/**
 * The areas of the classic zone's map, and what each is here to say.
 *
 * All of them belong to the one art whose grid fills its picture, because that is the arrangement
 * the real ones are in: a zone's terrain underneath, and the towns, roads and labels pasted on top
 * as their areas are discovered. Their colours are far from the twelve the grid is painted in and
 * far from each other, so one pixel of the finished map names which patch reached it.
 *
 * Laid out to leave the grid's own corners alone — those are what say the base was assembled right
 * — and so that no two of them overlap except the pair that is meant to.
 */
const PATCHES: Array<{
  id: number;
  art: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Its fragments, as `[row, column, layer, file]`. */
  fragments: Array<[number, number, number, number]>;
  note: string;
}> = [
  {
    // Two fragments across, and a picture narrower than the two of them: local x 0 to 12 out of the
    // 16 the pair holds, which is the same overhang the map itself has and the same crop.
    id: 500,
    art: 20,
    left: 12,
    top: 4,
    width: 12,
    height: FRAGMENT,
    fragments: [
      [0, 0, 0, 190041],
      [0, 1, 0, 190042],
    ],
    note: "an area of two fragments, cropped to a picture narrower than they hold",
  },
  {
    // Wholly transparent, over ground whose colour is known. An area's picture is a shape with soft
    // edges rather than a rectangle, so a reader that copied it instead of blending would stamp a
    // fragment-sized hole in the terrain — and this is what that would look like.
    id: 501,
    art: 20,
    left: 24,
    top: 8,
    width: FRAGMENT,
    height: FRAGMENT,
    fragments: [[0, 0, 0, 190043]],
    note: "an area painted on nothing at all, which must leave the terrain alone",
  },
  {
    // One fragment this install holds and one it does not. Unlike the map underneath, an area that
    // cannot be read whole is left off and the terrain shows through — which is what that ground
    // looks like to somebody who has not been there.
    id: 502,
    art: 20,
    left: 0,
    top: 12,
    width: 12,
    height: FRAGMENT,
    fragments: [
      [0, 0, 0, 190044],
      [0, 1, 0, ABSENT_FRAGMENT],
    ],
    note: "an area with a fragment this install does not hold",
  },
  {
    // No size and no fragments, which 506 of the real table's 2,909 rows are.
    id: 503,
    art: 20,
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    fragments: [],
    note: "an area that states no size, which is nothing to paste anywhere",
  },
  {
    // Its only fragment is on the layer the map is not assembled from, so the area has nothing on
    // the layer that matters and is dropped rather than drawn at another scale.
    id: 504,
    art: 20,
    left: 16,
    top: 12,
    width: 6,
    height: FRAGMENT,
    fragments: [[0, 0, 1, 190045]],
    note: "an area whose only fragment belongs to another layer",
  },
  {
    // Two areas over the same ground, which is what a place with art for a phase of a campaign has:
    // the game shows one of them to a player who has met some condition it keeps and this cannot
    // ask about, so both are painted and the later row wins where they meet.
    id: 520,
    art: 20,
    left: 0,
    top: 4,
    width: FRAGMENT,
    height: FRAGMENT,
    fragments: [[0, 0, 0, 190046]],
    note: "the earlier of two areas over one piece of ground",
  },
  {
    id: 521,
    art: 20,
    left: 0,
    top: 4,
    width: FRAGMENT,
    height: FRAGMENT,
    fragments: [[0, 0, 0, 190047]],
    note: "and the later, which is the one that shows",
  },
];

/** The colour each of those areas is painted, keyed by the texture it is written as. */
const PATCH_PAINT: Record<number, Paint> = {
  190041: [250, 40, 40, 255],
  190042: [40, 250, 40, 255],
  /** Transparent: the whole point of the area it belongs to. */
  190043: [0, 0, 0, 0],
  190044: [150, 150, 40, 255],
  190045: [40, 60, 250, 255],
  190046: [200, 60, 200, 255],
  190047: [60, 200, 200, 255],
};

/**
 * `WorldMapOverlay` — one row per area of a map, saying where its picture goes.
 *
 * The one table in this chain that keeps its id **and** the art it belongs to inside the row. The
 * six columns past the offsets are the rectangle the pointer has to be inside to name the area, a
 * player condition and a flag mask; nothing reads them, and they are here holding plausible values
 * so that a reader which counted past the offsets lands on a column rather than off the record.
 */
const worldMapOverlay: TableSpec = {
  fileDataId: WORLD_MAP_OVERLAY,
  layoutHash: 0x9a196494,
  tableHash: 0x3b7d0e12,
  idColumn: 0,
  flags: 0,
  recordSize: 44,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 32 }, // ID
    { storage: Storage.plain, offsetBits: 32, sizeBits: 32 }, // UiMapArtID
    { storage: Storage.plain, offsetBits: 64, sizeBits: 16 }, // TextureWidth
    { storage: Storage.plain, offsetBits: 80, sizeBits: 16 }, // TextureHeight
    { storage: Storage.plain, offsetBits: 96, sizeBits: 32 }, // OffsetX
    { storage: Storage.plain, offsetBits: 128, sizeBits: 32 }, // OffsetY
    { storage: Storage.plain, offsetBits: 160, sizeBits: 32 }, // HitRectTop
    { storage: Storage.plain, offsetBits: 192, sizeBits: 32 }, // HitRectBottom
    { storage: Storage.plain, offsetBits: 224, sizeBits: 32 }, // HitRectLeft
    { storage: Storage.plain, offsetBits: 256, sizeBits: 32 }, // HitRectRight
    { storage: Storage.plain, offsetBits: 288, sizeBits: 32 }, // PlayerConditionID
    { storage: Storage.plain, offsetBits: 320, sizeBits: 32 }, // Flags
  ],
  sections: [
    {
      key: 0n,
      // Id, art, width, height, left, top, the four hit-rectangle edges, condition, flags. The
      // condition on the second of the overlapping pair is what the real table's hundred such rows
      // hold, and nothing here evaluates it — both are painted.
      rows: PATCHES.map((patch) => [
        patch.id,
        patch.art,
        patch.width,
        patch.height,
        patch.left,
        patch.top,
        patch.top,
        patch.top + patch.height,
        patch.left,
        patch.left + patch.width,
        patch.id === 521 ? 4001 : 0,
        0,
      ]),
    },
    {
      // Encrypted, so an area of a place from unshipped content arrives as zeroes: no art, no size
      // and no offsets, which is a row to walk past rather than a rectangle to paste.
      key: 0x6b12f4a97d3e5c80n,
      rows: [[600, 20, FRAGMENT, FRAGMENT, 0, 0, 0, 0, 0, 0, 0, 0]],
    },
  ],
};

/**
 * `WorldMapOverlayTile` — the fragments of those areas, in the arrangement the map's own use.
 *
 * The same four columns as `UiMapArtTile` and the same relationship block, which is what makes the
 * two grids one piece of code in the reader.
 */
const worldMapOverlayTile: TableSpec = {
  fileDataId: WORLD_MAP_OVERLAY_TILE,
  layoutHash: 0x2c843422,
  tableHash: 0x18ef2d5a,
  idColumn: 0,
  flags: 4,
  recordSize: 7,
  columns: [
    { storage: Storage.plain, offsetBits: 0, sizeBits: 8 }, // RowIndex
    { storage: Storage.plain, offsetBits: 8, sizeBits: 8 }, // ColIndex
    { storage: Storage.plain, offsetBits: 16, sizeBits: 8 }, // LayerIndex
    { storage: Storage.plain, offsetBits: 24, sizeBits: 32 }, // FileDataID
  ],
  sections: [
    {
      key: 0n,
      rows: PATCHES.flatMap(({ fragments }) =>
        fragments.map(([row, column, layer, file]) => [row, column, layer, file]),
      ),
      idList: PATCHES.flatMap(({ fragments }, at) =>
        fragments.map((_, index) => 700 + at * 10 + index),
      ),
      relationships: PATCHES.flatMap(({ id, fragments }) =>
        fragments.map((): [number, number] => [id, 0]),
      ).map(([overlay], at): [number, number] => [overlay, at]),
    },
    {
      // Encrypted: a fragment of an area from unshipped content, belonging to an overlay no place
      // reaches and naming a texture nothing here holds.
      key: 0x6b12f4a97d3e5c80n,
      rows: [[0, 0, 0, ABSENT_FRAGMENT]],
      idList: [800],
      relationships: [[600, 0]],
    },
  ],
};

/* ---------- the textures ---------- */

/** One fragment, uncompressed and one flat colour, as the reader will be handed it. */
const fragment = (file: number, paint: Paint): IconSpec => ({
  fileDataId: file,
  encoding: Encoding.bgra,
  alphaBits: 8,
  alphaType: 0,
  body: flatPixels(paint),
});

const icons: IconSpec[] = [
  ...Array.from({ length: CLASSIC_ROWS * CLASSIC_COLUMNS }, (_, at) => {
    const row = Math.floor(at / CLASSIC_COLUMNS);
    const column = at % CLASSIC_COLUMNS;
    return fragment(gridFragment(row, column), gridPaint(row, column));
  }),
  ...Object.values(ONE_FRAGMENT).map(({ file, paint }) => fragment(file, paint)),
  ...Object.entries(PATCH_PAINT).map(([file, paint]) => fragment(Number(file), paint)),
];

emit("maps", {
  tables: [
    uiMap,
    uiMapXMapArt,
    uiMapArt,
    uiMapArtStyleLayer,
    uiMapArtTile,
    worldMapOverlay,
    worldMapOverlayTile,
  ],
  icons,
});
