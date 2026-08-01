/**
 * Asking the game to walk the account's collections again, and saying where that ask has got to.
 *
 * The census is provoked rather than scheduled — a build change, a domain that was never whole,
 * or the client's own counter saying there is more, and `docs/account-census.md` argues at length
 * for why none of those is a timer. What none of them covers is a reader who simply knows better,
 * and this is the one thing they can do about it.
 *
 * **Nothing about it is immediate, and the whole of this module's job is saying so.** The app
 * writes a request into a source file of the addon's own; the addon reads that file *at load*,
 * takes the walk, and writes down what it found *at logout* — because `ChronieDB` is written once,
 * at teardown. So the screen must talk about the next login rather than about what is happening
 * now, and a button that implied otherwise would be a button people press twice.
 *
 * The rules live here and `collectionView.tsx` only draws them, the same split every other view in
 * this app makes.
 */

import { ago } from "./format";

import type { CensusRequest } from "./bindings";

/**
 * Where the last thing somebody asked for has got to.
 *
 * - `none` — nothing has ever been asked for. There is no history to draw, only the offer.
 * - `waiting` — asked for, and the game has not been played since. This is the state the
 *   affordance exists to explain, and the state in which asking again would do nothing.
 * - `walked` — the addon took the walk and said so.
 * - `unknown` — the addon read the request and had nothing it could walk. Only reachable when the
 *   request named domains this client build does not answer for, which a targeted probe from a
 *   newer app against an older addon could produce.
 */
export type ResyncState = "none" | "waiting" | "walked" | "unknown";

export interface Resync {
  state: ResyncState;
  /** What the screen says about the last ask. Empty when there has never been one. */
  sentence: string;
  /**
   * Whether asking again would achieve anything.
   *
   * False while one is already waiting. A second request would be a second row, a second entry in
   * the addon's folder and exactly the same walk — and the button going quiet is the plainest way
   * of saying the first one has not been collected yet.
   */
  canAsk: boolean;
}

/** What the button offers when there is nothing outstanding. */
export const ASK = "Walk them all again";

/**
 * What the reader is promised by pressing it, which is deliberately not "now".
 *
 * Drawn beside the button whatever state the ask is in, because it is the answer to the question
 * the button raises rather than a report on any particular request.
 */
export const PROMISE =
  "Chronie asks the addon to walk every collection again. It happens the next time you log in, " +
  "and what it finds is written down when you log out.";

/**
 * The newest ask, and what to say about it.
 *
 * `requests` arrive newest first, which is the order the command answers in, so the newest is the
 * one this is about: an older ask that was answered says nothing a reader wants once a newer one
 * is outstanding.
 *
 * @param now Epoch seconds, injected so the tests can pin what "two days ago" means.
 */
export function resyncOf(requests: CensusRequest[] | null, now?: number): Resync {
  const newest = (requests || [])[0];
  if (!newest) {
    return { state: "none", sentence: "", canAsk: true };
  }
  if (newest.appliedAt == null) {
    return {
      state: "waiting",
      sentence: `Asked for ${ago(newest.createdAt, now)}, and not collected yet — the addon reads it the next time you log in.`,
      canAsk: false,
    };
  }
  if (newest.outcome === "unknown") {
    return {
      state: "unknown",
      // The one failure worth a sentence of its own: everything else on this screen would go on
      // reading as though a walk had happened, when the addon in the game answered for none of it.
      sentence: `Asked for ${ago(newest.createdAt, now)}, and the addon had nothing it could walk — the collections it named are not ones that game client answers for.`,
      canAsk: true,
    };
  }
  const walked = newest.walked.length ? ` — ${newest.walked.join(", ")}` : "";
  return {
    state: "walked",
    sentence: `Walked ${ago(newest.appliedAt, now)}${walked}. The readings above are what that walk left behind.`,
    canAsk: true,
  };
}
