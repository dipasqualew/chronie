/**
 * The window's whole world, as the browser suite hands it over.
 *
 * One object, because `bridge.ts` reads one object: every command the app can send is answered
 * out of a key of it. Assembled from nine, because it is edited in nine places — a branch
 * teaching the window a new transmog command has no business meeting a branch teaching it a new
 * setting, and a single literal of nine hundred lines is exactly where those two used to meet.
 *
 * The keys are listed here in the order the fixture has always listed them, so this file says
 * what the mock answers and each module beside it says what the answer is.
 */

import type { E2EMock } from "../../src/types";

import { captureImages } from "./captures";
import { dashboard } from "./dashboard";
import {
  achievementDetails,
  bossPortraits,
  currencyIcons,
  factionIcons,
  gameIcons,
  itemAppearances,
  itemDetails,
  placeIcons,
  placeHeroes,
} from "./game";
import { query } from "./query";
import {
  appUpdate,
  chosenPath,
  combatLog,
  installResult,
  logRetention,
  openedUrls,
  release,
  sessionGap,
  settings,
  syncResult,
} from "./settings";
import {
  characterLook,
  characterModel,
  characterQuestions,
  customSets,
  inGameSetAppearances,
  inGameSets,
  setRequests,
  transmog,
  transmogItems,
  transmogOpenings,
  transmogMarks,
  transmogWearers,
  wardrobe,
  wornSets,
  wornSetsAskedFor,
} from "./transmog";
import { wifi } from "./wifi";

export { FULL_SIZE, THUMBNAIL } from "./captures";
export { EVENING, NIGHT_BEFORE } from "./clock";
export { NOTED } from "./dashboard";
export { collapsed } from "./query";
export {
  ANY_CLASS_ITEM,
  CHARACTER_QUESTIONS,
  GALLERY_LOOKS,
  GALLERY_PAGE,
  GALLERY_PATIENCE_MS,
  WITHHELD_ITEM,
} from "./transmog";

// Typed as the real backend's answers, so a fixture that has drifted from what a command
// actually returns fails the type check rather than the assertion three steps later.
//
// The places are invented, the classes are not: a class token is the app's own vocabulary —
// the palette in `ui.tsx` is keyed by it — so a made-up one would draw every character in the
// colourless fallback and hide the very thing the cast is coloured for.
export const mockDesktop: E2EMock = {
  dashboard,
  transmog,
  transmogWearers,
  transmogItems,
  transmogOpenings,
  wardrobe,
  transmogMarks,
  customSets,
  inGameSets,
  inGameSetAppearances,
  setRequests,
  gameIcons,
  currencyIcons,
  placeIcons,
  placeHeroes,
  bossPortraits,
  factionIcons,
  achievementDetails,
  itemAppearances,
  itemDetails,
  captureImages,
  characterModel,
  characterLook,
  characterQuestions,
  wornSets,
  wornSetsAskedFor,
  settings,
  combatLog,
  sessionGap,
  logRetention,
  query,
  chosenPath,
  syncResult,
  installResult,
  appUpdate,
  release,
  openedUrls,
  wifi,
};
