/**
 * The two browsers that are not the game's: the sets the reader assembled here, and the ones
 * the player saved in the game itself.
 *
 * Two scenarios, because they are opposites. One is made by the page under test — so it starts
 * at none, and every claim about it is a claim about something that survived being written. The
 * other can only ever arrive from outside, which makes a fixture the only way it is populated
 * at all, and it is the one browser of the four that is about a *character*.
 */

import { expect, test } from "./harness";
import { InGameSets, YourSets, tagIt } from "./pages/ownSets";
import { Outfit, TransmogView } from "./pages/transmog";
import { Wardrobe } from "./pages/wardrobe";

test("keeps what she has on as a set of the reader's own", async ({ page }) => {
  test.slow();
  const transmog = new TransmogView(page);
  const wardrobe = new Wardrobe(page);
  const yours = new YourSets(page);
  const outfit = new Outfit(page);
  await transmog.open();

  // An outfit out of the game's whole wardrobe: a head that belongs to no set at all, and a
  // staff. Until this, it lasted exactly as long as the window did.
  await test.step("she is dressed in a helm and a staff to begin with", async () => {
    await transmog.browseBy("Items");
    await wardrobe.wear("Head", "Coif of the Drowned Star").click();
    await wardrobe.kind().selectOption({ label: "Staff" });
    await wardrobe.wear("Two-hand", "Staff of the Quiet Tide").click();
    await expect(outfit.slots()).toHaveCount(2);
  });

  await test.step("what she has on is saved as a set of the reader's own", async () => {
    await transmog.browseBy("Yours");
    await expect(yours.saying("No sets of your own yet")).toBeVisible();

    await outfit.saveAs("  Deeps  run ");

    // Tidied by the backend and named by what came back, rather than by what was typed.
    await expect(yours.names()).toHaveText(["Deeps run"]);
    await expect(yours.card("Deeps run")).toContainText("2 pieces");
    // Saving is a note taken, not a door closed: she is still wearing it.
    await expect(outfit.slots()).toHaveCount(2);
  });

  await test.step("a saved set lists the looks it was made of", async () => {
    await expect(yours.pieces("Deeps run")).toHaveCount(2);
    await expect(yours.wear("Deeps run", "Head", "Coif of the Drowned Star")).toBeVisible();
    await expect(yours.wear("Deeps run", "Two-hand", "Staff of the Quiet Tide")).toBeVisible();
  });

  // The whole round trip, and the only claim worth making about a saved set: it goes back on,
  // out of the database, exactly as it went in.
  await test.step("the character is dressed in a saved set again from nothing", async () => {
    await outfit.clear();
    await expect(outfit.slots()).toHaveCount(0);

    await yours.wearAll("Deeps run").click();

    await expect
      .poll(() => outfit.worn())
      .toEqual([
        "Coif of the Drowned Star · Head · Deeps run",
        "Staff of the Quiet Tide · Main hand · Deeps run",
      ]);
    // The same body the two looks asked for when they were picked out of the game itself: the
    // outfit is keyed by its display ids, so a body arriving at all says the saved set asked
    // for the same one, and nothing was lost on the way through Chronie's own storage.
    await expect.poll(() => outfit.drew("vertices")).toBe("976");
  });

  await test.step("one piece of a saved set goes on without the rest of it", async () => {
    await outfit.clear();
    await yours.wear("Deeps run", "Head", "Coif of the Drowned Star").click();
    await expect(outfit.slots()).toHaveCount(1);
  });

  // Names are unique without regard to case, so a name already used saves over that set —
  // and the button says which of the two it is about to do before it is clicked.
  await test.step("typing a name already used offers to replace that set", async () => {
    await outfit.name().fill("deeps RUN");
    await expect(outfit.keep()).toHaveText("Replace Deeps run");

    await outfit.keep().click();

    // One set still, holding the one piece she has on now.
    await expect(yours.names()).toHaveText(["deeps RUN"]);
    await expect(yours.pieces("deeps RUN")).toHaveCount(1);
  });

  // A set of the reader's own takes any mark a Blizzard set takes, because it is a third kind
  // of subject rather than a second feature.
  await test.step("a saved set is starred and tagged like one the game ships", async () => {
    await yours.star("deeps RUN").click();
    await expect(yours.star("deeps RUN")).toHaveAttribute("aria-pressed", "true");

    await tagIt(yours.card("deeps RUN"), "deeps RUN", "for", "the alt");
    await expect(yours.tags("deeps RUN")).toHaveText(["for: the alt"]);

    await yours.tagFilter().selectOption("for\tthe alt");
    await expect(yours.names()).toHaveText(["deeps RUN"]);
    await yours.tagFilter().selectOption("");
  });

  // Which of their own sets has the staff in it is a question neither browser beside this one
  // could answer, because neither of them is about what the reader put together.
  await test.step("a saved set is found by what is in it", async () => {
    await yours.search().fill("coif");
    await expect(yours.names()).toHaveText(["deeps RUN"]);

    await yours.search().fill("aegis");
    await expect(yours.names()).toHaveCount(0);
    await expect(yours.saying("Nothing matches")).toBeVisible();
    await yours.search().fill("");
  });

  await test.step("and a saved set is thrown away, after being asked twice", async () => {
    await yours.askToDelete("deeps RUN").click();
    // The first click only asks: the set is still there, with a way back out of it.
    await expect(yours.names()).toHaveText(["deeps RUN"]);
    await yours.keep("deeps RUN").click();
    await expect(yours.names()).toHaveText(["deeps RUN"]);

    await yours.delete("deeps RUN");

    await expect(yours.names()).toHaveCount(0);
    await expect(yours.saying("No sets of your own yet")).toBeVisible();
    // What she has on is untouched by the set that held it going away.
    await expect(outfit.slots()).toHaveCount(1);
  });
});

test("reads the sets the player saved in the game, and sends one back", async ({ page }) => {
  test.slow();
  const transmog = new TransmogView(page);
  const inGame = new InGameSets(page);
  const outfit = new Outfit(page);
  await transmog.open();

  // The only browser of the four that is about a *character*. Blizzard's sets, the whole
  // wardrobe and the reader's own are the same for everybody logged in; these were put together
  // at a transmogrifier by somebody, and a roster of alts is a wardrobe each.
  await test.step("the sets saved in the game are grouped by who saved them", async () => {
    await transmog.browseBy("Personal in-game sets");

    await expect(inGame.characters()).toHaveText(["Aster-Vale"]);
    // Brin-Hearth has been played with the addon on and saves nothing in game, which is a
    // heading with nothing under it — so they are not drawn, and the count above is of what is.
    await expect(inGame.names()).toHaveText(["Tideglass", "Unnamed set"]);
    await expect(inGame.saying("2 sets shown")).toBeVisible();
    // A set the client would not name is still a set: it is headed by the label the app gives
    // it, and says how little is in it without being opened.
    await expect(inGame.card("Unnamed set")).toContainText("0 pieces");
  });

  // An in-game set names appearances and nothing else, so unlike a set of the reader's own it
  // has to be opened — the same four walks of the game's tables a Blizzard set costs. This is
  // the step that says those ids reach real items on a real install.
  await test.step("a set saved in the game opens on what the game says is in it", async () => {
    await inGame.openSet("Tideglass");

    await expect(inGame.rows("Tideglass")).toHaveCount(2);
    await expect(inGame.rows("Tideglass")).toContainText(["Tideglass Crown", "Tideglass Mantle"]);
    await expect(inGame.wear("Tideglass", "Head", "Tideglass Crown")).toBeVisible();
  });

  // And the acceptance: what the player wears in the game goes onto the character here, out of
  // ids that were all Chronie's database held.
  await test.step("the character is dressed in a set she saved in the game", async () => {
    await inGame.wearAll("Tideglass").click();

    await expect
      .poll(() => outfit.worn())
      .toEqual(["Tideglass Crown · Head · Tideglass", "Tideglass Mantle · Shoulder · Tideglass"]);
    await expect(outfit.summary()).toHaveText("2 of 13 slots filled");
  });

  // And the direction nothing else in this suite goes: out of the app and into the account.
  // Every other step above reads the game; this one writes to it, and it is the only thing
  // Chronie ever asks a WoW account to change.
  //
  // The sentence is the point of the step rather than a detail of it. Nothing in a desktop app
  // can reach a running client, so the outfit is not in the game when the button comes back —
  // it is a row waiting for the addon to find at the next login, and a line that said only
  // "sent" would have a reader opening the game to look for something that is not there.
  await test.step("what she has on is sent to the game, to be saved at the next login", async () => {
    await outfit.sendAs("  Tideglass  court ");

    // Named by what came back rather than by what was typed: the backend tidies the name, and
    // a window drawing its own idea of it would promise a set under a name nobody will see.
    await expect(outfit.panel).toContainText(
      "Waiting for Tideglass court to be saved — it goes in next time you log that account in.",
    );
    // The box is emptied, because the request is made and typing over it would make a second
    // one. What she has on is untouched — sending is a note taken, not a door closed.
    await expect(outfit.name()).toHaveValue("");
    await expect(outfit.slots()).toHaveCount(2);
  });
});
