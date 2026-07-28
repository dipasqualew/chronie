/**
 * The characters view: the roster down the left, one character's whole history on the right.
 *
 * The roster is a navigation landmark and each character is a button in it, so picking one is
 * reachable the way a screen reader reaches any list of choices; the pane beside it is a
 * landmark of its own and is walked by heading. Each figure in the fact grid is a named group,
 * which is the one thing a term and its definition cannot do for themselves.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { Shell } from "./shell";

export class Roster {
  readonly page: Page;
  readonly view: Locator;
  readonly profile: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = new Shell(page).view("Characters");
    this.profile = this.view.getByRole("region", { name: "The character" });
  }

  async open(): Promise<void> {
    await new Shell(this.page).open("Characters");
    await expect(this.view.getByRole("heading", { name: "Characters", level: 1 })).toBeVisible();
  }

  /** How much history is on screen, as the line under the heading reads it. */
  summary(): Locator {
    return this.view.getByRole("status", { name: "What the roster holds" });
  }

  /** The roster itself, in the order it chose to put its characters in. */
  entries(): Locator {
    return this.view.getByRole("navigation", { name: "Character roster" }).getByRole("button");
  }

  /** One character in it, found by the name the entry is announced with. */
  entry(name: string): Locator {
    return this.entries().filter({ hasText: name });
  }

  async pick(name: string): Promise<void> {
    await this.entry(name).click();
    await expect(this.profile.getByRole("heading", { name, level: 2 })).toBeVisible();
  }

  /** One of the numbers in the fact grid, addressed by the word above it. */
  stat(label: string): Locator {
    return this.profile.getByRole("group", { name: label }).getByRole("definition");
  }

  /** The segment rows on the pane, which are the same rows the timeline unfolds into. */
  segments(): Locator {
    return this.profile.getByRole("button", { name: /^Open segment:/ });
  }

  /** The days those rows are filed under, newest first. */
  days(): Locator {
    return this.profile.getByRole("heading", { level: 4 });
  }

  /** A line on the pane, found by the thing it is about. */
  lineFor(name: string): Locator {
    return this.profile.getByRole("listitem").filter({ hasText: name });
  }

  /** Where the character stands with a faction, as a screen reader is told it. */
  standingWith(faction: string | RegExp): Locator {
    return this.profile.getByRole("progressbar", { name: faction });
  }

  /** A summary chip on the pane, which behaves the way the session card's chips do. */
  chip(saying: string | RegExp): Locator {
    return this.profile.getByRole("button", { name: saying });
  }

  /** One of the things a summary unfolded into, which is a way back to its segment. */
  unfolded(name: string): Locator {
    return this.profile.getByRole("button", { name: `Open the segment ${name} was recorded in` });
  }
}
