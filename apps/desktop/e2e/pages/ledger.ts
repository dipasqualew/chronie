/**
 * The details view: the ledger, where every segment is a row and nothing is summarised away.
 *
 * A table is a structure the accessibility tree already describes, so a cell is asked for by
 * what it says rather than by where it sits; the rows are the body's, which is named, because
 * the header is a row too and is not one of the segments.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { Shell } from "./shell";

export class Ledger {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    // Scoped to the view rather than the page: the roster next door is a landmark named for
    // the characters in it, and a bare "Character" reaches that too.
    this.view = new Shell(page).view("Details");
  }

  async open(): Promise<void> {
    await new Shell(this.page).open("Details");
    await expect(this.view.getByRole("heading", { name: "Details", level: 1 })).toBeVisible();
  }

  /** One row per segment, which is what the table is. */
  rows(): Locator {
    return this.view.getByRole("rowgroup", { name: "Segments" }).getByRole("row");
  }

  search(): Locator {
    return this.view.getByLabel("Filter segments");
  }

  character(): Locator {
    return this.view.getByLabel("Character");
  }

  /** A cell of the ledger, found the way a reader finds it: by what it says. */
  cellSaying(text: string): Locator {
    return this.view.getByRole("cell", { name: text });
  }
}
