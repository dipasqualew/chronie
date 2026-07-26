import { expect, test as base } from "@playwright/test";

/**
 * The window addressed the way a user addresses it: by the names and roles on screen.
 * Nothing here knows a CSS class beyond the containers it scopes a search to, so a restyle
 * cannot break the test and a change that makes something unreachable by keyboard or screen
 * reader will.
 */
class SegmentDetail {
  constructor(page) {
    this.page = page;
    this.dialog = page.locator("#segment-detail");
  }

  /** Opens the modal from the timeline row for a given character and location. */
  async openFromTimeline(character, instance) {
    await this.page.getByRole("button", { name: new RegExp(`Open segment: ${character} in ${instance}`) }).click();
    await expect(this.dialog).toBeVisible();
  }

  title() {
    return this.dialog.getByRole("heading", { level: 2 });
  }

  position() {
    return this.dialog.locator(".detail-position");
  }

  next() {
    return this.dialog.getByRole("button", { name: "Next segment" }).click();
  }

  previous() {
    return this.dialog.getByRole("button", { name: "Previous segment" }).click();
  }

  async close() {
    await this.dialog.getByRole("button", { name: "Close segment" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

class ActivityEditor {
  constructor(page) {
    this.page = page;
    this.dialog = page.locator("#activity-editor");
  }

  /** The editor is only reachable through a segment's detail, which is where editing lives. */
  async open() {
    await this.page.locator("#segment-detail").getByRole("button", { name: "Edit activities" }).click();
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

  async done() {
    await this.dialog.getByRole("button", { name: "Done" }).click();
    await expect(this.dialog).toBeHidden();
  }
}

const test = base.extend({
  detail: async ({ page }, use) => {
    await use(new SegmentDetail(page));
  },
  editor: async ({ page }, use) => {
    await use(new ActivityEditor(page));
  },
});

// Two evenings: the first is a keystone run followed two minutes later by an alt, which is
// the case that has to fold into one play session; the second is a day earlier and must not.
const EVENING = 1785063600;
const NIGHT_BEFORE = 1784977200;

const mockDesktop = {
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
  settings: {
    wowPath: "C:\\Games\\Example MMO\\_retail_",
    lastSync: "2026-07-26T11:58:00Z",
  },
  chosenPath: "D:\\Games\\Example MMO",
  syncResult: { segmentCount: 3, added: 1, updated: 1 },
  installResult: { version: "0.8.0-dev" },
  appUpdate: { updated: false, version: "0.1.0" },
};

const timeline = (page) => page.locator("#timeline");
const sessions = (page) => page.locator("#timeline .session");

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
