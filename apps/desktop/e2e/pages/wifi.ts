/**
 * Moving a history between machines, from both ends: the half that offers and the half that
 * agrees.
 *
 * Two landmarks on one page, named after their own headings, because both halves of a transfer
 * are on this screen and neither may answer for the other. The offer is a named group inside
 * the receiving half, which is what makes "there is an offer" a thing to ask rather than an
 * element to go looking for.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { eventually } from "./eventually";
import type { Eventually } from "./eventually";
import { openSettings } from "./settings";

export class Wifi {
  readonly page: Page;
  readonly sending: Locator;
  readonly receiving: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sending = page.getByRole("region", { name: "Send this history" });
    this.receiving = page.getByRole("region", { name: "Receive a history" });
  }

  async open(): Promise<void> {
    await openSettings(this.page, "Move this history");
    await expect(this.sending).toBeVisible();
  }

  /** What the sending half has just done, which is announced as it changes. */
  sendStatus(): Locator {
    return this.sending.getByRole("status");
  }

  receiveStatus(): Locator {
    return this.receiving.getByRole("status");
  }

  /** Where this history would go, which choosing a Chronie fills in rather than sends to. */
  address(): Locator {
    return this.sending.getByLabel("Address");
  }

  /**
   * The one screen in the app that destroys data if it is answered without reading.
   *
   * Absent until there is something to answer, which is why it is asked for as a group rather
   * than looked for by name: a group that is not there is a question nobody is being asked.
   */
  offer(): Locator {
    return this.receiving.getByRole("group");
  }

  /** A button on either half, by the words on it. */
  button(half: "sending" | "receiving", name: string | RegExp): Locator {
    return this[half].getByRole("button", { name });
  }

  /**
   * The addresses this window has offered its history to, in the order it offered.
   *
   * Sending is a command rather than a repaint, so what it wrote is true only once it has
   * answered — asserting on this keeps asking until then. Asserting that the list is still
   * *empty* passes on the first reading, as it must; what holds that step up is the assertion
   * before it, which has already waited for the click to have been answered.
   */
  sentTo(): Eventually<string[]> {
    return eventually(() => this.page.evaluate(() => window.__Chronie_E2E__?.wifi.sentTo ?? []));
  }
}
