import { describe, expect, it } from "vitest";

import { answerOf, lookKey, swatchLabel, withAnswer } from "./herself";
import type { CharacterLookPayload, CharacterQuestion } from "./types";

/** A question whose swatches are named, which is what the game does for hairstyles. */
const HAIR: CharacterQuestion = {
  id: 16,
  name: "Hair Style",
  swatches: [{ id: 132, name: "Loose" }, { id: 133, name: "Braided" }],
};

/** And one whose are not, which is what it does for every skin tone and most hair colours. */
const SKIN: CharacterQuestion = {
  id: 14,
  name: "Skin Color",
  swatches: [{ id: 85, name: "" }, { id: 86, name: "" }, { id: 87, name: "" }],
};

/** The two bodies, as the backend offers them, with hers the one being drawn. */
const ASKED: CharacterLookPayload = {
  bodies: [{ id: 1, name: "Human Male" }, { id: 2, name: "Human Female" }],
  body: 2,
  questions: [HAIR, SKIN],
  picked: [],
};

describe("which swatch is on her", () => {
  // The one thing this has to agree with the backend about. A question nobody has answered is
  // not an empty select: the body takes the first swatch of it, which is what every character
  // in this app was before there was anywhere to say otherwise.
  it("opens on the first swatch of a question nobody has answered", () => {
    expect(answerOf(HAIR, [])).toBe(132);
    expect(answerOf(SKIN, [{ question: 16, swatch: 133 }])).toBe(85);
  });

  it("takes the answer where there is one", () => {
    expect(answerOf(HAIR, [{ question: 14, swatch: 86 }, { question: 16, swatch: 133 }]))
      .toBe(133);
  });

  // A settings file older than the install it is being applied to. `chosen_by` ignores such an
  // answer and draws the swatch the game opens on, so a select that showed it would be showing
  // the reader something the body is demonstrably not drawn from.
  it("ignores an answer naming a swatch this question has not got", () => {
    expect(answerOf(HAIR, [{ question: 16, swatch: 40404 }])).toBe(132);
    // Including one that belongs to another question, which is the same staleness and the one
    // the game's own tables make easy: every playable body's swatches are in one table.
    expect(answerOf(HAIR, [{ question: 16, swatch: 86 }])).toBe(132);
  });

  it("answers nothing for a question with no swatches at all", () => {
    expect(answerOf({ id: 9, name: "Nothing", swatches: [] }, [])).toBe(0);
  });
});

describe("what a swatch is called", () => {
  it("uses the name the game gives it", () => {
    expect(swatchLabel(HAIR, 133)).toBe("Braided");
  });

  // Most of them have none — 45 face swatches and 23 skin tones on a shipping build, not one of
  // them named — so the number is what a reader picks by. It is the place in the game's own
  // order, one-based, which is where the square sits on the character creation screen.
  it("numbers the swatches the game does not name", () => {
    expect(swatchLabel(SKIN, 85)).toBe("Swatch 1");
    expect(swatchLabel(SKIN, 87)).toBe("Swatch 3");
  });

  it("says nothing about a swatch that is not one of the question's", () => {
    expect(swatchLabel(SKIN, 133)).toBe("");
  });
});

describe("answering a question", () => {
  // Every question, not the one that changed: that is what the settings file holds, and a
  // backend merging two ideas of who she is would have them drift the moment a build moved a
  // swatch out from under one of them.
  it("states every question, with the one just answered changed", () => {
    expect(withAnswer(ASKED, 16, 133)).toEqual([
      { question: 16, swatch: 133 },
      { question: 14, swatch: 85 },
    ]);
  });

  // The other body's answers ride along untouched. One settings file holds every body's, and
  // this form cannot see the questions of the body it is not drawing — so stating only what it
  // knows would forget his hair every time somebody switched to hers.
  it("keeps the answers about the body it is not showing", () => {
    const both: CharacterLookPayload = {
      ...ASKED,
      picked: [{ question: 11, swatch: 48 }, { question: 14, swatch: 87 }],
    };
    expect(withAnswer(both, 16, 133)).toEqual([
      { question: 16, swatch: 133 },
      { question: 14, swatch: 87 },
      { question: 11, swatch: 48 },
    ]);
  });

  it("keeps what was already answered about the others", () => {
    const answered: CharacterLookPayload = { ...ASKED, picked: [{ question: 14, swatch: 87 }] };
    expect(withAnswer(answered, 16, 133)).toEqual([
      { question: 16, swatch: 133 },
      { question: 14, swatch: 87 },
    ]);
  });
});

describe("her as a cache key", () => {
  // What the panes holding pictures of her key on. It has to change when she does and not
  // otherwise: a key that moved for nothing throws away twenty rendered bodies.
  it("changes when an answer does", () => {
    expect(lookKey(2, [{ question: 16, swatch: 132 }]))
      .not.toBe(lookKey(2, [{ question: 16, swatch: 133 }]));
  });

  // And when the body does, which is the coarser half of the same statement: every picture in
  // the window is of one body or the other, and none of them survives the switch.
  it("changes when the body does", () => {
    expect(lookKey(1, [])).not.toBe(lookKey(2, []));
  });

  it("is the same person whichever order the answers arrive in", () => {
    const one = [{ question: 16, swatch: 133 }, { question: 14, swatch: 86 }];
    const other = [{ question: 14, swatch: 86 }, { question: 16, swatch: 133 }];
    expect(lookKey(2, one)).toBe(lookKey(2, other));
  });

  it("leaves the list it was given alone", () => {
    const picked = [{ question: 16, swatch: 133 }, { question: 14, swatch: 86 }];
    lookKey(2, picked);
    expect(picked[0]).toEqual({ question: 16, swatch: 133 });
  });
});
