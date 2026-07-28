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
  Box3,
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

import { cameraFor, framingDistance, onScreen, type View } from "./modelPreview";

/** How wide a view the camera takes, in degrees. Narrow enough that a helm keeps its shape
 * rather than bulging the way a wide angle makes close things bulge. */
const FIELD_OF_VIEW = 35;

/** A point as the readout writes it: three axes, three decimals, one string to compare. */
const triple = (point: Vector3): string =>
  [point.x, point.y, point.z].map((axis) => axis.toFixed(3)).join(",");

export interface ModelStage {
  /** Puts a model on the stage, replacing whatever was there. */
  show(glb: Uint8Array): Promise<void>;
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

  let model: Group | null = null;
  let running = true;
  // Whether anything has ever been framed on this stage, which is what decides whether the
  // next model moves the camera. See `frameModel`.
  let framed = false;

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
   * Centres the model on the origin, works out where a camera holding all of it would sit,
   * and puts the camera there — the first time only.
   *
   * **Every model after the first leaves the camera exactly where the reader left it.** A
   * stage outlives the models on it: the outfit pane keeps one for as long as the wardrobe is
   * open and draws a new body for every piece put on or taken off. Framing each of them was
   * throwing away the reader's view once per click, so somebody comparing two helms on a face
   * they had zoomed in on had to zoom in again for the second one, and again after changing
   * their mind. What is on the stage is one character in different clothes, so the camera that
   * suited the last of them suits this one.
   *
   * The framing is still worked out, because it is what "Reset camera" goes back to, and that
   * has to be this model's framing rather than the one the pane opened on. `position0` and
   * `target0` are set instead of `saveState`, which would save wherever the camera is now —
   * the difference between a reset that frames the body and a reset that hands back a drag.
   */
  function frameModel(loaded: Group): void {
    const box = new Box3().setFromObject(loaded);
    const centre = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    loaded.position.sub(centre);

    const seen = onScreen([size.x, size.y, size.z], view);
    const place = cameraFor(view, framingDistance(seen, FIELD_OF_VIEW, camera.aspect));
    // How far off the middle of the model the middle of the pane may be dragged: to anywhere
    // on the model and no further. Zoomed into a helm that reaches the boots, which is the
    // whole errand; what it rules out is the drag that carries the model off the pane
    // entirely and leaves nothing on screen to say which way it went.
    controls.maxTargetRadius = size.length() / 2;
    controls.position0.set(...place);
    controls.target0.set(0, 0, 0);

    if (!framed) {
      framed = true;
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
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(swap)
        : swap(mesh.material);
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
    show(glb: Uint8Array): Promise<void> {
      return new Promise((resolve, reject) => {
        // A copy, because the loader takes ownership of the buffer it parses and the caller's
        // array may be a view into a longer one.
        const bytes = glb.slice().buffer as ArrayBuffer;
        new GLTFLoader().parse(bytes, "", (loaded) => {
          if (model) discard(model);
          model = loaded.scene;
          if (unlit) flatten(model);
          frameModel(model);
          scene.add(model);
          announce(model);
          resolve();
        }, (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
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
    dispose(): void {
      running = false;
      if (model) discard(model);
      model = null;
      announce(null);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
