/**
 * Putting a model down on a stage: measuring it, and moving it so the part being looked at is
 * the middle of the picture.
 *
 * This app draws models two ways — a live pane in `modelViewer.ts` and a grid of thumbnails in
 * `galleryStage.ts` — and they are two renderers for a reason: a pane is one scene with orbit
 * controls on it, and a grid is twenty pictures that must cost one graphics context between
 * them. What they are not is two framings. Where a model goes and how far back the camera
 * stands are the same questions with the same answers whatever is drawing them, and the
 * arithmetic behind both is `modelPreview.ts`'s [`frameOn`].
 *
 * So this is the one place either of them puts a model down. It is thin on purpose: everything
 * decidable without a scene graph is decided in `modelPreview.ts`, and what is left here is the
 * two lines that read a `three` object's size and move it.
 */

import { Box3, type Object3D } from "three";

import type { Focus } from "./gallery";
import { frameOn, type Framing, type View } from "./modelPreview";

/** What a stage knows about the picture it is about to draw. */
export interface Placement {
  /** Which part of the model the picture is about — `gallery.ts`'s table. */
  focus: Focus;
  /** Which way round the camera stands from it. */
  view: View;
  /** How wide a view that camera takes, in degrees. */
  fov: number;
  /** The pane's width over its height, so a narrow one is not framed as a square. */
  aspect: number;
}

/**
 * Moves `model` so that the part `placement.focus` names sits on the origin, and answers where a
 * camera holding that part would stand.
 *
 * The origin, always, because every stage here orbits its target and every stage's target is the
 * origin: whatever is put there is what a drag turns in place and what a zoom goes towards.
 */
export function placeOn(model: Object3D, placement: Placement): Framing {
  const { focus, view, fov, aspect } = placement;
  const box = new Box3().setFromObject(model);
  const framing = frameOn(
    [box.min.x, box.min.y, box.min.z],
    [box.max.x, box.max.y, box.max.z],
    focus,
    view,
    fov,
    aspect,
  );
  model.position.set(...framing.offset);
  return framing;
}
