/**
 * The one thing on the transmog screen that is the reader's own.
 *
 * Everything the two browsers beside this draw is read out of the installed game and is the
 * same for anybody on this build. A star and a tag are not: they are what this person said
 * about it, out of Chronie's own database — which is why they are a scenario of their own.
 *
 * The whole argument for marking the *appearance* rather than the item or the set that named it
 * is here too: both halves of the browser are looking at one wardrobe, so a look starred in the
 * list is starred in the set that holds it.
 */

import { expect, test } from "./harness";
import { tagIt } from "./pages/ownSets";
import { SetGrid, TransmogView } from "./pages/transmog";
import { Wardrobe } from "./pages/wardrobe";

test("keeps what the reader said about the game's wardrobe", async ({ page }) => {
  const transmog = new TransmogView(page);
  const sets = new SetGrid(page);
  const wardrobe = new Wardrobe(page);
  await transmog.open();

  await test.step("what was said about a look before is on it now", async () => {
    await transmog.browseBy("Items");

    await expect(wardrobe.tags("Coif of the Drowned Star")).toHaveText(["wishlist"]);
    // And nothing was said about its neighbours, which is the ordinary case.
    await expect(wardrobe.tags("Emberforge Helm")).toHaveCount(0);
    await expect(wardrobe.star("Emberforge Helm")).toHaveAttribute("aria-pressed", "false");
  });

  await test.step("a look starred here is starred inside the set that holds it", async () => {
    await wardrobe.star("Emberforge Helm").click();
    await expect(wardrobe.star("Emberforge Helm")).toHaveAttribute("aria-pressed", "true");

    await transmog.browseBy("Sets");
    await sets.openSet("Emberforge Plate");
    await expect(sets.rowStar("Emberforge Plate", "Emberforge Helm"))
      .toHaveAttribute("aria-pressed", "true");
    // The set it sits in was not starred by starring what is in it.
    await expect(sets.star("Emberforge Plate")).toHaveAttribute("aria-pressed", "false");
    await sets.closeSet("Emberforge Plate");
  });

  await test.step("a set takes a tag with a value, and one without as a label", async () => {
    await tagIt(sets.card("Emberforge Plate"), "Emberforge Plate", "faction", "horde");
    await expect(sets.tags("Emberforge Plate")).toHaveText(["faction: horde"]);

    await tagIt(sets.card("Emberforge Plate"), "Emberforge Plate", "wishlist");
    await expect(sets.tags("Emberforge Plate")).toHaveText(["faction: horde", "wishlist"]);
  });

  await test.step("the grid narrows to one tag, and offers only the tags in use", async () => {
    await expect(sets.tagFilter().getByRole("option")).toHaveText([
      "Any tag", "faction", "faction: horde", "wishlist",
    ]);

    await sets.tagFilter().selectOption("faction\thorde");
    await expect(sets.sets()).toHaveText(["Emberforge Plate"]);

    await sets.tagFilter().selectOption("");
    await expect(sets.sets()).toHaveCount(4);
  });

  // The word rather than the picker, which is how somebody who can see the chip narrows to
  // it without learning where the dropdown is.
  await test.step("the search box reads the tags too", async () => {
    await sets.search().fill("horde");
    await expect(sets.sets()).toHaveText(["Emberforge Plate"]);
    await sets.search().fill("");
  });

  // And the way a reader finds any of that out without being told: the chip they are already
  // looking at is a button, and clicking it writes the question it stands for into the box. The
  // term left behind is the point — it is there to be added to, and it is there to be cleared.
  await test.step("a tag clicked on a card asks the grid for it, in words", async () => {
    await sets.askByTag("Emberforge Plate", "faction: horde").click();
    await expect(sets.search()).toHaveValue("faction:horde");
    await expect(sets.sets()).toHaveText(["Emberforge Plate"]);

    await sets.search().fill("");
    await expect(sets.sets()).toHaveCount(4);
  });

  // Only 205 was starred, in the fixture, and nothing done since has starred a second set —
  // starring the helm above starred a look.
  await test.step("the grid narrows to the starred sets", async () => {
    await sets.favouritesOnly().check();
    await expect(sets.sets()).toHaveText(["Duskwoven Shroud"]);
    await expect(sets.star("Duskwoven Shroud")).toHaveAttribute("aria-pressed", "true");

    await sets.favouritesOnly().uncheck();
    await expect(sets.sets()).toHaveCount(4);
  });

  await test.step("a tag comes off from the chip it is written on", async () => {
    await sets.dropTag("Emberforge Plate", "wishlist").click();

    await expect(sets.tags("Emberforge Plate")).toHaveText(["faction: horde"]);
    // And the picker forgets the choice nothing carries any more.
    await expect(sets.tagFilter().getByRole("option")).toHaveText([
      "Any tag", "faction", "faction: horde",
    ]);
  });

  await test.step("and a star comes off again, leaving the grid whole", async () => {
    await sets.star("Duskwoven Shroud").click();
    await expect(sets.star("Duskwoven Shroud")).toHaveAttribute("aria-pressed", "false");

    await sets.favouritesOnly().check();
    await expect(sets.sets()).toHaveCount(0);
    await sets.favouritesOnly().uncheck();
  });
});
