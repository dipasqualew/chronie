/**
 * The two browsers that are not the game's own wardrobe: the sets the reader assembled here,
 * and the ones the player saved in the game itself.
 *
 * They are a pair because they are each other's opposite. A saved set is made by the page
 * under test and arrives with its pieces already in hand, so its card has nothing to open. An
 * in-game set can only ever arrive from outside, names appearances and nothing else, and costs
 * four walks of the game's own tables to open — so its card reads like one of Blizzard's.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { TransmogView } from "./transmog";

/** The third browser: the sets the reader saved off the character. */
export class YourSets {
  readonly page: Page;
  readonly list: Locator;

  constructor(page: Page) {
    this.page = page;
    this.list = new TransmogView(page).view
      .getByRole("region", { name: "The sets you saved here" });
  }

  /** The saved sets on screen, by the names the reader gave them. */
  names(): Locator {
    return this.list.getByRole("heading", { level: 4 });
  }

  /** Whatever the browser says when it is holding none of them, or none that match. */
  saying(text: string | RegExp): Locator {
    return this.list.getByText(text);
  }

  /** The card one of them is drawn on, found by its own heading. */
  card(name: string): Locator {
    return this.list
      .getByRole("article")
      .filter({ has: this.page.getByRole("heading", { name, exact: true, level: 4 }) });
  }

  /** The pieces a saved set turned out to be made of, which arrived with the card. */
  pieces(name: string): Locator {
    return this.card(name).getByRole("list", { name: `Pieces of ${name}` }).getByRole("listitem");
  }

  /** One of those rows, found by what its button would do. */
  wear(name: string, slot: string, label: string): Locator {
    return this.card(name).getByRole("button", { name: `Wear ${slot}: ${label}` });
  }

  wearAll(name: string): Locator {
    return this.card(name).getByRole("button", { name: `Wear all of ${name}` });
  }

  /** The star on the card, which is against the set the reader made. */
  star(name: string): Locator {
    return this.card(name).getByRole("button", { name: `Favourite ${name}`, exact: true });
  }

  /** What has been said about it, as the chips read. */
  tags(name: string): Locator {
    return this.card(name).getByRole("button", { name: /^Filter by the tag / });
  }

  /** The first of the two clicks that throw one away, which only asks. */
  askToDelete(name: string): Locator {
    return this.card(name).getByRole("button", { name: `Delete ${name}`, exact: true });
  }

  /** The way back out of that question. */
  keep(name: string): Locator {
    return this.card(name).getByRole("button", { name: "Keep it", exact: true });
  }

  /**
   * Throws one away, which takes two clicks: the first asks and the second does it.
   *
   * Both are named after the set, so the confirmation cannot be reached by accident — and the
   * assertion that the first click did *not* delete anything is left to the test.
   */
  async delete(name: string): Promise<void> {
    await this.askToDelete(name).click();
    await this.askToDelete(name).click();
  }

  search(): Locator {
    return this.list.getByLabel("Filter your sets");
  }

  tagFilter(): Locator {
    return this.list.getByLabel("Tag", { exact: true });
  }
}

/**
 * The fourth browser: the sets the player saved in the game itself.
 *
 * Grouped by character, which is the one way it is drawn differently from the three beside it —
 * so a character is a level-3 heading and a set a level-4 one, the same shape a collection and
 * a set have in the game's own grid. A character who saves nothing in game is not drawn at all,
 * so [`characters`] is what they have rather than who Chronie has read.
 */
export class InGameSets {
  readonly page: Page;
  readonly list: Locator;

  constructor(page: Page) {
    this.page = page;
    this.list = new TransmogView(page).view
      .getByRole("region", { name: "The sets you saved in the game" });
  }

  /** The characters with something to show, in the order the backend sorted them. */
  characters(): Locator {
    return this.list.getByRole("heading", { level: 3 });
  }

  /** The sets on screen, by the names the game holds them under. */
  names(): Locator {
    return this.list.getByRole("heading", { level: 4 });
  }

  saying(text: string | RegExp): Locator {
    return this.list.getByText(text);
  }

  card(name: string): Locator {
    return this.list
      .getByRole("article")
      .filter({ has: this.page.getByRole("heading", { name, exact: true, level: 4 }) });
  }

  /** One row per slot the player filled, which is what an opened set turned out to be. */
  rows(name: string): Locator {
    return this.card(name).getByRole("list", { name: `Pieces of ${name}` }).getByRole("listitem");
  }

  /** Opens one in place, which is where the game's files are actually read. */
  async openSet(name: string): Promise<void> {
    await this.list.getByRole("button", { name, exact: true }).click();
    await expect(this.rows(name).first()).toBeVisible();
  }

  /** The button on one row, which puts that piece on the character or takes it off again. */
  wear(name: string, slot: string, label: string): Locator {
    return this.card(name).getByRole("button", { name: `Wear ${slot}: ${label}` });
  }

  wearAll(name: string): Locator {
    return this.card(name).getByRole("button", { name: `Wear all of ${name}` });
  }
}

/**
 * Writes a tag against whatever is being marked, the way a reader does: open the little form,
 * fill it in, submit it. `host` is the card or the row it belongs to.
 *
 * The value is optional here because it is optional there — a tag with nothing in that box is
 * a label, which is half of what marking is for.
 */
export async function tagIt(
  host: Locator, name: string, key: string, value = "",
): Promise<void> {
  await host.getByRole("button", { name: `Tag ${name}`, exact: true }).click();
  await host.getByLabel(`Tag name for ${name}`, { exact: true }).fill(key);
  if (value) await host.getByLabel(`Tag value for ${name} (optional)`, { exact: true }).fill(value);
  await host.getByRole("button", { name: "Add", exact: true }).click();
}
