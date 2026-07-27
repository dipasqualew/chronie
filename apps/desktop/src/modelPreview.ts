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
 * The slots between the shoulders and the weapons have no mesh of their own, and on a
 * twelve-piece set that is most of the rows. There used to be a sentence here explaining that
 * absence to the reader; they are now shown the only way the game itself shows them, which is
 * on a body, and `unpaintable` is all that is left of it — for the install that cannot manage
 * even that.
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

/** The display types that are armour painted onto the body: everything between the shoulders
 * and the weapons. */
const PAINTED_ON = (displayType: number): boolean => displayType >= 2 && displayType <= 10;

/**
 * How one appearance is best shown: on its own, on a character, or as a picture.
 *
 * The order is the point. An appearance with geometry of its own is shown as that geometry —
 * a helm is a helm, and the character it would sit on cannot wear it yet. Everything else in
 * an armour slot is painted onto a body and means nothing off one, so it is shown on the
 * body. What is left is a weapon the tables have no model for and a row the game encrypts,
 * neither of which is worth a character.
 */
export function previewFor(appearance: Previewable): Preview {
  if (appearance.withheld) return { kind: "none", note: REASONS.withheld };
  if (appearance.hasModel) return { kind: "model", displayInfoId: appearance.displayInfoId };
  if (PAINTED_ON(appearance.displayType)) {
    return {
      kind: "worn",
      displayInfoId: appearance.displayInfoId,
      displayType: appearance.displayType,
    };
  }
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
