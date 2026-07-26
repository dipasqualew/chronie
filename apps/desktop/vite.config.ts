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
    target: "esnext",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: Boolean(process.env.TAURI_DEBUG),
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
