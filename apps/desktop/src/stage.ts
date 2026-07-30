/**
 * The one graphics context a pane holds, and the rules about when it exists.
 *
 * **A browser hands out about sixteen WebGL contexts and then starts silently discarding the
 * oldest.** Nothing about that failure looks like a failure: there is no error, the browser simply
 * takes one back, and a pane somewhere else in the window goes black. So a context leaked here is
 * not a slow drift in memory — it is a picture somewhere else that stops working, several clicks
 * later, for no reason anybody can see on screen.
 *
 * That is why the three live panes in this app — the outfit pane, the appearance modal and a
 * character's portrait — share this rather than each keeping their own copy of the arrangement.
 * Two of them had the same one, twice, and it was subtly wrong in both:
 *
 *  - **The promise is what is held, not the stage.** Making one is asynchronous, because three.js
 *    and its loader are imported on demand, so there is a window between "something asked for a
 *    picture" and "there is a renderer". Disposing whatever had finished being made by then lets a
 *    context started inside that window escape with nothing pointing at it.
 *  - **Nothing is drawn on a stage that has been given back.** React tears an effect down and sets
 *    it up again to prove the teardown is real — development Strict Mode does it to every effect in
 *    the app — and a `show` that was in flight across one of those would otherwise resolve against
 *    a disposed renderer. `era` is what answers that: the number a `show` started in, compared
 *    against the number the pane is on now.
 *
 * `modelViewer.ts` is the stage itself and `galleryTile.ts` is the other half of this problem — one
 * context for a whole grid of thumbnails, on the same two rules.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { Focus } from "./gallery";
import type { ModelStage } from "./modelViewer";

/**
 * Makes a stage inside `container`. Asynchronous because three.js is imported on demand.
 *
 * `label` is what the picture on it is of, as a screen reader is told it — a canvas says nothing
 * about itself, so this is the whole of what anything but a pair of eyes has to go on. Two of the
 * three panes name themselves for what they are and ignore it; a portrait names itself for *whom*
 * it is of, which is not known where the stage is made.
 */
export type MakeStage = (
  container: HTMLElement,
  label?: string,
) => ModelStage | Promise<ModelStage>;

export interface PaneStage {
  /**
   * Puts a model on the pane's one stage, making it the first time anything needs it.
   *
   * Answers whether the picture is on screen: false is a pane that went away while the model was
   * being read or the renderer was being made, and there is nothing left to say about it. Throws
   * what `createStage` throws — a machine with no working 3D at all — which is what the panes turn
   * into a sentence in place of a picture.
   */
  show(container: HTMLElement, glb: Uint8Array, focus?: Focus): Promise<boolean>;
  /**
   * Puts the camera back where framing whatever is on the stage now would have left it.
   *
   * Does nothing when there is no stage to put a camera back on — one still being made, one that
   * could not be made at all — which is a click on a button the pane only draws over a picture.
   */
  resetCamera(): void;
}

/**
 * One stage for as long as the component is mounted, given back when it is not.
 *
 * Made on demand rather than on mount: the appearance modal is mounted for the whole life of the
 * window and holds a context only once somebody has clicked through to a picture.
 *
 * `label` is read once, when the stage is made, because that is when the canvas it names is made.
 * A pane whose label outlives its picture — a portrait moving to another outfit — is a pane that
 * should be remounted rather than renamed, and `characterFigure.tsx` keys it so that it is.
 */
export function usePaneStage(createStage: MakeStage, label?: string): PaneStage {
  /** The stage, or the promise of one. See the note above on why this rather than the stage. */
  const starting = useRef<Promise<ModelStage> | null>(null);
  /** The one that has finished being made, for the things a click has to do straight away. */
  const made = useRef<ModelStage | null>(null);
  /** Which era of this pane's life is being drawn for. Bumped by every teardown. */
  const era = useRef(0);

  useEffect(
    () => () => {
      era.current += 1;
      const pending = starting.current;
      starting.current = null;
      made.current = null;
      // A stage that could not be made at all is nothing to give back, and the pane has already
      // said what that means.
      if (pending) void pending.then((stage) => stage.dispose()).catch(() => undefined);
    },
    [],
  );

  const show = useCallback(
    async (container: HTMLElement, glb: Uint8Array, focus?: Focus): Promise<boolean> => {
      const mine = era.current;
      // One stage, and one attempt to make one: two quick clicks would otherwise each start a
      // renderer and the second would be left running with nothing pointing at it.
      starting.current ??= Promise.resolve(createStage(container, label));
      const stage = await starting.current;
      // Given back while it was being made, which is exactly what a torn-down effect does. The
      // teardown disposed this stage already; drawing on it now would be drawing on a dead
      // renderer, and saying anything about it would be answering for a pane that has gone.
      if (mine !== era.current) return false;
      made.current = stage;
      await stage.show(glb, focus);
      return mine === era.current;
    },
    [createStage, label],
  );

  const resetCamera = useCallback(() => made.current?.resetCamera(), []);

  // One object for as long as `createStage` is the same one. The panes hang a `useCallback` off
  // this and an effect off that, so a fresh object per render would be a fresh callback per render
  // and an effect that redrew the character on every single one of them.
  return useMemo(() => ({ show, resetCamera }), [show, resetCamera]);
}
