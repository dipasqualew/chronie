/**
 * One transmog set, opened: what the game says it is made of, and what it looks like worn.
 *
 * `transmogModal.ts` decides how a payload reads as rows; this is the dialog over it, and the
 * one view in the app that asks for something after the page has loaded — so it is the one
 * with a loading state and a failure to draw.
 *
 * The pane above the list shows **the whole set on a character**, which is how a player sees
 * one: twelve pieces at once, argued out between themselves by the game's own priority table
 * and composited in the game's own order. Both of those are the backend's, because neither can
 * be decided one piece at a time. The rows below are then a way to take a piece off and put it
 * back rather than a way to look at pieces one at a time.
 *
 * Almost everything below is kept in refs rather than in state, and deliberately: the caches
 * are what stop a reader toggling a row from re-reading the game's storage for an outfit it has
 * already seen, the stage is a graphics context a browser will only hand out so many of, and
 * the counter is what decides which of several answers in flight is the one still being waited
 * for. None of those are things to draw, and turning them into state would redraw the pane for
 * each of them.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { glbBytes, outfitOf, REASONS, wearable, wornSetKey } from "./modelPreview";
import type { ModelStage } from "./modelViewer";
import { classLabel, expansionName, patchName } from "./transmog";
import { appearanceRows, appearanceSummary, iconIds } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type {
  CharacterModelPayload,
  IconsPayload,
  TransmogSet,
  TransmogSetItemsPayload,
  WornPiece,
  WornSetPayload,
} from "./types";

export interface TransmogDetailProps {
  /** The set the dialog is showing, or null when it is closed. */
  set: TransmogSet | null;
  onClose: () => void;
  /** Asks the backend what a set is made of. Passed in so the dialog is drivable without one. */
  load: (setId: number) => Promise<TransmogSetItemsPayload>;
  /** Asks the backend for the pictures those rows need, decoded out of the game's textures. */
  loadIcons: (iconFileDataIds: number[]) => Promise<IconsPayload>;
  /** Asks for the bare body a set falls back to when nothing is worn. One model for the app. */
  loadCharacter: () => Promise<CharacterModelPayload>;
  /** Asks for that body wearing an outfit, which is how the whole set is shown. */
  loadWorn: (pieces: WornPiece[]) => Promise<WornSetPayload>;
  /**
   * Makes the 3D pane. Passed in because it is the one thing here that needs a graphics card:
   * a machine without working 3D throws, and the reader gets the list on its own.
   */
  createStage?: (container: HTMLElement) => ModelStage | Promise<ModelStage>;
}

/** What the pane is showing, which is what its `data-state` says and what the note reads. */
interface PreviewState {
  state: string;
  note: string;
  /** Whether the stage is on show. Sticky through "loading", which touches neither. */
  stageVisible: boolean;
}

const EMPTY_PREVIEW: PreviewState = { state: "empty", note: "", stageVisible: false };

/** Nothing worn, which is what a set that has not been read yet has on. */
const NOTHING: ReadonlySet<number> = new Set<number>();

export function TransmogDetail(
  { set, onClose, load, loadIcons, loadCharacter, loadWorn, createStage = lazyStage }:
  TransmogDetailProps,
): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const stagePane = useRef<HTMLDivElement>(null);

  // What a set is made of never changes under a running app — it is read out of the installed
  // game — so a set opened twice is read once.
  const known = useRef(new Map<number, TransmogSetItemsPayload>()).current;
  // The pictures, by the id the rows name them by. Kept beside the sets rather than inside
  // them because sets share their icons: a collection's tier variants are the same textures
  // throughout, so a set opened after its neighbour draws complete straight away.
  const pictures = useRef(new Map<number, string>()).current;
  // The bodies, by the outfit each is wearing — see `wornSetKey`. Keyed by the whole outfit
  // rather than by a piece of it because that is what the answer is of: a character in a robe
  // and a character in a robe and boots are two different pictures. Toggling a piece off and
  // back on therefore costs one read rather than two. `null` is an answer: this install has
  // nothing to put on her for that outfit, and asking again would say the same.
  const outfits = useRef(new Map<string, string | null>()).current;
  // The bare body, asked for once and kept for as long as the app runs. It is one model for
  // every set there is, and the read behind it is the game's own storage.
  const character = useRef<Promise<CharacterModelPayload> | null>(null);
  // One stage for as long as the dialog is open. Each one is a graphics context of its own,
  // and a browser will only hand out so many before it starts taking them back.
  const stage = useRef<ModelStage | null>(null);
  const starting = useRef<Promise<ModelStage> | null>(null);
  // Which outfit the pane is currently answering. A reader toggling rows faster than the
  // bodies arrive would otherwise be shown whichever finished last.
  const asked = useRef(0);

  const [payload, setPayload] = useState<TransmogSetItemsPayload | null>(null);
  const [failure, setFailure] = useState("");
  /** Which rows are on the character. Row indices, because a set can name one twice. */
  const [worn, setWorn] = useState<ReadonlySet<number>>(NOTHING);
  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW);
  // The pictures live outside React, in a cache shared by every set — so a batch arriving
  // changes nothing React would notice, and this is what puts them into the frames waiting.
  const [, redrawIcons] = useReducer((count: number) => count + 1, 0);

  const rows = payload ? appearanceRows(payload) : [];

  const setState = useCallback((state: string, note: string): void => {
    setPreview((was) => ({ ...was, state, note }));
  }, []);

  /** Empties the pane: nothing on the stage, and the list to go on with. */
  const showNothing = useCallback((note: string): void => {
    setPreview({ state: "empty", note, stageVisible: false });
  }, []);

  /**
   * Draws a `.glb` on the stage, making one the first time anything needs it.
   *
   * `fallback` is what a machine that cannot draw it is shown instead, which is the list on its
   * own and a sentence saying why.
   */
  const onStage = useCallback(async (
    glb: string,
    mine: number,
    state: string,
    note: string,
    fallback: (error: unknown) => void,
  ): Promise<void> => {
    const pane = stagePane.current;
    if (!pane) return;
    setPreview({ state: "loading", note: "Drawing it…", stageVisible: true });
    try {
      // One stage, and one attempt to make one: two quick toggles would otherwise each start a
      // renderer and the second would be left running with nothing pointing at it.
      starting.current ??= Promise.resolve(createStage(pane));
      stage.current = await starting.current;
      await stage.current.show(glbBytes(glb));
      if (mine === asked.current) setState(state, note);
    } catch (error: unknown) {
      if (mine === asked.current) fallback(error);
    }
  }, [createStage, setState]);

  /**
   * Puts an outfit on the character, or the bare body on the stage when there is no outfit.
   *
   * The two are one errand with two answers behind them, and the empty one is not a failure:
   * taking every piece off is a thing a reader does on purpose, and what is underneath is the
   * body the set is a set of clothes for.
   *
   * A machine with no working 3D, or an install this app cannot read the body out of, falls
   * back to the empty pane a set used to open on. That is a worse view of a set and not a
   * broken one: every row is still there, still named and still pictured.
   */
  const dress = useCallback((pieces: WornPiece[], count: number): void => {
    const mine = (asked.current += 1);
    const blank = (): void =>
      showNothing(count ? "Choose a piece to put it back on." : "");

    if (!pieces.length) {
      setState("loading", "Reading the character model…");
      character.current ??= loadCharacter();
      void character.current
        .then((body) => {
          if (mine !== asked.current) return;
          return onStage(body.model, mine, "character", REASONS.bare, blank);
        })
        .catch(() => {
          // The body is not worth an error where the set should be: it is the backdrop, and
          // what the reader opened the set for is the list under it.
          character.current = null;
          if (mine === asked.current) blank();
        });
      return;
    }

    const key = wornSetKey(pieces);
    const put = (glb: string | null): void => {
      // Nothing to show: the game gives this install nothing it could put on a character for
      // any of these pieces. The list and a sentence are what is left.
      if (glb === null) return showNothing(REASONS.unshowable);
      void onStage(glb, mine, "worn", REASONS.set, (error) => showNothing(message(error)));
    };

    const cached = outfits.get(key);
    if (cached !== undefined) return put(cached);

    setState("loading", "Putting the set on the character…");
    void loadWorn(pieces)
      .then((answer) => {
        outfits.set(key, answer.model);
        if (mine === asked.current) put(answer.model);
      })
      .catch((error: unknown) => {
        if (mine === asked.current) showNothing(message(error));
      });
  }, [loadCharacter, loadWorn, onStage, outfits, setState, showNothing]);

  // `showModal` and `close` are the dialog's own state and React has no prop for them, so the
  // element is driven here. The reverse direction is `onClose`, which Escape also reaches.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (set && !element.open) element.showModal();
    if (!set && element.open) element.close();
  }, [set]);

  // What the set is made of, from the cache where it has been read before and from the backend
  // where it has not. A reader who clicks through to another set while this one is still being
  // read is looking at that one, so a late answer for a set nobody is on is dropped.
  useEffect(() => {
    if (!set) return;
    setFailure("");
    const cached = known.get(set.id);
    if (cached) {
      setPayload(cached);
      return;
    }
    setPayload(null);
    let current = true;
    void load(set.id)
      .then((answer) => {
        known.set(set.id, answer);
        if (current) setPayload(answer);
      })
      .catch((error: unknown) => {
        if (current) setFailure(message(error));
      });
    return () => { current = false; };
  }, [set, load, known]);

  // Everything a drawn set does once: put the whole set on the character, and go and get the
  // pictures the rows are waiting on. Both are keyed on the pair — which set is open, and what
  // came back for it — because a set closed and opened again has to go back to the whole set
  // dressed, and a repaint that changed neither must not.
  useEffect(() => {
    if (!payload || !set || payload.setId !== set.id) return;
    const rows = appearanceRows(payload);
    // Everything the game says a place for, which is what a set opened *is*: a reader who
    // wants one piece takes the others off, rather than starting from nothing and building up.
    const dressed = new Set(
      rows.flatMap((row, index) => (wearable(row).kind === "worn" ? [index] : [])),
    );
    setWorn(dressed);
    dress(outfitOf(rows, dressed), rows.length);

    const wanted = iconIds(payload).filter((id) => !pictures.has(id));
    if (!wanted.length) return;
    void loadIcons(wanted)
      .then((answer) => {
        for (const [id, url] of Object.entries(answer.icons || {})) pictures.set(Number(id), url);
        redrawIcons();
      })
      // An icon is the one thing on a row that can be missing without the row losing its
      // point, so a picture that will not come stays an empty frame rather than an error where
      // the set used to be.
      .catch(() => {});
  }, [set, payload, dress, loadIcons, pictures]);

  // The graphics context goes back when the dialog does. A reader who opens a set, turns it
  // around and closes it should be left holding nothing.
  useEffect(() => {
    if (set) return;
    asked.current += 1;
    stage.current?.dispose();
    stage.current = null;
    starting.current = null;
    setWorn(NOTHING);
    setPreview(EMPTY_PREVIEW);
  }, [set]);

  /** Takes a piece off the character, or puts it back, and shows what that leaves. */
  function toggle(index: number): void {
    const next = new Set(worn);
    if (!next.delete(index)) next.add(index);
    setWorn(next);
    dress(outfitOf(rows, next), rows.length);
  }

  return (
    <dialog id="transmog-detail" aria-labelledby="transmog-detail-title" ref={dialog} onClose={onClose}>
      <div className="detail-head">
        <div>
          <h2 className="detail-title" id="transmog-detail-title">
            {set ? set.name || `Set ${set.id}` : ""}
          </h2>
          <span className="detail-position">{set ? whereItSits(set) : ""}</span>
        </div>
        <div className="detail-nav">
          <button type="button" aria-label="Close set" onClick={onClose}>Close</button>
        </div>
      </div>
      {/* The preview sits above the list and outside the part that is redrawn, because the 3D
          pane holds a graphics context and rebuilding it per set would hand out a new one each
          time. Its state says what it is showing: nothing yet, the set worn, or a bare body. */}
      <div className="mog-preview" data-state={preview.state}>
        <div className="mog-stage" hidden={!preview.stageVisible} ref={stagePane} />
        <p className="mog-note muted" role="status">{preview.note}</p>
      </div>
      <div className="detail-body">
        {failure ? <p className="muted">{failure}</p> : null}
        {!failure && !payload ? <p className="muted">Reading what the set is made of…</p> : null}
        {payload ? <>
          <p className="detail-facts">{appearanceSummary(payload)}</p>
          {rows.length
            ? <ul className="mog-items">
              {rows.map((row, index) => (
                <Line
                  key={`${row.appearanceId}-${index}`} row={row} worn={worn.has(index)}
                  icon={pictures.get(row.iconFileDataId)} onToggle={() => toggle(index)}
                />
              ))}
            </ul>
            : null}
        </> : null}
      </div>
    </dialog>
  );
}

/** Where a set sits, as the line under its name reads. */
function whereItSits(set: TransmogSet): string {
  const patch = patchName(set.patchIntroduced);
  return [
    set.group,
    classLabel(set.classMask),
    expansionName(set.expansionId),
    patch ? `Patch ${patch}` : "",
  ].filter(Boolean).join(" · ");
}

/** One appearance, pictured and named as far as the tables allow, and linked out for the rest. */
function Line(
  { row, worn, icon, onToggle }:
  { row: AppearanceRow; worn: boolean; icon?: string; onToggle: () => void },
): ReactNode {
  // Whether the character can wear it at all, which is a fact about the game rather than about
  // this install: an appearance the game encrypts, and a thing it files under a weapon slot and
  // gives nobody a place to hold. Those rows keep their place in the list — the set's own count
  // includes them — and say why they are not on her instead of being a button that does nothing.
  const wanted = wearable(row);
  const canWear = wanted.kind === "worn";

  // An empty frame either way. A row whose appearance names no icon keeps it so the list stays
  // a column of pictures rather than one that indents wherever the game said nothing. The
  // picture is decorative: the row already says which slot it is and which item it came from.
  return (
    <li className="mog-item">
      {/* The picture and the slot together are the button, and the item name stays a link
          beside it: one changes what she is wearing and the other leaves the app, and a
          reader is entitled to tell which is which before clicking. */}
      <button
        type="button" className="mog-pick" aria-pressed={worn} disabled={!canWear}
        aria-label={`Wear ${row.slot}: ${row.label}`} onClick={onToggle}
      >
        <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>
        <span className="badge">{row.slot}</span>
      </button>
      {row.withheld
        ? <span className="muted">{row.label}</span>
        : <a href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
          target="_blank" rel="noopener noreferrer">{row.label}</a>}
      {row.hasModel ? <span className="chip">has its own model</span> : null}
      {/* A withheld row already says so where its name would be, and saying it twice is two
          elements with the same sentence in them rather than one clearer row. */}
      {canWear || row.withheld ? null : <span className="muted">{wanted.note}</span>}
      {row.appearanceId ? <span className="muted">appearance {row.appearanceId}</span> : null}
    </li>
  );
}

/**
 * The renderer, fetched the first time a reader asks to see something in 3D.
 *
 * three.js is most of a megabyte and the app opens on a timeline that has no use for it, so it
 * is a chunk of its own rather than part of the window's first load. Nobody who never opens a
 * model ever downloads it.
 */
const lazyStage = (container: HTMLElement): Promise<ModelStage> =>
  import("./modelViewer").then((viewer) => viewer.createModelStage(container));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
