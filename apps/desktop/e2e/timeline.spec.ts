/**
 * The timeline: what the window opens on, and the view the whole app is arranged around.
 *
 * One scenario — reading an evening — because that is what it is: the card summarises, the
 * summary unfolds, the fold opens into segments, and every one of those is a way into the
 * modal. Splitting it into a test per assertion would rebuild the same page eight times over
 * to say eight things about it.
 */

import { expect, test } from "./harness";
import {
  borderColours, fillColours, inkColours, overlapFractions, railColours,
} from "./pages/paint";
import { SegmentDetail } from "./pages/segment";
import { Timeline } from "./pages/timeline";

test("stitches segments into play sessions and leads with what happened", async ({ page }) => {
  const timeline = new Timeline(page);
  const detail = new SegmentDetail(page);
  await timeline.open();
  const first = timeline.sessions().first();

  await test.step("an evening is one session even across a change of character", async () => {
    await expect(timeline.sessions()).toHaveCount(2);
    await expect(timeline.summary()).toContainText("2 play sessions");
    await expect(timeline.summary()).toContainText("3 segments");
    await expect(timeline.fold(first, "2 segments")).toBeVisible();
  });

  await test.step("the cast is named where a screen reader can reach it", async () => {
    const played = timeline.cast(first);
    await expect(played).toHaveCount(2);
    await expect(played.first()).toHaveAccessibleName(/Aster-Vale, Mage · level 12/);
  });

  // The circle is the only thing on a session card that says who played at a glance, and it
  // says it in the colour the game uses. A ring drawn in the fallback grey is the failure
  // this catches: everyone the same colour is the same as nobody named.
  await test.step("each character is drawn in their own class colour", async () => {
    await expect(borderColours(timeline.cast(first)))
      .resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
  });

  // The version of the step above that only read the border was green for as long as the
  // fill was a 22% wash of the class colour over the card — every circle the colour of the
  // page, with a thin coloured ring, and nothing that could tell. So the fill is asserted
  // outright: mage cyan then druid orange, filled, with the initials in the ink chosen to
  // read on them. Both of those take the near-black; the white ink belongs to death knight,
  // demon hunter and shaman, which no fixture casts — the palette's unit tests measure all
  // thirteen, and this covers the only thing they cannot, which is that the page arrives
  // with the colours still attached to it.
  await test.step("and filled with it, not merely ringed in it", async () => {
    const played = timeline.cast(first);

    await expect(fillColours(played)).resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
    await expect(inkColours(played)).resolves.toEqual(["rgb(11, 11, 11)", "rgb(11, 11, 11)"]);
  });

  // Filling the circles cost them the ring that used to be their outer edge: they now wear
  // two more, standing 3px proud of the disc on every side. The overlap the stack was tuned
  // to without them then swallowed every initial but the last — "MAGE, DRUID, PRIEST, ROGUE"
  // came out as "M. DI PI RO". So the stacking is held to what it is for: a cast that reads.
  await test.step("and stacked close enough to read as one cast, not so close as to bury it", async () => {
    const covered = await overlapFractions(timeline.cast(first));

    expect(covered.length).toBeGreaterThan(0);
    for (const fraction of covered) {
      // Overlapping at all is the intent — a row spaced out into separate discs is a
      // different design, and this is what would notice somebody had drifted into it.
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1 / 3);
    }
  });

  await test.step("both kinds of time are reported, because they differ", async () => {
    await expect(first).toContainText("50m");
    await expect(first).toContainText("52m elapsed");
  });

  // What somebody did leads the card; what it earned them follows as summaries; and the
  // running numbers, which are context rather than news, are marks with the figures inside
  // them. A currency written out in full on the card is the state this replaced.
  await test.step("what was done leads, and what it earned follows", async () => {
    const done = timeline.activities(first);

    await expect(done).toHaveCount(1);
    await expect(done.first()).toContainText("Mythic+ run");
    await expect(done.first()).toContainText("+14 · Glass Caverns · timed");

    // Three achievements that evening and only one of them news: the warband's own first is
    // what the card names, and the two that merely caught a character up are a mark below with
    // no words at all. A chip reading "3 achievements" is the state this replaced — it made an
    // evening of catching up look like an evening of rare ones.
    await expect(first).toContainText("Quiet Ascent");
    await expect(first).not.toContainText("achievements");
    await expect(first).toContainText("Clockwork Glider");
    await expect(first).not.toContainText("Glass Token");
  });

  // Every figure the strip used to write out, in the one hover per kind that replaced it —
  // and the hover is also the name, which is the whole reason it is allowed to be an icon.
  await test.step("the running numbers are marks with the figures in the hover", async () => {
    await expect(timeline.tallies(first)).toHaveCount(3);
    await expect(timeline.tally(first, "Gold")).toHaveAccessibleName("Gold: 3g 29s");
    await expect(timeline.tally(first, "Currency")).toHaveAccessibleName(
      "Currency: Warband Chit +100, Glass Token +4, Rustward Scrip +2",
    );
  });

  // Two characters levelled that evening, so the card says how much of it there was rather
  // than picking one of them to name and dropping the rest.
  await test.step("what happened several times is counted, not listed", async () => {
    await expect(first).toContainText("2 levels");
    await expect(first).not.toContainText("Into the Light");
    await expect(first).not.toContainText("Level 12");
  });

  /**
   * The quieter half of the card, which is what issue #161 was about. A quest handed in, a set
   * of gear saved and a character catching up on an achievement the warband already had are all
   * things that happened, and none of them is why anybody came back to the evening. So each is a
   * mark down among the running numbers with every word it would have worn in its name — and
   * pressing one still gets the reader everything a chip would have.
   */
  await test.step("what was not news is a mark, and still comes apart", async () => {
    for (const [said, icon] of [
      ["Quest 81", "📜"],
      [/Raid updated · 2 slots/, "🎽"],
      ["2 achievements · character firsts", "🏆"],
    ] as const) {
      await expect(timeline.mark(first, said)).toHaveText(icon);
    }

    // While the three that are worth telling somebody about still say so in words.
    for (const said of ["Quiet Ascent", "Clockwork Glider", "2 levels"]) {
      await expect(timeline.chip(first, said)).toContainText(said);
    }

    const caught = timeline.mark(first, "character firsts");
    await expect(caught).toHaveAttribute("aria-expanded", "false");
    await caught.click();
    await expect(first).toContainText("Into the Light");
    await expect(first).toContainText("Tideglass Delver");

    // And each of them is still the way back to the run it was recorded in, which is the whole
    // reason a summary is allowed to swallow the names in the first place.
    await timeline.unfolded(first, "Tideglass Delver").click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await detail.close();

    await caught.click();
    await expect(first).not.toContainText("Into the Light");
  });

  // The night before caught the same critter twice. A pet is the one collectible a player
  // can hold several of, so only the catch that grew the collection is worth a line — "2
  // pets" would be reporting a collection that moved by one.
  await test.step("a pet caught twice counts once", async () => {
    const before = timeline.sessions().nth(1);
    await expect(before).toContainText("Mossling");
    await expect(before).not.toContainText("2 pets");
  });

  // The card is a summary and stays one: it says an evening had two levels in it, and the
  // reader who wants to know which two asks for them. That is the whole shape of the view —
  // nothing is a list until somebody has asked for a list.
  await test.step("a summary unfolds into the things it counted", async () => {
    const levels = timeline.chip(first, /2 levels/);

    await expect(levels).toHaveAttribute("aria-expanded", "false");
    await levels.click();
    await expect(levels).toHaveAttribute("aria-expanded", "true");
    await expect(first).toContainText("Level 12");
    await expect(first).toContainText("Level 9");
  });

  await test.step("one of them goes to the segment it was recorded in", async () => {
    await timeline.unfolded(first, "Level 9").click();
    await expect(detail.title()).toHaveText("Copperwood Depths");
    await detail.close();
  });

  await test.step("and the card goes back to being a summary", async () => {
    await timeline.chip(first, /2 levels/).click();
    await expect(timeline.chip(first, /2 levels/)).toHaveAttribute("aria-expanded", "false");
    await expect(first).not.toContainText("Level 12");
  });

  // The summary the addon could put no name to at all. What it counted is a number, and what
  // the reader gets when they open it is the piece of gear — read out of the installed game
  // here on the timeline, the same way it is inside a segment.
  await test.step("a transmog summary unfolds into the pieces themselves", async () => {
    await timeline.chip(first, /new appearance/).click();

    await expect(first).toContainText("Wanderer's Mantle");
    await expect(first).not.toContainText("Item 101");
    // Named by what the row shows rather than by the number underneath it, so the button
    // reads to a screen reader the way it reads on screen.
    await expect(timeline.unfolded(first, "Wanderer's Mantle")).toBeVisible();
  });

  // A milestone belongs to the segment it came from, and saying so is most of the point of
  // the summary: the chip is the way back to the run that produced it.
  await test.step("a summary standing for one thing opens that segment outright", async () => {
    await timeline.chip(first, /Clockwork Glider/).click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await detail.close();
  });

  // A segment reads the same way its session does, and clicking it is how its summary comes
  // apart — the modal below is the list, so the row itself needs no controls of its own.
  await test.step("the fold opens into rows summarised the same way", async () => {
    await timeline.fold(first, "2 segments").click();

    const row = timeline.segments(first).first();
    await expect(row).toContainText("Quiet Ascent");
    await expect(row).toContainText("Clockwork Glider");
    await expect(row).toContainText("Level 12");
    // The running totals belong to the evening, not to a row inside it — but the small change
    // of the run does belong to the run, so the row keeps its marks after they are gone.
    await expect(row).not.toContainText("Glass Token");
    await expect(timeline.tallies(row)).toHaveCount(0);
    await expect(timeline.mark(row, "2 achievements · character firsts")).toBeVisible();
    await expect(timeline.mark(row, /Raid updated/)).toBeVisible();
  });

  // Each row carries its own character's colour rather than the session's. This evening
  // opens on a mage and finishes on a druid, so a rail that took the card's colour — which
  // is what it does if a row forgets to name its own class, since the property is inherited
  // — would come out cyan twice and say nothing about who played what.
  await test.step("and each row wears the class colour of whoever played it", async () => {
    await expect(railColours(timeline.segments(first)))
      .resolves.toEqual(["rgb(63, 199, 235)", "rgb(255, 124, 10)"]);
  });
});
