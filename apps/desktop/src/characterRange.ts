/**
 * How far back a character's activity section is looking, and what falls inside it.
 *
 * The one rule the section is built on: **what a character has been doing lately is a different
 * question from what they have ever done.** The summary beside it is cumulative by nature — a
 * wallet, a standing, a wardrobe are all "as of now" — and the doing is not. An alt played twice
 * last spring and a main played every night both have a page full of segments, and only a window
 * over them tells the two apart.
 *
 * Two weeks by default because that is roughly a raid tier's worth of habit: long enough that a
 * week off does not empty the page, short enough that "lately" still means lately.
 *
 * Pure, so the rule is tested without a browser: ranges and a moment in, segments out. `now` is
 * always injected rather than read here — the drawing decides it once and every reckoning on the
 * page is made from the same moment, so a range cannot shift under a reader mid-render.
 */

import type { Segment } from "./types";

/** One choice on the range selector. */
export interface Range {
  /** What the `<select>` carries as its value, and what the view holds. */
  key: string;
  label: string;
  /** How far back it reaches, or null for the one that reaches all the way. */
  days: number | null;
}

/**
 * The ranges on offer, shortest first.
 *
 * Five, and deliberately coarse. A date picker would be the general answer and the wrong one:
 * nobody reading their own history wants to name two dates, they want "recently" and "a while
 * back", and every one of these is a phrase somebody would actually say.
 */
export const RANGES: Range[] = [
  { key: "week", label: "Last week", days: 7 },
  { key: "fortnight", label: "Last 2 weeks", days: 14 },
  { key: "month", label: "Last 30 days", days: 30 },
  { key: "quarter", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
];

/** Where the section opens. */
export const DEFAULT_RANGE = "fortnight";

/** The widest one, which is what an empty page offers as the way out of itself. */
export const WIDEST_RANGE = "all";

const DAY_SECONDS = 86_400;

/** The range a key names, falling back to the default rather than to nothing. */
export function rangeOf(key: string): Range {
  return (
    RANGES.find((range) => range.key === key) ??
    RANGES.find((range) => range.key === DEFAULT_RANGE)!
  );
}

/**
 * The moment a range starts at, or null where it starts at the beginning of the history.
 *
 * Counted back from `now` in whole days rather than from midnight, which is the reading that
 * makes "the last two weeks" mean the same thing at nine in the morning and at midnight: a
 * calendar-day version would quietly be thirteen days and a bit for most of the evening, which
 * is the exact stretch a player is looking at their history in.
 */
export function since(range: Range, now: number): number | null {
  return range.days === null ? null : now - range.days * DAY_SECONDS;
}

/**
 * The segments a range holds, in the order they arrived.
 *
 * Judged on when a segment *ended*, so a long night that began before the window began is in it:
 * the reader asking about the last fortnight means the play that happened in the last fortnight,
 * and a raid that started ten minutes early is not a different fortnight's raid.
 */
export function within(segments: Segment[], range: Range, now: number): Segment[] {
  const from = since(range, now);
  if (from === null) return segments;
  return segments.filter((segment) => (segment.endedAt || segment.startedAt || 0) >= from);
}
