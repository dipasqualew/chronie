// The repository's own scripts, which `apps/desktop`'s vitest cannot reach: bun's isolated
// linker gives each workspace only the packages it asked for, so a test file outside
// `apps/desktop` has no `vitest` to import. This config is that test file's runner.
//
// It deliberately holds no plugins. Nothing under `scripts/` renders anything; these tests
// read files off disk and assert on what they say.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "scripts",
    include: ["scripts/**/*.test.ts"],
    environment: "node",
  },
});
