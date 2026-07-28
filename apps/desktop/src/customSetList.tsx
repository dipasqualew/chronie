/**
 * The third way of browsing the wardrobe: the sets the reader put together themselves.
 *
 * Beside Blizzard's sets and the game's whole wardrobe, and drawn as nearly the same thing as
 * the first of those — a grid of cards, each listing what it is made of, each carrying the star
 * and the tags every other card in this view carries. The likeness is the point: a set is a
 * set, and somebody who has learned to read one, star one and put one on has learned it for all
 * three lists.
 *
 * What differs is only what is honestly different. A saved set is **already open** in the sense
 * that matters — there is nothing to fetch, because a saved piece is stored as what was on
 * screen — so a card costs nothing to draw and nothing to expand. It says when it was saved
 * rather than which expansion it came from, because it came from no expansion. It can be thrown
 * away, which nothing in the game's own wardrobe can. And its rows say nothing about who may
 * wear the item or what colour the game writes it in, because what was saved is a look and
 * those are facts about the items behind one — see `customSets.ts`.
 *
 * The rows are `AppearanceRow`s like every other row in this view, so putting one on goes
 * through exactly the code a set's row goes through.
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { filterCustomSets, piecesInOrder, rowOf, savedSummary } from "./customSets";
import { plural } from "./format";
import { NO_MARK_FILTER, tagChoices } from "./marks";
import type { MarkIndex } from "./marks";
import { MarkControls, MarkFilters } from "./marksEditor";
import type { MarkActions } from "./marksEditor";
import { isWorn } from "./outfit";
import type { Outfit } from "./outfit";
import type { AppearanceRow } from "./transmogModal";
import { LinkOut } from "./ui";
import type { CustomSet, CustomSetsPayload, TransmogMark } from "./types";

export interface CustomSetListProps {
  /** Whether the reader is in one of the other two browsers, which keeps this out of the way. */
  hidden: boolean;
  /** The saved sets, or null until they have been read — which is a moment, not a second. */
  payload: CustomSetsPayload | null;
  /** Throws one away, answering with what is left. Says why if it could not. */
  onDelete: (id: number) => Promise<CustomSetsPayload>;
  /** What the whole view does with a fresh payload, which is hold it and redraw. */
  onSaved: (payload: CustomSetsPayload) => void;
  onError: (error: unknown) => string;
  icons: Map<number, string>;
  /** Asks for the pictures the drawn rows are waiting on, which the view above caches. */
  wantIcons: (iconFileDataIds: number[]) => void;
  outfit: Outfit;
  marks: MarkActions;
  /** What has been said already, shared with both browsers beside this one. */
  index: MarkIndex;
  onWear: (row: AppearanceRow) => void;
  onWearAll: (set: CustomSet) => void;
}

export function CustomSetList(
  {
    hidden, payload, onDelete, onSaved, onError, icons, wantIcons, outfit, marks, index, onWear,
    onWearAll,
  }: CustomSetListProps,
): ReactNode {
  const [search, setSearch] = useState("");
  const [marked, setMarked] = useState(NO_MARK_FILTER);
  const [failure, setFailure] = useState("");

  const saved = payload?.sets ?? [];
  const sets = filterCustomSets(saved, {
    search, marks: { filter: marked, of: (id) => index.of("custom", id) },
  });
  const tags = tagChoices(index, "custom", saved.map((set) => set.id));

  return (
    <section className="panel mog-browser" id="custom-sets" hidden={hidden}>
      <div className="table-head">
        <div className="controls">
          <input
            id="custom-search" type="search" placeholder="Filter by name or what is in it…"
            aria-label="Filter your sets" value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <MarkFilters
            scope="custom" favourite={marked.favourite} tag={marked.tag} choices={tags}
            onFavourite={(only) => setMarked((was) => ({ ...was, favourite: only }))}
            onTag={(tag) => setMarked((was) => ({ ...was, tag }))}
          />
          <span className="count" id="custom-count">
            {payload ? `${plural(sets.length, "set")} shown` : ""}
          </span>
        </div>
      </div>
      {failure ? <p className="mark-failure" role="alert">{failure}</p> : null}
      <div className="mog-list" id="custom-list">
        <div className="mog-grid">
          {sets.map((set) => (
            <Card
              key={set.id} set={set} icons={icons} wantIcons={wantIcons} outfit={outfit}
              marks={marks} mark={index.of("custom", set.id)} index={index}
              onWear={onWear} onWearAll={() => onWearAll(set)}
              onDelete={() => {
                setFailure("");
                void onDelete(set.id)
                  .then(onSaved)
                  .catch((error: unknown) => setFailure(onError(error)));
              }}
            />
          ))}
        </div>
      </div>
      {/* Two different silences, and they want two different sentences: a reader who has saved
          nothing is being told how to start, and one whose filter matches nothing is being told
          to try another. */}
      <div className="empty" hidden={!payload || saved.length > 0}>
        <p className="empty-title">No sets of your own yet</p>
        <p>Dress the character from any of the lists, then save what she has on as a set.</p>
      </div>
      <div className="empty" hidden={!payload || saved.length === 0 || sets.length > 0}>
        <p className="empty-title">Nothing matches</p>
        <p>Try a different search, or a different tag.</p>
      </div>
    </section>
  );
}

/**
 * One saved set: what it is called, what is in it, and the two things to do with it.
 *
 * Open from the start, unlike a Blizzard set. There is nothing behind the click — the pieces
 * arrived with the card — so a card that had to be opened would be a click that only hid things.
 */
function Card(
  {
    set, icons, wantIcons, outfit, marks, mark, index, onWear, onWearAll, onDelete,
  }: {
    set: CustomSet;
    icons: Map<number, string>;
    wantIcons: (iconFileDataIds: number[]) => void;
    outfit: Outfit;
    marks: MarkActions;
    mark: TransmogMark | undefined;
    index: MarkIndex;
    onWear: (row: AppearanceRow) => void;
    onWearAll: () => void;
    onDelete: () => void;
  },
): ReactNode {
  const [confirming, setConfirming] = useState(false);
  // The place is kept beside the row because it is what makes a piece unique within a set —
  // two of the game's own one-handers can be the same look in two hands, and `appearanceId`
  // alone would draw them as one row and lose the other.
  const pieces = piecesInOrder(set).map((piece) => ({ place: piece.place, row: rowOf(piece) }));
  // The pictures those rows are waiting on. Most are already in the cache above — every look in
  // a saved set was on screen when it was saved — and the call ignores what it holds already.
  const wanted = pieces.map(({ row }) => row.iconFileDataId).filter((id) => id > 0);
  const wantedKey = wanted.join(",");
  useEffect(() => {
    if (wanted.length) wantIcons(wanted);
    // The ids rather than the array, which is new on every render and would ask every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, wantIcons]);

  return (
    <article className="mog-card" data-open>
      {/* No row of chips under the name, where a Blizzard set has three. A saved set belongs to
          no class, came out of no expansion and arrived in no patch, and the one thing that
          could go there — that it is the reader's own — is what the browser it is in says. */}
      <h4>{set.name}</h4>
      <MarkControls kind="custom" id={set.id} mark={mark} name={set.name} actions={marks} />
      <div className="mog-foot">
        <span>{savedSummary(set)}</span>
      </div>
      <div className="mog-contents">
        <div className="mog-contents-head">
          {pieces.length
            ? <button type="button" className="mog-wear-all" onClick={onWearAll}>
              {`Wear all of ${set.name}`}
            </button>
            : null}
          {/* Behind a second click, because it is the one thing in this view that destroys
              something the reader made and no other click here is undoable. */}
          {confirming
            ? <span className="mog-confirm">
              <button type="button" className="mog-delete" onClick={onDelete}>
                {`Delete ${set.name}`}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>Keep it</button>
            </span>
            : <button
              type="button" className="mog-delete" aria-label={`Delete ${set.name}`}
              onClick={() => setConfirming(true)}
            >Delete</button>}
        </div>
        <ul className="mog-items">
          {pieces.map(({ place, row }) => (
            <Piece
              key={place} row={row} worn={isWorn(outfit, row)}
              icon={icons.get(row.iconFileDataId)} marks={marks}
              mark={index.of("appearance", row.appearanceId)} onWear={() => onWear(row)}
            />
          ))}
        </ul>
      </div>
    </article>
  );
}

/**
 * One piece of a saved set, as something to put back on.
 *
 * The same row a set draws, minus everything a saved piece cannot honestly say. There is no
 * "+n items" and no class, level or quality: what was saved is a look, and those are facts
 * about the items that sell one. The star is the same star, because the look is the same look —
 * a piece starred here is starred in both browsers beside this one.
 */
function Piece(
  { row, worn, icon, marks, mark, onWear }: {
    row: AppearanceRow;
    worn: boolean;
    icon?: string;
    marks: MarkActions;
    mark: TransmogMark | undefined;
    onWear: () => void;
  },
): ReactNode {
  return (
    <li className="mog-item" data-worn={worn}>
      <button
        type="button" className="mog-pick" aria-pressed={worn}
        aria-label={`Wear ${row.slot}: ${row.label}`} onClick={onWear}
      >
        <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>
        <span className="badge">{row.slot}</span>
        <span className="mog-name">{row.label}</span>
      </button>
      {worn ? <span className="chip">worn</span> : null}
      <MarkControls
        kind="appearance" id={row.appearanceId} mark={mark} name={row.label} actions={marks}
      />
      <a
        className="mog-wowhead" href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
        target="_blank" rel="noopener noreferrer" title={`${row.label} on Wowhead`}
        aria-label={`${row.label} on Wowhead`}
      ><LinkOut /></a>
    </li>
  );
}
