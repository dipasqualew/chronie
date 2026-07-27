/**
 * What the set detail's preview should show for one appearance, and the arithmetic behind it.
 *
 * Kept apart from `modelViewer.ts` because none of this needs a renderer: which appearances
 * have a model at all is a fact about the game's files, and framing one is trigonometry. The
 * three.js half is thin on purpose, and everything decidable without a canvas is decided here.
 */

/** What the preview pane is showing. */
export type Preview =
  | { kind: "model"; displayInfoId: number }
  | { kind: "worn"; displayInfoId: number; displayType: number }
  | { kind: "icon"; iconFileDataId: number; note: string }
  | { kind: "none"; note: string };

/**
 * What the pane says about what it is showing, and why it is not showing something else.
 *
 * Every armour slot is now shown the way the game itself shows it, which is on a body — the
 * helm on her head rather than floating in front of her — so what is left of the old
 * explanations is the two ways an install can hold nothing to put there. `absent` is a slot
 * with geometry whose file is missing, and `unpaintable` a slot without one whose every
 * texture was painted for a body this app does not draw.
 */
export const REASONS = {
  worn: "Worn on the character. Drag to turn it.",
  none: "The game gives this appearance no model.",
  withheld: "The game keeps this appearance encrypted.",
  absent: "This install holds no model for it.",
  unpaintable: "This install holds nothing to paint this slot onto the character with.",
} as const;

/** The appearances a preview needs to tell apart, which is less than a row carries. */
export interface Previewable {
  displayType: number;
  displayInfoId: number;
  iconFileDataId: number;
  hasModel: boolean;
  withheld: boolean;
}

/**
 * The display types worn on the body: every armour slot, head through tabard.
 *
 * Everything above them is a weapon or a shield, which hangs off a hand and raises questions
 * of its own — so those are still shown on their own, and are the only appearances that are.
 */
const WORN_ON = (displayType: number): boolean => displayType >= 0 && displayType <= 10;

/**
 * How one appearance is best shown: on a character, on its own, or as a picture.
 *
 * The order is the point, and it is the other way round from what it used to be. **Every
 * armour slot is shown worn**, whether or not it has geometry: a helm has a model and the
 * only place that model means anything is on a head, so showing it in mid-air said less about
 * the appearance than showing it where the game puts it. What is left on its own is a weapon,
 * and what is left as a picture is a weapon the tables have no model for and a row the game
 * encrypts, neither of which is worth a character.
 */
export function previewFor(appearance: Previewable): Preview {
  if (appearance.withheld) return { kind: "none", note: REASONS.withheld };
  if (WORN_ON(appearance.displayType)) {
    return {
      kind: "worn",
      displayInfoId: appearance.displayInfoId,
      displayType: appearance.displayType,
    };
  }
  if (appearance.hasModel) return { kind: "model", displayInfoId: appearance.displayInfoId };
  return { kind: "icon", iconFileDataId: appearance.iconFileDataId, note: REASONS.none };
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
