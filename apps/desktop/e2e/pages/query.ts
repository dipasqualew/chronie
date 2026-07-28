/**
 * The Query view: an editor, an answer, and a picture of it.
 *
 * Everything here is addressed the way it is announced — the editor by its label, the chart by
 * the sentence a screen reader is given for it, the refusal by being an alert, the rows by
 * being the body of a table.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { Shell } from "./shell";

export class Workbench {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = new Shell(page).view("Query");
  }

  async open(): Promise<void> {
    await new Shell(this.page).open("Query");
    await expect(this.view.getByRole("heading", { name: "Query", level: 1 })).toBeVisible();
  }

  editor(): Locator {
    return this.view.getByRole("textbox", { name: "SQL" });
  }

  run(): Promise<void> {
    return this.view.getByRole("button", { name: "Run" }).click();
  }

  /** The chart, which says what it is drawing in the name it is announced by. */
  chart(): Locator {
    return this.view.getByRole("img");
  }

  /** One of the three dropdowns over the chart: `Horizontal axis`, `Vertical axis`, `Chart shape`. */
  choice(name: string): Locator {
    return this.view.getByRole("combobox", { name });
  }

  /** What the run amounted to — rows, columns, milliseconds. */
  summary(): Locator {
    return this.view.getByRole("status");
  }

  /** Why a query was refused, in the words the database used. */
  failure(): Locator {
    return this.view.getByRole("alert");
  }

  rows(): Locator {
    return this.view.getByRole("rowgroup", { name: "What came back" }).getByRole("row");
  }

  /** One question worth asking, offered above the editor. */
  recipe(name: string): Locator {
    return this.view.getByRole("button", { name });
  }

  /**
   * A table in the list down the left, opened so what is inside it can be reached.
   *
   * By the summary's own tooltip, because a `<summary>` carries no role of its own and nothing
   * else on it would say which table it opens.
   */
  async openTable(name: string): Promise<Locator> {
    await this.view.getByTitle(`What is in ${name}`).click();
    return this.view.getByRole("group", { name });
  }
}
