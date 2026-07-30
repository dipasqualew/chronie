/**
 * The screenshots category of Settings: the rules the addon acts on, and what is kept of a
 * picture once it has been taken.
 *
 * The whole of this feature is a page of controls whose only effect is what they wrote, so
 * every step reads the panel and the stored settings together.
 */

import { expect, test } from "./harness";
import { CaptureSettings } from "./pages/settings";

test("says what photographs itself, and what Chronie keeps of it", async ({ page }) => {
  const captures = new CaptureSettings(page);
  await captures.open();

  // What is on screen has to be what the install is running — a panel of unticked boxes on an
  // install that photographs account firsts is telling somebody the opposite of what happens.
  await test.step("the rules show what the install is actually running", async () => {
    await expect(captures.trigger(/An achievement nobody on this account had/)).toBeChecked();
    await expect(captures.trigger(/Every achievement this character earns/)).not.toBeChecked();
    await expect(captures.state()).toContainText("one kind of moment");
    await expect(captures.state()).toContainText("at most one a minute");
  });

  await test.step("ticking a rule saves the whole list", async () => {
    await captures.trigger(/A mount added to the collection/).check();

    await expect(captures.state()).toContainText("2 kinds of moment");
    // The unrecognised name is still there: the panel writes the whole list from its own
    // boxes, and a settings file somebody edited by hand must survive being written over.
    await captures.stored().toMatchObject({
      triggers: ["accountFirstAchievement", "mount", "somethingNewer"],
    });
    await expect(captures.panel).toContainText("somethingNewer");
  });

  // The addon offers a moment to the narrow rule first and the broad one second, so ticking
  // the broad one leaves the narrow one doing nothing on its own. Two ticked boxes where one
  // is inert is a state somebody would otherwise sit and stare at.
  await test.step("and says when a broader rule already covers a narrower one", async () => {
    await captures.trigger(/Every achievement this character earns/).check();

    await expect(captures.panel).toContainText(
      "Already covered by “Every achievement this character earns”",
    );
    await expect(captures.trigger(/An achievement nobody on this account had/)).toBeChecked();
  });

  // The half of the panel the desktop app acts on rather than the game. The default is a
  // re-encode, because the store is forever and the client writes megabytes a shot.
  await test.step("what is kept of a picture is a choice, and the default is not the raw file", async () => {
    await expect(captures.quality(/Fits a retina display/)).toBeChecked();
    await expect(captures.panel).toContainText("2560 pixels on the long side");
    await expect(captures.panel).toContainText("Nothing already in the store is re-compressed");

    await captures.quality(/Exactly what the game wrote/).check();

    await captures.stored().toMatchObject({ quality: "original" });
  });

  // The two opposite risks: a folder that never stops growing, and a folder somebody has
  // curated for years losing files. Which one is running has to be on screen.
  await test.step("and so is whether the game keeps its own copy", async () => {
    await expect(captures.panel).toContainText(
      "Chronie deletes the game’s copy once it holds a verified one of its own.",
    );

    await captures.originals().check();

    await expect(captures.panel).toContainText("its Screenshots folder goes on growing");
    await captures.stored().toMatchObject({
      quality: "original",
      keepOriginals: true,
    });
  });
});
