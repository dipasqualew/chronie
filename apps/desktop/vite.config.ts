// `vitest/config` rather than `vite`, so the `test` block below is type checked rather
// than tolerated as an unknown key.
import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // three.js is 630 kB on its own and is already split off into a chunk nobody downloads
    // until they open a model. Warning about it on every build would only teach us to ignore
    // the warning; anything above this is something new and worth looking at.
    chunkSizeWarningLimit: 700,
    target: "esnext",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: Boolean(process.env.TAURI_DEBUG),
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
