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
 *   one on the stage, the twenty in a wardrobe gallery — was drawn with the body and the answers
 *   as they were, so changing either is what invalidates them. [`lookKey`] is what the panes hold
 *   their caches against, and it changes exactly when she does.
 * - **The other body's answers are not hers.** One settings file holds every body's, because the
 *   question ids are the game's own and no two bodies share one — so a form that sent only the
 *   questions it can see would forget the other body's every time somebody switched.
 *   [`withAnswer`] keeps them.
 */

import type {
  CharacterLookPayload, CharacterPick, CharacterQuestion, PlayedCharacter,
} from "./types";

/** Nobody has been asked anything yet, which is the payload's own empty state. */
export const NOBODY_ASKED: CharacterLookPayload = {
  bodies: [],
  body: 0,
  questions: [],
  picked: [],
  characters: [],
};

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
  const asked = payload.questions.map((question) => question.id);
  // The other body's answers, untouched. They are in the same list and this form cannot see
  // them, which is exactly why it has to carry them rather than state what it knows.
  const elsewhere = payload.picked.filter((answer) => !asked.includes(answer.question));
  return [
    ...payload.questions.map((one) => ({
      question: one.id,
      swatch: one.id === question ? swatch : answerOf(one, payload.picked),
    })),
    ...elsewhere,
  ];
}

/**
 * The answers with one of the reader's own characters put on, ready to be sent.
 *
 * The same shape [`withAnswer`] has and for the same reason — the settings file holds every
 * body's answers and a form that sent only what it can see would forget the rest — but arrived at
 * from the other end. A character's answers are about *their* body, and the questions in them are
 * ids no other body shares, so putting one on is their answers plus everything already stored
 * that they say nothing about.
 *
 * **The character wins where the two overlap**, which is what picking one off the list means: a
 * reader who had already been arranging that body by hand and then asked for their warrior is
 * asking to look like their warrior. Everything they arranged about every *other* body is
 * untouched, so switching back to it still finds it.
 *
 * A character with no answers at all — the ordinary case, since the game only says what somebody
 * is made of at a barber's — leaves the stored answers exactly as they were. What changes for
 * them is the body, which the caller sends alongside this.
 */
export function withCharacter(
  payload: CharacterLookPayload, character: PlayedCharacter,
): CharacterPick[] {
  const theirs = character.picked.map((answer) => answer.question);
  return [
    ...character.picked,
    ...payload.picked.filter((answer) => !theirs.includes(answer.question)),
  ];
}

/**
 * Which of the reader's characters the form is currently showing, or `""` for none of them.
 *
 * So that the shortcut is a control that says something true rather than a button that fires and
 * forgets. It reads as "this is who she is now" and goes back to nothing the moment a swatch is
 * changed by hand, which is exactly what has happened.
 *
 * A character matches when the body is theirs and every answer of theirs is the answer in force.
 * Not the other way round: the settings file also holds answers about every other body the reader
 * has ever touched, and holding those against a character would mean nobody ever matched after
 * the first time somebody looked at a second body.
 *
 * Two characters can therefore match at once — two alts of one race whom nobody has had a haircut
 * on are the same body and the same nothing, and there is no third thing to tell them apart by.
 * The first is named, because a select has to show one and either is true.
 */
export function shownAs(
  body: number, picked: CharacterPick[], characters: PlayedCharacter[],
): string {
  const found = characters.find((character) => character.body === body
    && character.picked.every((theirs) => picked.some(
      (answer) => answer.question === theirs.question && answer.swatch === theirs.swatch,
    )));
  return found?.character ?? "";
}

/**
 * Her, as a string that changes when she does.
 *
 * What the panes that hold pictures of her key their caches on. The body leads, because it is
 * the coarsest thing about her and the one that changes every picture at once; the answers are
 * sorted by question, so two lists of the same answers in different orders are the same person
 * and no picture is thrown away for having been described differently.
 */
export function lookKey(body: number, picked: CharacterPick[]): string {
  const answers = [...picked]
    .sort((left, right) => left.question - right.question)
    .map((answer) => `${answer.question}:${answer.swatch}`)
    .join(",");
  return `${body}|${answers}`;
}
