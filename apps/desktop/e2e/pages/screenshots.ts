/**
 * The screenshots: a grid wherever captures are shown, and the one somebody opened.
 *
 * A tile is addressed by what it opens rather than by its position, because "the screenshot
 * from Glass Caverns at 22:03" is what a reader is looking for and is the only thing a screen
 * reader will read out. The grid is scoped to whatever it was drawn in — a session card or the
 * segment modal — since the same component draws both.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export class Screenshots {
  readonly page: Page;
  readonly viewer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.viewer = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("button", { name: "Close screenshot" }) });
  }

  /** The grid drawn inside a session card or a segment's modal. */
  gridIn(scope: Locator): Locator {
    return scope.getByRole("list", { name: "Screenshots" });
  }

  tilesIn(scope: Locator): Locator {
    return this.gridIn(scope).getByRole("button", { name: /Open the screenshot/ });
  }

  /**
   * The pictures that have arrived in those tiles.
   *
   * By their alternative text being empty, which is the accessibility tree's own word for
   * "decorative" — the tile already says where and when the picture was taken, so a thumbnail
   * that announced itself as well would have every tile read twice.
   */
  thumbnailsIn(scope: Locator): Locator {
    return this.gridIn(scope).getByAltText("", { exact: true });
  }

  /** Opens an evening's pictures on a session card, which is folded away until asked for. */
  async unfold(card: Locator): Promise<Locator> {
    await card.getByRole("button", { name: /screenshots?/ }).click();
    return this.tilesIn(card);
  }

  async open(tile: Locator): Promise<void> {
    await tile.click();
    await expect(this.viewer).toBeVisible();
  }

  /** Which of the evening's pictures is up, as the viewer announces it. */
  position(): Locator {
    return this.viewer.getByRole("status", { name: "Which screenshot" });
  }

  /** The picture itself, at the size it was taken, which arrives after the dialog does. */
  picture(): Locator {
    return this.viewer.getByRole("img", { name: /^Screenshot from / });
  }

  note(): Locator {
    return this.viewer.getByLabel("Note", { exact: true });
  }

  /** One of the viewer's own buttons, by the words on it. */
  button(name: string): Locator {
    return this.viewer.getByRole("button", { name, exact: true });
  }

  /** The way on to the next of the evening's pictures, from inside one of them. */
  step(name: "Next screenshot" | "Previous screenshot"): Locator {
    return this.viewer.getByRole("button", { name });
  }

  /**
   * The same walk done from the keyboard, pressed at the window rather than at a locator: the
   * question is whether the viewer still hears the key wherever the focus has ended up.
   */
  arrow(towards: "Left" | "Right"): Promise<void> {
    return this.page.keyboard.press(`Arrow${towards}`);
  }

  /** What deleting would take with it, which is asked before it is done. */
  warning(): Locator {
    return this.viewer.getByRole("alert");
  }

  async close(): Promise<void> {
    await this.button("Close screenshot").click();
    await expect(this.viewer).toBeHidden();
  }
}
