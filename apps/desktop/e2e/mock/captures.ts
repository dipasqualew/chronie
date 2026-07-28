/**
 * The screenshots Chronie holds, and the two pictures each of them is made of.
 *
 * Kept away from the segments that name them because the backend keeps them apart too: a tile
 * knows a row id, and asks for the image only once it is on screen.
 */

import type { E2EMock } from "../../src/types";

// Two tiny pictures, so the tile and the thing behind it can be told apart on screen. Real
// PNGs rather than placeholder strings: the browser has to actually decode what the backend
// hands over, and a `data:` URL that only looks like one would pass a test the app fails.
export const THUMBNAIL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElE" +
  "QVR4nGPQqDgBRww4OQBBxhDhzXmo9QAAAABJRU5ErkJggg==";
export const FULL_SIZE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlE" +
  "QVR4nGM4EaWBFTEMpAQAQEQ94cz6peQAAAAASUVORK5CYII=";

// The screenshots Chronie holds, keyed by the row id a tile asks for them by. 13 is absent
// on purpose: it is the marker whose file was never found, which the real backend answers
// nothing for and which has to draw as an explanation rather than as a broken picture.
export const captureImages: E2EMock["captureImages"] = {
  11: { thumbnail: THUMBNAIL, full: FULL_SIZE, byteSize: 3_204_112 },
  12: { thumbnail: THUMBNAIL, full: FULL_SIZE, byteSize: 3_100_000 },
  33: { thumbnail: THUMBNAIL, full: FULL_SIZE, byteSize: 2_411_902 },
};
