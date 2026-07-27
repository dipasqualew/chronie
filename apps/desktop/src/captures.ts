/**
 * The rules behind the pictures: which captures belong to what, how each one reads, and what
 * to say where there is no picture to show.
 *
 * Pure, like `sessions.ts` beside it, and for the same reason: "an evening's screenshots" and
 * "a segment's screenshots" differ only in what is handed in, and the sentence under a tile
 * is worth being able to test without a browser or a backend.
 *
 * The one thing here that is not merely formatting is [`captureTip`]. Everything else in the
 * app is put into a React tree as a value and written as text; the shared floating tooltip
 * takes HTML, because a single element is the only shape it can take a tip in — so a note,
 * which is the most user-supplied string in the application, is escaped here on the way in.
 */

import { clock, escapeHtml, plural } from "./format";
import type { Capture, CaptureThumbnailsPayload, Segment } from "./types";

/** A capture and the segment it was taken in, which is where everything about it comes from. */
export interface CapturedMoment {
  capture: Capture;
  segment: Segment;
}

/**
 * Every capture across a list of segments, in the order they were taken.
 *
 * Oldest first, unlike everything else in this app: a session and a segment are both read
 * backwards from now, but a set of photographs of one evening is read the way the evening
 * went. Ties are broken on the row id so a grid never reshuffles between repaints.
 */
export function capturedMoments(segments: Segment[]): CapturedMoment[] {
  return segments
    .flatMap((segment) => (segment.captures || []).map((capture) => ({ capture, segment })))
    .sort((left, right) =>
      (left.capture.at || 0) - (right.capture.at || 0) || left.capture.id - right.capture.id);
}

/** The ids whose thumbnails a grid of these needs; the ones with no image are not asked for. */
export const thumbnailIds = (moments: CapturedMoment[]): number[] =>
  moments.filter(({ capture }) => capture.imageState === "stored").map(({ capture }) => capture.id);

/**
 * Why there is no picture, or null when there is one to draw.
 *
 * Three different things and three different sentences. A tile that said "no image" to all of
 * them would be telling somebody their screenshot was lost when in fact they never took one.
 */
export function missingReason(capture: Capture): string | null {
  if (capture.imageState === "stored") return null;
  if (capture.imageState === "none") return "A note, with no picture taken.";
  return "Chronie could not find the file the game wrote for this one.";
}

/** What a tile is called: the moment, which is the one thing every capture has. */
export const captureTitle = (moment: CapturedMoment): string => clock(moment.capture.at);

/**
 * Why the capture exists, when it was not somebody pressing the key.
 *
 * The presence of a trigger is the whole difference between the two, so it is worth saying —
 * and worth saying in words, because `accountFirstAchievement` is a name from a settings file
 * rather than a sentence anybody would write.
 */
export function captureReason(capture: Capture): string {
  if (!capture.trigger) return "";
  return TRIGGER_LABELS[capture.trigger] || `Taken automatically: ${capture.trigger}`;
}

/** What each of the addon's own rules means — see `ns.newCaptureTriggers`. */
const TRIGGER_LABELS: Record<string, string> = {
  accountFirstAchievement: "Taken for an account first",
  achievement: "Taken for an achievement",
  levelUp: "Taken for a level up",
  mount: "Taken for a new mount",
  pet: "Taken for a new pet",
  toy: "Taken for a new toy",
  keystone: "Taken for a keystone run",
  keystoneOnTime: "Taken for a keystone beaten on time",
};

/**
 * The facts under a picture, in the order somebody would ask for them: who, where, when it
 * was written, and how big the file is.
 *
 * Everything but the moment comes off the segment rather than off the capture, which is the
 * point of a capture being linked to one: the segment already knows the character, the place
 * and the difficulty, settled by the client that was standing there.
 */
export function captureFacts({ capture, segment }: CapturedMoment): string[] {
  const facts = [segment.character, segment.instance, clock(capture.at)];
  const reason = captureReason(capture);
  if (reason) facts.push(reason);
  if (capture.byteSize) facts.push(fileSize(capture.byteSize));
  return facts.filter(Boolean);
}

/** A byte count as somebody would say it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return plural(bytes, "byte");
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ${units[unit]}`;
}

/**
 * What the floating tooltip is handed for one tile.
 *
 * The one string of markup this feature builds, and therefore the one place a note has to be
 * escaped by hand: `#tooltip` assigns `data-tip` straight to `innerHTML`, so an unescaped note
 * would be markup out of a text field the user typed into. Everywhere else a note appears — the
 * tile, the viewer, the field itself — it is a value in a React tree and is written as text
 * with nothing to remember.
 */
export function captureTip(moment: CapturedMoment): string {
  const note = moment.capture.note;
  const title = note ? escapeHtml(note) : "No note yet";
  return `<b>${title}</b>${captureFacts(moment).map(escapeHtml).join(" · ")}`;
}

/**
 * How a fold reads before anybody has opened it: how many pictures, and how many of them are
 * only markers.
 *
 * The second half is not padding. A player who took ten screenshots and finds nine of them is
 * owed an explanation on the way in rather than after opening the grid and counting.
 */
export function captureSummary(moments: CapturedMoment[]): string {
  const shown = moments.filter(({ capture }) => capture.imageState === "stored").length;
  const lost = moments.filter(({ capture }) => capture.imageState === "missing").length;
  const counted = plural(shown, "screenshot");
  if (!moments.length) return "No screenshots";
  if (!lost) return counted;
  return `${counted} · ${lost} without a file`;
}

/**
 * Whether a note has actually changed, which is what decides if a write is worth making.
 *
 * The comparison is on the trimmed text because that is what the backend will store: a field
 * somebody clicked into and out of again has not been edited, and asking the backend to say so
 * would repaint the whole window for nothing.
 */
export const noteChanged = (capture: Capture, typed: string): boolean =>
  typed.trim() !== (capture.note || "").trim();

/** What deleting one of these takes with it, said plainly enough to be a confirmation. */
export function deleteWarning(capture: Capture): string {
  return capture.imageState === "stored"
    ? "Delete this screenshot? The picture is deleted from Chronie's storage as well as the " +
      "entry, and neither can be recovered."
    : "Delete this entry? It cannot be recovered.";
}

/* ---------- the pictures the window has been handed ---------- */

export interface CaptureAlbum {
  /**
   * Fetches the thumbnails among `ids` that have not been fetched already, calling `changed`
   * when they land. Never called for a request that turned up nothing new.
   */
  learn: (ids: number[], changed: () => void) => Promise<void>;
  thumbnail: (id: number) => string | undefined;
  /**
   * Drops what is held for one capture, which the delete path calls.
   *
   * Not merely tidiness. A capture id is a SQLite rowid, and a rowid is reused once the row
   * holding the highest one is deleted — so an album that kept a deleted capture's picture
   * could hand it to the next capture ingested and show somebody a photograph of the wrong
   * evening.
   */
  forget: (id: number) => void;
}

/**
 * The thumbnails this window has been handed, kept for as long as it runs.
 *
 * The same shape as the achievement book beside it, and for the same reason: a reader
 * scrolling back through a history meets the same evening's pictures every time they come
 * past it, and each one should cross the bridge once. The backend caches them on disk as
 * well, so this saves the round trip rather than the work.
 *
 * A request that fails is forgotten rather than remembered as nothing, again like the book: a
 * grid whose pictures did not arrive draws the same placeholder as one whose captures have no
 * image, and it is worth another try the next time somebody opens that evening.
 */
export function createCaptureAlbum(
  load: (ids: number[]) => Promise<CaptureThumbnailsPayload>,
): CaptureAlbum {
  const known = new Map<number, string>();
  const asked = new Set<number>();

  return {
    learn: async (ids, changed) => {
      const fresh = [...new Set(ids)].filter((id) => id > 0 && !asked.has(id));
      if (!fresh.length) return;
      for (const id of fresh) asked.add(id);
      try {
        const payload = await load(fresh);
        for (const [id, url] of Object.entries(payload.thumbnails ?? {})) known.set(Number(id), url);
      } catch {
        for (const id of fresh) asked.delete(id);
        return;
      }
      changed();
    },
    thumbnail: (id) => known.get(id),
    forget: (id) => {
      known.delete(id);
      asked.delete(id);
    },
  };
}
