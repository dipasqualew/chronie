/**
 * What every spec in this suite starts from: the built page, with a whole world behind it.
 *
 * The world is `mock/`, installed before the first script runs so that `bridge.ts` finds it
 * already there — the window never knows it is not talking to Tauri. It is an automatic
 * fixture rather than a `beforeEach` in each file, because there is exactly one way to open
 * this app and no spec has any business opening it differently.
 *
 * Everything a spec addresses the page through lives in `pages/`. Nothing here, and nothing in
 * a spec file, knows a CSS class or an id: the window says what its parts are — see the
 * landmarks, live regions and named lists it now carries — and the page objects ask for them by
 * those names. A restyle cannot break this suite, and a change that puts something out of
 * reach of a screen reader will.
 */

import { test as base } from "@playwright/test";

import { mockDesktop } from "./mock";

export { expect } from "@playwright/test";

export const test = base.extend<{ chronie: void }>({
  chronie: [
    async ({ page }, use) => {
      await page.addInitScript((mock) => {
        window.__Chronie_E2E__ = mock;
      }, mockDesktop);
      await page.goto("/");
      await use();
    },
    { auto: true },
  ],
});
