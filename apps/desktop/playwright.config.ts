import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Most specs draw WebGL in software on CI, and a developer's machine is commonly building
  // at the same time. Unbounded workers make each render loop miss the fixed budgets below.
  workers: 4,
  // These are suite budgets, not estimates: ordinary specs finish in seconds, while the few
  // deliberate render benchmarks call `test.slow()` and receive three times this allowance.
  timeout: 60_000,
  expect: {
    // Backend answers and software-rendered pictures arrive asynchronously throughout the
    // suite. Five seconds is Playwright's default, not a promise this app makes.
    timeout: 30_000,
  },
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
