/**
 * What to say about combat logging: an honest answer about what the game is really doing.
 *
 * None of this promises anything; it reports. The backend has looked at the game's own config
 * and at the files in its `Logs/` folder, and these two state what it found — including the
 * two ways of being not-quite-on that are easy to mistake for working: logging without the
 * advanced flag, which produces a log with no positions in it, and a setting that says yes
 * over a folder nothing has been written to in days.
 *
 * The panel that shows them is `combatLogPanel.tsx`.
 */

import { ago, fileSize } from "./format";
import type { CombatLogStatus } from "./types";

/** Where the box a player has to tick themselves lives, named the way the game names it. */
const NETWORK_OPTIONS = "Advanced Combat Logging, in the game's Options › Network";

/**
 * The one line that says where this install stands.
 *
 * Four states, and the two unhappy ones are kept apart on purpose: `basic` is a box nobody
 * has ticked, `stale` is a log nobody is writing. Telling a player to go tick a box that is
 * already ticked is how a tool teaches people to stop reading it.
 */
export function stateSentence(status: CombatLogStatus, now?: number): string {
  switch (status.state) {
    case "off":
      return status.growing
        ? "Chronie is not asking for combat logging — though this install is writing a " +
            "combat log anyway, which somebody turned on outside Chronie."
        : "Combat logging is off. Nothing is being written and nothing is using disk.";
    case "basic":
      return status.advanced === null || status.advanced === undefined
        ? "Combat logging is on, but Chronie could not read the game's settings, so it " +
            `cannot confirm advanced logging. Check ${NETWORK_OPTIONS}.`
        : "Combat logging is on, but advanced combat logging is off — the log will have no " +
            `positions in it. Tick ${NETWORK_OPTIONS}, then log in again.`;
    case "advanced":
      return "Advanced combat logging is on, and the game is writing to it.";
    case "stale": {
      if (!status.log) {
        return (
          "Advanced combat logging is set up, but this install has no combat log at " +
          "all yet. One appears the next time you log in."
        );
      }
      // A file this machine will not date is a file nothing can be said about the age of.
      // Reckoning from the epoch would put "20659 days ago" on screen, which is worse than
      // admitting the gap.
      const when = status.log.modified
        ? `nothing has been written ${ago(status.log.modified, now)}`
        : "this machine will not say when the log was last written";
      return (
        `Advanced combat logging is set up, but ${when}. Expected while the game is ` +
        "closed; if you have been playing since, the game is not logging."
      );
    }
  }
}

/**
 * The evidence the sentence above was reached from, so a reader can disagree with it.
 *
 * Deliberately concrete — the file, its size, when it was last touched, and which config
 * the CVar was read out of. A status line nobody can check is a status line nobody should
 * believe.
 */
export function evidence(status: CombatLogStatus, now?: number): string[] {
  const lines: string[] = [];
  if (status.log) {
    const when = status.log.modified
      ? `last written ${ago(status.log.modified, now)}`
      : "with no date this machine will report";
    lines.push(`Newest log: ${status.log.name} — ${fileSize(status.log.bytes)}, ${when}.`);
  } else {
    lines.push("No combat log found in the game's Logs folder.");
  }
  if (status.source) {
    const reads = status.advanced ? "on" : "off";
    lines.push(`Advanced logging reads ${reads} in ${status.source}.`);
  } else {
    lines.push("No game config could be read, so the advanced setting is unknown.");
  }
  return lines;
}
