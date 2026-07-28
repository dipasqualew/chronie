/**
 * One segment, met the way a reader meets one: from the card that summarised it.
 *
 * Two scenarios, because they are two. The first walks a segment in full — everything the
 * modal fills in out of the installed game, everything a gain is read against, and the way out
 * to Wowhead. The second corrects what Chronie guessed the segment was, which is the one thing
 * on this screen that writes.
 */

import { expect, test } from "./harness";
import { ActivityEditor, AppearancePicture, SegmentDetail } from "./pages/segment";
import { Shell } from "./pages/shell";
import { Timeline } from "./pages/timeline";

/** How long a picture of one appearance is allowed to take, on a runner with no graphics card. */
const PATIENCE_MS = 30_000;

test("digs from a session down into a single segment and back out again", async ({ page }) => {
  const shell = new Shell(page);
  const timeline = new Timeline(page);
  const detail = new SegmentDetail(page);
  const drawn = new AppearancePicture(page);
  await timeline.open();
  const first = timeline.sessions().first();

  // The shortest way down there, and the one the card is arranged around: the evening's
  // activities are the first thing on it, and each is the way into the segment it happened
  // in — where the fight-by-fight, the pictures and the correction all live.
  await test.step("an activity on the card goes straight to the run it was", async () => {
    await timeline.activities(first).first().click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await detail.close();
  });

  await test.step("and so does the segment row underneath it", async () => {
    await timeline.fold(first, "2 segments").click();
    await detail.openFor("Aster-Vale", "Glass Caverns");

    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.position()).toHaveText("1 of 2");
    await expect(detail.dialog).toContainText("The Curator");
    await expect(detail.dialog).toContainText("+14");
  });

  // The segment carries an id and a name; everything else about an achievement is read out
  // of the installed game after the segment is already on screen.
  await test.step("an achievement fills in with what the game says about it", async () => {
    const earned = detail.rowsIn("Achievements");
    await expect(earned).toHaveCount(3);
    await expect(earned.first()).toContainText("Reach the lighthouse at the end of the pier.");
    await expect(earned.first()).toContainText("Chronicles › Tideglass Deeps");
    await expect(earned.first()).toContainText("25 points");
    await expect(earned.first()).toContainText("Reward: Title & the lamplighter's coat");
    await expect(detail.iconsIn("Achievements")).toHaveCount(1);
  });

  // An install can only describe the achievements it has, and a row still has to draw: what
  // is left is the name the addon caught at the moment it was earned, which is what the
  // window showed before it was reading the game's tables at all.
  await test.step("an achievement the game says nothing about keeps what the addon knew", async () => {
    const unknown = detail.rowsIn("Achievements").nth(1);
    await expect(unknown).toContainText("Quiet Ascent");
    await expect(unknown).toContainText("account first");
    await expect(unknown).not.toContainText("points");
  });

  // The transmog the addon recorded is a number and nothing else — the client had not loaded
  // the item when it fired — so everything a reader recognises the piece by is read out of the
  // installed game after the segment is on screen: what it is called, what colour that name is
  // written in, what kind of armour it is and where it is worn.
  await test.step("a transmog source fills in as the piece of gear it is", async () => {
    const collected = detail.rowsIn("Transmog");
    await expect(collected).toHaveCount(1);
    await expect(collected).toContainText("Wanderer's Mantle");
    await expect(collected).toContainText("Leather");
    await expect(collected).toContainText("Shoulders");
    await expect(collected).toContainText("new appearance");
    // Rare, which is the colour every player reads without being told, and which is an
    // attribute rather than a style because the packaged window's policy drops inline styles.
    await expect(detail.linkTo("Wanderer's Mantle")).toHaveAttribute("data-quality", "3");
    await expect(detail.iconsIn("Transmog")).toHaveCount(1);
  });

  // And the way through from the number to a picture of it. The row says what the piece is
  // called and what kind of thing it is; what it *looks* like is three of the game's tables
  // away, and none of them is opened until this button is pressed — which is the whole reason
  // it is a button rather than a picture on every row.
  await test.step("a transmog source opens into a picture of itself", async () => {
    await drawn.open();
    await expect(drawn.title("Wanderer's Mantle")).toBeVisible();

    // What the pane is holding, which is what the outfit pane's own steps read and for the same
    // reason: a canvas that never drew is the same rectangle as one that did. The pixels cannot
    // be read here — a live pane keeps no drawing buffer to read back — so the vertex count the
    // stage writes out is the instrument.
    await expect(drawn.picture()).toBeVisible();
    await expect.poll(() => drawn.vertices(), { timeout: PATIENCE_MS }).toBe("1152");

    // Closing it puts the reader back on the segment they were part way through rather than
    // on the timeline — it is over the modal, not instead of it.
    await drawn.close();
    await expect(detail.rowsIn("Transmog")).toContainText("Wanderer's Mantle");
  });

  // "+4" and "+25" say what the run paid out and nothing about what that came to. The
  // holding beside the gain and the bar under the faction are the half that answers it.
  await test.step("a gain says where it left the character, not only what it was", async () => {
    await expect(detail.gainFor("Glass Token")).toContainText("+4 (12,450)");

    const standing = detail.standingBars("Honored with Cavern Cartographers");
    await expect(standing).toHaveJSProperty("value", 4200);
    await expect(standing).toHaveJSProperty("max", 12000);
    await expect(detail.gainFor("Cavern Cartographers")).toContainText("Honored 4,200 / 12,000");
  });

  // Those two numbers are still one character's. The account's are the ones that decide
  // whether the grind is worth continuing here at all.
  await test.step("a gain says what the whole account has, not only this character", async () => {
    await expect(detail.gainFor("Glass Token")).toContainText("30,000 across 2 characters");

    // The warband's pot must not be worded as a sum. "6,000 across 2 characters" says two
    // people hold some between them; there is one pot of 6,000 and both are looking at it.
    await expect(detail.gainFor("Warband Chit")).toContainText("6,000 shared across the warband");
    await expect(detail.gainFor("Warband Chit")).not.toContainText("across 2 characters");

    await expect(detail.gainFor("Cavern Cartographers"))
      .toContainText("Brin-Hearth is further along: Revered");
  });

  // The same split the character pane draws, in the place a reader meets one segment: what
  // this hour did to the wallet is settled forever, and what the character is carrying is the
  // latest reading of a wallet that has moved since. An unqualified balance beside a segment
  // from March would read as though it were March's.
  await test.step("the wallet's balance sits beside what the segment did to it", async () => {
    await expect(detail.gainFor("is carrying")).toContainText("Aster is carrying 12g 50s");

    const account = detail.gainFor("across the account");
    await expect(account).toContainText("172g 50s across the account");
    await expect(account).toContainText("120g 0s in the warband bank");
  });

  // And when the client said nothing, the window says nothing: no empty bracket after the
  // gain, and no bar at the bottom of a track the character was never on.
  await test.step("and says none of it when the client never said", async () => {
    await detail.next().click();
    await expect(detail.title()).toHaveText("Copperwood Depths");

    await expect(detail.gainFor("Rustward Scrip")).toContainText("+2");
    await expect(detail.gainFor("Rustward Scrip")).not.toContainText("(");
    await expect(detail.gainFor("Lamplighters")).toContainText("+10");
    // The level is worth saying even where its length is unknown; the bar is not, because a
    // bar can only be drawn somewhere, and there is nowhere known to draw this one.
    await expect(detail.gainFor("Deepwater Wardens")).toContainText("Exalted");
    await expect(detail.standingBars()).toHaveCount(0);
    // Nor does the account line speak when this character is the one out in front: the best
    // standing on the account is this character's own, and telling somebody they are behind
    // themselves is worse than saying nothing.
    await expect(detail.gainFor("Deepwater Wardens")).not.toContainText("further along");
    // The scrip is held by nobody else, so its account total is the number already on the
    // line and repeating it would say nothing.
    await expect(detail.gainFor("Rustward Scrip")).not.toContainText("across");

    await detail.previous().click();
    await expect(detail.title()).toHaveText("Glass Caverns");
  });

  await test.step("next and previous walk the play session, not all of history", async () => {
    await detail.next().click();
    await expect(detail.title()).toHaveText("Copperwood Depths");
    await expect(detail.position()).toHaveText("2 of 2");
    await expect(detail.next()).toBeDisabled();

    await detail.previous().click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.previous()).toBeDisabled();
  });

  // The window is not a browser and cannot become one: a link has to be handed out to the
  // real one. Following it in place would leave the reader stranded on a web page.
  await test.step("a quest and an achievement go out to the reader's own browser", async () => {
    await detail.linkTo("Quest 81").click();
    await detail.linkTo("Into the Light").click();
    await detail.linkTo("Wanderer's Mantle").click();
    await expect.poll(() => shell.openedUrls()).toEqual([
      "https://www.wowhead.com/quest=81",
      "https://www.wowhead.com/achievement=9",
      // By the id the segment recorded, whatever the game ended up calling the item.
      "https://www.wowhead.com/item=101",
    ]);
    await expect(detail.title()).toHaveText("Glass Caverns");
    expect(shell.url()).toContain("127.0.0.1:4399");
  });

  // What happened to an equipment set is a chip like any other milestone, and the thing it
  // unfolds into is the part a table could never hold: which slot, and what replaced what.
  await test.step("and the equipment set it changed is there, down to the slot", async () => {
    const change = detail.equipset("Raid updated");
    await expect(change).toHaveCount(1);

    const slots = detail.slotsOf("Raid updated");
    await expect(slots).toHaveCount(2);
    await expect(slots.first()).toContainText("Head");
    await expect(slots.first()).toContainText("Tideglass Crown");
    await expect(slots.first()).toContainText("623");
    await expect(slots.first()).toContainText("Deepwater Crown");
    await expect(slots.first()).toContainText("639");

    // A slot the edit cleared says what left it and shows nothing arriving, rather than
    // drawing as a row with a blank on both sides. The cloak is an item this install cannot
    // describe, which is what an item from a build newer than the one on disk looks like:
    // the name the addon caught, and no picture.
    await expect(slots.nth(1)).toContainText("Back");
    await expect(slots.nth(1)).toContainText("Storm Cloak");
    await expect(slots.nth(1)).toContainText("620");
  });

  // Both pieces of the slot are drawn as the items they are — the picture and the colour of
  // the name — rather than as text, which is the same component the transmog rows use.
  await test.step("and both sides of a slot are drawn as the items they are", async () => {
    await expect(detail.iconsIn("Equipment sets")).toHaveCount(2);
    await expect(detail.linkTo("Deepwater Crown")).toHaveAttribute("data-quality", "4");
    await detail.close();
  });

  // Saving a set is housekeeping, so on the card it is its icon and nothing more — but the
  // sentence it gave up is still the name a screen reader reads and still the hover, which
  // is the whole bargain that made drawing it quietly acceptable.
  await test.step("the chip that led here says all of that without any of the words", async () => {
    const chip = timeline.chip(first, /Raid updated/);
    await expect(chip).toHaveText("🎽");
    await expect(chip).toHaveAttribute("data-tip", /2 slots, −604 ilvl/);
    await expect(chip).toHaveAccessibleName(/2 slots, −604 ilvl/);

    await chip.click();
    await expect(detail.title()).toHaveText("Glass Caverns");
  });
});

/**
 * Turning one appearance, which is what the pane is for and what issue #142 said it was bad at.
 *
 * Two complaints, one cause. The pane orbits its target and its target is the origin, so what
 * the stage puts on the origin is what a drag turns and what a scroll zooms towards — and it
 * used to put the middle of whatever arrived there. What arrives for a chestpiece is a whole
 * two-metre character with the appearance painted somewhere on her, because most of the game's
 * armour has no geometry of its own: so the reader who clicked one row of a segment was handed
 * a woman, framed head to foot, orbiting her pelvis. The thing they asked about was not in the
 * middle of the pane, and it swung out of the pane entirely at the first drag.
 *
 * Both readings are of the camera against the point it is looking at, because a canvas draws
 * the same rectangle at any distance and any angle.
 */
test("frames one appearance on the part of the character it is worn on, and turns it there",
  async ({ page }) => {
    const timeline = new Timeline(page);
    const detail = new SegmentDetail(page);
    const drawn = new AppearancePicture(page);

    await timeline.open();
    await timeline.fold(timeline.sessions().first(), "2 segments").click();
    await detail.openFor("Aster-Vale", "Glass Caverns");
    await drawn.open();
    await expect.poll(() => drawn.vertices(), { timeout: PATIENCE_MS }).toBe("1152");

    let framed = { out: 0, above: 0 };

    await test.step("the camera stands at the slot rather than off the whole body", async () => {
      framed = await drawn.settled();
      // The row is a chestpiece, so the framing holds not quite half her height. Framing all of
      // what came back instead stands the camera thirty-eight units out — the fixture body is a
      // long bar, and that is the number this pane used to open on.
      expect(framed.out).toBeLessThan(5);
      expect(framed.out).toBeGreaterThan(0);
    });

    await test.step("a drag turns it and leaves it the same distance away", async () => {
      await drawn.drag(120, 0);
      const turned = await drawn.settled();
      // An orbit changes which way round the model is and nothing else, so the distance is the
      // statement that the drag turned the appearance rather than re-framed something.
      expect(turned.out).toBeCloseTo(framed.out, 1);
    });

    // The other half of the report: a drag with any vertical in it threw the camera up over the
    // model's head, where the controls pin the angle and the remaining drag becomes a spin about
    // the middle of the pane. A whole pane's worth of downward drag is nearly three full turns
    // of it, and a reader turning a helm does not mean any of them.
    await test.step("and no drag takes the camera over the top of it", async () => {
      await drawn.drag(0, 400);
      const tilted = await drawn.settled();
      // Straight overhead is 1. Sixty degrees up, which is as far as the pane goes, is 0.866.
      expect(tilted.above).toBeLessThan(0.9);
      expect(tilted.above).toBeGreaterThan(0.7);
    });
  });

/**
 * The same pane, on the kind of screen most readers have.
 *
 * Every other test in this suite runs at one device pixel per CSS pixel, which is the one
 * setting under which the pane above is correct by accident. `modelViewer.ts` sizes the
 * *drawing buffer* and deliberately sets no inline style on the canvas — the packaged window's
 * policy drops those — so a canvas laid out at the pane's size is a thing the stylesheet has to
 * say, once per pane, and one of the two panes had never said it.
 *
 * What that costs on a Retina screen is not a canvas twice too big. The stage is a flex item in
 * a column, so its automatic minimum size is its content, so a canvas twice the pane's height
 * makes the pane twice as tall; the `ResizeObserver` reads the new height and sets a buffer
 * twice *that*, and the pane doubles again on the next frame. It ends where the browser's
 * maximum element height does, some thirty-three million pixels down, with the model spread
 * across a canvas the reader is looking at a four-hundredth of — which is a modal that flickers
 * for a moment and then shows nothing at all.
 *
 * So the assertion is the shape of the pane rather than anything about the picture on it: the
 * canvas covers the stage and no more, and the stage is the 3:4 rectangle the stylesheet asks
 * for. Both are true at any scale, and only one scale could ever have caught them being false.
 */
test.describe("on a screen with more device pixels than CSS pixels", () => {
  test.use({ deviceScaleFactor: 2 });

  test("draws an appearance on a pane the size of the pane", async ({ page }) => {
    const timeline = new Timeline(page);
    const detail = new SegmentDetail(page);
    const drawn = new AppearancePicture(page);

    await timeline.open();
    await timeline.fold(timeline.sessions().first(), "2 segments").click();
    await detail.openFor("Aster-Vale", "Glass Caverns");
    await drawn.open();

    await expect.poll(() => drawn.vertices(), { timeout: PATIENCE_MS }).toBe("1152");

    // Read after the model is on the stage and the frames that follow it, because the runaway
    // this rules out needs a `ResizeObserver` tick or two to become visible and every one of
    // them makes it worse.
    await page.waitForTimeout(500);
    const measured = await drawn.measure();

    expect(measured.canvas).toEqual(measured.pane);
    // And the pane is still the shape the stylesheet asks for, which is what says the canvas
    // was fitted to the pane rather than the pane stretched to some canvas.
    expect(measured.pane[1]! / measured.pane[0]!).toBeCloseTo(4 / 3, 1);
  });
});

test("lets the player correct what Chronie guessed a segment was", async ({ page }) => {
  const timeline = new Timeline(page);
  const detail = new SegmentDetail(page);
  const editor = new ActivityEditor(page);
  await timeline.open();
  await timeline.fold(timeline.sessions().first(), "2 segments").click();

  await test.step("correct the guess on a segment Chronie already labelled", async () => {
    await detail.openFor("Aster-Vale", "Glass Caverns");
    await editor.open();
    await editor.field("Keystone level").fill("18");
    await editor.field("Beat the timer").selectOption("no");
    await editor.done();

    await expect(detail.dialog).toContainText("+18");
    await expect(detail.dialog).toContainText("depleted");
    await detail.close();
    await expect(timeline.view).toContainText("+18");
  });

  await test.step("add an activity to a segment that had none", async () => {
    await detail.openFor("Brin-Hearth", "Copperwood Depths");
    await editor.open();
    await editor.add();
    await editor.kind(0).selectOption("levelling");
    await editor.field("Levels gained").fill("2");
    await editor.done();
    await detail.close();

    await expect(timeline.view).toContainText("Levelling");
    await expect(timeline.view).toContainText("2 levels");
  });

  await test.step("remove an activity that does not belong", async () => {
    await detail.openFor("Brin-Hearth", "Copperwood Depths");
    await editor.open();
    await editor.remove("Levelling");
    await editor.done();
    await detail.close();

    await expect(timeline.view).not.toContainText("Levelling");
  });
});
