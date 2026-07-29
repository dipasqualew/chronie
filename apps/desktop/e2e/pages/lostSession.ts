/**
 * The notice the timeline draws when the history it is showing is not all of what happened.
 *
 * The window asks the backend once on load, so a spec that wants a different answer has to be
 * holding it before the page runs — which is what [`LostSession.answer`] is for. It registers a
 * second init script over the one the harness installed and reloads; init scripts run in the
 * order they were added, so the patch lands on the shared world rather than replacing it.
 */

import type { Locator, Page } from "@playwright/test";

import { Shell } from "./shell";

import type { SessionGap } from "../../src/types";

export class LostSession {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = new Shell(page).view("Timeline");
  }

  /** Opens the window again with the backend giving this answer. */
  async answer(gap: SessionGap): Promise<void> {
    await this.page.addInitScript((patch) => {
      if (window.__Chronie_E2E__) window.__Chronie_E2E__.sessionGap = patch;
    }, gap);
    await this.page.goto("/");
  }

  /** The notice itself, which is only in the page at all when something is missing. */
  notice(): Locator {
    return this.view.getByRole("alert", { name: "Missing play" });
  }
}
