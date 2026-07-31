/**
 * The collection view: what the account holds, and what the game has to hold it against.
 *
 * Everything on that screen is a subtraction taken against a reading, so the two things worth
 * reaching are the numbers and the reading over them — and they are asked for the same way a
 * screen reader would ask: a live region for the provenance, an alert for what the number is
 * worth, and a named group per figure of the tally, because a `<dd>` takes no name of its own.
 *
 * The one thing here that is not a locator is `provenanceAboveTally`. That the reading is drawn
 * *before* the numbers is a claim the accessibility tree has no opinion about and the whole
 * feature turns on, so it is measured off two elements that were found by name — the same
 * allowance `paint.ts` takes.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { Shell } from "./shell";

/** Which half of the collection is on screen, by the word on the button that opens it. */
export type Half = "Achievements" | "Mounts";

/** The singular the view names a reading and its caveat after, per half. */
const NOUN: Record<Half, string> = { Achievements: "achievement", Mounts: "mount" };

export class Collection {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = new Shell(page).view("Collection");
  }

  async open(): Promise<void> {
    await new Shell(this.page).open("Collection");
    await expect(this.view.getByRole("heading", { name: "Collection", level: 1 })).toBeVisible();
  }

  /** Switches between the two halves, which is two buttons rather than a router. */
  async lookAt(half: Half): Promise<void> {
    await this.view
      .getByRole("group", { name: "Look at" })
      .getByRole("button", { name: half })
      .click();
    await expect(this.reading(half)).toBeVisible();
  }

  /** Both halves at once, as the line under the heading reads them. */
  holdings(): Locator {
    return this.view.getByRole("status", { name: "What the collection holds" });
  }

  /** What the walk claimed about itself, which is the provenance of every number under it. */
  reading(half: Half): Locator {
    return this.view.getByRole("status", { name: `How the ${NOUN[half]} census was read` });
  }

  /**
   * What the view says the number under it is worth — drawn at either of two volumes.
   *
   * By label rather than by role, because both volumes answer to the same name and a page object
   * that could only reach one of them would leave the quieter one untestable. `graveWorth` is
   * the one that asks specifically for the loud one.
   */
  worth(half: Half): Locator {
    return this.view.getByLabel(`What the ${NOUN[half]} count is worth`);
  }

  /** The same thing, asked for as an alert: the page admitting the number is unsound. */
  graveWorth(half: Half): Locator {
    return this.view.getByRole("alert", { name: `What the ${NOUN[half]} count is worth` });
  }

  /** One figure of the tally, addressed by the word above it. */
  tally(half: Half, label: string): Locator {
    return this.view
      .getByLabel(`How many ${NOUN[half]}s`)
      .getByRole("group", { name: label })
      .getByRole("definition");
  }

  /**
   * Whether the reading is drawn above the numbers taken from it.
   *
   * Read off the boxes rather than asked of the tree, because "this comes first" is not
   * something the accessibility tree states — and it is the claim the whole screen is built on.
   */
  async provenanceAboveTally(half: Half): Promise<boolean> {
    const above = await this.reading(half).boundingBox();
    const below = await this.tally(half, "Held").boundingBox();
    if (!above || !below) throw new Error(`the ${NOUN[half]} half is not on screen to be measured`);
    return above.y < below.y;
  }

  /* ---------- the achievement tree ---------- */

  private get tree(): Locator {
    return this.view.getByRole("region", { name: "Achievements by category", exact: true });
  }

  /** The branches of the game's own tree, in the order the view ranked them. */
  categories(): Locator {
    return this.tree.getByRole("group");
  }

  /** Opens one of them. The summary carries no role, so the click asks for its tooltip. */
  async openCategory(name: string): Promise<void> {
    await this.tree.getByTitle(`What is left in ${name}`).click();
    await expect(this.missingIn(name).first()).toBeVisible();
  }

  /** What is left in one branch, worth the most first. */
  missingIn(name: string): Locator {
    return this.tree.getByRole("list", { name: `${name} still to earn` }).getByRole("listitem");
  }

  /* ---------- who earned them, and when ---------- */

  /** One character's share of the account, as a row of the cast. */
  carrier(character: string): Locator {
    return this.view
      .getByRole("region", { name: "Who earned them" })
      .getByRole("row")
      .filter({ hasText: character });
  }

  /** One figure on that row, by what it says — the row header is the name, the cells are it. */
  carrierCell(character: string, value: string): Locator {
    return this.carrier(character).getByRole("cell", { name: value, exact: true });
  }

  /** The account's history year by year, oldest first and with the empty years in it. */
  years(): Locator {
    return this.view
      .getByRole("list", { name: "Achievements earned each year" })
      .getByRole("listitem");
  }

  /** One of those years, found by the year itself. */
  year(year: string): Locator {
    return this.years().filter({ hasText: year });
  }

  /* ---------- the mounts ---------- */

  /** The mounts the game has and the account has not, by name. */
  mounts(): Locator {
    return this.view.getByRole("list", { name: "Mounts still to get" }).getByRole("listitem");
  }

  /** One of them, found by the name the row leads with. */
  mount(name: string): Locator {
    return this.mounts().filter({ hasText: name });
  }
}
