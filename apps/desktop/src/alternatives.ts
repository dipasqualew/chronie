/**
 * What else might do, for a look the game will not let this reader have — the rows of the panel.
 *
 * `openings.ts` draws the exact half of that question: the very same appearance, on an item no
 * class is locked out of. Where there is one, the reader is not locked out of the look at all.
 * Where there is not, the row is red and the honest answer stops being exact — so this is the
 * list of things that are *not that look* and might do instead, and everything about how it is
 * drawn follows from that.
 *
 * **Two kinds of claim, and they must never read as one.** A row out of `shapes.rs` is the same
 * mesh, the same geosets and the same painted sections: it is the same piece of armour in another
 * colour, and there is nothing approximate about it. A row out of `fingerprints.rs` is a
 * thumbnail distance under a threshold the install cut for its own slot — a suggestion, with the
 * number it was ranked by on it. [`AlternativeRow.exact`] is that difference and the panel says
 * it in words rather than by position.
 *
 * **What somebody decided outranks what was measured.** Both stores are thrown away and rebuilt
 * from the game every patch; a person's "yes, that one" is not, and it belongs at the top of the
 * list rather than wherever this month's distances put it. A rejection sinks to the bottom for
 * the same reason — the whole point of storing one is that the same wrong row does not climb back
 * every time the panel is opened.
 */

import { plural } from "./format";
import { kindOfClass } from "./items";
import type { Alternative, AlternativesPayload, LookalikeVerdict } from "./types";

/** Somebody looked at a suggestion and agreed with it. */
export const CONFIRMED = "yes";

/** And somebody looked at one and did not. */
export const REJECTED = "no";

/** One thing offered in place of a look, and what anybody has said about it. */
export interface AlternativeRow {
  appearanceId: number;
  itemId: number;
  /** What names the row: the item's name, or its id where the game gives none. */
  label: string;
  /** Cloth, leather, mail or plate — see [`kindOfClass`] and why it is drawn at all. */
  kind: string;
  /** Where to go for it, in the words the openings table already uses. */
  requirement: string;
  iconFileDataId: number;
  /**
   * Whether this is the geometry's answer, which is an equality, rather than the pictures',
   * which is a ranking. What the panel draws from it is a sentence, not a position.
   */
  exact: boolean;
  /** How alike the two pictures measured, for a ranked row — see [`likeness`]. */
  likeness: string;
  /** [`CONFIRMED`], [`REJECTED`], or nothing where nobody has looked. */
  verdict: string | null;
}

/**
 * How alike two pictures measured, as the one number a reader is given.
 *
 * **Never 100% for two pictures that are not the same picture.** 0.0039 apart is 99.61% alike
 * and rounds to 100, and 100% is the one figure somebody would read as a verdict rather than as
 * a measurement — which is exactly what this half of the feature is not. So the rounding is
 * one-sided: anything short of identical stops at 99.9%.
 */
export function likeness(distance: number): string {
  if (distance <= 0) return "100% alike";
  const alike = Math.min((1 - distance) * 100, 99.9);
  return `${Number(alike.toFixed(1))}% alike`;
}

/** What somebody said about one suggestion, or nothing where nobody has looked at it. */
export function verdictOf(
  said: LookalikeVerdict[],
  appearanceId: number,
  alternativeId: number,
): string | null {
  const found = said.find(
    (one) => one.appearanceId === appearanceId && one.alternativeId === alternativeId,
  );
  return found ? found.verdict : null;
}

/**
 * The rows of the panel: what was measured, ordered by what a person has said about it.
 *
 * Three bands, and the middle one is the measurement's own order — the exact rows first because
 * they are the stronger claim, then the ranked ones nearest first. A confirmation lifts a row out
 * of that order entirely and a rejection drops it below all of it, because those are the two
 * things nobody has to measure again.
 */
export function alternativeRows(
  payload: AlternativesPayload,
  said: LookalikeVerdict[],
): AlternativeRow[] {
  const rows: AlternativeRow[] = [
    ...payload.sameMesh.map((one) => row(one, true, payload.appearanceId, said)),
    ...payload.lookalikes.map((one) => row(one, false, payload.appearanceId, said)),
  ];
  const band = (of: AlternativeRow): number =>
    of.verdict === CONFIRMED ? 0 : of.verdict === REJECTED ? 2 : 1;
  return rows
    .map((one, at) => ({ one, at }))
    .sort((left, right) => band(left.one) - band(right.one) || left.at - right.at)
    .map(({ one }) => one);
}

function row(
  of: Alternative,
  exact: boolean,
  appearanceId: number,
  said: LookalikeVerdict[],
): AlternativeRow {
  return {
    appearanceId: of.appearanceId,
    itemId: of.itemId,
    label: of.name || `Item ${of.itemId}`,
    kind: kindOfClass(of.classId, of.subclassId),
    requirement: of.requiredLevel > 0 ? `Level ${of.requiredLevel}` : "",
    iconFileDataId: of.iconFileDataId,
    exact,
    likeness: exact || of.distance == null ? "" : likeness(of.distance),
    verdict: verdictOf(said, appearanceId, of.appearanceId),
  };
}

/**
 * The one line over the list, which is the answer for a reader who reads nothing else.
 *
 * It has to distinguish four states that all look like an empty list from the outside: the
 * pictures are still being read, the geometry cannot speak for this slot at all, both measures
 * ran and found nothing, and something was found. Only the first of those is a reason to come
 * back later, and a panel that said "nothing looks like this" while it was still reading would
 * be the app reporting its own unfinished work as an answer about the game.
 */
export function alternativesSummary(payload: AlternativesPayload): string {
  const exact = payload.sameMesh.length;
  const ranked = payload.lookalikes.length;
  const waiting = payload.lookalikesReady
    ? ""
    : " · still reading the game's own textures, which takes about a minute once per patch";

  if (exact && ranked) {
    return `${plural(exact, "other colour")} of this same piece of armour, and ${plural(
      ranked,
      "look",
    )} near enough to be worth your eye`;
  }
  if (exact) return `${plural(exact, "other colour")} of this same piece of armour${waiting}`;
  if (ranked) return `${plural(ranked, "look")} near enough to be worth your eye`;
  if (!payload.lookalikesReady) {
    return "Chronie is reading the game's own textures to answer this — about a minute, once per patch";
  }
  // Both measures ran. Which of them had anything to say about the slot at all is the
  // difference between "nothing matched" and "this cannot be answered that way", and a reader
  // deciding whether to keep looking wants the second said out loud.
  return payload.geometryAnswers
    ? "Nothing else in the game is this piece of armour, and nothing looks near enough to offer"
    : "Nothing in the game looks near enough to this one to offer";
}
