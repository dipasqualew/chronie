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
  | { kind: "icon"; iconFileDataId: number; note: string }
  | { kind: "none"; note: string };

/**
 * Why an appearance is shown as a picture rather than as something to turn around.
 *
 * The first is the common one by a distance. Chest, waist, legs, feet, wrist, hands, back and
 * tabard are textures painted onto the character's body — there is no mesh to show on its own,
 * and on a twelve-piece set that accounts for ten of the rows.
 */
export const REASONS = {
  painted: "The game paints this slot onto the character, so it has no model of its own.",
  none: "The game gives this appearance no model.",
  withheld: "The game keeps this appearance encrypted.",
  absent: "This install holds no model for it.",
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

export function previewFor(appearance: Previewable): Preview {
  if (appearance.withheld) return { kind: "none", note: REASONS.withheld };
  if (appearance.hasModel) return { kind: "model", displayInfoId: appearance.displayInfoId };
  return {
    kind: "icon",
    iconFileDataId: appearance.iconFileDataId,
    note: PAINTED_ON(appearance.displayType) ? REASONS.painted : REASONS.none,
  };
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
