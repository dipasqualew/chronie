/**
 * One segment in full: the frame every view opens it in, the editor behind it, and the picture
 * one of its rows opens into.
 *
 * There are two frames and this page object addresses both, because every question below is
 * about the segment rather than about what is holding it. The timeline docks a segment in the
 * panel beside its spine; the roster and the table open one as a modal over themselves. So the
 * frame is found by the one control that only an opened segment has — the way out of it — and
 * not by being a dialog, which only one of the two is.
 *
 * Its sections are landmarks named after their headings, so "the achievements" and "the
 * equipment sets" are things to ask for rather than places to count to.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { eventually } from "./eventually";
import type { Eventually } from "./eventually";

export class SegmentDetail {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page
      .getByRole("dialog")
      .or(page.getByRole("complementary"))
      .filter({ has: page.getByRole("button", { name: "Close segment" }) });
  }

  /** Opens a segment from a row for a given character and location, wherever the row is. */
  async openFor(character: string, instance: string): Promise<void> {
    await this.page
      .getByRole("button", { name: new RegExp(`Open segment: ${character} in ${instance}`) })
      .click();
    await expect(this.panel).toBeVisible();
  }

  title(): Locator {
    return this.panel.getByRole("heading", { level: 2 });
  }

  /**
   * Whether the segment is standing clear to the right of something rather than over it.
   *
   * The whole of what issue #239 asked for, and only the browser can answer it: "beside" is a
   * fact about two boxes, and a modal that covered the timeline would say every word this one
   * says. Read against the timeline's own spine, because that is what may not be hidden.
   */
  async standsRightOf(other: Locator): Promise<boolean> {
    const [mine, theirs] = [await this.panel.boundingBox(), await other.boundingBox()];
    if (!mine || !theirs) return false;
    return mine.x >= theirs.x + theirs.width;
  }

  /**
   * Turns the wheel with the pointer over the head of the frame.
   *
   * The head and not the middle of it, because that is the half of issue #241 nothing smaller
   * could catch: the frame used to scroll its body only, so the picture and the name at the top
   * of it were dead to the wheel and the page underneath took the gesture instead. Driven from
   * the mouse rather than from a locator for the same reason — which element is under the
   * pointer is the whole question, and `Locator.scroll` would answer it by fiat.
   */
  async wheelOverHead(by: number): Promise<void> {
    const box = await this.title().boundingBox();
    if (!box) throw new Error("there is no segment open to turn the wheel over");
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.mouse.wheel(0, by);
  }

  /** How far down the segment the reader has got, in pixels of the frame's own scrolling. */
  scrolledBy(): Eventually<number> {
    return eventually(() => this.panel.evaluate((frame) => frame.scrollTop));
  }

  /**
   * How far below the top of the frame the title bar is sitting, in pixels.
   *
   * What says the head is pinned there rather than scrolling away with the picture above it: it
   * starts a picture's height down and ends up against the top edge, and the way out of the
   * segment goes with it. Only the browser lays any of that out.
   */
  headBelowTop(): Eventually<number> {
    return eventually(async () => {
      const [head, frame] = [await this.title().boundingBox(), await this.panel.boundingBox()];
      return head && frame ? head.y - frame.y : Number.NaN;
    });
  }

  /**
   * The picture a segment opens with, found by the place it is of.
   *
   * Every place has one — the banner the game paints, or the map it draws, or the backend's own
   * stand-in for the few with neither — so unlike the icons further down this is a thing to
   * assert the presence of rather than the absence.
   */
  hero(place: string): Locator {
    return this.panel.getByRole("img", { name: `Picture of ${place}` });
  }

  /**
   * How much of the frame's width that picture covers, as a fraction of it.
   *
   * A reading rather than a locator, because the claim is about two boxes rather than about
   * anything either one of them says: the band is the frame's *header*, and a header that stops
   * short of the edge it is a header of is the thing to catch. Measured against the frame's
   * content box, which is the box the band is laid out inside.
   */
  async heroSpan(place: string): Promise<number> {
    const band = await this.hero(place).boundingBox();
    if (!band) return 0;
    const across = await this.panel.evaluate((frame) => frame.clientWidth);
    return across === 0 ? 0 : band.width / across;
  }

  /**
   * How much of that picture is on screen, as a fraction of the whole of it.
   *
   * The other half of the same claim and the one that needs the picture's own size, so it is a
   * reading rather than anything a locator could express: the band draws the picture at the width
   * it has, and what says nothing was cropped is that the height it took is the height the whole
   * picture wants at that width. Compared against the band as well as against the picture, because
   * a band that clipped what it was given would leave the picture measuring its full height and
   * showing less of it.
   */
  heroShown(place: string): Promise<number> {
    return this.hero(place).evaluate((band) => {
      const picture = band.querySelector("img");
      if (!picture?.naturalWidth || !picture.naturalHeight) return 0;
      const drawn = picture.getBoundingClientRect();
      const whole = (drawn.width * picture.naturalHeight) / picture.naturalWidth;
      return whole === 0 ? 0 : Math.min(band.clientHeight, drawn.height) / whole;
    });
  }

  /**
   * What the frame around each boss portrait is filled with.
   *
   * Read off the frame rather than asked for by name, because the frame says nothing to a screen
   * reader and should not — the row names the boss beside it. So it is reached through the
   * picture it holds, which is found by its own empty alternative text. Only the browser can
   * answer this: a frame that draws no box of its own is invisible from the markup.
   */
  portraitFills(): Promise<string[]> {
    return this.iconsIn("Encounters").evaluateAll((pictures) =>
      pictures.map((picture) =>
        picture.parentElement ? getComputedStyle(picture.parentElement).backgroundColor : "",
      ),
    );
  }

  /**
   * Clicks the backdrop, which is the page behind the modal and not an element of its own.
   *
   * The top-left corner of the window: the modal is centred and no part of it reaches there, and
   * a click that lands on the backdrop is delivered to the dialog. Driven from the mouse rather
   * than from a locator because there is nothing to locate — the backdrop belongs to no element,
   * which is the whole reason closing on it has to be written by hand.
   */
  async clickAway(): Promise<void> {
    await this.page.mouse.click(4, 4);
    await expect(this.panel).toBeHidden();
  }

  /** Where in the list the reader is, announced as they step through it. */
  position(): Locator {
    return this.panel.getByRole("status", { name: "Which segment" });
  }

  /**
   * One section of the segment, by the heading it is filed under.
   *
   * An opened segment is a dozen lists of unrelated things — achievements, transmog, currency,
   * the equipment sets — and every question about one of them is a question about its section.
   */
  section(title: string): Locator {
    return this.panel.getByRole("region", { name: title, exact: true });
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

  /**
   * The picture a faction borrows from its own Exalted achievement, on the line it was earned on.
   *
   * Found by the faction it is of, because that is the only thing the frame says: the line names
   * the faction beside it, so a picture that announced itself as well would have a screen reader
   * read every reputation twice. Where the game has nothing to borrow — every renown faction, which
   * is most of a modern history — there is no frame at all, and asking for one is how a spec says
   * so.
   */
  factionIcon(faction: string): Locator {
    return this.panel.getByRole("img", { name: `Icon for ${faction}` });
  }

  /** A link out of the window, named by the text it shows. */
  linkTo(name: string): Locator {
    return this.panel.getByRole("link", { name });
  }

  /**
   * The line one gain is written on, found by the thing it is a gain of.
   *
   * Every section of the modal lists its events, so a gain is a list item wherever it lives,
   * and the name on it is the only thing a reader would use to find it.
   */
  gainFor(name: string): Locator {
    return this.panel.getByRole("listitem").filter({ hasText: name });
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
      ? this.panel.getByRole("progressbar")
      : this.panel.getByRole("progressbar", { name });
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

  /** The way on to the next segment of whatever list this one was opened from. */
  next(): Locator {
    return this.panel.getByRole("button", { name: "Next segment" });
  }

  previous(): Locator {
    return this.panel.getByRole("button", { name: "Previous segment" });
  }

  /**
   * The same walk done from the keyboard, which is what a reader reaches for once they realise
   * the frame walks a list at all.
   *
   * Pressed at the window rather than at a locator on purpose: the whole question is whether the
   * frame still hears the key wherever the focus happens to have ended up.
   */
  arrow(towards: "Left" | "Right"): Promise<void> {
    return this.page.keyboard.press(`Arrow${towards}`);
  }

  async close(): Promise<void> {
    await this.panel.getByRole("button", { name: "Close segment" }).click();
    await expect(this.panel).toBeHidden();
  }
}

/**
 * The editor behind an opened segment, which is the only place an activity can be corrected.
 *
 * Reachable through a segment and nowhere else, which is where editing lives — so opening it
 * is two clicks written down once. A dialog whichever frame it was reached from: correcting
 * what Chronie guessed is a question waiting to be answered, and nothing else may be done
 * until it is.
 */
export class ActivityEditor {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("button", { name: "Add activity" }) });
  }

  async open(): Promise<void> {
    await new SegmentDetail(this.page).panel
      .getByRole("button", { name: "Edit activities" })
      .click();
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
 * Its own dialog rather than part of the segment under it, and found by the stage it holds: the
 * segment is still open behind it and both are named after whatever they are showing.
 */
export class AppearancePicture {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("figure", { name: "Where the appearance is drawn" }) });
  }

  /** Opens it from the row of a segment's transmog source, which is what the button is for. */
  async open(): Promise<void> {
    await new SegmentDetail(this.page)
      .section("Transmog")
      .getByRole("button", { name: /^Show .* drawn$/ })
      .click();
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
