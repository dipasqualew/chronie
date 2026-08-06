/**
 * Putting a model down on a stage: measuring it, and moving it so the part being looked at is
 * the middle of the picture.
 *
 * This app draws models two ways — a live pane in `modelViewer.ts` and a grid of thumbnails in
 * `galleryStage.ts` — and they are two renderers for a reason: a pane is one scene with orbit
 * controls on it, and a grid is twenty pictures that must cost one graphics context between
 * them. What they are not is two framings. Where a model goes and how far back the camera
 * stands are the same questions with the same answers whatever is drawing them, and the
 * arithmetic behind both is `modelPreview.ts`'s [`frameOn`], which is where the tests are.
 *
 * So this is the one place either of them puts a model down, and there is to be no other. The
 * grid used to keep a second copy — its own margin, its own trigonometry, its own camera
 * direction — and a second copy of an answer is a second place for it to be wrong.
 *
 * # Framing measures the model, never where the last framing left it
 *
 * **The transform comes off before the box is read.** That one line is the whole of #274 and it
 * is worth stating why, because the failure it prevents is invisible in the code that caused it.
 *
 * A bounding box is read in *world* space, so a model that has already been framed is measured
 * with its own offset baked in — and framing it again computes an offset against that, which
 * exactly cancels the first one. The model goes back where it started, the framing after puts it
 * back on the mark, and it alternates once per frame for as long as anything keeps asking.
 *
 * Nothing asks twice in the pane, where a model is parsed and framed and drawn until it is
 * replaced. The grid asks once per pointer move: a drag repaints the model already on the
 * graphics card, because parsing a megabyte of `.glb` thirty times a second is the thing that
 * arrangement exists to avoid. So a reader turning a set watched it flicker up and down through
 * half its own height, and every fix for that until now was a fix in one of the two framings.
 *
 * Framing has to answer the same thing every time it is asked. Taking the transform off first is
 * what makes that true by construction rather than by nobody happening to ask twice, and
 * `framing.test.ts` is what keeps it true — it frames one body five times.
 *
 * This owns the model's position, and is the only thing that may set it. A stage that wants to
 * move a model has a camera to move instead.
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
  /**
   * Whether the reader can turn the model about its vertical axis and cannot do anything else.
   *
   * A thumbnail can: a drag spins the camera round it and there is no zoom to get back out with,
   * so what has to fit is not the model as seen from here but the cylinder it sweeps through as
   * it turns. Otherwise a polearm lying front to back is framed by the little of it that shows
   * end on, and swings out of its own picture the moment it comes side on.
   *
   * The pane does not: it orbits freely, which no single framing can cover, and it has a zoom
   * and a way back for the reader who goes somewhere a framing did not anticipate.
   */
  turns?: boolean;
}

/**
 * Moves `model` so that the part `placement.focus` names sits on the origin, and answers where a
 * camera holding that part would stand.
 *
 * The origin, always, because every stage here orbits its target and every stage's target is the
 * origin: whatever is put there is what a drag turns in place and what a zoom goes towards.
 */
export function placeOn(model: Object3D, placement: Placement): Framing {
  const { focus, view, fov, aspect, turns = false } = placement;

  // As the model is, rather than as the last framing left it. See the note above — this is the
  // line, and the flicker is what happens without it.
  model.position.set(0, 0, 0);
  const box = new Box3().setFromObject(model);

  const low: [number, number, number] = [box.min.x, box.min.y, box.min.z];
  const high: [number, number, number] = [box.max.x, box.max.y, box.max.z];
  if (turns) {
    // The circle the corners of the box travel on, about the vertical axis through its middle:
    // what a turnable picture has to hold is the widest that model ever gets, whichever way
    // round it is. Symmetrical about the same middle, so where the model goes does not change.
    const reach = Math.hypot(high[0] - low[0], high[2] - low[2]) / 2;
    const middleX = (high[0] + low[0]) / 2;
    const middleZ = (high[2] + low[2]) / 2;
    low[0] = middleX - reach;
    high[0] = middleX + reach;
    low[2] = middleZ - reach;
    high[2] = middleZ + reach;
  }

  const framing = frameOn(low, high, focus, view, fov, aspect);
  model.position.set(...framing.offset);
  return framing;
}
