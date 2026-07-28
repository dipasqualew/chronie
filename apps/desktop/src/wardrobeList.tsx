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
 * puts in a bag slot and it is 64 pixels of squint; the same look shown worn is what the game's
 * own wardrobe shows, and it is the only way to tell two brown chestpieces apart. It is off by
 * default and the page shrinks to a fifth when it is on, because a row of names is a string and a
 * row of models is a character read out of the game's files. `gallery.ts` decides what a page is
 * and where a camera looks; `galleryStage.ts` draws them, all on one graphics context.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import {
  PAGE as GALLERY_PAGE, focusOf, piecesOf, stillWanted,
} from "./gallery";
import type { Thumbnail } from "./gallery";
import type { GalleryStage } from "./galleryStage";
import { NO_MARK_FILTER, tagChoices } from "./marks";
import type { MarkIndex } from "./marks";
import { MarkControls, MarkFilters } from "./marksEditor";
import type { MarkActions } from "./marksEditor";
import { REASONS, glbBytes, wearable as canBeWorn } from "./modelPreview";
import { isWorn, onlyWearable } from "./outfit";
import type { Outfit } from "./outfit";
import { CLASSES } from "./transmog";
import { LinkOut } from "./ui";
import { ANY_CLASS, qualityLabel, wearerLabel } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import {
  KINDS, PAGE, answerKey, filterAppearances, kindOf, shownSummary, wardrobeRow,
} from "./wardrobe";
import type { Kind } from "./wardrobe";
import type { GalleryPayload, TransmogMark, WardrobePayload, WornPiece } from "./types";

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
}

/** What the list says while the game's tables are being read for a kind. */
const READING = "Reading every appearance the game has for this…";

export function WardrobeList(
  {
    hidden, load, wantIcons, icons, outfit, hideUnwearable, onHideUnwearable, marks, index,
    onWear, loadGallery, look, createGalleryStage = lazyGalleryStage,
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
            ? { kind: "model", glb: row.model }
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
  const stage = useRef<GalleryStage | null>(null);
  const starting = useRef<Promise<GalleryStage> | null>(null);
  useEffect(() => {
    if (asModels) return undefined;
    stage.current?.dispose();
    stage.current = null;
    starting.current = null;
    return undefined;
  }, [asModels]);
  const paint = useCallback(async (
    target: HTMLCanvasElement, glb: string, displayType: number,
  ): Promise<void> => {
    // One stage, and one attempt to make one: twenty rows painting at once would otherwise
    // each start a context of their own, which is the thing this exists to avoid.
    starting.current ??= Promise.resolve(createGalleryStage());
    stage.current = await starting.current;
    await stage.current.paint(target, glbBytes(glb), focusOf(displayType));
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
              mark={index.of("appearance", row.appearanceId)} onWear={() => onWear(row)}
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

/** One look, as something to put on: the same row a set draws, with what a set cannot say. */
function Look(
  { row, worn, icon, marks, mark, onWear, body, paint }: {
    row: AppearanceRow;
    worn: boolean;
    icon?: string;
    marks: MarkActions;
    /** The same mark a set's row of this look draws, because both key on the appearance. */
    mark: TransmogMark | undefined;
    onWear: () => void;
    /**
     * The body wearing this look, when the gallery is on and one has arrived.
     *
     * `undefined` is the gallery being off, and the row keeps the icon it always had.
     */
    body: Thumbnail | undefined;
    paint: (target: HTMLCanvasElement, glb: string, displayType: number) => Promise<void>;
  },
): ReactNode {
  const wanted = canBeWorn(row);
  const canWear = wanted.kind === "worn";
  const source = row.sources[0]!;
  return (
    <li className="mog-item" data-worn={worn}>
      <button
        type="button" className="mog-pick" aria-pressed={worn} disabled={!canWear}
        aria-label={`Wear ${row.slot}: ${row.label}`} onClick={onWear}
      >
        {/* The picture, which is the icon until a body arrives to take its place. A row whose
            body has not come yet keeps the icon rather than a gap, so the list does not jump
            about as twenty of them land. */}
        {body?.kind === "model"
          ? <Worn glb={body.glb} displayType={row.displayType} label={row.label} paint={paint} />
          : <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>}
        <span className="badge">{row.slot}</span>
        {/* In the colour the game writes the name in, which is the fastest thing to read in a
            list of a thousand — and the stylesheet's job rather than an inline style, because
            the packaged app's CSP drops those. The same arrangement `GameItem` uses. */}
        <span
          className="mog-name" data-quality={String(source.quality)}
          title={`${row.label} · ${qualityLabel(source.quality)}`}
        >{row.label}</span>
      </button>
      {worn ? <span className="chip">worn</span> : null}
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
    </li>
  );
}

/**
 * One row's picture of the character wearing it.
 *
 * A plain canvas, painted once by the grid's one stage and then left alone: what is on it after
 * that is a bitmap, so a page of twenty costs one context and twenty images rather than twenty
 * live scenes. Painting again for the same model would only repeat the picture already there,
 * which is why the effect keys on the `.glb` and not on the render.
 *
 * A paint that fails leaves the canvas empty rather than the row broken — the name, the slot and
 * the quality are still what the row is for, and a machine with no working 3D at all is a machine
 * where every row of the gallery is one of these.
 */
function Worn(
  { glb, displayType, label, paint }: {
    glb: string;
    displayType: number;
    label: string;
    paint: (target: HTMLCanvasElement, glb: string, displayType: number) => Promise<void>;
  },
): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    void paint(target, glb, displayType).catch(() => undefined);
  }, [glb, displayType, paint]);
  return (
    <span className="mog-icon mog-worn">
      <canvas ref={canvas} aria-label={`${label}, worn`} />
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
