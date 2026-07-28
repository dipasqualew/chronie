/**
 * Every appearance the game holds for one kind of place, as a list to dress a character from.
 *
 * The other half of the transmog browser. The sets beside it are somebody at Blizzard's idea
 * of an outfit; this is the game's whole wardrobe, cut by the kind of thing rather than by who
 * put it in a set — which is the only way to reach the several thousand looks no set names.
 * What a kind is and what a filter leaves is `wardrobe.ts`; what happens when a row is clicked
 * is `outfit.ts`, the same as for a set, and deliberately: the character does not care which
 * half of the view a look came out of.
 *
 * Two things about this list are load-bearing, and both are consequences of its size. **It is
 * read a kind at a time**, because the whole wardrobe is fifty-five thousand looks and fourteen
 * megabytes, and **it is drawn a page at a time**, because five thousand rows of buttons and
 * icons is a second of stutter to show a reader forty screens they did not ask for. What was
 * already read stays read: the seventeen kinds of weapon are one answer, so going from staves
 * to daggers is a filter rather than a second trip to the game's storage.
 *
 * And then the third way of looking at it: **as pictures of the thing**. An icon is what the game
 * puts in a bag slot and it is 64 pixels of squint; the same look shown drawn is what the game's
 * own wardrobe shows, and it is the only way to tell two brown chestpieces apart. It is off by
 * default and the page shrinks to a fifth when it is on, because a row of names is a string and a
 * row of models is geometry read out of the game's files. `gallery.ts` decides what a page is
 * and where a camera looks; `galleryStage.ts` draws them, all on one graphics context.
 *
 * Turned on, the list stops being a list. A row becomes a tile with the picture across the whole
 * of it and the name, the marks and the rest underneath — because the picture is what the reader
 * turned this on to look at, and a hundred pixels of it beside a column of text is not looking.
 * The tile is also **turnable**: dragging across the picture orbits it, through the same one
 * off-screen context every other tile is drawn through and with nothing running between drags.
 * `galleryStage.ts` is where that claim is kept.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import {
  PAGE as GALLERY_PAGE, focusOf, piecesOf, stillWanted, turnedBy,
} from "./gallery";
import type { Focus, Thumbnail } from "./gallery";
import type { GalleryStage } from "./galleryStage";
import { NO_MARK_FILTER, tagChoices } from "./marks";
import type { MarkIndex } from "./marks";
import { MarkControls, MarkFilters } from "./marksEditor";
import type { MarkActions } from "./marksEditor";
import { REASONS, glbBytes, wearable as canBeWorn } from "./modelPreview";
import { isWorn, onlyWearable } from "./outfit";
import type { Outfit } from "./outfit";
import { NO_QUALITIES, indexQualities, loadQualities as loadStore } from "./qualities";
import type { QualityIndex } from "./qualities";
import { Qualities } from "./qualitiesChips";
import { CLASSES } from "./transmog";
import { LinkOut } from "./ui";
import { ANY_CLASS, qualityLabel, wearerLabel } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import {
  KINDS, PAGE, answerKey, filterAppearances, kindOf, shownSummary, wardrobeRow,
} from "./wardrobe";
import type { Kind } from "./wardrobe";
import type {
  GalleryKind, GalleryPayload, QualitiesFile, Quality, TransmogMark, WardrobePayload, WornPiece,
} from "./types";

export interface WardrobeListProps {
  /** Whether the reader is looking at the sets instead, which is what keeps this unread. */
  hidden: boolean;
  /** Asks the backend for every look filling these display types. */
  load: (displayTypes: number[]) => Promise<WardrobePayload>;
  /** Asks for the pictures the drawn rows are waiting on, which the view above caches. */
  wantIcons: (iconFileDataIds: number[]) => void;
  icons: Map<number, string>;
  outfit: Outfit;
  /** Whether the rows with nowhere to go are left out, which the whole view decides. */
  hideUnwearable: boolean;
  onHideUnwearable: (hide: boolean) => void;
  /** The three ways a mark is written, which the view above owns because it holds the payload. */
  marks: MarkActions;
  /**
   * And what has been said already, indexed.
   *
   * Shared with the set browser rather than read again here, and that sharing is the feature:
   * both halves key a look by its appearance id, so a piece starred inside a set is starred in
   * this list and the other way round.
   */
  index: MarkIndex;
  onWear: (row: AppearanceRow) => void;
  /** Asks the backend for a page of the wardrobe worn, which is what the gallery draws. */
  loadGallery: (pieces: WornPiece[]) => Promise<GalleryPayload>;
  /**
   * Who the bodies in that gallery are, as a string that changes when she does — `herself.ts`.
   *
   * Every thumbnail is a picture of her wearing one thing, so answering a question about her
   * body makes all of them pictures of somebody else. This is the only use for it here: the
   * page is asked for again, and the backend applies the answers it holds.
   */
  look: string;
  /**
   * Makes the one graphics context the whole grid is drawn through.
   *
   * Injected for the same reason the pane's stage is: it is the one thing here that needs a
   * graphics card, so a test can hand over something that draws nothing and a machine that has
   * no working 3D at all can go without.
   */
  createGalleryStage?: () => GalleryStage | Promise<GalleryStage>;
  /**
   * The committed measurements for one slot — see `qualities.ts`.
   *
   * Injected for the reason the stage is, and with a second reason of its own: the real one
   * pulls in a few hundred kilobytes of JSON per slot, and a test that wanted three rows would
   * otherwise load the whole game's chestpieces to draw them.
   */
  loadQualities?: (displayType: number) => Promise<QualitiesFile | null>;
}

/** What the list says while the game's tables are being read for a kind. */
const READING = "Reading every appearance the game has for this…";

export function WardrobeList(
  {
    hidden, load, wantIcons, icons, outfit, hideUnwearable, onHideUnwearable, marks, index,
    onWear, loadGallery, look, createGalleryStage = lazyGalleryStage,
    loadQualities = loadStore,
  }: WardrobeListProps,
): ReactNode {
  const [kindKey, setKindKey] = useState(KINDS[0]!.key);
  const [search, setSearch] = useState("");
  const [klass, setKlass] = useState("");
  /** Whether the looks are drawn worn rather than as their bag icons. */
  const [asModels, setAsModels] = useState(false);
  const [shown, setShown] = useState(PAGE);
  /** What this list is narrowed to beyond what the game says. The sets beside it keep own. */
  const [marked, setMarked] = useState(NO_MARK_FILTER);

  // What has been read, by the answer rather than by the kind: seventeen kinds of weapon are
  // one payload. Kept outside React for the reason the sets' cache is — an answer landing is
  // not a redraw, the counter below is what says one happened — and a string in there is the
  // sentence saying why a kind could not be read.
  const answers = useRef(new Map<string, WardrobePayload | string>()).current;
  const asked = useRef(new Set<string>()).current;
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  // What was measured of the looks in each slot, by the slot. Kept outside React the way the
  // answers are, and keyed by the display type rather than by the answer: the seventeen kinds of
  // weapon share one payload but are five files, because the store is written a slot at a time.
  const measured = useRef(new Map<number, QualityIndex>()).current;
  const wanting = useRef(new Set<number>()).current;

  const kind = kindOf(kindKey);
  const key = answerKey(kind);
  const answer = answers.get(key);

  const read = useCallback((wanted: Kind): void => {
    const wantedKey = answerKey(wanted);
    if (asked.has(wantedKey)) return;
    asked.add(wantedKey);
    void load(wanted.displayTypes)
      .then((payload) => answers.set(wantedKey, payload))
      .catch((error: unknown) => answers.set(wantedKey, message(error)))
      .finally(redraw);
  }, [load, answers, asked]);

  // Nothing is read until the reader asks to see it. The wardrobe costs the same second of
  // the game's storage the sets do, and a reader who never leaves the sets never pays it.
  useEffect(() => {
    if (!hidden) read(kind);
  }, [hidden, kind, read]);

  // And the same for what was measured of them, for the same reason twice over: a slot's file is
  // a few hundred kilobytes of JavaScript, and a reader who never opens the wardrobe downloads
  // none of it. A file that will not load leaves an empty index rather than an error — the rows
  // are the game's and draw without it.
  useEffect(() => {
    if (hidden) return;
    for (const displayType of kind.displayTypes) {
      if (wanting.has(displayType)) continue;
      wanting.add(displayType);
      void loadQualities(displayType)
        .then((file) => measured.set(displayType, indexQualities(file)))
        .catch(() => measured.set(displayType, NO_QUALITIES))
        .finally(redraw);
    }
  }, [hidden, kind, loadQualities, measured, wanting]);

  /**
   * What was measured of one look, wherever among the slot's files it landed.
   *
   * A search across the seventeen kinds of weapon is one payload over five files, and a look
   * belongs to exactly one of them — so the first that holds it is the answer.
   */
  const qualityOf = useCallback((appearanceId: number) => {
    for (const displayType of kind.displayTypes) {
      const found = measured.get(displayType)?.of(appearanceId);
      if (found) return found;
    }
    return undefined;
  }, [kind, measured]);

  // Only the tags written against a look this kind actually holds, so a reader browsing heads
  // is not offered the one they invented for staves and then shown nothing. The whole answer
  // rather than the filtered list, so the picker does not shrink as it is used.
  const tags = useMemo(
    () => (typeof answer === "object"
      ? tagChoices(index, "appearance", answer.appearances.map((one) => one.appearanceId))
      : []),
    [index, answer],
  );

  const looks = typeof answer === "object"
    ? filterAppearances(answer.appearances, {
      kind, search, klass, marks: { filter: marked, of: (id) => index.of("appearance", id) },
      qualities: qualityOf,
    })
    : [];
  const rows = looks.map((look) => wardrobeRow(look));
  // Whatever cannot go on her is left out unless the box above says otherwise — the same
  // statement about what a reader is here for that the sets are filtered by.
  const kept = hideUnwearable ? onlyWearable(rows) : rows;
  const page = asModels ? GALLERY_PAGE : PAGE;
  const drawn = kept.slice(0, shown);

  // The pictures for what is actually on screen, and nothing else: a kind holds thousands of
  // rows and decoding a texture for each would be a minute of work nobody asked for.
  const waiting = drawn.map((row) => row.iconFileDataId).filter((id) => id > 0);
  const waitingKey = waiting.join(",");
  useEffect(() => {
    if (waiting.length) wantIcons(waiting);
    // The ids rather than the array, which is new on every render and would ask every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, wantIcons]);

  // The bodies, by the display each is drawn from. Kept outside React for the reason the answers
  // are — one arriving is not a redraw, the counter says one happened — and kept across a change
  // of kind, because the same helm is under Head and inside three sets and is one picture.
  const bodies = useRef(new Map<number, Thumbnail>()).current;
  // Of whichever woman they were drawn of. Written during the render rather than in an effect
  // of its own, so that the request below is made once, for the page as it now is: an effect
  // that emptied the map afterwards would leave this one having already decided nothing was
  // missing.
  const drawnOf = useRef(look);
  if (drawnOf.current !== look) {
    drawnOf.current = look;
    bodies.clear();
  }
  const wanted = asModels ? piecesOf(drawn) : [];
  const wantedKey = wanted.map((piece) => piece.displayInfoId).join(",");
  useEffect(() => {
    const missing = stillWanted(wanted, bodies);
    if (!missing.length) return;
    for (const piece of missing) bodies.set(piece.displayInfoId, { kind: "wanted" });
    void loadGallery(missing)
      .then((payload) => {
        for (const row of payload.models) {
          bodies.set(row.displayInfoId, row.model
            ? { kind: "model", glb: row.model, shows: row.kind }
            : { kind: "nothing", note: REASONS.unshowable });
        }
      })
      // A page that will not come leaves its rows saying so rather than waiting for ever. The
      // icons are still there, which is what the list had before any of this.
      .catch(() => {
        for (const piece of missing) {
          bodies.set(piece.displayInfoId, { kind: "nothing", note: REASONS.unshowable });
        }
      })
      .finally(redraw);
    // The display ids rather than the array, which is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, look, loadGallery, bodies]);

  // One graphics context for the whole grid, made the first time a picture is wanted and given
  // back when the reader turns the gallery off. Twenty contexts is more than a browser hands
  // out, which is a grid whose top rows go black as its bottom rows fill in.
  //
  // **The promise is what is held on to, not the stage.** Making one is asynchronous — the
  // module it comes out of is imported on demand — so there is a window between "a tile asked
  // for a picture" and "there is a renderer", and a reader can turn the gallery off inside it.
  // Disposing whatever had finished being made by then would let a context started in that
  // window escape with nothing left pointing at it, which is a leak that never shows up as a
  // leak: the browser just hands out one fewer next time. Awaiting it here disposes the one
  // that was on its way as surely as the one that had arrived.
  const starting = useRef<Promise<GalleryStage> | null>(null);
  useEffect(() => {
    if (!asModels) return undefined;
    // Fires when the gallery is turned off, and when the view goes away with it left on.
    return () => {
      const pending = starting.current;
      starting.current = null;
      // A stage that could not be made at all — a machine with no working 3D — is nothing to
      // give back, and the tiles have already shown what that means.
      if (pending) void pending.then((made) => made.dispose()).catch(() => undefined);
    };
  }, [asModels]);
  const paint = useCallback(async (
    target: HTMLCanvasElement, bytes: Uint8Array, focus: Focus, turn: number,
  ): Promise<void> => {
    // One stage, and one attempt to make one: twenty rows painting at once would otherwise
    // each start a context of their own, which is the thing this exists to avoid.
    starting.current ??= Promise.resolve(createGalleryStage());
    const made = await starting.current;
    await made.paint(target, bytes, focus, turn);
  }, [createGalleryStage]);

  /** Every narrowing starts the list again from the top, where the reader is looking. */
  const narrow = (change: () => void): void => {
    change();
    setShown(page);
  };

  return (
    <section className="panel mog-browser" id="wardrobe" hidden={hidden}>
      <div className="table-head">
        <div className="controls">
          {/* The kinds are grouped because seventeen weapons in one flat list of thirty is a
              list nobody reads to the end of. */}
          <select
            id="wardrobe-kind" aria-label="Kind of appearance" value={kindKey}
            onChange={(event) => narrow(() => setKindKey(event.target.value))}
          >
            {groups().map((group) => (
              <optgroup key={group.name} label={group.name}>
                {group.kinds.map((one) => (
                  <option key={one.key} value={one.key}>{one.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <input
            id="wardrobe-search" type="search" placeholder="Filter by name…"
            aria-label="Filter appearances" value={search}
            onChange={(event) => narrow(() => setSearch(event.target.value))}
          />
          <select
            id="wardrobe-class" aria-label="Class" value={klass}
            onChange={(event) => narrow(() => setKlass(event.target.value))}
          >
            <option value="">All classes</option>
            {CLASSES.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <label className="mog-hide">
            <input
              type="checkbox" id="wardrobe-hide-unwearable" checked={hideUnwearable}
              onChange={(event) => onHideUnwearable(event.target.checked)}
            />
            Hide what she cannot wear
          </label>
          {/* Beside it, because both are statements about what a reader is here for. Turning it
              on shortens the page to a fifth: twenty bodies is what the backend draws in about
              the time one takes, and a hundred is not. */}
          <label className="mog-hide">
            <input
              type="checkbox" id="wardrobe-as-models" checked={asModels}
              onChange={(event) => {
                // Not through `narrow`, which puts the list back to *this* mode's page: the
                // whole point of the switch is that the page after it is a different size, and
                // going from names to models has to shrink the list rather than draw a hundred
                // bodies once.
                setAsModels(event.target.checked);
                setShown(event.target.checked ? GALLERY_PAGE : PAGE);
              }}
            />
            Show worn
          </label>
          <MarkFilters
            scope="wardrobe" favourite={marked.favourite} tag={marked.tag} choices={tags}
            onFavourite={(only) => narrow(() => setMarked((was) => ({ ...was, favourite: only })))}
            onTag={(tag) => narrow(() => setMarked((was) => ({ ...was, tag })))}
          />
          <span className="count" id="wardrobe-count">
            {typeof answer === "object"
              ? shownSummary(drawn.length, kept.length, answer.withheldCount)
              : ""}
          </span>
        </div>
      </div>
      <div className="mog-list" id="wardrobe-list" data-models={asModels}>
        {answer === undefined ? <p className="muted">{READING}</p> : null}
        {typeof answer === "string" ? <p className="muted">{answer}</p> : null}
        <ul className="mog-items">
          {drawn.map((row) => (
            <Look
              key={row.appearanceId} row={row} worn={isWorn(outfit, row)}
              icon={icons.get(row.iconFileDataId)} marks={marks}
              mark={index.of("appearance", row.appearanceId)}
              quality={qualityOf(row.appearanceId)} onWear={() => onWear(row)}
              body={asModels ? bodies.get(row.displayInfoId) : undefined} paint={paint}
            />
          ))}
        </ul>
        {/* What is left, and the way to it. A number rather than an endless scroll, because
            the honest answer to "how much more of this is there" is four thousand. */}
        {kept.length > drawn.length
          ? <button
            type="button" className="mog-more"
            onClick={() => setShown((was) => was + page)}
          >{`Show ${Math.min(page, kept.length - drawn.length)} more of ${plural(kept.length - drawn.length, "appearance")}`}</button>
          : null}
      </div>
      <div className="empty" hidden={typeof answer !== "object" || kept.length > 0}>
        <p className="empty-title">Nothing matches</p>
        <p>Try a different search, class or kind of appearance.</p>
      </div>
    </section>
  );
}

/**
 * One look, as something to put on: the same row a set draws, with what a set cannot say.
 *
 * Two shapes, and the switch between them is `body` having arrived. **As a row**, the picture is
 * a 32-pixel icon and the whole row is one button, because the row is a line of text and putting
 * the piece on is what a reader opened the list to do. **As a tile**, the picture is the width of
 * the tile and everything else is underneath it — and the picture is no longer part of the
 * button, because it has become something to drag. A click that turned out to be a drag would
 * otherwise put a piece on the character every time somebody looked at the back of a helm.
 */
function Look(
  { row, worn, icon, marks, mark, quality, onWear, body, paint }: {
    row: AppearanceRow;
    worn: boolean;
    icon?: string;
    marks: MarkActions;
    /** The same mark a set's row of this look draws, because both key on the appearance. */
    mark: TransmogMark | undefined;
    /** What the committed store measured of it, or nothing where it holds no row. */
    quality: Quality | undefined;
    onWear: () => void;
    /**
     * The picture of this look, when the gallery is on and one has arrived.
     *
     * `undefined` is the gallery being off, and the row keeps the icon it always had.
     */
    body: Thumbnail | undefined;
    paint: Paint;
  },
): ReactNode {
  const wanted = canBeWorn(row);
  const canWear = wanted.kind === "worn";
  const source = row.sources[0]!;
  const shown = body?.kind === "model" ? body : null;
  /* In the colour the game writes the name in, which is the fastest thing to read in a list of
     a thousand — and the stylesheet's job rather than an inline style, because the packaged
     app's CSP drops those. The same arrangement `GameItem` uses. */
  const name = (
    <span
      className="mog-name" data-quality={String(source.quality)}
      title={`${row.label} · ${qualityLabel(source.quality)}`}
    >{row.label}</span>
  );
  const said = <>
    {worn ? <span className="chip">worn</span> : null}
    {/* Before what the reader said about it, because it is of the same kind as the game's own
        facts beside it — measured rather than typed — and because it is what the eye is
        actually looking for in a list of five thousand chestpieces. */}
    <Qualities quality={quality} />
    <MarkControls
      kind="appearance" id={row.appearanceId} mark={mark} name={row.label} actions={marks}
    />
    {source.allowableClass !== 0 && source.allowableClass !== ANY_CLASS
      ? <span className="chip">{wearerLabel(source.allowableClass)}</span>
      : null}
    {row.liftsRestriction
      ? <span className="chip mog-lifted" title="Another item gives this look to any class">
        Any class too
      </span>
      : null}
    {/* How many items sell the look. A count and not a way in: a set can afford to name the
        items behind each of its dozen looks, and a slot holding five thousand cannot. */}
    {source.itemCount > 1
      ? <span className="chip muted">{`${source.itemCount} items`}</span>
      : null}
    {canWear ? null : <span className="muted">{wanted.note}</span>}
    <a
      className="mog-wowhead" href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
      target="_blank" rel="noopener noreferrer" title={`${row.label} on Wowhead`}
      aria-label={`${row.label} on Wowhead`}
    ><LinkOut /></a>
  </>;

  if (shown) {
    return (
      <li className="mog-item mog-tile" data-worn={worn}>
        <Turnable
          glb={shown.glb} shows={shown.shows} displayType={row.displayType}
          label={row.label} paint={paint}
        />
        <button
          type="button" className="mog-pick" aria-pressed={worn} disabled={!canWear}
          aria-label={`Wear ${row.slot}: ${row.label}`} onClick={onWear}
        >
          <span className="badge">{row.slot}</span>
          {name}
        </button>
        <div className="mog-said">{said}</div>
      </li>
    );
  }

  return (
    <li className="mog-item" data-worn={worn}>
      {/* The whole row is one button — picture, slot and name — because putting the piece on is
          what a reader opened the list to do. */}
      <button
        type="button" className="mog-pick" aria-pressed={worn} disabled={!canWear}
        aria-label={`Wear ${row.slot}: ${row.label}`} onClick={onWear}
      >
        <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>
        <span className="badge">{row.slot}</span>
        {name}
      </button>
      {said}
    </li>
  );
}

/** What a tile does to get itself drawn, which is the one thing here that needs a graphics card. */
type Paint = (
  target: HTMLCanvasElement, bytes: Uint8Array, focus: Focus, turn: number,
) => Promise<void>;

/**
 * One tile's picture, turnable.
 *
 * A plain canvas painted by the grid's one stage: what is on it between drags is a bitmap, so a
 * page of twenty costs one context and twenty images rather than twenty live scenes. There is no
 * animation loop here and no `requestAnimationFrame` — a tile nobody is touching does no work at
 * all, which is the property that makes twenty of them affordable.
 *
 * **A drag is a queue of one.** Pointer moves arrive faster than a render finishes, so the angle
 * the reader has asked for is written into `wanted` and a single pump drains it. Whatever
 * arrived while a paint was in flight collapses to the last of them, which is the only one worth
 * drawing — the alternative is a queue of stale angles the picture works through after the hand
 * has stopped.
 *
 * The bytes are decoded once and kept, because the stage recognises the model it is already
 * holding by the identity of the array it was handed. A fresh `glbBytes` per frame would parse a
 * megabyte of `.glb` and re-upload its textures thirty times a second, which is the thing this
 * whole arrangement exists to avoid.
 *
 * A paint that fails leaves whatever was on the canvas rather than breaking the row — the name,
 * the slot and the quality are still what the row is for, and a machine with no working 3D at
 * all is a machine where every tile of the gallery is an empty one of these.
 */
function Turnable(
  { glb, shows, displayType, label, paint }: {
    glb: string;
    shows: GalleryKind;
    displayType: number;
    label: string;
    paint: Paint;
  },
): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bytes = useMemo(() => glbBytes(glb), [glb]);
  const focus = useMemo(() => focusOf(displayType, shows), [displayType, shows]);

  /** Where the reader has turned this tile to, which outlives any one paint. */
  const turn = useRef(0);
  /** The angle asked for and not yet drawn, and whether the pump is already draining it. */
  const wanted = useRef<number | null>(null);
  const painting = useRef(false);

  const ask = useCallback((at: number): void => {
    wanted.current = at;
    if (painting.current) return;
    painting.current = true;
    void (async () => {
      try {
        while (wanted.current !== null) {
          const next = wanted.current;
          wanted.current = null;
          const target = canvas.current;
          if (!target) break;
          await paint(target, bytes, focus, next);
        }
      } catch {
        // Leaves the picture that was there. See the note above.
      } finally {
        painting.current = false;
      }
    })();
  }, [bytes, focus, paint]);

  // The first paint, and any later one caused by the model itself changing. Not by the angle:
  // the angle lives in a ref precisely so that turning a tile is not a React render.
  useEffect(() => ask(turn.current), [ask]);

  /** The drag in progress: which pointer, where it went down, and the angle it started from. */
  const drag = useRef<{ pointer: number; from: number; at: number } | null>(null);

  return (
    <span className="mog-shot">
      <canvas
        ref={canvas} aria-label={`${label}, drawn`}
        onPointerDown={(event) => {
          // Captured, so a drag that leaves the tile keeps turning it rather than stopping at
          // the edge — twenty tiles side by side means most drags cross one.
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, from: event.clientX, at: turn.current };
        }}
        onPointerMove={(event) => {
          const started = drag.current;
          if (!started || started.pointer !== event.pointerId) return;
          turn.current = turnedBy(
            started.at, event.clientX - started.from, event.currentTarget.clientWidth,
          );
          ask(turn.current);
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      />
    </span>
  );
}

/** The kinds in the order the picker offers them, under the headings they belong to. */
function groups(): Array<{ name: string; kinds: Kind[] }> {
  const groups: Array<{ name: string; kinds: Kind[] }> = [];
  for (const kind of KINDS) {
    const last = groups.at(-1);
    if (last && last.name === kind.group) last.kinds.push(kind);
    else groups.push({ name: kind.group, kinds: [kind] });
  }
  return groups;
}

/**
 * The real stage, loaded the first time a reader asks to see one.
 *
 * three.js and its loader are most of this app's JavaScript, and the same import the outfit pane
 * makes: a reader who never opens the gallery never downloads it, and one who has already opened
 * the pane pays nothing here because the module is already in memory.
 */
const lazyGalleryStage = (): Promise<GalleryStage> =>
  import("./galleryStage").then((stage) => stage.createGalleryStage());

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
