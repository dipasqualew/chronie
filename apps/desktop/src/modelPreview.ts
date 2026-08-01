/**
 * What the set detail's preview should show for one appearance, and the arithmetic behind it.
 *
 * Kept apart from `modelViewer.ts` because none of this needs a renderer: which appearances
 * have a model at all is a fact about the game's files, and framing one is trigonometry. The
 * three.js half is thin on purpose, and everything decidable without a canvas is decided here.
 */

import type { Focus } from "./gallery";
import { isHeld } from "./transmogModal";
import type { WornPiece } from "./types";

/** Whether a row of a set is something the character can wear, and what it is if not. */
export type Wearable = { kind: "worn"; piece: WornPiece } | { kind: "nowhere"; note: string };

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

/** Where a model can be looked at from. */
export type View = "default" | "front" | "back" | "left" | "right" | "tile";

type Triple = [number, number, number];

const cross = (a: Triple | readonly [number, number, number], b: Triple): Triple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const unit = (a: Triple): Triple => {
  const length = Math.hypot(...a);
  return length < 1e-9 ? [0, 0, 1] : [a[0] / length, a[1] / length, a[2] / length];
};

/**
 * Which way the camera sits, per named view, as a direction from the model's middle.
 *
 * They name where the camera goes and not which way the model is facing, and on a character
 * the two are not the same: M2 is X-forward, so `right` is the view a character looks out of
 * and `front` is its left shoulder. Naming them after the axes is the only version of this
 * that stays true for a helm, a cloak and a body at once.
 *
 * **`default` is `right` by another name, and that is the point.** It used to be off every
 * axis, on the argument that a thing seen exactly head on reads as a silhouette — which is
 * true of a helm on its own and quite wrong about a person. What the window actually opens on
 * is a woman in the clothes somebody is choosing for her, and the reader wanting to see the
 * front of a tabard was being shown three quarters of her left side. Every view of her is one
 * drag away and this is the one to start from; the axis it happens to be is the game's.
 *
 * `tile` is the odd one and the only one off an axis. A thumbnail is a hundred pixels and cannot
 * be zoomed, panned or turned off its own axis, so a look shown square on reads as a silhouette
 * with no way for the reader to fix it — which is an argument about small pictures rather than
 * about models, and is why it does not apply to the pane. Slightly round and slightly above,
 * so a shoulder has depth and a helm has a top.
 */
const DIRECTIONS: Record<View, [number, number, number]> = {
  default: [1, 0, 0],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  tile: unit([0.45, 0.12, 1]),
};

/** Where to put a camera that is `distance` from a model, looking at it from `view`. */
export function cameraFor(view: View, distance: number): [number, number, number] {
  const [x, y, z] = DIRECTIONS[view];
  return [x * distance, y * distance, z * distance];
}

/**
 * How much of the pane's two directions a model takes up, and how much of it is depth.
 *
 * All half-sizes, in the model's own units, measured from a box centred on the origin — which
 * is what `frameModel` has just made of it. `across` and `up` are what has to fit; `deep` is
 * the part that does not show and still has to be paid for, because perspective enlarges what
 * is nearest and the nearest corner of a body is half its depth in front of its middle.
 */
export interface OnScreen {
  across: number;
  up: number;
  deep: number;
}

/** Which way is up in the world the models are put into, and the only one they are given. */
const UP: readonly [number, number, number] = [0, 1, 0];

/**
 * A box of `size` seen from `view`, as the three half-sizes framing it needs.
 *
 * The box is axis-aligned and every view is square to an axis, so two of the three answers are
 * always just half of one side. It is done in the general way regardless — project the box's
 * extent onto the camera's own right, up and forward — because that stays correct for a view
 * that is not square to anything, and this file has already had one of those and may again.
 */
export function onScreen(size: Triple, view: View): OnScreen {
  const forward = unit([...DIRECTIONS[view]] as Triple);
  const sideways = cross(UP, forward);
  // Straight down at something is the one direction that leaves nothing to call sideways.
  const right = unit(Math.hypot(...sideways) < 1e-9 ? [1, 0, 0] : sideways);
  const up = unit(cross(forward, right));
  const reach = (axis: Triple): number =>
    (Math.abs(axis[0]) * size[0] + Math.abs(axis[1]) * size[1] + Math.abs(axis[2]) * size[2]) / 2;
  return { across: reach(right), up: reach(up), deep: reach(forward) };
}

/**
 * How much room to leave around a framed model: four per cent of it, and no more.
 *
 * It used to be forty, which is where "the model is tiny and I zoom in every time I open this"
 * came from. A margin is worth having — a body whose scalp touches the top edge reads as one
 * that has been cut off — but the pane is small and the clothes are the errand, so the margin
 * is the smallest one that still reads as deliberate.
 */
const MARGIN = 1.04;

/**
 * How far back a camera has to sit to hold a model in a `fov` degree view of a pane `aspect`
 * wide for its height.
 *
 * Both directions, which is the half that used to be missing. Framing was done against the
 * radius of the model's bounding *sphere* and against the vertical field of view alone: the
 * sphere around a person is nearly as wide as she is tall, so a body was framed as though it
 * were a ball with her inside it, and the pane was left mostly empty around her.
 *
 * The horizontal field of view is the vertical one widened by the aspect, so a wide pane
 * spends its extra room on nothing and a narrow one is what actually decides the distance.
 *
 * The depth is added rather than fitted. Everything else here is the arithmetic of a flat
 * rectangle at the middle of the model, and the corner that overflows a tight frame is the one
 * nearest the camera — so the camera is put where that face is framed, and the middle sits half
 * a depth further off. The floor is for the models that are nearly flat: a cloak is a sheet,
 * and framing one exactly would put the camera inside it.
 */
export function framingDistance(seen: OnScreen, fov: number, aspect: number): number {
  const half = Math.tan((fov / 2) * (Math.PI / 180));
  const wide = half * Math.max(aspect, 0.01);
  const back = Math.max((seen.up * MARGIN) / half, (seen.across * MARGIN) / wide);
  return Math.max(back + seen.deep, 0.1);
}

/** Where a model goes, where the camera goes, and how far the two may be dragged apart. */
export interface Framing {
  /** Where to put the model, so that the part being looked at sits on the origin. */
  offset: [number, number, number];
  /** How far the camera stands off it. */
  distance: number;
  /** How far a pan may carry the middle of the pane off what is being looked at. */
  leash: number;
}

/**
 * A model placed so that the part `focus` names is the middle of the pane, and a camera put
 * where it holds that part and no more.
 *
 * **The offset is the whole of the fix for a helm that swung about the pane as it was turned.**
 * A stage orbits its target and its target is the origin, so whatever is put on the origin is
 * what a drag turns *in place* and what a scroll zooms *towards*. Centring the model's bounding
 * box put a two-metre character's pelvis there — so a reader who came to look at a helm, zoomed
 * in on it and dragged was orbiting a point a metre below the thing they were looking at, and
 * the helm swept off the pane at the first degree. Framed on the head, the same drag turns the
 * head.
 *
 * `focus` is `gallery.ts`'s, and deliberately the same table: the thumbnail of an appearance
 * and the pane it opens into are two sizes of one picture, and a reader who clicked a helm
 * because it filled its tile should not be handed a whole woman.
 *
 * What has to fit is the model's box clipped to a cube of the held size around that point — a
 * slice of a body for a slot on one. A `focus` that holds the whole model clips to nothing at
 * all and frames exactly what this file framed before there was a focus, which matters: that is
 * the character pane, and a polearm three times a character's height is wider than it is tall.
 */
export function frameOn(
  low: [number, number, number],
  high: [number, number, number],
  focus: Focus,
  view: View,
  fov: number,
  aspect: number,
): Framing {
  const size = high.map((edge, axis) => edge - (low[axis] ?? 0)) as Triple;
  const middle = high.map((edge, axis) => (edge + (low[axis] ?? 0)) / 2) as Triple;
  // Both of `focus`'s numbers are proportions of the model's own height, which is what lets one
  // table frame a body two metres tall and a fixture of sixty-eight units alike.
  const height = Math.max(size[1], 1e-3);
  const at = low[1] + focus.height * height;
  const held = Math.max(focus.holds * height, 1e-3);

  const shown = (focus.holds >= 1 ? size : size.map((edge) => Math.min(edge, held))) as Triple;
  return {
    offset: [-middle[0], -at, -middle[2]],
    distance: framingDistance(onScreen(shown, view), fov, aspect),
    // To anywhere on what is being looked at and no further. What it rules out is the drag that
    // carries the model off the pane entirely and leaves nothing on screen to say which way it
    // went — so it is a leash on the part in view, not on everything that arrived with it.
    leash: Math.hypot(...shown) / 2,
  };
}
