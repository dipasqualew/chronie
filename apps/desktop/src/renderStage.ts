/**
 * The browser half of `scripts/render-model.ts`: a stage on a blank page, driven from outside.
 *
 * Nothing here decides anything. It puts a `.glb` on the app's own `createModelStage` and says
 * when the picture has settled, so that the process outside can take one. Everything the
 * render depends on — the loader, the materials, the lights, the tone mapping, and the policy
 * the page is served under — is the app's, because a tool that renders a model its own way can
 * only ever tell you about itself.
 */

import { createModelStage, type ModelStage, type StageOptions } from "./modelViewer";

/** What a caller asks for. */
export interface RenderRequest extends StageOptions {
  /** The `.glb`, base64 encoded, because that is what survives the trip into a page. */
  glb: string;
  /** How large a picture to draw, in CSS pixels. Square, so no view is foreshortened. */
  size: number;
}

/** What it is told about what it got, which is what `announce` wrote on the stage. */
export interface RenderReport {
  /** How much geometry the file turned into. Zero is a `.glb` that parsed into nothing. */
  vertices: number;
  /** How many of the model's textures arrived with an image in them. */
  pictures: number;
  /** How many did not — a texture the loader made and never managed to fill. */
  blank: number;
}

declare global {
  interface Window {
    /** Draws one model and answers once there is something on the canvas to photograph. */
    renderModel(request: RenderRequest): Promise<RenderReport>;
  }
}

const container = document.getElementById("stage");
if (!container) throw new Error("the render page has no stage to draw on");

let stage: ModelStage | null = null;

window.renderModel = async ({ glb, size, ...options }: RenderRequest): Promise<RenderReport> => {
  container.style.width = `${size}px`;
  container.style.height = `${size}px`;

  // A fresh stage per model: the options are fixed when one is built, and a run asks for a
  // single picture. Disposing first is what gives the graphics memory back between them.
  stage?.dispose();
  stage = createModelStage(container, options);

  const binary = atob(glb);
  await stage.show(Uint8Array.from(binary, (character) => character.charCodeAt(0)));

  // Two frames. The first is the one that uploads the textures and the second is the first
  // drawn with them — and a picture taken between the two is a model in flat white, which is
  // precisely the symptom this tool exists to tell apart from a real one.
  await new Promise((settle) => requestAnimationFrame(() => requestAnimationFrame(settle)));

  return {
    vertices: Number(container.dataset.vertices ?? 0),
    pictures: Number(container.dataset.pictures ?? 0),
    blank: Number(container.dataset.blank ?? 0),
  };
};
