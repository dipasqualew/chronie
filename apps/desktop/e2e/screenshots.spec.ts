/**
 * The photographs of an evening, which is what the rest of this history is a caption for.
 *
 * The whole loop in one test, because the pieces only mean anything together: an evening's
 * pictures fold out of the card that summarised it, one of them opens full size, the sentence
 * under it can be rewritten, and the thing itself can be thrown away.
 */

import { expect, test } from "./harness";
import { NOTED } from "./mock";
import { Screenshots } from "./pages/screenshots";
import { SegmentDetail } from "./pages/segment";
import { Shell } from "./pages/shell";
import { Timeline } from "./pages/timeline";

test("shows an evening's screenshots, and lets one be annotated or deleted", async ({ page }) => {
  const shell = new Shell(page);
  const timeline = new Timeline(page);
  const shots = new Screenshots(page);
  const detail = new SegmentDetail(page);
  await timeline.open();
  const card = timeline.sessions().first();

  await test.step("the card counts them, and says how many are only markers", async () => {
    // Four captures in the evening across two segments, and one of them is a marker whose
    // file was never found — which is said on the way in rather than discovered by counting.
    await expect(timeline.fold(card, /screenshots/))
      .toContainText("3 screenshots · 1 without a file");
  });

  const tiles = await shots.unfold(card);
  await expect(tiles).toHaveCount(4);

  // The pictures cross the bridge as `data:` URLs and the browser has to decode them, which is
  // the half a fixture of placeholder strings would not have proved.
  await test.step("each tile fills with the picture Chronie holds", async () => {
    await expect(shots.thumbnailsIn(card)).toHaveCount(3);
    await expect(shots.thumbnailsIn(card).first()).toHaveJSProperty("naturalWidth", 4);
  });

  // A note is typed by a person and drawn in three places. React writes it as a value in two
  // of them; the floating tooltip is handed HTML, which is the one that has to escape it.
  //
  // The assertion is that the tags are *text*: a note that reached the page as markup would
  // have been parsed into a bold word, and its text would have lost the tags rather than
  // showing them. So finding "<b>first</b>" written out is exactly finding it escaped.
  await test.step("a note containing markup is text on the tile and in the tooltip", async () => {
    await expect(tiles.first()).toContainText(NOTED);

    await tiles.first().hover();
    await expect(shell.tooltip()).toBeVisible();
    await expect(shell.tooltip()).toContainText(NOTED);
  });

  await test.step("a marker with no file says so instead of showing a broken picture", async () => {
    await expect(tiles.nth(2)).toContainText("could not find the file");
    await shots.open(tiles.nth(2));
    await expect(shots.picture()).toHaveCount(0);
    await expect(shots.viewer).toContainText("could not find the file");
    await shots.close();
  });

  await test.step("opening one shows the picture at the size it was taken", async () => {
    await shots.open(tiles.first());
    await expect(shots.picture()).toHaveJSProperty("naturalWidth", 8);
    await expect(shots.viewer).toContainText("Aster-Vale · Glass Caverns");
    await expect(shots.viewer).toContainText("3.1 MB");
    await expect(shots.position()).toHaveText("1 of 4");
  });

  await test.step("and the reader can walk the evening from inside it", async () => {
    await shots.step("Next screenshot").click();
    await expect(shots.position()).toHaveText("2 of 4");
    // The one Chronie took by itself says which rule asked for it, which is the whole
    // difference between it and one somebody pressed the key for.
    await expect(shots.viewer).toContainText("Taken for an account first");
    await shots.step("Previous screenshot").click();
    await expect(shots.position()).toHaveText("1 of 4");
  });

  await test.step("the note can be rewritten, and the tile says what was stored", async () => {
    await expect(shots.note()).toHaveValue(NOTED);
    await shots.note().fill("Yogg-Saron, no lights");
    await shots.button("Save note").click();

    await expect(tiles.first()).toContainText("Yogg-Saron, no lights");
    await expect(tiles.first()).not.toContainText(NOTED);
  });

  await test.step("and cleared, which is a note nobody wrote rather than an empty one", async () => {
    await shots.button("Clear note").click();

    await expect(shots.note()).toHaveValue("");
    await expect(tiles.first()).not.toContainText("Yogg-Saron");
    // With no note the tile falls back to where it was taken, which is the next best caption.
    await expect(tiles.first()).toContainText("Glass Caverns");
  });

  // Deleting takes a file with it and cannot be undone, so it is asked about first — and the
  // question says the picture goes as well as the entry.
  await test.step("deleting asks first, and says the picture goes with it", async () => {
    await shots.button("Delete").click();
    await expect(shots.warning()).toContainText("The picture is deleted from Chronie's storage");

    await shots.button("Keep it").click();
    await expect(shots.warning()).toHaveCount(0);
    await expect(tiles).toHaveCount(4);
  });

  await test.step("and then does both halves", async () => {
    await shots.button("Delete").click();
    await shots.button("Yes, delete it").click();

    await expect(shots.viewer).toBeHidden();
    await expect(tiles).toHaveCount(3);
    await expect(timeline.fold(card, /screenshots/))
      .toContainText("2 screenshots · 1 without a file");
  });

  // The same pictures, filed where they were taken: a session's grid is the evening's, and a
  // segment's is its own.
  await test.step("a segment shows only the screenshots taken during it", async () => {
    await timeline.fold(card, "2 segments").click();
    await detail.openFor("Brin-Hearth", "Copperwood Depths");

    await expect(shots.tilesIn(detail.dialog)).toHaveCount(1);
    await detail.close();
  });
});
