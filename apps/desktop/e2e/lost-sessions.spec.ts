/**
 * The evening the game never wrote out.
 *
 * The addon keeps a session in memory and the client serialises it at logout, so a crash takes
 * the whole evening with it — and the file left on disk still holds the session before it,
 * which is why nothing about the loss shows up in the history itself. The backend catches it
 * by holding the client's combat log against the newest segment on record; what this spec is
 * about is the only part a player ever sees, which is whether the timeline admits it.
 *
 * Two scenarios, and the quiet one matters as much as the loud one: a notice that appeared on
 * an ordinary evening would be one nobody read on the evening it was true.
 */

import { expect, test } from "./harness";
import { LostSession } from "./pages/lostSession";
import { Timeline } from "./pages/timeline";

test("says so on the timeline when a session was played and never written", async ({ page }) => {
  const lost = new LostSession(page);
  const timeline = new Timeline(page);

  await test.step("the backend reports play the history does not contain", async () => {
    await lost.answer({
      kind: "missing",
      gap: {
        recordedTo: 1_784_977_200,
        playedTo: 1_785_063_600,
        log: "WoWCombatLog-072612_183012.txt",
      },
    });
    await timeline.open();
  });

  await test.step("the timeline says how much is missing, and why", async () => {
    await expect(lost.notice()).toBeVisible();
    await expect(lost.notice()).toContainText("missing up to 24h 00m of play");
    await expect(lost.notice()).toContainText("crash or a force-quit");
  });

  // The claim is about a file on the reader's own disk, so the notice names it. A warning
  // nobody can go and check is a warning nobody should believe.
  await test.step("it names the file the claim was read out of", async () => {
    await expect(lost.notice()).toContainText("WoWCombatLog-072612_183012.txt");
  });

  // Nothing recovers a session the game never wrote anywhere. Saying so is what stops a
  // reader hunting the settings for a Recover button that cannot exist.
  await test.step("it does not offer to get the session back", async () => {
    await expect(lost.notice()).toContainText("Nothing recovers those segments");
  });

  // The counts above it still describe what is on screen. The notice contradicts them on
  // purpose and must not replace them.
  await test.step("the history it does hold is still described", async () => {
    await expect(timeline.summary()).toContainText("segment");
  });
});

test("says nothing at all on an ordinary evening", async ({ page }) => {
  const lost = new LostSession(page);
  const timeline = new Timeline(page);
  await timeline.open();

  // The shared world answers `complete`, which is what every other spec in this suite runs
  // against — so this also proves the notice is not quietly in all of their pages.
  await expect(lost.notice()).toHaveCount(0);
});
