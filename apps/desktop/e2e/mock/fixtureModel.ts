/**
 * Bodies, read off the disk the fixtures sit on.
 *
 * On its own, away from the module that dresses them, because it is the one part of the mock
 * that is not written down: everything else here is a literal, and this is a file loaded off
 * disk at the moment a test asks for it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A `.glb` the backend's own converter wrote, as the data URL a command would answer with.
 *
 * Written by `cargo run --example dump_model`, and held to what the converters currently
 * produce by tests in `models.rs` and `character.rs`. Using the real output rather than a
 * hand-made stand-in is the point: this is the only place anything reads the glTF this app
 * writes, so it is the only place that can say three.js accepts it.
 */
export function fixtureModel(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const glb = readFileSync(join(here, "..", "..", "fixtures", "transmog", name));
  return `data:model/gltf-binary;base64,${glb.toString("base64")}`;
}
