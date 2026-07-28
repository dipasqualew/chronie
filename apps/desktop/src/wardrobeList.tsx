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
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import { NO_MARK_FILTER, tagChoices } from "./marks";
import type { MarkIndex } from "./marks";
import { MarkControls, MarkFilters } from "./marksEditor";
import type { MarkActions } from "./marksEditor";
import { wearable as canBeWorn } from "./modelPreview";
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
import type { TransmogMark, WardrobePayload } from "./types";

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
}

/** What the list says while the game's tables are being read for a kind. */
const READING = "Reading every appearance the game has for this…";

export function WardrobeList(
  {
    hidden, load, wantIcons, icons, outfit, hideUnwearable, onHideUnwearable, marks, index,
    onWear,
  }: WardrobeListProps,
): ReactNode {
  const [kindKey, setKindKey] = useState(KINDS[0]!.key);
  const [search, setSearch] = useState("");
  const [klass, setKlass] = useState("");
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

  /** Every narrowing starts the list again from the top, where the reader is looking. */
  const narrow = (change: () => void): void => {
    change();
    setShown(PAGE);
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
      <div className="mog-list" id="wardrobe-list">
        {answer === undefined ? <p className="muted">{READING}</p> : null}
        {typeof answer === "string" ? <p className="muted">{answer}</p> : null}
        <ul className="mog-items">
          {drawn.map((row) => (
            <Look
              key={row.appearanceId} row={row} worn={isWorn(outfit, row)}
              icon={icons.get(row.iconFileDataId)} marks={marks}
              mark={index.of("appearance", row.appearanceId)} onWear={() => onWear(row)}
            />
          ))}
        </ul>
        {/* What is left, and the way to it. A number rather than an endless scroll, because
            the honest answer to "how much more of this is there" is four thousand. */}
        {kept.length > drawn.length
          ? <button
            type="button" className="mog-more"
            onClick={() => setShown((was) => was + PAGE)}
          >{`Show ${Math.min(PAGE, kept.length - drawn.length)} more of ${plural(kept.length - drawn.length, "appearance")}`}</button>
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
  { row, worn, icon, marks, mark, onWear }: {
    row: AppearanceRow;
    worn: boolean;
    icon?: string;
    marks: MarkActions;
    /** The same mark a set's row of this look draws, because both key on the appearance. */
    mark: TransmogMark | undefined;
    onWear: () => void;
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
        <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
