/**
 * One transmog set, opened: what the game says it is made of, and what it looks like.
 *
 * `transmogModal.ts` decides how a payload reads as rows; this is the dialog over it, and the
 * one view in the app that asks for something after the page has loaded — so it is the one
 * with a loading state and a failure to draw.
 *
 * The pane above the list opens on the character rather than on nothing, because that is what
 * the set is a set of clothes for: a bare Human Female, asked for once for the whole app and
 * shown for every set after. Picking a row then shows that appearance the way the game itself
 * would: a helm as the helm, and everything painted onto a body — which is eight of the twelve
 * slots — on the body, worn.
 *
 * Almost everything below is kept in refs rather than in state, and deliberately: the caches
 * are what stop a reader clicking down a set from re-reading the game's storage per row, the
 * stage is a graphics context a browser will only hand out so many of, and the counter is what
 * decides which of several answers in flight is the one still being waited for. None of those
 * are things to draw, and turning them into state would redraw the pane for each of them.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { glbBytes, previewFor, REASONS } from "./modelPreview";
import type { ModelStage } from "./modelViewer";
import { classLabel, expansionName, patchName } from "./transmog";
import { appearanceRows, appearanceSummary, iconIds } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type {
  CharacterModelPayload,
  IconsPayload,
  TransmogModelPayload,
  TransmogSet,
  TransmogSetItemsPayload,
  WornModelPayload,
} from "./types";

export interface TransmogDetailProps {
  /** The set the dialog is showing, or null when it is closed. */
  set: TransmogSet | null;
  onClose: () => void;
  /** Asks the backend what a set is made of. Passed in so the dialog is drivable without one. */
  load: (setId: number) => Promise<TransmogSetItemsPayload>;
  /** Asks the backend for the pictures those rows need, decoded out of the game's textures. */
  loadIcons: (iconFileDataIds: number[]) => Promise<IconsPayload>;
  /** Asks for one appearance's model, converted to something a browser can load. */
  loadModel: (displayInfoId: number) => Promise<TransmogModelPayload>;
  /** Asks for the bare body a set opens on. One model for the whole app. */
  loadCharacter: () => Promise<CharacterModelPayload>;
  /** Asks for that body with one appearance composited onto it, which is how armour is shown. */
  loadWorn: (displayInfoId: number, displayType: number) => Promise<WornModelPayload>;
  /**
   * Makes the 3D pane. Passed in because it is the one thing here that needs a graphics card:
   * a machine without working 3D throws, and the reader gets the icon instead.
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

export function TransmogDetail(
  {
    set, onClose, load, loadIcons, loadModel, loadCharacter, loadWorn, createStage = lazyStage,
  }: TransmogDetailProps,
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
  // The models, by the display they were asked for under. `null` is an answer: this install
  // has nothing to show for that appearance, and asking again would say the same.
  const models = useRef(new Map<number, string | null>()).current;
  // The same, for the bodies wearing one appearance. Kept apart from the models above because
  // a display id means a different picture in each: the item alone, and the item on somebody.
  const wornModels = useRef(new Map<number, string | null>()).current;
  // The bare body, asked for once and kept for as long as the app runs. It is one model for
  // every set there is, and the read behind it is the game's own storage.
  const character = useRef<Promise<CharacterModelPayload> | null>(null);
  // One stage for as long as the dialog is open. Each one is a graphics context of its own,
  // and a browser will only hand out so many before it starts taking them back.
  const stage = useRef<ModelStage | null>(null);
  const starting = useRef<Promise<ModelStage> | null>(null);
  // Which pick the pane is currently answering. A reader clicking down a set faster than the
  // models arrive would otherwise be shown whichever finished last.
  const asked = useRef(0);

  const [payload, setPayload] = useState<TransmogSetItemsPayload | null>(null);
  const [failure, setFailure] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW);
  // The row the pane is showing as a picture, so a late-arriving icon lands in it.
  const [still, setStill] = useState<AppearanceRow | null>(null);
  // The pictures live outside React, in a cache shared by every set — so a batch arriving
  // changes nothing React would notice, and this is what puts them into the frames waiting.
  const [, redrawIcons] = useReducer((count: number) => count + 1, 0);

  const rows = payload ? appearanceRows(payload) : [];

  const setState = useCallback((state: string, note: string): void => {
    setPreview((was) => ({ ...was, state, note }));
  }, []);

  /** The still picture: an appearance's icon, and a sentence saying why it is not a model. */
  const showStill = useCallback((row: AppearanceRow, note: string): void => {
    setStill(row);
    setPreview({ state: "still", note, stageVisible: false });
  }, []);

  /** Empties the pane: nothing on the stage, nothing in the frame, and the list to go on with. */
  const showNothing = useCallback((note: string): void => {
    setStill(null);
    setPreview({ state: "empty", note, stageVisible: false });
  }, []);

  /**
   * Draws a `.glb` on the stage, making one the first time anything needs it.
   *
   * `fallback` is what a machine that cannot draw it is shown instead, and is the only
   * difference between an appearance's model and the body: one has an icon to fall back to and
   * the other has nothing.
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
    setStill(null);
    setPreview({ state: "loading", note: "Drawing it…", stageVisible: true });
    try {
      // One stage, and one attempt to make one: two quick picks would otherwise each start a
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
   * The body a set is opened on: the character with nothing worn, before a row is picked.
   *
   * Asked for once for the whole app rather than per set, because it is the same Human Female
   * every time — so every set after the first opens on it without another read of the game's
   * storage.
   *
   * A machine with no working 3D, or an install this app cannot read the body out of, falls
   * back to the empty pane a set used to open on. That is a worse view of a set and not a
   * broken one: every row is still there, and every row that has a model of its own still
   * shows it.
   */
  const showCharacter = useCallback((count: number): void => {
    const mine = (asked.current += 1);
    setPicked(null);
    setStill(null);
    setState("loading", "Reading the character model…");
    character.current ??= loadCharacter();
    const blank = (): void =>
      showNothing(count ? "Choose an appearance to see it up close." : "");
    void character.current
      .then((model) => {
        if (mine !== asked.current) return;
        return onStage(model.model, mine, "character", "Nothing is worn yet. Drag to turn it.", blank);
      })
      .catch(() => {
        // The body is not worth an error where the set should be: it is the backdrop, and what
        // the reader opened the set for is the list under it.
        character.current = null;
        if (mine === asked.current) blank();
      });
  }, [loadCharacter, onStage, setState, showNothing]);

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

  // Everything a drawn set does once: put the body on the stage, and go and get the pictures
  // the rows are waiting on. Both are keyed on the pair — which set is open, and what came
  // back for it — because a set closed and opened again has to go back to the body, and a
  // repaint that changed neither must not.
  useEffect(() => {
    if (!payload || !set || payload.setId !== set.id) return;
    showCharacter(appearanceRows(payload).length);
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
  }, [set, payload, showCharacter, loadIcons, pictures]);

  // The graphics context goes back when the dialog does. A reader who opens a set, looks at a
  // helm and closes it should be left holding nothing.
  useEffect(() => {
    if (set) return;
    asked.current += 1;
    stage.current?.dispose();
    stage.current = null;
    starting.current = null;
    setPicked(null);
    setStill(null);
    setPreview(EMPTY_PREVIEW);
  }, [set]);

  /**
   * Shows one appearance the way the game itself would: on its own where it has geometry of
   * its own, and worn on the character where it has none.
   *
   * Which of those it is comes out of `previewFor`, and it is a fact about the game's files
   * rather than about this install. A chestpiece is not a failed model — it is texture painted
   * onto a body, and the body is where it becomes something to look at.
   */
  function pick(index: number): void {
    const row = rows[index];
    if (!row) return;
    const mine = (asked.current += 1);
    setPicked(index);

    const wanted = previewFor(row);
    if (wanted.kind === "icon" || wanted.kind === "none") return showStill(row, wanted.note);

    // The two are the same errand with different answers behind them: read one `.glb`, put it
    // on the stage, and fall back to the icon if there is nothing to put there.
    const worn = wanted.kind === "worn";
    const cache = worn ? wornModels : models;
    const cached = cache.get(wanted.displayInfoId);
    if (cached !== undefined) {
      void showModel(row, cached, mine, worn);
      return;
    }

    setState("loading", worn
      ? `Putting ${row.label.toLowerCase()} on the character…`
      : `Reading the model of ${row.label.toLowerCase()}…`);
    const loading = worn
      ? loadWorn(wanted.displayInfoId, wanted.displayType)
      : loadModel(wanted.displayInfoId);
    void loading
      .then((answer) => {
        cache.set(wanted.displayInfoId, answer.model);
        if (mine === asked.current) void showModel(row, answer.model, mine, worn);
      })
      .catch((error: unknown) => {
        if (mine === asked.current) showStill(row, message(error));
      });
  }

  /** Puts a loaded model on the stage, or falls back to the icon when there is none. */
  async function showModel(
    row: AppearanceRow, glb: string | null, mine: number, worn: boolean,
  ): Promise<void> {
    // Nothing to show: the game gives this install no model for the appearance, or nothing it
    // could put on a character. The icon and a sentence are what is left either way.
    // Two ways an install can hold nothing to show, and they are not the same sentence. A
    // slot with geometry is missing a *file*; one without is missing every picture its
    // textures name, which is what a body painted for somebody else leaves behind.
    if (glb === null) {
      return showStill(row, row.hasModel ? REASONS.absent : REASONS.unpaintable);
    }
    // Either the model would not load or the machine has no working 3D at all — a remote
    // desktop, a virtual machine, a driver the browser has blocklisted. Both leave the reader
    // better off with the icon and a sentence than with an empty rectangle.
    const note = worn ? REASONS.worn : "Drag to turn it.";
    await onStage(glb, mine, worn ? "worn" : "model", note, (error) => showStill(row, message(error)));
  }

  const stillPicture = still ? pictures.get(still.iconFileDataId) : undefined;

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
          time. Its state says what it is showing: nothing yet, a model, or a picture. */}
      <div className="mog-preview" data-state={preview.state}>
        <div className="mog-stage" hidden={!preview.stageVisible} ref={stagePane} />
        <div className="mog-still">
          {stillPicture ? <img src={stillPicture} alt="" /> : null}
        </div>
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
                  key={`${row.appearanceId}-${index}`} row={row} pressed={picked === index}
                  icon={pictures.get(row.iconFileDataId)} onPick={() => pick(index)}
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
  { row, pressed, icon, onPick }:
  { row: AppearanceRow; pressed: boolean; icon?: string; onPick: () => void },
): ReactNode {
  // An empty frame either way. A row whose appearance names no icon keeps it so the list stays
  // a column of pictures rather than one that indents wherever the game said nothing. The
  // picture is decorative: the row already says which slot it is and which item it came from.
  return (
    <li className="mog-item">
      {/* The picture and the slot together are the button, and the item name stays a link
          beside it: one leads out of the app and the other stays in it, and a reader is
          entitled to tell which is which before clicking. */}
      <button
        type="button" className="mog-pick" aria-pressed={pressed}
        aria-label={`Preview ${row.slot}: ${row.label}`} onClick={onPick}
      >
        <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>
        <span className="badge">{row.slot}</span>
      </button>
      {row.withheld
        ? <span className="muted">{row.label}</span>
        : <a href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
          target="_blank" rel="noopener noreferrer">{row.label}</a>}
      {row.hasModel ? <span className="chip">has its own model</span> : null}
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
