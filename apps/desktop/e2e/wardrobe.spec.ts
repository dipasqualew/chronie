/**
 * The other half of the game's wardrobe: every look it holds for one kind of place, whether or
 * not a set ever named it — and the same list drawn as twenty characters at once.
 *
 * A set is somebody at Blizzard's idea of an outfit, and the several thousand looks that belong
 * to none of them are reachable only here. What survives the switch between the two is the
 * outfit, because it lives beside both rather than inside either.
 */

import { expect, test } from "./harness";
import { GALLERY_LOOKS, GALLERY_PAGE } from "./mock";
import { Outfit, PATIENCE_MS, SetGrid, TransmogView } from "./pages/transmog";
import { Wardrobe, pixelsOf } from "./pages/wardrobe";

test("browses every look the game holds, as names and as characters", async ({ page }) => {
  // The only test here besides the sets that draws, and this one draws twenty at once. A CI
  // runner has no graphics card and renders all of it in software.
  test.slow();
  const transmog = new TransmogView(page);
  const sets = new SetGrid(page);
  const wardrobe = new Wardrobe(page);
  const outfit = new Outfit(page);
  await transmog.open();

  await test.step("she is wearing something out of a set to begin with", async () => {
    await sets.openSet("Emberforge Plate");
    await sets.wear("Emberforge Plate", "Head", "Emberforge Helm").click();
    await expect(outfit.slots()).toHaveCount(1);
  });

  // What the switch is for. The Coif belongs to no set, so no card in the grid behind this
  // could ever have reached it.
  await test.step("browsing by item reaches a look no set holds", async () => {
    await transmog.browseBy("Items");

    await expect(wardrobe.rows()).toContainText([
      "Coif of the Drowned Star", "Emberforge Helm", "Tideglass Crown",
    ]);
    await expect(wardrobe.count())
      .toHaveText("3 appearances · 1 look the game keeps encrypted");
  });

  // And what the switch does not do: she keeps what she has on. The helm went on out of a
  // set and the rail says so too — one look, however it was reached.
  await test.step("what she has on survives the switch, and the rail knows it", async () => {
    await expect.poll(() => outfit.worn())
      .toEqual(["Emberforge Helm · Head · Emberforge Plate"]);
    await expect(wardrobe.wear("Head", "Emberforge Helm")).toHaveAttribute("aria-pressed", "true");
    await expect(wardrobe.wear("Head", "Coif of the Drowned Star"))
      .toHaveAttribute("aria-pressed", "false");
  });

  await test.step("a look out of the wardrobe goes on her, and names no set", async () => {
    await wardrobe.wear("Head", "Coif of the Drowned Star").click();
    // Nothing came out of a set, so nothing claims one: the tip ends at the place it fills
    // rather than naming a set that does not exist.
    await expect.poll(() => outfit.worn()).toEqual(["Coif of the Drowned Star · Head"]);
    await expect.poll(() => outfit.drew("vertices")).toBe("976");
  });

  // The reason the browser reads what kind of thing an item is at all: the game files a
  // staff, a two-handed sword and a one-handed axe under one display type, so a picker built
  // on the game's own numbering could offer none of them.
  await test.step("one kind of weapon is picked out of everything held in a hand", async () => {
    await wardrobe.kind().selectOption({ label: "Staff" });
    await expect(wardrobe.rows()).toContainText(["Staff of the Quiet Tide"]);

    await wardrobe.kind().selectOption({ label: "One-handed sword" });
    await expect(wardrobe.rows()).toContainText(["Emberforge Blade"]);

    // A shield arrives in the same answer as those two and is not a weapon at all in the
    // game's filing — it is armour — so the kind that finds it is reading the item.
    await wardrobe.kind().selectOption({ label: "Shield" });
    await expect(wardrobe.rows()).toContainText(["Emberforge Aegis"]);
  });

  await test.step("a look out of one kind and a look out of another go on at once", async () => {
    await wardrobe.kind().selectOption({ label: "Staff" });
    await wardrobe.wear("Two-hand", "Staff of the Quiet Tide").click();
    await expect.poll(() => outfit.worn()).toEqual([
      "Coif of the Drowned Star · Head",
      "Staff of the Quiet Tide · Main hand",
    ]);
  });

  await test.step("a kind narrows by name and by class like the sets do", async () => {
    await wardrobe.kind().selectOption({ label: "Head" });
    await wardrobe.search().fill("coif");
    await expect(wardrobe.rows()).toContainText(["Coif of the Drowned Star"]);

    await wardrobe.search().fill("");
    // The Tideglass Crown is the one head of the three that any class may not wear.
    await wardrobe.klass().selectOption({ label: "Warrior" });
    await expect(wardrobe.rows())
      .toContainText(["Coif of the Drowned Star", "Emberforge Helm"]);
    await wardrobe.klass().selectOption("");
  });

  // The feature, and the benchmark, in one step — because they are the same claim. A gallery is
  // twenty characters drawn at once, and the way it fails is not an error: a window that made a
  // graphics context per row would get about sixteen out of the browser and then start losing
  // the ones it made first, so the grid would fill in at the bottom and go blank at the top.
  // Every one of the twenty carrying pixels is what says there is one context behind all of them.
  //
  // The backend half of this is `budget.rs`, which counts what a page of twenty costs to *build*
  // against what the same twenty cost one at a time. This is the half no count can reach: what
  // the window does with them after they arrive.
  await test.step("a page of the wardrobe is drawn as twenty characters at once", async () => {
    await wardrobe.kind().selectOption({ label: "Chest" });
    await expect(wardrobe.rows()).toHaveCount(GALLERY_LOOKS.length);

    const started = Date.now();
    await wardrobe.asModels().check();
    await expect(wardrobe.bodies()).toHaveCount(GALLERY_PAGE);
    await expect(wardrobe.rows()).toHaveCount(GALLERY_PAGE);
    // Every one of them, and the poll is what waits for the last: the rows paint as their
    // models arrive rather than all at once, so a count taken too early is a race.
    await expect.poll(() => wardrobe.painted(), { timeout: PATIENCE_MS }).toBe(GALLERY_PAGE);

    // A ceiling rather than a measurement. What it rules out is the order of magnitude — a
    // grid that takes a minute, or one that never finishes because the seventeenth context was
    // refused — and it is deliberately far above what the machine this runs on actually takes,
    // because a CI runner's clock is not an instrument. `budget.rs` explains the same choice
    // from the other side.
    expect(Date.now() - started).toBeLessThan(PATIENCE_MS);
  });

  // Turning one of them, which is the reason a tile is worth its size. The picture is redrawn
  // through the same one off-screen context every other tile is drawn through — so what this
  // rules out is a window that reached for a live pane per tile the moment one had to move,
  // which is the sixteen-context wall again by another route.
  //
  // The pixels are what say it happened. A canvas draws the same rectangle whichever way round
  // the thing on it is, and the DOM says nothing at all about an angle.
  await test.step("a picture can be turned where it sits", async () => {
    const picture = wardrobe.bodies().first();
    const before = await pixelsOf(picture);
    const box = await picture.boundingBox();
    if (!box) throw new Error("the first tile has no box to drag across");

    // Across half the tile, which is half a turn: enough that no framing or lighting accident
    // could leave the picture looking the way it did.
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => await pixelsOf(picture) !== before, { timeout: PATIENCE_MS })
      .toBe(true);
    // And the rest of the grid is untouched: one tile turned, not the page redrawn.
    await expect.poll(() => wardrobe.painted(), { timeout: PATIENCE_MS }).toBe(GALLERY_PAGE);
  });

  // The page shrinks to a fifth when the pictures come on, and grows back when they go off.
  // Twenty bodies is what the backend draws in about the time one takes; a hundred is not.
  await test.step("the page is smaller when it is drawn as characters", async () => {
    await expect(wardrobe.count())
      .toHaveText(`${GALLERY_PAGE} of ${GALLERY_LOOKS.length} appearances`);
    await wardrobe.asModels().uncheck();
    await expect(wardrobe.bodies()).toHaveCount(0);
    await expect(wardrobe.count()).toHaveText(`${GALLERY_LOOKS.length} appearances`);
    await wardrobe.kind().selectOption({ label: "Head" });
  });

  // And back again, with both halves as they were left: the sets keep their filters, the
  // wardrobe keeps its kind, and she keeps what was assembled out of the two of them.
  await test.step("switching back hands the sets over unchanged", async () => {
    await transmog.browseBy("Sets");
    await expect(sets.rows("Emberforge Plate")).toHaveCount(5);
    await expect(outfit.slots()).toHaveCount(2);

    await transmog.browseBy("Items");
    await expect(wardrobe.kind()).toHaveValue("armour-0");
    await expect(wardrobe.rows()).toHaveCount(3);
  });
});
