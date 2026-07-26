import { expect, test as base } from "@playwright/test";

/**
 * The activity editor, addressed the way a user addresses it: by the names and roles on
 * screen. Nothing here knows a CSS class, so a restyle cannot break the test and a change
 * that makes the dialog unreachable by keyboard or screen reader will.
 */
class ActivityEditor {
  constructor(page) {
    this.page = page;
    this.dialog = page.getByRole("dialog");
  }

  /** Opens the editor from the timeline row for a given character and location. */
  async openFor(character, instance) {
    await this.page
      .getByRole("button", { name: `Edit activities for ${character} in ${instance}` })
      .click();
    await expect(this.dialog).toBeVisible();
  }

  row(index) {
    return this.dialog.getByRole("combobox", { name: "Activity kind" }).nth(index);
  }

  field(label) {
    return this.dialog.getByLabel(label, { exact: true });
  }

  add() {
    return this.dialog.getByRole("button", { name: "Add activity" }).click();
  }

  reset() {
    return this.dialog.getByRole("button", { name: "Reset to guesses" }).click();
  }

  async done() {
    await this.dialog.getByRole("button", { name: "Done" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

const test = base.extend({
  editor: async ({ page }, use) => {
    await use(new ActivityEditor(page));
  },
});

const mockDesktop = {
  dashboard: {
    generatedAt: "2026-07-26T12:00:00Z",
    knownActivityKinds: ["mythic_plus", "progress_raid", "legacy_raid", "levelling"],
    segments: [
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
        encounters: [{ id: 900, name: "The Curator", at: 1785064000, success: true }],
        character: "Aster-Vale",
        classFile: "SENTINEL",
        level: 12,
        day: "2026-07-26",
        instance: "Glass Caverns",
        difficulty: "Expedition",
        instanceType: "scenario",
        startedAt: 1785063600,
        endedAt: 1785065400,
        seconds: 1800,
        lootValue: 245000,
        goldDiff: 32000,
        currencyTotal: 4,
        reputationTotal: 25,
        housingXP: 0,
        transmogs: [{ id: 101, at: 1785065000, newAppearance: true }],
        currencies: [{ id: 7, name: "Glass Token", amount: 4 }],
        reputation: [{ faction: "Cavern Cartographers", amount: 25 }],
        achievements: [{ id: 9, name: "Into the Light", at: 1785065000, accountFirst: false }],
        levelUps: [{ level: 12, at: 1785065100 }],
        mounts: [{ id: 11, name: "Clockwork Glider", at: 1785065200 }],
        pets: [],
        quests: [{ id: 81, at: 1785065250 }],
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
        startedAt: 1784977200,
        endedAt: 1784978100,
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
        pets: [{ id: 12, name: "Mossling", at: 1784978000 }],
        quests: [],
        toys: [{ id: 13, name: "Pocket Orrery", at: 1784978050 }],
        housingItems: [{ id: 14, name: "Carved Reading Chair", at: 1784978060, warbandFirst: true }],
        housingLevelUps: [{ level: 2, at: 1784978070 }],
      },
    ],
  },
  settings: {
    wowPath: "C:\\Games\\Example MMO\\_retail_",
    lastSync: "2026-07-26T11:58:00Z",
  },
  chosenPath: "D:\\Games\\Example MMO",
  syncResult: { segmentCount: 2, added: 1, updated: 1 },
  installResult: { version: "0.8.0-dev" },
  appUpdate: { updated: false, version: "0.1.0" },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((mock) => {
    window.__Chronie_E2E__ = mock;
  }, mockDesktop);
  await page.goto("/");
});

test("renders a complete segment dashboard from the injected datastore", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Segments" })).toBeVisible();
  await expect(page.locator("#meta")).toContainText("2 segments");
  await expect(page.locator("#tiles")).toContainText("29g 50s");
  await expect(page.locator("#timeline")).toContainText("Aster-Vale");
  await expect(page.locator("#timeline")).toContainText("Glass Caverns");
  await expect(page.locator("#timeline")).toContainText("Into the Light");
  await expect(page.locator("#rows tr")).toHaveCount(2);

  await test.step("names what each segment was, and admits when it knows of nothing", async () => {
    await expect(page.locator("#timeline")).toContainText("Mythic+ run");
    await expect(page.locator("#timeline")).toContainText("+14");
    await expect(page.locator("#timeline")).toContainText("No activity recorded");
  });
});

test("lets the player correct what Chronie guessed a segment was", async ({ page, editor }) => {
  await test.step("correct the guess on a segment Chronie already labelled", async () => {
    await editor.openFor("Aster-Vale", "Glass Caverns");
    await editor.field("Keystone level").fill("18");
    await editor.field("Beat the timer").selectOption("no");
    await editor.done();

    await expect(page.locator("#timeline")).toContainText("+18");
    await expect(page.locator("#timeline")).toContainText("depleted");
  });

  await test.step("add an activity to a segment that had none", async () => {
    await editor.openFor("Brin-Hearth", "Copperwood");
    await editor.add();
    await editor.row(0).selectOption("levelling");
    await editor.field("Levels gained").fill("2");
    await editor.done();

    await expect(page.locator("#timeline")).toContainText("Levelling");
    await expect(page.locator("#timeline")).toContainText("2 levels");
  });

  await test.step("remove an activity that does not belong", async () => {
    await editor.openFor("Brin-Hearth", "Copperwood");
    await editor.dialog.getByRole("button", { name: "Remove Levelling" }).click();
    await editor.done();

    await expect(page.locator("#rows")).toContainText("Brin-Hearth");
    await expect(page.locator("#timeline")).not.toContainText("Levelling");
  });
});

test("filters segments by synthetic character and location", async ({ page }) => {
  await page.getByLabel("Filter segments").fill("copper");
  await expect(page.locator("#rows tr")).toHaveCount(1);
  await expect(page.locator("#rows")).toContainText("Brin-Hearth");

  await page.getByLabel("Filter segments").fill("");
  await page.getByLabel("Character").selectOption("Aster-Vale");
  await expect(page.locator("#rows tr")).toHaveCount(1);
  await expect(page.locator("#rows")).toContainText("Glass Caverns");
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
  await expect(page.locator("#setup-status")).toContainText("2 segments, 1 new");

  await page.getByRole("button", { name: "Install or update addon" }).click();
  await expect(page.locator("#setup-status")).toContainText("0.8.0-dev installed");

  await page.getByRole("button", { name: "Check for app update" }).click();
  await expect(page.locator("#setup-status")).toHaveText("Chronie is up to date.");
});
