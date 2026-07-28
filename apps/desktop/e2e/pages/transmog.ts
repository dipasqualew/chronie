/**
 * The transmog view: four browsers on the left, and the character on the right.
 *
 * This holds the two halves that never go away — the switch above the browsers, and the
 * character wearing whatever has been clicked out of any of them — and the browser of the
 * game's own sets. The other three are `wardrobe.ts` and `ownSets.ts`.
 *
 * A collection is a level-3 heading and a set a level-4 one, so the whole grid is reachable by
 * heading the way a screen reader walks it. A set opens in place — there is no dialog — so
 * everything inside one is found within its own card.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { Shell } from "./shell";

/** How long a page of characters is allowed to take, from the switch to the last picture. */
export const PATIENCE_MS = 30_000;

export class TransmogView {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = new Shell(page).view("Transmog");
  }

  /** The tab loads the game's tables the first time it is opened, and not before. */
  async open(): Promise<void> {
    await new Shell(this.page).open("Transmog");
    await expect(this.view.getByRole("heading", { name: "Transmog", level: 1 })).toBeVisible();
  }

  /**
   * The switch above the browsers: the game's sets, its whole wardrobe, the reader's own, or
   * the ones the player saved in the game itself.
   */
  async browseBy(what: "Sets" | "Items" | "Yours" | "Personal in-game sets"): Promise<void> {
    await this.view.getByRole("group", { name: "Browse the game by" })
      .getByRole("button", { name: what, exact: true }).click();
  }

  /** Whatever the view says about the whole of what it read, above all four browsers. */
  saying(text: string | RegExp): Locator {
    return this.view.getByText(text);
  }
}

/**
 * The first browser: every set the installed game holds, grouped by collection.
 */
export class SetGrid {
  readonly page: Page;
  readonly browser: Locator;

  constructor(page: Page) {
    this.page = page;
    this.browser = new TransmogView(page).view
      .getByRole("region", { name: "The game's sets" });
  }

  /** The collection headings, which are the browser's own — the panels beside it have them too. */
  collections(): Locator {
    return this.browser.getByRole("heading", { level: 3 });
  }

  sets(): Locator {
    return this.browser.getByRole("heading", { level: 4 });
  }

  /** The card a set is shown on, found by the set's own heading. */
  card(name: string): Locator {
    return this.browser
      .getByRole("article")
      .filter({ has: this.page.getByRole("heading", { name, exact: true }) });
  }

  /** Whatever a card says about itself, found by the words on it. */
  cardSaying(set: string, text: string | RegExp): Locator {
    return this.card(set).getByText(text);
  }

  /** And whatever the browser says about the grid as a whole. */
  saying(text: string | RegExp): Locator {
    return this.browser.getByText(text);
  }

  /** Opens a set in place, the way a reader does: by clicking its name. */
  async openSet(name: string): Promise<Locator> {
    await this.browser.getByRole("button", { name, exact: true }).click();
    const card = this.card(name);
    await expect(this.rows(name).first()).toBeVisible();
    return card;
  }

  async closeSet(name: string): Promise<void> {
    await this.browser.getByRole("button", { name, exact: true }).click();
    await expect(this.rows(name)).toHaveCount(0);
  }

  /**
   * One row per appearance a set names, in the order the backend sorted them.
   *
   * The rows of the outer list only. A row that several items reach carries a list of its own,
   * and those are list items too — so "every list item in the card" would count the items a
   * reader expanded as though they were looks, which is the very thing this view stopped
   * doing. What tells them apart is that a look is something to put on and an item is not.
   */
  rows(set: string): Locator {
    return this.card(set)
      .getByRole("list", { name: `Appearances in ${set}` })
      .getByRole("listitem")
      .filter({ has: this.page.getByRole("button", { name: /^Wear / }) });
  }

  /**
   * The count on a row that opens the items giving that look, named by what it says.
   *
   * By role and text rather than by class: it is a real button with a real label, and a
   * reader deciding whether to open it reads that label.
   */
  sourcesToggle(set: string, others: number): Locator {
    return this.card(set).getByRole("button", {
      name: `+${others} ${others === 1 ? "item" : "items"}`,
      exact: true,
    });
  }

  /** The items behind one look, once its count has been clicked. */
  sources(set: string, label: string): Locator {
    return this.card(set)
      .getByRole("list", { name: `Items that give ${label}` })
      .getByRole("listitem");
  }

  /**
   * The way through to the item an appearance came from, which is the corner of its row.
   *
   * Named in full rather than by the item alone: the link is a drawn glyph with no text of
   * its own, so "Tideglass Mantle on Wowhead" is the whole of what a screen reader announces
   * and matching less of it would also match the row's own button.
   */
  link(set: string, label: string): Locator {
    return this.card(set).getByRole("link", { name: `${label} on Wowhead`, exact: true });
  }

  /**
   * The item's own name on a row, which is the largest thing on it and what a reader aims at.
   *
   * Inside the row's own button, because the point of asking for it separately is that a
   * reader clicking the words gets the piece put on — the whole row is one button.
   */
  name(set: string, slot: string, label: string): Locator {
    return this.wear(set, slot, label).getByText(label, { exact: true });
  }

  /** The one box above the grid: whether the rows with nowhere to go are left out. */
  hideUnwearable(): Locator {
    return this.browser.getByRole("checkbox", { name: "Hide what she cannot wear" });
  }

  /** The other one: whether each card is drawn as the character wearing that set. */
  asModels(): Locator {
    return this.browser.getByRole("checkbox", { name: "Show each set worn" });
  }

  /** How much of the grid is shown, and how much of it a filter left. */
  count(): Locator {
    return this.browser.getByRole("status", { name: "How much of the grid is shown" });
  }

  /**
   * The pictures themselves, one per card, once the sets are drawn worn.
   *
   * Each canvas is named after the set it is of, which is more than the wardrobe's tiles can
   * say for themselves: a card in this grid is a named thing where a row of the wardrobe is a
   * look.
   */
  bodies(): Locator {
    return this.browser.getByRole("img", { name: /, drawn$/ });
  }

  /** The picture on one card, by the set it is of. */
  body(name: string): Locator {
    return this.card(name).getByRole("img", { name: `${name}, drawn` });
  }

  /**
   * How many of those actually have a character on them.
   *
   * Counted from the pixels rather than from the elements, for the reason `Wardrobe.painted`
   * gives: a canvas that was never drawn on is the same rectangle in the DOM as one that was,
   * and a window handing out a graphics context per card fails silently.
   */
  async painted(): Promise<number> {
    return this.bodies().evaluateAll((canvases) => canvases.filter((canvas) => {
      const picture = (canvas as HTMLCanvasElement).getContext("2d");
      if (!picture) return false;
      const { width, height } = canvas as HTMLCanvasElement;
      if (!width || !height) return false;
      const { data } = picture.getImageData(0, 0, width, height);
      for (let at = 3; at < data.length; at += 4) if (data[at] !== 0) return true;
      return false;
    }).length);
  }

  /**
   * The frame every row keeps for its picture, whether or not one has arrived in it.
   *
   * The frame says what it is a frame for and the picture inside it says nothing at all: the
   * whole row is one button and already carries the slot and the item in its own name, so a
   * picture that announced itself as well would have a screen reader read every row twice.
   */
  iconFrames(set: string): Locator {
    return this.card(set).getByRole("img", { name: /^Icon for / });
  }

  /** And the pictures that have arrived in them, by their alternative text being empty. */
  icons(set: string): Locator {
    return this.card(set).getByAltText("", { exact: true });
  }

  /**
   * The button on one row, which puts that piece on the character or takes it off again.
   *
   * `nth` because two rows of one set can carry the same slot and the same name — two looks
   * an install cannot tell apart by their labels alone — and picking either is picking what
   * that row is for.
   */
  wear(set: string, slot: string, label: string, nth = 0): Locator {
    return this.card(set).getByRole("button", { name: `Wear ${slot}: ${label}` }).nth(nth);
  }

  /** The whole set at once, which is how a player looks at one. */
  wearAll(set: string): Locator {
    return this.card(set).getByRole("button", { name: `Wear all of ${set}` });
  }

  /**
   * The star on the card itself, which is against the *set*.
   *
   * Named after the set, where a row's star is named after the look on it — so this reaches
   * the card's own control and never one belonging to something inside it.
   */
  star(set: string): Locator {
    return this.card(set).getByRole("button", { name: `Favourite ${set}`, exact: true });
  }

  /**
   * What the reader has said about the set, as the chips read.
   *
   * The card's own, and only the card's: a chip on a card narrows the grid and so is a button,
   * where a chip on a look inside an opened set is a word and nothing else.
   */
  tags(set: string): Locator {
    return this.card(set).getByRole("button", { name: /^Filter by the tag / });
  }

  /** One of those chips, named by what clicking it would ask the grid for. */
  askByTag(set: string, label: string): Locator {
    return this.card(set)
      .getByRole("button", { name: `Filter by the tag ${label}`, exact: true });
  }

  /** Throws a tag away again, from the chip it is written on. */
  dropTag(set: string, label: string): Locator {
    return this.card(set)
      .getByRole("button", { name: `Remove the tag ${label} from ${set}`, exact: true });
  }

  /**
   * One row of an open set, found by the look it is for.
   *
   * By the star's own accessible name rather than by the row's text, because two rows can
   * carry names one contains the other of and only the control is named exactly.
   */
  row(set: string, label: string): Locator {
    return this.rows(set)
      .filter({ has: this.page.getByRole("button", { name: `Favourite ${label}`, exact: true }) });
  }

  /** The star on one of those rows, which is against the *look* and not against the set. */
  rowStar(set: string, label: string): Locator {
    return this.row(set, label).getByRole("button", { name: `Favourite ${label}`, exact: true });
  }

  /**
   * What the committed store measured a set's artwork to be, which nobody typed.
   *
   * Found by the sentence it carries, because that sentence is the whole point of the chip:
   * it says where the claim came from, and it is what tells this apart from the reader's own
   * chips beside it.
   */
  measured(set: string): Locator {
    return this.card(set).getByTitle(/nobody typed it/);
  }

  /**
   * The colours those swatches were actually painted, read off the picture.
   *
   * A reading rather than a locator, and it has to be: the swatches are `aria-hidden`, because
   * the chip's own tooltip already names every colour in it and a screen reader meeting two
   * unlabelled graphics would be told "image, image" and nothing else. What this rules out is
   * a swatch the page never painted — the colour is data rather than a class, so it is an SVG
   * `fill`, which is the one way to paint an arbitrary colour that the packaged app's Content
   * Security Policy allows.
   */
  swatchColours(set: string): Promise<string[]> {
    return this.measured(set).evaluate((chip) =>
      [...chip.querySelectorAll("rect")].map((square) => square.getAttribute("fill") ?? ""));
  }

  /** Whether the grid is narrowed to the starred sets. */
  favouritesOnly(): Locator {
    return this.browser.getByRole("checkbox", { name: "Favourites only" });
  }

  /**
   * The picker of tags in use, which is absent entirely until one is.
   *
   * Exactly "Tag", because every "+ tag" button on the grid is labelled "Tag <something>"
   * and a loose match would find whichever of them Playwright reached first.
   */
  tagFilter(): Locator {
    return this.browser.getByLabel("Tag", { exact: true });
  }

  search(): Locator {
    return this.browser.getByLabel("Filter transmog sets");
  }

  expansion(): Locator {
    return this.browser.getByLabel("Expansion");
  }

  klass(): Locator {
    return this.browser.getByLabel("Class");
  }

  /** How far down the grid the reader has got, which the character has to survive. */
  scrollOffset(): Promise<number> {
    return this.page.evaluate(() => window.scrollY);
  }

  scrollToEnd(): Promise<void> {
    return this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  }
}

/**
 * The character, and the rail of what she has on — the half of the view that never goes away.
 *
 * Every piece is a picture over her, and the picture is the button that takes it off again.
 * What it is, where it is and which set it came out of are on its tip, which is what [`worn`]
 * reads. Nothing here needs a set to be open, which is the point.
 */
export class Outfit {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("complementary", { name: "The character" });
  }

  /** One tile per place on the body that has something in it, head downwards. */
  slots(): Locator {
    return this.panel.getByRole("list", { name: "What she has on" }).getByRole("listitem");
  }

  /** How much is on, as the line under the character reads it. */
  summary(): Locator {
    return this.panel.getByRole("status", { name: "How much is on" });
  }

  /** Whatever the pane says about what it is showing, which is a live region too. */
  note(): Locator {
    return this.panel.getByRole("status", { name: "What the stage is showing" });
  }

  /**
   * What she has on, as each tile's tip reads it: the item, its place, and the set it came
   * out of — the last of the three absent for a look that came out of none.
   *
   * The rail is pictures, so this is where the names are. Read through `expect.poll`, because
   * a piece going on is a round trip through the backend and the tips arrive with it.
   */
  worn(): Promise<string[]> {
    return this.panel.getByRole("button", { name: /^Take off / })
      .evaluateAll((tiles) => tiles.map((tile) => {
        const tip = document.createElement("div");
        tip.innerHTML = (tile as HTMLElement).dataset.tip ?? "";
        return [...tip.children].map((part) => part.textContent).join(" · ");
      }));
  }

  takeOff(label: string): Promise<void> {
    return this.panel.getByRole("button", { name: `Take off ${label}` }).click();
  }

  clear(): Promise<void> {
    return this.panel.getByRole("button", { name: "Take it all off" }).click();
  }

  /** The box that turns what she has on into a set of the reader's own. */
  name(): Locator {
    return this.panel.getByLabel("Name for this set");
  }

  /**
   * The button beside it, which says which of the two things it is about to do.
   *
   * Matched loosely on purpose: "Save as a set" and "Replace Horde look" are the same control
   * and a test that had to know which is showing could not ask what it says.
   */
  keep(): Locator {
    return this.panel.getByRole("button", { name: /^(Save as a set|Replace )/ });
  }

  /** Saves what she has on under a name, the way a reader does. */
  async saveAs(name: string): Promise<void> {
    await this.name().fill(name);
    await this.keep().click();
  }

  /**
   * Sends what she has on to the game under a name.
   *
   * The only thing this app ever writes into a WoW account, and it is two steps: the request
   * is recorded here and the addon carries it out the next time that account is logged in.
   */
  async sendAs(name: string): Promise<void> {
    await this.name().fill(name);
    await this.panel.getByRole("button", { name: "Send to the game" }).click();
  }

  /** The pane the body is drawn on, which says how much geometry it ended up holding. */
  stage(): Locator {
    return this.panel.getByRole("figure", { name: "Where she is drawn" });
  }

  /** The picture of her, which only exists once a body has reached the stage. */
  canvas(): Locator {
    return this.panel.getByRole("img", { name: "The character, drawn" });
  }

  /**
   * Where the camera is and what it is pointed at, as the stage writes them down.
   *
   * A canvas draws the same rectangle whichever way round the model on it is, so this is the
   * only thing outside a pair of eyes that can tell a model that moved from one that did not.
   */
  async framing(): Promise<{ camera: string; target: string }> {
    const stage = this.stage();
    return {
      camera: (await stage.getAttribute("data-camera")) ?? "",
      target: (await stage.getAttribute("data-target")) ?? "",
    };
  }

  /** One of the things the stage counts of what it drew: vertices, pictures, blanks. */
  drew(what: "vertices" | "pictures" | "blank" | "camera" | "target"): Promise<string | null> {
    return this.stage().getAttribute(`data-${what}`);
  }

  /**
   * Where the camera is once it has stopped moving, which is not where a drag leaves it.
   *
   * A drag does not end when the mouse does: the controls carry a shrinking fraction of it
   * into every frame after, which is what makes turning a model feel like turning something
   * with weight. So a reading taken straight after one is of something still in flight, and
   * two such readings are never the same number twice. This waits for two that are.
   *
   * Two that are is not the end of the remainder, only the end of what three decimals can
   * see: the controls stop reporting movement while a thousandth of the drag is still owed,
   * and go on spending it after that. [`movedFrom`] is how a later reading is compared to
   * this one for that reason.
   */
  async settled(): Promise<string> {
    let last = "";
    await expect
      .poll(async () => {
        const now = await this.drew("camera") ?? "";
        const still = now !== "" && now === last;
        last = now;
        return still;
      }, { timeout: 15_000 })
      .toBe(true);
    return last;
  }

  /**
   * How far the camera has moved from a reading taken earlier, in the model's own units.
   *
   * Distance rather than string equality, because the last digit of the readout belongs to
   * the drag's remainder rather than to anything the app decided — see [`settled`]. What the
   * comparisons using this rule out is a camera that was *framed* again, and a framing moves
   * it the better part of thirty units.
   */
  async movedFrom(camera: string): Promise<number> {
    const numbers = (reading: string): number[] => reading.split(",").map(Number);
    const [now, before] = [numbers(await this.drew("camera") ?? ""), numbers(camera)];
    return Math.hypot(...now.map((axis, at) => axis - (before[at] ?? 0)));
  }

  /** Drags across the middle of the canvas with one button held, the way a reader does. */
  async drag(button: "left" | "right", across: number, down: number): Promise<void> {
    const box = await this.canvas().boundingBox();
    if (!box) throw new Error("there is no canvas on the stage to drag");
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await this.page.mouse.move(x, y);
    await this.page.mouse.down({ button });
    // In steps, because a single jump is one pointer event and the controls read movement
    // between them — the same reason a real drag is a hundred of these.
    await this.page.mouse.move(x + across, y + down, { steps: 8 });
    await this.page.mouse.up({ button });
  }

  resetCamera(): Promise<void> {
    return this.panel.getByRole("button", { name: "Reset camera" }).click();
  }

  /** Opens the form under her that says who she is, which reads nothing until it is opened. */
  askWhoSheIs(): Promise<void> {
    return this.panel.getByText("Who she is").click();
  }

  /** One question the game asks about her body, by the name the game gives it. */
  about(question: string): Locator {
    return this.panel.getByLabel(question);
  }

  /** The answers offered to one of those questions, in the order the game lists them. */
  swatches(question: string): Locator {
    return this.about(question).getByRole("option");
  }

  /**
   * Starts writing down every state the pane passes through, and hands back what it has so far.
   *
   * The one thing about a redraw that cannot be caught by looking afterwards. A body arriving
   * is a fraction of a second, so "the picture stayed up while the next one was read" is a
   * claim about states nothing polling would ever be standing in front of — and the failure it
   * rules out is exactly one of those: a pane that goes blank for that fraction and comes back
   * with the new body is indistinguishable, once it has come back, from one that never went.
   *
   * So the states are recorded as they happen and read at leisure. The stylesheet hides the
   * stage for `loading` and `empty`, so either of those appearing in the record of a redraw is
   * the white flash, whatever the pane looks like by the time anybody asks.
   */
  async watchPane(): Promise<void> {
    await this.panel.getByRole("group", { name: "The stage" }).evaluate((pane) => {
      const seen: string[] = [pane.dataset.state ?? ""];
      (window as unknown as { paneStates: string[] }).paneStates = seen;
      new MutationObserver(() => seen.push(pane.dataset.state ?? ""))
        .observe(pane, { attributes: true, attributeFilter: ["data-state"] });
    });
  }

  /** Every state the pane has been in since [`watchPane`], oldest first. */
  paneStates(): Promise<string[]> {
    return this.page.evaluate(() =>
      (window as unknown as { paneStates?: string[] }).paneStates ?? []);
  }
}
