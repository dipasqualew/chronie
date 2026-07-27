/**
 * The character, wearing what the reader has assembled, and the list of what that is.
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { glbBytes, REASONS, wornSetKey } from "./modelPreview";
import type { ModelStage } from "./modelViewer";
import { outfitSummary, piecesOf, placeName, wornPieces } from "./outfit";
import type { Outfit } from "./outfit";
import type { CharacterModelPayload, WornPiece, WornSetPayload } from "./types";

export interface OutfitPanelProps {
  outfit: Outfit;
  /** Takes one piece off. The panel knows the place and nothing about what put it there. */
  onTakeOff: (place: string) => void;
  onClearAll: () => void;
  /** Asks for the bare body, which is what an outfit with nothing in it comes to. */
  loadCharacter: () => Promise<CharacterModelPayload>;
  /** Asks for that body wearing the whole outfit. Passed in so the panel is drivable alone. */
  loadWorn: (pieces: WornPiece[]) => Promise<WornSetPayload>;
  /** The pictures the worn list draws, out of the cache the browser beside it fills. */
  icons: Map<number, string>;
  /**
   * Makes the 3D pane. Passed in because it is the one thing here that needs a graphics card:
   * a machine without working 3D throws, and the reader is told so rather than shown nothing.
   */
  createStage?: (container: HTMLElement) => ModelStage | Promise<ModelStage>;
}

/** What the pane is showing, which is what its `data-state` says and what the note reads. */
interface PaneState {
  state: "loading" | "shown" | "empty";
  note: string;
}

export function OutfitPanel(
  {
    outfit, onTakeOff, onClearAll, loadCharacter, loadWorn, icons, createStage = lazyStage,
  }: OutfitPanelProps,
): ReactNode {
  const stagePane = useRef<HTMLDivElement>(null);
  // The bodies, by the outfit each is wearing — see `wornSetKey`. Keyed by the whole outfit
  // rather than by a piece of it because that is what the answer is of: a character in a robe
  // and a character in a robe and boots are two different pictures. Taking a piece off and
  // putting it back therefore costs one read rather than two. `null` is an answer: this
  // install has nothing to put on her for that outfit, and asking again would say the same.
  const bodies = useRef(new Map<string, string | null>()).current;
  // The bare body, asked for once and kept for as long as the app runs. It is one model for
  // every outfit there is, and the read behind it is the game's own storage.
  const character = useRef<Promise<CharacterModelPayload> | null>(null);
  // One stage for as long as the view is mounted. Each one is a graphics context of its own,
  // and a browser will only hand out so many before it starts taking them back.
  const stage = useRef<ModelStage | null>(null);
  const starting = useRef<Promise<ModelStage> | null>(null);
  // Which outfit the pane is currently answering. A reader clicking faster than the bodies
  // arrive would otherwise be left looking at whichever finished last.
  const asked = useRef(0);

  const [pane, setPane] = useState<PaneState>({ state: "loading", note: "" });

  const pieces = piecesOf(outfit);
  const key = wornSetKey(pieces);

  /** Draws a `.glb` on the stage, making one the first time anything needs it. */
  const onStage = useCallback(async (
    glb: string, mine: number, note: string, fallback: (error: unknown) => void,
  ): Promise<void> => {
    const container = stagePane.current;
    if (!container) return;
    try {
      // One stage, and one attempt to make one: two quick picks would otherwise each start a
      // renderer and the second would be left running with nothing pointing at it.
      starting.current ??= Promise.resolve(createStage(container));
      stage.current = await starting.current;
      await stage.current.show(glbBytes(glb));
      if (mine === asked.current) setPane({ state: "shown", note });
    } catch (error: unknown) {
      if (mine === asked.current) fallback(error);
    }
  }, [createStage]);

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
  const dress = useCallback((pieces: WornPiece[], key: string): void => {
    const mine = (asked.current += 1);
    const blank = (error: unknown): void =>
      setPane({ state: "empty", note: message(error) });

    if (!pieces.length) {
      setPane({ state: "loading", note: "Reading the character model…" });
      character.current ??= loadCharacter();
      void character.current
        .then((body) => {
          if (mine !== asked.current) return;
          return onStage(body.model, mine, REASONS.bare, blank);
        })
        .catch((error: unknown) => {
          character.current = null;
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

    setPane({ state: "loading", note: "Putting it on the character…" });
    void loadWorn(pieces)
      .then((answer) => {
        bodies.set(key, answer.model);
        if (mine === asked.current) put(answer.model);
      })
      .catch(blank);
  }, [bodies, loadCharacter, loadWorn, onStage]);

  // Redrawn every time the outfit changes — including for the empty one the view opens on,
  // which is the bare character. Keyed on the outfit's name rather than on the object, so an
  // outfit reassembled piece by piece into the same thing is not read out of the game twice.
  useEffect(() => {
    dress(pieces, key);
    // `pieces` is what `key` names, and the key is the identity that matters: two lists holding
    // the same appearances are the same outfit and must not be read twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dress]);

  // The graphics context goes back when the view does.
  useEffect(() => () => {
    stage.current?.dispose();
    stage.current = null;
    starting.current = null;
  }, []);

  const worn = wornPieces(outfit);

  return (
    <aside className="outfit" id="outfit">
      {/* The stage keeps its height whatever the pane is showing, so a body arriving does not
          make the list under it jump. */}
      <div className="outfit-preview" data-state={pane.state}>
        <div className="outfit-stage" ref={stagePane} />
        <p className="mog-note muted" role="status" id="outfit-note">{pane.note}</p>
      </div>
      <div className="outfit-head">
        <h3>Worn</h3>
        <span className="muted" id="outfit-summary">{outfitSummary(outfit)}</span>
        {worn.length
          ? <button type="button" className="outfit-clear" onClick={onClearAll}>Take it all off</button>
          : null}
      </div>
      <ul className="outfit-list" id="outfit-list">
        {worn.map((piece) => (
          <li className="outfit-slot" key={piece.place}>
            <span className="mog-icon">
              {icons.get(piece.row.iconFileDataId)
                ? <img src={icons.get(piece.row.iconFileDataId)} alt="" />
                : null}
            </span>
            <span className="outfit-where badge">{placeName(piece.place, piece.row)}</span>
            <span className="outfit-what">
              {/* The panel is narrow and item names are not, so the name is clipped and the
                  whole of it is on the row for anyone who wants it. */}
              <span className="outfit-item" title={piece.row.label}>{piece.row.label}</span>
              <span className="muted">{piece.setName || `Set ${piece.setId}`}</span>
            </span>
            <button
              type="button" className="outfit-off"
              aria-label={`Take off ${piece.row.label}`}
              onClick={() => onTakeOff(piece.place)}
            >Remove</button>
          </li>
        ))}
      </ul>
      {/* Kept in the tree rather than swapped for the list, so the two cannot both be absent
          and the reader is never looking at a panel that says nothing at all. */}
      <p className="muted outfit-empty" hidden={worn.length > 0}>
        Every appearance you pick goes on her and stays on while you look for the next one.
      </p>
    </aside>
  );
}

/**
 * The renderer, fetched the first time the transmog view is opened.
 *
 * three.js is most of a megabyte and the app opens on a timeline that has no use for it, so it
 * is a chunk of its own rather than part of the window's first load. Nobody who never opens
 * the wardrobe ever downloads it.
 */
const lazyStage = (container: HTMLElement): Promise<ModelStage> =>
  import("./modelViewer").then((viewer) => viewer.createModelStage(container));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
