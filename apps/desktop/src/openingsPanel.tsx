/**
 * How anyone gets the looks a set locks: one row per locked slot, and where to go for it.
 *
 * The panel an opened class-locked set carries, and the second half of the answer the chip on the
 * card gives. "Any plate wearer" says the lock lifts and "Paladin only" says it stands, and
 * neither says *which* slot did it — which is what a reader in front of Icecrown's Paladin tier
 * actually needs, seven of its eight looks being on a world drop and the eighth on nothing.
 *
 * A table, because the shape of the answer is a column of slots read against a column of items,
 * and because a reader scanning for the red row is scanning down a column. What it is *not* is
 * this window's sortable data tables: nothing here is clickable but the link out, so the shared
 * `th`/`tr` rules are undone in the sheet beside this.
 *
 * The rows are `openings.ts`'s. This draws them and decides nothing.
 */

import "./openingsPanel.css";

import type { ReactNode } from "react";

import { openingLabel, openingRows, openingSummary, unread } from "./openings";
import type { OpeningRow } from "./openings";
import type { AppearanceRow } from "./transmogModal";
import type { OpeningsPayload } from "./types";
import { LinkOut } from "./ui";

export function OpeningsPanel({
  name,
  rows,
  openings,
}: {
  /** The set the panel is about, which is what the table is named after. */
  name: string;
  /** The set's own rows, already grouped by look — see `appearanceRows`. */
  rows: AppearanceRow[];
  /** What the backend read out of every item in the game, or nothing while it is being read. */
  openings: OpeningsPayload | undefined;
}): ReactNode {
  if (!openings) return <p className="muted">Reading who else sells these looks…</p>;
  const shown = openingRows(rows, openings);
  const missing = unread(rows, openings);
  // Nothing to draw and nothing to apologise for: every locked look sits in a section this
  // install holds no key to, and a table of question marks is worse than no table.
  if (!shown.length && !missing) return null;
  return (
    <div className="mog-openings">
      <p className="detail-facts">{openingSummary(shown, missing)}</p>
      {shown.length ? (
        <table aria-label={`How anyone gets the looks ${name} locks`}>
          <thead>
            <tr>
              <th scope="col">Slot</th>
              <th scope="col">In the set</th>
              {/* The game's own words for the mask, which is what "any class" means on an item
                  and what the row beside a look already says — see `wearerLabel`. */}
              <th scope="col">Any class</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <Row key={row.appearanceId} row={row} />
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/**
 * One locked slot, and the way in beside it.
 *
 * `data-open` rather than a colour written into the markup: the packaged app's Content Security
 * Policy will not carry a nonce on a `style` attribute, so nothing this window draws is styled
 * from a `style` prop — see the note in `CLAUDE.md` and `data-quality` everywhere else.
 */
function Row({ row }: { row: OpeningRow }): ReactNode {
  return (
    <tr data-open={row.open !== null}>
      <th scope="row">{row.slot}</th>
      <td>{row.own}</td>
      <td>
        {row.open ? (
          <>
            <span>{openingLabel(row.open)}</span>
            <a
              className="mog-wowhead"
              href={`https://www.wowhead.com/item=${encodeURIComponent(row.open.itemId)}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${row.open.name || `Item ${row.open.itemId}`} on Wowhead`}
            >
              <LinkOut />
            </a>
          </>
        ) : (
          // The row the whole panel is read for. Said in words rather than left blank,
          // because a blank cell is a thing that failed to load.
          <span>Nothing gives this look to another class</span>
        )}
      </td>
    </tr>
  );
}
