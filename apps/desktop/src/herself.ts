/**
 * Who the character is: the rules behind the form that says so.
 *
 * The backend reads what the game's own character creation screen asks about her body and hands
 * over both halves at once — the questions with every swatch of each, and whichever of them
 * this reader has already answered. See `customization.rs`. What is left for this side is
 * small and is entirely about drawing a form over it:
 *
 * - **An unanswered question is not an empty one.** The body takes the first swatch of anything
 *   nobody has chosen for — that is what every character in this app was before there was
 *   anywhere to say otherwise — so a select over a question with no answer has to open on the
 *   first swatch rather than on nothing. [`answerOf`].
 * - **Most swatches have no name.** A skin tone is a square of colour on the game's own screen
 *   and the table's `Name_lang` for it is empty; a hair colour is named fifteen times out of
 *   fifty-eight. Numbering them is this side's job, because inventing a name in the payload
 *   would be inventing it where a later build could contradict it. [`swatchLabel`].
 * - **The bodies already drawn are of somebody else.** Every picture of her in the window — the
 *   one on the stage, the twenty in a wardrobe gallery — was drawn with the answers as they
 *   were, so changing one is what invalidates them. [`lookKey`] is what the panes hold their
 *   caches against, and it changes exactly when she does.
 */

import type { CharacterLookPayload, CharacterPick, CharacterQuestion } from "./types";

/** Nobody has been asked anything yet, which is the payload's own empty state. */
export const NOBODY_ASKED: CharacterLookPayload = { questions: [], picked: [] };

/**
 * Which swatch of a question is on her: the answer if there is one, and the first swatch if not.
 *
 * `0` only for a question with no swatches at all, which the game does not ship and which a
 * select would draw as an empty list either way.
 *
 * An answer naming a swatch this question has not got is ignored here for the same reason
 * `chosen_by` ignores it at the other end: it is a settings file older than the install, and
 * what the reader is shown has to be what the body is actually drawn from.
 */
export function answerOf(question: CharacterQuestion, picked: CharacterPick[]): number {
  const said = picked.find((answer) => answer.question === question.id)?.swatch ?? 0;
  const hers = question.swatches.some((swatch) => swatch.id === said);
  return hers ? said : question.swatches[0]?.id ?? 0;
}

/**
 * What to call one swatch, which is what the game calls it or where it sits.
 *
 * The number is one-based and is its place in the question's own order — the order the
 * character creation screen offers them in — so "Swatch 3" is the third square on that screen
 * and stays the third one as long as the build does.
 */
export function swatchLabel(question: CharacterQuestion, swatchId: number): string {
  const at = question.swatches.findIndex((swatch) => swatch.id === swatchId);
  if (at < 0) return "";
  return question.swatches[at]!.name || `Swatch ${at + 1}`;
}

/**
 * The answers with one question answered differently, ready to be sent.
 *
 * Every question is stated rather than only the one that changed, because that is what the
 * settings file holds and what a form knows: sending only the difference would leave the
 * backend merging two ideas of who she is, and the two would drift the moment a build renamed
 * a swatch out from under one of them.
 */
export function withAnswer(
  payload: CharacterLookPayload, question: number, swatch: number,
): CharacterPick[] {
  return payload.questions.map((asked) => ({
    question: asked.id,
    swatch: asked.id === question ? swatch : answerOf(asked, payload.picked),
  }));
}

/**
 * Her, as a string that changes when she does.
 *
 * What the panes that hold pictures of her key their caches on. Sorted by question, so two
 * lists of the same answers in different orders are the same woman and no picture is thrown
 * away for having been described differently.
 */
export function lookKey(picked: CharacterPick[]): string {
  return [...picked]
    .sort((left, right) => left.question - right.question)
    .map((answer) => `${answer.question}:${answer.swatch}`)
    .join(",");
}
