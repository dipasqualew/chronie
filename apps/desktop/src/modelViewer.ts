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

import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { framingDistance } from "./modelPreview";

/** How wide a view the camera takes, in degrees. Narrow enough that a helm keeps its shape
 * rather than bulging the way a wide angle makes close things bulge. */
const FIELD_OF_VIEW = 35;

export interface ModelStage {
  /** Puts a model on the stage, replacing whatever was there. */
  show(glb: Uint8Array): Promise<void>;
  /** Gives back the graphics memory and stops the loop. The stage is finished afterwards. */
  dispose(): void;
}

/**
 * A stage inside `container`, sized to it and kept sized to it.
 *
 * Throws when the machine has no working 3D at all, which is a thing that happens: a remote
 * desktop, a virtual machine without a GPU, a driver the browser has blocklisted. The caller
 * shows the icon instead, the same as for an appearance that has no model.
 */
export function createModelStage(container: HTMLElement): ModelStage {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // The textures come out of the game already lit — the shading a player sees on a helm is
  // painted into it — so the tone mapping is only here to keep the highlights of the one
  // light below from clipping.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  container.replaceChildren(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 1000);
  camera.position.set(0, 0, 3);

  // Two lights and no more: a key from over the reader's shoulder so that turning the model
  // shows its shape, and enough ambient that the side facing away is still legible.
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(1.4, 2, 2.5);
  scene.add(key);
  scene.add(new AmbientLight(0xffffff, 1.1));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // Panning a single item off the middle of its own pane is only ever an accident.
  controls.enablePan = false;
  controls.minDistance = 0.2;
  controls.maxDistance = 40;

  let model: Group | null = null;
  let running = true;

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
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  /**
   * What the stage is holding, written where anything outside can see it.
   *
   * A canvas says nothing about whether the file in it parsed into geometry — an empty scene
   * and a helm draw the same blank rectangle to everything but an eye. This is what the
   * browser tests read, and what to look at first when a model comes up empty.
   */
  function announce(loaded: Group | null): void {
    let drawn = 0;
    loaded?.traverse((object) => {
      const geometry = (object as { geometry?: { attributes?: { position?: { count: number } } } })
        .geometry;
      drawn += geometry?.attributes?.position?.count ?? 0;
    });
    container.dataset.vertices = String(drawn);
  }

  /** Centres the model on the origin and backs the camera off far enough to hold all of it. */
  function frameModel(loaded: Group): void {
    const box = new Box3().setFromObject(loaded);
    const centre = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    loaded.position.sub(centre);

    const distance = framingDistance(radius, FIELD_OF_VIEW);
    // Slightly above and to the side, because an item seen exactly head on reads as a
    // silhouette and the whole point of showing it in 3D is that it has a shape.
    camera.position.set(distance * 0.45, distance * 0.25, distance);
    controls.target.set(0, 0, 0);
    controls.update();
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
          frameModel(model);
          scene.add(model);
          announce(model);
          resolve();
        }, (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
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
