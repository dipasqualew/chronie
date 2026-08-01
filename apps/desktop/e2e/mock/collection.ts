/**
 * What the account holds, and what the game has to hold it against.
 *
 * The two halves the Collection view is drawn from, and they are deliberately not the same
 * shape: the census is Chronie's own database, so it names ids and a localised name and nothing
 * else, and the catalogue is the game's tables, so it carries the words, the tree and the
 * points. Everything on that screen is the subtraction between them.
 *
 * The census here is a *finished* walk of the achievements and an *unfinished* walk of the
 * mounts, on purpose. That is the one distinction the whole feature turns on — a walk that did
 * not reach the end licenses no subtraction — and a fixture with two finished walks in it could
 * not tell the two apart.
 */

import type { E2EMock } from "../../src/types";

import { EVENING } from "./clock";

/** The character that did the walking, and the alt it attributes half the history to. */
export const WALKER = "Aster-Vale";
export const ALT = "Brin-Hearth";

/** The category the missing achievements are ranked inside, which is the one the spec opens. */
export const DEEP_CATEGORY = "Chronicles";

/**
 * The achievement nobody has earned that is worth the most in that category.
 *
 * It is deliberately not first alphabetically and not first by id: what puts it at the top of
 * the list is its worth, which is the ordering the view claims.
 */
export const RICHEST_MISSING = "Wardens of the Tideglass";

export const accountCensus: E2EMock["accountCensus"] = {
  readings: [
    {
      domain: "achievements",
      complete: true,
      revision: 4,
      held: 3,
      // The client's own counter agreeing with what was written down, which is the steady
      // state: nothing is out of date and no walk is provoked.
      counted: 3,
      build: "12.0.5.67823",
      walkedBy: WALKER,
      startedAt: EVENING - 120,
      completedAt: EVENING - 60,
      observedAt: EVENING,
    },
    {
      // Cut short by a logout, which is the ordinary way a thirteen-thousand-call walk ends.
      // Everything the view says about mounts has to be hedged because of this one flag.
      domain: "mounts",
      complete: false,
      revision: 2,
      held: 1,
      counted: null,
      build: "12.0.5.67823",
      walkedBy: WALKER,
      startedAt: EVENING - 30,
      completedAt: null,
      observedAt: EVENING,
    },
  ],
  achievements: [
    // Earned years before Chronie existed, by an alt nobody has logged into since — which is
    // the whole argument for the census: no history of gains could ever have produced it.
    {
      id: 2144,
      name: "The Immortal",
      points: 25,
      earnedOn: "2009-03-22",
      earnedBy: ALT,
    },
    {
      id: 4842,
      name: "Herald of the Titans",
      points: 25,
      earnedOn: "2011-08-04",
      earnedBy: WALKER,
    },
    // A year later, so the timeline has a hole in the middle that has to be drawn as a hole.
    {
      id: 101,
      name: "Into the Light",
      points: 10,
      earnedOn: "2013-01-09",
      earnedBy: WALKER,
    },
  ],
  mounts: [{ id: 6, name: "Brown Horse", favourite: true, hidden: false }],
};

export const collectionCatalogue: E2EMock["collectionCatalogue"] = {
  achievements: [
    {
      id: 2144,
      title: "The Immortal",
      description: "Clear the raid without a death.",
      category: ["Dungeons & Raids", "Lich King Raid"],
      points: 25,
      iconFileDataId: 250010,
      faction: -1,
    },
    {
      id: 4842,
      title: "Herald of the Titans",
      description: "Defeat Algalon at level 80.",
      category: ["Dungeons & Raids", "Lich King Raid"],
      points: 25,
      iconFileDataId: 250011,
      faction: -1,
    },
    {
      id: 101,
      title: "Into the Light",
      description: "Reach the lighthouse.",
      category: [DEEP_CATEGORY, "Tideglass Deeps"],
      points: 10,
      iconFileDataId: 250001,
      faction: -1,
    },
    // The three nobody has. Worth 25, 10 and 0, and listed here in none of those orders, so
    // that the ranking the view claims is a thing the fixture could disprove.
    {
      id: 102,
      title: "Deeper into the Light",
      description: "Reach the lighthouse without being seen.",
      category: [DEEP_CATEGORY, "Tideglass Deeps"],
      points: 10,
      iconFileDataId: 250002,
      faction: -1,
    },
    {
      // Worth nothing at all, which half the real table is: a feat of strength. Ranking by
      // points is what keeps these out of the way of the things worth doing.
      id: 107,
      title: "The Long Road",
      description: "Walk from one end of it to the other.",
      category: [DEEP_CATEGORY, "Feats of Strength"],
      points: 0,
      iconFileDataId: 250007,
      faction: -1,
    },
    {
      id: 113,
      title: RICHEST_MISSING,
      description: "Earn the trust of the wardens.",
      category: [DEEP_CATEGORY, "Tideglass Deeps"],
      points: 25,
      iconFileDataId: 250013,
      faction: -1,
    },
  ],
  mounts: [
    { id: 6, name: "Brown Horse", source: "Vendor: Unger Statforth. Zone: Wetlands. Cost: 1" },
    {
      id: 1601,
      name: "Tideglass Drake",
      source: "Drop: The Tidewarden. Zone: Tideglass Deeps",
    },
    // Eleven rows of the real table say nothing about where the mount comes from, and they are
    // the ones the game offers no way of getting.
    { id: 1602, name: "Unbroken Skystrider", source: "" },
  ],
  // Rows the game keeps encrypted, which no total can account for — and which the view is
  // obliged to say out loud rather than quietly subtract.
  withheldAchievements: 2,
  withheldMounts: 1,
};

/**
 * The walks somebody has asked the game to take, and there have been none.
 *
 * Empty on purpose, because the state the affordance exists for is the one nobody has used yet:
 * the button is offered, its promise is drawn, and there is no history above it. A scenario that
 * presses it moves the fixture to the state after — see `e2eDesktop.ts`, which records the ask
 * exactly as the backend would, unanswered, because that is what a real one is until the player
 * has actually logged in.
 */
export const censusRequests: E2EMock["censusRequests"] = [];
