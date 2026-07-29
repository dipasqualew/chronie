/**
 * What to say about deleting combat logs.
 *
 * This is the only irreversible thing Chronie does, so nothing here is cheerful about it and
 * nothing here rounds a number down. What the panel has to get across, in this order: what
 * would go if the sweeper ran now, what would not go and why, and what has already gone.
 *
 * The middle one is the one that matters. An old log nothing has read is a raid night somebody
 * logged before Chronie could read one, and it is never deleted — but a tool that silently
 * skipped it would be indistinguishable from one that was not running, so it is said out loud
 * and left for the reader to deal with.
 *
 * The panel that shows these is `retentionPanel.tsx`.
 */

import { ago, fileSize } from "./format";
import type { LogPile, LogRetention } from "./types";

/** The shortest window the backend will accept, mirroring `retention::MIN_RETAIN_DAYS`. */
export const MIN_DAYS = 1;

/** What the number box offers when nobody has set one, mirroring `DEFAULT_RETAIN_DAYS`. */
export const DEFAULT_DAYS = 7;

/** The longest window worth offering. A year of raid logs is the disk this exists to save. */
export const MAX_DAYS = 365;

/** A window somebody typed, brought inside what the backend will honour. */
export function windowDays(typed: number): number {
  if (!Number.isFinite(typed)) return DEFAULT_DAYS;
  return Math.min(Math.max(Math.round(typed), MIN_DAYS), MAX_DAYS);
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** A pile as a size and a count, which is the pair somebody actually weighs. */
export function pileSize(pile: LogPile): string {
  return `${plural(pile.count, "log", "logs")}, ${fileSize(pile.bytes)}`;
}

/**
 * The one line that says what the sweeper is doing, or would do.
 *
 * Off is not silence: the sentence still says what turning it on would cost, because that is
 * the whole of the decision and it has to be readable before the switch rather than after.
 */
export function sweepSentence(status: LogRetention): string {
  const window = `${plural(status.days, "day", "days")}`;
  if (!status.enabled) {
    return status.doomed.count === 0
      ? `Chronie deletes no combat logs. Turning this on at ${window} would delete nothing ` +
          "today — there is nothing old enough that Chronie has finished reading."
      : `Chronie deletes no combat logs. Turning this on at ${window} would delete ` +
          `${pileSize(status.doomed)} on the next sync.`;
  }
  return status.doomed.count === 0
    ? `Deleting combat logs Chronie has read once they are older than ${window}. ` +
        "Nothing is waiting to be deleted."
    : `Deleting combat logs Chronie has read once they are older than ${window}. ` +
        `${pileSize(status.doomed)} go on the next sync.`;
}

/**
 * The rest of what a reader needs, one line each: what will not be touched, and what has been.
 *
 * `unread` comes first and is worded as a thing to act on rather than a statistic. It is the
 * only pile Chronie will never clear by itself, and somebody who wants that disk back has to
 * go and delete those files knowing what they are.
 */
export function sweepDetail(status: LogRetention, now?: number): string[] {
  const lines: string[] = [];
  if (status.unread.count > 0) {
    lines.push(
      `${pileSize(status.unread)} are older than the window and have never been read by ` +
        "Chronie — logs from before it was watching, most likely. These are never deleted. " +
        "Removing them is yours to do.",
    );
  }
  if (status.unfinished.count > 0) {
    lines.push(
      `${pileSize(status.unfinished)} are older than the window and only partly read. ` +
        "Chronie is still working through them and will not delete one until it has finished.",
    );
  }
  if (status.removed.length > 0) {
    const last = status.removed[0];
    lines.push(
      `Last deleted: ${last.name} — ${fileSize(last.bytes)}, ${ago(last.deletedAt, now)}, ` +
        `after ${plural(last.linesRead, "line", "lines")} of it had been read.`,
    );
  }
  return lines;
}

/**
 * The files a pile names, worded so the claim above them can be checked.
 *
 * Only the first ten travel from the backend, so a pile with more than that says so rather
 * than quietly showing a tenth of itself as though it were all of it.
 */
export function pileFiles(pile: LogPile, now?: number): string[] {
  const lines = pile.files.map((file) => {
    const when = file.modified ? `last written ${ago(file.modified, now)}` : "undated";
    return `${file.name} — ${fileSize(file.bytes)}, ${when}.`;
  });
  const rest = pile.count - pile.files.length;
  if (rest > 0) lines.push(`…and ${plural(rest, "other", "others")}.`);
  return lines;
}
