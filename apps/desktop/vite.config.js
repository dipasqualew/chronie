import { defineConfig } from "vite";

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
    include: ["src/**/*.test.js"],
  },
});
