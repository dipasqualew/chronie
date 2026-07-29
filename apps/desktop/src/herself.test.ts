import { describe, expect, it } from "vitest";

import { answerOf, lookKey, shownAs, swatchLabel, withAnswer, withCharacter } from "./herself";
import type { CharacterLookPayload, CharacterQuestion, PlayedCharacter } from "./types";

/** A question whose swatches are named, which is what the game does for hairstyles. */
const HAIR: CharacterQuestion = {
  id: 16,
  name: "Hair Style",
  swatches: [
    { id: 132, name: "Loose" },
    { id: 133, name: "Braided" },
  ],
};

/** And one whose are not, which is what it does for every skin tone and most hair colours. */
const SKIN: CharacterQuestion = {
  id: 14,
  name: "Skin Color",
  swatches: [
    { id: 85, name: "" },
    { id: 86, name: "" },
    { id: 87, name: "" },
  ],
};

/** The two bodies, as the backend offers them, with hers the one being drawn. */
const ASKED: CharacterLookPayload = {
  bodies: [
    { id: 1, name: "Human Male" },
    { id: 2, name: "Human Female" },
  ],
  body: 2,
  questions: [HAIR, SKIN],
  picked: [],
  characters: [],
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
    expect(
      answerOf(HAIR, [
        { question: 14, swatch: 86 },
        { question: 16, swatch: 133 },
      ]),
    ).toBe(133);
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
      picked: [
        { question: 11, swatch: 48 },
        { question: 14, swatch: 87 },
      ],
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
    expect(lookKey(2, [{ question: 16, swatch: 132 }])).not.toBe(
      lookKey(2, [{ question: 16, swatch: 133 }]),
    );
  });

  // And when the body does, which is the coarser half of the same statement: every picture in
  // the window is of one body or the other, and none of them survives the switch.
  it("changes when the body does", () => {
    expect(lookKey(1, [])).not.toBe(lookKey(2, []));
  });

  it("is the same person whichever order the answers arrive in", () => {
    const one = [
      { question: 16, swatch: 133 },
      { question: 14, swatch: 86 },
    ];
    const other = [
      { question: 14, swatch: 86 },
      { question: 16, swatch: 133 },
    ];
    expect(lookKey(2, one)).toBe(lookKey(2, other));
  });

  it("leaves the list it was given alone", () => {
    const picked = [
      { question: 16, swatch: 133 },
      { question: 14, swatch: 86 },
    ];
    lookKey(2, picked);
    expect(picked[0]).toEqual({ question: 16, swatch: 133 });
  });
});

describe("becoming somebody the reader plays", () => {
  /** Somebody who has been to a barber, so the addon could read what she is made of. */
  const ASTER: PlayedCharacter = {
    character: "Aster-Vale",
    body: 2,
    picked: [
      { question: 16, swatch: 133 },
      { question: 14, swatch: 87 },
    ],
  };

  /** And somebody who has not, which is most of a roster: the right body, and nothing else the
   * game would say. */
  const BRIN: PlayedCharacter = { character: "Brin-Ravencrest", body: 1, picked: [] };

  it("puts on every answer the character carries", () => {
    expect(withCharacter(ASKED, ASTER)).toEqual([
      { question: 16, swatch: 133 },
      { question: 14, swatch: 87 },
    ]);
  });

  // What picking somebody off the list means. A reader who had been arranging this body by hand
  // and then asked for their warrior is asking to look like their warrior.
  it("overrules an answer the reader had already given about that body", () => {
    const answered: CharacterLookPayload = { ...ASKED, picked: [{ question: 16, swatch: 132 }] };

    expect(withCharacter(answered, ASTER)).toEqual([
      { question: 16, swatch: 133 },
      { question: 14, swatch: 87 },
    ]);
  });

  // And the rule the whole settings file rests on: one file holds every body's answers, and
  // becoming somebody on one body must not forget what was arranged on another.
  it("keeps the answers about every other body untouched", () => {
    const both: CharacterLookPayload = {
      ...ASKED,
      picked: [
        { question: 11, swatch: 48 },
        { question: 16, swatch: 132 },
      ],
    };

    expect(withCharacter(both, ASTER)).toEqual([
      { question: 16, swatch: 133 },
      { question: 14, swatch: 87 },
      { question: 11, swatch: 48 },
    ]);
  });

  // The ordinary case, and the one that looks like it does nothing: the client only says what a
  // character is made of at a barber's, so most of a roster is a body and no answers. What
  // changes for them is the body, which the caller sends alongside this.
  it("leaves the answers alone for a character the game would say nothing about", () => {
    const answered: CharacterLookPayload = { ...ASKED, picked: [{ question: 11, swatch: 48 }] };

    expect(withCharacter(answered, BRIN)).toEqual([{ question: 11, swatch: 48 }]);
  });
});

describe("which of them the form is showing", () => {
  const ASTER: PlayedCharacter = {
    character: "Aster-Vale",
    body: 2,
    picked: [{ question: 16, swatch: 133 }],
  };
  const BRIN: PlayedCharacter = { character: "Brin-Ravencrest", body: 1, picked: [] };
  const ROSTER = [ASTER, BRIN];

  it("names the character whose body and answers are the ones in force", () => {
    expect(shownAs(2, [{ question: 16, swatch: 133 }], ROSTER)).toBe("Aster-Vale");
  });

  // The settings file also holds answers about every other body the reader has ever touched.
  // Held against a character, nobody would ever match after the first look at a second body.
  it("ignores the answers about bodies the character has nothing to do with", () => {
    const picked = [
      { question: 16, swatch: 133 },
      { question: 11, swatch: 48 },
    ];

    expect(shownAs(2, picked, ROSTER)).toBe("Aster-Vale");
  });

  // Which is what changing one swatch by hand does: she stops being that person, and the
  // control saying so is the whole reason it reads the form rather than remembering a click.
  it("names nobody once an answer of theirs has been changed", () => {
    expect(shownAs(2, [{ question: 16, swatch: 132 }], ROSTER)).toBe("");
  });

  it("names nobody on a body none of them is", () => {
    expect(shownAs(9, [{ question: 16, swatch: 133 }], ROSTER)).toBe("");
  });

  // Somebody the game has said nothing about is their body and the swatches it opens on, so an
  // untouched form on that body is them — which is true, and is what a reader sees after
  // picking them.
  it("names a character the game would say nothing about by their body alone", () => {
    expect(shownAs(1, [], ROSTER)).toBe("Brin-Ravencrest");
  });

  it("names nobody at all when the reader plays nobody this install can draw", () => {
    expect(shownAs(2, [], [])).toBe("");
  });
});
