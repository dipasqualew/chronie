/**
 * The character, wearing one of the sets they saved in the game.
 *
 * The one picture on this page, and it earns its place by answering a question nothing else on
 * it can: *who is this*. A roster row is two initials in a class colour and a profile is a grid
 * of numbers, and neither is how a player recognises their own alt — they recognise the tabard.
 *
 * Three things make it different from every other body this app draws, and all three are the
 * same difference stated at different heights:
 *
 * - **It is drawn on their body, not on the reader's.** Everywhere else a look is being chosen
 *   and is shown on whoever is going to wear it — a person the reader assembled out of fifty-one
 *   bodies and a select per question. Here the wearer is already decided and is not the reader's
 *   invention, so the request carries the character's name and the backend resolves the body.
 *   See `character_worn_set`.
 * - **The clothes are theirs too.** Not a set out of the game's catalogue but one this player put
 *   together at a transmogrifier, read off their own account by the addon.
 * - **Nothing here is a way in to anything.** The transmog view is where a set is opened, taken
 *   apart and worn piece by piece; this is a portrait. Picking another set changes the portrait
 *   and nothing else.
 *
 * The set is read the moment it is chosen, which costs the game's own tables — an in-game set
 * names appearances and nothing else, see `inGameSets.ts` — and the outfit is then one more
 * request for the body wearing it. Both are kept for as long as this character is the one on
 * screen, so flipping between their sets costs nothing the second time.
 *
 * # A live pane, and not a gallery tile
 *
 * This used to paint through `galleryStage.ts`, which was the wrong renderer twice over (#222).
 * A gallery stage draws into a fixed 256 × 256 buffer and copies the result onto a plain 2D
 * canvas, because a grid is twenty pictures at once and a browser hands out about sixteen WebGL
 * contexts. **A portrait is one picture.** It can afford the real thing, and the difference is
 * not subtle: a 256-pixel bitmap laid out `object-fit: contain` inside a wide frame is a small
 * blurry character with an empty band either side of it, and dragging it turns that bitmap
 * rather than a model.
 *
 * So it draws on `modelViewer.ts` through `usePaneStage`, the same arrangement the outfit pane
 * and the appearance modal use — one live scene, sized to its element in device pixels by a
 * `ResizeObserver`, with orbit controls, damping, zoom and a way back. `stage.ts` is where the
 * rules about when that context exists live, and `.model-canvas` in `modelViewer.css` is what
 * gives the canvas a size, which is the other half of what #146 was about.
 */

import "./characterFigure.css";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { glbBytes } from "./modelPreview";
import { usePaneStage } from "./stage";
import type { MakeStage } from "./stage";
import { appearanceIds, setLabel, wornFrom } from "./inGameSets";
import type {
  CharacterWornSetPayload,
  InGameSet,
  InGameSetAppearancesPayload,
  Likeness,
  WornPiece,
} from "./types";

export interface CharacterFigureProps {
  /** Whose portrait it is, which is also whose body the backend is asked to draw. */
  character: string;
  /** What they saved in game, or null where Chronie has never read this character's wardrobe. */
  sets: InGameSet[] | null;
  /** Asks the game's files what a set's appearances actually are. */
  loadAppearances: (appearanceIds: number[]) => Promise<InGameSetAppearancesPayload>;
  /** Asks for that character wearing them. */
  loadWorn: (character: string, pieces: WornPiece[]) => Promise<CharacterWornSetPayload>;
  /**
   * Makes the 3D pane. Passed in because it is the one thing here that needs a graphics card:
   * a machine without working 3D throws, and the reader is told so rather than shown nothing.
   */
  createStage?: MakeStage;
}

/** What one set turned out to be worth drawing: the model, or the reason there is none. */
type Portrait =
  | { kind: "reading" }
  | { kind: "drawn"; glb: string; likeness: Likeness }
  | { kind: "nothing"; note: string };

/** A set with nothing in it is a set the player made and has not filled, and cannot be worn. */
const filled = (sets: InGameSet[] | null): InGameSet[] =>
  (sets ?? []).filter((set) => set.slots.length > 0);

export function CharacterFigure({
  character,
  sets,
  loadAppearances,
  loadWorn,
  createStage = lazyStage,
}: CharacterFigureProps): ReactNode {
  const wearable = filled(sets);
  // Held by set id rather than by position, so a sync that adds a set does not silently move
  // the reader onto somebody else's clothes. Null means "whichever is first", which is what a
  // reader who has chosen nothing is looking at.
  const [chosen, setChosen] = useState<number | null>(null);
  const showing = wearable.find((set) => set.id === chosen) ?? wearable[0];

  // What each set came to. Outside React for the reason the set list keeps its own outside it:
  // a cache filling is not a redraw, and the counter below is what says one happened. Keyed by
  // character and set together — the ids are the account's, and two alts' wardrobes are two
  // wardrobes.
  const known = useRef(new Map<string, Portrait>()).current;
  const asked = useRef(new Set<string>()).current;
  const [, redraw] = useState(0);

  const read = useCallback(
    async (key: string, set: InGameSet): Promise<void> => {
      try {
        const opened = await loadAppearances(appearanceIds(set));
        const pieces = wornFrom(opened.appearances);
        if (!pieces.length) {
          known.set(key, { kind: "nothing", note: NOTHING_TO_WEAR });
          return;
        }
        const worn = await loadWorn(character, pieces);
        known.set(
          key,
          worn.model
            ? { kind: "drawn", glb: worn.model, likeness: worn.likeness }
            : // Which of the two silences it is, because they are answers to different
              // questions and only one of them is about the clothes. See `Likeness`.
              { kind: "nothing", note: nothingDrawn(worn.likeness, character) },
        );
      } catch (error: unknown) {
        // Worth saying, because on a machine with no game installed this is the failure a reader
        // meets on every character — and a blank frame would look like a bug in Chronie rather
        // than like an app that cannot reach the game's files.
        known.set(key, {
          kind: "nothing",
          note: error instanceof Error ? error.message : String(error),
        });
      } finally {
        redraw((count) => count + 1);
      }
    },
    [character, loadAppearances, loadWorn, known],
  );

  const key = showing ? `${character}:${showing.id}` : "";
  useEffect(() => {
    if (!showing || asked.has(key)) return;
    asked.add(key);
    known.set(key, { kind: "reading" });
    void read(key, showing);
  }, [key, showing, read, asked, known]);

  // Chronie has never looked at this character's wardrobe, which is a question this app has not
  // asked rather than one the game answered — so it says nothing at all. See `wardrobeSummary`.
  if (!sets) return null;

  const portrait = known.get(key);
  const name = showing ? setLabel(showing) : "";

  return (
    <figure className="figure" aria-label={`${character}, drawn`}>
      <FigureStage
        // Keyed by the outfit, so moving to another set starts a fresh pane rather than
        // repainting one that is still holding the last body.
        key={key}
        portrait={portrait}
        label={showing ? `${character} wearing ${name}` : character}
        waiting={figureWait(wearable.length)}
        createStage={createStage}
      />
      {wearable.length > 1 ? (
        <figcaption className="figure-pick">
          <label htmlFor={`figure-set-${character}`}>Wearing</label>
          <select
            id={`figure-set-${character}`}
            value={showing?.id ?? ""}
            onChange={(event) => setChosen(Number(event.target.value))}
          >
            {wearable.map((set) => (
              <option key={set.id} value={set.id}>
                {setLabel(set)}
              </option>
            ))}
          </select>
        </figcaption>
      ) : wearable.length === 1 ? (
        <figcaption className="figure-pick muted">Wearing {name}</figcaption>
      ) : null}
      {/* Under the picture rather than over it, and only where it changes what the reader is
          looking at: a body drawn off a race alone is the right shape in the wrong colours, and
          a reader who is not told that reads it as Chronie getting their character wrong. */}
      {portrait?.kind === "drawn" && portrait.likeness === "race" ? (
        <p className="figure-caveat muted">{DEFAULT_COLOURING}</p>
      ) : null}
    </figure>
  );
}

/**
 * The pane the body is drawn on, and what it says while there is no body on it.
 *
 * Its own component so that the stage is torn down and rebuilt with the outfit — the `key` on it
 * above is what does that — and so that the hook holding a WebGL context is somewhere with
 * exactly one lifetime. `usePaneStage` gives the context back on unmount; a hook in the figure
 * itself would hold one for as long as the reader is on the character, including while the pane
 * is showing a sentence because there is nothing to draw.
 */
function FigureStage({
  portrait,
  label,
  waiting,
  createStage,
}: {
  portrait: Portrait | undefined;
  label: string;
  waiting: string;
  createStage: MakeStage;
}): ReactNode {
  const pane = useRef<HTMLDivElement>(null);
  // Named for whom it is of rather than for what it is, which is the one thing a portrait's
  // canvas can say that the outfit pane's cannot: the wearer is decided, so the picture is of
  // somebody. It is read when the stage is made, and the stage is made once per outfit.
  const stage = usePaneStage(createStage, `${label}, drawn`);
  const [failure, setFailure] = useState<string | null>(null);
  const glb = portrait?.kind === "drawn" ? portrait.glb : null;

  useEffect(() => {
    const container = pane.current;
    if (!container || !glb) return;
    setFailure(null);
    // The whole of her, because there is no part of a portrait it is about: the boots are as
    // much of the answer as the helm, which is `WHOLE` and is what the pane defaults to.
    void stage.show(container, glbBytes(glb)).catch((error: unknown) => {
      // A machine with no working 3D — a remote desktop, a virtual machine, a driver the
      // browser has blocklisted — falls back to a sentence, the same as the outfit pane.
      setFailure(error instanceof Error ? error.message : String(error));
    });
  }, [glb, stage]);

  const note = failure ?? (portrait?.kind === "nothing" ? portrait.note : glb ? null : waiting);

  return (
    <div className="figure-stage" data-state={note ? "empty" : "shown"}>
      {/* Always mounted and never replaced, because the stage draws into it: a container that
          came and went with the picture would take the renderer's canvas with it, and the pane
          would come back empty on the frame after a failure was cleared. It carries no role of
          its own — the canvas inside it is the picture and names itself, and a figure wrapping a
          figure is one landmark too many for a reader arriving on it. */}
      <div className="figure-pane" ref={pane} />
      {note ? <p className="figure-note muted">{note}</p> : null}
      {/* Over the corner of the picture and only while there is one, because turning a body is
          how a reader gets lost and this is the way back. The same control the outfit pane
          carries, for the same reason. */}
      {note ? null : (
        <button type="button" className="figure-reset" onClick={() => stage.resetCamera()}>
          Reset camera
        </button>
      )}
    </div>
  );
}

/** What the frame says while there is nothing in it yet, which is two different silences. */
const figureWait = (count: number): string =>
  count
    ? "Dressing the character…"
    : "No transmog sets saved in game, so there is nothing to dress this character in.";

/**
 * Why there is no body, when the backend had a set to draw and drew nothing.
 *
 * Two entirely different answers behind one `null`, and telling them apart is most of what #222
 * asked for. `nobody` is the app not recognising the character at all, which used to be answered
 * with the reader's own invented body and no explanation — a portrait of a stranger. Anything
 * else is the clothes, which is what this frame has always said.
 */
const nothingDrawn = (likeness: Likeness, character: string): string =>
  likeness === "nobody"
    ? `Chronie has not read who ${character} is yet, so there is nobody to draw. Log in on them` +
      " once with Chronie installed and they will appear here."
    : NOTHING_TO_DRAW;

/**
 * The body is theirs and the colouring is not, which is the ordinary state of most of a roster.
 *
 * The game is what limits this rather than the addon: `UnitRace` and `UnitSex` are readable
 * wherever a character is standing, and `C_BarberShop.GetAvailableCustomizations` is the only
 * call in the client that will enumerate what they are *made of* — and it answers nothing
 * anywhere but the barber's chair. See `docs/character-rendering.md`.
 */
const DEFAULT_COLOURING =
  "Drawn from their race, at the colours the game itself opens on: the client only says what a" +
  " character is made of at a barber's chair. Sit in one with Chronie installed and this becomes" +
  " their own skin, hair and face.";

/** Every piece of the set is one the game gives no place on a body. */
const NOTHING_TO_WEAR = "Nothing in this set can be worn on a character.";

/** And the other end: the pieces have places and this install has no model to put in them. */
const NOTHING_TO_DRAW = "This install holds nothing to draw this set on a character with.";

/**
 * The renderer, fetched the first time a reader opens somebody's page.
 *
 * three.js and its loader are most of this app's JavaScript, and the same import the outfit pane
 * and the appearance modal make: a reader who only ever reads the timeline never downloads it,
 * and one who has already opened the wardrobe pays nothing here because it is already in memory.
 */
const lazyStage: MakeStage = (container, label) =>
  import("./modelViewer").then((viewer) =>
    // Named for whom it is of, unlike the other two panes: the outfit pane draws whoever the
    // reader invented and the modal draws a hat, and neither has a name to give. See `MakeStage`.
    viewer.createModelStage(container, { label: label ?? "The character, drawn" }),
  );
