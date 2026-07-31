/**
 * The wardrobe: the sets, the looks inside them, what a reader has said about them, and the
 * bodies wearing them.
 *
 * By some way the largest part of the mock and the part that moves most, which is the reason it
 * is a file of its own — a branch teaching the window a new transmog command edits this and
 * meets nobody.
 */

import type { CharacterQuestion, E2EMock } from "../../src/types";

import { fixtureModel } from "./fixtureModel";

/**
 * What every item of the transmog fixtures says about itself beyond its name.
 *
 * The window groups a set's rows by appearance and reads these three to say what separates two
 * items that give the same look, so a row has to carry them whether or not the flow below
 * looks at them. Every item here is one anybody may wear.
 */
export const ANY_CLASS_ITEM = { allowableClass: 0xffff, requiredLevel: 0, quality: 4 } as const;

/** And what the backend answers for an appearance whose item the game keeps encrypted. */
export const WITHHELD_ITEM = { allowableClass: 0, requiredLevel: 0, quality: 0 } as const;

/**
 * How many looks the gallery draws at a time, mirroring `gallery.ts`.
 *
 * Written here rather than imported so that a change to the page size shows up as a failing
 * count rather than as a test that quietly follows it.
 */
export const GALLERY_PAGE = 20;

/**
 * How long a page of twenty characters is allowed to take, from the switch to the last picture.
 *
 * Generous on purpose. This is the browser half of the benchmark issue #129 asks for, and what a
 * shared CI runner can be trusted to say is the order of magnitude rather than the milliseconds:
 * the machine this was written on draws the page in about a second, and anything approaching this
 * number is a grid that has stopped working rather than one that got slower.
 */
export const GALLERY_PATIENCE_MS = 30_000;

/**
 * A page of chestpieces, which exists so the gallery can be driven at the size it really runs at.
 *
 * Distinct display ids, because the window asks for one body per display and two rows of one
 * display are one picture — so twenty rows sharing a display would be a page of one and would
 * prove nothing about twenty. What each of them is *wearing* is the same fixture body, which is
 * the part of a browser benchmark that does not have to differ: three.js parses, uploads and
 * draws each one from scratch either way.
 *
 * A few more than a page, so that turning the pictures on visibly shortens the list: the same
 * kind drawn as names fits in one page of a hundred and drawn as characters does not.
 */
export const GALLERY_LOOKS = Array.from({ length: GALLERY_PAGE + 4 }, (_, index) => ({
  appearanceId: 81000 + index,
  itemId: 31000 + index,
  // Numbered so that "the twentieth row drew" is a thing an assertion can name.
  name: `Robe of the Deep ${String(index).padStart(2, "0")}`,
  displayType: 3,
  inventoryType: 5,
  classId: 4,
  subclassId: 2,
  allowableClass: 0xffff,
  requiredLevel: 0,
  quality: 3,
  displayInfoId: 901000 + index,
  iconFileDataId: 130003,
  hasModel: false,
  itemCount: 1,
  liftsRestriction: false,
}));

/**
 * What each body is asked, by `ChrModel`. Two bodies, and not the same questions under other
 * names: a beard is a question no female body is ever asked, which is why picking the other
 * body replaces the form rather than relabelling it.
 */
export const CHARACTER_QUESTIONS: Record<number, CharacterQuestion[]> = {
  1: [
    {
      id: 11,
      name: "Hair Style",
      swatches: [
        { id: 44, name: "Bald" },
        { id: 45, name: "Peasant" },
      ],
    },
    {
      id: 13,
      name: "Beard",
      swatches: [
        { id: 70, name: "Clean" },
        { id: 71, name: "Full" },
      ],
    },
  ],
  2: [
    {
      id: 16,
      name: "Hair Style",
      swatches: [
        { id: 132, name: "Loose" },
        { id: 133, name: "Braided" },
      ],
    },
    // Unnamed, as most of the game's own swatches are: a skin tone is a square of colour.
    {
      id: 14,
      name: "Skin Color",
      swatches: [
        { id: 85, name: "" },
        { id: 86, name: "" },
      ],
    },
  ],
};

// The same invented sets the backend fixtures hold, so the two halves of the transmog
// view are exercised against one story rather than two.
export const transmog: E2EMock["transmog"] = {
  readCount: 6,
  declaredCount: 8,
  withheldCount: 2,
  sets: [
    {
      id: 205,
      name: "Duskwoven Shroud",
      group: "Duskwoven Attire",
      groupId: 3,
      classMask: 0,
      expansionId: 5,
      parentId: 0,
      flags: 0,
      uiOrder: 15,
      patchIntroduced: 110000,
      itemCount: 2,
    },
    {
      id: 203,
      name: "Emberforge Plate",
      group: "Emberforge Armory",
      groupId: 2,
      classMask: 0x0023,
      expansionId: 4,
      parentId: 0,
      flags: 2,
      uiOrder: 5,
      patchIntroduced: 100300,
      itemCount: 6,
    },
    {
      id: 201,
      name: "Tideglass Regalia",
      group: "Tideglass Wardrobe",
      groupId: 1,
      classMask: 0x0190,
      expansionId: 3,
      parentId: 0,
      flags: 1,
      uiOrder: 5,
      patchIntroduced: 100200,
      itemCount: 6,
    },
    // The same clothes in another colour, which the game says by naming 201 as its parent. It
    // has no card of its own: it is a square on 201's rail, and clicking it draws 201's card as
    // this set instead. 1,724 of a shipping install's sets are one of these.
    {
      id: 211,
      name: "Verdigris Tideglass Regalia",
      group: "Tideglass Wardrobe",
      groupId: 1,
      classMask: 0x0190,
      expansionId: 3,
      parentId: 201,
      flags: 1,
      uiOrder: 6,
      patchIntroduced: 100201,
      itemCount: 3,
    },
    {
      id: 202,
      name: "Tideglass Hide",
      group: "Tideglass Wardrobe",
      groupId: 1,
      classMask: 0x0e08,
      expansionId: 3,
      parentId: 201,
      flags: 1,
      uiOrder: 10,
      patchIntroduced: 100200,
      itemCount: 2,
      // The other faction bought exactly these clothes under another name, so 210 is shown
      // in its place and 202 says which card carries it. 436 of a shipping install's sets
      // are somebody else's wardrobe like this.
      alternates: [
        {
          id: 210,
          name: "Deepglass Hide",
          group: "Deepglass Wardrobe",
          classMask: 0x0e08,
          expansionId: 3,
          patchIntroduced: 100200,
          reason: "faction" as const,
        },
      ],
    },
    // And the other end of that pair, still in the payload — the counts above are about what
    // the game holds — and left out of the grid by the window rather than by the backend.
    {
      id: 210,
      name: "Deepglass Hide",
      group: "Deepglass Wardrobe",
      groupId: 4,
      classMask: 0x0e08,
      expansionId: 3,
      parentId: 0,
      flags: 8,
      uiOrder: 15,
      patchIntroduced: 100200,
      itemCount: 2,
      sameLookAs: 202,
    },
  ],
};

/**
 * And who the items behind each of them say can really wear it — see `wearers.rs`.
 *
 * The three sentences the card can draw, one of each. The plate set and the cloth set are the
 * ordinary case: nobody is locked out beyond the people who cannot wear that armour, and the
 * chip says so rather than repeating the mask. `Tideglass Hide` is the other case — the game
 * files it under the leather mask and its sandals are the Druid's own, so no Rogue can wear the
 * set however much leather it is. And `Duskwoven Shroud` is absent, because its every item sits
 * in a section this install holds no key to: the card falls back to the game's own mask.
 */
export const transmogWearers: E2EMock["transmogWearers"] = {
  readCount: 5,
  wearers: [
    { setId: 201, classMask: 0x0190 },
    { setId: 211, classMask: 0x0190 },
    { setId: 202, classMask: 0x0400 },
    { setId: 210, classMask: 0x0400 },
    { setId: 203, classMask: 0x0023 },
  ],
};

// And what those sets are made of, which the window asks for a set at a time. The item
// ids, slots and the one appearance the game withholds are the backend fixtures' own, so
// a change to the chain the Rust tests hold still shows up here too.
export const transmogItems: E2EMock["transmogItems"] = {
  201: {
    setId: 201,
    readCount: 6,
    withheldCount: 0,
    appearances: [
      {
        modifiedAppearanceId: 71001,
        itemId: 30001,
        name: "Tideglass Crown",
        appearanceId: 80001,
        displayType: 0,
        inventoryType: 1,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900001,
        iconFileDataId: 130001,
        hasModel: true,
      },
      // The set names the same appearance through the same `ItemModifiedAppearance` twice,
      // which the game stores as one row copied. One look, and one item giving it — so the
      // two rows are one row, and it says nothing about there being another item.
      {
        modifiedAppearanceId: 71001,
        itemId: 30001,
        name: "Tideglass Crown",
        appearanceId: 80001,
        displayType: 0,
        inventoryType: 1,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900001,
        iconFileDataId: 130001,
        hasModel: true,
      },
      {
        modifiedAppearanceId: 71002,
        itemId: 30002,
        name: "Tideglass Mantle",
        appearanceId: 80002,
        displayType: 1,
        inventoryType: 3,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900002,
        iconFileDataId: 130002,
        hasModel: true,
      },
      {
        modifiedAppearanceId: 71003,
        itemId: 30003,
        name: "Tideglass Robe",
        appearanceId: 80003,
        displayType: 3,
        inventoryType: 5,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900012,
        iconFileDataId: 130003,
        hasModel: false,
      },
      // And the ordinary shape of a shipping set: two more items giving the robe's look,
      // one of them locked to a class the set itself is not, one of them cheaper. Three
      // items, one row, and the whole reason a row opens.
      {
        modifiedAppearanceId: 71030,
        itemId: 30030,
        name: "Robe of the Tideglass Court",
        appearanceId: 80003,
        displayType: 3,
        inventoryType: 5,
        allowableClass: 0x0010,
        requiredLevel: 60,
        quality: 4,
        displayInfoId: 900012,
        iconFileDataId: 130003,
        hasModel: false,
      },
      {
        modifiedAppearanceId: 71031,
        itemId: 30031,
        name: "Sea-Touched Vestment",
        appearanceId: 80003,
        displayType: 3,
        inventoryType: 5,
        allowableClass: 0xffff,
        requiredLevel: 45,
        quality: 3,
        displayInfoId: 900012,
        iconFileDataId: 130003,
        hasModel: false,
      },
    ],
  },
  202: {
    setId: 202,
    readCount: 2,
    withheldCount: 0,
    appearances: [
      // The Druid's own, which is why the card above says "Druid only" — and, no other item
      // in the game giving the look, the one row of this whole fixture that is a wall.
      {
        modifiedAppearanceId: 71004,
        itemId: 30004,
        name: "Tideglass Sandals",
        appearanceId: 80004,
        displayType: 6,
        inventoryType: 8,
        allowableClass: 0x0400,
        requiredLevel: 0,
        quality: 4,
        displayInfoId: 900004,
        iconFileDataId: 130004,
        hasModel: false,
      },
      {
        modifiedAppearanceId: 71005,
        itemId: 30005,
        name: "Tideglass Gloves",
        appearanceId: 80005,
        displayType: 8,
        inventoryType: 10,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900005,
        iconFileDataId: 130005,
        hasModel: false,
      },
    ],
  },
  // The colour of 201, which holds its own clothes: the whole reason a rail is worth clicking
  // is that picking a variant shows a different set of armour rather than the same one twice.
  211: {
    setId: 211,
    readCount: 1,
    withheldCount: 0,
    appearances: [
      {
        modifiedAppearanceId: 71020,
        itemId: 30020,
        name: "Verdigris Tideglass Robe",
        appearanceId: 80020,
        displayType: 3,
        inventoryType: 5,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900020,
        iconFileDataId: 130003,
        hasModel: false,
      },
    ],
  },
  // The set whose appearances span several slots, which is what the list is grouped by.
  203: {
    setId: 203,
    readCount: 6,
    withheldCount: 0,
    appearances: [
      {
        modifiedAppearanceId: 71006,
        itemId: 30006,
        name: "Emberforge Helm",
        appearanceId: 80006,
        displayType: 0,
        inventoryType: 1,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900001,
        iconFileDataId: 130001,
        hasModel: true,
      },
      {
        modifiedAppearanceId: 71007,
        itemId: 30007,
        name: "Emberforge Pauldrons",
        appearanceId: 80007,
        displayType: 1,
        inventoryType: 3,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900009,
        iconFileDataId: 130002,
        hasModel: true,
      },
      {
        modifiedAppearanceId: 71008,
        itemId: 30008,
        name: "Emberforge Breastplate",
        appearanceId: 80008,
        displayType: 3,
        inventoryType: 5,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900003,
        iconFileDataId: 130003,
        hasModel: false,
      },
      // The Paladin's own, and the reason this set's chip says "Any plate wearer" rather than
      // "Paladin only": something in no set at all sells the same look to anybody, which is
      // what the panel under the head of the list names — see `transmogOpenings`.
      {
        modifiedAppearanceId: 71009,
        itemId: 30009,
        name: "Emberforge Greaves",
        appearanceId: 80009,
        displayType: 5,
        inventoryType: 7,
        allowableClass: 0x0002,
        requiredLevel: 0,
        quality: 4,
        displayInfoId: 900006,
        iconFileDataId: 130006,
        hasModel: false,
      },
      // A weapon, which the game files under a display type that says only "a weapon" —
      // and beside it where the item is worn, which is what says the right hand.
      {
        modifiedAppearanceId: 71010,
        itemId: 30010,
        name: "Emberforge Blade",
        appearanceId: 80010,
        displayType: 11,
        inventoryType: 13,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900007,
        iconFileDataId: 130005,
        hasModel: true,
      },
      // And one whose item the game withholds, so nothing says a hand — or a name. That
      // is the one appearance left that is still shown on its own: a model at the origin
      // would be inside her pelvis, and the shape of the thing is better than nothing.
      {
        modifiedAppearanceId: 71017,
        itemId: 30017,
        name: "",
        appearanceId: 80017,
        displayType: 12,
        inventoryType: 0,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900007,
        iconFileDataId: 130005,
        hasModel: true,
      },
    ],
  },
  // Two appearances, one of which the game encrypts — so the modal has to list something
  // it cannot name rather than come up one row short of the card.
  205: {
    setId: 205,
    readCount: 1,
    withheldCount: 1,
    appearances: [
      {
        modifiedAppearanceId: 71011,
        itemId: 30011,
        name: "",
        appearanceId: 80011,
        displayType: 3,
        inventoryType: 5,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900900,
        iconFileDataId: 130008,
        hasModel: false,
      },
      {
        modifiedAppearanceId: 71012,
        itemId: 0,
        name: "",
        appearanceId: 0,
        displayType: 0,
        inventoryType: 1,
        ...WITHHELD_ITEM,
        displayInfoId: 0,
        iconFileDataId: 0,
        hasModel: false,
      },
    ],
  },
};

/**
 * And how anybody gets the looks those sets lock — see `openings.rs` and `openings.ts`.
 *
 * Keyed by set and asked for only where a set's own rows lock somebody out, which in this
 * fixture is two of them and both answers a reader could act on:
 *
 * - `Emberforge Plate` locks its legs to the Paladin, and `Greaves of the Wanderer` — an item
 *   belonging to no set at all, which is where 87% of these live — sells the same look to
 *   everybody. That is the green row, and nothing inside the set could ever have found it.
 * - `Tideglass Hide` locks its sandals to the Druid and nothing in the game sells them around.
 *   That is the red row, and it is the whole reason the panel is drawn rather than a chip.
 *
 * A look the set already sells openly is in `openings` too — the backend answers per look and
 * decides nothing — and the window draws no row for it, having stopped nobody.
 *
 * The level on `Greaves of the Wanderer` is this file's own rather than the backend fixture's,
 * which asks for none: what a row says about the item it points at is drawn only where the game
 * asks for something, and a fixture of all zeroes would never draw it.
 */
export const transmogOpenings: E2EMock["transmogOpenings"] = {
  203: {
    setId: 203,
    readCount: 4,
    withheldCount: 0,
    blocked: [],
    openings: [
      { appearanceId: 80006, itemId: 30006, name: "Emberforge Helm", requiredLevel: 0, quality: 4 },
      {
        appearanceId: 80007,
        itemId: 30007,
        name: "Emberforge Pauldrons",
        requiredLevel: 0,
        quality: 4,
      },
      {
        appearanceId: 80008,
        itemId: 30008,
        name: "Emberforge Breastplate",
        requiredLevel: 0,
        quality: 5,
      },
      {
        appearanceId: 80009,
        itemId: 30025,
        name: "Greaves of the Wanderer",
        requiredLevel: 30,
        quality: 3,
      },
    ],
  },
  202: {
    setId: 202,
    readCount: 1,
    withheldCount: 0,
    blocked: [80004],
    openings: [
      {
        appearanceId: 80005,
        itemId: 30005,
        name: "Tideglass Gloves",
        requiredLevel: 0,
        quality: 4,
      },
    ],
  },
};

// The other half of the browser: every look the game holds for one kind of place, keyed by
// the display types the window asks for. Two answers, because that is all the window ever
// asks for — one armour slot, and everything held in a hand at once.
//
// The looks are the backend fixtures' own, with one addition that is the whole point of
// browsing this way: the Coif of the Drowned Star belongs to no set at all, so nothing in
// the sets beside this could ever reach it.
export const wardrobe: E2EMock["wardrobe"] = {
  "0": {
    displayTypes: [0],
    readCount: 3,
    // One head this install can reach no item of, which is a look it can say nothing
    // whatever about rather than one it can half-describe.
    withheldCount: 1,
    appearances: [
      // A head out of the game and out of no set. It is first because the list is sorted
      // by name, which is how a wardrobe of five thousand is scrolled at all.
      {
        appearanceId: 80040,
        itemId: 30040,
        name: "Coif of the Drowned Star",
        displayType: 0,
        inventoryType: 1,
        classId: 4,
        subclassId: 1,
        allowableClass: 0xffff,
        requiredLevel: 30,
        quality: 3,
        displayInfoId: 900040,
        iconFileDataId: 130002,
        hasModel: true,
        itemCount: 1,
        liftsRestriction: false,
      },
      // The helm set 203 also holds, which is what says the two halves of the view are
      // dressing one character: worn from either, it is the same look on the same head.
      {
        appearanceId: 80006,
        itemId: 30006,
        name: "Emberforge Helm",
        displayType: 0,
        inventoryType: 1,
        classId: 4,
        subclassId: 4,
        allowableClass: 0xffff,
        requiredLevel: 0,
        quality: 4,
        displayInfoId: 900001,
        iconFileDataId: 130001,
        hasModel: true,
        // Three items sell it and one of them is locked to a class the other two are not,
        // which is the one fact about a look no amount of scrolling would show.
        itemCount: 3,
        liftsRestriction: true,
      },
      {
        appearanceId: 80001,
        itemId: 30001,
        name: "Tideglass Crown",
        displayType: 0,
        inventoryType: 1,
        classId: 4,
        subclassId: 1,
        allowableClass: 0x0190,
        requiredLevel: 0,
        quality: 4,
        displayInfoId: 900002,
        iconFileDataId: 130001,
        hasModel: true,
        itemCount: 1,
        liftsRestriction: false,
      },
    ],
  },
  // Everything held in a hand, in one answer — which is what lets the picker offer staves
  // and daggers as neighbours without going back to the game for each.
  "11,12,13,14,15": {
    displayTypes: [11, 12, 13, 14, 15],
    readCount: 4,
    withheldCount: 0,
    appearances: [
      {
        appearanceId: 80010,
        itemId: 30010,
        name: "Emberforge Blade",
        displayType: 11,
        inventoryType: 13,
        classId: 2,
        subclassId: 7,
        allowableClass: 0xffff,
        requiredLevel: 0,
        quality: 5,
        displayInfoId: 900007,
        iconFileDataId: 130005,
        hasModel: true,
        itemCount: 1,
        liftsRestriction: false,
      },
      // A shield, which the game files as armour rather than as a weapon — so a picker
      // reading the display type alone would have put it among the swords.
      {
        appearanceId: 80015,
        itemId: 30015,
        name: "Emberforge Aegis",
        displayType: 13,
        inventoryType: 14,
        classId: 4,
        subclassId: 6,
        allowableClass: 0xffff,
        requiredLevel: 0,
        quality: 5,
        displayInfoId: 900015,
        iconFileDataId: 130005,
        hasModel: true,
        itemCount: 1,
        liftsRestriction: false,
      },
      // And two the display type cannot tell apart at all: a staff and a two-handed sword
      // are both filed under 11, and only the item's own subclass separates them.
      {
        appearanceId: 80014,
        itemId: 30014,
        name: "Emberforge Greatsword",
        displayType: 11,
        inventoryType: 17,
        classId: 2,
        subclassId: 8,
        allowableClass: 0xffff,
        requiredLevel: 0,
        quality: 5,
        displayInfoId: 900014,
        iconFileDataId: 130005,
        hasModel: true,
        itemCount: 1,
        liftsRestriction: false,
      },
      {
        appearanceId: 80041,
        itemId: 30041,
        name: "Staff of the Quiet Tide",
        displayType: 11,
        inventoryType: 17,
        classId: 2,
        subclassId: 10,
        allowableClass: 0xffff,
        requiredLevel: 45,
        quality: 4,
        displayInfoId: 900014,
        iconFileDataId: 130005,
        hasModel: true,
        itemCount: 2,
        liftsRestriction: false,
      },
    ],
  },
  // A page's worth of chestpieces, which is the one kind here that exists to be counted
  // rather than read. Twenty distinct looks is what the gallery draws at a time and what
  // `budget.rs` holds the backend to, and it is the number the browser half has to survive:
  // a window that made a graphics context per row would get about sixteen of them and then
  // start losing the ones it made first.
  "3": {
    displayTypes: [3],
    readCount: GALLERY_LOOKS.length,
    withheldCount: 0,
    appearances: GALLERY_LOOKS,
  },
};

// What this reader has already said about the game's wardrobe with their own hands.
//
// Deliberately not empty, and deliberately not much: one starred set and one tagged look are
// what a browser opening on an install that has been used for a while looks like, and they
// are what makes "the star survived being written" a different assertion from "the star is
// drawn at all". Everything else the suite needs it writes itself, through the same buttons
// a player would — see `bridge.ts`, where the mock keeps them the way the two tables do.
export const transmogMarks: E2EMock["transmogMarks"] = {
  marks: [
    { kind: "set", id: 205, favourite: true, tags: [] },
    { kind: "appearance", id: 80040, favourite: false, tags: [{ key: "wishlist", value: null }] },
  ],
};

// And the sets they put together themselves, which start at none — deliberately, where the
// marks above start at two. A saved set is made by the page under test and by nothing else,
// so a fixture holding one would be the one thing on this screen that never had to survive
// being written. The empty state is worth opening on for its own sake as well.
export const customSets: E2EMock["customSets"] = { sets: [] };

// And the ones the player saved in the *game*, which start at two, where the reader's own
// start at none — and the difference is the point. A saved set is made by the page under
// test; an in-game set can only ever arrive from outside it, so a fixture is the only way
// this browser is ever populated at all.
//
// Two characters, because the list is grouped by character and one of them would never show
// that. They are the two the dashboard is a history of, so this is one account throughout —
// which is what lets the characters view draw somebody in clothes they actually saved.
// "Brin-Hearth" has been played with the addon on and saves nothing in game, which is the
// sentence the empty grouping has to be able to say: read, and found none.
export const inGameSets: E2EMock["inGameSets"] = {
  characters: [
    {
      character: "Aster-Vale",
      sets: [
        {
          id: 4,
          name: "Tideglass",
          icon: 130001,
          observedAt: 1_769_000_000,
          slots: [
            { slot: 0, appearanceId: 71001 },
            { slot: 1, appearanceId: 71002 },
          ],
        },
        // Named nothing by the client, which its own API is documented as sometimes doing,
        // and holding nothing — which is a set the player made and has not filled yet.
        { id: 5, name: "", icon: null, observedAt: null, slots: [] },
      ],
    },
    { character: "Brin-Hearth", sets: [] },
  ],
};

// What one of those turns out to be, keyed by the appearance ids the window asks with. The
// set holding nothing asks with nothing, which is the empty key — and the backend's real
// answer to that is an empty list rather than an error.
export const inGameSetAppearances: E2EMock["inGameSetAppearances"] = {
  "71001,71002": {
    readCount: 2,
    withheldCount: 0,
    appearances: [
      {
        modifiedAppearanceId: 71001,
        itemId: 30001,
        name: "Tideglass Crown",
        appearanceId: 80001,
        displayType: 0,
        inventoryType: 1,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900001,
        iconFileDataId: 130001,
        hasModel: true,
      },
      {
        modifiedAppearanceId: 71002,
        itemId: 30002,
        name: "Tideglass Mantle",
        appearanceId: 80002,
        displayType: 1,
        inventoryType: 3,
        ...ANY_CLASS_ITEM,
        displayInfoId: 900002,
        iconFileDataId: 130002,
        hasModel: true,
      },
    ],
  },
};

// And the outfits sent the other way, which start at none for the reason the reader's own
// sets do: a request is made by the page under test and by nothing else, so a fixture
// holding one would be the one thing on this screen that never had to survive being sent.
export const setRequests: E2EMock["setRequests"] = [];

// The body every set detail falls back to when nothing is worn.
export const characterModel: E2EMock["characterModel"] = fixtureModel("character.glb");

// And who that body is: what the game's own character creation screen asks about her, and
// what has been answered. The names are the fixtures' own — most of the game's real swatches
// have none at all, which is the case worth having in front of the window, so the skin tones
// here have none either.
//
// A shipping install offers fifty-one bodies here rather than two. Two is what this file
// holds because the picker is a `<select>` and the only thing about it worth driving from
// outside is that changing it replaces the form underneath, which one other body proves and
// fifty do not.
//
// The two characters are the two halves of what the addon can read: Aster has been to a barber
// and so arrives with answers, and Brin has not and arrives as a body and nothing else — which is
// the ordinary case and the one worth having in front of the window. They are the other body
// between them, so picking one is a change the form underneath has to survive.
export const characterLook: E2EMock["characterLook"] = {
  bodies: [
    { id: 1, name: "Human Male" },
    { id: 2, name: "Human Female" },
  ],
  body: 2,
  questions: CHARACTER_QUESTIONS[2]!,
  picked: [],
  characters: [
    { character: "Aster-Vale", body: 2, picked: [{ question: 16, swatch: 133 }] },
    { character: "Brin-Ravencrest", body: 1, picked: [] },
  ],
};

export const characterQuestions: E2EMock["characterQuestions"] = CHARACTER_QUESTIONS;

// The bodies, keyed by the outfit each is wearing: every piece's display id, ascending and
// comma joined, which is `wornSetKey`. Keying by the whole outfit rather than by a piece of
// it is the point — it is what lets a step below say which outfit the window actually asked
// the backend for, and taking a piece off is exactly a different key.
//
// `worn-helm.glb` is the one with a second node in it — the body, and a helm above it on a
// translation, which is the shape three.js had never been handed before; `robe.glb` is one
// node, a body with armour painted into its atlas.
export const wornSets: E2EMock["wornSets"] = {
  // One piece: the robe out of set 201, which is the slot with no geometry of its own and
  // the whole reason the character is there at all.
  "900012": fixtureModel("robe.glb"),
  // And that robe with a helm out of another set on top of it, which is the picture the
  // whole view was rebuilt for: two sets, one body. 900001 is the helm both sets name.
  "900001,900012": fixtureModel("worn-helm.glb"),
  // Set 203 worn whole: a helm, a pair of pauldrons, a breastplate, greaves and a blade,
  // over the robe already on her. Its sixth row is an item the game withholds, so nothing
  // says a hand and it is not on her — and the breastplate takes the robe's chest.
  "900001,900003,900006,900007,900009": fixtureModel("worn-helm.glb"),
  // The same with the helm taken off again.
  "900003,900006,900007,900009": fixtureModel("worn-helm.glb"),
  // And the three the shoulders are swapped over: a mantle out of one set on top of the
  // helm and robe, then a pair of pauldrons out of the other taking their place, then the
  // pauldrons off again.
  "900001,900002,900012": fixtureModel("worn-helm.glb"),
  "900001,900009,900012": fixtureModel("worn-helm.glb"),
  // The crown and the mantle of "Tideglass", which is the one set anybody saved in game and
  // so the clothes the characters view draws its portrait in.
  "900001,900002": fixtureModel("worn-helm.glb"),
  // Set 202 worn whole — sandals and gloves, which is all it holds. It is here because the
  // grid can be drawn as characters now, and every card of it asks for the set it is of.
  "900004,900005": fixtureModel("robe.glb"),
  // And the two the other half of the browser assembles: a head that belongs to no set at
  // all, and that head with a staff — which is a look no card in the grid could reach.
  "900040": fixtureModel("worn-helm.glb"),
  "900014,900040": fixtureModel("worn-helm.glb"),
  // One outfit is missing on purpose and answers `null`: set 205's one wearable row names a
  // display the game keeps encrypted, so this install has nothing to put on her for it.
  //
  // And the page of chestpieces the gallery is measured on. A gallery row is an outfit of
  // one, so each of them is keyed by its own display id and nothing else — the same
  // `wornSetKey` a whole outfit gets, with one piece in it.
  ...Object.fromEntries(
    GALLERY_LOOKS.map((look) => [String(look.displayInfoId), fixtureModel("robe.glb")]),
  ),
};

/**
 * Whose body an outfit was asked to be drawn on, in the order asked.
 *
 * State rather than a fixture, and the only thing a test can see of that question: the mock
 * holds one picture of a body and has no game to redraw it from, so what is checkable is that
 * the character view asked on behalf of the character whose page it is rather than for whoever
 * the transmog screen happens to be set to.
 */
export const wornSetsAskedFor: E2EMock["wornSetsAskedFor"] = [];
