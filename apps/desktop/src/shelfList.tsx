/**
 * The fifth way of browsing the wardrobe: the sets a reader can almost have.
 *
 * The other four are lists of what exists — Blizzard's sets, the whole wardrobe by kind, the
 * reader's own outfits, what they saved in game. This one is a list of *near misses*, and it is
 * the only browser here that could not be reached by filtering any of them: "the sets one slot
 * short of anybody" is not a fact about a set that the game states anywhere, it is arithmetic
 * over every item in the game — see `shelf.ts` for what a row is and `wearers.rs` for the read
 * behind it.
 *
 * A row says three things and then gets out of the way: who can wear the set as it stands, which
 * slot or two stop everybody else, and **which kind of answer that slot has** — an equality out
 * of the game's own geometry, or a ranking somebody has to confirm by eye. The third is why this
 * is a browser rather than a filter: about half of these sets can be settled today with "the same
 * helm, in this colour, anybody can wear it", and drawing that in the same voice as a list of
 * 96%-alike thumbnails would undersell the first and oversell the second.
 *
 * Opening a row is opening the set: the same read of the game's tables the grid does, the same
 * `openingsPanel.tsx` under it, and so the same "Show possible alternatives" button on the same
 * red row. Nothing about the answer is re-implemented here — the shelf is the way *to* it.
 */

import "./shelfList.css";

import { useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import { OpeningsPanel } from "./openingsPanel";
import type { AlternativeActions } from "./alternativesPanel";
import { answerNote, blockedLabel, filterShelf, shelfRows, shelfSummary } from "./shelf";
import type { ShelfRow } from "./shelf";
import { expansionName, whoWears } from "./transmog";
import { appearanceRows } from "./transmogModal";
import type {
  OpeningsPayload,
  SetWearers,
  TransmogPayload,
  TransmogSetItemsPayload,
} from "./types";

export interface ShelfListProps {
  /** Whether the reader is in one of the other browsers, which keeps this out of the way. */
  hidden: boolean;
  /** The game's sets, or null while they are still being read out of the install. */
  payload: TransmogPayload | null;
  /**
   * What the items behind each set say — see `wearers.rs`.
   *
   * The whole shelf is this read: a set with no answer here is not on it, because a set nothing
   * can be said about is not a set anybody is one slot short of.
   */
  wearersOf: (setId: number) => SetWearers | undefined;
  /**
   * Whether that read has landed, which is the difference between an empty shelf and a wait.
   *
   * It is a second command after the grid's own and the dearer of the two, so the ordinary
   * first sight of this browser is neither the list nor "nothing matches" but a sentence saying
   * the reading is still going on.
   */
  ready: boolean;
  /** Opens one: reads what the set is made of, and how anybody gets the looks it locks. */
  onOpen: (setId: number) => void;
  /** What that read found, the sentence saying why it failed, or nothing yet. */
  contentsOf: (setId: number) => TransmogSetItemsPayload | string | undefined;
  /** And which of the set's looks something outside it sells to anybody — see `openings.ts`. */
  openingsOf: (setId: number) => OpeningsPayload | undefined;
  /** Reading what else might do for a look nothing sells around, and ruling on it. */
  alternatives: AlternativeActions;
  /** The pictures, shared with every other browser in this view. */
  icons: Map<number, string>;
}

export function ShelfList({
  hidden,
  payload,
  wearersOf,
  ready,
  onOpen,
  contentsOf,
  openingsOf,
  alternatives,
  icons,
}: ShelfListProps): ReactNode {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  // Nothing at all until the read that decides the shelf has landed. Half a list drawn from a
  // read still in flight is a list that grows under the reader's hand, and the sentence over it
  // would be counting sets that had not been counted yet.
  const rows = ready ? shelfRows(payload?.sets ?? [], wearersOf) : [];
  const shown = filterShelf(rows, search);

  const toggle = (setId: number): void => {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(setId)) next.delete(setId);
      else {
        next.add(setId);
        onOpen(setId);
      }
      return next;
    });
  };

  return (
    <section
      className="panel mog-browser"
      id="shelf"
      hidden={hidden}
      aria-label="Sets one slot short of anybody"
    >
      <div className="table-head">
        <div className="controls">
          {/* Words only, and the placeholder says which ones. This list is already cut the one
              way that matters, so the box is for finding a set inside it rather than for
              asking the game another question — see `filterShelf`. */}
          <input
            id="shelf-search"
            type="search"
            placeholder="Filter by name, class, or slot…"
            aria-label="Filter the sets one slot short"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="count" id="shelf-count" role="status" aria-label="How many are shown">
            {payload && ready ? `${plural(shown.length, "set")} shown` : ""}
          </span>
        </div>
        {/* Over the list rather than in the count beside the box, because it is about the shelf
            and not about the search: the two numbers are two different errands, and the third
            says how much of the list a person is going to have to settle by eye. */}
        <p className="detail-facts" id="shelf-summary">
          {payload && ready ? shelfSummary(rows) : "Reading what every item in the game allows…"}
        </p>
      </div>
      <div className="mog-list" id="shelf-list">
        <div className="mog-grid">
          {shown.map((row) => (
            <Card
              key={row.set.id}
              row={row}
              open={open.has(row.set.id)}
              onToggle={() => toggle(row.set.id)}
              contents={contentsOf(row.set.id)}
              openings={openingsOf(row.set.id)}
              alternatives={alternatives}
              icons={icons}
            />
          ))}
        </div>
      </div>
      {/* Two silences and two sentences. A reader whose install genuinely holds no near miss is
          being told that is the answer; one whose filter matches nothing is being told to try
          another. Neither is drawn while the read that decides it is still going on. */}
      <div className="empty" hidden={!payload || !ready || rows.length > 0}>
        <p className="empty-title">Nothing is one slot short</p>
        <p>Every set this install can describe is either open to everybody or shut to most.</p>
      </div>
      <div className="empty" hidden={!payload || !ready || rows.length === 0 || shown.length > 0}>
        <p className="empty-title">Nothing matches</p>
        <p>Try a different search.</p>
      </div>
    </section>
  );
}

/**
 * One near miss: the set, what stops it, and — once opened — the set's own answer to that.
 *
 * The chips are the obstacles, and they are the one place on this card where a colour carries
 * meaning: `data-exact` says the geometry can speak for the slot, which is drawn as a different
 * chip rather than as a footnote because a reader scanning six hundred of these is scanning for
 * exactly that. It is an attribute rather than a `style` prop for the reason everything in this
 * window is — see the note in `CLAUDE.md`.
 */
function Card({
  row,
  open,
  onToggle,
  contents,
  openings,
  alternatives,
  icons,
}: {
  row: ShelfRow;
  open: boolean;
  onToggle: () => void;
  contents: TransmogSetItemsPayload | string | undefined;
  openings: OpeningsPayload | undefined;
  alternatives: AlternativeActions;
  icons: Map<number, string>;
}): ReactNode {
  const name = row.set.name || "Unnamed set";
  const rows = typeof contents === "object" ? appearanceRows(contents, row.set.name) : [];

  return (
    <article className="mog-card mog-shelf" data-open={open}>
      <h4>
        <button type="button" className="mog-open" aria-expanded={open} onClick={onToggle}>
          {name}
        </button>
      </h4>
      <div className="mog-facts">
        <span className="chip">{whoWears(row.wearers)}</span>
        <span className="chip">{expansionName(row.set.expansionId)}</span>
        {row.blocked.map((slot) => (
          <span
            key={slot.displayType}
            className="chip mog-shelf-slot"
            data-exact={slot.exact}
            title={`${slot.slot} is one of the slots nothing in the game sells around`}
          >
            {slot.slot}
          </span>
        ))}
      </div>
      <p className="detail-facts">{blockedLabel(row)}</p>
      <p className="detail-facts muted">{answerNote(row)}</p>
      <div className="mog-foot">
        <span>{row.set.group || "Ungrouped"}</span>
        <span className="muted">#{row.set.id}</span>
      </div>
      {open ? (
        <div className="mog-contents">
          {contents === undefined ? (
            <p className="muted">Reading what the set is made of…</p>
          ) : null}
          {typeof contents === "string" ? <p className="muted">{contents}</p> : null}
          {/* The set's own answer, drawn by the same panel the grid draws — including the
              button on the red row, which is what this whole browser is a road to. */}
          {typeof contents === "object" ? (
            <OpeningsPanel
              name={name}
              rows={rows}
              openings={openings}
              alternatives={alternatives}
              icons={icons}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
