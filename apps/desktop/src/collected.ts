/**
 * Which of the game's looks the reader actually owns, and what that answer is worth.
 *
 * Everything else the transmog view draws comes out of the installed game and is therefore the
 * same for everybody on that build: `wardrobe.rs` reads all 55,198 appearances of a shipping
 * install and `transmog.rs` reads the sets that name them, and neither has any idea whether the
 * account has collected one of them. This is the other side of that — Chronie's own database,
 * filled by the addon walking the client's wardrobe — and it is the difference between a browser
 * of the game and a browser of a *wardrobe*.
 *
 * It keys on the same number the game's own tables do. The client calls it a `visualID` and
 * `ItemAppearance` calls it a row id, and they are one number, so the join is a set lookup and
 * nothing more — see `collector::census::collected_appearances`.
 *
 * **The one thing this file exists to get right is what may be said over the answer.** The client
 * only ever shows the wardrobe through the logged-in character's class filter — a mage is not
 * shown plate — so what is stored is the *union* of what the roster's characters have each been
 * able to see, built up as they are played. Which means a look that is here is one the account
 * certainly owns, and a look that is not here is one nobody has yet been in a position to prove it
 * owns. Those are not opposites. A screen that drew the second as "you do not own this" would be
 * telling a reader something false about their own collection, which is why [`collectedNote`]
 * exists and why nothing here ever answers "uncollected".
 */

import type { CollectedAppearancesPayload } from "./types";

/**
 * The looks the account has been seen to own, as something a list can ask per row.
 *
 * A set rather than the payload's array for the reason `marks.ts` builds an index: a page of a
 * hundred rows re-filtered on every keystroke against thirty thousand ids is three million
 * comparisons that a hash lookup does not do.
 */
export interface CollectedLooks {
  /** Whether the account has been *seen* to own this look. Never the negation of that. */
  has: (appearanceId: number) => boolean;
  /** How many looks are known to be owned, which is what a summary counts. */
  count: number;
  /**
   * What the client's own unfiltered counter made of the same question, or nothing.
   *
   * The honest measure of how far the union has got: `count` is what the roster has managed to
   * show us and this is what the game says there is to see. They meet when enough armour types
   * have been played.
   */
  counted: number | null;
  /**
   * How much of an answer this is at all, which is three states rather than two.
   *
   * `unread` is a browser that has not had the answer back yet, or could not — and it says
   * nothing, because a screen that announced a shortfall for the half-second before the answer
   * landed would be announcing one it has no idea exists. `unwalked` is the answer having
   * arrived and said that nothing has ever walked the wardrobe, which is worth a sentence.
   */
  state: "unread" | "unwalked" | "walked";
}

/** Nothing has been read, which is what every screen draws before the answer lands. */
export const NOTHING_COLLECTED: CollectedLooks = {
  has: () => false,
  count: 0,
  counted: null,
  state: "unread",
};

export function indexCollected(payload: CollectedAppearancesPayload | null): CollectedLooks {
  if (!payload) return NOTHING_COLLECTED;
  if (!payload.reading) return { ...NOTHING_COLLECTED, state: "unwalked" };
  const owned = new Set(payload.appearances);
  return {
    has: (appearanceId) => owned.has(appearanceId),
    count: owned.size,
    counted: payload.reading.counted ?? null,
    state: "walked",
  };
}

/**
 * The sentence a browser has to carry beside a collected mark, or nothing to say.
 *
 * Not decoration and not a footnote. A reader looking at a wardrobe where some rows are marked
 * and some are not will read the unmarked ones as "not collected" unless told otherwise, and on
 * this reading that is wrong for every look the walking characters' classes could not be shown.
 * So the shortfall is said out loud wherever it is real, and says which of the two things it is:
 * the wardrobe has never been walked, or it has been walked by too few of the roster.
 */
export function collectedNote(looks: CollectedLooks): string | null {
  if (looks.state === "unread") return null;
  if (looks.state === "unwalked") {
    return "Nothing has walked the wardrobe yet, so no look here is marked as collected. Log in to the game with Chronie installed and it will.";
  }
  if (looks.counted != null && looks.counted > looks.count) {
    const missing = looks.counted - looks.count;
    return `The game counts ${missing.toLocaleString()} more collected ${missing === 1 ? "look" : "looks"} than this. A character is only ever shown the appearances its own class can wear, so an unmarked look here may be one nobody has logged in to see yet.`;
  }
  return null;
}
