/**
 * One picture in a grid of them, and the one graphics context the grid is drawn through.
 *
 * Shared by the two halves of the transmog browser that draw pictures rather than names — the
 * wardrobe, where a tile is one appearance on a body, and the set grid, where a card is a whole
 * set on one. Neither of them cares which it is: a tile is a `.glb`, a framing and an angle, and
 * everything above it decides what those are. `gallery.ts` is where they are decided and
 * `galleryStage.ts` is what paints them.
 *
 * It is one module rather than two because the expensive thing here is not the component. It is
 * the WebGL context, and a browser hands out about sixteen of them: two grids that each invented
 * their own way of making, sharing and giving one back would be two chances to leak one, and a
 * leaked context does not show up as an error — the browser simply hands out one fewer next time
 * and a grid somewhere else goes black.
 */

import "./galleryTile.css";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

import { turnedBy } from "./gallery";
import type { Focus } from "./gallery";
import type { GalleryStage } from "./galleryStage";
import { glbBytes } from "./modelPreview";

/** What a tile does to get itself drawn, which is the one thing here that needs a graphics card. */
export type Paint = (
  target: HTMLCanvasElement,
  bytes: Uint8Array,
  focus: Focus,
  turn: number,
) => Promise<void>;

/**
 * The real stage, loaded the first time a reader asks to see one.
 *
 * three.js and its loader are most of this app's JavaScript, and the same import the outfit pane
 * makes: a reader who never opens a gallery never downloads it, and one who has already opened
 * the pane pays nothing here because the module is already in memory.
 */
export const lazyGalleryStage = (): Promise<GalleryStage> =>
  import("./galleryStage").then((stage) => stage.createGalleryStage());

/**
 * The one graphics context a grid is drawn through, made when it is first wanted and given back
 * when the reader turns the pictures off.
 *
 * Twenty contexts is more than a browser hands out, which is a grid whose top rows go black as
 * its bottom rows fill in — so there is one, and every tile paints through it.
 *
 * **The promise is what is held on to, not the stage.** Making one is asynchronous — the module
 * it comes out of is imported on demand — so there is a window between "a tile asked for a
 * picture" and "there is a renderer", and a reader can turn the gallery off inside it. Disposing
 * whatever had finished being made by then would let a context started in that window escape with
 * nothing left pointing at it, which is a leak that never shows up as a leak: the browser just
 * hands out one fewer next time. Awaiting it disposes the one that was on its way as surely as
 * the one that had arrived.
 *
 * `on` is whether the grid is showing pictures at all. Turning it off is what gives the context
 * back, and so is the view going away with it left on.
 *
 * **Nothing is painted on a stage that has been given back.** React tears an effect down and sets
 * it up again to prove the teardown is real — development Strict Mode does it to every effect in
 * the app — and a tile's first paint is asked for before this hook's own effect has run, because
 * React runs a child's effects before its parent's. So a paint in flight across a teardown would
 * otherwise resolve against a disposed renderer. `era` is what answers that: the number the paint
 * started in, compared against the number the grid is on when it comes back. The tile asks again on
 * the setup that follows, so the picture still arrives. `stage.ts` is the same rule for a live pane.
 */
export function useGalleryPaint(
  on: boolean,
  createGalleryStage: () => GalleryStage | Promise<GalleryStage>,
): Paint {
  const starting = useRef<Promise<GalleryStage> | null>(null);
  /** Which era of this grid's life is being painted for. Bumped by every teardown. */
  const era = useRef(0);
  useEffect(() => {
    if (!on) return undefined;
    return () => {
      era.current += 1;
      const pending = starting.current;
      starting.current = null;
      // A stage that could not be made at all — a machine with no working 3D — is nothing to
      // give back, and the tiles have already shown what that means.
      if (pending) void pending.then((made) => made.dispose()).catch(() => undefined);
    };
  }, [on]);

  return useCallback(
    async (
      target: HTMLCanvasElement,
      bytes: Uint8Array,
      focus: Focus,
      turn: number,
    ): Promise<void> => {
      const mine = era.current;
      // One stage, and one attempt to make one: twenty tiles painting at once would otherwise each
      // start a context of their own, which is the thing this exists to avoid.
      starting.current ??= Promise.resolve(createGalleryStage());
      const made = await starting.current;
      // Given back while it was being made. The teardown disposed this stage already, and painting
      // on it now would be painting on a dead renderer.
      if (mine !== era.current) return;
      await made.paint(target, bytes, focus, turn);
    },
    [createGalleryStage],
  );
}

/**
 * One tile's picture, turnable.
 *
 * A plain canvas painted by the grid's one stage: what is on it between drags is a bitmap, so a
 * page of twenty costs one context and twenty images rather than twenty live scenes. There is no
 * animation loop here and no `requestAnimationFrame` — a tile nobody is touching does no work at
 * all, which is the property that makes twenty of them affordable.
 *
 * **A drag is a queue of one.** Pointer moves arrive faster than a render finishes, so the angle
 * the reader has asked for is written into `wanted` and a single pump drains it. Whatever
 * arrived while a paint was in flight collapses to the last of them, which is the only one worth
 * drawing — the alternative is a queue of stale angles the picture works through after the hand
 * has stopped.
 *
 * The bytes are decoded once and kept, because the stage recognises the model it is already
 * holding by the identity of the array it was handed. A fresh `glbBytes` per frame would parse a
 * megabyte of `.glb` and re-upload its textures thirty times a second, which is the thing this
 * whole arrangement exists to avoid.
 *
 * A paint that fails leaves whatever was on the canvas rather than breaking the row — the name,
 * the slot and the quality are still what the row is for, and a machine with no working 3D at
 * all is a machine where every tile of the gallery is an empty one of these.
 */
export function Turnable({
  glb,
  focus,
  label,
  paint,
}: {
  glb: string;
  /** How much of what arrived to hold in view, and where on it to look — see `gallery.ts`. */
  focus: Focus;
  label: string;
  paint: Paint;
}): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bytes = useMemo(() => glbBytes(glb), [glb]);

  /** Where the reader has turned this tile to, which outlives any one paint. */
  const turn = useRef(0);
  /** The angle asked for and not yet drawn, and whether the pump is already draining it. */
  const wanted = useRef<number | null>(null);
  const painting = useRef(false);

  const ask = useCallback(
    (at: number): void => {
      wanted.current = at;
      if (painting.current) return;
      painting.current = true;
      void (async () => {
        try {
          while (wanted.current !== null) {
            const next = wanted.current;
            wanted.current = null;
            const target = canvas.current;
            if (!target) break;
            await paint(target, bytes, focus, next);
          }
        } catch {
          // Leaves the picture that was there. See the note above.
        } finally {
          painting.current = false;
        }
      })();
    },
    [bytes, focus, paint],
  );

  // The first paint, and any later one caused by the model itself changing. Not by the angle:
  // the angle lives in a ref precisely so that turning a tile is not a React render.
  useEffect(() => ask(turn.current), [ask]);

  /** The drag in progress: which pointer, where it went down, and the angle it started from. */
  const drag = useRef<{ pointer: number; from: number; at: number } | null>(null);

  return (
    <span className="mog-shot">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${label}, drawn`}
        onPointerDown={(event) => {
          // Captured, so a drag that leaves the tile keeps turning it rather than stopping at
          // the edge — twenty tiles side by side means most drags cross one.
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, from: event.clientX, at: turn.current };
        }}
        onPointerMove={(event) => {
          const started = drag.current;
          if (!started || started.pointer !== event.pointerId) return;
          turn.current = turnedBy(
            started.at,
            event.clientX - started.from,
            event.currentTarget.clientWidth,
          );
          ask(turn.current);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
    </span>
  );
}
