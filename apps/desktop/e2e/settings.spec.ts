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
