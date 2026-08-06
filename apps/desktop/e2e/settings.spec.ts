/**
 * The first category of Settings: where the game is, and everything that reaches out of the
 * window from there.
 *
 * One scenario, in the order somebody meets it on a fresh install — find the folder, save it,
 * pull what the game has written, put the addon in place, and ask whether this Chronie is the
 * current one. Every step of it is a button whose only visible effect is the line underneath.
 */

import { expect, test } from "./harness";
import { GameAndSync } from "./pages/settings";

test("drives the game folder, sync, addon installation and app update checks", async ({ page }) => {
  const setup = new GameAndSync(page);
  await setup.open();

  await test.step("the folder Chronie is already using is the one on screen", async () => {
    await expect(setup.folder()).toHaveValue("C:\\Games\\Example MMO\\_retail_");
  });

  await test.step("browsing for another one fills it in", async () => {
    await setup.button("Browse…").click();
    await expect(setup.folder()).toHaveValue("D:\\Games\\Example MMO");
  });

  await test.step("saving it says so", async () => {
    await setup.button("Save").click();
    await expect(setup.state()).toHaveText("Game folder saved.");
  });

  await test.step("a sync says how much it found and how much of it was new", async () => {
    await setup.button("Sync now").click();
    await expect(setup.state()).toContainText("3 segments, 1 new");
  });

  await test.step("installing the addon says which version went in", async () => {
    await setup.button("Install or update addon").click();
    await expect(setup.state()).toContainText("0.8.0-dev installed");
  });

  await test.step("and checking for an update says when there is nothing to do", async () => {
    await setup.button("Check for app update").click();
    await expect(setup.state()).toHaveText("Chronie is up to date.");
  });
});

/**
 * The one setting on this panel, and the only one anywhere that decides what the addon starts
 * without being asked.
 *
 * Its own scenario rather than a step of the one above, because it is a different question: the
 * buttons up there all reach out of the window and are held to their status line, and this is a
 * switch whose whole claim is that what was ticked is what was stored. Both halves are checked
 * for that reason — a box that draws itself ticked and saved nothing looks identical on screen.
 */
test("walks the account by itself only once somebody has asked it to", async ({ page }) => {
  const setup = new GameAndSync(page);
  await setup.open();

  await test.step("a fresh install draws it unticked", async () => {
    await expect(setup.census()).not.toBeChecked();
    await setup.storedCensus().toBe(false);
  });

  await test.step("the sentence beside it says what to use instead", async () => {
    await expect(setup.panel).toContainText("Resync");
  });

  await test.step("ticking it says so, and is what the backend was told", async () => {
    await setup.census().check();
    await expect(setup.state()).toHaveText("Chronie will walk the account after a loading screen.");
    await setup.storedCensus().toBe(true);
  });

  await test.step("and unticking it puts the account back where it was", async () => {
    await setup.census().uncheck();
    await expect(setup.state()).toHaveText("Chronie will only walk the account when asked.");
    await setup.storedCensus().toBe(false);
  });
});
