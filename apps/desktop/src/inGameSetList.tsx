/**
 * The fourth way of browsing the wardrobe: the sets the player saved in the game itself.
 *
 * Drawn as nearly the same thing as the three beside it, which is the point — a set is a set,
 * and somebody who has learned to read one and put one on has learned it for all four. What
 * differs is only what is honestly different, and there are three of those.
 *
 * **It is grouped by character.** The other three lists are one list, because Blizzard's sets and
 * the game's wardrobe and the reader's own saved sets are the same for everybody logged in. These
 * belong to whoever Chronie read them on, and a roster of ten alts is ten wardrobes — so the
 * character is a heading rather than a filter, and a character Chronie has never been played on
 * is simply absent rather than shown as empty.
 *
 * **It has to be opened.** An in-game set names appearances and nothing else — see
 * `inGameSets.ts` — so a card starts closed and costs the game's own tables to expand, exactly
 * as a Blizzard set does. On a machine with no game installed the names are still here and the
 * opening is what fails, which is the trade `0018_in_game_sets.sql` argues.
 *
 * **Nothing here deletes one.** Every other destructive click in this view destroys something
 * this app made. A set in this list is the player's, held on Blizzard's servers, and the app
 * does not get to throw it away as a side effect of tidying.
 */

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import {
  appearanceIds, charactersWithSets, filterInGameSets, rowsOf, setLabel, setSummary,
} from "./inGameSets";
import { isWorn } from "./outfit";
import type { Outfit } from "./outfit";
import type { AppearanceRow } from "./transmogModal";
import { LinkOut } from "./ui";
import type { InGameSet, InGameSetAppearancesPayload, InGameSetsPayload } from "./types";

export interface InGameSetListProps {
  /** Whether the reader is in one of the other browsers, which keeps this out of the way. */
  hidden: boolean;
  /** The sets, or null until they have been read out of Chronie's own database. */
  payload: InGameSetsPayload | null;
  /** Asks the game's files what a set's appearances actually are, when a reader opens one. */
  loadAppearances: (appearanceIds: number[]) => Promise<InGameSetAppearancesPayload>;
  icons: Map<number, string>;
  /** Asks for the pictures the drawn rows are waiting on, which the view above caches. */
  wantIcons: (iconFileDataIds: number[]) => void;
  outfit: Outfit;
  onWear: (row: AppearanceRow) => void;
  onWearAll: (set: InGameSet, rows: AppearanceRow[]) => void;
}

/** What an opened set turned out to be, or the sentence saying why it could not be opened. */
type Opened = InGameSetAppearancesPayload | string;

export function InGameSetList(
  {
    hidden, payload, loadAppearances, icons, wantIcons, outfit, onWear, onWearAll,
  }: InGameSetListProps,
): ReactNode {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // What each set turned out to be. Kept outside React for the reason the transmog view keeps
  // its own: a cache filling is not a redraw, and the counter below is what says one happened.
  // Keyed by character and set together — the ids are the account's, but the wardrobes are read
  // per character and keying on the id alone would show one alt's answer under another's set.
  const known = useRef(new Map<string, Opened>()).current;
  const asked = useRef(new Set<string>()).current;
  const [, redraw] = useState(0);

  const read = useCallback((key: string, set: InGameSet): void => {
    if (asked.has(key)) return;
    asked.add(key);
    void loadAppearances(appearanceIds(set))
      .then((answer) => {
        known.set(key, answer);
        redraw((count) => count + 1);
        wantIcons(answer.appearances.map((one) => one.iconFileDataId).filter((id) => id > 0));
      })
      // Worth saying out loud, because the reader clicked to see what was in it — and on a
      // machine with no game installed this is the failure they will meet every time.
      .catch((error: unknown) => {
        known.set(key, error instanceof Error ? error.message : String(error));
        redraw((count) => count + 1);
      });
  }, [loadAppearances, wantIcons, known, asked]);

  const toggle = useCallback((key: string, set: InGameSet): void => {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        read(key, set);
      }
      return next;
    });
  }, [read]);

  const characters = charactersWithSets(payload)
    .map((entry) => ({ ...entry, sets: filterInGameSets(entry.sets, search) }));
  const shown = characters.reduce((total, entry) => total + entry.sets.length, 0);
  const held = charactersWithSets(payload).reduce((total, one) => total + one.sets.length, 0);

  return (
    <section className="panel mog-browser" id="ingame-sets" hidden={hidden}>
      <div className="table-head">
        <div className="controls">
          <input
            id="ingame-search" type="search" placeholder="Filter by name…"
            aria-label="Filter the sets you saved in game" value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="count" id="ingame-count">
            {payload ? `${plural(shown, "set")} shown` : ""}
          </span>
        </div>
      </div>
      <div className="mog-list" id="ingame-list">
        {characters.map((entry) => (
          <section key={entry.character} className="mog-character" hidden={!entry.sets.length}>
            <h3>{entry.character}</h3>
            <div className="mog-grid">
              {entry.sets.map((set) => {
                const key = `${entry.character}:${set.id}`;
                return (
                  <Card
                    key={key} set={set} opened={known.get(key)} open={open.has(key)}
                    icons={icons} outfit={outfit} onWear={onWear} onWearAll={onWearAll}
                    onToggle={() => toggle(key, set)}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {/* Three silences and three sentences. A reader with no wardrobes read at all is being
          told what makes one appear; one whose characters save nothing in game is being told
          that is what Chronie found rather than shown a blank; one whose filter matches nothing
          is being told to try another. */}
      <div className="empty" hidden={!payload || characters.length > 0}>
        <p className="empty-title">No wardrobes read yet</p>
        <p>Log a character in with the addon installed, and the sets they saved in game appear here.</p>
      </div>
      <div className="empty" hidden={!payload || characters.length === 0 || held > 0}>
        <p className="empty-title">No sets saved in game</p>
        <p>Chronie read these characters and found no transmog sets saved on the account.</p>
      </div>
      <div className="empty" hidden={!payload || held === 0 || shown > 0}>
        <p className="empty-title">Nothing matches</p>
        <p>Try a different search.</p>
      </div>
    </section>
  );
}

/**
 * One set the player saved in game: its name, and what it turns out to be made of.
 *
 * Closed until clicked, because what it is made of is four walks of the game's own tables away.
 * The head says how many pieces without opening anything, since the slots came out of Chronie's
 * database with the name — it is only what those slots *are* that costs.
 */
function Card(
  { set, opened, open, icons, outfit, onWear, onWearAll, onToggle }: {
    set: InGameSet;
    opened: Opened | undefined;
    open: boolean;
    icons: Map<number, string>;
    outfit: Outfit;
    onWear: (row: AppearanceRow) => void;
    onWearAll: (set: InGameSet, rows: AppearanceRow[]) => void;
    onToggle: () => void;
  },
): ReactNode {
  const name = setLabel(set);
  const rows = typeof opened === "object" ? rowsOf(opened.appearances) : [];

  return (
    <article className="mog-card" data-open={open || undefined}>
      <h4>
        <button type="button" className="mog-open" aria-expanded={open} onClick={onToggle}>
          {name}
        </button>
      </h4>
      <div className="mog-foot">
        <span>{setSummary(set)}</span>
      </div>
      {open
        ? <div className="mog-contents">
          {opened === undefined
            ? <p className="mog-reading">Reading what is in it…</p>
            : null}
          {typeof opened === "string"
            ? <p className="mark-failure" role="alert">{opened}</p>
            : null}
          {rows.length
            ? <div className="mog-contents-head">
              <button
                type="button" className="mog-wear-all" onClick={() => onWearAll(set, rows)}
              >{`Wear all of ${name}`}</button>
            </div>
            : null}
          <ul className="mog-items">
            {rows.map((row, at) => (
              <Piece
                // The slot rather than the appearance, because one appearance can fill two
                // slots — the same sword in both hands — and keying on the look would collapse
                // the pair into one row and lose the hand that came second.
                key={set.slots[at]?.slot ?? at} row={row} worn={isWorn(outfit, row)}
                icon={icons.get(row.iconFileDataId)} onWear={() => onWear(row)}
              />
            ))}
          </ul>
        </div>
        : null}
    </article>
  );
}

/** One piece of an in-game set, as something to put on the character. */
function Piece(
  { row, worn, icon, onWear }: {
    row: AppearanceRow;
    worn: boolean;
    icon?: string;
    onWear: () => void;
  },
): ReactNode {
  return (
    <li className="mog-item" data-worn={worn}>
      <button
        type="button" className="mog-pick" aria-pressed={worn}
        aria-label={`Wear ${row.slot}: ${row.label}`} onClick={onWear}
        disabled={row.withheld}
      >
        <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>
        <span className="badge">{row.slot}</span>
        <span className="mog-name">{row.label}</span>
      </button>
      {worn ? <span className="chip">worn</span> : null}
      {row.withheld
        ? null
        : <a
          className="mog-wowhead"
          href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
          target="_blank" rel="noopener noreferrer" title={`${row.label} on Wowhead`}
          aria-label={`${row.label} on Wowhead`}
        ><LinkOut /></a>}
    </li>
  );
}
