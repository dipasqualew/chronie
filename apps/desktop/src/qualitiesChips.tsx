/**
 * What was measured of a look, on the row that shows it.
 *
 * One component for both browsers, the way `MarkControls` is one for both — a set card and a
 * wardrobe row carry the same chip and a reader who learns it on one has learned it on the other.
 * What a quality *means* is `qualities.ts`; where it comes from is `qualities.rs` and the
 * committed store beside it; this is the handful of pixels over it.
 *
 * **It has to say it was nobody's opinion.** The chip sits beside a reader's own stars and tags,
 * and the two are different kinds of claim: one is what somebody typed and the other is what the
 * game's artwork measures as. So the chip is dashed rather than filled — the same "this is
 * derived" the guessed activity chip already uses — and its tooltip says where it came from in
 * words. Everything the row draws that is *not* dashed was either typed by the reader or stated
 * by the game.
 *
 * **The swatches are SVG, and that is not a style choice.** The packaged window runs under a
 * Content Security Policy that drops inline `style` attributes, which is why every colour
 * elsewhere in this app is a class the stylesheet already holds. These colours are data — one of
 * sixteen million, read out of a file — so there is no class to have written. A `fill` on an SVG
 * rectangle is a presentation attribute rather than a style, and it is the one way to paint an
 * arbitrary colour that the policy allows.
 *
 * **And every part of it filters the list it is on**, where the list gave it a way to. A chip that
 * shows a reader their wardrobe is mostly brown and then cannot be asked for the brown ones is a
 * chip that has raised a question it will not answer; clicking a swatch or the word writes the
 * term that asks it into the box above — `colour:brown`, `size:large`. That is also the whole of
 * how anybody finds out the box takes terms at all: they clicked a thing and one appeared in it.
 * A chip on a row that is not part of the list being filtered is given no [`onFilter`] and stays
 * exactly the piece of text it was.
 */

import "./qualitiesChips.css";

import type { ReactNode } from "react";

import { BUILT_IN, COLOUR, SIZE, colourName, qualitySummary } from "./qualities";
import { termText } from "./terms";
import type { Quality } from "./types";

/** How large a swatch is drawn, in the units its own viewBox counts in. */
const SWATCH = 10;

export function Qualities({
  quality,
  onFilter,
}: {
  quality: Quality | undefined;
  /** What the list wants asked of it when part of this chip is clicked, where it takes terms. */
  onFilter?: (term: string) => void;
}): ReactNode {
  // A look the store says nothing about draws exactly as it drew before any of this existed,
  // which is what lets a store regenerated one patch late still be worth having.
  if (!quality) return null;
  // The word rather than the two colour names, because the names are already on the swatches for
  // anybody who can see them and the size is the thing no picture says. A reader who cannot see
  // them has the tooltip, which says all of it in words.
  const said = quality.size ?? colourName(quality.primary);
  const key = quality.size ? SIZE : COLOUR;
  // **No two parts of the chip ask the same thing.** A chip with no size prints the primary
  // colour's own name, and two colours measured apart can still be one word — there are eight
  // names over the whole wheel. Either way a second button asking what a button beside it
  // already asks is one thing under one name twice, which is a control to get past rather than
  // a choice for anybody reading the row through a screen reader. The word keeps its question,
  // being the larger target and the one with letters on it, and a square that has nothing left
  // to ask goes back to being a picture.
  const asked = new Set([termText(key, said)]);
  const swatch = (colour: string): ReactNode => {
    const term = termText(COLOUR, colourName(colour));
    const ask = onFilter && !asked.has(term) ? onFilter : undefined;
    asked.add(term);
    return <Swatch colour={colour} onFilter={ask} />;
  };
  return (
    <span className="chip quality" title={`${qualitySummary(quality)} · ${BUILT_IN}`}>
      {swatch(quality.primary)}
      {quality.accent ? swatch(quality.accent) : null}
      {onFilter ? (
        <Pick facet={key} said={said} onFilter={onFilter} className="quality-said" />
      ) : (
        <span className="quality-said">{said}</span>
      )}
    </span>
  );
}

/**
 * One colour, as a square.
 *
 * `aria-hidden` until it can be clicked, because the chip's own tooltip already names every colour
 * in it — a screen reader meeting two unlabelled graphics here would be told "image, image" and
 * nothing else. Once it is a way of narrowing the list it is a control rather than a decoration,
 * and it says which colour it would ask for.
 */
export function Swatch({
  colour,
  onFilter,
}: {
  colour: string;
  onFilter?: (term: string) => void;
}): ReactNode {
  const square = (
    <svg
      className="quality-swatch"
      viewBox={`0 0 ${SWATCH} ${SWATCH}`}
      width={SWATCH}
      height={SWATCH}
      aria-hidden="true"
    >
      <rect width={SWATCH} height={SWATCH} rx="3" fill={colour} />
    </svg>
  );
  if (!onFilter) return square;
  return (
    <Pick facet={COLOUR} said={colourName(colour)} onFilter={onFilter} className="quality-pick">
      {square}
    </Pick>
  );
}

/**
 * A part of the chip that narrows the list to what it says.
 *
 * Named by what it would do rather than by what it says, because "large" alone read out of a list
 * of a hundred rows is not a button anybody can act on — and the key is in there, so a reader
 * hears the difference between asking for the size and asking for the colour.
 */
function Pick({
  facet,
  said,
  onFilter,
  className,
  children,
}: {
  /** The key the term is asked under — `colour` or `size`, and never React's own `key`. */
  facet: string;
  said: string;
  onFilter: (term: string) => void;
  className: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      className={`${className} quality-ask`}
      aria-label={`Filter by ${facet}: ${said}`}
      title={`Filter by ${facet}: ${said}`}
      onClick={() => onFilter(termText(facet, said))}
    >
      {children ?? said}
    </button>
  );
}
