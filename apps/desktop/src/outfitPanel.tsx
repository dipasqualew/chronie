/**
 * The character, wearing what the reader has assembled, and the rail of what that is.
 *
 * This is the half of the transmog view that never goes away. The sets are browsed beside it
 * and clicking an appearance changes what she has on; the body stays where it is and redraws.
 * That is the whole difference from the dialog this replaced — a preview opened over one set
 * and closed with it, and an outfit outlives every set it was assembled from.
 *
 * Almost everything below is kept in refs rather than in state, and deliberately: the caches
 * are what stop a reader trying hats from re-reading the game's storage for an outfit it has
 * already seen, the stage is a graphics context a browser will only hand out so many of, and
 * the counter is what decides which of several bodies in flight is the one still being waited
 * for. None of those are things to draw, and turning them into state would redraw the pane for
 * each of them.
 */

import "./outfitPanel.css";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { piecesFrom, setNamed } from "./customSets";
import { Herself } from "./herselfPanel";
import type { HerselfProps } from "./herselfPanel";
import { iconFrom, requestSummary, slotsFrom } from "./inGameSets";
import { glbBytes, REASONS, wornSetKey } from "./modelPreview";
import { outfitSummary, piecesOf, wornPieces, wornTip } from "./outfit";
import type { Outfit } from "./outfit";
import { usePaneStage } from "./stage";
import type { MakeStage } from "./stage";
import type {
  CharacterModelPayload,
  CustomSet,
  CustomSetPiece,
  CustomSetsPayload,
  InGameSetSlot,
  SetRequest,
  WornPiece,
  WornSetPayload,
} from "./types";

/**
 * Saving what she has on under a name, as the panel needs it.
 *
 * The sets already saved are here only so the button can say which of the two things it is
 * about to do — see [`SaveAsSet`]. Everything else is the same shape the marks use: the write
 * answers with all of them, and what came back is what the view then holds.
 */
export interface SaveActions {
  /**
   * Asks the *game* to hold on to this outfit, under the name in the box beside it.
   *
   * The one action in this app that changes something inside a WoW account. Two steps rather
   * than one, and the button says so: this records the request, and the addon saves the set the
   * next time the player logs in — nothing in a desktop app can reach a running game. See
   * `docs/transmog-sets.md`.
   */
  onSendToGame: (
    name: string,
    icon: number | null,
    slots: InGameSetSlot[],
  ) => Promise<SetRequest[]>;
  sets: CustomSet[];
  onSave: (name: string, pieces: CustomSetPiece[]) => Promise<CustomSetsPayload>;
  onSaved: (payload: CustomSetsPayload) => void;
  onError: (error: unknown) => string;
}

export interface OutfitPanelProps {
  outfit: Outfit;
  /** How the outfit on her becomes a set of the reader's own. */
  save: SaveActions;
  /** Takes one piece off. The panel knows the place and nothing about what put it there. */
  onTakeOff: (place: string) => void;
  onClearAll: () => void;
  /** Asks for the bare body, which is what an outfit with nothing in it comes to. */
  loadCharacter: () => Promise<CharacterModelPayload>;
  /** Asks for that body wearing the whole outfit. Passed in so the panel is drivable alone. */
  loadWorn: (pieces: WornPiece[]) => Promise<WornSetPayload>;
  /** The pictures the worn rail draws, out of the cache the browser beside it fills. */
  icons: Map<number, string>;
  /** The form under her that says who she is, and the reader's answers as they stand. */
  herself: HerselfProps;
  /**
   * Her, as a string that changes when she does — see `herself.ts`.
   *
   * Every body below is cached under it, because every body below *is* of her: change her hair
   * and the character in a robe is a different picture of a different woman. The panel does not
   * read it beyond that, and never sends it: which answers apply is the backend's, out of the
   * settings file, for all three of the commands that draw her.
   */
  look: string;
  /**
   * Makes the 3D pane. Passed in because it is the one thing here that needs a graphics card:
   * a machine without working 3D throws, and the reader is told so rather than shown nothing.
   */
  createStage?: MakeStage;
}

/**
 * What the pane is showing, which is what its `data-state` says and what the note reads.
 *
 * `redrawing` is the one that is not about this read at all but about the last one: a body is
 * on the stage and the next one is being read out of the game. It exists because the stylesheet
 * hides the stage for `loading` and `empty`, and going to `loading` for a read that has a
 * perfectly good body already drawn is the white flash the reader used to get once per piece
 * put on. The two are told apart by whether anything has ever reached the stage, and nothing
 * else: an empty canvas must not be dressed up as a picture of anybody.
 */
interface PaneState {
  state: "loading" | "redrawing" | "shown" | "empty";
  note: string;
}

/** Whether the pane has a body on it that is worth keeping there while the next one is read. */
const drawn = (was: PaneState): boolean => was.state === "shown" || was.state === "redrawing";

/**
 * What to say while a body is being read: the note, over whatever the stage is already holding.
 *
 * A function of the state it replaces, because the question "is there a picture up" is one only
 * the pane's own last answer can settle — the stage is a ref and a canvas says nothing about
 * whether anything parsed into it.
 */
const reading =
  (note: string) =>
  (was: PaneState): PaneState => ({
    state: drawn(was) ? "redrawing" : "loading",
    note,
  });

export function OutfitPanel({
  outfit,
  save,
  onTakeOff,
  onClearAll,
  loadCharacter,
  loadWorn,
  icons,
  herself,
  look,
  createStage = lazyStage,
}: OutfitPanelProps): ReactNode {
  const stagePane = useRef<HTMLDivElement>(null);
  // The bodies, by the outfit each is wearing — see `wornSetKey`. Keyed by the whole outfit
  // rather than by a piece of it because that is what the answer is of: a character in a robe
  // and a character in a robe and boots are two different pictures. Taking a piece off and
  // putting it back therefore costs one read rather than two. `null` is an answer: this
  // install has nothing to put on her for that outfit, and asking again would say the same.
  const bodies = useRef(new Map<string, string | null>()).current;
  // The bare body, asked for once per woman and kept for as long as the app runs. It is one
  // model for every outfit there is, and the read behind it is the game's own storage — but it
  // is a model *of somebody*, so it is held under the same key the dressed bodies are.
  const character = useRef(new Map<string, Promise<CharacterModelPayload>>()).current;
  // One stage for as long as the view is mounted. Each one is a graphics context of its own, and a
  // browser will only hand out so many before it starts taking them back — `stage.ts` is where that
  // arrangement lives, and where the reason nothing is ever drawn on one already given back is.
  const stage = usePaneStage(createStage);
  // Which outfit the pane is currently answering. A reader clicking faster than the bodies
  // arrive would otherwise be left looking at whichever finished last.
  const asked = useRef(0);

  const [pane, setPane] = useState<PaneState>({ state: "loading", note: "" });

  const pieces = piecesOf(outfit);
  // The outfit *and* who is wearing it, because both decide the picture. Answering a question
  // about her body makes every cached body a picture of somebody else, and this is where they
  // stop being answers: a key nothing asks for again is a body that is read out of the game
  // afresh, which is the whole of the invalidation.
  const key = `${look}|${wornSetKey(pieces)}`;

  /** Draws a `.glb` on the stage, making one the first time anything needs it. */
  const onStage = useCallback(
    async (
      glb: string,
      mine: number,
      note: string,
      fallback: (error: unknown) => void,
    ): Promise<void> => {
      const container = stagePane.current;
      if (!container) return;
      try {
        const drew = await stage.show(container, glbBytes(glb));
        // `drew` is false for a view that has gone away since, which has no note to be written.
        if (drew && mine === asked.current) setPane({ state: "shown", note });
      } catch (error: unknown) {
        if (mine === asked.current) fallback(error);
      }
    },
    [stage],
  );

  /**
   * Puts the outfit on the character, or the bare body on the stage when there is no outfit.
   *
   * The two are one errand with two answers behind them, and the empty one is not a failure:
   * taking every piece off is a thing a reader does on purpose, and what is underneath is the
   * body all of this is clothes for.
   *
   * A machine with no working 3D — a remote desktop, a virtual machine, a driver the browser
   * has blocklisted — falls back to a sentence. The list of what is on is still there and the
   * sets beside it are still browsable, which is a worse view of a wardrobe and not a broken
   * one.
   */
  const dress = useCallback(
    (pieces: WornPiece[], key: string): void => {
      const mine = (asked.current += 1);
      const blank = (error: unknown): void => setPane({ state: "empty", note: message(error) });

      if (!pieces.length) {
        setPane(reading("Reading the character model…"));
        let bare = character.get(key);
        if (!bare) {
          bare = loadCharacter();
          character.set(key, bare);
        }
        void bare
          .then((body) => {
            if (mine !== asked.current) return;
            return onStage(body.model, mine, REASONS.bare, blank);
          })
          .catch((error: unknown) => {
            // Forgotten rather than remembered as a failure: an install being read while it is
            // patched can refuse one moment and answer the next, and this is the one model with
            // no icons to fall back on.
            character.delete(key);
            if (mine === asked.current) blank(error);
          });
        return;
      }

      const put = (glb: string | null): void => {
        // Nothing to show: the game gives this install nothing it could put on a character for
        // any of these pieces. The list of what is on and a sentence are what is left.
        if (glb === null) return setPane({ state: "empty", note: REASONS.unshowable });
        void onStage(glb, mine, REASONS.set, blank);
      };

      const cached = bodies.get(key);
      if (cached !== undefined) return put(cached);

      setPane(reading("Putting it on the character…"));
      void loadWorn(pieces)
        .then((answer) => {
          bodies.set(key, answer.model);
          if (mine === asked.current) put(answer.model);
        })
        .catch(blank);
    },
    [bodies, character, loadCharacter, loadWorn, onStage],
  );

  // Redrawn every time the outfit changes — including for the empty one the view opens on,
  // which is the bare character — and every time *she* does. Keyed on the outfit's name rather
  // than on the object, so an outfit reassembled piece by piece into the same thing is not read
  // out of the game twice.
  useEffect(() => {
    dress(pieces, key);
    // `pieces` is what `key` names, and the key is the identity that matters: two lists holding
    // the same appearances are the same outfit and must not be read twice. Held by "does not
    // read the same outfit out of the game twice" in `transmogView.test.tsx`, which puts a helm
    // on, takes it off and puts it back, and asks how many times the game was read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dress]);

  const worn = wornPieces(outfit);

  return (
    <aside className="outfit" id="outfit" aria-label="The character">
      {/* The stage keeps its height whatever the pane is showing, so a body arriving does not
          make the line under it jump. */}
      <div className="outfit-preview" data-state={pane.state} role="group" aria-label="The stage">
        <div className="outfit-body">
          {/* A figure, because what it holds is a picture of somebody. The canvas inside names
              itself — see `createModelStage` — and this names the place it is drawn in, which
              is what survives a pane that has no picture in it at all. */}
          <div
            className="outfit-stage"
            ref={stagePane}
            role="figure"
            aria-label="Where she is drawn"
          />
          {/* What she has on, **down her side rather than under her**. A row apiece in the
              panel's own column was the version this replaced, and it took the character's
              height away exactly as she was being dressed: every piece put on made the picture
              of her wearing it smaller, and a whole body's worth left the smallest picture of
              all. Out of the flow, so the twelfth piece costs the stage nothing.

              Pictures only, because a picture is what a reader recognises a hat by. The name,
              the place and the set it came from are all on the tip — [`wornTip`] — which is
              what a wardrobe of icons has always kept them on. */}
          <ul className="outfit-worn" id="outfit-list" aria-label="What she has on">
            {worn.map((piece) => (
              <li className="outfit-slot" key={piece.place}>
                {/* The tile is the button: taking it off again is the only thing left to do to
                    a piece already on her, so there is nothing for a separate control to be
                    told apart from. The cross the tile grows under the pointer is what says
                    so before the click. */}
                <button
                  type="button"
                  className="outfit-off"
                  aria-label={`Take off ${piece.row.label}`}
                  data-tip={wornTip(piece)}
                  onClick={() => onTakeOff(piece.place)}
                >
                  <span className="mog-icon">
                    {icons.get(piece.row.iconFileDataId) ? (
                      <img src={icons.get(piece.row.iconFileDataId)} alt="" />
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {/* Over the corner of the stage, because it belongs to the picture rather than to
              the panel under it — and only while there is a picture: a pane showing a
              sentence because this machine cannot draw 3D has no camera to put back. A body
              being redrawn is still a body somebody can have dragged too far, so the way back
              goes where the picture goes rather than away for the length of every read. */}
          {drawn(pane) ? (
            <button type="button" className="outfit-reset" onClick={() => stage.resetCamera()}>
              Reset camera
            </button>
          ) : null}
        </div>
        <p
          className="mog-note muted"
          role="status"
          id="outfit-note"
          aria-label="What the stage is showing"
        >
          {pane.note}
        </p>
      </div>
      {/* Under the picture and above the clothes, which is the order the two questions come in:
          this is the body, and everything below it is what goes on the body. Shut, because a
          reader is here to try things on and the answers already apply to every body drawn. */}
      <Herself {...herself} />
      <div className="outfit-head">
        <h3>Worn</h3>
        <span className="muted" id="outfit-summary" role="status" aria-label="How much is on">
          {outfitSummary(outfit)}
        </span>
        {worn.length ? (
          <button type="button" className="outfit-clear" onClick={onClearAll}>
            Take it all off
          </button>
        ) : null}
      </div>
      {/* Only once there is something to save. A form that could do nothing but refuse is worse
          than no form, and "nothing on yet" is already said by the line under it. */}
      {worn.length ? <SaveAsSet outfit={outfit} save={save} /> : null}
      {/* Kept in the tree rather than swapped for the rail, so the two cannot both be absent
          and the reader is never looking at a panel that says nothing at all. */}
      <p className="muted outfit-empty" hidden={worn.length > 0}>
        Every appearance you pick goes on her and stays on while you look for the next one.
      </p>
    </aside>
  );
}

/**
 * The name box under the character, which is the whole of how a set of one's own is made.
 *
 * Here rather than anywhere else because this is where the outfit is: a set is what she has on
 * at the moment somebody decides it is worth keeping, and every other arrangement — a dialog, a
 * page of its own, a list to pick pieces into — asks the reader to build the thing twice.
 *
 * **The button says which of the two things it will do.** Names are unique without regard to
 * case, so typing the name of a set that already exists saves over it — which is exactly what
 * somebody who swapped one piece and saved again meant, and exactly what somebody who forgot
 * they had used the name did not. Saying "Replace Horde look" before the click is the whole
 * difference between those two readers.
 *
 * What is *not* here is any clearing of the character afterwards. Saving is a note taken, not a
 * door closed: the reader is still dressing her, and having their work taken away as a reward
 * for keeping it would be an odd thing for an app to do.
 */
function SaveAsSet({ outfit, save }: { outfit: Outfit; save: SaveActions }): ReactNode {
  const [name, setName] = useState("");
  const [failure, setFailure] = useState("");
  const [saved, setSaved] = useState("");
  const replacing = setNamed(save.sets, name);
  // Only the pieces the game has a slot for. `outfit.ts` and the game disagree about nothing
  // that matters here, but a look the game withholds has nowhere to go in either — see
  // `slotsFrom`, which drops exactly what `placeOf` would.
  const slots = slotsFrom(outfit);

  return (
    <form
      className="outfit-save"
      onSubmit={(event) => {
        event.preventDefault();
        setFailure("");
        setSaved("");
        // The backend cleans and refuses; this only avoids sending a form nobody filled in,
        // which would otherwise answer "Give the set a name" for a stray Enter.
        if (!name.trim()) return;
        void save
          .onSave(name, piecesFrom(outfit))
          .then((payload) => {
            save.onSaved(payload);
            setSaved(`Saved as ${name.trim().replace(/\s+/g, " ")}. It is under "Yours".`);
            setName("");
          })
          .catch((error: unknown) => setFailure(save.onError(error)));
      }}
    >
      <input
        className="outfit-name"
        type="text"
        id="outfit-name"
        value={name}
        aria-label="Name for this set"
        placeholder="Name this outfit"
        onChange={(event) => {
          setName(event.target.value);
          setSaved("");
        }}
      />
      <button type="submit" className="outfit-keep">
        {replacing ? `Replace ${replacing.name}` : "Save as a set"}
      </button>
      {/* Beside saving rather than instead of it, because they are two different keepings and
          a reader may want either or both: one puts the outfit in this app's own browser, the
          other puts it in the game's, where the character can actually be dressed in it.

          `type="button"`, so Enter in the name box still means the ordinary save. Sending an
          outfit into somebody's WoW account is not what a stray keypress should do. */}
      <button
        type="button"
        className="outfit-send"
        disabled={!slots.length}
        onClick={() => {
          setFailure("");
          setSaved("");
          if (!name.trim()) return;
          void save
            .onSendToGame(name, iconFrom(outfit), slots)
            .then((requests) => {
              const sent = requests[0];
              setSaved(
                sent
                  ? requestSummary(sent)
                  : `Sent ${name.trim().replace(/\s+/g, " ")} to the game.`,
              );
              setName("");
            })
            .catch((error: unknown) => setFailure(save.onError(error)));
        }}
      >
        Send to the game
      </button>
      {/* A live region rather than a chip that appears: the reader's eye is on the character
          and the list, and the one thing worth interrupting them for is where the set went. */}
      {saved ? (
        <span className="muted" role="status">
          {saved}
        </span>
      ) : null}
      {failure ? (
        <span className="mark-failure" role="alert">
          {failure}
        </span>
      ) : null}
    </form>
  );
}

/**
 * The renderer, fetched the first time the transmog view is opened.
 *
 * three.js is most of a megabyte and the app opens on a timeline that has no use for it, so it
 * is a chunk of its own rather than part of the window's first load. Nobody who never opens
 * the wardrobe ever downloads it.
 */
const lazyStage: MakeStage = (container) =>
  import("./modelViewer").then((viewer) =>
    viewer.createModelStage(container, { label: "The character, drawn" }),
  );

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
