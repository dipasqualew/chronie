import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { E2EMock } from "../src/types";

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
  readonly rows: Locator;

  constructor(page: Page) {
    this.page = page;
    this.rows = page.locator("#rows tr");
  }

  async open(): Promise<void> {
    await this.page.getByRole("button", { name: "Details" }).click();
    await expect(this.page.getByRole("heading", { name: "Details" })).toBeVisible();
  }

  search(): Locator {
    return this.page.getByLabel("Filter segments");
  }

  character(): Locator {
    return this.page.getByLabel("Character");
  }

  /** A cell of the ledger, found the way a reader finds it: by what it says. */
  cellSaying(text: string): Locator {
    return this.page.getByRole("cell", { name: text });
  }
}

/**
 * The transmog view, which reads the installed game rather than the addon's history.
 *
 * A collection is a level-3 heading and a set a level-4 one, so the whole view is reachable
 * by heading the way a screen reader walks it.
 */
class TransmogView {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = page.locator("#transmog-view");
  }

  /** The tab loads the game's tables the first time it is opened, and not before. */
  async open(): Promise<void> {
    await this.page.getByRole("button", { name: "Transmog" }).click();
    await expect(this.view.getByRole("heading", { name: "Transmog", level: 1 })).toBeVisible();
  }

  collections(): Locator {
    return this.view.getByRole("heading", { level: 3 });
  }

  sets(): Locator {
    return this.view.getByRole("heading", { level: 4 });
  }

  /** The card a set is shown on, found by the set's own heading. */
  card(name: string): Locator {
    return this.view
      .getByRole("article")
      .filter({ has: this.page.getByRole("heading", { name, exact: true }) });
  }

  search(): Locator {
    return this.view.getByLabel("Filter transmog sets");
  }

  expansion(): Locator {
    return this.view.getByLabel("Expansion");
  }

  klass(): Locator {
    return this.view.getByLabel("Class");
  }

  /** How far down the grid the reader has got, which opening and closing a set must not move. */
  scrollOffset(): Promise<number> {
    return this.page.evaluate(() => window.scrollY);
  }

  scrollToEnd(): Promise<void> {
    return this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  }
}

/**
 * One set opened: the appearances the game says it is made of.
 *
 * The dialog answers to the name of the set it is showing and every appearance is a list
 * item, so the whole thing is walkable without knowing a single class name.
 */
class TransmogDetail {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.locator("#transmog-detail");
  }

  /** Opens a set the way a reader does: by clicking its name on the card. */
  async open(name: string): Promise<void> {
    await this.page.getByRole("button", { name, exact: true }).click();
    await expect(this.named(name)).toBeVisible();
  }

  /** The dialog as a screen reader announces it, which is by the set it is showing. */
  named(name: string): Locator {
    return this.page.getByRole("dialog", { name });
  }

  /** One row per appearance the set names, in the order the backend sorted them. */
  rows(): Locator {
    return this.dialog.getByRole("listitem");
  }

  /** The way through to the item an appearance came from. */
  link(label: string): Locator {
    return this.dialog.getByRole("link", { name: label });
  }

  /**
   * The frame every row keeps for its picture, and the pictures that have arrived in them.
   *
   * Not an accessibility locator, and deliberately: an icon beside a row that already names
   * its slot and its item is decorative, so it carries no alternative text and is not in the
   * accessibility tree at all. Giving it one to make it selectable would have a screen
   * reader announce every row twice.
   */
  iconFrames(): Locator {
    return this.dialog.locator(".mog-icon");
  }

  icons(): Locator {
    return this.dialog.locator(".mog-icon img");
  }

  /**
   * Picks a row, which is what fills the preview above the list.
   *
   * The first of its name, because a set naming one appearance twice has two rows that are
   * the same appearance — and picking either of them is picking the same thing.
   */
  pick(slot: string, label: string): Promise<void> {
    return this.dialog.getByRole("button", { name: `Preview ${slot}: ${label}` }).first().click();
  }

  /**
   * The preview pane, which says what it is showing in an attribute: nothing yet, a model on
   * the stage, or a still picture for an appearance that has none.
   */
  preview(): Locator {
    return this.dialog.locator(".mog-preview");
  }

  /** The pane a model is put on, which says how much geometry it ended up holding. */
  stage(): Locator {
    return this.dialog.locator(".mog-stage");
  }

  /** The canvas the model is drawn on, which only exists once one has been shown. */
  canvas(): Locator {
    return this.dialog.locator(".mog-stage canvas");
  }

  /** The still picture, shown for the slots the game paints onto the character. */
  stillPicture(): Locator {
    return this.dialog.locator(".mog-still img");
  }

  /** Whatever the pane says about what it is showing, which is a live region. */
  note(): Locator {
    return this.dialog.locator(".mog-note");
  }

  /** Anything the dialog says in its own words: where the set sits, what it holds. */
  says(text: string): Locator {
    return this.dialog.getByText(text);
  }

  async close(): Promise<void> {
    await this.dialog.getByRole("button", { name: "Close set" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

const test = base.extend<{
  detail: SegmentDetail;
  editor: ActivityEditor;
  ledger: DetailsTable;
  transmog: TransmogView;
  transmogDetail: TransmogDetail;
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
  transmog: async ({ page }, use) => {
    await use(new TransmogView(page));
  },
  transmogDetail: async ({ page }, use) => {
    await use(new TransmogDetail(page));
  },
});

// Two evenings: the first is a keystone run followed two minutes later by an alt, which is
// the case that has to fold into one play session; the second is a day earlier and must not.
const EVENING = 1785063600;
const NIGHT_BEFORE = 1784977200;

// Typed as the real backend's answers, so a fixture that has drifted from what a command
// actually returns fails the type check rather than the assertion three steps later.
//
// The places are invented, the classes are not: a class token is the app's own vocabulary —
// the palette in `ui.ts` is keyed by it — so a made-up one would draw every character in the
// colourless fallback and hide the very thing the cast is coloured for.
const mockDesktop: E2EMock = {
  dashboard: {
    generatedAt: "2026-07-26T12:00:00Z",
    knownActivityKinds: ["mythic_plus", "progress_raid", "legacy_raid", "levelling"],
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
        transmogs: [],
        // The other half of the story: gains the client said nothing else about. An
        // item-based currency counted before its first change has no holding to report, and
        // a faction read off a chat line on a character that has never met it has no
        // standing. Neither is a holding of zero or a standing at the bottom of a bar, so
        // neither may draw as one.
        // A third case sits beside them: a faction the client named a level for and gave no
        // length to. That is a standing worth printing and a bar with nothing to draw, and a
        // bar at zero would announce the character as nowhere in a level they are inside.
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
        currencies: [{ id: 7, name: "Glass Token", amount: 4, total: 12450 }],
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
        pets: [{ id: 12, name: "Mossling", at: NIGHT_BEFORE + 800 }],
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
    readCount: 4,
    declaredCount: 6,
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
        patchIntroduced: 100300, itemCount: 5,
      },
      {
        id: 201, name: "Tideglass Regalia", group: "Tideglass Wardrobe", groupId: 1,
        classMask: 0x0190, expansionId: 3, parentId: 0, flags: 1, uiOrder: 5,
        patchIntroduced: 100200, itemCount: 4,
      },
      {
        id: 202, name: "Tideglass Hide", group: "Tideglass Wardrobe", groupId: 1,
        classMask: 0x0e08, expansionId: 3, parentId: 201, flags: 1, uiOrder: 10,
        patchIntroduced: 100200, itemCount: 2,
      },
    ],
  },
  // And what those sets are made of, which the window asks for a set at a time. The item
  // ids, slots and the one appearance the game withholds are the backend fixtures' own, so
  // a change to the chain the Rust tests hold still shows up here too.
  transmogItems: {
    201: {
      setId: 201,
      readCount: 4,
      withheldCount: 0,
      appearances: [
        {
          modifiedAppearanceId: 71001, itemId: 30001, name: "Tideglass Crown", appearanceId: 80001,
          displayType: 0, displayInfoId: 900001, iconFileDataId: 130001, hasModel: true,
        },
        // The set names the same appearance twice, which is why the card counts four.
        {
          modifiedAppearanceId: 71001, itemId: 30001, name: "Tideglass Crown", appearanceId: 80001,
          displayType: 0, displayInfoId: 900001, iconFileDataId: 130001, hasModel: true,
        },
        {
          modifiedAppearanceId: 71002, itemId: 30002, name: "Tideglass Mantle", appearanceId: 80002,
          displayType: 1, displayInfoId: 900002, iconFileDataId: 130002, hasModel: true,
        },
        {
          modifiedAppearanceId: 71003, itemId: 30003, name: "Tideglass Robe", appearanceId: 80003,
          displayType: 2, displayInfoId: 900003, iconFileDataId: 130003, hasModel: false,
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
          displayType: 5, displayInfoId: 900004, iconFileDataId: 130004, hasModel: false,
        },
        {
          modifiedAppearanceId: 71005, itemId: 30005, name: "Tideglass Gloves", appearanceId: 80005,
          displayType: 7, displayInfoId: 900005, iconFileDataId: 130005, hasModel: false,
        },
      ],
    },
    // The set whose appearances span several slots, which is what the list is grouped by.
    203: {
      setId: 203,
      readCount: 5,
      withheldCount: 0,
      appearances: [
        {
          modifiedAppearanceId: 71006, itemId: 30006, name: "Emberforge Helm", appearanceId: 80006,
          displayType: 0, displayInfoId: 900001, iconFileDataId: 130001, hasModel: true,
        },
        {
          modifiedAppearanceId: 71007, itemId: 30007, name: "Emberforge Pauldrons",
          appearanceId: 80007,
          displayType: 1, displayInfoId: 900009, iconFileDataId: 130002, hasModel: true,
        },
        {
          modifiedAppearanceId: 71008, itemId: 30008, name: "Emberforge Breastplate",
          appearanceId: 80008,
          displayType: 2, displayInfoId: 900003, iconFileDataId: 130003, hasModel: false,
        },
        {
          modifiedAppearanceId: 71009, itemId: 30009, name: "Emberforge Greaves",
          appearanceId: 80009,
          displayType: 4, displayInfoId: 900006, iconFileDataId: 130006, hasModel: false,
        },
        // A weapon: the other half of what the game gives geometry to, and the half whose
        // display type the community definitions do not pin down well enough to name.
        {
          modifiedAppearanceId: 71010, itemId: 30010, name: "Emberforge Bulwark",
          appearanceId: 80010,
          displayType: 11, displayInfoId: 900007, iconFileDataId: 130005, hasModel: true,
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
          displayType: 2, displayInfoId: 900900, iconFileDataId: 130008, hasModel: false,
        },
        {
          modifiedAppearanceId: 71012, itemId: 0, name: "", appearanceId: 0,
          displayType: 0, displayInfoId: 0, iconFileDataId: 0, hasModel: false,
        },
      ],
    },
  },
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
  // The models, as the backend hands them over: a `.glb` in a data URL, keyed by the display
  // the appearance named. 900002 is missing on purpose — a shoulder the tables say has a
  // model and this install holds no file for, which is a row that has to fall back to its
  // icon rather than show an error.
  transmogModels: {
    900001: fixtureModel("helm.glb"),
    900007: fixtureModel("helm.glb"),
  },
  // The body every set detail opens on, before anything is worn.
  characterModel: fixtureModel("character.glb"),
  settings: {
    wowPath: "C:\\Games\\Example MMO\\_retail_",
    lastSync: "2026-07-26T11:58:00Z",
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
 * The ink is chosen in TypeScript and applied in CSS, so this is the only place the two meet
 * and the only place the initials can be shown to still read against the fill behind them.
 */
const inkColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));

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

test.beforeEach(async ({ page }) => {
  await page.addInitScript((mock) => {
    window.__Chronie_E2E__ = mock;
  }, mockDesktop);
  await page.goto("/");
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
    const cast = sessions(page).first().getByRole("img");
    await expect(cast).toHaveCount(2);
    await expect(cast.first()).toHaveAttribute("aria-label", /Aster-Vale, Mage · level 12/);
  });

  // The circle is the only thing on a session card that says who played at a glance, and it
  // says it in the colour the game uses. A ring drawn in the fallback grey is the failure
  // this catches: everyone the same colour is the same as nobody named.
  await test.step("each character is drawn in their own class colour", async () => {
    await expect(borderColours(sessions(page).first().getByRole("img")))
      .resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
  });

  // The version of the step above that only read the border was green for as long as the
  // fill was a 22% wash of the class colour over the card — every circle the colour of the
  // page, with a thin coloured ring, and nothing that could tell. So the fill is asserted
  // outright: mage cyan then druid orange, filled, with the initials in the ink chosen to
  // read on them. Both of those take the near-black; the white ink belongs to death knight,
  // demon hunter and shaman, which no fixture casts — `classInk`'s unit tests cover all
  // thirteen, and this covers the only thing they cannot, which is the stylesheet.
  await test.step("and filled with it, not merely ringed in it", async () => {
    const cast = sessions(page).first().getByRole("img");

    await expect(fillColours(cast)).resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
    await expect(inkColours(cast)).resolves.toEqual(["rgb(11, 11, 11)", "rgb(11, 11, 11)"]);
  });

  // Filling the circles cost them the ring that used to be their outer edge: they now wear
  // two more, standing 3px proud of the disc on every side. The overlap the stack was tuned
  // to without them then swallowed every initial but the last — "MAGE, DRUID, PRIEST, ROGUE"
  // came out as "M. DI PI RO". So the stacking is held to what it is for: a cast that reads.
  await test.step("and stacked close enough to read as one cast, not so close as to bury it", async () => {
    const covered = await overlapFractions(sessions(page).first().getByRole("img"));

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

  await test.step("the achievements lead and the running totals follow", async () => {
    const first = sessions(page).first();
    await expect(first).toContainText("2 achievements");
    await expect(first).toContainText("Clockwork Glider");
    await expect(first).toContainText("Glass Token");
    await expect(first).toContainText("3g 29s");
  });

  // Two achievements and two characters' levelling that evening, so the card says how much
  // of each there was rather than picking one of them to name and dropping the rest.
  await test.step("what happened several times is counted, not listed", async () => {
    const first = sessions(page).first();
    await expect(first).toContainText("2 levels");
    await expect(first).not.toContainText("Into the Light");
    await expect(first).not.toContainText("Level 12");
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
});

test("digs from a session down into a single segment and back out again", async ({ page, detail }) => {
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

  // "+4" and "+25" say what the run paid out and nothing about what that came to. The
  // holding beside the gain and the bar under the faction are the half that answers it.
  await test.step("a gain says where it left the character, not only what it was", async () => {
    await expect(detail.gainFor("Glass Token")).toContainText("+4 (12,450)");

    const standing = detail.standingBars("Honored with Cavern Cartographers");
    await expect(standing).toHaveJSProperty("value", 4200);
    await expect(standing).toHaveJSProperty("max", 12000);
    await expect(detail.gainFor("Cavern Cartographers")).toContainText("Honored 4,200 / 12,000");
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
    await expect.poll(() => openedUrls(page)).toEqual([
      "https://www.wowhead.com/quest=81",
      "https://www.wowhead.com/achievement=9",
    ]);
    await expect(detail.title()).toHaveText("Glass Caverns");
    expect(page.url()).toContain("127.0.0.1:4399");
  });

  await detail.close();
});

// What happened to an equipment set is a chip like any other milestone, and the thing it
// unfolds into is the part a table could never hold: which slot, and what replaced what.
test("shows what happened to an equipment set, down to the slot", async ({ page, detail }) => {
  // Two slots moved: one item was replaced by a better one, and one was cleared outright.
  // The total falls because clearing a slot really does cost the set everything it held.
  const chip = sessions(page).first().getByRole("button", { name: /Raid updated/ });
  await expect(chip).toContainText("2 slots, −604 ilvl");

  await chip.click();
  await expect(detail.title()).toHaveText("Glass Caverns");

  const change = detail.dialog.locator(".equipset");
  await expect(change).toHaveCount(1);
  await expect(change).toContainText("Raid updated");

  const slots = change.locator(".equipset-slots li");
  await expect(slots).toHaveCount(2);
  await expect(slots.first()).toContainText("Head");
  await expect(slots.first()).toContainText("Tideglass Crown (623)");
  await expect(slots.first()).toContainText("Deepwater Crown (639)");

  // A slot the edit cleared says what left it and shows nothing arriving, rather than
  // drawing as a row with a blank on both sides.
  await expect(slots.nth(1)).toContainText("Back");
  await expect(slots.nth(1)).toContainText("Storm Cloak (620)");

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

test("shows the game's transmog sets by collection and filters them", async ({
  page,
  transmog,
  transmogDetail,
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
    await expect(card).toContainText("4 appearances");
    // A set for nobody in particular is for everybody, and says so.
    await expect(transmog.card("Duskwoven Shroud")).toContainText("Any class");
  });

  // Coming up short is expected — the game encrypts what it has not released — so the view
  // has to say so rather than quietly show fewer sets than the game holds.
  await test.step("the sets the game keeps encrypted are accounted for", async () => {
    await expect(transmog.view.getByText("2 sets the game keeps encrypted")).toBeVisible();
  });

  await test.step("the search reaches the collection as well as the set", async () => {
    await transmog.search().fill("tideglass");
    await expect(transmog.sets()).toHaveText(["Tideglass Regalia", "Tideglass Hide"]);
    await expect(transmog.collections()).toHaveCount(1);
    await transmog.search().fill("");
    await expect(transmog.sets()).toHaveCount(4);
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
    await expect(transmog.view.getByText("Nothing matches")).toBeVisible();
    await expect(transmog.sets()).toHaveCount(0);
  });

  // From here the grid is left as the filters above put it — the sets a priest can wear —
  // because closing a set has to hand back exactly that.
  await test.step("a set opens on what the game says it is made of", async () => {
    await transmog.search().fill("");
    await expect(transmog.card("Tideglass Regalia")).toContainText("4 appearances");

    await transmogDetail.open("Tideglass Regalia");
    await expect(transmogDetail.says("Tideglass Wardrobe · Cloth · Cataclysm · Patch 10.2.0"))
      .toBeVisible();
    // The set names one of its appearances twice, so a list agreeing with the card is four
    // rows long rather than three.
    await expect(transmogDetail.says("4 appearances")).toBeVisible();
    await expect(transmogDetail.rows()).toHaveCount(4);
  });

  // The names come out of a fifth table, the one whose records vary in length — so a row
  // reading as an item rather than as a number is what says that reader works end to end.
  await test.step("every appearance says which slot it fills and leads to the item", async () => {
    await expect(transmogDetail.rows()).toContainText(["Head", "Head", "Shoulder", "Chest"]);
    await expect(transmogDetail.rows()).toContainText([
      "Tideglass Crown", "Tideglass Crown", "Tideglass Mantle", "Tideglass Robe",
    ]);
    await expect(transmogDetail.link("Tideglass Mantle"))
      .toHaveAttribute("href", "https://www.wowhead.com/item=30002");
    await expect(transmogDetail.link("Tideglass Robe"))
      .toHaveAttribute("href", "https://www.wowhead.com/item=30003");

    // The dialog is inside the same window as everything else, so a link out of it has to
    // reach the reader's browser the way the segment detail's links do.
    await transmogDetail.link("Tideglass Mantle").click();
    await expect.poll(() => openedUrls(page)).toContain("https://www.wowhead.com/item=30002");
    await expect(transmogDetail.named("Tideglass Regalia")).toBeVisible();
  });

  // The pictures come out of the game's own textures, and they arrive after the rows do —
  // so what is checked here is that every row ends up carrying one, not that it had one the
  // moment the list appeared.
  await test.step("every appearance carries the game's own picture of it", async () => {
    await expect(transmogDetail.iconFrames()).toHaveCount(4);
    await expect(transmogDetail.icons()).toHaveCount(4);
    // The set names its first appearance twice, so two of the four rows show one texture.
    const sources = await transmogDetail.icons().evaluateAll(
      (images) => images.map((image) => (image as HTMLImageElement).currentSrc),
    );
    expect(new Set(sources).size).toBe(3);
    for (const source of sources) expect(source).toContain("data:image/png;base64,");

    // Decoded, not merely fetched: a data url the browser could not read would leave the
    // element with no intrinsic size at all.
    const widths = await transmogDetail.icons().evaluateAll(
      (images) => images.map((image) => (image as HTMLImageElement).naturalWidth),
    );
    expect(widths).toEqual([8, 8, 8, 8]);
  });

  // Only heads, shoulders, weapons and shields have geometry of their own. The pane is where
  // that difference shows: a helm is a model to turn around, a chestpiece is its icon and a
  // sentence saying why, and neither of them is an error.
  // Most of a set has no model of its own, so the pane opens on the thing all of it is drawn
  // on: a bare body, before anything is worn.
  await test.step("opening a set shows the character everything is worn on", async () => {
    await expect(transmogDetail.preview()).toHaveAttribute("data-state", "character");
    await expect(transmogDetail.note()).toHaveText("Nothing is worn yet. Drag to turn it.");
    await expect(transmogDetail.canvas()).toBeVisible();

    // 7 × 88: the fixture body holds eleven geosets and a bare one draws seven of them, and
    // every part is drawn out of the same 88 vertices the whole model shares. Which makes this
    // the geoset selection, counted from the far end of the pipe — a variant drawn alongside
    // its default reads as 8 × 88, and a default that went missing as 6 × 88.
    await expect(transmogDetail.stage()).toHaveAttribute("data-vertices", "616");
  });

  await test.step("picking an appearance with a model shows it in 3D", async () => {
    await transmogDetail.pick("Head", "Tideglass Crown");
    await expect(transmogDetail.preview()).toHaveAttribute("data-state", "model");
    await expect(transmogDetail.canvas()).toBeVisible();
    await expect(transmogDetail.note()).toHaveText("Drag to turn it.");

    // Geometry rather than merely a canvas: an empty scene and a helm draw the same blank
    // rectangle, so what says the file was read is the stage saying what it is holding.
    await expect(transmogDetail.stage()).toHaveAttribute("data-vertices", "8");
  });

  await test.step("picking one the game paints onto the character shows its icon instead", async () => {
    await transmogDetail.pick("Chest", "Tideglass Robe");
    await expect(transmogDetail.preview()).toHaveAttribute("data-state", "still");
    await expect(transmogDetail.note())
      .toHaveText("The game paints this slot onto the character, so it has no model of its own.");
    await expect(transmogDetail.stillPicture()).toBeVisible();
    await expect(transmogDetail.canvas()).toBeHidden();
  });

  // The tables say this shoulder has a model and the install holds no file for it, which is
  // the third case: not an armour slot, not a model, and still not an error.
  await test.step("a model this install does not hold falls back to the icon", async () => {
    await transmogDetail.pick("Shoulder", "Tideglass Mantle");
    await expect(transmogDetail.preview()).toHaveAttribute("data-state", "still");
    await expect(transmogDetail.note()).toHaveText("This install holds no model for it.");
  });

  await test.step("closing a set hands back the grid the reader left", async () => {
    // A window short enough that the grid has somewhere to scroll to, so that the position
    // being kept is a fact about the app rather than about there being nothing to scroll.
    await page.setViewportSize({ width: 720, height: 360 });
    await transmog.scrollToEnd();
    const scrolled = await transmog.scrollOffset();
    expect(scrolled).toBeGreaterThan(0);

    await transmogDetail.close();
    await expect(transmog.sets()).toHaveText(["Duskwoven Shroud", "Tideglass Regalia"]);
    await expect(transmog.klass()).toHaveValue("4");
    await expect(transmog.search()).toHaveValue("");
    expect(await transmog.scrollOffset()).toBe(scrolled);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  // The card promises two appearances and the game encrypts one of them outright, so the
  // list has to hold a row it can say nothing about rather than come up a row short.
  await test.step("an appearance the game withholds still takes a row and says so", async () => {
    // Clicked on the card rather than on the name, because the whole card opens a set.
    await transmog.card("Duskwoven Shroud").click();
    await expect(transmogDetail.named("Duskwoven Shroud")).toBeVisible();
    await expect(transmogDetail.rows()).toHaveCount(2);
    await expect(transmogDetail.says("2 appearances · 1 the game keeps encrypted")).toBeVisible();
    await expect(transmogDetail.says("The game keeps this appearance encrypted")).toBeVisible();
    // The other row got as far as an item and no further: the game encrypts that item's own
    // row too, so it is named by its id rather than left as a blank beside a slot.
    await expect(transmogDetail.link("Item 30011"))
      .toHaveAttribute("href", "https://www.wowhead.com/item=30011");

    // One row names a texture this install does not hold and the other names none at all,
    // so neither has a picture to show — and both still keep the frame, so the list reads as
    // a column of icons with two blanks rather than as two rows that lost their indent.
    await expect(transmogDetail.iconFrames()).toHaveCount(2);
    await expect(transmogDetail.icons()).toHaveCount(0);
    await transmogDetail.close();
  });

  // Weapons are the other half of what the game gives a model to, and they arrive through a
  // second dialog opening — so this is also what says the pane survives being reused.
  await test.step("a weapon in another set gets a model of its own", async () => {
    await transmog.klass().selectOption("");
    await transmog.card("Emberforge Plate").click();
    await expect(transmogDetail.named("Emberforge Plate")).toBeVisible();
    // Back to the body, on a stage that has had a helm and an icon on it since.
    await expect(transmogDetail.preview()).toHaveAttribute("data-state", "character");

    await transmogDetail.pick("Weapon or shield", "Emberforge Bulwark");
    await expect(transmogDetail.preview()).toHaveAttribute("data-state", "model");
    await expect(transmogDetail.canvas()).toBeVisible();
    await transmogDetail.close();
  });
});

test("drives setup, sync, addon installation, and app update checks", async ({ page }) => {
  await page.getByRole("button", { name: "Setup" }).click();
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
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
});

/**
 * The whole of WiFi sync from the sending machine's side.
 *
 * Choosing a Chronie fills its address in rather than sending to it, which is the rule worth
 * holding: one click must not be enough to hand a history over.
 */
test("finds another Chronie on the network and offers this history to it", async ({ page }) => {
  await page.getByRole("button", { name: "Setup" }).click();
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
  await page.getByRole("button", { name: "Setup" }).click();
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

