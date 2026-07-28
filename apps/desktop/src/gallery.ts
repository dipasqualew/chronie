/**
 * The wardrobe drawn as pictures of the thing rather than as a list of names.
 *
 * The game's own wardrobe shows every look as a character wearing it, and it is not decoration:
 * `gallery.rs` explains why there is no other way to show a chestpiece, and the short version is
 * that a chestpiece is a texture painted onto a body and not a mesh anybody could put on a
 * turntable. So a gallery row is a whole character, seen close.
 *
 * Everything here is decidable without a renderer, which is why it is here and not in
 * `galleryStage.ts`: how much of a page is asked for at a time, which rows are still waiting on
 * a model, and where a camera has to be pointed to make a boot legible on a body a hundred pixels
 * tall. The three.js half is thin and the browser tests are what exercise it.
 */

import { wearable } from "./modelPreview";
import type { AppearanceRow } from "./transmogModal";
import type { GalleryKind, WornPiece } from "./types";

/**
 * How many looks are drawn as models at a time.
 *
 * Twenty, where the same list drawn as names draws a hundred. A row of names is a string and an
 * icon; a row of models is a body out of the game's own files, a `.glb` across the process
 * boundary, and a texture uploaded to the graphics card. The number is what issue #129 asks
 * about and what `budget.rs` holds the backend to for a page.
 */
export const PAGE = 20;

/** What a row of a gallery is waiting for, or has. */
export type Thumbnail =
  | { kind: "wanted" }
  /** `shows` is the backend's word for what the `.glb` holds — a whole body, or the item. */
  | { kind: "model"; glb: string; shows: GalleryKind }
  | { kind: "nothing"; note: string };

/**
 * The rows of a page that can be shown worn, as the pieces the backend is asked about.
 *
 * The same question the set list asks before it lets a row be clicked — [`wearable`] — and for
 * the same reason: a look the game encrypts, and a thing filed under a weapon slot that nobody
 * holds, have no place on a body and there is nothing to render. Those rows keep their icon.
 */
export function piecesOf(rows: AppearanceRow[]): WornPiece[] {
  return rows
    .map((row) => wearable(row))
    .filter((wanted): wanted is { kind: "worn"; piece: WornPiece } => wanted.kind === "worn")
    .map((wanted) => wanted.piece);
}

/**
 * Which of those the window neither has nor has already sent for.
 *
 * A page is asked for in one call, and the reason to subtract what is already held first is that
 * the two halves of the browser share looks: the same helm turns up under Head and inside three
 * sets, and a reader going back and forth between kinds would otherwise pay for it each time.
 *
 * By display id rather than by appearance, because the display is what the body is drawn from —
 * two appearances that resolve to one display are one picture.
 */
export function stillWanted(
  pieces: WornPiece[],
  have: ReadonlyMap<number, Thumbnail>,
): WornPiece[] {
  const wanted = new Map<number, WornPiece>();
  for (const piece of pieces) {
    if (have.has(piece.displayInfoId) || wanted.has(piece.displayInfoId)) continue;
    wanted.set(piece.displayInfoId, piece);
  }
  return [...wanted.values()];
}

/**
 * Where a camera has to look to show one slot on a whole body.
 *
 * A gallery row is a hundred and fifty pixels tall and a character is about two metres of it, so
 * a helm framed the way the outfit pane frames a body is four pixels of hat. The game solves this
 * the same way — its wardrobe zooms to the slot being browsed — and so does this: point at the
 * part of the body the slot is on, and hold only as much of her as that part needs.
 *
 * `height` is where on her to look, as a fraction of the body from the floor to the top of the
 * head, and `holds` is how much of her height to keep in view. Both are proportions rather than
 * distances so that nothing here has to know how large the model that arrives is — the stage
 * measures that and multiplies.
 *
 * The numbers are where the parts of a human body are, and the only judgement in them is how
 * much context each slot wants: a helm is shown with the shoulders under it because a hat with
 * no neck reads as a floating object, and a cloak and a robe are shown nearly whole because that
 * is what they are.
 */
export interface Focus {
  /** Where to look, 0 at the feet and 1 at the top of the head. */
  height: number;
  /** How much of the body's height to hold in view, 1 being all of her. */
  holds: number;
}

const WHOLE: Focus = { height: 0.5, holds: 1 };

/**
 * Per `DisplayType`, which is how `ItemAppearance` numbers a slot — 0 head through 10 tabard,
 * and everything above them a weapon.
 */
const FOCUS: Record<number, Focus> = {
  0: { height: 0.92, holds: 0.3 },  // head
  1: { height: 0.82, holds: 0.35 }, // shoulders
  2: { height: 0.7, holds: 0.45 },  // shirt
  3: { height: 0.7, holds: 0.45 },  // chest
  4: { height: 0.6, holds: 0.3 },   // waist
  5: { height: 0.35, holds: 0.5 },  // legs
  6: { height: 0.08, holds: 0.25 }, // feet
  7: { height: 0.6, holds: 0.3 },   // wrist
  8: { height: 0.58, holds: 0.3 },  // hands
  9: { height: 0.6, holds: 0.9 },   // back: a cloak is most of her
  10: { height: 0.65, holds: 0.6 }, // tabard
};

/**
 * The framing for one slot on a body, or the whole of whatever arrived.
 *
 * `shows` is what the backend drew, and `"held"` short-circuits the table: a weapon, a shield
 * and an off-hand come back as the item's own mesh with no body under it, so there is no "part
 * of her the slot is on" to point at — the object *is* the picture, and holding all of it is
 * the only framing that means anything. The stage measures what it was given, which is what
 * lets one answer here frame a dagger and a polearm three times a character's height alike.
 */
export function focusOf(displayType: number, shows: GalleryKind = "worn"): Focus {
  if (shows === "held") return WHOLE;
  return FOCUS[displayType] ?? WHOLE;
}

/** A whole turn, which is what dragging the full width of a picture is worth. */
const FULL_TURN = Math.PI * 2;

/**
 * Where a drag has turned a thumbnail to: the angle it started at, plus what the pointer moved.
 *
 * A full turn across the width of the picture. That rate is the one thing here worth choosing
 * rather than inheriting: slower and a reader cannot get round to the back of a helm without
 * letting go and starting again, faster and the model spins past the side they were aiming for.
 * The width rather than a fixed number of pixels, so a tile the reader has made larger turns at
 * the same speed under the hand rather than four times as fast.
 *
 * Unbounded on purpose — dragging on round the third time is a reader who meant to, and a
 * clamp at a full turn would stop the model dead under a hand that was still moving.
 */
export function turnedBy(from: number, moved: number, across: number): number {
  if (across <= 0) return from;
  return from + (moved / across) * FULL_TURN;
}
