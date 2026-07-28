import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RECIPES } from "../src/query";
import type { E2EMock } from "../src/types";

/**
 * A query as the mock's table of answers is keyed — whitespace collapsed, so a statement laid
 * out over six lines in the recipe is the same key as the one the page sends back.
 */
const collapsed = (sql: string): string => sql.trim().replace(/\s+/g, " ");

/**
 * The window addressed the way a user addresses it: by the names and roles on screen.
 * Nothing here knows a CSS class beyond the containers it scopes a search to, so a restyle
 * cannot break the test and a change that makes something unreachable by keyboard or screen
 * reader will.
 */
class SegmentDetail {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.locator("#segment-detail");
  }

  /** Opens the modal from the timeline row for a given character and location. */
  async openFromTimeline(character: string, instance: string): Promise<void> {
    await this.page.getByRole("button", { name: new RegExp(`Open segment: ${character} in ${instance}`) }).click();
    await expect(this.dialog).toBeVisible();
  }

  title(): Locator {
    return this.dialog.getByRole("heading", { level: 2 });
  }

  position(): Locator {
    return this.dialog.locator(".detail-position");
  }

  /** A link out of the window, named by the text it shows. */
  linkTo(name: string): Locator {
    return this.dialog.getByRole("link", { name });
  }

  /** One row per achievement the segment recorded, in the order they were earned. */
  achievements(): Locator {
    return this.dialog.locator(".earned-item");
  }

  /**
   * The pictures that have arrived in those rows.
   *
   * Not an accessibility locator, and deliberately: the row names the achievement beside the
   * picture, so the picture carries no alternative text and is not in the accessibility tree
   * at all. Giving it one to make it selectable would have a screen reader read every row
   * twice.
   */
  achievementIcons(): Locator {
    return this.dialog.locator(".earned-icon img");
  }

  /** One row per transmog source the segment recorded. */
  transmogs(): Locator {
    return this.dialog.locator(".items li");
  }

  /**
   * The pictures that have arrived in the item rows, wherever in the modal they are.
   *
   * Not an accessibility locator, for the same reason the achievements' are not: the row
   * names the item beside the picture, so the picture carries no alternative text.
   */
  itemIcons(): Locator {
    return this.dialog.locator(".item-icon img");
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
   * divs: a bar with a name, a value and a length is something the accessibility tree
   * already carries, so the test can read exactly what a reader is told.
   */
  standingBars(name?: string | RegExp): Locator {
    return name === undefined
      ? this.dialog.getByRole("progressbar")
      : this.dialog.getByRole("progressbar", { name });
  }

  next(): Promise<void> {
    return this.dialog.getByRole("button", { name: "Next segment" }).click();
  }

  previous(): Promise<void> {
    return this.dialog.getByRole("button", { name: "Previous segment" }).click();
  }

  async close(): Promise<void> {
    await this.dialog.getByRole("button", { name: "Close segment" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

class ActivityEditor {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.locator("#activity-editor");
  }

  /** The editor is only reachable through a segment's detail, which is where editing lives. */
  async open(): Promise<void> {
    await this.page.locator("#segment-detail").getByRole("button", { name: "Edit activities" }).click();
    await expect(this.dialog).toBeVisible();
  }

  row(index: number): Locator {
    return this.dialog.getByRole("combobox", { name: "Activity kind" }).nth(index);
  }

  field(label: string): Locator {
    return this.dialog.getByLabel(label, { exact: true });
  }

  add(): Promise<void> {
    return this.dialog.getByRole("button", { name: "Add activity" }).click();
  }

  async done(): Promise<void> {
    await this.dialog.getByRole("button", { name: "Done" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

/**
 * The details view: the ledger, where every segment is a row and nothing is summarised away.
 *
 * A table is a structure the accessibility tree already describes, so a cell is asked for by
 * what it says rather than by where it sits; only the count of rows is scoped to the body,
 * because the header is a row too and is not one of the segments.
 */
class DetailsTable {
  readonly page: Page;
  readonly view: Locator;
  readonly rows: Locator;

  constructor(page: Page) {
    this.page = page;
    // Scoped to the view rather than the page: the roster next door is a landmark named for
    // the characters in it, and a bare "Character" reaches that too.
    this.view = page.locator("#details-view");
    this.rows = page.locator("#rows tr");
  }

  async open(): Promise<void> {
    await this.page.getByRole("button", { name: "Details" }).click();
    await expect(this.page.getByRole("heading", { name: "Details" })).toBeVisible();
  }

  search(): Locator {
    return this.view.getByLabel("Filter segments");
  }

  character(): Locator {
    return this.view.getByLabel("Character");
  }

  /** A cell of the ledger, found the way a reader finds it: by what it says. */
  cellSaying(text: string): Locator {
    return this.view.getByRole("cell", { name: text });
  }
}

/**
 * The characters view: the roster down the left, one character's whole history on the right.
 *
 * The roster is a navigation landmark and each character is a button in it, so picking one is
 * reachable the way a screen reader reaches any list of choices; the pane beside it is walked
 * by heading. Nothing here knows a class name beyond the two containers it scopes to.
 */
class Roster {
  readonly page: Page;
  readonly view: Locator;
  readonly profile: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = page.locator("#characters-view");
    this.profile = page.locator("#character-detail");
  }

  async open(): Promise<void> {
    await this.page.getByRole("button", { name: "Characters", exact: true }).click();
    await expect(this.view.getByRole("heading", { name: "Characters", level: 1 })).toBeVisible();
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
    return this.profile.locator("dl div").filter({ hasText: label }).locator("dd");
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
}

/**
 * The transmog view: the sets on the left, and the character on the right.
 *
 * A collection is a level-3 heading and a set a level-4 one, so the whole view is reachable
 * by heading the way a screen reader walks it. A set opens in place — there is no dialog —
 * so everything inside one is found within its own card.
 */
class TransmogView {
  readonly page: Page;
  readonly view: Locator;
  /**
   * The half of the view the sets are browsed in.
   *
   * Scoped rather than reaching into the whole view, because the wardrobe list beside it is
   * the same panel with the same controls in it — a class filter, a box about what she can
   * wear — and "the class filter" is only a question with an answer once it is asked of one
   * of them.
   */
  readonly browser: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = page.locator("#transmog-view");
    this.browser = this.view.locator("#transmog-browser");
  }

  /** The tab loads the game's tables the first time it is opened, and not before. */
  async open(): Promise<void> {
    // Exactly, because a session that collected one is a chip that says "transmog" too.
    await this.page.getByRole("button", { name: "Transmog", exact: true }).click();
    await expect(this.view.getByRole("heading", { name: "Transmog", level: 1 })).toBeVisible();
  }

  /** The switch above the browsers: the game's sets, its whole wardrobe, or the reader's own. */
  async browseBy(what: "Sets" | "Items" | "Yours"): Promise<void> {
    await this.view.getByRole("button", { name: what, exact: true }).click();
  }

  /** The collection headings, which are the browser's own — the panel beside it has one too. */
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

  /** Opens a set in place, the way a reader does: by clicking its name. */
  async openSet(name: string): Promise<Locator> {
    await this.page.getByRole("button", { name, exact: true }).click();
    const card = this.card(name);
    await expect(card.getByRole("listitem").first()).toBeVisible();
    return card;
  }

  async closeSet(name: string): Promise<void> {
    await this.page.getByRole("button", { name, exact: true }).click();
    await expect(this.card(name).getByRole("listitem")).toHaveCount(0);
  }

  /**
   * One row per appearance a set names, in the order the backend sorted them.
   *
   * The rows of the outer list only. A row that several items reach carries a list of its own,
   * and those are listitems too — so "every listitem in the card" would count the items a
   * reader expanded as though they were looks, which is the very thing this view stopped
   * doing.
   */
  rows(name: string): Locator {
    return this.card(name).locator(".mog-items > .mog-item");
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
   * By its text rather than by a class, because the point of asking for it separately is that
   * a reader clicking the words gets the piece put on — the whole row is one button.
   */
  name(set: string, label: string): Locator {
    return this.card(set).locator(".mog-pick").getByText(label, { exact: true });
  }

  /** The one box above the grid: whether the rows with nowhere to go are left out. */
  hideUnwearable(): Locator {
    return this.browser.getByRole("checkbox", { name: "Hide what she cannot wear" });
  }

  /**
   * The frame every row keeps for its picture, and the pictures that have arrived in them.
   *
   * Not an accessibility locator, and deliberately: an icon beside a row that already names
   * its slot and its item is decorative, so it carries no alternative text and is not in the
   * accessibility tree at all. Giving it one to make it selectable would have a screen
   * reader announce every row twice.
   */
  iconFrames(name: string): Locator {
    return this.card(name).locator(".mog-icon");
  }

  icons(name: string): Locator {
    return this.card(name).locator(".mog-icon img");
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

  /** What has been said about the set, as the chips read — the × beside each is not part. */
  tags(set: string): Locator {
    return this.card(set).locator("> .mark .mark-tag-text");
  }

  /**
   * One row of an open set, found by the look it is for.
   *
   * By the star's own accessible name rather than by the row's text, because two rows can
   * carry names one contains the other of and only the control is named exactly.
   */
  row(set: string, label: string): Locator {
    return this.card(set).locator(".mog-items > .mog-item")
      .filter({ has: this.page.getByRole("button", { name: `Favourite ${label}`, exact: true }) });
  }

  /** The star on one of those rows, which is against the *look* and not against the set. */
  rowStar(set: string, label: string): Locator {
    return this.row(set, label).getByRole("button", { name: `Favourite ${label}`, exact: true });
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
 * The other half of the browser: every look the game holds for one kind of place.
 *
 * A flat list rather than a grid of cards, because there is nothing to group five thousand
 * heads by — so a row is found by what its button would do, which is put the thing on her.
 */
class Wardrobe {
  readonly page: Page;
  readonly list: Locator;

  constructor(page: Page) {
    this.page = page;
    this.list = page.locator("#wardrobe");
  }

  /** What is drawn right now, which is a page of it rather than the whole kind. */
  rows(): Locator {
    return this.list.locator(".mog-items > .mog-item");
  }

  /** The names on those rows, which is what a reader is scanning for. */
  names(): Locator {
    return this.list.locator(".mog-name");
  }

  /** Which kind of place is being browsed: an armour slot, or a kind of thing held. */
  kind(): Locator {
    return this.list.getByLabel("Kind of appearance");
  }

  search(): Locator {
    return this.list.getByLabel("Filter appearances");
  }

  klass(): Locator {
    return this.list.getByLabel("Class");
  }

  /** The button on one row, which puts that look on the character or takes it off again. */
  wear(slot: string, label: string): Locator {
    return this.list.getByRole("button", { name: `Wear ${slot}: ${label}` });
  }

  /** One row, found by the look it is for — by its star's name, which is exact. */
  row(label: string): Locator {
    return this.list.locator(".mog-items > .mog-item")
      .filter({ has: this.page.getByRole("button", { name: `Favourite ${label}`, exact: true }) });
  }

  /** The star on that row, which is against the look — the same one a set's row carries. */
  star(label: string): Locator {
    return this.row(label).getByRole("button", { name: `Favourite ${label}`, exact: true });
  }

  /** What has been said about the look, as the chips read. */
  tags(label: string): Locator {
    return this.row(label).locator(".mark-tag-text");
  }

  favouritesOnly(): Locator {
    return this.list.getByRole("checkbox", { name: "Favourites only" });
  }

  tagFilter(): Locator {
    return this.list.getByLabel("Tag", { exact: true });
  }

  /** How far down the kind the reader has got, and what the game would not say. */
  count(): Locator {
    return this.list.locator("#wardrobe-count");
  }
}

/**
 * The third browser: the sets the reader saved off the character.
 *
 * A grid of cards like the game's own sets, so the locators read like `TransmogView`'s — but a
 * saved set has no button to open it, because there is nothing behind the click: the pieces
 * arrived with the card. So a card is found by its heading rather than by the button that
 * opens one.
 */
class YourSets {
  readonly page: Page;
  readonly list: Locator;

  constructor(page: Page) {
    this.page = page;
    this.list = page.locator("#custom-sets");
  }

  /** The saved sets on screen, by the names the reader gave them. */
  names(): Locator {
    return this.list.getByRole("heading", { level: 4 });
  }

  /** The card one of them is drawn on, found by its own heading. */
  card(name: string): Locator {
    return this.list
      .getByRole("article")
      .filter({ has: this.page.getByRole("heading", { name, exact: true, level: 4 }) });
  }

  /** One row of a saved set, found by what its button would do. */
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
    return this.card(name).locator("> .mark .mark-tag-text");
  }

  /**
   * Throws one away, which takes two clicks: the first asks and the second does it.
   *
   * Both are named after the set, so the confirmation cannot be reached by accident — and the
   * assertion that the first click did *not* delete anything is left to the test.
   */
  async delete(name: string): Promise<void> {
    await this.card(name).getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    await this.card(name).getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  }

  search(): Locator {
    return this.list.getByLabel("Filter your sets");
  }

  favouritesOnly(): Locator {
    return this.list.getByRole("checkbox", { name: "Favourites only" });
  }

  tagFilter(): Locator {
    return this.list.getByLabel("Tag", { exact: true });
  }
}

/**
 * The character, and the list of what she has on — the half of the view that never goes away.
 *
 * Every piece is a list item naming the place, the item and the set it came out of, and the
 * button beside it says what taking it off would take off. Nothing here needs a set to be
 * open, which is the point.
 */
class Outfit {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.locator("#outfit");
  }

  /** One row per place on the body that has something in it, head downwards. */
  slots(): Locator {
    return this.panel.locator(".outfit-slot");
  }

  /** How much is on, as the line above the list reads it. */
  summary(): Locator {
    return this.panel.locator("#outfit-summary");
  }

  /**
   * The line under each item's name saying which set it came out of.
   *
   * Only on the pieces that came out of one: a look picked out of the game's whole wardrobe
   * has no set behind it, and the line is absent rather than empty.
   */
  provenance(): Locator {
    return this.panel.locator(".outfit-what .muted");
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

  /** The pane the body is drawn on, which says how much geometry it ended up holding. */
  stage(): Locator {
    return this.panel.locator(".outfit-stage");
  }

  /** The canvas she is drawn on, which only exists once a body has been shown. */
  canvas(): Locator {
    return this.panel.locator(".outfit-stage canvas");
  }

  /** Whatever the pane says about what it is showing, which is a live region. */
  note(): Locator {
    return this.panel.locator("#outfit-note");
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
}

/**
 * Settings, which is a rail of categories and one pane. Everything else on this page that
 * lives under Settings opens through here, so the two clicks are written down once.
 */
class SettingsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** Opens Settings on a given category, addressed by the name on the rail. */
  async open(category: string): Promise<void> {
    await this.page.getByRole("button", { name: "Settings", exact: true }).click();
    await this.page
      .getByRole("navigation", { name: "Settings categories" })
      .getByRole("button", { name: category })
      .click();
  }
}

/**
 * The combat logging panel on Settings: one switch, and what the install is really doing.
 *
 * The panel is a landmark and is found by its name, and everything inside it by role — the
 * checkbox by the label beside it, the state line by its being a live region. Nothing here
 * knows an id or a class, so the panel can be rebuilt and this still addresses it.
 */
class CombatLoggingPanel {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Combat logging" });
  }

  async open(): Promise<void> {
    await new SettingsPage(this.page).open("Combat logs");
    await expect(this.panel).toBeVisible();
  }

  /** The one box somebody has to tick themselves, named by the label wrapped around it. */
  toggle(): Locator {
    return this.panel.getByRole("checkbox", { name: "Start combat logging when I log in" });
  }

  /** Where the panel says where this install stands, which is announced as it changes. */
  state(): Locator {
    return this.panel.getByRole("status");
  }
}

/**
 * The screenshots: a grid wherever captures are shown, and the one somebody opened.
 *
 * A tile is addressed by what it opens rather than by its position, because "the screenshot
 * from Glass Caverns at 22:03" is what a reader is looking for and is the only thing a screen
 * reader will read out. The grid is scoped to whatever it was drawn in — a session card or the
 * segment modal — since the same component draws both.
 */
class Screenshots {
  readonly page: Page;
  readonly viewer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.viewer = page.locator("#capture-viewer");
  }

  tilesIn(scope: Locator): Locator {
    return scope.getByRole("button", { name: /Open the screenshot/ });
  }

  /** Opens an evening's pictures on a session card, which is folded away until asked for. */
  async unfold(card: Locator): Promise<Locator> {
    await card.getByRole("button", { name: /screenshots?/ }).click();
    return this.tilesIn(card);
  }

  async open(tile: Locator): Promise<void> {
    await tile.click();
    await expect(this.viewer).toBeVisible();
  }

  note(): Locator {
    return this.viewer.getByLabel("Note", { exact: true });
  }

  /** The picture itself, which arrives after the dialog does. */
  picture(): Locator {
    return this.viewer.locator("img");
  }

  async close(): Promise<void> {
    await this.viewer.getByRole("button", { name: "Close screenshot" }).click();
    await expect(this.viewer).toBeHidden();
  }
}

/**
 * The retention panel on Settings: a switch, a number of days, and — the reason the panel
 * exists — the files a sweep would take, by name, before anybody agrees to it.
 */
class LogRetentionPanel {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Deleting old combat logs" });
  }

  async open(): Promise<void> {
    await new SettingsPage(this.page).open("Combat logs");
    await expect(this.panel).toBeVisible();
  }

  toggle(): Locator {
    return this.panel.getByRole("checkbox", {
      name: "Delete combat logs Chronie has finished reading",
    });
  }

  /** How long a log is kept, which is a number and is addressed as one. */
  days(): Locator {
    return this.panel.getByRole("spinbutton", { name: "Keep logs for" });
  }

  state(): Locator {
    return this.panel.getByRole("status");
  }
}

/**
 * The screenshots category of Settings: what photographs itself, and what is kept of it.
 *
 * Every control is addressed by the moment it is about — "a mount added to the collection" —
 * because that is what somebody is looking for and what a screen reader announces. The two
 * halves of the panel are one region, and the state lines are live regions inside it.
 */
class CaptureSettingsPanel {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Screenshots" });
  }

  async open(): Promise<void> {
    await new SettingsPage(this.page).open("Screenshots");
    await expect(this.panel).toBeVisible();
  }

  /** One rule's box, named by the moment it photographs. */
  trigger(moment: string | RegExp): Locator {
    return this.panel.getByRole("checkbox", { name: moment });
  }

  /** One of the four things Chronie can keep of a picture. */
  quality(level: string | RegExp): Locator {
    return this.panel.getByRole("radio", { name: level });
  }

  originals(): Locator {
    return this.panel.getByRole("checkbox", { name: "Leave the game’s own copy where it is" });
  }

  /** What the panel says about the rules as they stand, which is announced as it changes. */
  state(): Locator {
    return this.panel.getByRole("status");
  }
}

/**
 * The Query view: an editor, an answer, and a picture of it.
 *
 * Everything here is addressed the way it is announced — the editor by its label, the chart
 * by the sentence a screen reader is given for it, the refusal by being an alert. The one
 * exception is the rows, which are a table and are read as one.
 */
class QueryWorkbench {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = page.locator("#query-view");
  }

  async open(): Promise<void> {
    await this.page.getByRole("button", { name: "Query", exact: true }).click();
    await expect(this.view).toBeVisible();
  }

  editor(): Locator {
    return this.view.getByRole("textbox", { name: "SQL" });
  }

  async runIt(): Promise<void> {
    await this.view.getByRole("button", { name: "Run" }).click();
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
    return this.view.locator(".query-rows tbody tr");
  }

  /** One question worth asking, offered above the editor. */
  recipe(name: string): Locator {
    return this.view.getByRole("button", { name });
  }

  /** A table in the list down the left, opened so what is inside it can be reached. */
  async openTable(name: string): Promise<Locator> {
    const listed = this.view.locator(`#query-table-${name}`);
    await listed.locator("summary").click();
    return listed;
  }
}

const test = base.extend<{
  detail: SegmentDetail;
  editor: ActivityEditor;
  ledger: DetailsTable;
  roster: Roster;
  transmog: TransmogView;
  wardrobe: Wardrobe;
  yours: YourSets;
  outfit: Outfit;
  combat: CombatLoggingPanel;
  retention: LogRetentionPanel;
  captureSettings: CaptureSettingsPanel;
  shots: Screenshots;
  workbench: QueryWorkbench;
}>({
  detail: async ({ page }, use) => {
    await use(new SegmentDetail(page));
  },
  editor: async ({ page }, use) => {
    await use(new ActivityEditor(page));
  },
  ledger: async ({ page }, use) => {
    await use(new DetailsTable(page));
  },
  roster: async ({ page }, use) => {
    await use(new Roster(page));
  },
  transmog: async ({ page }, use) => {
    await use(new TransmogView(page));
  },
  wardrobe: async ({ page }, use) => {
    await use(new Wardrobe(page));
  },
  yours: async ({ page }, use) => {
    await use(new YourSets(page));
  },
  outfit: async ({ page }, use) => {
    await use(new Outfit(page));
  },
  combat: async ({ page }, use) => {
    await use(new CombatLoggingPanel(page));
  },
  retention: async ({ page }, use) => {
    await use(new LogRetentionPanel(page));
  },
  captureSettings: async ({ page }, use) => {
    await use(new CaptureSettingsPanel(page));
  },
  shots: async ({ page }, use) => {
    await use(new Screenshots(page));
  },
  workbench: async ({ page }, use) => {
    await use(new QueryWorkbench(page));
  },
});

// Two evenings: the first is a keystone run followed two minutes later by an alt, which is
// the case that has to fold into one play session; the second is a day earlier and must not.
const EVENING = 1785063600;
const NIGHT_BEFORE = 1784977200;

// Two tiny pictures, so the tile and the thing behind it can be told apart on screen. Real
// PNGs rather than placeholder strings: the browser has to actually decode what the backend
// hands over, and a `data:` URL that only looks like one would pass a test the app fails.
const THUMBNAIL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElE" +
  "QVR4nGPQqDgBRww4OQBBxhDhzXmo9QAAAABJRU5ErkJggg==";
const FULL_SIZE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlE" +
  "QVR4nGM4EaWBFTEMpAQAQEQ94cz6peQAAAAASUVORK5CYII=";

// The note is the most user-supplied string in the application, and this is the shape that
// proves it: typed by a person, containing markup, and drawn in three places — the tile, the
// viewer, and the tooltip that is handed HTML rather than a value in a React tree.
const NOTED = "<b>first</b> Yogg kill";

/**
 * What every item of the transmog fixtures says about itself beyond its name.
 *
 * The window groups a set's rows by appearance and reads these three to say what separates two
 * items that give the same look, so a row has to carry them whether or not the flow below
 * looks at them. Every item here is one anybody may wear.
 */
const ANY_CLASS_ITEM = { allowableClass: 0xffff, requiredLevel: 0, quality: 4 } as const;

/** And what the backend answers for an appearance whose item the game keeps encrypted. */
const WITHHELD_ITEM = { allowableClass: 0, requiredLevel: 0, quality: 0 } as const;

// Typed as the real backend's answers, so a fixture that has drifted from what a command
// actually returns fails the type check rather than the assertion three steps later.
//
// The places are invented, the classes are not: a class token is the app's own vocabulary —
// the palette in `ui.tsx` is keyed by it — so a made-up one would draw every character in the
// colourless fallback and hide the very thing the cast is coloured for.
const mockDesktop: E2EMock = {
  dashboard: {
    generatedAt: "2026-07-26T12:00:00Z",
    knownActivityKinds: ["mythic_plus", "progress_raid", "legacy_raid", "levelling"],
    // What every character was last seen holding, which is the half of the story no single
    // segment can tell: the tokens on the line belong to one character, and "how many of
    // these do I have, everywhere" and "has somebody already finished this grind" are
    // questions about the account.
    holdings: {
      // Two wallets and the one pot the account shares. The pot is what makes the account's
      // worth a different number from either wallet, which is the whole reason it is drawn.
      gold: {
        characters: [
          { character: "Aster-Vale", total: 125000, at: EVENING },
          { character: "Brin-Hearth", total: 400000, at: EVENING - 3 * 86400 },
        ],
        wallets: 525000,
        warband: 1200000,
        warbandAt: EVENING - 3 * 86400,
        total: 1725000,
        oldest: EVENING - 3 * 86400,
      },
      currencies: [{
        id: 7,
        name: "Glass Token",
        total: 30000,
        oldest: EVENING - 3 * 86400,
        characters: [
          { character: "Aster-Vale", total: 12450, at: EVENING },
          { character: "Brin-Hearth", total: 17550, at: EVENING - 3 * 86400 },
        ],
      }, {
        // The warband's one pot: the game hands every character the same balance, so both
        // rows are that balance seen from somewhere else rather than two holdings, the total
        // is the freshest of them rather than their sum, and the wording has to say so.
        id: 10,
        name: "Warband Chit",
        total: 6000,
        accountWide: true,
        oldest: EVENING,
        characters: [
          { character: "Aster-Vale", total: 6000, at: EVENING },
          { character: "Brin-Hearth", total: 6000, at: EVENING - 3 * 86400 },
        ],
      }],
      factions: [
        {
          faction: "Cavern Cartographers",
          best: {
            character: "Brin-Hearth", standing: "Revered", current: 3000, max: 21000,
            rank: 7, system: "reaction", at: EVENING - 3 * 86400,
          },
          characters: [
            {
              character: "Aster-Vale", standing: "Honored", current: 4200, max: 12000,
              rank: 6, system: "reaction", at: EVENING,
            },
            {
              character: "Brin-Hearth", standing: "Revered", current: 3000, max: 21000,
              rank: 7, system: "reaction", at: EVENING - 3 * 86400,
            },
          ],
        },
        // The one the account leader is standing on: nobody is ahead of this character
        // because this character is the one out in front, and there is nothing to say.
        {
          faction: "Deepwater Wardens",
          best: {
            character: "Brin-Hearth", standing: "Exalted", rank: 8, system: "reaction",
            at: EVENING,
          },
          characters: [{
            character: "Brin-Hearth", standing: "Exalted", rank: 8, system: "reaction",
            at: EVENING,
          }],
        },
      ],
    },
    segments: [
      {
        id: "synthetic-003",
        segmentId: 3,
        activities: [],
        encounters: [],
        character: "Brin-Hearth",
        classFile: "DRUID",
        level: 9,
        day: "2026-07-26",
        instance: "Copperwood Depths",
        difficulty: "",
        instanceType: "none",
        startedAt: EVENING + 1920,
        endedAt: EVENING + 3120,
        seconds: 1200,
        lootValue: 15000,
        goldDiff: 900,
        currencyTotal: 2,
        reputationTotal: 50,
        housingXP: 0,
        // A second source in the same evening, so the transmog summary counts two and unfolds
        // into them — and one this install can say nothing about, which is what the name the
        // addon caught at the time is the fallback for.
        transmogs: [{ id: 4200, name: "Storm Cloak", at: EVENING + 2200, newAppearance: false }],
        // The other half of the story: gains the client said nothing else about. An
        // item-based currency counted before its first change has no holding to report, and
        // a faction read off a chat line on a character that has never met it has no
        // standing. Neither is a holding of zero or a standing at the bottom of a bar, so
        // neither may draw as one.
        // A third case sits beside them: a faction the client named a level for and gave no
        // length to. That is a standing worth printing and a bar with nothing to draw, and a
        // bar at zero would announce the character as nowhere in a level they are inside.
        // The alt's own picture, so an evening's fold has captures from more than one of its
        // segments and the grid is a session's rather than a segment's.
        captures: [{
          id: 33, sourceId: "TEST|3|33", at: EVENING + 2000, imageState: "stored",
          byteSize: 2_411_902, sourceName: "WoWScrnShot_072626_190000.jpg",
        }],
        currencies: [{ id: 8, name: "Rustward Scrip", amount: 2 }],
        reputation: [
          { faction: "Lamplighters", amount: 10 },
          { faction: "Deepwater Wardens", amount: 40, standing: "Exalted" },
        ],
        achievements: [],
        levelUps: [{ level: 9, at: EVENING + 3000 }],
        mounts: [],
        pets: [],
        quests: [],
        toys: [],
        housingItems: [],
        housingLevelUps: [],
      },
      {
        id: "synthetic-001",
        segmentId: 1,
        activities: [
          {
            id: 11,
            kind: "mythic_plus",
            source: "inferred",
            confidence: 1,
            metadata: { dungeon: "Glass Caverns", keystoneLevel: 14, timed: true },
          },
        ],
        // Three captures covering everything a tile has to be able to say: a picture with a
        // note somebody typed, an automatic one Chronie took by itself, and a marker whose
        // file was never found — which is a row to explain rather than a blank tile.
        captures: [
          {
            id: 11, sourceId: "TEST|1|11", at: EVENING + 1400, imageState: "stored",
            note: NOTED, byteSize: 3_204_112, sourceName: "WoWScrnShot_072626_183020.jpg",
          },
          {
            id: 12, sourceId: "TEST|1|12", at: EVENING + 1450, imageState: "stored",
            trigger: "accountFirstAchievement", achievementId: 77, byteSize: 3_100_000,
          },
          { id: 13, sourceId: "TEST|1|13", at: EVENING + 1500, imageState: "missing" },
        ],
        keystone: { level: 14, completed: true, onTime: true, upgrades: 1 },
        encounters: [{ id: 900, name: "The Curator", at: EVENING + 400, success: true }],
        character: "Aster-Vale",
        classFile: "MAGE",
        level: 12,
        day: "2026-07-26",
        instance: "Glass Caverns",
        difficulty: "Expedition",
        instanceType: "scenario",
        startedAt: EVENING,
        endedAt: EVENING + 1800,
        seconds: 1800,
        lootValue: 245000,
        goldDiff: 32000,
        currencyTotal: 4,
        reputationTotal: 25,
        housingXP: 0,
        equipsetChanges: [
          {
            setId: 3,
            name: "Raid",
            kind: "updated",
            at: EVENING + 1700,
            items: [
              {
                slot: 1,
                itemId: 4101, itemLevel: 639, itemName: "Deepwater Crown",
                previousItemId: 4100, previousItemLevel: 623, previousItemName: "Tideglass Crown",
              },
              // A slot the edit cleared, which has to draw as an emptied slot rather than as
              // a row with nothing in it.
              { slot: 15, previousItemId: 4200, previousItemLevel: 620, previousItemName: "Storm Cloak" },
            ],
          },
        ],
        transmogs: [{ id: 101, at: EVENING + 1400, newAppearance: true }],
        // Both gains carry where they left the character: the tokens now in the bag, and the
        // level the faction now sits at with the distance into it. Those are the numbers a
        // gain on its own cannot give — whether there is enough to buy anything, and how far
        // "+25" actually moved the standing.
        currencies: [
          { id: 7, name: "Glass Token", amount: 4, total: 12450 },
          { id: 10, name: "Warband Chit", amount: 100, total: 6000 },
        ],
        reputation: [{
          faction: "Cavern Cartographers", amount: 25,
          standing: "Honored", current: 4200, max: 12000,
        }],
        achievements: [
          { id: 9, name: "Into the Light", at: EVENING + 1400, accountFirst: false },
          // One the install can say nothing about, which is what an achievement earned on a
          // build newer than the one on disk looks like: the addon's own name and no more.
          { id: 77, name: "Quiet Ascent", at: EVENING + 1450, accountFirst: true },
        ],
        levelUps: [{ level: 12, at: EVENING + 1500 }],
        mounts: [{ id: 11, name: "Clockwork Glider", at: EVENING + 1600 }],
        pets: [],
        quests: [{ id: 81, at: EVENING + 1650 }],
        toys: [],
        housingItems: [],
        housingLevelUps: [],
      },
      {
        id: "synthetic-002",
        segmentId: 2,
        activities: [],
        encounters: [],
        character: "Brin-Hearth",
        classFile: "DRUID",
        level: 8,
        day: "2026-07-25",
        instance: "Copperwood",
        difficulty: "",
        instanceType: "none",
        startedAt: NIGHT_BEFORE,
        endedAt: NIGHT_BEFORE + 900,
        seconds: 900,
        lootValue: 50000,
        goldDiff: -1200,
        currencyTotal: 0,
        reputationTotal: 0,
        housingXP: 30,
        transmogs: [],
        currencies: [],
        reputation: [],
        achievements: [],
        levelUps: [],
        mounts: [],
        // The same critter twice, which is the shape only a battle pet can take: the
        // collection grew by one and the second catch is another of something already
        // held. A card that counted two would be reporting a collection that did not move.
        pets: [
          { id: 12, name: "Mossling", at: NIGHT_BEFORE + 800, speciesFirst: true },
          { id: 12, name: "Mossling", at: NIGHT_BEFORE + 820, speciesFirst: false },
        ],
        quests: [],
        toys: [{ id: 13, name: "Pocket Orrery", at: NIGHT_BEFORE + 850 }],
        housingItems: [{ id: 14, name: "Carved Reading Chair", at: NIGHT_BEFORE + 860, warbandFirst: true }],
        housingLevelUps: [{ level: 2, at: NIGHT_BEFORE + 870 }],
      },
    ],
  },
  // The same invented sets the backend fixtures hold, so the two halves of the transmog
  // view are exercised against one story rather than two.
  transmog: {
    readCount: 5,
    declaredCount: 7,
    withheldCount: 2,
    sets: [
      {
        id: 205, name: "Duskwoven Shroud", group: "Duskwoven Attire", groupId: 3,
        classMask: 0, expansionId: 5, parentId: 0, flags: 0, uiOrder: 15,
        patchIntroduced: 110000, itemCount: 2,
      },
      {
        id: 203, name: "Emberforge Plate", group: "Emberforge Armory", groupId: 2,
        classMask: 0x0023, expansionId: 4, parentId: 0, flags: 2, uiOrder: 5,
        patchIntroduced: 100300, itemCount: 6,
      },
      {
        id: 201, name: "Tideglass Regalia", group: "Tideglass Wardrobe", groupId: 1,
        classMask: 0x0190, expansionId: 3, parentId: 0, flags: 1, uiOrder: 5,
        patchIntroduced: 100200, itemCount: 6,
      },
      {
        id: 202, name: "Tideglass Hide", group: "Tideglass Wardrobe", groupId: 1,
        classMask: 0x0e08, expansionId: 3, parentId: 201, flags: 1, uiOrder: 10,
        patchIntroduced: 100200, itemCount: 2,
        // The other faction bought exactly these clothes under another name, so 210 is shown
        // in its place and 202 says which card carries it. 436 of a shipping install's sets
        // are somebody else's wardrobe like this.
        alternates: [{
          id: 210, name: "Deepglass Hide", group: "Deepglass Wardrobe", classMask: 0x0e08,
          expansionId: 3, patchIntroduced: 100200, reason: "faction" as const,
        }],
      },
      // And the other end of that pair, still in the payload — the counts above are about what
      // the game holds — and left out of the grid by the window rather than by the backend.
      {
        id: 210, name: "Deepglass Hide", group: "Deepglass Wardrobe", groupId: 4,
        classMask: 0x0e08, expansionId: 3, parentId: 0, flags: 8, uiOrder: 15,
        patchIntroduced: 100200, itemCount: 2, sameLookAs: 202,
      },
    ],
  },
  // And what those sets are made of, which the window asks for a set at a time. The item
  // ids, slots and the one appearance the game withholds are the backend fixtures' own, so
  // a change to the chain the Rust tests hold still shows up here too.
  transmogItems: {
    201: {
      setId: 201,
      readCount: 6,
      withheldCount: 0,
      appearances: [
        {
          modifiedAppearanceId: 71001, itemId: 30001, name: "Tideglass Crown", appearanceId: 80001,
          displayType: 0, inventoryType: 1,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900001, iconFileDataId: 130001, hasModel: true,
        },
        // The set names the same appearance through the same `ItemModifiedAppearance` twice,
        // which the game stores as one row copied. One look, and one item giving it — so the
        // two rows are one row, and it says nothing about there being another item.
        {
          modifiedAppearanceId: 71001, itemId: 30001, name: "Tideglass Crown", appearanceId: 80001,
          displayType: 0, inventoryType: 1,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900001, iconFileDataId: 130001, hasModel: true,
        },
        {
          modifiedAppearanceId: 71002, itemId: 30002, name: "Tideglass Mantle", appearanceId: 80002,
          displayType: 1, inventoryType: 3,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900002, iconFileDataId: 130002, hasModel: true,
        },
        {
          modifiedAppearanceId: 71003, itemId: 30003, name: "Tideglass Robe", appearanceId: 80003,
          displayType: 3, inventoryType: 5,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900012, iconFileDataId: 130003, hasModel: false,
        },
        // And the ordinary shape of a shipping set: two more items giving the robe's look,
        // one of them locked to a class the set itself is not, one of them cheaper. Three
        // items, one row, and the whole reason a row opens.
        {
          modifiedAppearanceId: 71030, itemId: 30030, name: "Robe of the Tideglass Court",
          appearanceId: 80003, displayType: 3, inventoryType: 5,
          allowableClass: 0x0010, requiredLevel: 60, quality: 4,
          displayInfoId: 900012, iconFileDataId: 130003, hasModel: false,
        },
        {
          modifiedAppearanceId: 71031, itemId: 30031, name: "Sea-Touched Vestment",
          appearanceId: 80003, displayType: 3, inventoryType: 5,
          allowableClass: 0xffff, requiredLevel: 45, quality: 3,
          displayInfoId: 900012, iconFileDataId: 130003, hasModel: false,
        },
      ],
    },
    202: {
      setId: 202,
      readCount: 2,
      withheldCount: 0,
      appearances: [
        {
          modifiedAppearanceId: 71004, itemId: 30004, name: "Tideglass Sandals",
          appearanceId: 80004,
          displayType: 6, inventoryType: 8,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900004, iconFileDataId: 130004, hasModel: false,
        },
        {
          modifiedAppearanceId: 71005, itemId: 30005, name: "Tideglass Gloves", appearanceId: 80005,
          displayType: 8, inventoryType: 10,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900005, iconFileDataId: 130005, hasModel: false,
        },
      ],
    },
    // The set whose appearances span several slots, which is what the list is grouped by.
    203: {
      setId: 203,
      readCount: 6,
      withheldCount: 0,
      appearances: [
        {
          modifiedAppearanceId: 71006, itemId: 30006, name: "Emberforge Helm", appearanceId: 80006,
          displayType: 0, inventoryType: 1,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900001, iconFileDataId: 130001, hasModel: true,
        },
        {
          modifiedAppearanceId: 71007, itemId: 30007, name: "Emberforge Pauldrons",
          appearanceId: 80007,
          displayType: 1, inventoryType: 3,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900009, iconFileDataId: 130002, hasModel: true,
        },
        {
          modifiedAppearanceId: 71008, itemId: 30008, name: "Emberforge Breastplate",
          appearanceId: 80008,
          displayType: 3, inventoryType: 5,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900003, iconFileDataId: 130003, hasModel: false,
        },
        {
          modifiedAppearanceId: 71009, itemId: 30009, name: "Emberforge Greaves",
          appearanceId: 80009,
          displayType: 5, inventoryType: 7,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900006, iconFileDataId: 130006, hasModel: false,
        },
        // A weapon, which the game files under a display type that says only "a weapon" —
        // and beside it where the item is worn, which is what says the right hand.
        {
          modifiedAppearanceId: 71010, itemId: 30010, name: "Emberforge Blade",
          appearanceId: 80010,
          displayType: 11, inventoryType: 13,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900007, iconFileDataId: 130005, hasModel: true,
        },
        // And one whose item the game withholds, so nothing says a hand — or a name. That
        // is the one appearance left that is still shown on its own: a model at the origin
        // would be inside her pelvis, and the shape of the thing is better than nothing.
        {
          modifiedAppearanceId: 71017, itemId: 30017, name: "",
          appearanceId: 80017,
          displayType: 12, inventoryType: 0,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900007, iconFileDataId: 130005, hasModel: true,
        },
      ],
    },
    // Two appearances, one of which the game encrypts — so the modal has to list something
    // it cannot name rather than come up one row short of the card.
    205: {
      setId: 205,
      readCount: 1,
      withheldCount: 1,
      appearances: [
        {
          modifiedAppearanceId: 71011, itemId: 30011, name: "", appearanceId: 80011,
          displayType: 3, inventoryType: 5,
          ...ANY_CLASS_ITEM,
          displayInfoId: 900900, iconFileDataId: 130008, hasModel: false,
        },
        {
          modifiedAppearanceId: 71012, itemId: 0, name: "", appearanceId: 0,
          displayType: 0, inventoryType: 1,
          ...WITHHELD_ITEM,
          displayInfoId: 0, iconFileDataId: 0, hasModel: false,
        },
      ],
    },
  },
  // The other half of the browser: every look the game holds for one kind of place, keyed by
  // the display types the window asks for. Two answers, because that is all the window ever
  // asks for — one armour slot, and everything held in a hand at once.
  //
  // The looks are the backend fixtures' own, with one addition that is the whole point of
  // browsing this way: the Coif of the Drowned Star belongs to no set at all, so nothing in
  // the sets beside this could ever reach it.
  wardrobe: {
    "0": {
      displayTypes: [0],
      readCount: 3,
      // One head this install can reach no item of, which is a look it can say nothing
      // whatever about rather than one it can half-describe.
      withheldCount: 1,
      appearances: [
        // A head out of the game and out of no set. It is first because the list is sorted
        // by name, which is how a wardrobe of five thousand is scrolled at all.
        {
          appearanceId: 80040, itemId: 30040, name: "Coif of the Drowned Star",
          displayType: 0, inventoryType: 1, classId: 4, subclassId: 1,
          allowableClass: 0xffff, requiredLevel: 30, quality: 3,
          displayInfoId: 900040, iconFileDataId: 130002, hasModel: true,
          itemCount: 1, liftsRestriction: false,
        },
        // The helm set 203 also holds, which is what says the two halves of the view are
        // dressing one character: worn from either, it is the same look on the same head.
        {
          appearanceId: 80006, itemId: 30006, name: "Emberforge Helm",
          displayType: 0, inventoryType: 1, classId: 4, subclassId: 4,
          allowableClass: 0xffff, requiredLevel: 0, quality: 4,
          displayInfoId: 900001, iconFileDataId: 130001, hasModel: true,
          // Three items sell it and one of them is locked to a class the other two are not,
          // which is the one fact about a look no amount of scrolling would show.
          itemCount: 3, liftsRestriction: true,
        },
        {
          appearanceId: 80001, itemId: 30001, name: "Tideglass Crown",
          displayType: 0, inventoryType: 1, classId: 4, subclassId: 1,
          allowableClass: 0x0190, requiredLevel: 0, quality: 4,
          displayInfoId: 900002, iconFileDataId: 130001, hasModel: true,
          itemCount: 1, liftsRestriction: false,
        },
      ],
    },
    // Everything held in a hand, in one answer — which is what lets the picker offer staves
    // and daggers as neighbours without going back to the game for each.
    "11,12,13,14,15": {
      displayTypes: [11, 12, 13, 14, 15],
      readCount: 4,
      withheldCount: 0,
      appearances: [
        {
          appearanceId: 80010, itemId: 30010, name: "Emberforge Blade",
          displayType: 11, inventoryType: 13, classId: 2, subclassId: 7,
          allowableClass: 0xffff, requiredLevel: 0, quality: 5,
          displayInfoId: 900007, iconFileDataId: 130005, hasModel: true,
          itemCount: 1, liftsRestriction: false,
        },
        // A shield, which the game files as armour rather than as a weapon — so a picker
        // reading the display type alone would have put it among the swords.
        {
          appearanceId: 80015, itemId: 30015, name: "Emberforge Aegis",
          displayType: 13, inventoryType: 14, classId: 4, subclassId: 6,
          allowableClass: 0xffff, requiredLevel: 0, quality: 5,
          displayInfoId: 900015, iconFileDataId: 130005, hasModel: true,
          itemCount: 1, liftsRestriction: false,
        },
        // And two the display type cannot tell apart at all: a staff and a two-handed sword
        // are both filed under 11, and only the item's own subclass separates them.
        {
          appearanceId: 80014, itemId: 30014, name: "Emberforge Greatsword",
          displayType: 11, inventoryType: 17, classId: 2, subclassId: 8,
          allowableClass: 0xffff, requiredLevel: 0, quality: 5,
          displayInfoId: 900014, iconFileDataId: 130005, hasModel: true,
          itemCount: 1, liftsRestriction: false,
        },
        {
          appearanceId: 80041, itemId: 30041, name: "Staff of the Quiet Tide",
          displayType: 11, inventoryType: 17, classId: 2, subclassId: 10,
          allowableClass: 0xffff, requiredLevel: 45, quality: 4,
          displayInfoId: 900014, iconFileDataId: 130005, hasModel: true,
          itemCount: 2, liftsRestriction: false,
        },
      ],
    },
  },
  // What this reader has already said about the game's wardrobe with their own hands.
  //
  // Deliberately not empty, and deliberately not much: one starred set and one tagged look are
  // what a browser opening on an install that has been used for a while looks like, and they
  // are what makes "the star survived being written" a different assertion from "the star is
  // drawn at all". Everything else the suite needs it writes itself, through the same buttons
  // a player would — see `bridge.ts`, where the mock keeps them the way the two tables do.
  transmogMarks: {
    marks: [
      { kind: "set", id: 205, favourite: true, tags: [] },
      { kind: "appearance", id: 80040, favourite: false, tags: [{ key: "wishlist", value: null }] },
    ],
  },
  // And the sets they put together themselves, which start at none — deliberately, where the
  // marks above start at two. A saved set is made by the page under test and by nothing else,
  // so a fixture holding one would be the one thing on this screen that never had to survive
  // being written. The empty state is worth opening on for its own sake as well.
  customSets: { sets: [] },
  // The pictures those appearances name, decoded — eight-pixel PNGs standing in for the
  // textures the backend pulls out of the game's own storage. 130008 is missing on purpose:
  // set 205 names it and the install holds no such file, which is the case a row has to
  // survive rather than break on. So is the icon the tables give appearance 71012, which is
  // no icon at all.
  gameIcons: {
    130001: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mNwaj"
      + "r2Hx9mGBkKAF+FokHepdeGAAAAAElFTkSuQmCC",
    130002: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mM45u"
      + "j0Hx9mGBkKADftkgFGGhUWAAAAAElFTkSuQmCC",
    130003: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mP4z9"
      + "DyHx9mGBkKALdWoIE3ifJxAAAAAElFTkSuQmCC",
    130006: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mNwaj"
      + "r2Hx9mGBkKAF+FokHepdeGAAAAAElFTkSuQmCC",
    // The gloves, which are the one row that both has a picture and cannot be put on the
    // character — so the picture is what the reader is left looking at.
    130005: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mP4z9"
      + "DyHx9mGBkKALdWoIE3ifJxAAAAAElFTkSuQmCC",
    250001: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mM45u"
      + "j0Hx9mGBkKADftkgFGGhUWAAAAAElFTkSuQmCC",
  },
  // What the game says about the achievements those segments name. 77 is deliberately absent:
  // an install can only describe the achievements it has, and a row still has to draw.
  achievementDetails: {
    9: {
      id: 9,
      title: "Into the Light",
      description: "Reach the lighthouse at the end of the pier.",
      reward: "Reward: Title & the lamplighter's coat",
      category: ["Chronicles", "Tideglass Deeps"],
      categoryId: 10,
      points: 25,
      iconFileDataId: 250001,
      faction: -1,
    },
  },
  // What the game says about the items those segments name — the transmog source collected,
  // and the two pieces the equipment set swapped. 4200 is deliberately absent: the cloak the
  // set gave up is an item this install cannot describe, and the row still has to draw with
  // the name the addon caught.
  itemDetails: {
    // The transmog source, which the addon recorded as a number and nothing else: this is the
    // whole of what the reader ends up seeing about it.
    101: {
      id: 101, name: "Wanderer's Mantle", classId: 4, subclassId: 2, inventoryType: 3,
      quality: 3, requiredLevel: 25, allowableClass: 0xffff, iconFileDataId: 130002,
    },
    // The plate helm the set took on, and the one it replaced. The helm is the only item in
    // the fixture some classes may not wear.
    4101: {
      id: 4101, name: "Deepwater Crown", classId: 4, subclassId: 4, inventoryType: 1,
      quality: 4, requiredLevel: 80, allowableClass: 0b10_0011, iconFileDataId: 130001,
    },
    4100: {
      id: 4100, name: "Tideglass Crown", classId: 4, subclassId: 4, inventoryType: 1,
      quality: 3, requiredLevel: 80, allowableClass: 0b10_0011, iconFileDataId: 130001,
    },
  },
  // The screenshots Chronie holds, keyed by the row id a tile asks for them by. 13 is absent
  // on purpose: it is the marker whose file was never found, which the real backend answers
  // nothing for and which has to draw as an explanation rather than as a broken picture.
  captureImages: {
    11: { thumbnail: THUMBNAIL, full: FULL_SIZE, byteSize: 3_204_112 },
    12: { thumbnail: THUMBNAIL, full: FULL_SIZE, byteSize: 3_100_000 },
    33: { thumbnail: THUMBNAIL, full: FULL_SIZE, byteSize: 2_411_902 },
  },
  // The body every set detail falls back to when nothing is worn.
  characterModel: fixtureModel("character.glb"),
  // The bodies, keyed by the outfit each is wearing: every piece's display id, ascending and
  // comma joined, which is `wornSetKey`. Keying by the whole outfit rather than by a piece of
  // it is the point — it is what lets a step below say which outfit the window actually asked
  // the backend for, and taking a piece off is exactly a different key.
  //
  // `worn-helm.glb` is the one with a second node in it — the body, and a helm above it on a
  // translation, which is the shape three.js had never been handed before; `robe.glb` is one
  // node, a body with armour painted into its atlas.
  wornSets: {
    // One piece: the robe out of set 201, which is the slot with no geometry of its own and
    // the whole reason the character is there at all.
    "900012": fixtureModel("robe.glb"),
    // And that robe with a helm out of another set on top of it, which is the picture the
    // whole view was rebuilt for: two sets, one body. 900001 is the helm both sets name.
    "900001,900012": fixtureModel("worn-helm.glb"),
    // Set 203 worn whole: a helm, a pair of pauldrons, a breastplate, greaves and a blade,
    // over the robe already on her. Its sixth row is an item the game withholds, so nothing
    // says a hand and it is not on her — and the breastplate takes the robe's chest.
    "900001,900003,900006,900007,900009": fixtureModel("worn-helm.glb"),
    // The same with the helm taken off again.
    "900003,900006,900007,900009": fixtureModel("worn-helm.glb"),
    // And the three the shoulders are swapped over: a mantle out of one set on top of the
    // helm and robe, then a pair of pauldrons out of the other taking their place, then the
    // pauldrons off again.
    "900001,900002,900012": fixtureModel("worn-helm.glb"),
    "900001,900009,900012": fixtureModel("worn-helm.glb"),
    // And the two the other half of the browser assembles: a head that belongs to no set at
    // all, and that head with a staff — which is a look no card in the grid could reach.
    "900040": fixtureModel("worn-helm.glb"),
    "900014,900040": fixtureModel("worn-helm.glb"),
    // One outfit is missing on purpose and answers `null`: set 205's one wearable row names a
    // display the game keeps encrypted, so this install has nothing to put on her for it.
  },
  settings: {
    wowPath: "C:\\Games\\Example MMO\\_retail_",
    lastSync: "2026-07-26T11:58:00Z",
    combatLogging: false,
    // What a fresh install photographs, plus a name this build has no rule for — the state a
    // hand-edited settings file or a newer addon leaves, and the one the panel must not
    // quietly delete the first time somebody ticks anything.
    captureTriggers: ["accountFirstAchievement", "somethingNewer"],
    captureQuality: "balanced",
    keepOriginalScreenshots: false,
  },
  // An install that has never been asked to log: the setting is off, and the game's own
  // config happens to have the advanced box ticked already, which is the case that proves
  // the panel reports the setting and the install as two separate facts.
  combatLog: {
    requested: false,
    advanced: true,
    source: "WTF/Account/EXAMPLE/config-cache.wtf",
    log: null,
    growing: false,
    state: "off",
  },
  // A folder in the state that makes retention worth having and worth being careful with: two
  // old logs Chronie has read to the end of, and one older still that it has never read — the
  // raid night somebody logged before Chronie was watching, which must survive any sweep and
  // has to be on screen saying so.
  logRetention: {
    enabled: false,
    days: 7,
    doomed: {
      count: 2,
      bytes: 402_653_184,
      files: [
        { name: "WoWCombatLog-071026_201500.txt", bytes: 268_435_456, modified: EVENING - 30 * 86400 },
        { name: "WoWCombatLog-071126_193000.txt", bytes: 134_217_728, modified: EVENING - 29 * 86400 },
      ],
    },
    unread: {
      count: 1,
      bytes: 1_073_741_824,
      files: [
        { name: "WoWCombatLog-032526_204500.txt", bytes: 1_073_741_824, modified: EVENING - 120 * 86400 },
      ],
    },
    unfinished: { count: 0, bytes: 0, files: [] },
    removed: [],
  },
  // The database as the Query view may see it, and the answers to the four questions this
  // suite asks of it. The queries are keyed by the recipes themselves rather than by copies
  // of their text: what the view sends is the recipe, so a recipe somebody rewords stays
  // answered and a view that stopped sending it does not.
  query: {
    schema: {
      tables: [
        {
          name: "characters",
          view: false,
          rowCount: 3,
          columns: [
            { name: "id", kind: "INTEGER", primaryKey: true },
            { name: "name", kind: "TEXT", primaryKey: false },
            { name: "class_file", kind: "TEXT", primaryKey: false },
          ],
        },
        {
          name: "segments",
          view: false,
          rowCount: 1204,
          columns: [
            { name: "id", kind: "INTEGER", primaryKey: true },
            { name: "character_id", kind: "INTEGER", primaryKey: false },
            { name: "instance_name", kind: "TEXT", primaryKey: false },
            { name: "duration_seconds", kind: "INTEGER", primaryKey: false },
          ],
        },
      ],
    },
    answers: {
      [collapsed(RECIPES[0]?.sql ?? "")]: {
        columns: ["character", "hours"],
        rows: [["Aster-Vale", 41.5], ["Brin-Hearth", 12], ["Corvin-Vale", 3.2]],
        truncated: false,
        elapsedMs: 3,
      },
      [collapsed(RECIPES[1]?.sql ?? "")]: {
        columns: ["day", "hours"],
        rows: [
          ["2026-07-23", 2.5], ["2026-07-24", 4], ["2026-07-25", 0.75], ["2026-07-26", 3.25],
        ],
        truncated: false,
        elapsedMs: 5,
      },
      // What clicking a table in the list asks for. The null is the point of the row: an
      // empty cell and a cell holding nothing look identical, and only one of them is true.
      'SELECT * FROM "characters" LIMIT 50': {
        columns: ["id", "name", "class_file"],
        rows: [[1, "Aster-Vale", "MAGE"], [2, "Brin-Hearth", "PALADIN"], [3, "Corvin-Vale", null]],
        truncated: false,
        elapsedMs: 1,
      },
      // A mistyped column, refused in SQLite's own words — the one answer this feature has
      // to get right, because it is the one every reader will meet.
      "SELECT charater FROM segments": { error: "no such column: charater" },
    },
  },
  chosenPath: "D:\\Games\\Example MMO",
  syncResult: { segmentCount: 3, added: 1, updated: 1 },
  installResult: { version: "0.8.0-dev" },
  appUpdate: { updated: false, version: "0.1.0" },
  openedUrls: [],
  // One other Chronie on the network waiting for a database, and one sender knocking at this
  // one the moment it starts waiting. Both halves of a transfer are on this page, which is
  // the only place the two ever meet in a test.
  wifi: {
    peers: [{ device: "Study desktop", address: "192.168.1.20:51571" }],
    receipt: { stored: true, reason: "", segmentCount: 1204 },
    status: {
      listening: false,
      device: "Kitchen laptop",
      addresses: ["192.168.1.31:51571"],
      port: 51571,
      offer: null,
      outcome: null,
    },
    incoming: {
      from: "192.168.1.20",
      receiving: false,
      offer: {
        protocol: 1,
        device: "Study desktop",
        segmentCount: 1204,
        characterCount: 3,
        newestDay: "2026-07-26",
        bytes: 4_404_019,
      },
    },
    sentTo: [],
  },
};

/**
 * A `.glb` the backend's own converter wrote, as the data URL a command would answer with.
 *
 * Written by `cargo run --example dump_model`, and held to what the converters currently
 * produce by tests in `models.rs` and `character.rs`. Using the real output rather than a
 * hand-made stand-in is the point: this is the only place anything reads the glTF this app
 * writes, so it is the only place that can say three.js accepts it.
 */
function fixtureModel(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const glb = readFileSync(join(here, "..", "fixtures", "transmog", name));
  return `data:model/gltf-binary;base64,${glb.toString("base64")}`;
}

const timeline = (page: Page): Locator => page.locator("#timeline");
const sessions = (page: Page): Locator => page.locator("#timeline .session");

/**
 * Who played that evening, as the row of class circles.
 *
 * Scoped to the cast rather than to every named image on the card: the running totals are
 * named marks too, and a card that earned gold and reputation would otherwise report a cast
 * of five for an evening two characters played.
 */
const cast = (session: Locator): Locator => session.locator(".session-cast").getByRole("img");

/** The evening's activities, which are the first thing a card says. */
const activities = (session: Locator): Locator => session.locator(".act-roll").getByRole("button");

/**
 * The colour each of a set of elements is ringed in, as the browser resolved it.
 *
 * Computed rather than read off the markup on purpose: a class colour reaches the screen
 * through a custom property and a border that names it, and only the browser can say the
 * two ever met.
 */
const borderColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderTopColor));

/**
 * The colour each of a set of elements is filled with, as the browser resolved it.
 *
 * Computed for the same reason the ring is, and more urgently: the markup only ever carries
 * the class colour as a custom property, and what the fill actually does with that property
 * lives in the stylesheet. A rule that washed the colour down to nothing, or never named it
 * at all, is invisible from the markup and plain here.
 */
const fillColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));

/**
 * The colour each of a set of elements writes its text in, as the browser resolved it.
 *
 * The ink is written down beside the fill in the stylesheet, so this is where the pairing is
 * shown to have survived to the page and the initials to still read against what is behind
 * them.
 */
const inkColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));

/**
 * The colour of the rail down the left edge of each of a set of elements.
 *
 * The rail is an inset box-shadow rather than a border, so that the hairline holding a
 * priest's white apart from the card can sit inside it. Its first layer is the class colour
 * and the second is that hairline, which is why only the first is read.
 */
const railColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? ""));

/**
 * How much of each element in a row the one after it covers, as a fraction of its own width.
 * The last has nothing on top of it and so has no fraction of its own.
 *
 * Only the browser does layout, so only the browser can say whether a stacked cast still
 * reads. And the bounding box alone cannot say it: the rings are drawn with `box-shadow`,
 * which occupies no space, so a circle paints further than it measures. The ring is read
 * back off the element rather than assumed, which is the point — the overlap has to be
 * judged against what a circle actually covers, whatever it happens to be wearing.
 */
const overlapFractions = (elements: Locator): Promise<number[]> =>
  elements.evaluateAll((nodes) => {
    const ringOf = (node: Element): number => {
      const spreads = [...getComputedStyle(node).boxShadow.matchAll(/(?:-?[\d.]+px\s+){3}(-?[\d.]+)px/g)]
        .map((layer) => Number(layer[1]));
      return Math.max(0, ...spreads);
    };
    return nodes.slice(0, -1).map((node, index) => {
      const next = nodes[index + 1]!;
      const box = node.getBoundingClientRect();
      const covered = box.right - (next.getBoundingClientRect().left - ringOf(next));
      return Math.max(0, covered) / box.width;
    });
  });

/**
 * The urls the window has asked the operating system to open, in the order it asked.
 *
 * A real browser opening is the one outcome a browser test cannot see, so this stands in for
 * it: the app has done its part when it has handed the url over.
 */
const openedUrls = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__Chronie_E2E__?.openedUrls ?? []);

/** The addresses this window has offered its history to, in the order it offered. */
const sentTo = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__Chronie_E2E__?.wifi.sentTo ?? []);

/**
 * What the backend was actually told to store about combat logging.
 *
 * The switch on screen says what the window drew; this says what it wrote — and a control
 * that reports a setting it never saved is the failure worth having both.
 */
const combatLoggingSetting = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => window.__Chronie_E2E__?.settings.combatLogging);

/** And what it was told to keep logs for, which is `null` while it is told to keep them all. */
const retainDaysSetting = (page: Page): Promise<number | null | undefined> =>
  page.evaluate(() => window.__Chronie_E2E__?.settings.retainLogDays ?? null);

/**
 * The screenshot settings as the backend was actually told to store them.
 *
 * Read back for the same reason the combat logging one is: a control that reports a setting it
 * never saved looks identical on screen to one that did, and the whole of this feature is a
 * page of controls whose only effect is what they wrote.
 */
const captureSettingsStored = (page: Page): Promise<{
  triggers: string[];
  quality?: string;
  keepOriginals?: boolean;
}> => page.evaluate(() => ({
  triggers: window.__Chronie_E2E__?.settings.captureTriggers ?? [],
  quality: window.__Chronie_E2E__?.settings.captureQuality,
  keepOriginals: window.__Chronie_E2E__?.settings.keepOriginalScreenshots,
}));

test.beforeEach(async ({ page }) => {
  await page.addInitScript((mock) => {
    window.__Chronie_E2E__ = mock;
  }, mockDesktop);
  await page.goto("/");
});

/**
 * The one test here that is about the harness rather than the product.
 *
 * Three attempts at the class colours were green in this suite and grey in the window,
 * because the window is not a browser with the brakes off: Tauri serves the page under a
 * CSP and stamps a nonce onto the `<style>` tags it embeds, and a nonce in `style-src` makes
 * every engine ignore `'unsafe-inline'`. A `style=""` attribute has nowhere to put a nonce,
 * so every colour the page sent that way was thrown out before it was ever drawn.
 *
 * `vite.config.ts` now serves that same policy to the dev server and to this one. This says
 * so out loud, because the day it silently stops being true is the day the colour steps
 * below go back to proving nothing.
 */
test("runs under the content policy the packaged window runs under", async ({ page }) => {
  const response = await page.reload();
  const csp = response?.headers()["content-security-policy"] ?? "";

  // A nonce, specifically. `'unsafe-inline'` is in the directive too and is the thing the
  // nonce switches off, so a policy that had lost the nonce would still look permissive
  // while being far more permissive than the product.
  expect(csp).toMatch(/style-src[^;]*'nonce-/);
  expect(csp).toMatch(/script-src[^;]*'nonce-/);

  // And the page has to survive it: the stylesheet is inline, so it lives or dies on having
  // been stamped with that same nonce. A body drawn in the browser default is what a
  // mis-stamped nonce looks like, and it would take every assertion about colour with it.
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(246, 245, 242)");

  // The two policies are written out by hand in two files, and only one of them is ever
  // served to anything that could complain. The packaged one is the product's, and the day it
  // grants less than this one does is the day the suite goes back to being more permissive
  // than the window — which is how a model with every texture refused shipped green.
  //
  // Not equality: the served policy legitimately carries the nonces above, the dev server's
  // websocket and its port. What has to hold is that nothing the page needs is missing from
  // the one the reader actually runs under.
  const packaged: string = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  ).app.security.csp;
  for (const directive of ["connect-src", "img-src"]) {
    const granted = (policy: string): string[] =>
      policy.split(";").find((one) => one.trim().startsWith(directive))?.trim().split(/\s+/) ?? [];
    // `blob:` by name, because it is the one every picture in every `.glb` arrives through —
    // as a `fetch` on Chromium and as an `<img>` on WebKit, so both directives or neither.
    expect(granted(packaged), `${directive} in tauri.conf.json`).toContain("blob:");
    expect(granted(csp), `${directive} as served`).toContain("blob:");
  }
});

test("stitches segments into play sessions and leads with what happened", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();

  await test.step("an evening is one session even across a change of character", async () => {
    await expect(sessions(page)).toHaveCount(2);
    await expect(page.locator("#timeline-meta")).toContainText("2 play sessions");
    await expect(page.locator("#timeline-meta")).toContainText("3 segments");
    await expect(sessions(page).first().getByRole("button", { name: "2 segments" })).toBeVisible();
  });

  await test.step("the cast is named where a screen reader can reach it", async () => {
    const played = cast(sessions(page).first());
    await expect(played).toHaveCount(2);
    await expect(played.first()).toHaveAttribute("aria-label", /Aster-Vale, Mage · level 12/);
  });

  // The circle is the only thing on a session card that says who played at a glance, and it
  // says it in the colour the game uses. A ring drawn in the fallback grey is the failure
  // this catches: everyone the same colour is the same as nobody named.
  await test.step("each character is drawn in their own class colour", async () => {
    await expect(borderColours(cast(sessions(page).first())))
      .resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
  });

  // The version of the step above that only read the border was green for as long as the
  // fill was a 22% wash of the class colour over the card — every circle the colour of the
  // page, with a thin coloured ring, and nothing that could tell. So the fill is asserted
  // outright: mage cyan then druid orange, filled, with the initials in the ink chosen to
  // read on them. Both of those take the near-black; the white ink belongs to death knight,
  // demon hunter and shaman, which no fixture casts — the palette's unit tests measure all
  // thirteen, and this covers the only thing they cannot, which is that the page arrives
  // with the colours still attached to it.
  await test.step("and filled with it, not merely ringed in it", async () => {
    const played = cast(sessions(page).first());

    await expect(fillColours(played)).resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
    await expect(inkColours(played)).resolves.toEqual(["rgb(11, 11, 11)", "rgb(11, 11, 11)"]);
  });

  // Filling the circles cost them the ring that used to be their outer edge: they now wear
  // two more, standing 3px proud of the disc on every side. The overlap the stack was tuned
  // to without them then swallowed every initial but the last — "MAGE, DRUID, PRIEST, ROGUE"
  // came out as "M. DI PI RO". So the stacking is held to what it is for: a cast that reads.
  await test.step("and stacked close enough to read as one cast, not so close as to bury it", async () => {
    const covered = await overlapFractions(cast(sessions(page).first()));

    expect(covered.length).toBeGreaterThan(0);
    for (const fraction of covered) {
      // Overlapping at all is the intent — a row spaced out into separate discs is a
      // different design, and this is what would notice somebody had drifted into it.
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1 / 3);
    }
  });

  await test.step("both kinds of time are reported, because they differ", async () => {
    const first = sessions(page).first();
    await expect(first).toContainText("50m");
    await expect(first).toContainText("52m elapsed");
  });

  // What somebody did leads the card; what it earned them follows as summaries; and the
  // running numbers, which are context rather than news, are marks with the figures inside
  // them. A currency written out in full on the card is the state this replaced.
  await test.step("what was done leads, and what it earned follows", async () => {
    const first = sessions(page).first();
    const done = activities(first);

    await expect(done).toHaveCount(1);
    await expect(done.first()).toContainText("Mythic+ run");
    await expect(done.first()).toContainText("+14 · Glass Caverns · timed");

    await expect(first).toContainText("2 achievements");
    await expect(first).toContainText("Clockwork Glider");
    await expect(first).not.toContainText("Glass Token");
  });

  // Every figure the strip used to write out, in the one hover per kind that replaced it.
  await test.step("the running numbers are marks with the figures in the hover", async () => {
    const totals = sessions(page).first().locator(".tally");

    await expect(totals).toHaveCount(3);
    await expect(totals.first()).toHaveAttribute("aria-label", "Gold: 3g 29s");
    await expect(sessions(page).first().locator(".tally-currency"))
      .toHaveAttribute("aria-label", "Currency: Warband Chit +100, Glass Token +4, Rustward Scrip +2");
  });

  // Two achievements and two characters' levelling that evening, so the card says how much
  // of each there was rather than picking one of them to name and dropping the rest.
  await test.step("what happened several times is counted, not listed", async () => {
    const first = sessions(page).first();
    await expect(first).toContainText("2 levels");
    await expect(first).not.toContainText("Into the Light");
    await expect(first).not.toContainText("Level 12");
  });

  // The night before caught the same critter twice. A pet is the one collectible a player
  // can hold several of, so only the catch that grew the collection is worth a line — "2
  // pets" would be reporting a collection that moved by one.
  await test.step("a pet caught twice counts once", async () => {
    const before = sessions(page).nth(1);
    await expect(before).toContainText("Mossling");
    await expect(before).not.toContainText("2 pets");
  });
});

/**
 * The card is a summary and stays one: it says an evening had two levels in it, and the
 * reader who wants to know which two asks for them. That is the whole shape of the view —
 * nothing is a list until somebody has asked for a list.
 */
test("unfolds a summary into the things it counted, and folds it back up", async ({ page, detail }) => {
  const first = sessions(page).first();
  const levels = first.getByRole("button", { name: /2 levels/ });

  await expect(levels).toHaveAttribute("aria-expanded", "false");
  await levels.click();
  await expect(levels).toHaveAttribute("aria-expanded", "true");
  await expect(first).toContainText("Level 12");
  await expect(first).toContainText("Level 9");

  await test.step("one of them goes to the segment it was recorded in", async () => {
    await first.getByRole("button", { name: /Open the segment Level 9 was recorded in/ }).click();
    await expect(detail.title()).toHaveText("Copperwood Depths");
    await detail.close();
  });

  await test.step("and the card goes back to being a summary", async () => {
    await levels.click();
    await expect(levels).toHaveAttribute("aria-expanded", "false");
    await expect(first).not.toContainText("Level 12");
  });

  // The summary the addon could put no name to at all. What it counted is a number, and what
  // the reader gets when they open it is the piece of gear — read out of the installed game
  // here on the timeline, the same way it is inside a segment.
  await test.step("a transmog summary unfolds into the pieces themselves", async () => {
    await first.getByRole("button", { name: /new appearance/ }).click();

    await expect(first).toContainText("Wanderer's Mantle");
    await expect(first).not.toContainText("Item 101");
    // Named by what the row shows rather than by the number underneath it, so the button
    // reads to a screen reader the way it reads on screen.
    await expect(first.getByRole("button", {
      name: /Open the segment Wanderer's Mantle was recorded in/,
    })).toBeVisible();
  });
});

// A segment reads the same way its session does, and clicking it is how its summary comes
// apart — the modal below is the list, so the row itself needs no controls of its own.
test("summarises each segment the same way, once the session is opened", async ({ page }) => {
  const first = sessions(page).first();
  await first.getByRole("button", { name: "2 segments" }).click();

  const row = first.getByRole("button", { name: /Open segment: Aster-Vale in Glass Caverns/ });
  await expect(row).toContainText("2 achievements");
  await expect(row).toContainText("Clockwork Glider");
  await expect(row).toContainText("Level 12");
  // The running totals belong to the evening, not to a row inside it.
  await expect(row).not.toContainText("Glass Token");

  // Each row carries its own character's colour rather than the session's. This evening
  // opens on a mage and finishes on a druid, so a rail that took the card's colour — which
  // is what it does if a row forgets to name its own class, since the property is inherited
  // — would come out cyan twice and say nothing about who played what.
  await test.step("and wears the class colour of whoever played it", async () => {
    await expect(railColours(first.locator(".seg")))
      .resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
  });
});

test("digs from a session down into a single segment and back out again", async ({ page, detail }) => {
  // The shortest way down there, and the one the card is arranged around: the evening's
  // activities are the first thing on it, and each is the way into the segment it happened
  // in — where the fight-by-fight, the pictures and the correction all live.
  await test.step("an activity on the card goes straight to the run it was", async () => {
    await activities(sessions(page).first()).first().click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await detail.close();
  });

  await sessions(page).first().getByRole("button", { name: "2 segments" }).click();

  await detail.openFromTimeline("Aster-Vale", "Glass Caverns");
  await expect(detail.title()).toHaveText("Glass Caverns");
  await expect(detail.position()).toHaveText("1 of 2");
  await expect(detail.dialog).toContainText("The Curator");
  await expect(detail.dialog).toContainText("+14");

  // The segment carries an id and a name; everything else about an achievement is read out
  // of the installed game after the segment is already on screen.
  await test.step("an achievement fills in with what the game says about it", async () => {
    const earned = detail.achievements();
    await expect(earned).toHaveCount(2);
    await expect(earned.first()).toContainText("Reach the lighthouse at the end of the pier.");
    await expect(earned.first()).toContainText("Chronicles › Tideglass Deeps");
    await expect(earned.first()).toContainText("25 points");
    await expect(earned.first()).toContainText("Reward: Title & the lamplighter's coat");
    await expect(detail.achievementIcons()).toHaveCount(1);
  });

  // An install can only describe the achievements it has, and a row still has to draw: what
  // is left is the name the addon caught at the moment it was earned, which is what the
  // window showed before it was reading the game's tables at all.
  await test.step("an achievement the game says nothing about keeps what the addon knew", async () => {
    const unknown = detail.achievements().nth(1);
    await expect(unknown).toContainText("Quiet Ascent");
    await expect(unknown).toContainText("account first");
    await expect(unknown).not.toContainText("points");
  });

  // The transmog the addon recorded is a number and nothing else — the client had not loaded
  // the item when it fired — so everything a reader recognises the piece by is read out of the
  // installed game after the segment is on screen: what it is called, what colour that name is
  // written in, what kind of armour it is and where it is worn.
  await test.step("a transmog source fills in as the piece of gear it is", async () => {
    const collected = detail.transmogs();
    await expect(collected).toHaveCount(1);
    await expect(collected).toContainText("Wanderer's Mantle");
    await expect(collected).toContainText("Leather");
    await expect(collected).toContainText("Shoulders");
    await expect(collected).toContainText("new appearance");
    // Rare, which is the colour every player reads without being told, and which is an
    // attribute rather than a style because the packaged window's policy drops inline styles.
    await expect(detail.linkTo("Wanderer's Mantle")).toHaveAttribute("data-quality", "3");
    await expect(detail.itemIcons().first()).toBeVisible();
  });

  // "+4" and "+25" say what the run paid out and nothing about what that came to. The
  // holding beside the gain and the bar under the faction are the half that answers it.
  await test.step("a gain says where it left the character, not only what it was", async () => {
    await expect(detail.gainFor("Glass Token")).toContainText("+4 (12,450)");

    const standing = detail.standingBars("Honored with Cavern Cartographers");
    await expect(standing).toHaveJSProperty("value", 4200);
    await expect(standing).toHaveJSProperty("max", 12000);
    await expect(detail.gainFor("Cavern Cartographers")).toContainText("Honored 4,200 / 12,000");
  });

  // Those two numbers are still one character's. The account's are the ones that decide
  // whether the grind is worth continuing here at all.
  await test.step("a gain says what the whole account has, not only this character", async () => {
    await expect(detail.gainFor("Glass Token")).toContainText("30,000 across 2 characters");

    // The warband's pot must not be worded as a sum. "6,000 across 2 characters" says two
    // people hold some between them; there is one pot of 6,000 and both are looking at it.
    await expect(detail.gainFor("Warband Chit")).toContainText("6,000 shared across the warband");
    await expect(detail.gainFor("Warband Chit")).not.toContainText("across 2 characters");

    await expect(detail.gainFor("Cavern Cartographers"))
      .toContainText("Brin-Hearth is further along: Revered");
  });

  // The same split the character pane draws, in the place a reader meets one segment: what
  // this hour did to the wallet is settled forever, and what the character is carrying is the
  // latest reading of a wallet that has moved since. An unqualified balance beside a segment
  // from March would read as though it were March's.
  await test.step("the wallet's balance sits beside what the segment did to it", async () => {
    await expect(detail.gainFor("is carrying")).toContainText("Aster is carrying 12g 50s");

    const account = detail.gainFor("across the account");
    await expect(account).toContainText("172g 50s across the account");
    await expect(account).toContainText("120g 0s in the warband bank");
  });

  // And when the client said nothing, the window says nothing: no empty bracket after the
  // gain, and no bar at the bottom of a track the character was never on.
  await test.step("and says none of it when the client never said", async () => {
    await detail.next();
    await expect(detail.title()).toHaveText("Copperwood Depths");

    await expect(detail.gainFor("Rustward Scrip")).toContainText("+2");
    await expect(detail.gainFor("Rustward Scrip")).not.toContainText("(");
    await expect(detail.gainFor("Lamplighters")).toContainText("+10");
    // The level is worth saying even where its length is unknown; the bar is not, because a
    // bar can only be drawn somewhere, and there is nowhere known to draw this one.
    await expect(detail.gainFor("Deepwater Wardens")).toContainText("Exalted");
    await expect(detail.standingBars()).toHaveCount(0);
    // Nor does the account line speak when this character is the one out in front: the best
    // standing on the account is this character's own, and telling somebody they are behind
    // themselves is worse than saying nothing.
    await expect(detail.gainFor("Deepwater Wardens")).not.toContainText("further along");
    // The scrip is held by nobody else, so its account total is the number already on the
    // line and repeating it would say nothing.
    await expect(detail.gainFor("Rustward Scrip")).not.toContainText("across");

    await detail.previous();
    await expect(detail.title()).toHaveText("Glass Caverns");
  });

  await test.step("next and previous walk the play session, not all of history", async () => {
    await detail.next();
    await expect(detail.title()).toHaveText("Copperwood Depths");
    await expect(detail.position()).toHaveText("2 of 2");
    await expect(detail.dialog.getByRole("button", { name: "Next segment" })).toBeDisabled();

    await detail.previous();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.dialog.getByRole("button", { name: "Previous segment" })).toBeDisabled();
  });

  // The window is not a browser and cannot become one: a link has to be handed out to the
  // real one. Following it in place would leave the reader stranded on a web page.
  await test.step("a quest and an achievement go out to the reader's own browser", async () => {
    await detail.linkTo("Quest 81").click();
    await detail.linkTo("Into the Light").click();
    await detail.linkTo("Wanderer's Mantle").click();
    await expect.poll(() => openedUrls(page)).toEqual([
      "https://www.wowhead.com/quest=81",
      "https://www.wowhead.com/achievement=9",
      // By the id the segment recorded, whatever the game ended up calling the item.
      "https://www.wowhead.com/item=101",
    ]);
    await expect(detail.title()).toHaveText("Glass Caverns");
    expect(page.url()).toContain("127.0.0.1:4399");
  });

  await detail.close();
});

/**
 * The photographs of an evening, which is what the rest of this history is a caption for.
 *
 * The whole loop in one test, because the pieces only mean anything together: an evening's
 * pictures fold out of the card that summarised it, one of them opens full size, the sentence
 * under it can be rewritten, and the thing itself can be thrown away.
 */
test("shows an evening's screenshots, and lets one be annotated or deleted", async ({
  page, shots, detail,
}) => {
  const card = sessions(page).first();

  await test.step("the card counts them, and says how many are only markers", async () => {
    // Four captures in the evening across two segments, and one of them is a marker whose
    // file was never found — which is said on the way in rather than discovered by counting.
    await expect(card.getByRole("button", { name: /screenshots/ }))
      .toContainText("3 screenshots · 1 without a file");
  });

  const tiles = await shots.unfold(card);
  await expect(tiles).toHaveCount(4);

  // The pictures cross the bridge as `data:` URLs and the browser has to decode them, which is
  // the half a fixture of placeholder strings would not have proved.
  await test.step("each tile fills with the picture Chronie holds", async () => {
    await expect(card.locator(".capture-thumb img")).toHaveCount(3);
    await expect(card.locator(".capture-thumb img").first())
      .toHaveJSProperty("naturalWidth", 4);
  });

  // A note is typed by a person and drawn in three places. React writes it as a value in two
  // of them; the floating tooltip is handed HTML, which is the one that has to escape it.
  await test.step("a note containing markup is text on the tile and in the tooltip", async () => {
    await expect(tiles.first()).toContainText(NOTED);
    await expect(tiles.first().locator("b")).toHaveCount(0);

    await tiles.first().hover();
    const tip = page.locator("#tooltip");
    await expect(tip).toBeVisible();
    // One `<b>`, which is the tooltip's own — the note's would be a second, and its text
    // would have lost the tags rather than showing them.
    await expect(tip.locator("b")).toHaveCount(1);
    await expect(tip.locator("b")).toHaveText(NOTED);
  });

  await test.step("a marker with no file says so instead of showing a broken picture", async () => {
    await expect(tiles.nth(2)).toContainText("could not find the file");
    await shots.open(tiles.nth(2));
    await expect(shots.picture()).toHaveCount(0);
    await expect(shots.viewer).toContainText("could not find the file");
    await shots.close();
  });

  await test.step("opening one shows the picture at the size it was taken", async () => {
    await shots.open(tiles.first());
    await expect(shots.picture()).toHaveJSProperty("naturalWidth", 8);
    await expect(shots.viewer).toContainText("Aster-Vale · Glass Caverns");
    await expect(shots.viewer).toContainText("3.1 MB");
    await expect(shots.viewer.locator(".detail-position")).toHaveText("1 of 4");
  });

  await test.step("and the reader can walk the evening from inside it", async () => {
    await shots.viewer.getByRole("button", { name: "Next screenshot" }).click();
    await expect(shots.viewer.locator(".detail-position")).toHaveText("2 of 4");
    // The one Chronie took by itself says which rule asked for it, which is the whole
    // difference between it and one somebody pressed the key for.
    await expect(shots.viewer).toContainText("Taken for an account first");
    await shots.viewer.getByRole("button", { name: "Previous screenshot" }).click();
    await expect(shots.viewer.locator(".detail-position")).toHaveText("1 of 4");
  });

  await test.step("the note can be rewritten, and the tile says what was stored", async () => {
    await expect(shots.note()).toHaveValue(NOTED);
    await shots.note().fill("Yogg-Saron, no lights");
    await shots.viewer.getByRole("button", { name: "Save note" }).click();

    await expect(tiles.first()).toContainText("Yogg-Saron, no lights");
    await expect(tiles.first()).not.toContainText(NOTED);
  });

  await test.step("and cleared, which is a note nobody wrote rather than an empty one", async () => {
    await shots.viewer.getByRole("button", { name: "Clear note" }).click();

    await expect(shots.note()).toHaveValue("");
    await expect(tiles.first()).not.toContainText("Yogg-Saron");
    // With no note the tile falls back to where it was taken, which is the next best caption.
    await expect(tiles.first()).toContainText("Glass Caverns");
  });

  // Deleting takes a file with it and cannot be undone, so it is asked about first — and the
  // question says the picture goes as well as the entry.
  await test.step("deleting asks first, and says the picture goes with it", async () => {
    await shots.viewer.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(shots.viewer.getByRole("alert"))
      .toContainText("The picture is deleted from Chronie's storage");

    await shots.viewer.getByRole("button", { name: "Keep it" }).click();
    await expect(shots.viewer.getByRole("alert")).toHaveCount(0);
    await expect(tiles).toHaveCount(4);
  });

  await test.step("and then does both halves", async () => {
    await shots.viewer.getByRole("button", { name: "Delete", exact: true }).click();
    await shots.viewer.getByRole("button", { name: "Yes, delete it" }).click();

    await expect(shots.viewer).toBeHidden();
    await expect(tiles).toHaveCount(3);
    await expect(card.getByRole("button", { name: /screenshots/ }))
      .toContainText("2 screenshots · 1 without a file");
  });

  // The same pictures, filed where they were taken: a session's grid is the evening's, and a
  // segment's is its own.
  await test.step("a segment shows only the screenshots taken during it", async () => {
    await card.getByRole("button", { name: "2 segments" }).click();
    await detail.openFromTimeline("Brin-Hearth", "Copperwood Depths");

    await expect(shots.tilesIn(detail.dialog)).toHaveCount(1);
    await detail.close();
  });
});

// What happened to an equipment set is a chip like any other milestone, and the thing it
// unfolds into is the part a table could never hold: which slot, and what replaced what.
test("shows what happened to an equipment set, down to the slot", async ({ page, detail }) => {
  // Two slots moved: one item was replaced by a better one, and one was cleared outright.
  // The total falls because clearing a slot really does cost the set everything it held.
  //
  // Saving a set is housekeeping, so on the card it is its icon and nothing more — but the
  // sentence it gave up is still the name a screen reader reads and still the hover, which
  // is the whole bargain that made drawing it quietly acceptable.
  const chip = sessions(page).first().getByRole("button", { name: /Raid updated/ });
  await expect(chip).toHaveText("🎽");
  await expect(chip).toHaveAttribute("data-tip", /2 slots, −604 ilvl/);
  await expect(chip).toHaveAttribute("aria-label", /2 slots, −604 ilvl/);

  await chip.click();
  await expect(detail.title()).toHaveText("Glass Caverns");

  const change = detail.dialog.locator(".equipset");
  await expect(change).toHaveCount(1);
  await expect(change).toContainText("Raid updated");

  const slots = change.locator(".equipset-slots li");
  await expect(slots).toHaveCount(2);
  await expect(slots.first()).toContainText("Head");
  await expect(slots.first()).toContainText("Tideglass Crown");
  await expect(slots.first()).toContainText("623");
  await expect(slots.first()).toContainText("Deepwater Crown");
  await expect(slots.first()).toContainText("639");

  // Both pieces of the slot are drawn as the items they are — the picture and the colour of
  // the name — rather than as text, which is the same component the transmog rows use.
  await test.step("and both sides are drawn as the items they are", async () => {
    await expect(detail.itemIcons()).toHaveCount(3);
    await expect(detail.linkTo("Deepwater Crown")).toHaveAttribute("data-quality", "4");
  });

  // A slot the edit cleared says what left it and shows nothing arriving, rather than
  // drawing as a row with a blank on both sides.
  await expect(slots.nth(1)).toContainText("Back");
  // The cloak is an item this install cannot describe, which is what an item from a build
  // newer than the one on disk looks like: the name the addon caught, and no picture.
  await expect(slots.nth(1)).toContainText("Storm Cloak");
  await expect(slots.nth(1)).toContainText("620");

  await detail.close();
});

// A milestone belongs to the segment it came from, and saying so is most of the point of
// the summary: the chip is the way back to the run that produced it.
test("opens the segment a highlight came from", async ({ page, detail }) => {
  await sessions(page).first().getByRole("button", { name: /Clockwork Glider/ }).click();
  await expect(detail.title()).toHaveText("Glass Caverns");
});

test("lets the player correct what Chronie guessed a segment was", async ({ page, detail, editor }) => {
  await sessions(page).first().getByRole("button", { name: "2 segments" }).click();

  await test.step("correct the guess on a segment Chronie already labelled", async () => {
    await detail.openFromTimeline("Aster-Vale", "Glass Caverns");
    await editor.open();
    await editor.field("Keystone level").fill("18");
    await editor.field("Beat the timer").selectOption("no");
    await editor.done();

    await expect(detail.dialog).toContainText("+18");
    await expect(detail.dialog).toContainText("depleted");
    await detail.close();
    await expect(timeline(page)).toContainText("+18");
  });

  await test.step("add an activity to a segment that had none", async () => {
    await detail.openFromTimeline("Brin-Hearth", "Copperwood Depths");
    await editor.open();
    await editor.add();
    await editor.row(0).selectOption("levelling");
    await editor.field("Levels gained").fill("2");
    await editor.done();
    await detail.close();

    await expect(timeline(page)).toContainText("Levelling");
    await expect(timeline(page)).toContainText("2 levels");
  });

  await test.step("remove an activity that does not belong", async () => {
    await detail.openFromTimeline("Brin-Hearth", "Copperwood Depths");
    await editor.open();
    await editor.dialog.getByRole("button", { name: "Remove Levelling" }).click();
    await editor.done();
    await detail.close();

    await expect(timeline(page)).not.toContainText("Levelling");
  });
});

test("lists every segment on the details view and filters it", async ({ detail, ledger }) => {
  await ledger.open();
  await expect(ledger.rows).toHaveCount(3);

  // The ledger abbreviates, but not to the point of dropping what a gain came to: the
  // holding follows the currency and the standing follows the faction, in the one cell each
  // of them gets. A gain the client said nothing more about gets nothing more said.
  await test.step("a gain names what it left behind, where there was anything to name", async () => {
    await expect(ledger.cellSaying("Glass Token +4 (12,450)")).toBeVisible();
    await expect(ledger.cellSaying("Cavern Cartographers +25 (Honored)")).toBeVisible();
    await expect(ledger.cellSaying("Rustward Scrip")).not.toContainText("(");
    // One cell, both factions: the one the client could not place says only what was gained,
    // and the one it named a level for says the level even though no bar could be drawn for
    // it. The table has room for the name and never had room for the bar.
    await expect(ledger.cellSaying("Lamplighters"))
      .toHaveText("Lamplighters +10, Deepwater Wardens +40 (Exalted)");
  });

  // The ledger abbreviates but does not number: an item the addon could put no name to is
  // looked up here too, in one request for the whole table rather than a picture per cell.
  await test.step("a transmog source is named rather than numbered", async () => {
    await expect(ledger.cellSaying("Wanderer's Mantle (new)")).toBeVisible();
    await expect(ledger.view).not.toContainText("Item 101");
    // And the one this install cannot describe keeps the name the addon caught.
    await expect(ledger.cellSaying("Storm Cloak (variant)")).toBeVisible();
  });

  await ledger.search().fill("copperwood");
  await expect(ledger.rows).toHaveCount(2);

  await ledger.search().fill("");
  await ledger.character().selectOption("Aster-Vale");
  await expect(ledger.rows).toHaveCount(1);
  await expect(ledger.rows).toContainText("Glass Caverns");

  // From here the modal walks what the table is showing, which is the one row left.
  await test.step("a row opens the same detail the timeline does", async () => {
    await ledger.rows.first().click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.position()).toHaveText("1 of 1");
  });
});

/**
 * The view the other three cannot be: one where the character is the subject.
 *
 * The timeline cuts an evening across everybody who played it and the ledger's rows each
 * belong to one segment; neither can answer "what has this character been doing", which is
 * the question a player with eight alts asks first.
 */
test("gives every character a page of their own", async ({ page, roster }) => {
  await roster.open();

  // Recency, not hours: Brin-Hearth logged out last, so Brin-Hearth is who the view opens on.
  await test.step("the roster is everybody, most recently played first", async () => {
    await expect(roster.entries()).toHaveCount(2);
    await expect(roster.entries().first()).toContainText("Brin-Hearth");
    await expect(roster.entries().nth(1)).toContainText("Aster-Vale");
    await expect(page.locator("#characters-meta")).toContainText("2 characters");
    await expect(page.locator("#characters-meta")).toContainText("3 segments");
    await expect(page.locator("#characters-meta")).toContainText("1h 05m played");
  });

  // The same rail a segment row wears, for the same reason: the roster is a list of people,
  // and the colour is what tells them apart before the name has been read.
  await test.step("each of them wears their own class colour", async () => {
    await expect(railColours(roster.entries()))
      .resolves.toEqual(["rgb(255, 124, 10)", "rgb(63, 199, 235)"]);
  });

  await test.step("and the one the view opened on is the one it is showing", async () => {
    await expect(roster.entries().first()).toHaveAttribute("aria-pressed", "true");
    await expect(roster.profile.getByRole("heading", { name: "Brin-Hearth", level: 2 })).toBeVisible();
  });

  await test.step("the pane adds up everything known about them", async () => {
    await roster.pick("Aster-Vale");
    await expect(roster.profile).toContainText("Mage · level 12");
    await expect(roster.stat("Played")).toHaveText("30m");
    await expect(roster.stat("Segments")).toHaveText("1");
    await expect(roster.stat("Days")).toHaveText("1");
    await expect(roster.stat("Looted")).toHaveText("24g 50s");
    await expect(roster.profile).toContainText("Mostly in Glass Caverns");
  });

  // Two days on one character, which is the thing no session card can show: the timeline
  // files an evening under its date and this files a character under theirs.
  await test.step("their segments sit under the days they happened on", async () => {
    await roster.pick("Brin-Hearth");
    await expect(roster.stat("Days")).toHaveText("2");
    await expect(roster.days()).toHaveCount(2);
    await expect(roster.segments()).toHaveCount(2);
    await expect(roster.segments().first()).toContainText("Copperwood Depths");
    // The same summary a timeline row carries, because it is the same row.
    await expect(roster.segments().first()).toContainText("Level 9");
  });

  // The half of the story a segment cannot tell: what this character is carrying now, and
  // whether anybody on the account has already got further with a faction than they have.
  await test.step("what they are holding is read against what the account holds", async () => {
    await expect(roster.lineFor("Glass Token")).toContainText("17,550");
    await expect(roster.lineFor("Glass Token")).toContainText("30,000 across the account");
    await expect(roster.lineFor("Deepwater Wardens")).toContainText("furthest on the account");

    // The 6,000 on this line is the account's pot read from here rather than this
    // character's share of it, and unlabelled it would read as a coincidence that the alt
    // beside them holds exactly as much.
    await expect(roster.lineFor("Warband Chit")).toContainText("shared across the warband");

    await roster.pick("Aster-Vale");
    await expect(roster.lineFor("Glass Token")).toContainText("12,450");
    // Somebody else is ahead of them here, so the badge belongs to that somebody else.
    await expect(roster.lineFor("Cavern Cartographers")).not.toContainText("furthest");
    const standing = roster.profile.getByRole("progressbar", { name: /Cavern Cartographers/ });
    await expect(standing).toHaveJSProperty("value", 4200);
    await expect(standing).toHaveJSProperty("max", 12000);
  });

  // Gold is the one number the pane says twice, and the two are different kinds of thing: the
  // balance is what the addon last read off the client, the net is what every recorded segment
  // did to it and knows nothing of the gold that was there before Chronie was installed.
  await test.step("what they are carrying is drawn apart from what they earned", async () => {
    await roster.pick("Brin-Hearth");
    await expect(roster.stat("Wallet")).toHaveText("40g 0s");

    // And under it, what the roster is worth: every wallet plus the one pot they all share,
    // which is added once however many characters can reach it.
    await expect(roster.profile).toContainText("172g 50s across the account");
    await expect(roster.profile).toContainText("120g 0s in the warband bank");
  });
});

/**
 * The point of the whole thing: a segment met here is the segment met anywhere else.
 *
 * The row is the timeline's row and the modal is the timeline's modal, so a change to what a
 * segment says lands in both views at once rather than in whichever one somebody remembered.
 */
test("opens a character's segments into the same detail every other view opens", async ({
  roster,
  detail,
}) => {
  await roster.open();
  await roster.pick("Brin-Hearth");

  await test.step("a row opens the detail, walking that character's history and no more", async () => {
    await roster.segments().first().click();
    await expect(detail.title()).toHaveText("Copperwood Depths");
    // Two segments, both Brin-Hearth's — the evening the modal walks from the timeline holds
    // Aster-Vale's keystone run too, and it has no business in a character's own history.
    await expect(detail.position()).toHaveText("1 of 2");

    await detail.next();
    await expect(detail.title()).toHaveText("Copperwood");
    await expect(detail.dialog.getByRole("button", { name: "Next segment" })).toBeDisabled();
    await detail.close();
  });

  // The summary strip is the session card's, which means the chips behave the way they do
  // there: a summary standing for several things unfolds, and each of them is a way back.
  await test.step("a summary of several unfolds into them, and they lead back to the segment", async () => {
    await roster.pick("Aster-Vale");
    const achievements = roster.profile.getByRole("button", { name: /2 achievements/ });
    await expect(achievements).toHaveAttribute("aria-expanded", "false");

    await achievements.click();
    await expect(roster.profile).toContainText("Into the Light");
    await roster.profile
      .getByRole("button", { name: /Open the segment Into the Light was recorded in/ }).click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.position()).toHaveText("1 of 1");
    await detail.close();
  });
});

test("browses the game's transmog sets and dresses the character in them", async ({
  page,
  transmog,
  wardrobe,
  yours,
  outfit,
}) => {
  await transmog.open();

  await test.step("every set arrives under the collection it belongs to", async () => {
    await expect(transmog.collections()).toHaveText([
      "Duskwoven Attire · 1 set",
      "Emberforge Armory · 1 set",
      "Tideglass Wardrobe · 2 sets",
    ]);
    await expect(transmog.sets()).toHaveCount(4);
    await expect(transmog.view.getByText("4 sets shown")).toBeVisible();
  });

  await test.step("a card says who the set is for and where it came from", async () => {
    const card = transmog.card("Tideglass Regalia");
    await expect(card).toContainText("Cloth");
    await expect(card).toContainText("Cataclysm");
    await expect(card).toContainText("Patch 10.2.0");
    // Items, because items is what the game's own table counts. How many looks they come to
    // takes four more tables and is what opening the set is for.
    await expect(card).toContainText("6 items");
    // A set for nobody in particular is for everybody, and says so.
    await expect(transmog.card("Duskwoven Shroud")).toContainText("Any class");
  });

  // Coming up short is expected — the game encrypts what it has not released — so the view
  // has to say so rather than quietly show fewer sets than the game holds.
  await test.step("the sets the game keeps encrypted are accounted for", async () => {
    await expect(transmog.view.getByText(/2 sets the game keeps encrypted/)).toBeVisible();
  });

  // A set that is another set's clothes is shown once, under the set that carries it, and the
  // one shown says so. Otherwise a reader browsing the game's several thousand sets meets the
  // same wardrobe up to six times over.
  await test.step("a set holding another's appearances is shown once, and named", async () => {
    await expect(transmog.sets()).not.toContainText(["Deepglass Hide"]);
    // The name and nothing else: a faction pair is the same armour for the same classes out of
    // the same patch, so a qualifier here would repeat the chip directly above it.
    await expect(transmog.card("Tideglass Hide"))
      .toContainText("the other faction's Deepglass Hide");
    await expect(transmog.card("Tideglass Hide"))
      .not.toContainText("the other faction's Deepglass Hide · ");
    // And the grid says why it is shorter than the count above it.
    await expect(
      transmog.view.getByText(/1 set shown under another holding the same appearances/),
    ).toBeVisible();
  });

  // The whole risk of folding a set away: a reader who types its name has to find it. The
  // filters read the cluster rather than the card, so the set folded away is still reachable
  // by every route it had before — its name, its collection, and its class.
  await test.step("a folded set is still found by its own name", async () => {
    await transmog.search().fill("deepglass");
    await expect(transmog.sets()).toHaveText(["Tideglass Hide"]);
    await transmog.search().fill("");
    await expect(transmog.sets()).toHaveCount(4);
  });

  // The character is there before a single set has been touched, which is the shape of this
  // view: the body is the view, rather than something a dialog opens over it.
  await test.step("the character is on screen before anything has been picked", async () => {
    await expect(outfit.summary()).toHaveText("Nothing on yet. Pick an appearance from any set.");
    await expect(outfit.note())
      .toHaveText("Nothing is worn. Drag to turn it, right-drag to move it.");
    await expect(outfit.canvas()).toBeVisible();

    // 12 × 96: the fixture body holds twenty-five geosets and a bare one draws thirteen of
    // them — one per group, plus the hairstyle that shares the skin's — of which twelve reach
    // the picture, because the eye glow is composited by adding and glTF cannot write that.
    // Every part is drawn out of the same list, which is 96 of the model's 200 vertices: the
    // ones those twelve parts reach between them, and all the `.glb` now carries. Which makes
    // this the geoset selection, counted from the far end of the pipe: a variant drawn
    // alongside its default reads as thirteen parts rather than twelve, and a default that
    // went missing as eleven. Two of the twelve are her head and her ears, which nothing but
    // her own customization asks for.
    await expect(outfit.stage()).toHaveAttribute("data-vertices", "1152");
  });

  // The one thing zoom on its own cannot do. Magnified far enough to look at a boot, the head
  // is somewhere off the top of the pane, and turning is no way back to it — an orbit moves
  // the camera and never what it is pointed at. So the right button moves the model, and the
  // button over the corner of the stage puts it back where framing it left it.
  await test.step("the model can be moved as well as turned, and put back", async () => {
    const framed = await outfit.framing();
    expect(framed.target).toBe("0.000,0.000,0.000");
    expect(framed.camera).not.toBe("");

    // Turning first, and it is exactly the half that was never enough: the camera goes
    // somewhere else and the middle of the pane stays on the middle of the model.
    await outfit.drag("left", 90, 0);
    await expect.poll(() => outfit.stage().getAttribute("data-camera")).not.toBe(framed.camera);
    expect((await outfit.framing()).target).toBe(framed.target);

    // And the right button, which is the change: what the camera is pointed at moves.
    await outfit.drag("right", 70, 45);
    await expect.poll(() => outfit.stage().getAttribute("data-target")).not.toBe(framed.target);

    // Back to the framing, to the digit — a reset that lands near where it started is a
    // reader still hunting for the model, which is the thing this is here to end.
    await outfit.resetCamera();
    await expect(outfit.stage()).toHaveAttribute("data-camera", framed.camera);
    await expect(outfit.stage()).toHaveAttribute("data-target", framed.target);
  });

  await test.step("the search reaches the collection as well as the set", async () => {
    await transmog.search().fill("tideglass");
    await expect(transmog.sets()).toHaveText(["Tideglass Regalia", "Tideglass Hide"]);
    await expect(transmog.collections()).toHaveCount(1);
    await transmog.search().fill("");
    await expect(transmog.sets()).toHaveCount(4);
  });

  // Everything the card itself shows is searchable, because a reader looking at
  // "Plate · Mists of Pandaria" and wanting more like it types one of those words rather
  // than going hunting for the dropdown that holds it.
  await test.step("the search reaches the metadata the card shows", async () => {
    await transmog.search().fill("plate");
    await expect(transmog.sets()).toHaveText(["Emberforge Plate"]);
    await transmog.search().fill("cloth cataclysm");
    await expect(transmog.sets()).toHaveText(["Tideglass Regalia"]);
    await transmog.search().fill("");
  });

  await test.step("expansion and class narrow it together", async () => {
    await transmog.expansion().selectOption({ label: "Cataclysm" });
    await expect(transmog.sets()).toHaveCount(2);

    await transmog.klass().selectOption({ label: "Priest" });
    await expect(transmog.sets()).toHaveText(["Tideglass Regalia"]);
  });

  await test.step("a set no class owns survives a class filter", async () => {
    await transmog.expansion().selectOption({ label: "All expansions" });
    await expect(transmog.sets()).toHaveText(["Duskwoven Shroud", "Tideglass Regalia"]);
  });

  await test.step("a filter that matches nothing says so", async () => {
    await transmog.search().fill("nothing like it");
    await expect(transmog.browser.getByText("Nothing matches")).toBeVisible();
    await expect(transmog.sets()).toHaveCount(0);
  });

  // The acceptance for the whole redesign: six items, three looks, and a list one row per
  // look rather than one row per thing that happens to wear the model.
  await test.step("a set opens on its looks rather than on its items", async () => {
    await transmog.search().fill("");
    await transmog.klass().selectOption("");
    await expect(transmog.card("Tideglass Regalia")).toContainText("6 items");

    await transmog.openSet("Tideglass Regalia");
    await expect(transmog.rows("Tideglass Regalia")).toHaveCount(3);
    // And the sentence that explains why a card promising six opened as a list of three.
    //
    // Five items rather than the card's six, and both are right. The card counts rows of
    // `TransmogSetItem`, which is all the grid has; this counts the items those rows reach,
    // and one of the six is the game naming a single item twice. The refined number is the
    // one worth printing next to the list it describes.
    await expect(transmog.card("Tideglass Regalia"))
      .toContainText("3 appearances from 5 items");
    // And the sets beside it are still there, which is what a dialog took away.
    await expect(transmog.sets()).toHaveCount(4);
  });

  // The names come out of a fifth table, the one whose records vary in length — so a row
  // reading as an item rather than as a number is what says that reader works end to end.
  await test.step("every appearance says which slot it fills and leads to the item", async () => {
    await expect(transmog.rows("Tideglass Regalia"))
      .toContainText(["Head", "Shoulder", "Chest"]);
    await expect(transmog.rows("Tideglass Regalia")).toContainText([
      "Tideglass Crown", "Tideglass Mantle", "Tideglass Robe",
    ]);
    await expect(transmog.link("Tideglass Regalia", "Tideglass Mantle"))
      .toHaveAttribute("href", "https://www.wowhead.com/item=30002");

    // A link out of the window has to reach the reader's browser the way every other one does.
    await transmog.link("Tideglass Regalia", "Tideglass Mantle").click();
    await expect.poll(() => openedUrls(page)).toContain("https://www.wowhead.com/item=30002");
  });

  // Nothing is lost by collapsing: every item is still there, one click further in, and the
  // row says how many before it is asked. Three items give the robe's look and the row is
  // named after the one closest to the set's own name rather than after whichever the backend
  // listed first.
  await test.step("a row opens on every item that gives its look", async () => {
    await expect(transmog.sourcesToggle("Tideglass Regalia", 2)).toBeVisible();
    await transmog.sourcesToggle("Tideglass Regalia", 2).click();

    // Whatever anybody can wear first, then the cheapest way in, then the class-locked one —
    // which is the order of the question the list is open for.
    await expect(transmog.sources("Tideglass Regalia", "Tideglass Robe")).toHaveText([
      /Tideglass Robe/,
      /Sea-Touched Vestment/,
      /Robe of the Tideglass Court/,
    ]);
    // Only the facts that differ between them, and here all three do.
    await expect(transmog.sources("Tideglass Regalia", "Tideglass Robe").last())
      .toContainText("Priest");
    await expect(transmog.sources("Tideglass Regalia", "Tideglass Robe").nth(1))
      .toContainText("Level 45");
    // And each is still its own item, with its own way out of the app.
    await expect(transmog.link("Tideglass Regalia", "Sea-Touched Vestment"))
      .toHaveAttribute("href", "https://www.wowhead.com/item=30031");

    // Collapsing a look does not put it on or take it off: the row above is still the button.
    await expect(transmog.rows("Tideglass Regalia")).toHaveCount(3);
  });

  // The one fact a row volunteers without being opened, and the most useful thing this view
  // can say: a reader whose class cannot wear the set's own version of a look can still have
  // the look. Nothing else on the row would ever tell them so.
  await test.step("a look sold to everybody as well as to one class says so", async () => {
    await expect(transmog.card("Tideglass Regalia").getByText("Any class too")).toHaveCount(1);
    // The head is one item and says nothing of the kind.
    const head = transmog.rows("Tideglass Regalia").first();
    await expect(head).not.toContainText("Any class too");
  });

  // The pictures come out of the game's own textures, and they arrive after the rows do —
  // so what is checked here is that every row ends up carrying one, not that it had one the
  // moment the list appeared.
  await test.step("every appearance carries the game's own picture of it", async () => {
    await expect(transmog.iconFrames("Tideglass Regalia")).toHaveCount(3);
    await expect(transmog.icons("Tideglass Regalia")).toHaveCount(3);
    // One per look now, and three different ones: the pictures were the clearest sign of the
    // old shape, where a set naming one appearance twice drew the same texture twice.
    const sources = await transmog.icons("Tideglass Regalia").evaluateAll(
      (images) => images.map((image) => (image as HTMLImageElement).currentSrc),
    );
    expect(new Set(sources).size).toBe(3);
    for (const source of sources) expect(source).toContain("data:image/png;base64,");

    // Decoded, not merely fetched: a data url the browser could not read would leave the
    // element with no intrinsic size at all.
    const widths = await transmog.icons("Tideglass Regalia").evaluateAll(
      (images) => images.map((image) => (image as HTMLImageElement).naturalWidth),
    );
    expect(widths).toEqual([8, 8, 8]);
  });

  // The change this whole view was rebuilt for: an appearance clicked in a set goes onto the
  // body, and the body is still there with the set still open behind it.
  await test.step("picking an appearance puts it on the character", async () => {
    // Clicked by the item's own name, which is the largest thing on the row and the one a
    // reader aims at — and which used to be the link out, so that the one part of the row
    // anybody would click was the one part that did not dress her.
    await transmog.name("Tideglass Regalia", "Tideglass Robe").click();
    await expect(outfit.slots()).toHaveText([/Chest.*Tideglass Robe.*Tideglass Regalia/s]);
    await expect(outfit.summary()).toHaveText("1 of 13 slots filled");
    await expect(outfit.note())
      .toHaveText("Worn on the character. Drag to turn it, right-drag to move it.");

    // A body, not the item: 12 × 96, the same one part per geoset group a bare character
    // draws, out of the vertices those parts share. A robe that arrived as geometry of its
    // own would be a mesh of its own beside them.
    await expect(outfit.stage()).toHaveAttribute("data-vertices", "1152");

    // And the armour has a colour on it. Geometry was all this ever asked for, and geometry
    // is the half that was never in doubt: a body with every texture refused draws the exact
    // shape of the robe in flat white and answers 1152 to the line above.
    //
    // The refusing is the page's Content Security Policy. A `.glb` carries its pictures
    // inside itself, three.js hands each one to the browser as a `blob:` URL, and a policy
    // naming neither `blob:` nor a wildcard turns every one of them away — through
    // `connect-src`, because the loader fetches them rather than pointing an `<img>` at them.
    //
    // Which is why this is here and not in a unit test. The atlas is right, the UVs read it,
    // the `.glb` carries it, and every one of those can be checked without a browser. The
    // only place the picture is refused is a real page under the real policy.
    // Two of them: the composited body atlas, and the hair's own — which is the picture that
    // stands between a hairstyle and a white cap on her head.
    await expect(outfit.stage()).toHaveAttribute("data-pictures", "2");
    await expect(outfit.stage()).toHaveAttribute("data-blank", "0");
  });

  // And the other half of that bargain: the corner of the row is the only part of it that
  // leaves. Taking it hands the url to the operating system and leaves her dressed exactly as
  // she was, rather than taking the piece back off on the way out.
  await test.step("the corner of a row leaves for Wowhead without undressing her", async () => {
    // The shoulder, which one item gives. The robe's row has no corner of its own — three
    // items give that look and none of them is the one the row means — and its items carry
    // their own, which the step above followed.
    await transmog.link("Tideglass Regalia", "Tideglass Mantle").click();
    await expect.poll(() => openedUrls(page)).toContain("https://www.wowhead.com/item=30002");
    await expect(outfit.slots()).toHaveText([/Chest.*Tideglass Robe.*Tideglass Regalia/s]);
  });

  // And the acceptance for the redesign itself: a piece out of one set and a piece out of
  // another, on one body at once, with both sets open behind them. A dialog made this the
  // hard way round — the first set had to be closed before the second could be reached.
  await test.step("pieces from two different sets go on at the same time", async () => {
    await transmog.openSet("Emberforge Plate");
    await transmog.wear("Emberforge Plate", "Head", "Emberforge Helm").click();
    await expect(outfit.slots()).toHaveText([
      /Head.*Emberforge Helm.*Emberforge Plate/s,
      /Chest.*Tideglass Robe.*Tideglass Regalia/s,
    ]);
    await expect(transmog.rows("Tideglass Regalia")).toHaveCount(3);
    // Five of that set's six: the sixth is filed under a weapon slot with nothing saying a
    // hand, so it has nowhere on her to go and is left out until somebody asks for it.
    await expect(transmog.rows("Emberforge Plate")).toHaveCount(5);

    // A body *and* a helm: 11 × 88 for the body — one part fewer than bare, because the helm
    // covers the hair, and eight vertices fewer between them for the same reason — plus the
    // helm's own eight. Two nodes in one scene is the shape the converter gained for that, and
    // a loader reading only the first would say 968.
    await expect(outfit.stage()).toHaveAttribute("data-vertices", "976");
  });

  // A place holds one thing. Two sets' shoulders are two different appearances for the same
  // pair of shoulders, so the second takes them rather than going on over the first — which
  // is what a reader trying pauldrons expects.
  await test.step("a second thing for the same place swaps rather than stacks", async () => {
    await transmog.wear("Tideglass Regalia", "Shoulder", "Tideglass Mantle").click();
    await expect(outfit.slots()).toHaveCount(3);
    await transmog.wear("Emberforge Plate", "Shoulder", "Emberforge Pauldrons").click();
    await expect(outfit.slots()).toHaveText([
      /Head.*Emberforge Helm/s,
      /Shoulder.*Emberforge Pauldrons.*Emberforge Plate/s,
      /Chest.*Tideglass Robe/s,
    ]);
  });

  // And clicking the row that put a piece on takes it off again, which is how one comes off
  // without going over to the list beside the character.
  await test.step("clicking the same row again takes that piece off", async () => {
    await transmog.wear("Emberforge Plate", "Shoulder", "Emberforge Pauldrons").click();
    await expect(outfit.slots()).toHaveCount(2);
    await transmog.wear("Emberforge Plate", "Shoulder", "Emberforge Pauldrons").click();
    await expect(outfit.slots()).toHaveCount(3);
  });

  // A set is a set of clothes, and looking at all of it at once is the ordinary thing to
  // want; clicking six rows to get there is not.
  await test.step("a whole set goes on in one go", async () => {
    await transmog.wearAll("Emberforge Plate").click();
    // Five of its six rows: the sixth is an item the game withholds, so nothing says a hand.
    await expect(outfit.slots()).toHaveText([
      /Head.*Emberforge Helm/s,
      /Shoulder.*Emberforge Pauldrons/s,
      /Chest.*Emberforge Breastplate/s,
      /Legs.*Emberforge Greaves/s,
      /Main hand.*Emberforge Blade/s,
    ]);
    await expect(outfit.summary()).toHaveText("5 of 13 slots filled");
    await expect(outfit.stage()).toHaveAttribute("data-vertices", "976");
  });

  // "On screen at all times" is not a figure of speech: a wardrobe of several thousand sets
  // is scrolled through, and the character has to still be there at the bottom of it. A
  // window short enough that the grid has somewhere to scroll to is what makes that a fact
  // about the app rather than about there being nothing to scroll.
  await test.step("the character stays on screen however far the sets are scrolled", async () => {
    await page.setViewportSize({ width: 1100, height: 400 });
    await transmog.scrollToEnd();
    expect(await transmog.scrollOffset()).toBeGreaterThan(0);
    await expect(outfit.panel).toBeInViewport();
    await expect(outfit.slots()).toHaveCount(5);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await test.step("closing a set hands back the grid, filters and all", async () => {
    await transmog.closeSet("Emberforge Plate");
    await transmog.closeSet("Tideglass Regalia");
    await expect(transmog.sets()).toHaveCount(4);
    await expect(transmog.klass()).toHaveValue("");
    await expect(transmog.search()).toHaveValue("");
    // And what she has on outlives every set it was assembled from, which is the whole point
    // of the outfit living beside the sets rather than inside one of them.
    await expect(outfit.slots()).toHaveCount(5);
  });

  await test.step("a piece comes off again and the rest stays on", async () => {
    await outfit.takeOff("Emberforge Helm");
    await expect(outfit.slots()).toHaveCount(4);

    await outfit.clear();
    await expect(outfit.slots()).toHaveCount(0);
    await expect(outfit.summary()).toHaveText("Nothing on yet. Pick an appearance from any set.");
    await expect(outfit.stage()).toHaveAttribute("data-vertices", "1152");
  });

  // An appearance the game encrypts is one of the two there is nowhere on her to put, so the
  // list leaves it out — and the card still accounts for it, because its own count includes
  // it and a list shorter than the number above it is what a reader would have to explain.
  await test.step("an appearance the game withholds is left out, and counted", async () => {
    await transmog.openSet("Duskwoven Shroud");
    await expect(transmog.rows("Duskwoven Shroud")).toHaveCount(1);
    await expect(transmog.card("Duskwoven Shroud"))
      .toContainText("2 appearances · 1 the game keeps encrypted");
    await expect(transmog.card("Duskwoven Shroud"))
      .toContainText("1 appearance hidden, with nowhere on her to go");
  });

  // And the box is for the reader who wants to see what a set is really made of: the row it
  // can say nothing about comes back, and says so where its name would be.
  await test.step("unticking the box hands back the rows a set really holds", async () => {
    await transmog.hideUnwearable().uncheck();
    await expect(transmog.rows("Duskwoven Shroud")).toHaveCount(2);
    await expect(transmog.card("Duskwoven Shroud"))
      .toContainText("The game keeps this appearance encrypted");
    // The other row got as far as an item and no further: the game encrypts that item's own
    // row too, so it is named by its id rather than left as a blank beside a slot.
    await expect(transmog.link("Duskwoven Shroud", "Item 30011"))
      .toHaveAttribute("href", "https://www.wowhead.com/item=30011");

    // One row names a texture this install does not hold and the other names none at all,
    // so neither has a picture to show — and both still keep the frame, so the list reads as
    // a column of icons with two blanks rather than as two rows that lost their indent.
    await expect(transmog.iconFrames("Duskwoven Shroud")).toHaveCount(2);
    await expect(transmog.icons("Duskwoven Shroud")).toHaveCount(0);
  });

  // The one row of that set the game does give a place for names a display it keeps
  // encrypted, so this install has nothing to put on her — which is a sentence and a bare
  // list rather than an error where the wardrobe was.
  await test.step("an outfit this install can show nothing for says so", async () => {
    await transmog.wear("Duskwoven Shroud", "Chest", "Item 30011").click();
    await expect(outfit.slots()).toHaveCount(1);
    await expect(outfit.note())
      .toHaveText("This install holds nothing to put on the character for these.");
    await expect(outfit.canvas()).toBeHidden();
    await transmog.closeSet("Duskwoven Shroud");
    await outfit.clear();
  });

  // The other appearance in the fixtures with nowhere on a body to go: it is filed under a
  // weapon slot and nothing says which hand — and a button that did nothing when clicked
  // would be worse than one that says why it cannot. The box is still unticked from the step
  // above, which is what a set opened afterwards has to obey as well.
  await test.step("an appearance there is nowhere to put says so instead of going on", async () => {
    await transmog.openSet("Emberforge Plate");
    await expect(transmog.rows("Emberforge Plate")).toHaveCount(6);
    await expect(transmog.card("Emberforge Plate"))
      .toContainText("The game gives this appearance no place on a character.");
    await expect(transmog.wear("Emberforge Plate", "Weapon or shield", "Item 30017")).toBeDisabled();
  });

  // And ticking it again takes that row back out of an open set, which is the half that says
  // the box governs what is drawn rather than having only reached the set once.
  await test.step("ticking the box again puts the placeless row away", async () => {
    await transmog.hideUnwearable().check();
    await expect(transmog.rows("Emberforge Plate")).toHaveCount(5);
    await expect(transmog.wear("Emberforge Plate", "Weapon or shield", "Item 30017"))
      .toHaveCount(0);
    await expect(transmog.card("Emberforge Plate"))
      .toContainText("1 appearance hidden, with nowhere on her to go");
  });

  /* ---------- the other half: every look the game has, set or no set ---------- */

  // What the switch is for. A set is somebody at Blizzard's idea of an outfit, and the Coif
  // belongs to none — so no card in the grid behind this could ever have reached it.
  await test.step("browsing by item reaches a look no set holds", async () => {
    await transmog.wear("Emberforge Plate", "Head", "Emberforge Helm").click();
    await expect(outfit.slots()).toHaveCount(1);

    await transmog.browseBy("Items");
    await expect(wardrobe.names()).toHaveText([
      "Coif of the Drowned Star", "Emberforge Helm", "Tideglass Crown",
    ]);
    await expect(wardrobe.count()).toHaveText("3 appearances · 1 look the game keeps encrypted");
  });

  // And what the switch does not do: she keeps what she has on. The helm went on out of a
  // set and the list says so too — one look, however it was reached.
  await test.step("what she has on survives the switch, and the list knows it", async () => {
    await expect(outfit.slots()).toHaveText([/Head.*Emberforge Helm.*Emberforge Plate/s]);
    await expect(wardrobe.wear("Head", "Emberforge Helm")).toHaveAttribute("aria-pressed", "true");
    await expect(wardrobe.wear("Head", "Coif of the Drowned Star"))
      .toHaveAttribute("aria-pressed", "false");
  });

  await test.step("a look out of the wardrobe goes on her, and names no set", async () => {
    await wardrobe.wear("Head", "Coif of the Drowned Star").click();
    await expect(outfit.slots()).toHaveText([/Head.*Coif of the Drowned Star/s]);
    // Nothing came out of a set, so nothing claims one: the line where a set's name goes is
    // absent rather than blank.
    await expect(outfit.provenance()).toHaveCount(0);
    await expect(outfit.stage()).toHaveAttribute("data-vertices", "976");
  });

  // The reason the browser reads what kind of thing an item is at all: the game files a
  // staff, a two-handed sword and a one-handed axe under one display type, so a picker built
  // on the game's own numbering could offer none of them.
  await test.step("one kind of weapon is picked out of everything held in a hand", async () => {
    await wardrobe.kind().selectOption({ label: "Staff" });
    await expect(wardrobe.names()).toHaveText(["Staff of the Quiet Tide"]);

    await wardrobe.kind().selectOption({ label: "One-handed sword" });
    await expect(wardrobe.names()).toHaveText(["Emberforge Blade"]);

    // A shield arrives in the same answer as those two and is not a weapon at all in the
    // game's filing — it is armour — so the kind that finds it is reading the item.
    await wardrobe.kind().selectOption({ label: "Shield" });
    await expect(wardrobe.names()).toHaveText(["Emberforge Aegis"]);
  });

  await test.step("a look out of one kind and a look out of another go on at once", async () => {
    await wardrobe.kind().selectOption({ label: "Staff" });
    await wardrobe.wear("Two-hand", "Staff of the Quiet Tide").click();
    await expect(outfit.slots()).toHaveText([
      /Head.*Coif of the Drowned Star/s,
      /Main hand.*Staff of the Quiet Tide/s,
    ]);
  });

  await test.step("a kind narrows by name and by class like the sets do", async () => {
    await wardrobe.kind().selectOption({ label: "Head" });
    await wardrobe.search().fill("coif");
    await expect(wardrobe.names()).toHaveText(["Coif of the Drowned Star"]);

    await wardrobe.search().fill("");
    // The Tideglass Crown is the one head of the three that any class may not wear.
    await wardrobe.klass().selectOption({ label: "Warrior" });
    await expect(wardrobe.names()).toHaveText(["Coif of the Drowned Star", "Emberforge Helm"]);
    await wardrobe.klass().selectOption("");
  });

  // And back again, with both halves as they were left: the sets keep their filters, the
  // wardrobe keeps its kind, and she keeps what was assembled out of the two of them.
  await test.step("switching back hands the sets over unchanged", async () => {
    await transmog.browseBy("Sets");
    await expect(transmog.rows("Emberforge Plate")).toHaveCount(5);
    await expect(outfit.slots()).toHaveCount(2);

    await transmog.browseBy("Items");
    await expect(wardrobe.kind()).toHaveValue("armour-0");
    await expect(wardrobe.names()).toHaveCount(3);
  });

  /* ---------- and the one thing on this screen that is the reader's ---------- */

  // Everything above is read out of the installed game and is the same for anybody on this
  // build. What follows is not: it is what this person said about it, and it comes out of
  // Chronie's own database.
  await test.step("what was said about a look before is on it now", async () => {
    await expect(wardrobe.tags("Coif of the Drowned Star")).toHaveText(["wishlist"]);
    // And nothing was said about its neighbours, which is the ordinary case.
    await expect(wardrobe.tags("Emberforge Helm")).toHaveCount(0);
    await expect(wardrobe.star("Emberforge Helm")).toHaveAttribute("aria-pressed", "false");
  });

  // The whole argument for marking the *appearance* rather than the item or the set that
  // named it: the two halves of this browser are looking at one wardrobe, so a look starred
  // in the list is starred in the set that holds it.
  await test.step("a look starred here is starred inside the set that holds it", async () => {
    await wardrobe.star("Emberforge Helm").click();
    await expect(wardrobe.star("Emberforge Helm")).toHaveAttribute("aria-pressed", "true");

    await transmog.browseBy("Sets");
    await expect(transmog.rowStar("Emberforge Plate", "Emberforge Helm"))
      .toHaveAttribute("aria-pressed", "true");
    // The set it sits in was not starred by starring what is in it.
    await expect(transmog.star("Emberforge Plate")).toHaveAttribute("aria-pressed", "false");
  });

  await test.step("a set takes a tag with a value, and one without as a label", async () => {
    await tagIt(transmog.card("Emberforge Plate"), "Emberforge Plate", "faction", "horde");
    await expect(transmog.tags("Emberforge Plate")).toHaveText(["faction: horde"]);

    await tagIt(transmog.card("Emberforge Plate"), "Emberforge Plate", "wishlist");
    await expect(transmog.tags("Emberforge Plate")).toHaveText(["faction: horde", "wishlist"]);
  });

  await test.step("the grid narrows to one tag, and offers only the tags in use", async () => {
    await expect(transmog.tagFilter().getByRole("option")).toHaveText([
      "Any tag", "faction", "faction: horde", "wishlist",
    ]);

    await transmog.tagFilter().selectOption("faction\thorde");
    await expect(transmog.sets()).toHaveText(["Emberforge Plate"]);

    await transmog.tagFilter().selectOption("");
    await expect(transmog.sets()).toHaveCount(4);
  });

  // The word rather than the picker, which is how somebody who can see the chip narrows to
  // it without learning where the dropdown is.
  await test.step("the search box reads the tags too", async () => {
    await transmog.search().fill("horde");
    await expect(transmog.sets()).toHaveText(["Emberforge Plate"]);
    await transmog.search().fill("");
  });

  // Only 205 was starred, in the fixture, and nothing done since has starred a second set —
  // starring the helm above starred a look.
  await test.step("the grid narrows to the starred sets", async () => {
    await transmog.favouritesOnly().check();
    await expect(transmog.sets()).toHaveText(["Duskwoven Shroud"]);
    await expect(transmog.star("Duskwoven Shroud")).toHaveAttribute("aria-pressed", "true");

    await transmog.favouritesOnly().uncheck();
    await expect(transmog.sets()).toHaveCount(4);
  });

  await test.step("a tag comes off from the chip it is written on", async () => {
    await transmog.card("Emberforge Plate")
      .getByRole("button", { name: "Remove the tag wishlist from Emberforge Plate", exact: true })
      .click();
    await expect(transmog.tags("Emberforge Plate")).toHaveText(["faction: horde"]);
    // And the picker forgets the choice nothing carries any more.
    await expect(transmog.tagFilter().getByRole("option")).toHaveText([
      "Any tag", "faction", "faction: horde",
    ]);
  });

  await test.step("and a star comes off again, leaving the grid whole", async () => {
    await transmog.star("Duskwoven Shroud").click();
    await expect(transmog.star("Duskwoven Shroud")).toHaveAttribute("aria-pressed", "false");

    await transmog.favouritesOnly().check();
    await expect(transmog.sets()).toHaveCount(0);
    await transmog.favouritesOnly().uncheck();
  });

  /* ---------- and the sets the reader makes out of all of it ---------- */

  // The point of the whole arrangement above. The outfit on her now is a helm out of the
  // game's wardrobe and a staff out of it, and until this it lasted exactly as long as the
  // window did.
  await test.step("what she has on is saved as a set of the reader's own", async () => {
    await transmog.browseBy("Yours");
    await expect(yours.list.getByText("No sets of your own yet")).toBeVisible();

    await outfit.saveAs("  Deeps  run ");

    // Tidied by the backend and named by what came back, rather than by what was typed.
    await expect(yours.names()).toHaveText(["Deeps run"]);
    await expect(yours.card("Deeps run")).toContainText("2 pieces");
    // Saving is a note taken, not a door closed: she is still wearing it.
    await expect(outfit.slots()).toHaveCount(2);
  });

  await test.step("a saved set lists the looks it was made of", async () => {
    await expect(yours.card("Deeps run").getByRole("listitem")).toHaveCount(2);
    await expect(yours.wear("Deeps run", "Head", "Coif of the Drowned Star")).toBeVisible();
    await expect(yours.wear("Deeps run", "Two-hand", "Staff of the Quiet Tide")).toBeVisible();
  });

  // The whole round trip, and the only claim worth making about a saved set: it goes back on,
  // out of the database, exactly as it went in.
  await test.step("the character is dressed in a saved set again from nothing", async () => {
    await outfit.clear();
    await expect(outfit.slots()).toHaveCount(0);

    await yours.wearAll("Deeps run").click();

    await expect(outfit.slots()).toHaveText([
      /Head.*Coif of the Drowned Star.*Deeps run/s,
      /Main hand.*Staff of the Quiet Tide.*Deeps run/s,
    ]);
    // The same body the two looks asked for when they were picked out of the game itself: the
    // outfit is keyed by its display ids, so a body arriving at all says the saved set asked
    // for the same one, and nothing was lost on the way through Chronie's own storage.
    await expect(outfit.stage()).toHaveAttribute("data-vertices", "2208");
  });

  await test.step("one piece of a saved set goes on without the rest of it", async () => {
    await outfit.clear();
    await yours.wear("Deeps run", "Head", "Coif of the Drowned Star").click();
    await expect(outfit.slots()).toHaveCount(1);
  });

  // Names are unique without regard to case, so a name already used saves over that set —
  // and the button says which of the two it is about to do before it is clicked.
  await test.step("typing a name already used offers to replace that set", async () => {
    await outfit.name().fill("deeps RUN");
    await expect(outfit.keep()).toHaveText("Replace Deeps run");

    await outfit.keep().click();

    // One set still, holding the one piece she has on now.
    await expect(yours.names()).toHaveText(["deeps RUN"]);
    await expect(yours.card("deeps RUN").getByRole("listitem")).toHaveCount(1);
  });

  // The issue's other half: a set of the reader's own takes any mark a Blizzard set takes,
  // because it is a third kind of subject rather than a second feature.
  await test.step("a saved set is starred and tagged like one the game ships", async () => {
    await yours.star("deeps RUN").click();
    await expect(yours.star("deeps RUN")).toHaveAttribute("aria-pressed", "true");

    await tagIt(yours.card("deeps RUN"), "deeps RUN", "for", "the alt");
    await expect(yours.tags("deeps RUN")).toHaveText(["for: the alt"]);

    await yours.tagFilter().selectOption("for\tthe alt");
    await expect(yours.names()).toHaveText(["deeps RUN"]);
    await yours.tagFilter().selectOption("");
  });

  // Which of their own sets has the staff in it is a question neither browser beside this one
  // could answer, because neither of them is about what the reader put together.
  await test.step("a saved set is found by what is in it", async () => {
    await yours.search().fill("coif");
    await expect(yours.names()).toHaveText(["deeps RUN"]);

    await yours.search().fill("aegis");
    await expect(yours.names()).toHaveCount(0);
    await expect(yours.list.getByText("Nothing matches")).toBeVisible();
    await yours.search().fill("");
  });

  await test.step("and a saved set is thrown away, after being asked twice", async () => {
    await yours.card("deeps RUN")
      .getByRole("button", { name: "Delete deeps RUN", exact: true }).click();
    // The first click only asks: the set is still there, with a way back out of it.
    await expect(yours.names()).toHaveText(["deeps RUN"]);
    await yours.card("deeps RUN").getByRole("button", { name: "Keep it", exact: true }).click();
    await expect(yours.names()).toHaveText(["deeps RUN"]);

    await yours.delete("deeps RUN");

    await expect(yours.names()).toHaveCount(0);
    await expect(yours.list.getByText("No sets of your own yet")).toBeVisible();
    // What she has on is untouched by the set that held it going away.
    await expect(outfit.slots()).toHaveCount(1);
  });
});

/**
 * Writes a tag against whatever is being marked, the way a reader does: open the little form,
 * fill it in, submit it. `host` is the card or the row it belongs to.
 *
 * The value is optional here because it is optional there — a tag with nothing in that box is
 * a label, which is half of what marking is for.
 */
async function tagIt(host: Locator, name: string, key: string, value = ""): Promise<void> {
  await host.getByRole("button", { name: `Tag ${name}`, exact: true }).click();
  await host.getByLabel(`Tag name for ${name}`, { exact: true }).fill(key);
  if (value) await host.getByLabel(`Tag value for ${name} (optional)`, { exact: true }).fill(value);
  await host.getByRole("button", { name: "Add", exact: true }).click();
}

test("drives settings, sync, addon installation, and app update checks", async (
  { page, combat, retention, captureSettings },
) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Game folder")).toHaveValue("C:\\Games\\Example MMO\\_retail_");

  await page.getByRole("button", { name: "Browse…" }).click();
  await expect(page.getByLabel("Game folder")).toHaveValue("D:\\Games\\Example MMO");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#setup-status")).toHaveText("Game folder saved.");

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator("#setup-status")).toContainText("3 segments, 1 new");

  await page.getByRole("button", { name: "Install or update addon" }).click();
  await expect(page.locator("#setup-status")).toContainText("0.8.0-dev installed");

  await page.getByRole("button", { name: "Check for app update" }).click();
  await expect(page.locator("#setup-status")).toHaveText("Chronie is up to date.");

  // The rules the addon acts on, which are the reason this category exists. What is on screen
  // has to be what the install is running — a panel of unticked boxes on an install that
  // photographs account firsts is telling somebody the opposite of what is happening.
  await test.step("the screenshot rules show what the install is actually running", async () => {
    await captureSettings.open();

    await expect(captureSettings.trigger(/An achievement nobody on this account had/))
      .toBeChecked();
    await expect(captureSettings.trigger(/Every achievement this character earns/))
      .not.toBeChecked();
    await expect(captureSettings.state()).toContainText("one kind of moment");
    await expect(captureSettings.state()).toContainText("at most one a minute");
  });

  await test.step("ticking a rule saves the whole list", async () => {
    await captureSettings.trigger(/A mount added to the collection/).check();

    await expect(captureSettings.state()).toContainText("2 kinds of moment");
    // The unrecognised name is still there: the panel writes the whole list from its own
    // boxes, and a settings file somebody edited by hand must survive being written over.
    await expect(captureSettingsStored(page)).resolves.toMatchObject({
      triggers: ["accountFirstAchievement", "mount", "somethingNewer"],
    });
    await expect(captureSettings.panel).toContainText("somethingNewer");
  });

  // The addon offers a moment to the narrow rule first and the broad one second, so ticking
  // the broad one leaves the narrow one doing nothing on its own. Two ticked boxes where one
  // is inert is a state somebody would otherwise sit and stare at.
  await test.step("and says when a broader rule already covers a narrower one", async () => {
    await captureSettings.trigger(/Every achievement this character earns/).check();

    await expect(captureSettings.panel)
      .toContainText("Already covered by “Every achievement this character earns”");
    await expect(captureSettings.trigger(/An achievement nobody on this account had/))
      .toBeChecked();
  });

  // The half of the panel the desktop app acts on rather than the game. The default is a
  // re-encode, because the store is forever and the client writes megabytes a shot.
  await test.step("what is kept of a picture is a choice, and the default is not the raw file", async () => {
    await expect(captureSettings.quality(/Fits a retina display/)).toBeChecked();
    await expect(captureSettings.panel).toContainText("2560 pixels on the long side");
    await expect(captureSettings.panel)
      .toContainText("Nothing already in the store is re-compressed");

    await captureSettings.quality(/Exactly what the game wrote/).check();

    await expect(captureSettingsStored(page)).resolves.toMatchObject({ quality: "original" });
  });

  // The two opposite risks: a folder that never stops growing, and a folder somebody has
  // curated for years losing files. Which one is running has to be on screen.
  await test.step("and so is whether the game keeps its own copy", async () => {
    await expect(captureSettings.panel)
      .toContainText("Chronie deletes the game’s copy once it holds a verified one of its own.");

    await captureSettings.originals().check();

    await expect(captureSettings.panel).toContainText("its Screenshots folder goes on growing");
    await expect(captureSettingsStored(page)).resolves.toMatchObject({
      quality: "original",
      keepOriginals: true,
    });
  });

  // What a combat log costs has to be readable before anybody ticks the box, not after the
  // first raid night has filled a disk — so the warning being on screen beside an untouched
  // switch is the thing asserted, rather than anything that happens once it is on.
  await test.step("combat logging is off, and says what turning it on would cost", async () => {
    await combat.open();
    await expect(combat.toggle()).not.toBeChecked();
    await expect(combat.state())
      .toHaveText("Combat logging is off. Nothing is being written and nothing is using disk.");
    await expect(combat.panel).toContainText("a raid night is hundreds of megabytes");
    await expect(combat.panel)
      .toContainText("Chronie deletes nothing out of the game's Logs folder unless the panel");
    await expect(combatLoggingSetting(page)).resolves.toBe(false);
  });

  // Ticking it moves the setting and nothing else: the game's own config already has advanced
  // logging on, and no log has been written, so what the install honestly is now is set up
  // and waiting — which is what the panel has to say rather than "on".
  await test.step("ticking it turns the setting on and reports what that actually leaves", async () => {
    await combat.toggle().check();

    await expect(combat.toggle()).toBeChecked();
    await expect(combat.state()).toContainText("Advanced combat logging is set up");
    await expect(combat.state()).toContainText("no combat log at all yet");
    // The line is coloured from this, and the colour is half of what the sentence means.
    await expect(combat.state()).toHaveAttribute("data-state", "stale");
    await expect(combatLoggingSetting(page)).resolves.toBe(true);
  });

  // The sentence is a claim about this install, so the panel shows what it read it from.
  await test.step("and shows the evidence it read that from", async () => {
    await expect(combat.panel).toContainText("No combat log found in the game's Logs folder.");
    await expect(combat.panel)
      .toContainText("Advanced logging reads on in WTF/Account/EXAMPLE/config-cache.wtf.");
  });

  // Deleting a combat log is the one thing Chronie does that cannot be undone, so what would
  // go has to be readable — by name — while the switch is still off. A summary printed after
  // the first sweep would be a report of a decision nobody was given the chance to make.
  await test.step("deleting old logs is off, and names what turning it on would take", async () => {
    await expect(retention.toggle()).not.toBeChecked();
    await expect(retention.state()).toContainText("Chronie deletes no combat logs");
    await expect(retention.state()).toContainText("Turning this on at 7 days would delete 2 logs");
    await expect(retention.panel).toContainText("Would go on the next sync:");
    await expect(retention.panel).toContainText("WoWCombatLog-071026_201500.txt");
    await expect(retention.panel).toContainText("WoWCombatLog-071126_193000.txt");
    await expect(retainDaysSetting(page)).resolves.toBeNull();
  });

  // The gigabyte nothing has ever read is the file this whole feature is careful about. It is
  // never swept, and a tool that skipped it silently would be indistinguishable from one that
  // was not running — so it is named, sized, and handed back to the reader.
  await test.step("and says which old logs it will never delete by itself", async () => {
    await expect(retention.panel).toContainText("1 log, 1.0 GB");
    await expect(retention.panel).toContainText("never been read by Chronie");
    await expect(retention.panel).toContainText("These are never deleted. Removing them is yours to do.");
    await expect(retention.panel).toContainText("Never deleted by Chronie:");
    await expect(retention.panel).toContainText("WoWCombatLog-032526_204500.txt");
  });

  await test.step("turning it on records the window and says what goes next sync", async () => {
    await retention.toggle().check();

    await expect(retention.toggle()).toBeChecked();
    await expect(retainDaysSetting(page)).resolves.toBe(7);
    await expect(retention.state()).toContainText("older than 7 days");
    await expect(retention.state()).toContainText("2 logs, 384.0 MB go on the next sync");
    await expect(retention.panel).toContainText("Going on the next sync:");

    // A longer window is the same feature with a different number, and it has to reach the
    // setting rather than only the box it was typed into.
    await retention.days().fill("30");
    await retention.days().blur();
    await expect(retainDaysSetting(page)).resolves.toBe(30);
    await expect(retention.state()).toContainText("older than 30 days");
  });
});

/**
 * The whole of WiFi sync from the sending machine's side.
 *
 * Choosing a Chronie fills its address in rather than sending to it, which is the rule worth
 * holding: one click must not be enough to hand a history over.
 */
test("finds another Chronie on the network and offers this history to it", async ({ page }) => {
  await new SettingsPage(page).open("Move this history");
  const sending = page.getByRole("region", { name: "Send this history" });

  await sending.getByRole("button", { name: "Look for Chronies" }).click();
  await expect(page.locator("#wifi-send-status")).toHaveText("Found 1 Chronie waiting.");
  await expect(sending.getByRole("button", { name: /Study desktop/ })).toBeVisible();

  await sending.getByRole("button", { name: /Study desktop/ }).click();
  await expect(page.getByLabel("Address")).toHaveValue("192.168.1.20:51571");
  await expect(sentTo(page)).resolves.toEqual([]);

  await sending.getByRole("button", { name: "Send history" }).click();
  await expect(page.locator("#wifi-send-status"))
    .toHaveText("Sent to 192.168.1.20:51571: it now holds 1204 segments.");
  await expect(sentTo(page)).resolves.toEqual(["192.168.1.20:51571"]);
});

/**
 * The receiving side, which is where the destructive click lives.
 *
 * What the offer says is asserted rather than only that it appeared: accepting throws away
 * everything the machine has collected, and the sentence above the button is the only thing
 * standing between a reader and that.
 */
test("takes a history from another Chronie only once somebody agrees", async ({ page }) => {
  await new SettingsPage(page).open("Move this history");
  const receiving = page.getByRole("region", { name: "Receive a history" });
  const offer = page.locator("#wifi-offer");

  await expect(page.locator("#wifi-receive-status")).toContainText("Not waiting");
  await expect(offer).toBeHidden();

  await receiving.getByRole("button", { name: "Wait for a database" }).click();
  await expect(offer).toBeVisible();
  await expect(page.locator("#wifi-offer-text")).toContainText("Study desktop (192.168.1.20)");
  await expect(page.locator("#wifi-offer-text")).toContainText("1204 segments across 3 characters");
  await expect(page.locator("#wifi-offer-text")).toContainText("4.2 MB");
  await expect(page.locator("#wifi-offer-text"))
    .toContainText("replaces everything this Chronie has collected");

  await test.step("declining leaves this history where it was", async () => {
    await offer.getByRole("button", { name: "Decline" }).click();
    await expect(offer).toBeHidden();
    await expect(page.locator("#wifi-receive-status"))
      .toContainText("Turned down the database from Study desktop.");
  });

  await test.step("accepting says what replaced what", async () => {
    // Stopping and starting again is how the panel gets a second offer, which is also how
    // somebody would recover from having declined the transfer they actually wanted.
    await receiving.getByRole("button", { name: "Stop waiting" }).click();
    await receiving.getByRole("button", { name: "Wait for a database" }).click();
    await expect(offer).toBeVisible();

    await offer.getByRole("button", { name: "Accept and replace" }).click();
    await expect(offer).toBeHidden();
    await expect(page.locator("#wifi-receive-status"))
      .toContainText("Replaced this history with Study desktop's: 1204 segments");
  });
});


/**
 * The whole of the Query view, from opening it to being told a column does not exist.
 *
 * The steps are in the order somebody actually meets them, and the first one is the one the
 * feature stands or falls on: the view opens already answered, with a picture of a real
 * question, rather than as an empty box waiting for somebody to know SQL before it will show
 * them anything.
 */
test("asks the history a question and draws the answer", async ({ workbench }) => {
  await workbench.open();

  await test.step("opens on a question already asked, and a chart of it", async () => {
    await expect(workbench.summary()).toHaveText("3 rows · 2 columns · 3 ms");
    // The chart says what it is drawing in the name it is announced by, which is the only
    // thing a reader who cannot see it would be given.
    await expect(workbench.chart())
      .toHaveAccessibleName("hours by character, as a bar chart of 3 values");
    await expect(workbench.rows()).toHaveCount(3);
    await expect(workbench.rows().first()).toContainText("Aster-Vale");
    await expect(workbench.rows().first()).toContainText("41.5");
  });

  await test.step("redraws the same answer as another shape", async () => {
    await workbench.choice("Chart shape").selectOption("line");
    await expect(workbench.chart())
      .toHaveAccessibleName("hours by character, as a line chart of 3 values");
  });

  await test.step("takes another question from the ones offered", async () => {
    await workbench.recipe("Hours per day").click();

    await expect(workbench.editor()).toHaveValue(/GROUP BY s.ended_day/);
    await expect(workbench.summary()).toHaveText("4 rows · 2 columns · 5 ms");
    // The recipe says what to plot and how, so a question about days over time arrives as a
    // line rather than as whatever the column order happened to suggest.
    await expect(workbench.chart())
      .toHaveAccessibleName("hours by day, as a line chart of 4 values");
    await expect(workbench.rows()).toHaveCount(4);
  });

  await test.step("opens a table from the list and asks for all of it", async () => {
    const characters = await workbench.openTable("characters");
    await expect(characters).toContainText("class_file");

    await characters.getByRole("button", { name: "SELECT * FROM characters" }).click();

    await expect(workbench.editor()).toHaveValue('SELECT * FROM "characters" LIMIT 50');
    await expect(workbench.rows()).toHaveCount(3);
    // Nothing said what to plot, so the convention did: the first column that names things
    // along the bottom, the first that counts them up the side.
    await expect(workbench.chart())
      .toHaveAccessibleName("id by name, as a bar chart of 3 values");
    // The character with no class recorded. An empty cell and a cell holding nothing look
    // identical on screen, and only one of them is what the database said.
    await expect(workbench.rows().last()).toContainText("—");
  });

  await test.step("says why a query was refused, and keeps the rows that worked", async () => {
    await workbench.editor().fill("SELECT charater FROM segments");
    await workbench.runIt();

    await expect(workbench.failure()).toHaveText("no such column: charater");
    // The last answer is still on screen: a mistyped column is one keystroke from a working
    // query, and taking the rows away to say so would be a punishment for a typo.
    await expect(workbench.rows()).toHaveCount(3);
  });
});

