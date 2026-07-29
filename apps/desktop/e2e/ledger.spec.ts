/**
 * The details view: every segment on its own row, and the filters over them.
 *
 * The view the other two are summaries of, so what it is held to is what it abbreviates
 * without dropping — and that a row opens into the same modal every other view opens.
 */

import { expect, test } from "./harness";
import { Ledger } from "./pages/ledger";
import { SegmentDetail } from "./pages/segment";

test("lists every segment on the details view and filters it", async ({ page }) => {
  const ledger = new Ledger(page);
  const detail = new SegmentDetail(page);

  await ledger.open();
  await expect(ledger.rows()).toHaveCount(3);

  // The ledger abbreviates, but not to the point of dropping what a gain came to: the
  // holding follows the currency and the standing follows the faction, in the one cell each
  // of them gets. A gain the client said nothing more about gets nothing more said.
  await test.step("a gain names what it left behind, where there was anything to name", async () => {
    await expect(ledger.cellSaying("Glass Token +4 (12,450)")).toBeVisible();
    await expect(ledger.cellSaying("Cavern Cartographers +25 (Honored)")).toBeVisible();
    await expect(ledger.cellSaying("Rustward Scrip")).not.toContainText("(");
    // One cell, both factions: the one the client could not place says only what was gained,
    // and the one it named a level for says the level even though no bar could be drawn for
    // it. The table has room for the name and never had room for the bar.
    await expect(ledger.cellSaying("Lamplighters")).toHaveText(
      "Lamplighters +10, Deepwater Wardens +40 (Exalted)",
    );
  });

  // The ledger abbreviates but does not number: an item the addon could put no name to is
  // looked up here too, in one request for the whole table rather than a picture per cell.
  await test.step("a transmog source is named rather than numbered", async () => {
    await expect(ledger.cellSaying("Wanderer's Mantle (new)")).toBeVisible();
    await expect(ledger.view).not.toContainText("Item 101");
    // And the one this install cannot describe keeps the name the addon caught.
    await expect(ledger.cellSaying("Storm Cloak (variant)")).toBeVisible();
  });

  await test.step("the box narrows it to a location", async () => {
    await ledger.search().fill("copperwood");
    await expect(ledger.rows()).toHaveCount(2);
    await ledger.search().fill("");
  });

  await test.step("and the picker to one character", async () => {
    await ledger.character().selectOption("Aster-Vale");
    await expect(ledger.rows()).toHaveCount(1);
    await expect(ledger.rows()).toContainText("Glass Caverns");
  });

  // From here the modal walks what the table is showing, which is the one row left.
  await test.step("a row opens the same detail the timeline does", async () => {
    await ledger.rows().first().click();
    await expect(detail.title()).toHaveText("Glass Caverns");
    await expect(detail.position()).toHaveText("1 of 1");
  });
});
