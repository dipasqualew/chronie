/**
 * What the installed game can be asked about the numbers the addon wrote down.
 *
 * Icons, achievements and items are one module because they are one bargain: the addon records
 * an id and the install either has something to say about it or has not. Every table here is
 * deliberately missing an entry something elsewhere in the mock names.
 */

import type { E2EMock } from "../../src/types";

// The pictures those appearances name, decoded — eight-pixel PNGs standing in for the
// textures the backend pulls out of the game's own storage. 130008 is missing on purpose:
// set 205 names it and the install holds no such file, which is the case a row has to
// survive rather than break on. So is the icon the tables give appearance 71012, which is
// no icon at all.
export const gameIcons: E2EMock["gameIcons"] = {
  130001: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mNwaj"
    + "r2Hx9mGBkKAF+FokHepdeGAAAAAElFTkSuQmCC",
  130002: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mM45u"
    + "j0Hx9mGBkKADftkgFGGhUWAAAAAElFTkSuQmCC",
  130003: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mP4z9"
    + "DyHx9mGBkKALdWoIE3ifJxAAAAAElFTkSuQmCC",
  130006: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mNwaj"
    + "r2Hx9mGBkKAF+FokHepdeGAAAAAElFTkSuQmCC",
  // The gloves, which are the one row that both has a picture and cannot be put on the
  // character — so the picture is what the reader is left looking at.
  130005: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mP4z9"
    + "DyHx9mGBkKALdWoIE3ifJxAAAAAElFTkSuQmCC",
  250001: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mM45u"
    + "j0Hx9mGBkKADftkgFGGhUWAAAAAElFTkSuQmCC",
};

// The picture each currency is drawn with, keyed by the currency's own id rather than by the
// file behind it — which is the shape of the real command, because the hop from one to the
// other happens in the backend. The warband's shared pot is deliberately absent: the game names
// a picture for most currencies and not all of them, and a row without one still has to draw.
export const currencyIcons: E2EMock["currencyIcons"] = {
  7: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mM45u"
    + "j0Hx9mGBkKADftkgFGGhUWAAAAAElFTkSuQmCC",
};

// The picture each place is drawn with, keyed by the name the addon filed the segment under —
// which is the shape of the real command, because the tables that draw a dungeon are keyed by
// that same localised name and the hop happens in the backend. Only the scenario has one: the
// game draws a picture for a dungeon, a raid and a delve, and none at all for the open world, so
// the two zone segments beside it are what a row with nothing to show has to look like.
export const placeIcons: E2EMock["placeIcons"] = {
  "Glass Caverns": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklE"
    + "QVR42mM45uj0Hx9mGBkKADftkgFGGhUWAAAAAElFTkSuQmCC",
};

// What the game says about the achievements those segments name. 77 is deliberately absent:
// an install can only describe the achievements it has, and a row still has to draw.
export const achievementDetails: E2EMock["achievementDetails"] = {
  9: {
    id: 9,
    title: "Into the Light",
    description: "Reach the lighthouse at the end of the pier.",
    reward: "Reward: Title & the lamplighter's coat",
    category: ["Chronicles", "Tideglass Deeps"],
    categoryId: 10,
    points: 25,
    iconFileDataId: 250001,
    faction: -1,
  },
};

// What the game says about the items those segments name — the transmog source collected,
// and the two pieces the equipment set swapped. 4200 is deliberately absent: the cloak the
// set gave up is an item this install cannot describe, and the row still has to draw with
// the name the addon caught.
// The look each of those items carries, for the rows a reader can click through to a picture
// of. Only the transmog source has one: it is the only row in the fixture that offers the
// button, and an item with no entry here is what the real backend leaves out of its answer.
export const itemAppearances: E2EMock["itemAppearances"] = {
  101: { appearanceId: 80012, displayInfoId: 900012, displayType: 3, inventoryType: 3 },
};

export const itemDetails: E2EMock["itemDetails"] = {
  // The transmog source, which the addon recorded as a number and nothing else: this is the
  // whole of what the reader ends up seeing about it.
  101: {
    id: 101, name: "Wanderer's Mantle", classId: 4, subclassId: 2, inventoryType: 3,
    quality: 3, requiredLevel: 25, allowableClass: 0xffff, iconFileDataId: 130002,
  },
  // The plate helm the set took on, and the one it replaced. The helm is the only item in
  // the fixture some classes may not wear.
  4101: {
    id: 4101, name: "Deepwater Crown", classId: 4, subclassId: 4, inventoryType: 1,
    quality: 4, requiredLevel: 80, allowableClass: 0b10_0011, iconFileDataId: 130001,
  },
  4100: {
    id: 4100, name: "Tideglass Crown", classId: 4, subclassId: 4, inventoryType: 1,
    quality: 3, requiredLevel: 80, allowableClass: 0b10_0011, iconFileDataId: 130001,
  },
};
