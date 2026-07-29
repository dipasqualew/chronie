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

  /** The way back out of a drag, which only a live camera has. */
  resetPortrait(name: string): Locator {
    return this.figure(name).getByRole("button", { name: "Reset camera" });
  }

  /**
   * The shape of the picture and of the pane holding it, in CSS pixels.
   *
   * Read off the canvas rather than asked of the accessibility tree, because "the canvas covers
   * its pane and no more" is not a thing the tree has an opinion about — and it is the thing worth
   * checking. `modelViewer.ts` sizes the drawing *buffer* in device pixels and sets no inline
   * style, so a pane whose stylesheet does not lay the canvas out gets one laid out at its buffer:
   * twice the pane on a Retina screen, and because a stage's automatic minimum size is its
   * content, the pane then grows to fit it and the `ResizeObserver` doubles the buffer again. That
   * runs away to the browser's largest element in a few frames, which is #146. The locator is
   * found by name; the measuring is what the note in `paint.ts` allows.
   */
  portraitShape(
    name: string,
    wearing: string,
  ): Promise<{ pane: [number, number]; canvas: [number, number] }> {
    return this.drawn(name, wearing).evaluate((canvas) => {
      const pane = canvas.parentElement as HTMLElement;
      return {
        pane: [pane.clientWidth, pane.clientHeight] as [number, number],
        canvas: [canvas.clientWidth, canvas.clientHeight] as [number, number],
      };
    });
  }

  /**
   * Where the portrait's camera is, as the stage writes it beside the picture.
   *
   * A canvas draws the same rectangle whichever way round the body on it is, so nothing but an eye
   * can tell a model that turned from one that did not. This is what the stage writes for exactly
   * that reason — see `report` in `modelViewer.ts`.
   */
  portraitCamera(name: string, wearing: string): Promise<string | undefined> {
    return this.drawn(name, wearing).evaluate(
      (canvas) => (canvas.parentElement as HTMLElement).dataset.camera,
    );
  }

  /** Drags the portrait sideways, which is how a reader turns a character round. */
  async turnPortrait(name: string, wearing: string): Promise<void> {
    const shot = this.drawn(name, wearing);
    const box = await shot.boundingBox();
    if (!box) throw new Error(`${name} is not on screen to be turned`);
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await this.page.mouse.move(middle.x, middle.y);
    await this.page.mouse.down();
    await this.page.mouse.move(middle.x - box.width / 3, middle.y, { steps: 8 });
    await this.page.mouse.up();
  }

  /* ---------- the summary ---------- */

  /** One of the numbers in the fact grid, addressed by the word above it. */
  stat(label: string): Locator {
    return this.profile.getByRole("group", { name: label }).getByRole("definition");
  }

  /** A row of one of the two holdings tables, found by the thing it is about. */
  holding(table: "Currencies" | "Reputation", name: string): Locator {
    return this.profile
      .getByRole("table", { name: table })
      .getByRole("row")
      .filter({ hasText: name });
  }

  /**
   * The picture a faction borrows from its own Exalted achievement, in the standings table.
   *
   * Found by the faction it is of, because the row names the faction beside it. This column was
   * plain names before there were any pictures and stays plain for every faction the game has no
   * achievement for — which is every renown faction — so asking for a frame is how a spec says
   * which of the two a row is.
   */
  factionIcon(faction: string): Locator {
    return this.profile.getByRole("img", { name: `Icon for ${faction}` });
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
    return this.profile
      .getByRole("region", { name: "What it got them" })
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
