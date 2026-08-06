/**
 * The install itself: where the game is, what Chronie is doing to it, and what each button on
 * the settings screens answers with.
 *
 * One module because they are one screen's worth of state. Choosing a folder, syncing, putting
 * the addon in place and updating the app are four answers from the same panel, and the combat
 * log and the sweep that thins it are what the rest of that panel is about.
 */

import type { E2EMock } from "../../src/types";

import { EVENING } from "./clock";

export const settings: E2EMock["settings"] = {
  wowPath: "C:\\Games\\Example MMO\\_retail_",
  lastSync: "2026-07-26T11:58:00Z",
  combatLogging: false,
  // What a fresh install photographs, plus a name this build has no rule for — the state a
  // hand-edited settings file or a newer addon leaves, and the one the panel must not
  // quietly delete the first time somebody ticks anything.
  captureTriggers: ["accountFirstAchievement", "somethingNewer"],
  captureQuality: "balanced",
  keepOriginalScreenshots: false,
  // On, which is what every install starts as and what the panel has to draw before anybody has
  // touched it. It shipped off for a while, and what was wrong then was the walk rather than the
  // switch — a share of every single frame, and the wardrobe re-walked at every loading screen.
  automaticCensus: true,
};

// An install that has never been asked to log: the setting is off, and the game's own
// config happens to have the advanced box ticked already, which is the case that proves
// the panel reports the setting and the install as two separate facts.
export const combatLog: E2EMock["combatLog"] = {
  requested: false,
  advanced: true,
  source: "WTF/Account/EXAMPLE/config-cache.wtf",
  log: null,
  growing: false,
  state: "off",
};

// The ordinary answer, which is the one every test that is not about this gets: the client's
// log and the history agree, so the timeline says nothing about holes and the notice is not in
// the page at all. A test that wants the unhappy shape overwrites this key.
export const sessionGap: E2EMock["sessionGap"] = { kind: "complete" };

// A folder in the state that makes retention worth having and worth being careful with: two
// old logs Chronie has read to the end of, and one older still that it has never read — the
// raid night somebody logged before Chronie was watching, which must survive any sweep and
// has to be on screen saying so.
export const logRetention: E2EMock["logRetention"] = {
  enabled: false,
  days: 7,
  doomed: {
    count: 2,
    bytes: 402_653_184,
    files: [
      {
        name: "WoWCombatLog-071026_201500.txt",
        bytes: 268_435_456,
        modified: EVENING - 30 * 86400,
      },
      {
        name: "WoWCombatLog-071126_193000.txt",
        bytes: 134_217_728,
        modified: EVENING - 29 * 86400,
      },
    ],
  },
  unread: {
    count: 1,
    bytes: 1_073_741_824,
    files: [
      {
        name: "WoWCombatLog-032526_204500.txt",
        bytes: 1_073_741_824,
        modified: EVENING - 120 * 86400,
      },
    ],
  },
  unfinished: { count: 0, bytes: 0, files: [] },
  removed: [],
};

export const chosenPath: E2EMock["chosenPath"] = "D:\\Games\\Example MMO";

export const syncResult: E2EMock["syncResult"] = { segmentCount: 3, added: 1, updated: 1 };

export const installResult: E2EMock["installResult"] = { version: "0.8.0-dev" };

export const appUpdate: E2EMock["appUpdate"] = { updated: false, version: "0.1.0" };

export const release: E2EMock["release"] = {
  channel: "dev",
  commit: "95b5e08d2f1a4c3b6e7d8a9f0b1c2d3e4f5a6b7c",
};

export const openedUrls: E2EMock["openedUrls"] = [];
