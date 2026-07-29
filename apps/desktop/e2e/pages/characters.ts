/**
 * The characters view: the roster down the left, one character on the right.
 *
 * The roster is a navigation landmark and each character is a button in it, so picking one is
 * reachable the way a screen reader reaches any list of choices. The pane beside it is a
 * landmark of its own holding two pages — Summary is what they are, Activity is what they have
 * been doing — switched by a tab each, so everything here is asked for by name: a figure in the
 * fact grid by the word above it, a currency or a faction by the row it is on, a range by the
 * label over the selector.
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

  /* ---------- the two pages ---------- */

  /** The tab that opens one of them, which is also what says which is open. */
  pageTab(name: "Summary" | "Activity"): Locator {
    return this.profile.getByRole("tab", { name });
  }

  async show(name: "Summary" | "Activity"): Promise<void> {
    await this.pageTab(name).click();
    await expect(this.pageTab(name)).toHaveAttribute("aria-selected", "true");
  }

  /* ---------- the portrait ---------- */

  /** The character drawn in one of the sets they saved, found by who it is of. */
  figure(name: string): Locator {
    return this.profile.getByRole("figure", { name: `${name}, drawn` });
  }

  /** Whatever the frame is holding: the body once it arrives, and a sentence until it does. */
  drawn(name: string, wearing: string): Locator {
    return this.figure(name).getByRole("img", { name: `${name} wearing ${wearing}, drawn` });
  }

  /** What the frame says when it is holding no body. */
  figureNote(name: string): Locator {
    return this.figure(name).getByRole("paragraph");
  }

  /* ---------- the summary ---------- */

  /** One of the numbers in the fact grid, addressed by the word above it. */
  stat(label: string): Locator {
    return this.profile.getByRole("group", { name: label }).getByRole("definition");
  }

  /** A row of one of the two holdings tables, found by the thing it is about. */
  holding(table: "Currencies" | "Reputation", name: string): Locator {
    return this.profile.getByRole("table", { name: table })
      .getByRole("row").filter({ hasText: name });
  }

  /** Where the character stands with a faction, as a screen reader is told it. */
  standingWith(faction: string | RegExp): Locator {
    return this.profile.getByRole("progressbar", { name: faction });
  }

  /* ---------- the activity ---------- */

  /** How far back the activity page is looking. */
  range(): Locator {
    return this.profile.getByRole("combobox", { name: "Showing" });
  }

  /** What that range turned out to hold, as the line beside the selector reads it. */
  ranged(): Locator {
    return this.profile.getByRole("status", { name: "What the range holds" });
  }

  /** What was done in it, in the order it was done. */
  activities(): Locator {
    return this.profile.getByRole("list", { name: "What was done" }).getByRole("listitem");
  }

  /** A summary chip of what the range earned, which behaves the way a session card's chips do. */
  chip(saying: string | RegExp): Locator {
    return this.profile.getByRole("region", { name: "What it got them" })
      .getByRole("button", { name: saying });
  }

  /** One of the things such a summary unfolded into, which is a way back to its segment. */
  unfolded(name: string): Locator {
    return this.profile.getByRole("button", { name: `Open the segment ${name} was recorded in` });
  }

  /** The disclosure the segments are folded away behind. */
  segmentFold(): Locator {
    return this.profile.getByRole("group", { name: "Every segment in this range" });
  }

  /** Opens it. The count is what it is labelled with, so it is what the click asks for. */
  async openSegments(count: string): Promise<void> {
    await this.segmentFold().getByText(count).click();
    await expect(this.segments().first()).toBeVisible();
  }

  /** The segment rows inside it, which are the same rows the timeline unfolds into. */
  segments(): Locator {
    return this.profile.getByRole("button", { name: /^Open segment:/ });
  }

  /** The days those rows are filed under, newest first. */
  days(): Locator {
    return this.profile.getByRole("heading", { level: 4 });
  }
}
