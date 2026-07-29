/**
 * The view the other three cannot be: one where the character is the subject.
 *
 * The timeline cuts an evening across everybody who played it and the ledger's rows each
 * belong to one segment; neither can answer "what has this character been doing", which is
 * the question a player with eight alts asks first.
 *
 * One scenario, walking the pane the way a reader does: who they are, then what they are — the
 * balances that are true whenever you ask — then what they have been doing, which is the half a
 * time range means anything to. It ends where every other view ends: the same segment modal,
 * walking this character's own history and no more.
 *
 * **Everything about the activity half is asserted over "All time".** The fixture is dated from
 * one fixed evening and the ranges are reckoned from the clock on the machine running this, so
 * any narrower range would pass today and empty out later. What the default is worth checking is
 * that it *is* the default, which is a fact about the page rather than about the calendar.
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
    await expect(railColours(roster.entries())).resolves.toEqual([
      "rgb(255, 124, 10)",
      "rgb(63, 199, 235)",
    ]);
  });

  await test.step("and the one the view opened on is the one it is showing", async () => {
    await expect(roster.entries().first()).toHaveAttribute("aria-pressed", "true");
    await expect(
      roster.profile.getByRole("heading", { name: "Brin-Hearth", level: 2 }),
    ).toBeVisible();
    // Summary first: a reader arriving on somebody wants to know who they are before they
    // want a fortnight of their evenings.
    await expect(roster.pageTab("Summary")).toHaveAttribute("aria-selected", "true");
  });

  // The one picture on the page, and the only body in this app drawn on somebody the reader
  // did not invent: the wearer is already decided, so the clothes go on *their* character. It
  // is one of the sets this player saved at a transmogrifier, read off their own account.
  await test.step("the character is drawn in a set they saved in the game", async () => {
    await roster.pick("Aster-Vale");

    await expect(roster.drawn("Aster-Vale", "Tideglass")).toBeVisible();
  });

  // Brin-Hearth has been played with the addon on and saves nothing in game, which is a
  // different thing from a wardrobe nobody has read — and worth saying rather than leaving as
  // an empty frame.
  await test.step("and told plainly when there is nothing to dress them in", async () => {
    await roster.pick("Brin-Hearth");

    await expect(roster.figureNote("Brin-Hearth")).toContainText("No transmog sets saved in game");
  });

  await test.step("the summary adds up everything known about them", async () => {
    await roster.pick("Aster-Vale");
    await expect(roster.profile).toContainText("Mage · level 12");
    await expect(roster.stat("Played")).toHaveText("30m");
    await expect(roster.stat("Segments")).toHaveText("1");
    await expect(roster.stat("Days")).toHaveText("1");
    await expect(roster.stat("Looted")).toHaveText("24g 50s");
    await expect(roster.profile).toContainText("Mostly in Glass Caverns");
  });

  // The half of the story a segment cannot tell: what this character is carrying now, and how
  // far the rest of the account has got with the factions they are grinding. Both are tables
  // rather than sentences, because eight of either is a column to read down.
  await test.step("what they are holding is read against what the account holds", async () => {
    await expect(roster.holding("Currencies", "Glass Token")).toContainText("12,450");
    await expect(roster.holding("Currencies", "Glass Token")).toContainText("30,000");

    // The 6,000 on this row is the account's one pot read from here rather than this
    // character's share of it, and unlabelled it would read as a coincidence that the alt
    // beside them holds exactly as much.
    await expect(roster.holding("Currencies", "Warband Chit")).toContainText(
      "shared across the warband",
    );

    // Somebody else is out in front here, and who that is is the whole question in front of a
    // faction: a reputation is grind a warband does once.
    await expect(roster.holding("Reputation", "Cavern Cartographers")).toContainText(
      "Brin-Hearth · Revered",
    );
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

    // The furthest anybody has got with this one is this character, which is said as such
    // rather than by repeating the name at the top of the page.
    await expect(roster.holding("Reputation", "Deepwater Wardens")).toContainText("This character");
  });

  // The other half of the pane, and the only one a time range means anything to. Two weeks is
  // where it opens because that is roughly a tier's worth of habit; every assertion below is
  // made over all time, for the reason at the top of this file.
  await test.step("the activity page opens on the last fortnight", async () => {
    await roster.show("Activity");

    await expect(roster.range()).toHaveValue("fortnight");
  });

  // What somebody would say if you asked how the fortnight went, rather than a count of runs:
  // the level and the dungeon are the whole content of the sentence, and "1 Mythic+ run" would
  // throw both away.
  await test.step("what was done is listed in the order it was done", async () => {
    await roster.pick("Aster-Vale");
    await roster.show("Activity");
    await roster.range().selectOption("all");

    await expect(roster.ranged()).toContainText("1 segment");
    await expect(roster.activities()).toHaveCount(1);
    await expect(roster.activities().first()).toContainText("Mythic+ run");
  });

  // The summary strip is the session card's, which means it behaves the way it does there: a
  // summary standing for several things unfolds, and each of them is a way back. The one asked
  // for here is a quiet mark — two achievements that only caught this character up — which is
  // the harder half of the bargain: it carries no words on the pane at all, so the name it is
  // asked for is the only thing standing between it and being unreachable.
  await test.step("a summary of what it earned unfolds into the things it stands for", async () => {
    const achievements = roster.chip(/2 achievements/);
    await expect(achievements).toHaveAttribute("aria-expanded", "false");

    await achievements.click();
    await expect(roster.profile).toContainText("Into the Light");
    await roster.unfolded("Into the Light").click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.position()).toHaveText("1 of 1");
    await detail.close();
  });

  // The segments are the least of it and are folded away as such — a fortnight is forty of
  // them, and forty rows above the two facts a reader came for is why they moved down here.
  // The point of the whole thing is that opening one still lands where it always did: the row
  // is the timeline's row and the modal is the timeline's modal.
  await test.step("the segments are folded away, and one still opens the detail", async () => {
    await roster.pick("Brin-Hearth");
    await roster.show("Activity");
    await roster.range().selectOption("all");

    await expect(roster.ranged()).toContainText("2 segments");
    await expect(roster.segmentFold()).not.toHaveAttribute("open", "");
    await roster.openSegments("2 segments");

    // Two days on one character, which is the thing no session card can show: the timeline
    // files an evening under its date and this files a character under theirs.
    await expect(roster.days()).toHaveCount(2);
    await expect(roster.segments()).toHaveCount(2);

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
});
