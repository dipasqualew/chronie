/**
 * Twenty models on one graphics context, drawn once each into a picture that then costs nothing.
 *
 * The pane in `modelViewer.ts` is a live scene: a renderer, a loop, and orbit controls, because a
 * reader turning a character around is the whole point of it. A gallery is the opposite errand.
 * Twenty of those would be twenty WebGL contexts — **a browser hands out about sixteen and then
 * starts silently discarding the oldest**, which is a grid where the top rows go black as the
 * bottom ones fill in — and twenty animation loops redrawing pictures nobody is turning.
 *
 * So there is one renderer for the whole grid, off screen. Each row is drawn into it once and the
 * result is copied into that row's own 2D canvas, which from then on is an image: no context, no
 * loop, no memory on the graphics card. What a row costs after it has been drawn is a bitmap.
 *
 * Everything decidable without a renderer is in `gallery.ts`, which is where the tests are —
 * including [`focusOf`], the reason a helm in a gallery is a helm rather than four pixels of hat
 * on a whole character. The browser suite is what exercises this half.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  type Group,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import type { Focus } from "./gallery";

/** The same narrow view the pane uses, so a body has the same proportions in both. */
const FIELD_OF_VIEW = 35;

/** How much room to leave around what is framed, so nothing touches the edge of the picture. */
const MARGIN = 1.15;

/**
 * Where the camera stands, as a direction from what it is looking at.
 *
 * Square to the front would read as a silhouette; this is the same three-quarter view the pane
 * opens on, and the reason a gallery shows shape rather than outline.
 */
const FROM: [number, number, number] = [0.45, 0.12, 1];

export interface GalleryStage {
  /**
   * Draws one model into `target`, framed on the part of the body `focus` names.
   *
   * The canvas is left holding a picture and nothing else — no context of its own and nothing to
   * dispose. What the model held on the graphics card is given back before this resolves.
   */
  paint(target: HTMLCanvasElement, glb: Uint8Array, focus: Focus): Promise<void>;
  /** Gives back the one context. The stage is finished afterwards. */
  dispose(): void;
}

export interface GalleryStageOptions {
  /** How large a picture to draw, in device pixels. Square, so no row is foreshortened. */
  size?: number;
}

/** The one renderer a whole grid of thumbnails is drawn through. */
export function createGalleryStage(options: GalleryStageOptions = {}): GalleryStage {
  const size = options.size ?? 256;

  // `preserveDrawingBuffer`, and it is not optional here. The picture is taken by copying this
  // canvas into another one *after* the render call returns, and without it the browser is free
  // to have cleared the buffer by then — which is a grid of empty rectangles on some drivers and
  // a correct grid on others, the worst kind of difference to find out about from a user.
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  // The pane's two lights, at the pane's intensities, so that a look picked out of a gallery is
  // the look that then appears on the character.
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(1.4, 2, 2.5);
  scene.add(key);
  scene.add(new AmbientLight(0xffffff, 1.1));

  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 1000);
  const loader = new GLTFLoader();

  /**
   * Points the camera at the part of the model `focus` names, holding as much of it as `focus`
   * asks for.
   *
   * Both numbers are proportions of the model's own height, which is what lets one table in
   * `gallery.ts` frame a body two metres tall and a body of two hundred fixture units alike.
   */
  function frame(model: Group, focus: Focus): void {
    const box = new Box3().setFromObject(model);
    const middle = box.getCenter(new Vector3());
    const span = box.getSize(new Vector3());
    const height = Math.max(span.y, 0.001);

    // Everything is framed about the origin, so the model is moved rather than the camera aimed:
    // one subtraction here against a target, a projection and a leash everywhere else.
    const at = box.min.y + focus.height * height;
    model.position.set(-middle.x, -at, -middle.z);

    // What has to fit: the slice of the body being held, and — for the whole-body case, which is
    // every weapon — its width too, because a polearm is wider than she is tall.
    const held = Math.max(focus.holds * height, focus.holds >= 1 ? span.x : 0, 0.001);
    const half = (FIELD_OF_VIEW / 2) * (Math.PI / 180);
    const distance = (held / 2 / Math.tan(half)) * MARGIN;
    camera.position.set(...FROM.map((axis) => axis * distance) as [number, number, number]);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  /**
   * Gives back everything a model holds on the graphics card.
   *
   * A grid is twenty of these one after another, so a leak here is not a slow drift — it is
   * twenty bodies' worth of textures still resident by the time the reader reaches the end of
   * one page, and several pages of that is the tab.
   */
  function discard(model: Group): void {
    scene.remove(model);
    model.traverse((object) => {
      const mesh = object as { geometry?: { dispose(): void }; material?: unknown };
      mesh.geometry?.dispose();
      for (const material of [mesh.material].flat()) {
        const used = material as { dispose?(): void; map?: { dispose(): void } } | undefined;
        used?.map?.dispose();
        used?.dispose?.();
      }
    });
  }

  /**
   * What was drawn, written on the row's own canvas where anything outside can see it.
   *
   * The same argument `modelViewer.ts` makes for the pane, and it applies harder here: a
   * thumbnail is a small picture, and a small picture of nothing looks a great deal like a small
   * picture of a character. This is what the browser tests read.
   */
  function announce(target: HTMLCanvasElement, model: Group): void {
    let vertices = 0;
    model.traverse((object) => {
      const part = object as { geometry?: { attributes?: { position?: { count: number } } } };
      vertices += part.geometry?.attributes?.position?.count ?? 0;
    });
    target.dataset.vertices = String(vertices);
  }

  return {
    paint(target: HTMLCanvasElement, glb: Uint8Array, focus: Focus): Promise<void> {
      return new Promise((resolve, reject) => {
        // A copy, because the loader takes ownership of the buffer it parses and the caller's
        // array may be a view into a longer one.
        const bytes = glb.slice().buffer as ArrayBuffer;
        loader.parse(bytes, "", (loaded) => {
          const model = loaded.scene;
          scene.add(model);
          frame(model, focus);
          renderer.render(scene, camera);

          // Sized once. Assigning either dimension resets the canvas whether or not the value
          // changed, and a row repainted with the same model would flash white doing it.
          if (target.width !== size) target.width = size;
          if (target.height !== size) target.height = size;
          const picture = target.getContext("2d");
          if (picture) {
            picture.clearRect(0, 0, size, size);
            picture.drawImage(renderer.domElement, 0, 0, size, size);
          }
          announce(target, model);
          discard(model);
          resolve();
        }, (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
    dispose(): void {
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
