/**
 * What the account has, held against what the game has — which is the one question no addon in
 * the client is in a position to ask.
 *
 * The subtraction is the feature, and the rule it turns on is that an absence means a removal
 * only inside a reading that says it is complete. So this walks both halves of the fixture on
 * purpose: the achievements were walked to the end and their count is stated as fact, the mounts
 * were cut short and every number off them is hedged. A run that stopped at the achievements
 * would pass over the thing worth guarding.
 */

import { expect, test } from "./harness";
import { ALT, DEEP_CATEGORY, RICHEST_MISSING, WALKER } from "./mock";
import { Collection } from "./pages/collection";

test("says what the account is missing, and what that claim is worth", async ({ page }) => {
  const collection = new Collection(page);
  await collection.open();

  await test.step("the account is counted against the game's own tables", async () => {
    await expect(collection.holdings()).toHaveText("3 of 6 achievements · 1 of 3 mounts");
    await expect(collection.tally("Achievements", "Held")).toHaveText("3");
    await expect(collection.tally("Achievements", "The game has")).toHaveText("6");
    await expect(collection.tally("Achievements", "Still to get")).toHaveText("3");
    // Out of the game's book rather than the client's, because the earned total and the total
    // available have to be counted out of the same one or the fraction means nothing.
    await expect(collection.tally("Achievements", "Points")).toHaveText("60 of 95");
  });

  // Provenance first, and literally first: a figure whose provenance is a footnote is a figure
  // nobody learns to check, and a reading that did not finish licenses no subtraction at all.
  await test.step("what the walk claimed about itself is drawn above the numbers", async () => {
    expect(await collection.provenanceAboveTally("Achievements")).toBe(true);
    await expect(collection.reading("Achievements")).toContainText(
      `Read on ${WALKER}, on build 12.0.5.67823`,
    );
    await expect(collection.reading("Achievements")).toContainText("all the way through");

    // Even a whole reading cannot answer for the rows this install could not decrypt. They are
    // in the game's table and not in the total, and nothing else on screen would say so.
    await expect(collection.worth("Achievements")).toContainText(
      "2 rows of the game's own table came through encrypted",
    );
    // And it is said quietly. Every install has encrypted rows and always will, so drawn as an
    // alert this would be a red box that never changes — which is how a reader learns to stop
    // reading them, and the mount half below is the one that has to be read.
    await expect(collection.graveWorth("Achievements")).toHaveCount(0);
  });

  await test.step("a branch opens with what is left in it worth the most first", async () => {
    await collection.openCategory(DEEP_CATEGORY);

    await expect(collection.missingIn(DEEP_CATEGORY)).toContainText([
      RICHEST_MISSING,
      "Deeper into the Light",
      "The Long Road",
    ]);
    // And what put them in that order, drawn beside each title: the feat of strength worth
    // nothing at all is at the bottom rather than scattered through the things worth doing.
    await expect(collection.missingIn(DEEP_CATEGORY)).toContainText([/^25/, /^10/, /^0/]);
  });

  // The grouping is by the outermost branch and the rows name the innermost, which is the
  // difference between fifteen categories a player recognises and four hundred they do not.
  await test.step("the branches are the ones a player knows, and each row says where it really is", async () => {
    await expect(collection.categories()).toContainText([DEEP_CATEGORY, "Dungeons & Raids"]);
    await expect(collection.missingIn(DEEP_CATEGORY)).toContainText([
      "Tideglass Deeps",
      "Tideglass Deeps",
      "Feats of Strength",
    ]);
  });

  // The question the census pays for. One character did the walking and the client attributed
  // the whole account's history, so an alt nobody has logged into since 2011 is on this list.
  await test.step("one character's walk names everybody who earned anything", async () => {
    await expect(collection.carrierCell(WALKER, "2")).toBeVisible();
    await expect(collection.carrierCell(WALKER, "35")).toBeVisible();
    await expect(collection.carrierCell(ALT, "1")).toBeVisible();
    await expect(collection.carrierCell(ALT, "25")).toBeVisible();
  });

  // A year nobody played is a fact about a person. Two adjacent bars where there should be a
  // hole is the chart telling them something that did not happen.
  await test.step("a hole in the middle of somebody's play is drawn as a hole", async () => {
    await expect(collection.years()).toContainText(["2009", "2010", "2011", "2012", "2013"]);
    await expect(collection.year("2010")).toContainText("0 achievements");
    await expect(collection.year("2012")).toContainText("0 achievements");
  });

  // The other half of the fixture, and the reason it is shaped the way it is: the mount walk was
  // cut short by a logout, so nothing taken off it may be presented as fact.
  await test.step("a walk that was cut short is not allowed to read as a finished one", async () => {
    await collection.lookAt("Mounts");

    await expect(collection.reading("Mounts")).toContainText("not to the end");
    // Loudly, unlike the achievements above: this is the page saying a number under it is not
    // what it looks like, rather than that it is a little short of what the game has.
    await expect(collection.graveWorth("Mounts")).toContainText("upper bound");
    await expect(collection.tally("Mounts", "Still to get")).toHaveText("2");
  });

  // Somebody who has not got a mount wants to know where it is, which a name and a picture do
  // not say — and the handful the table says nothing about have to say that rather than nothing.
  await test.step("what is left says where the game keeps it, or admits it will not say", async () => {
    await expect(collection.mounts()).toContainText(["Tideglass Drake", "Unbroken Skystrider"]);
    await expect(collection.mount("Tideglass Drake")).toContainText(
      "Drop: The Tidewarden. Zone: Tideglass Deeps",
    );
    await expect(collection.mount("Unbroken Skystrider")).toContainText(
      "The game says nothing about where this one comes from.",
    );
  });

  // And the one thing on the screen that is not a reading. A census is provoked and never
  // scheduled, so somebody who knows better has to be able to say so — and the affordance has to
  // be honest that nothing happens until they next log in, or it is a button people press twice.
  await test.step("a reader who knows a reading is stale can ask for a fresh one", async () => {
    await expect(collection.askForACensus()).toBeEnabled();
    await expect(collection.lastAsk()).toHaveCount(0);

    await collection.askForACensus().click();

    await expect(collection.lastAsk()).toContainText("the next time you log in");
    // And goes quiet, because a second ask would be the same walk written into the game's folder
    // twice. The button coming back is what says the first one was collected.
    await expect(collection.askForACensus()).toBeDisabled();
  });
});
