import { expect, test as base } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

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
}

const test = base.extend<{ detail: SegmentDetail; editor: ActivityEditor; transmog: TransmogView }>({
  detail: async ({ page }, use) => {
    await use(new SegmentDetail(page));
  },
  editor: async ({ page }, use) => {
    await use(new ActivityEditor(page));
  },
  transmog: async ({ page }, use) => {
    await use(new TransmogView(page));
  },
});

// Two evenings: the first is a keystone run followed two minutes later by an alt, which is
// the case that has to fold into one play session; the second is a day earlier and must not.
const EVENING = 1785063600;
const NIGHT_BEFORE = 1784977200;

// Typed as the real backend's answers, so a fixture that has drifted from what a command
// actually returns fails the type check rather than the assertion three steps later.
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
        classFile: "ARTIFICER",
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
        currencyTotal: 0,
        reputationTotal: 0,
        housingXP: 0,
        transmogs: [],
        currencies: [],
        reputation: [],
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
        classFile: "SENTINEL",
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
        transmogs: [{ id: 101, at: EVENING + 1400, newAppearance: true }],
        currencies: [{ id: 7, name: "Glass Token", amount: 4 }],
        reputation: [{ faction: "Cavern Cartographers", amount: 25 }],
        achievements: [{ id: 9, name: "Into the Light", at: EVENING + 1400, accountFirst: false }],
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
        classFile: "ARTIFICER",
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
        patchIntroduced: 100300, itemCount: 4,
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
  settings: {
    wowPath: "C:\\Games\\Example MMO\\_retail_",
    lastSync: "2026-07-26T11:58:00Z",
  },
  chosenPath: "D:\\Games\\Example MMO",
  syncResult: { segmentCount: 3, added: 1, updated: 1 },
  installResult: { version: "0.8.0-dev" },
  appUpdate: { updated: false, version: "0.1.0" },
};

const timeline = (page: Page): Locator => page.locator("#timeline");
const sessions = (page: Page): Locator => page.locator("#timeline .session");

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
    await expect(cast.first()).toHaveAttribute("aria-label", /Aster-Vale, Sentinel · level 12/);
  });

  await test.step("both kinds of time are reported, because they differ", async () => {
    const first = sessions(page).first();
    await expect(first).toContainText("50m");
    await expect(first).toContainText("52m elapsed");
  });

  await test.step("the achievements lead and the running totals follow", async () => {
    const first = sessions(page).first();
    await expect(first).toContainText("Into the Light");
    await expect(first).toContainText("Clockwork Glider");
    await expect(first).toContainText("Level 12");
    await expect(first).toContainText("Glass Token");
    await expect(first).toContainText("3g 29s");
  });
});

test("digs from a session down into a single segment and back out again", async ({ page, detail }) => {
  await sessions(page).first().getByRole("button", { name: "2 segments" }).click();

  await detail.openFromTimeline("Aster-Vale", "Glass Caverns");
  await expect(detail.title()).toHaveText("Glass Caverns");
  await expect(detail.position()).toHaveText("1 of 2");
  await expect(detail.dialog).toContainText("The Curator");
  await expect(detail.dialog).toContainText("+14");

  await test.step("next and previous walk the play session, not all of history", async () => {
    await detail.next();
    await expect(detail.title()).toHaveText("Copperwood Depths");
    await expect(detail.position()).toHaveText("2 of 2");
    await expect(detail.dialog.getByRole("button", { name: "Next segment" })).toBeDisabled();

    await detail.previous();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.dialog.getByRole("button", { name: "Previous segment" })).toBeDisabled();
  });

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

test("lists every segment on the details view and filters it", async ({ page, detail }) => {
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
  await expect(page.locator("#rows tr")).toHaveCount(3);

  await page.getByLabel("Filter segments").fill("copperwood");
  await expect(page.locator("#rows tr")).toHaveCount(2);

  await page.getByLabel("Filter segments").fill("");
  await page.getByLabel("Character").selectOption("Aster-Vale");
  await expect(page.locator("#rows tr")).toHaveCount(1);
  await expect(page.locator("#rows")).toContainText("Glass Caverns");

  // From here the modal walks what the table is showing, which is the one row left.
  await test.step("a row opens the same detail the timeline does", async () => {
    await page.locator("#rows tr").first().click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.position()).toHaveText("1 of 1");
  });
});

test("shows the game's transmog sets by collection and filters them", async ({ transmog }) => {
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
