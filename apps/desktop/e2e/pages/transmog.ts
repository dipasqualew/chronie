/**
 * The transmog view: five browsers on the left, and the character on the right.
 *
 * This holds the two halves that never go away — the switch above the browsers, and the
 * character wearing whatever has been clicked out of any of them — the browser of the game's own
 * sets, and the shelf of the ones a reader is a slot short of. The others are `wardrobe.ts` and
 * `ownSets.ts`.
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
   * The switch above the browsers: the game's sets, its whole wardrobe, the reader's own, the
   * ones the player saved in the game itself, or the shelf of sets one slot short of anybody.
   */
  async browseBy(
    what: "Sets" | "Items" | "Yours" | "Personal in-game sets" | "One slot short",
  ): Promise<void> {
    await this.view
      .getByRole("group", { name: "Browse the game by" })
      .getByRole("button", { name: what, exact: true })
      .click();
  }

  /** Whatever the view says about the whole of what it read, above all five browsers. */
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
    this.browser = new TransmogView(page).view.getByRole("region", { name: "The game's sets" });
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
   * The rail of a card: one square per difficulty or colour the game files under the set.
   *
   * Found by the accessible name of the list rather than by the strip it is drawn as, because
   * the squares are the one thing on a card that has no words on it at all — a rail a test
   * cannot ask for by name is a rail a screen reader cannot either.
   */
  variants(set: string): Locator {
    return this.card(set)
      .getByRole("list", { name: `Difficulties and colours of ${set}` })
      .getByRole("button");
  }

  /** Draws a card as one of the members on its rail, the way a reader does: by clicking it. */
  async showVariant(set: string, member: string): Promise<void> {
    await this.card(set)
      .getByRole("button", { name: `Show ${member}`, exact: true })
      .click();
    await expect(this.card(member)).toBeVisible();
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
   * The panel over an opened set's list: how anybody gets the looks that set locks.
   *
   * A table, and named after the set it is about — the one thing on the card that says which
   * slot a class lock actually cost the reader, where the chip above says only that one stands.
   */
  openings(set: string): Locator {
    return this.card(set).getByRole("table", { name: `How anyone gets the looks ${set} locks` });
  }

  /**
   * The rows of it, which are one per locked look and never the head of the table.
   *
   * What tells them apart is the slot: a row carries it as its stub, and the head carries three
   * column titles and no stub at all. A look the set already sells to everybody is not a row
   * here, which is what this count is worth asserting.
   */
  openingRows(set: string): Locator {
    return this.openings(set)
      .getByRole("row")
      .filter({ has: this.page.getByRole("rowheader") });
  }

  /** One of those rows, found by the slot it is named after. */
  openingRow(set: string, slot: string): Locator {
    return this.openings(set)
      .getByRole("row")
      .filter({ has: this.page.getByRole("rowheader", { name: slot, exact: true }) });
  }

  /**
   * The button on a row nothing sells around, which opens the last and least certain tier.
   *
   * Named after the set's own piece rather than the slot, because that is what a reader is
   * standing in front of and what the panel it opens is titled after.
   */
  showAlternatives(set: string, own: string): Locator {
    return this.card(set).getByRole("button", { name: `Show possible alternatives to ${own}` });
  }

  /** And what it opened: everything the two measures could still say about that look. */
  alternatives(set: string, own: string): Locator {
    return this.card(set).getByRole("list", { name: `Possible alternatives to ${own}` });
  }

  /** One of its rows, found by the item it offers. */
  alternative(set: string, own: string, offered: string): Locator {
    return this.alternatives(set, own).getByRole("listitem").filter({ hasText: offered });
  }

  /**
   * Saying what one thinks of a suggestion — the one thing on this panel that outlives a patch.
   *
   * Both stores behind the rows are thrown away and measured off the game again whenever it
   * moves; a person's answer is not, so it is a button rather than a reading.
   */
  ruleOn(set: string, own: string, says: string, offered: string): Locator {
    return this.alternatives(set, own).getByRole("button", { name: `${says}: ${offered}` });
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
    return this.bodies().evaluateAll(
      (canvases) =>
        canvases.filter((canvas) => {
          const picture = (canvas as HTMLCanvasElement).getContext("2d");
          if (!picture) return false;
          const { width, height } = canvas as HTMLCanvasElement;
          if (!width || !height) return false;
          const { data } = picture.getImageData(0, 0, width, height);
          for (let at = 3; at < data.length; at += 4) if (data[at] !== 0) return true;
          return false;
        }).length,
    );
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
    return this.card(set)
      .getByRole("button", { name: `Wear ${slot}: ${label}` })
      .nth(nth);
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
    return this.card(set).getByRole("button", { name: `Filter by the tag ${label}`, exact: true });
  }

  /** Throws a tag away again, from the chip it is written on. */
  dropTag(set: string, label: string): Locator {
    return this.card(set).getByRole("button", {
      name: `Remove the tag ${label} from ${set}`,
      exact: true,
    });
  }

  /**
   * One row of an open set, found by the look it is for.
   *
   * By the star's own accessible name rather than by the row's text, because two rows can
   * carry names one contains the other of and only the control is named exactly.
   */
  row(set: string, label: string): Locator {
    return this.rows(set).filter({
      has: this.page.getByRole("button", { name: `Favourite ${label}`, exact: true }),
    });
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
      [...chip.querySelectorAll("rect")].map((square) => square.getAttribute("fill") ?? ""),
    );
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

  /** The whole of what the grid is narrowed by. There were two selects beside it; there are not. */
  search(): Locator {
    return this.browser.getByLabel("Filter transmog sets");
  }

  /**
   * A fact printed on a card, which narrows the grid to what it says when clicked.
   *
   * This is what the expansion and class dropdowns became — see `Fact` in `transmogView.tsx`.
   * Named by what clicking it would ask for rather than by what it prints, which is also how
   * the measured colour beside it is named.
   */
  fact(set: string, asks: string): Locator {
    return this.card(set).getByRole("button", { name: `Filter by ${asks}` });
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
 * The fifth browser: the sets a reader can almost have — see `shelf.ts`.
 *
 * Drawn as the same cards the grid is, so a set is a level-4 heading here too and everything
 * about one is found inside its own card. What is only here is the obstacle: which slot stops
 * the set, and whether that slot is one the game's own geometry can answer exactly.
 */
export class Shelf {
  readonly page: Page;
  readonly browser: Locator;

  constructor(page: Page) {
    this.page = page;
    this.browser = new TransmogView(page).view.getByRole("region", {
      name: "Sets one slot short of anybody",
    });
  }

  /** The sets on the shelf, in the order it puts them. */
  sets(): Locator {
    return this.browser.getByRole("heading", { level: 4 });
  }

  /** The card one is drawn on, found by its own heading. */
  card(name: string): Locator {
    return this.browser
      .getByRole("article")
      .filter({ has: this.page.getByRole("heading", { name, exact: true }) });
  }

  /** Whatever the shelf says about itself, above the list. */
  saying(text: string | RegExp): Locator {
    return this.browser.getByText(text);
  }

  /** And whatever one of its cards says, found by the words on it. */
  cardSaying(set: string, text: string | RegExp): Locator {
    return this.card(set).getByText(text);
  }

  /** The one box above the list, which narrows it by name, class or slot. */
  search(): Locator {
    return this.browser.getByRole("searchbox", { name: "Filter the sets one slot short" });
  }

  /**
   * The chip naming a slot in the way, which is the one thing on a card only this browser draws.
   *
   * By its title rather than by the word on it, because the word is on the card twice — the chip
   * and the sentence under it both say "Feet" — and the chip is the half that carries whether the
   * geometry can answer for the slot.
   */
  blocked(set: string, slot: string): Locator {
    return this.card(set).getByTitle(
      `${slot} is one of the slots nothing in the game sells around`,
    );
  }

  /** Opens one in place, which reads the set and draws its own openings panel under it. */
  async openSet(name: string): Promise<Locator> {
    await this.browser.getByRole("button", { name, exact: true }).click();
    const card = this.card(name);
    await expect(
      card.getByRole("table", { name: `How anyone gets the looks ${name} locks` }),
    ).toBeVisible();
    return card;
  }

  /** The button on the row nothing sells around, which is what this shelf is a road to. */
  showAlternatives(set: string, own: string): Locator {
    return this.card(set).getByRole("button", { name: `Show possible alternatives to ${own}` });
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
    return this.panel.getByRole("button", { name: /^Take off / }).evaluateAll((tiles) =>
      tiles.map((tile) => {
        const tip = document.createElement("div");
        tip.innerHTML = (tile as HTMLElement).dataset.tip ?? "";
        return [...tip.children].map((part) => part.textContent).join(" · ");
      }),
    );
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
   * with weight. The stage says when that remainder is spent, so a starved render loop only
   * makes this wait longer rather than making two accidentally adjacent readings look settled.
   */
  async settled(): Promise<string> {
    await expect(this.stage()).toHaveAttribute("data-camera-state", "settled");
    return (await this.drew("camera")) ?? "";
  }

  /**
   * How far the camera has moved from a reading taken earlier, in the model's own units.
   *
   * Distance rather than string equality, because what the comparisons using this rule out is
   * a camera that was *framed* again, and a framing moves it the better part of thirty units.
   */
  async movedFrom(camera: string): Promise<number> {
    const numbers = (reading: string): number[] => reading.split(",").map(Number);
    const [now, before] = [numbers((await this.drew("camera")) ?? ""), numbers(camera)];
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
      new MutationObserver(() => seen.push(pane.dataset.state ?? "")).observe(pane, {
        attributes: true,
        attributeFilter: ["data-state"],
      });
    });
  }

  /** Every state the pane has been in since [`watchPane`], oldest first. */
  paneStates(): Promise<string[]> {
    return this.page.evaluate(
      () => (window as unknown as { paneStates?: string[] }).paneStates ?? [],
    );
  }
}
