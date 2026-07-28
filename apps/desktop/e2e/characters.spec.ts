/**
 * The view the other three cannot be: one where the character is the subject.
 *
 * The timeline cuts an evening across everybody who played it and the ledger's rows each
 * belong to one segment; neither can answer "what has this character been doing", which is
 * the question a player with eight alts asks first.
 *
 * One scenario, ending where every other view ends: the same segment modal, walking this
 * character's own history and no more.
 */

import { expect, test } from "./harness";
import { Roster } from "./pages/characters";
import { railColours } from "./pages/paint";
import { SegmentDetail } from "./pages/segment";

test("gives every character a page of their own", async ({ page }) => {
  const roster = new Roster(page);
  const detail = new SegmentDetail(page);
  await roster.open();

  // Recency, not hours: Brin-Hearth logged out last, so Brin-Hearth is who the view opens on.
  await test.step("the roster is everybody, most recently played first", async () => {
    await expect(roster.entries()).toHaveCount(2);
    await expect(roster.entries().first()).toContainText("Brin-Hearth");
    await expect(roster.entries().nth(1)).toContainText("Aster-Vale");
    await expect(roster.summary()).toContainText("2 characters");
    await expect(roster.summary()).toContainText("3 segments");
    await expect(roster.summary()).toContainText("1h 05m played");
  });

  // The same rail a segment row wears, for the same reason: the roster is a list of people,
  // and the colour is what tells them apart before the name has been read.
  await test.step("each of them wears their own class colour", async () => {
    await expect(railColours(roster.entries()))
      .resolves.toEqual(["rgb(255, 124, 10)", "rgb(63, 199, 235)"]);
  });

  await test.step("and the one the view opened on is the one it is showing", async () => {
    await expect(roster.entries().first()).toHaveAttribute("aria-pressed", "true");
    await expect(roster.profile.getByRole("heading", { name: "Brin-Hearth", level: 2 }))
      .toBeVisible();
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
    const standing = roster.standingWith(/Cavern Cartographers/);
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

  // The point of the whole thing: a segment met here is the segment met anywhere else. The row
  // is the timeline's row and the modal is the timeline's modal, so a change to what a segment
  // says lands in both views at once rather than in whichever one somebody remembered.
  await test.step("a row opens the detail, walking that character's history and no more", async () => {
    await roster.segments().first().click();
    await expect(detail.title()).toHaveText("Copperwood Depths");
    // Two segments, both Brin-Hearth's — the evening the modal walks from the timeline holds
    // Aster-Vale's keystone run too, and it has no business in a character's own history.
    await expect(detail.position()).toHaveText("1 of 2");

    await detail.next().click();
    await expect(detail.title()).toHaveText("Copperwood");
    await expect(detail.next()).toBeDisabled();
    await detail.close();
  });

  // The summary strip is the session card's, which means the chips behave the way they do
  // there: a summary standing for several things unfolds, and each of them is a way back.
  await test.step("a summary of several unfolds into them, and they lead back to the segment", async () => {
    await roster.pick("Aster-Vale");
    const achievements = roster.chip(/2 achievements/);
    await expect(achievements).toHaveAttribute("aria-expanded", "false");

    await achievements.click();
    await expect(roster.profile).toContainText("Into the Light");
    await roster.unfolded("Into the Light").click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.position()).toHaveText("1 of 1");
    await detail.close();
  });
});
