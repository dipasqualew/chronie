/**
 * The window itself: the bar across the top, the six views under it, and the one thing the app
 * does that a browser test cannot watch — handing a url to the operating system.
 *
 * Every other page object in this suite is about one view. This is what they all sit inside,
 * so it is where the tabs live and where "the window is still the window" is asked.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { eventually } from "./eventually";
import type { Eventually } from "./eventually";

/** The six tabs, by the words on them. */
export type ViewName = "Timeline" | "Characters" | "Details" | "Query" | "Transmog" | "Settings";

export class Shell {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Opens a view and hands back the landmark it is drawn in.
   *
   * Exactly, because the words on the tabs turn up all over the window — a session that
   * collected a transmog source has a chip that says "Transmog" too.
   */
  async open(name: ViewName): Promise<Locator> {
    await this.page.getByRole("button", { name, exact: true }).click();
    const view = this.view(name);
    await expect(view).toBeVisible();
    return view;
  }

  /**
   * One of the six views, by the name of the tab that opens it.
   *
   * The timeline is the window's `main` and the other five are regions beside it, which is
   * what they are: one of them is what the window is for at any moment and the rest are
   * hidden. A hidden view is out of the accessibility tree altogether, so this only ever
   * reaches the one on screen.
   */
  view(name: ViewName): Locator {
    return name === "Timeline"
      ? this.page.getByRole("main", { name })
      : this.page.getByRole("region", { name, exact: true });
  }

  /**
   * The policy the page is actually served under, read off a fresh load of it.
   *
   * The one thing on this page that is about the harness rather than the product: the packaged
   * window runs under a Content Security Policy and this suite has to run under the same one.
   */
  async policy(): Promise<string> {
    const response = await this.page.reload();
    return response?.headers()["content-security-policy"] ?? "";
  }

  /**
   * What the page is painted, as the browser resolved it.
   *
   * The whole stylesheet in one reading: it is inline, so it lives or dies on having been
   * stamped with the nonce the policy above carries, and a body in the browser default is what
   * a mis-stamped one looks like.
   */
  background(): Eventually<string> {
    return eventually(() =>
      this.page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    );
  }

  /**
   * How far down the window itself the reader has got, in pixels.
   *
   * The window and not a view, because there is one scrolling page here and every view is drawn
   * inside it — which is why anything on the page that scrolls for itself has to say so, and why
   * this is the reading that catches one that does not.
   */
  scrolledBy(): Eventually<number> {
    return eventually(() => this.page.evaluate(() => window.scrollY));
  }

  /** The build, in the corner of the bar, which says what it is in its own tooltip. */
  build(): Locator {
    return this.page.getByTitle(/^Chronie /);
  }

  /**
   * The urls the window has asked the operating system to open, in the order it asked.
   *
   * A real browser opening is the one outcome a browser test cannot see, so this stands in for
   * it: the app has done its part when it has handed the url over.
   */
  openedUrls(): Eventually<string[]> {
    return eventually(() => this.page.evaluate(() => window.__Chronie_E2E__?.openedUrls ?? []));
  }

  /** Where the window itself is, which every link out of it has to leave alone. */
  url(): string {
    return this.page.url();
  }

  /** The one floating tooltip, shared by everything on the page that carries a tip. */
  tooltip(): Locator {
    return this.page.getByRole("status", { name: "What the pointer is on" });
  }
}
