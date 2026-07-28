/**
 * Who she is, as a form under the character.
 *
 * Everything else in the transmog view is about what she has *on*. This is the one control over
 * the body under the clothes: **which body** — a body of any race a person can be, as `ChrModel`
 * numbers them, which on a shipping install is fifty-one of them — and then the questions the
 * game's own character creation screen asks about that one. Her skin, her face, her hair and its
 * colour, her ears; his beard, his moustache, his sideburns; a Dracthyr's horns. `herself.ts` is
 * the rules and `body.rs` and `customization.rs` are where they come from.
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
 * **The body is the first control and it reloads the rest.** Another body is asked another set
 * of questions entirely — there is no "hair style" that means the same thing on both — so
 * changing it replaces the form under it with what the backend answers for the new one. The
 * answers about the body being left are kept, in the settings file and in the payload, so
 * switching back finds them.
 *
 * **A select per question rather than the game's own grid of swatches.** The game draws squares
 * of colour because it has the pictures to draw them with; this has ids and, for most swatches,
 * no name at all. A row of 58 unnamed buttons would be a worse version of what a select already
 * does well, and the character is redrawn on every change anyway — which makes the picture
 * beside the form the preview.
 *
 * And then the one control that is not the reader inventing somebody: **the people they actually
 * play**, read out of the game by the addon and offered above the body. Picking one is a body and
 * a dozen answers in a single change — "show me this hat on my warrior" instead of twenty selects
 * that approximate her. It sits first because it fills in everything below it, and it is absent
 * entirely on an install the addon has never run on, where there would be nobody to offer.
 */

import "./herselfPanel.css";

import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { answerOf, NOBODY_ASKED, shownAs, swatchLabel, withAnswer, withCharacter } from "./herself";
import type { CharacterChosen, CharacterLookPayload, CharacterPick } from "./types";

export interface HerselfProps {
  /** Asks what she may be and what she is. Called once, the first time this is opened. */
  load: () => Promise<CharacterLookPayload>;
  /** Says who she is from now on — which body, and every answer — and answers with what was
   * stored. The whole of it each time, because a body and its answers are one statement. */
  save: (body: number, picked: CharacterPick[]) => Promise<CharacterChosen>;
  /**
   * What the view does once she has changed: throw away every picture of the old her and ask
   * for them again. The panel does no drawing of its own — the character on the stage above it
   * is the preview, and it is somebody else's to redraw.
   */
  onChanged: (chosen: CharacterChosen) => void;
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
    store(payload.body, withAnswer(payload, question, swatch));
  };

  /**
   * Becomes one of the reader's own characters, which is a body and its answers in one change.
   *
   * The same errand every other control on this panel runs — [`store`] saves and repaints — so a
   * character whose body is not the one on the stage reloads the form under it exactly as picking
   * that body by hand would.
   */
  const become = (named: string): void => {
    const character = payload.characters.find((one) => one.character === named);
    if (!character) return;
    store(character.body, withCharacter(payload, character));
  };

  /**
   * Stores who she is and reports it, then repaints the form from what came back.
   *
   * A body change comes back with the other body's questions, because the backend re-reads them
   * for whichever body is now being drawn — so the form under the picker is replaced rather
   * than reinterpreted, and a swatch id that means one thing on her means nothing on him.
   */
  const store = (body: number, picked: CharacterPick[]): void => {
    setFailure("");
    void save(body, picked)
      .then((chosen) => {
        onChanged(chosen);
        if (chosen.body === payload.body) {
          setPayload((was) => ({ ...was, picked: chosen.picked }));
          return;
        }
        setNote("Reading what the game says that body can be…");
        return load()
          .then((asked) => setPayload(asked))
          .finally(() => setNote(""));
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
        {/* The reader's own people, above the body because picking one fills the body in too.
            Absent where there are none rather than shown empty: an install the addon has never
            run on has nobody to offer, and an empty select would read as a roster of nobody. */}
        {payload.characters.length
          ? (
            <label className="herself-field" htmlFor="herself-character">
              <span>Who you play</span>
              <select
                id="herself-character" value={shownAs(payload.body, payload.picked, payload.characters)}
                onChange={(event) => become(event.target.value)}
              >
                {/* What the select says when she is nobody in particular, which is every reader
                    who has arranged a body by hand and the state this panel opens in. */}
                <option value="">Someone else</option>
                {payload.characters.map((one) => (
                  <option key={one.character} value={one.character}>{one.character}</option>
                ))}
              </select>
            </label>
          )
          : null}
        {/* The body next, because everything under it belongs to whichever one this is. */}
        {payload.bodies.length > 1
          ? (
            <label className="herself-field" htmlFor="herself-body">
              <span>Body</span>
              <select
                id="herself-body" value={payload.body}
                onChange={(event) => store(Number(event.target.value), payload.picked)}
              >
                {payload.bodies.map((body) => (
                  <option key={body.id} value={body.id}>{body.name}</option>
                ))}
              </select>
            </label>
          )
          : null}
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
