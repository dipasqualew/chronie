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
 */

import type { ReactNode } from "react";

import { BUILT_IN, colourName, qualitySummary } from "./qualities";
import type { Quality } from "./types";

/** How large a swatch is drawn, in the units its own viewBox counts in. */
const SWATCH = 10;

export function Qualities({ quality }: { quality: Quality | undefined }): ReactNode {
  // A look the store says nothing about draws exactly as it drew before any of this existed,
  // which is what lets a store regenerated one patch late still be worth having.
  if (!quality) return null;
  return (
    <span className="chip quality" title={`${qualitySummary(quality)} · ${BUILT_IN}`}>
      <Swatch colour={quality.primary} />
      {quality.accent ? <Swatch colour={quality.accent} /> : null}
      {/* The word rather than the two colour names, because the names are already on the
          swatches for anybody who can see them and the size is the thing no picture says. A
          reader who cannot see them has the tooltip, which says all of it in words. */}
      <span className="quality-said">{quality.size ?? colourName(quality.primary)}</span>
    </span>
  );
}

/**
 * One colour, as a square.
 *
 * `aria-hidden`, because the chip's own tooltip already names every colour in it — a screen
 * reader meeting two unlabelled graphics here would be told "image, image" and nothing else.
 */
function Swatch({ colour }: { colour: string }): ReactNode {
  return (
    <svg
      className="quality-swatch" viewBox={`0 0 ${SWATCH} ${SWATCH}`}
      width={SWATCH} height={SWATCH} aria-hidden="true"
    >
      <rect width={SWATCH} height={SWATCH} rx="3" fill={colour} />
    </svg>
  );
}
