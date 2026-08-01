/**
 * The 3D pane: a `.glb` on screen, lit, and turnable with the mouse.
 *
 * The backend does everything game-specific — parsing the model, decoding its textures,
 * writing them out as glTF — so what is left here is a scene, two lights and a camera. That
 * split is the point: three.js reads a `.glb` and has never heard of World of Warcraft.
 *
 * Everything that can be decided without a renderer lives in `modelPreview.ts`, which is
 * where the tests are. What is left is the part only a browser can run, and the browser tests
 * are what exercise it.
 */

import "./modelViewer.css";

import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { placeOn } from "./framing";
import { WHOLE, type Focus } from "./gallery";
import { cameraFor, type View } from "./modelPreview";

/** How wide a view the camera takes, in degrees. Narrow enough that a helm keeps its shape
 * rather than bulging the way a wide angle makes close things bulge. */
const FIELD_OF_VIEW = 35;

/** A point as the readout writes it: three axes, three decimals, one string to compare. */
const triple = (point: Vector3): string =>
  [point.x, point.y, point.z].map((axis) => axis.toFixed(3)).join(",");

export interface ModelStage {
  /**
   * Puts a model on the stage, replacing whatever was there.
   *
   * `focus` says which part of it the pane is about — `gallery.ts`'s table, the same one the
   * thumbnails are framed with. Nothing said means all of it, which is what a character wearing
   * an outfit is: there is no part of her the pane is about, and the boots are as much of the
   * answer as the helm.
   */
  show(glb: Uint8Array, focus?: Focus): Promise<void>;
  /**
   * Puts the camera back where framing whatever is on the stage now would have left it.
   *
   * The way out of a drag that went too far, and — since a new model no longer moves the
   * camera — the only thing that ever moves it but the reader. Turning, zooming and moving
   * compose into a great many places to be lost, and none of them looks any different from an
   * empty pane.
   */
  resetCamera(): void;
  /** Gives back the graphics memory and stops the loop. The stage is finished afterwards. */
  dispose(): void;
}

export interface StageOptions {
  /**
   * Draw every texture as the colour it actually holds: no lights, no tone mapping, no
   * shading of any kind.
   *
   * The lit stage below is for looking at, and it is a bad instrument. A key light at 2.2
   * over an ambient at 1.1, through ACES tone mapping, moves every colour it draws — a flat
   * tan body comes out near white, which is how "the armour has no colour" was once read off
   * a screenshot that had colour in it. Something measuring what is on the model wants the
   * texture back unaltered, and this is that: same loader, same geometry, same pictures, and
   * the shading taken out from under them.
   */
  unlit?: boolean;
  /** Where the camera sits once a model has been framed. */
  view?: View;
  /**
   * What the picture on the canvas is of, as a screen reader is told it.
   *
   * A canvas carries no role and says nothing about itself, so a pane holding one is a blank
   * rectangle to everything but a pair of eyes. This is the whole of what anything else — a
   * reader on a screen reader, a test asking for the character — has to go on.
   */
  label?: string;
}

/**
 * A stage inside `container`, sized to it and kept sized to it.
 *
 * Throws when the machine has no working 3D at all, which is a thing that happens: a remote
 * desktop, a virtual machine without a GPU, a driver the browser has blocklisted. The caller
 * shows the icon instead, the same as for an appearance that has no model.
 */
export function createModelStage(container: HTMLElement, options: StageOptions = {}): ModelStage {
  const unlit = options.unlit ?? false;
  const view = options.view ?? "default";

  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // The textures come out of the game already lit — the shading a player sees on a helm is
  // painted into it — so the tone mapping is only here to keep the highlights of the one
  // light below from clipping.
  renderer.toneMapping = unlit ? NoToneMapping : ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  // Named, so that a stylesheet can say how large the element is — because nothing here can.
  // `resize` below calls `setSize` with `updateStyle` off and has to: the packaged window is
  // served a policy with a nonce in `style-src`, which makes every engine ignore
  // `'unsafe-inline'`, so an inline `style=""` is thrown out before it is ever read. What that
  // leaves is a drawing buffer sized in *device* pixels and an element with no size of its own,
  // which on a screen with two device pixels to the CSS pixel lays the canvas out at twice its
  // pane. A class rather than a rule per pane, because two panes draw on one of these and the
  // second one forgot — see the note on `.model-canvas` in `modelViewer.css`, imported above.
  renderer.domElement.className = "model-canvas";
  // And named for a reader as well as for the stylesheet: a canvas carries no role and says
  // nothing about itself, so a pane holding one is a blank rectangle to everything but a pair
  // of eyes.
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", options.label ?? "The model, drawn");
  container.replaceChildren(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 1000);
  camera.position.set(0, 0, 3);

  // Two lights and no more: a key from over the reader's shoulder so that turning the model
  // shows its shape, and enough ambient that the side facing away is still legible.
  if (!unlit) {
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(1.4, 2, 2.5);
    scene.add(key);
    scene.add(new AmbientLight(0xffffff, 1.1));
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // Moving the model, on the right button, because zoom on its own only ever reaches its
  // middle: a character magnified far enough to look at a boot has her head somewhere off the
  // top of the pane, and an orbit moves the camera without moving what it is pointed at. How
  // far it may be moved is a fact about the model rather than about the stage, so the leash is
  // put on in `frameModel` below.
  controls.enablePan = true;
  controls.minDistance = 0.2;
  controls.maxDistance = 40;
  // A turn stays a turn: the camera is kept sixty degrees short of straight overhead and of
  // straight underneath, which are the two places an orbit stops being one. At the pole the
  // controls pin the angle and the remaining drag turns into a spin about the middle of the
  // pane — the model whirls, the vertical drag does nothing, and the way back is not obvious
  // from anything on screen. Neither view is one anybody came for: this pane shows clothes on a
  // person, and there is nothing to learn about a robe from directly above her scalp.
  controls.minPolarAngle = Math.PI / 6;
  controls.maxPolarAngle = Math.PI - Math.PI / 6;

  // A drag changes the camera synchronously in OrbitControls' pointer handler, before the next
  // animation frame gets a turn. Mark it there rather than in `frame`, so anything waiting on
  // the stage can never mistake the `settled` left by the frame before a drag for its result.
  const moving = (): void => {
    container.dataset.cameraState = "moving";
  };
  controls.addEventListener("change", moving);
  container.dataset.cameraState = "settled";

  let model: Group | null = null;
  let running = true;
  // What the camera was last framed on, which is what decides whether the next model moves it.
  // See `frameModel`.
  let framed: string | null = null;

  const resize = (): void => {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const frame = (): void => {
    if (!running) return;
    // `update` answers whether it moved anything, which is the only frame the readout below
    // has anything new to say — and with damping on, the frames after a drag ends are moving
    // frames too. Everything else is a string nobody would have been able to tell apart.
    if (controls.update()) report();
    else container.dataset.cameraState = "settled";
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  /**
   * Where the camera is and what it is pointed at, written where anything outside can see it.
   *
   * The same argument as `announce` below, one property further out: a canvas draws the same
   * rectangle whichever way round the model on it is, so nothing but an eye can tell a model
   * that moved from one that did not, or a reset that put the camera back from one that left
   * it somewhere near. Three decimals, because "near enough" is the failure being ruled out.
   */
  function report(): void {
    container.dataset.camera = triple(camera.position);
    container.dataset.target = triple(controls.target);
  }

  /**
   * What the stage is holding, written where anything outside can see it.
   *
   * A canvas says nothing about whether the file in it parsed into geometry — an empty scene
   * and a helm draw the same blank rectangle to everything but an eye. This is what the
   * browser tests read, and what to look at first when a model comes up empty.
   *
   * The pictures are counted for the same reason, one layer further in. A `.glb` carries its
   * textures inside itself, and the loader turns each into a `blob:` URL and loads it back
   * through an `<img>` — a hop with a page's Content Security Policy across it, and one that
   * fails silently: the texture object is made either way, and a model whose every image was
   * refused draws in flat white with no error anywhere. `blank` is that, counted.
   */
  function announce(loaded: Group | null): void {
    let drawn = 0;
    const seen = new Set<unknown>();
    let pictures = 0;
    let blank = 0;
    loaded?.traverse((object) => {
      const part = object as {
        geometry?: { attributes?: { position?: { count: number } } };
        material?: unknown;
      };
      drawn += part.geometry?.attributes?.position?.count ?? 0;
      for (const material of [part.material].flat()) {
        const map = (material as { map?: { image?: { width?: number } } } | undefined)?.map;
        if (!map || seen.has(map)) continue;
        seen.add(map);
        if ((map.image?.width ?? 0) > 0) pictures += 1;
        else blank += 1;
      }
    });
    container.dataset.vertices = String(drawn);
    container.dataset.pictures = String(pictures);
    container.dataset.blank = String(blank);
  }

  /**
   * Puts the part of the model the pane is about on the origin, works out where a camera
   * holding that part would sit, and puts the camera there — when the part has changed.
   *
   * **A model framed the same way as the last one leaves the camera exactly where the reader
   * left it.** A stage outlives the models on it: the outfit pane keeps one for as long as the
   * wardrobe is open and draws a new body for every piece put on or taken off. Framing each of
   * them was throwing away the reader's view once per click, so somebody comparing two helms on
   * a face they had zoomed in on had to zoom in again for the second one, and again after
   * changing their mind. What is on the stage is one character in different clothes, so the
   * camera that suited the last of them suits this one.
   *
   * The focus is what says whether that argument applies. Two helms are framed on a head and
   * the reader keeps their view; a helm and then a pair of boots are two different parts of a
   * body, and holding the head still while the reader asks about the feet shows them an empty
   * pane. So the camera moves exactly when what the pane is about moves — which is never, for
   * the character pane, because every outfit on her is the whole of her.
   *
   * The framing is still worked out either way, because it is what "Reset camera" goes back to,
   * and that has to be this model's framing rather than the one the pane opened on. `position0`
   * and `target0` are set instead of `saveState`, which would save wherever the camera is now —
   * the difference between a reset that frames the body and a reset that hands back a drag.
   */
  function frameModel(loaded: Group, focus: Focus): void {
    // `framing.ts`, because a framing that lived here would be the second one in the app and the
    // gallery's was the first. It is also what makes framing the same model twice harmless,
    // which nothing in this file does and nothing in this file should have to remember.
    const { distance, leash } = placeOn(loaded, {
      focus,
      view,
      fov: FIELD_OF_VIEW,
      aspect: camera.aspect,
    });

    const place = cameraFor(view, distance);
    controls.maxTargetRadius = leash;
    controls.position0.set(...place);
    controls.target0.set(0, 0, 0);

    const on = `${focus.height},${focus.holds}`;
    if (framed !== on) {
      framed = on;
      camera.position.set(...place);
      controls.target.set(0, 0, 0);
    }
    controls.update();
    report();
  }

  /**
   * Swaps every material a model arrived with for one that only ever shows its own texture.
   *
   * glTF's materials are physical ones, so the picture on a part is the *input* to a lighting
   * model rather than the thing drawn. `MeshBasicMaterial` has no lighting model at all, which
   * is what makes the pixel on screen the texel in the file — the property anything measuring
   * a render needs and no lit material can offer.
   *
   * The maps are carried over rather than copied: the loader owns them, `discard` disposes
   * them, and a texture uploaded twice is the expensive half of showing a body.
   */
  function flatten(loaded: Group): void {
    const swap = (material: Material): Material => {
      const lit = material as MeshStandardMaterial;
      const flat = new MeshBasicMaterial({
        map: lit.map,
        color: lit.color,
        transparent: lit.transparent,
        opacity: lit.opacity,
        alphaTest: lit.alphaTest,
        side: lit.side,
      });
      lit.dispose();
      return flat;
    };
    loaded.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (!mesh.material) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }

  /**
   * Gives back everything a model holds on the graphics card.
   *
   * Removing a group from a scene drops the reference and nothing else — the geometry, the
   * materials and the textures stay where they were put. A reader clicking through a set is
   * a model a second, and the pictures are the expensive half.
   */
  function discard(group: Group): void {
    scene.remove(group);
    group.traverse((object) => {
      const mesh = object as { geometry?: { dispose(): void }; material?: unknown };
      mesh.geometry?.dispose();
      for (const material of [mesh.material].flat()) {
        const used = material as { dispose?(): void; map?: { dispose(): void } } | undefined;
        used?.map?.dispose();
        used?.dispose?.();
      }
    });
  }

  return {
    show(glb: Uint8Array, focus: Focus = WHOLE): Promise<void> {
      return new Promise((resolve, reject) => {
        // A copy, because the loader takes ownership of the buffer it parses and the caller's
        // array may be a view into a longer one.
        const bytes = glb.slice().buffer as ArrayBuffer;
        new GLTFLoader().parse(
          bytes,
          "",
          (loaded) => {
            if (model) discard(model);
            model = loaded.scene;
            if (unlit) flatten(model);
            frameModel(model, focus);
            scene.add(model);
            announce(model);
            resolve();
          },
          (error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
    /**
     * The damping is spent before the state is restored, and that order is the whole of it.
     *
     * A drag does not stop when the mouse does: `update` carries a shrinking fraction of it
     * into every frame after, which is what makes turning a model feel like turning something
     * with weight. `reset` restores the saved position and then calls `update` itself — so a
     * reset while any of that remainder is still owed hands it straight back, and the camera
     * settles beside the framing rather than on it. One undamped update spends what is left
     * first; the restore that follows has nothing working against it.
     */
    resetCamera(): void {
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = true;
      controls.reset();
      report();
    },
    /**
     * Everything this stage holds, given back: the loop, the model, the observer, the controls,
     * the renderer's own resources, the canvas — and the graphics context itself.
     *
     * `forceContextLoss` is the last of those and is not tidiness. `dispose` gives back what the
     * renderer allocated *through* the context and leaves the context alive, to be collected
     * whenever the browser gets round to it. A browser hands out about sixteen and then starts
     * silently discarding the oldest, so a stage built and given back several times over — which
     * is what a reader opening one appearance after another is, and what React's own
     * setup/cleanup/setup does to every effect in development — walks through the whole allowance
     * and takes some other pane's picture with it. Nothing about that looks like an error. The
     * gallery's stage has always done this; the pane forgot.
     */
    dispose(): void {
      running = false;
      if (model) discard(model);
      model = null;
      announce(null);
      observer.disconnect();
      controls.removeEventListener("change", moving);
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
