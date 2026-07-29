/**
 * What to say when the history has a hole in it.
 *
 * The addon's whole record of a session lives in memory until the client serialises it at
 * logout, so a crash loses the evening — and the SavedVariables file left behind still holds
 * the *previous* one, which is why nothing about the loss shows up in the timeline. The
 * backend catches it by holding the client's combat log, which is written as it goes, against
 * the newest segment on record; `gap.rs` is the rule and this is only the wording.
 *
 * Three of the four answers say nothing. A window that reported "no gap found" every time
 * somebody opened it would teach people to stop reading the one time it mattered, and
 * "nothing to compare" is not a reassurance and must never be drawn as one.
 */

import { ago, duration } from "./format";
import type { SessionGap } from "./types";

/**
 * The line to draw above the history, or `null` when there is nothing to say.
 *
 * @param now Epoch seconds, injected so the tests can pin what "yesterday" means.
 */
export function gapSentence(gap: SessionGap | null, now?: number): string | null {
  if (!gap || gap.kind !== "missing") return null;
  const lost = duration(gap.gap.playedTo - gap.gap.recordedTo);
  return `Chronie is missing up to ${lost} of play. The game was still writing its combat ` +
    `log ${ago(gap.gap.playedTo, now)}, but the last session it saved ended ` +
    `${ago(gap.gap.recordedTo, now)} — so a session ended without the game writing it out, ` +
    "which is what a crash or a force-quit does.";
}

/**
 * The evidence behind that sentence, so a reader can go and check rather than take it on
 * trust. Empty whenever [`gapSentence`] is silent.
 */
export function gapEvidence(gap: SessionGap | null): string[] {
  if (!gap || gap.kind !== "missing") return [];
  return [
    `The newest combat log is ${gap.gap.log}, in the game's Logs folder.`,
    "Nothing recovers those segments — the game never wrote them anywhere. " +
      "What is on screen is everything Chronie has.",
  ];
}
