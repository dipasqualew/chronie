/**
 * One item, drawn the way the game draws one: a picture, a name in the colour of its quality,
 * and the facts that say what it is.
 *
 * Every place in the app that names an item goes through here — the transmog a character
 * collected, the pieces an equipment set changed to hold, a milestone unfolded on the
 * timeline — so an item reads the same way wherever it turns up, and improving how one of
 * them reads improves all of them.
 *
 * What the segment recorded is an id and, at best, a name. Everything else is asked of the
 * game's own tables, by the row itself: the component puts its id in the book on mount and
 * redraws when the answer lands, which is what lets it be dropped anywhere without the view
 * around it having to collect ids first. The book batches, so a list of twenty is one lookup.
 *
 * A row before the lookup lands, and a row for an item this install cannot describe, are the
 * same row: the name the addon caught, no picture, no facts. That is what the app showed
 * before any of this existed, and it is what it falls back to rather than an apology.
 */

import "./item.css";

import { useEffect, useReducer } from "react";
import type { ReactNode } from "react";

import { itemLine } from "./items";
import type { ItemBook } from "./items";

export interface GameItemProps {
  /** The item as the game numbers it, which is what everything else is looked up by. */
  id: number;
  /** The name the addon caught at the time, when it caught one. */
  name?: string | null;
  book: ItemBook;
  /**
   * False on a row that is already a column of something else — an equipment set's slots,
   * where two items sit side by side under a slot name and the facts would drown them.
   */
  facts?: boolean;
  /**
   * False inside something that is itself a control — an unfolded milestone, where the whole
   * row is a button back to the segment. A link inside a button is not a thing a browser can
   * make sense of, and the name is drawn as text there instead.
   */
  link?: boolean;
  /** Drawn after the name: a time, whether the appearance was new, an item level. */
  children?: ReactNode;
}

/**
 * The wardrobe's own link out to Wowhead, which is where a reader goes for the rest of it.
 *
 * Every item in the app links there, so it is here rather than in each view. The link opens
 * outside the window — `installExternalLinks` hands it to the operating system — and the id
 * is encoded because a url is the one string in this component that is not written as text.
 */
const wowhead = (id: number): string => `https://www.wowhead.com/item=${encodeURIComponent(id)}`;

/**
 * The quality as an attribute rather than a colour.
 *
 * The packaged app's CSP carries a nonce in `style-src`, which makes the browser drop every
 * `style=""` attribute the page writes — so this hands the stylesheet a number and the
 * stylesheet, which is nonced and therefore trusted, turns it into a colour. The same
 * arrangement `classProps` uses for a character's class.
 */
const qualityProps = (quality: number | null): { "data-quality"?: string } =>
  quality == null ? {} : { "data-quality": String(quality) };

export function GameItem({
  id,
  name,
  book,
  facts = true,
  link = true,
  children,
}: GameItemProps): ReactNode {
  // The book is not state — it is a cache outside React, shared with every other row in the
  // window — so an answer landing has nothing to change that React would notice on its own.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  // Asking is idempotent: the book keeps what it has been told and what it has already asked
  // about, so a second row naming the same item adds nothing to the next request and still
  // hears about the answer. The unsubscribe is the effect's own cleanup.
  useEffect(() => book.learn([id], redraw), [id, book]);

  const line = itemLine(id, name, book.detail(id));
  const icon = book.icon(id);
  const said = [line.kind, line.slot, line.restriction, line.requirement].filter(Boolean);
  // Everything the row knows, for the places it cannot all be drawn: the quality beside the
  // name, and — where the facts are off — what kind of thing it is.
  const title = [line.name, line.qualityName, ...(facts ? [] : said)].filter(Boolean).join(" · ");

  return (
    <span className="item">
      {/* Decorative: the name is beside it, and a picture that announced itself as well would
          have a screen reader read every row twice. The frame is drawn whether or not there
          is anything in it yet, so a column of items never goes ragged. */}
      <span className="item-icon" {...qualityProps(line.quality)}>
        {icon ? <img src={icon} alt="" /> : null}
      </span>
      <span className="item-said">
        <span className="item-line">
          {link ? (
            <a
              className="item-name"
              {...qualityProps(line.quality)}
              href={wowhead(id)}
              target="_blank"
              rel="noopener noreferrer"
              title={title}
            >
              {line.name}
            </a>
          ) : (
            <span className="item-name" {...qualityProps(line.quality)} title={title}>
              {line.name}
            </span>
          )}
          {children}
        </span>
        {facts && said.length ? (
          <span className="item-facts">
            {said.map((fact) => (
              <span className="chip" key={fact}>
                {fact}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
}
