/**
 * One segment in full: the modal every view opens, the editor behind it, and the picture one
 * of its rows opens into.
 *
 * The modal is a dialog and its sections are landmarks named after their headings — so "the
 * achievements" and "the equipment sets" are things to ask for rather than places to count to.
 * Three dialogs can be open at once here, and each is found by the one control only it has: a
 * modal is named after whatever it is showing, which changes as the reader walks the list.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export class SegmentDetail {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole("dialog")
      .filter({ has: page.getByRole("button", { name: "Close segment" }) });
  }

  /** Opens the modal from a row for a given character and location, wherever the row is. */
  async openFor(character: string, instance: string): Promise<void> {
    await this.page
      .getByRole("button", { name: new RegExp(`Open segment: ${character} in ${instance}`) })
      .click();
    await expect(this.dialog).toBeVisible();
  }

  title(): Locator {
    return this.dialog.getByRole("heading", { level: 2 });
  }

  /** Where in the list the reader is, which the modal announces as they step through it. */
  position(): Locator {
    return this.dialog.getByRole("status", { name: "Which segment" });
  }

  /**
   * One section of the modal, by the heading it is filed under.
   *
   * The modal is a dozen lists of unrelated things — achievements, transmog, currency, the
   * equipment sets — and every question about one of them is a question about its section.
   */
  section(title: string): Locator {
    return this.dialog.getByRole("region", { name: title, exact: true });
  }

  /** The rows of one of those sections. */
  rowsIn(title: string): Locator {
    return this.section(title).getByRole("listitem");
  }

  /**
   * The pictures that have arrived in a section's rows.
   *
   * By their alternative text being empty, which is the accessibility tree's own word for
   * "this is decorative" — and it is decorative on purpose: the row names the item beside the
   * picture, so one that announced itself would have a screen reader read every row twice.
   * "The frame holds a picture that says nothing" is exactly the claim being made.
   */
  iconsIn(title: string): Locator {
    return this.section(title).getByAltText("", { exact: true });
  }

  /** A link out of the window, named by the text it shows. */
  linkTo(name: string): Locator {
    return this.dialog.getByRole("link", { name });
  }

  /**
   * The line one gain is written on, found by the thing it is a gain of.
   *
   * Every section of the modal lists its events, so a gain is a list item wherever it lives,
   * and the name on it is the only thing a reader would use to find it.
   */
  gainFor(name: string): Locator {
    return this.dialog.getByRole("listitem").filter({ hasText: name });
  }

  /**
   * The bar under a reputation gain, addressed the way a screen reader announces it.
   *
   * This is the whole reason the standing is drawn as a `<progress>` rather than a pair of
   * divs: a bar with a name, a value and a length is something the accessibility tree already
   * carries, so the test can read exactly what a reader is told.
   */
  standingBars(name?: string | RegExp): Locator {
    return name === undefined
      ? this.dialog.getByRole("progressbar")
      : this.dialog.getByRole("progressbar", { name });
  }

  /** One equipment set the segment changed, on the line that says what happened to it. */
  equipset(title: string): Locator {
    return this.section("Equipment sets").getByRole("listitem").filter({ hasText: title });
  }

  /** And the slots inside it, which are the part a table could never hold. */
  slotsOf(title: string): Locator {
    return this.section("Equipment sets")
      .getByRole("list", { name: `Slots in ${title}` })
      .getByRole("listitem");
  }

  /** The way on to the next segment of whatever list the modal was opened from. */
  next(): Locator {
    return this.dialog.getByRole("button", { name: "Next segment" });
  }

  previous(): Locator {
    return this.dialog.getByRole("button", { name: "Previous segment" });
  }

  async close(): Promise<void> {
    await this.dialog.getByRole("button", { name: "Close segment" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

/**
 * The editor behind the modal, which is the only place an activity can be corrected.
 *
 * Reachable through a segment and nowhere else, which is where editing lives — so opening it
 * is two clicks written down once.
 */
export class ActivityEditor {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole("dialog")
      .filter({ has: page.getByRole("button", { name: "Add activity" }) });
  }

  async open(): Promise<void> {
    await new SegmentDetail(this.page).dialog
      .getByRole("button", { name: "Edit activities" }).click();
    await expect(this.dialog).toBeVisible();
  }

  /** Which kind of thing one row says it was, which is the row's own first control. */
  kind(index: number): Locator {
    return this.dialog.getByRole("combobox", { name: "Activity kind" }).nth(index);
  }

  /** One of the fields that kind of activity carries, by the label beside it. */
  field(label: string): Locator {
    return this.dialog.getByLabel(label, { exact: true });
  }

  add(): Promise<void> {
    return this.dialog.getByRole("button", { name: "Add activity" }).click();
  }

  /** Throws one away, named after the kind of thing it is — "Remove Levelling". */
  remove(kind: string): Promise<void> {
    return this.dialog.getByRole("button", { name: `Remove ${kind}` }).click();
  }

  async done(): Promise<void> {
    await this.dialog.getByRole("button", { name: "Done" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

/**
 * A picture of one transmog source, over the segment it was collected in.
 *
 * Its own dialog rather than part of the modal under it, and found by the stage it holds: the
 * segment's modal is open behind it and both are named after whatever they are showing.
 */
export class AppearancePicture {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole("dialog")
      .filter({ has: page.getByRole("figure", { name: "Where the appearance is drawn" }) });
  }

  /** Opens it from the row of a segment's transmog source, which is what the button is for. */
  async open(): Promise<void> {
    await new SegmentDetail(this.page).section("Transmog")
      .getByRole("button", { name: /^Show .* drawn$/ }).click();
    await expect(this.dialog).toBeVisible();
  }

  title(name: string): Locator {
    return this.dialog.getByRole("heading", { name });
  }

  /** The picture itself, which only exists once something has been drawn on it. */
  picture(): Locator {
    return this.dialog.getByRole("img", { name: "The appearance, drawn" });
  }

  /**
   * How much geometry reached the stage.
   *
   * The pixels cannot be read here — a live pane keeps no drawing buffer to read back — so the
   * vertex count the stage writes out is the instrument for "something was actually drawn".
   */
  vertices(): Promise<string | null> {
    return this.stage().getAttribute("data-vertices");
  }

  /**
   * The pane the picture is drawn in, and the picture's own size inside it, in CSS pixels.
   *
   * A reading rather than a pair of locators: what this is for is comparing the two boxes, and
   * the content box on both sides is the honest comparison — the pane draws a border along its
   * bottom edge and the canvas fills what is inside it.
   */
  measure(): Promise<{ pane: number[]; canvas: number[] }> {
    return this.stage().evaluate((pane) => {
      const canvas = pane.querySelector("canvas");
      return {
        pane: [pane.clientWidth, pane.clientHeight],
        canvas: [canvas?.clientWidth ?? 0, canvas?.clientHeight ?? 0],
      };
    });
  }

  /**
   * Where the camera is, relative to the point it is looking at, in the model's own units.
   *
   * A canvas draws the same rectangle whichever way round the thing on it is and however far
   * away it stands, so the readout the stage writes is the only instrument out here that can
   * tell a helm framed on a head from a helm framed as a woman — and, after a drag, a camera
   * that turned from one that went over the top of her.
   */
  async framing(): Promise<{ out: number; above: number }> {
    const stage = this.stage();
    const numbers = async (named: string): Promise<number[]> =>
      ((await stage.getAttribute(`data-${named}`)) ?? "").split(",").map(Number);
    const [camera, target] = [await numbers("camera"), await numbers("target")];
    const off = camera.map((axis, at) => axis - (target[at] ?? 0));
    const out = Math.hypot(...off);
    return { out, above: out === 0 ? 0 : (off[1] ?? 0) / out };
  }

  /**
   * Where the camera is once it has stopped moving, which is not where a drag leaves it.
   *
   * A drag does not end when the mouse does: the controls carry a shrinking fraction of it into
   * every frame after, which is what makes turning a model feel like turning something with
   * weight. The stage says when that remainder is spent, so a starved render loop only makes
   * this wait longer rather than making two accidentally adjacent readings look settled.
   */
  async settled(): Promise<{ out: number; above: number }> {
    await expect(this.stage()).toHaveAttribute("data-camera-state", "settled");
    return this.framing();
  }

  /** Drags across the middle of the picture with the left button, the way a reader turns it. */
  async drag(across: number, down: number): Promise<void> {
    const box = await this.picture().boundingBox();
    if (!box) throw new Error("there is no picture on the stage to drag");
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    // In steps, because a single jump is one pointer event and the controls read movement
    // between them — the same reason a real drag is a hundred of these.
    await this.page.mouse.move(x + across, y + down, { steps: 8 });
    await this.page.mouse.up();
  }

  private stage(): Locator {
    return this.dialog.getByRole("figure", { name: "Where the appearance is drawn" });
  }

  async close(): Promise<void> {
    await this.dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(this.dialog).toBeHidden();
  }
}
