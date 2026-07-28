/**
 * Who she is, as a form under the character.
 *
 * Everything else in the transmog view is about what she has *on*. This is the one control over
 * the body under the clothes: the questions the game's own character creation screen asks about
 * a Human Female — her skin, her face, her hair and its colour, her ears, what she is wearing in
 * her ears — each with every swatch the installed game holds for it. `herself.ts` is the rules
 * and `customization.rs` is where they come from.
 *
 * Three decisions worth stating, because each had an obvious alternative:
 *
 * **It is shut until somebody opens it, and reads nothing until then.** The panel walks five of
 * the game's tables, and the overwhelming majority of the time a reader is here to try hats on.
 * Every body drawn above already has this reader's answers applied whether or not this is ever
 * opened, because the backend keeps them and the window does not have to remember to send them.
 *
 * **Every answer is written through to the settings file as it is picked**, with no Save button
 * over the form. The same rule the marks and the capture settings follow, for the same reason: a
 * choice that changed the picture and was not stored is a lie the reader has no way to catch.
 * What it costs is a round trip per select against a local file, which nobody can see.
 *
 * **A select per question rather than the game's own grid of swatches.** The game draws squares
 * of colour because it has the pictures to draw them with; this has ids and, for most swatches,
 * no name at all. A row of 58 unnamed buttons would be a worse version of what a select already
 * does well, and the character is redrawn on every change anyway — which makes the picture
 * beside the form the preview.
 */

import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { answerOf, NOBODY_ASKED, swatchLabel, withAnswer } from "./herself";
import type { CharacterLookPayload, CharacterPick } from "./types";

export interface HerselfProps {
  /** Asks what she may be and what she is. Called once, the first time this is opened. */
  load: () => Promise<CharacterLookPayload>;
  /** Says who she is from now on, and answers with what was stored. */
  save: (picked: CharacterPick[]) => Promise<CharacterPick[]>;
  /**
   * What the view does once she has changed: throw away every picture of the old her and ask
   * for them again. The panel does no drawing of its own — the character on the stage above it
   * is the preview, and it is somebody else's to redraw.
   */
  onChanged: (picked: CharacterPick[]) => void;
  onError: (error: unknown) => string;
}

export function Herself({ load, save, onChanged, onError }: HerselfProps): ReactNode {
  const [payload, setPayload] = useState<CharacterLookPayload>(NOBODY_ASKED);
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState("");
  // Once, however often it is opened and shut: what the game holds cannot change under a
  // running window, and the answers this side of it are the ones it just wrote.
  const [asked, setAsked] = useState(false);

  const open = useCallback((): void => {
    if (asked) return;
    setAsked(true);
    setNote("Reading what the game says she can be…");
    void load()
      .then((answer) => {
        setPayload(answer);
        setNote("");
      })
      .catch((error: unknown) => {
        setNote("");
        setFailure(onError(error));
      });
  }, [asked, load, onError]);

  const answer = (question: number, swatch: number): void => {
    setFailure("");
    void save(withAnswer(payload, question, swatch))
      .then((picked) => {
        setPayload((was) => ({ ...was, picked }));
        onChanged(picked);
      })
      .catch((error: unknown) => setFailure(onError(error)));
  };

  return (
    <details className="herself" onToggle={(event) => {
      if (event.currentTarget.open) open();
    }}>
      <summary>Who she is</summary>
      {/* A live region, because the answer to opening this is either a form or a sentence and
          the reader is looking at the character rather than at the disclosure they just
          clicked. */}
      {note ? <p className="muted" role="status">{note}</p> : null}
      {failure ? <p className="mark-failure" role="alert">{failure}</p> : null}
      {/* An install this app cannot read the tables of says so once and offers nothing —
          rather than a form of empty selects, which would look like a body nobody can change
          instead of a game nothing could be read from. */}
      {asked && !note && !failure && !payload.questions.length
        ? <p className="muted">The installed game says nothing about how this body is put together.</p>
        : null}
      <div className="herself-form">
        {payload.questions.map((question) => {
          const field = `herself-${question.id}`;
          return (
            <label key={question.id} className="herself-field" htmlFor={field}>
              <span>{question.name || `Question ${question.id}`}</span>
              <select
                id={field} value={answerOf(question, payload.picked)}
                onChange={(event) => answer(question.id, Number(event.target.value))}
              >
                {question.swatches.map((swatch) => (
                  <option key={swatch.id} value={swatch.id}>
                    {swatchLabel(question, swatch.id)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </details>
  );
}
