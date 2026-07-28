/**
 * What the set detail's preview should show for one appearance, and the arithmetic behind it.
 *
 * Kept apart from `modelViewer.ts` because none of this needs a renderer: which appearances
 * have a model at all is a fact about the game's files, and framing one is trigonometry. The
 * three.js half is thin on purpose, and everything decidable without a canvas is decided here.
 */

import { isHeld } from "./transmogModal";
import type { WornPiece } from "./types";

/** Whether a row of a set is something the character can wear, and what it is if not. */
export type Wearable =
  | { kind: "worn"; piece: WornPiece }
  | { kind: "nowhere"; note: string };

/**
 * What the pane says about what it is showing, and what a row that cannot be worn says.
 *
 * A set is shown as a set now, so the pane's two sentences are the whole outfit and the bare
 * body — and the explanations that are left belong to the rows rather than to the pane. Both
 * of them are facts about the game rather than about this install: `withheld` is an appearance
 * the game encrypts, and `nowhere` a thing the game files under a weapon slot and gives no
 * place on a body — arrows, and an item whose own row is withheld so nothing says a hand.
 *
 * The second half of each of the pane's own two is the only place the app says which buttons
 * do what. Nothing on a canvas advertises that the right one moves the model, and a reader who
 * never finds out is left with the zoom that goes past the edges of the pane and no way back
 * across them.
 *
 * What is gone with the single-appearance pane is the pair that explained an install rather
 * than a game — a slot whose model file is missing, a slot whose every texture was painted for
 * another body. Neither is attributable once twelve pieces come back as one body, and what a
 * reader sees instead is the gap in the outfit where that piece would have been.
 */
export const REASONS = {
  set: "Worn on the character. Drag to turn it, right-drag to move it.",
  bare: "Nothing is worn. Drag to turn it, right-drag to move it.",
  unshowable: "This install holds nothing to put on the character for these.",
  withheld: "The game keeps this appearance encrypted.",
  nowhere: "The game gives this appearance no place on a character.",
} as const;

/** The appearances an outfit needs to tell apart, which is less than a row carries. */
export interface Previewable {
  displayType: number;
  inventoryType: number;
  displayInfoId: number;
  iconFileDataId: number;
  hasModel: boolean;
  withheld: boolean;
}

/**
 * The display types worn on the body: every armour slot, head through tabard.
 *
 * Everything above them is a weapon or a shield, and where one of those goes is a question the
 * display type does not answer — see [`isHeld`], which asks the item instead.
 */
const ARMOUR = (displayType: number): boolean => displayType >= 0 && displayType <= 10;

/**
 * Whether one appearance goes on the character, and as what.
 *
 * **Every appearance the game says a place for is worn**, whether or not it has geometry: a
 * helm has a model and the only place that model means anything is on a head, and a sword
 * means as little in mid-air as a helm does. So armour goes on the body by its slot, and a
 * weapon goes there when the item says which hand it is held in.
 *
 * What is left is the two the game itself has nothing to say about, and neither is a failure
 * of this install: a row the game encrypts outright, and a thing filed under a weapon slot
 * that nobody holds. Those rows stay in the list and stay off the character, because a set is
 * what the game says it is and a list one row short reads as a bug.
 */
export function wearable(appearance: Previewable): Wearable {
  if (appearance.withheld) return { kind: "nowhere", note: REASONS.withheld };
  if (ARMOUR(appearance.displayType) || isHeld(appearance.displayType, appearance.inventoryType)) {
    return {
      kind: "worn",
      piece: {
        displayInfoId: appearance.displayInfoId,
        displayType: appearance.displayType,
        inventoryType: appearance.inventoryType,
      },
    };
  }
  return { kind: "nowhere", note: REASONS.nowhere };
}

/**
 * The outfit a list of rows and a set of picks comes to, in the order the rows are listed.
 *
 * The row order rather than the picking order, so that taking a piece off and putting it back
 * asks for the outfit it asked for before — which is what makes caching one worth doing. What
 * order the pieces actually composite in is the backend's, out of the game's own table, and
 * nothing here needs to know it.
 */
export function outfitOf(rows: Previewable[], picked: ReadonlySet<number>): WornPiece[] {
  return rows
    .map((row, index): WornPiece | null => {
      if (!picked.has(index)) return null;
      const wanted = wearable(row);
      return wanted.kind === "worn" ? wanted.piece : null;
    })
    .filter((piece): piece is WornPiece => piece !== null);
}

/**
 * How an outfit is named, for anything holding on to one: its display ids, sorted, joined.
 *
 * Sorted rather than left in the order they are worn, because two lists of the same pieces are
 * the same outfit and get the same body back — the backend lays them out by slot before it
 * does anything else. An appearance a set names twice keeps both of its places, for the same
 * reason the list itself does: that is what the set says, and it is not the same outfit as the
 * one that names it once.
 */
export function wornSetKey(pieces: WornPiece[]): string {
  return pieces
    .map((piece) => piece.displayInfoId)
    .sort((left, right) => left - right)
    .join(",");
}

/** The `.glb` inside a data URL, as the bytes a loader parses. */
export function glbBytes(dataUrl: string): Uint8Array {
  const prefix = "data:model/gltf-binary;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("That is not a model this window can read.");
  const binary = atob(dataUrl.slice(prefix.length));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * How far back a camera has to sit to hold a sphere of `radius` in a `fov` degree view.
 *
 * The margin is what keeps a helm from touching the edges of the pane, and the floor is for
 * the models that are nearly flat — a cloak is a sheet, and framing its radius exactly would
 * put the camera inside it.
 */
export function framingDistance(radius: number, fov: number): number {
  const half = (fov / 2) * (Math.PI / 180);
  return Math.max(radius / Math.tan(half), 0.1) * 1.4;
}

/** Where a model can be looked at from. */
export type View = "default" | "front" | "back" | "left" | "right";

/**
 * Which way the camera sits, per named view, as a direction from the model's middle.
 *
 * `default` is the one the window opens on and is deliberately not square to anything: an
 * item seen exactly head on reads as a silhouette, and the whole point of showing it in 3D is
 * that it has a shape. The four named ones are square on purpose — they are what a render
 * asked for twice has to produce the same picture from.
 *
 * They name where the camera goes and not which way the model is facing, and on a character
 * the two are not the same: M2 is X-forward, so `right` is the view a character looks out of
 * and `front` is its left shoulder. Naming them after the axes is the only version of this
 * that stays true for a helm, a cloak and a body at once.
 */
const DIRECTIONS: Record<View, [number, number, number]> = {
  default: [0.45, 0.25, 1],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

/**
 * Where to put a camera that is `distance` from a model, looking at it from `view`.
 *
 * The named views are unit directions scaled by the distance. `default` is left at the
 * offsets the window has always used rather than normalised to them, because normalising it
 * would move the camera the reader is used to for the sake of a tidier rule.
 */
export function cameraFor(view: View, distance: number): [number, number, number] {
  const [x, y, z] = DIRECTIONS[view];
  return [x * distance, y * distance, z * distance];
}
