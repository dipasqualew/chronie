import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:4399",
    trace: "on-first-retry",
  },
  webServer: {
    command: "bun run build && bun run preview --host 127.0.0.1 --port 4399",
    port: 4399,
    reuseExistingServer: true,
  },
});
