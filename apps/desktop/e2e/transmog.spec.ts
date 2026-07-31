/**
 * The game's own sets, and the character they are tried on.
 *
 * One scenario, and the longest in the suite: browsing a wardrobe is one errand — find a set,
 * open it, put a piece on, look at her, change your mind — and every step of it depends on the
 * one before. It is also the only test here that draws, which is why it is slow: a CI runner
 * has no graphics card and renders every body in software.
 *
 * The other three browsers are `wardrobe.spec.ts` and `own-sets.spec.ts`.
 */

import { expect, test } from "./harness";
import { Shell } from "./pages/shell";
import { Outfit, PATIENCE_MS, SetGrid, TransmogView } from "./pages/transmog";
import { pixelsOf } from "./pages/wardrobe";

test("browses the game's transmog sets and dresses the character in them", async ({ page }) => {
  test.slow();
  const shell = new Shell(page);
  const transmog = new TransmogView(page);
  const sets = new SetGrid(page);
  const outfit = new Outfit(page);
  await transmog.open();

  await test.step("every set arrives under the collection it belongs to", async () => {
    await expect(sets.collections()).toHaveText([
      "Duskwoven Attire · 1 set",
      "Emberforge Armory · 1 set",
      "Tideglass Wardrobe · 2 sets",
    ]);
    await expect(sets.sets()).toHaveCount(4);
    await expect(transmog.saying("4 sets shown")).toBeVisible();
  });

  await test.step("a card says who the set is for and where it came from", async () => {
    const card = sets.card("Tideglass Regalia");
    // Who the *items* allow rather than what mask the set was filed under — a second command
    // walking every item in the game that gives one of these looks, arriving after the grid.
    await expect(card).toContainText("Any cloth wearer");
    await expect(card).toContainText("Cataclysm");
    await expect(card).toContainText("Patch 10.2.0");
    // Items, because items is what the game's own table counts. How many looks they come to
    // takes four more tables and is what opening the set is for.
    await expect(card).toContainText("6 items");
    // A set for nobody in particular is for everybody, and says so. It is also the set the
    // wearers read says nothing about — every item behind it sits in a section this install
    // holds no key to — so this card is the one still drawing the game's own mask.
    await expect(sets.card("Duskwoven Shroud")).toContainText("Any class");
  });

  // The whole of issue #244, and both ends of it. The game's own `ClassMask` answers two
  // different questions in one voice: "Plate" is an armour type and "Paladin" is a lock, and the
  // card said them the same way. What a reader wants to know is whether they can wear the thing,
  // and only the items behind the looks can say — see `wearers.rs` and `whoWears`.
  await test.step("a card says who can really wear the set", async () => {
    // The lock lifted: nothing keeps a Warrior or a Death Knight out of these clothes, and the
    // chip is now an invitation where the mask was a wall.
    await expect(sets.cardSaying("Emberforge Plate", "Any plate wearer")).toBeVisible();
    // And the lock standing, narrower than the armour the game filed it under: the sandals in
    // this set are the Druid's own, so no other leather wearer can put the whole of it on.
    await expect(sets.cardSaying("Tideglass Hide", "Druid only")).toBeVisible();
  });

  // The one thing on the card that no install and no reader supplied: what the artwork was
  // measured to be, out of the store this repository ships — see `qualities.ts`. It is here
  // rather than in a component test because this is the only place the *built* page runs: the
  // measurements are files bundled at build time and painted as SVG under the packaged app's
  // Content Security Policy, and neither of those is a thing a jsdom test can be wrong about.
  //
  // Structural rather than a colour. The store is a measurement of a real install and gets
  // regenerated; the claim worth making here is that a set the game has held for years arrives
  // with a swatch that was actually painted, and says who worked it out.
  await test.step("a card says what the artwork was measured to be", async () => {
    await expect(sets.measured("Tideglass Regalia")).toBeVisible();
    const painted = await sets.swatchColours("Tideglass Regalia");
    expect(painted.length).toBeGreaterThan(0);
    expect(painted[0]).toMatch(/^#[0-9a-f]{6}$/);
  });

  // Coming up short is expected — the game encrypts what it has not released — so the view
  // has to say so rather than quietly show fewer sets than the game holds.
  await test.step("the sets the game keeps encrypted are accounted for", async () => {
    await expect(transmog.saying(/2 sets the game keeps encrypted/)).toBeVisible();
  });

  // A set that is another set's clothes is shown once, under the set that carries it, and the
  // one shown says so. Otherwise a reader browsing the game's several thousand sets meets the
  // same wardrobe up to six times over.
  await test.step("a set holding another's appearances is shown once, and named", async () => {
    await expect(sets.sets()).not.toContainText(["Deepglass Hide"]);
    // The name and nothing else: a faction pair is the same armour for the same classes out of
    // the same patch, so a qualifier here would repeat the chip directly above it.
    await expect(sets.card("Tideglass Hide")).toContainText("the other faction's Deepglass Hide");
    await expect(sets.card("Tideglass Hide")).not.toContainText(
      "the other faction's Deepglass Hide · ",
    );
    // And the grid says why it is shorter than the count above it.
    await expect(
      transmog.saying(/1 set shown under another holding the same appearances/),
    ).toBeVisible();
  });

  // The whole risk of folding a set away: a reader who types its name has to find it. The
  // filters read the cluster rather than the card, so the set folded away is still reachable
  // by every route it had before — its name, its collection, and its class.
  await test.step("a folded set is still found by its own name", async () => {
    await sets.search().fill("deepglass");
    await expect(sets.sets()).toHaveText(["Tideglass Hide"]);
    await sets.search().fill("");
    await expect(sets.sets()).toHaveCount(4);
  });

  // The other fold, and much the larger of the two. A set's difficulties and colours are rows of
  // the game's own table with a parent named on them — Nerub-ar Palace is 52 of those and 13
  // things anybody would call a set of clothes — so they are squares on one card's rail rather
  // than cards of their own, and picking one draws the card as that set.
  await test.step("a set's colours are one card, and picking one redraws it", async () => {
    await expect(sets.sets()).not.toContainText(["Verdigris Tideglass Regalia"]);
    await expect(sets.variants("Tideglass Regalia")).toHaveCount(2);
    await expect(transmog.saying(/1 set shown as a variant on another's card/)).toBeVisible();

    await sets.showVariant("Tideglass Regalia", "Verdigris Tideglass Regalia");
    // Everything above the rail is about the member being shown, and the grid is no longer.
    await expect(sets.card("Verdigris Tideglass Regalia")).toContainText("3 items");
    await expect(sets.sets()).toHaveCount(4);
    await expect(sets.variants("Verdigris Tideglass Regalia")).toHaveCount(2);

    // And the card goes back to the set it opened on, which is the one the rest of this
    // scenario is about.
    await sets.showVariant("Verdigris Tideglass Regalia", "Tideglass Regalia");
    await expect(sets.card("Tideglass Regalia")).toContainText("6 items");
  });

  // The whole risk of folding a set away, asked of the larger fold: a reader who types the name
  // of a colour has to land on the card carrying it.
  await test.step("a variant is still found by its own name", async () => {
    await sets.search().fill("verdigris");
    await expect(sets.sets()).toHaveText(["Tideglass Regalia"]);
    await sets.search().fill("");
    await expect(sets.sets()).toHaveCount(4);
  });

  // What a card cannot say in words. A set is a set of clothes and the grid is names, counts
  // and chips — so this is the switch that draws each card as the character wearing that set,
  // out of one request for the whole page.
  //
  // The backend half is `budget.rs`, which counts what a page of sets costs to build against
  // the same sets one at a time. This is the half no count can reach: what the window does with
  // them once they arrive, and whether one graphics context is behind all of them.
  await test.step("every card can be drawn as the character wearing that set", async () => {
    await sets.asModels().check();
    // Three of the four cards. Set 205's one wearable row names a display the game keeps
    // encrypted, so this install has nothing to put on her for it — and that card stays the
    // card it always was rather than becoming an empty frame with an apology in it.
    await expect(sets.bodies()).toHaveCount(3);
    await expect(sets.body("Emberforge Plate")).toBeVisible();
    await expect(sets.card("Duskwoven Shroud").getByRole("img", { name: /, drawn$/ })).toHaveCount(
      0,
    );
    await expect(sets.card("Duskwoven Shroud")).toContainText("2 items");
    await expect.poll(() => sets.painted(), { timeout: PATIENCE_MS }).toBe(3);
  });

  // Turning one, which is what the picture is worth its size for — and the same drag has to
  // *not* open the set, because the picture sits outside the button that does. A click that
  // turned out to be a drag would otherwise unfold a set every time somebody looked at a back.
  await test.step("a card can be turned round without opening the set", async () => {
    const picture = sets.body("Emberforge Plate");
    const before = await pixelsOf(picture);
    const box = await picture.boundingBox();
    if (!box) throw new Error("the card has no picture to drag across");

    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await pixelsOf(picture)) !== before, { timeout: PATIENCE_MS })
      .toBe(true);
    await expect(sets.rows("Emberforge Plate")).toHaveCount(0);
    // And the rest of the grid is untouched: one card turned, not the page redrawn.
    await expect.poll(() => sets.painted(), { timeout: PATIENCE_MS }).toBe(3);
  });

  // And off again, leaving the grid exactly as it was: the pictures are a way of looking at the
  // sets rather than a mode the browser gets stuck in.
  await test.step("and the grid goes back to the cards it was", async () => {
    await expect(sets.count()).toHaveText("4 sets shown");
    await sets.asModels().uncheck();
    await expect(sets.bodies()).toHaveCount(0);
    await expect(sets.sets()).toHaveCount(4);
  });

  // The character is there before a single set has been touched, which is the shape of this
  // view: the body is the view, rather than something a dialog opens over it.
  await test.step("the character is on screen before anything has been picked", async () => {
    await expect(outfit.summary()).toHaveText("Nothing on yet. Pick an appearance from any set.");
    await expect(outfit.note()).toHaveText(
      "Nothing is worn. Drag to turn it, right-drag to move it.",
    );
    await expect(outfit.canvas()).toBeVisible();

    // 12 × 96: the fixture body holds twenty-five geosets and a bare one draws thirteen of
    // them — one per group, plus the hairstyle that shares the skin's — of which twelve reach
    // the picture, because the eye glow is composited by adding and glTF cannot write that.
    // Every part is drawn out of the same list, which is 96 of the model's 200 vertices: the
    // ones those twelve parts reach between them, and all the `.glb` now carries. Which makes
    // this the geoset selection, counted from the far end of the pipe: a variant drawn
    // alongside its default reads as thirteen parts rather than twelve, and a default that
    // went missing as eleven. Two of the twelve are her head and her ears, which nothing but
    // her own customization asks for.
    await expect.poll(() => outfit.drew("vertices")).toBe("1152");
  });

  // The one thing zoom on its own cannot do. Magnified far enough to look at a boot, the head
  // is somewhere off the top of the pane, and turning is no way back to it — an orbit moves
  // the camera and never what it is pointed at. So the right button moves the model, and the
  // button over the corner of the stage puts it back where framing it left it.
  await test.step("the model can be moved as well as turned, and put back", async () => {
    const framed = await outfit.framing();
    expect(framed.target).toBe("0.000,0.000,0.000");
    // Face to face with her, which is what the window now opens on: out along the one axis she
    // looks down, at her own height, dead centre. A reader opening a wardrobe is choosing
    // clothes for a person, and three quarters of her left shoulder was never the view for it.
    expect(framed.camera).toMatch(/^\d+\.\d{3},0\.000,0\.000$/);

    // Turning first, and it is exactly the half that was never enough: the camera goes
    // somewhere else and the middle of the pane stays on the middle of the model.
    await outfit.drag("left", 90, 0);
    await expect.poll(() => outfit.drew("camera")).not.toBe(framed.camera);
    expect((await outfit.framing()).target).toBe(framed.target);

    // And the right button, which is the change: what the camera is pointed at moves.
    await outfit.drag("right", 70, 45);
    await expect.poll(() => outfit.drew("target")).not.toBe(framed.target);

    // Back to the framing, to the digit — a reset that lands near where it started is a
    // reader still hunting for the model, which is the thing this is here to end.
    await outfit.resetCamera();
    await expect.poll(() => outfit.drew("camera")).toBe(framed.camera);
    await expect.poll(() => outfit.drew("target")).toBe(framed.target);
  });

  // The body under the clothes. Everything else in this view is what she has on; this is the
  // one control over who is wearing it, and it is read out of the installed game — the
  // questions are the game's own character creation screen's, and most of its swatches have no
  // name, which is why one of these two is numbered.
  await test.step("who she is can be answered, and is kept", async () => {
    await outfit.askWhoSheIs();
    await expect(outfit.about("Hair Style")).toHaveValue("132");
    await expect(outfit.swatches("Hair Style")).toHaveText(["Loose", "Braided"]);
    await expect(outfit.swatches("Skin Color")).toHaveText(["Swatch 1", "Swatch 2"]);

    await outfit.watchPane();
    await outfit.about("Hair Style").selectOption("133");

    // Stored as it is picked rather than behind a button, so what the form shows after a
    // repaint is what the settings file holds — the same bargain the marks make.
    await expect(outfit.about("Hair Style")).toHaveValue("133");
    // And she is drawn again: the body on the stage was a picture of the woman who was there
    // before, and the window asks the backend for her afresh rather than keeping it.
    await expect(outfit.canvas()).toBeVisible();
    await expect.poll(() => outfit.drew("vertices")).toBe("1152");

    // And the loose-haired body stayed up the whole time the braided one was being read. The
    // record is what makes that assertable at all — by the time anything can be looked at, a
    // pane that flashed white and a pane that never did are the same pane. Polling for
    // `redrawing` is what waits for the redraw to have happened; the states around it are what
    // says the reader was never shown a blank rectangle to get there.
    await expect.poll(() => outfit.paneStates()).toContain("redrawing");
    expect(await outfit.paneStates()).not.toContain("loading");
    expect(await outfit.paneStates()).not.toContain("empty");
  });

  // And the coarser half of it: another body entirely. The questions belong to whichever body
  // is being drawn — a beard is one no female body is ever asked — so the form under the picker
  // is replaced rather than relabelled.
  await test.step("the other body can be drawn instead, and is asked its own questions", async () => {
    await outfit.about("Body").selectOption("1");

    await expect(outfit.about("Beard")).toHaveValue("70");
    await expect(outfit.about("Skin Color")).toHaveCount(0);
    await expect(outfit.canvas()).toBeVisible();

    // Back to her, and the answer given before the switch is still there: one settings file
    // holds every body's, because no two bodies share a question.
    await outfit.about("Body").selectOption("2");
    await expect(outfit.about("Hair Style")).toHaveValue("133");
  });

  // And the one control on this panel that is not the reader inventing somebody: the people they
  // actually play, read out of the game by the addon. Picking one is a body and every answer
  // about it in a single change — "show me this hat on my warrior" rather than the dozen selects
  // above it, arranged until they approximate her.
  await test.step("one of the reader's own characters can be worn instead", async () => {
    await expect(outfit.swatches("Who you play")).toHaveText([
      "Someone else",
      "Aster-Vale",
      "Brin-Ravencrest",
    ]);
    // And she already is one of them, without anybody having said so: the answer given two
    // steps up is the one Aster carries, and the control reads the form rather than remembering
    // a click. That is what lets it go back to nobody when a swatch is changed by hand.
    await expect(outfit.about("Who you play")).toHaveValue("Aster-Vale");
    await outfit.about("Hair Style").selectOption("132");
    await expect(outfit.about("Who you play")).toHaveValue("");

    // Picking her back is the whole feature in one line: the answer arrives without the reader
    // having had to know which swatch it was.
    await outfit.about("Who you play").selectOption("Aster-Vale");
    await expect(outfit.about("Hair Style")).toHaveValue("133");
    await expect(outfit.canvas()).toBeVisible();

    // And somebody of the other body, which moves the body picker under it and replaces the
    // form under that — the same reload picking that body by hand causes, because it is one.
    await outfit.about("Who you play").selectOption("Brin-Ravencrest");
    await expect(outfit.about("Body")).toHaveValue("1");
    await expect(outfit.about("Beard")).toHaveValue("70");

    // Back to her, so the steps after this one find the body they were written against.
    await outfit.about("Who you play").selectOption("Aster-Vale");
    await expect(outfit.about("Hair Style")).toHaveValue("133");
  });

  await test.step("the search reaches the collection as well as the set", async () => {
    await sets.search().fill("tideglass");
    await expect(sets.sets()).toHaveText(["Tideglass Regalia", "Tideglass Hide"]);
    await expect(sets.collections()).toHaveCount(1);
    await sets.search().fill("");
    await expect(sets.sets()).toHaveCount(4);
  });

  // Everything the card itself shows is searchable, because a reader looking at
  // "Plate · Mists of Pandaria" and wanting more like it types one of those words rather
  // than going hunting for the dropdown that holds it.
  await test.step("the search reaches the metadata the card shows", async () => {
    await sets.search().fill("plate");
    await expect(sets.sets()).toHaveText(["Emberforge Plate"]);
    await sets.search().fill("cloth cataclysm");
    await expect(sets.sets()).toHaveText(["Tideglass Regalia"]);
    await sets.search().fill("");
  });

  await test.step("expansion and class narrow it together", async () => {
    await sets.expansion().selectOption({ label: "Cataclysm" });
    await expect(sets.sets()).toHaveCount(2);

    await sets.klass().selectOption({ label: "Priest" });
    await expect(sets.sets()).toHaveText(["Tideglass Regalia"]);
  });

  await test.step("a set no class owns survives a class filter", async () => {
    await sets.expansion().selectOption({ label: "All expansions" });
    await expect(sets.sets()).toHaveText(["Duskwoven Shroud", "Tideglass Regalia"]);
  });

  // And the dropdown asks the same question the chip answers. Tideglass Hide is filed under the
  // leather mask, which every Rogue is in, so the filter reading that mask handed a Rogue a set
  // no Rogue can wear — and hid it from the one class that can.
  await test.step("the class filter narrows to what a class can really wear", async () => {
    await sets.klass().selectOption({ label: "Rogue" });
    await expect(sets.sets()).toHaveText(["Duskwoven Shroud"]);

    await sets.klass().selectOption({ label: "Druid" });
    await expect(sets.sets()).toHaveText(["Duskwoven Shroud", "Tideglass Hide"]);
    await sets.klass().selectOption("");
  });

  await test.step("a filter that matches nothing says so", async () => {
    await sets.search().fill("nothing like it");
    await expect(sets.saying("Nothing matches")).toBeVisible();
    await expect(sets.sets()).toHaveCount(0);
  });

  // The acceptance for the whole redesign: six items, three looks, and a list one row per
  // look rather than one row per thing that happens to wear the model.
  await test.step("a set opens on its looks rather than on its items", async () => {
    await sets.search().fill("");
    await sets.klass().selectOption("");
    await expect(sets.card("Tideglass Regalia")).toContainText("6 items");

    await sets.openSet("Tideglass Regalia");
    await expect(sets.rows("Tideglass Regalia")).toHaveCount(3);
    // And the sentence that explains why a card promising six opened as a list of three.
    //
    // Five items rather than the card's six, and both are right. The card counts rows of
    // `TransmogSetItem`, which is all the grid has; this counts the items those rows reach,
    // and one of the six is the game naming a single item twice. The refined number is the
    // one worth printing next to the list it describes.
    await expect(sets.card("Tideglass Regalia")).toContainText("3 appearances from 5 items");
    // And the sets beside it are still there, which is what a dialog took away.
    await expect(sets.sets()).toHaveCount(4);
  });

  // The names come out of a fifth table, the one whose records vary in length — so a row
  // reading as an item rather than as a number is what says that reader works end to end.
  await test.step("every appearance says which slot it fills and leads to the item", async () => {
    await expect(sets.rows("Tideglass Regalia")).toContainText(["Head", "Shoulder", "Chest"]);
    await expect(sets.rows("Tideglass Regalia")).toContainText([
      "Tideglass Crown",
      "Tideglass Mantle",
      "Tideglass Robe",
    ]);
    await expect(sets.link("Tideglass Regalia", "Tideglass Mantle")).toHaveAttribute(
      "href",
      "https://www.wowhead.com/item=30002",
    );

    // A link out of the window has to reach the reader's browser the way every other one does.
    await sets.link("Tideglass Regalia", "Tideglass Mantle").click();
    await shell.openedUrls().toContain("https://www.wowhead.com/item=30002");
  });

  // Nothing is lost by collapsing: every item is still there, one click further in, and the
  // row says how many before it is asked. Three items give the robe's look and the row is
  // named after the one closest to the set's own name rather than after whichever the backend
  // listed first.
  await test.step("a row opens on every item that gives its look", async () => {
    await expect(sets.sourcesToggle("Tideglass Regalia", 2)).toBeVisible();
    await sets.sourcesToggle("Tideglass Regalia", 2).click();

    // Whatever anybody can wear first, then the cheapest way in, then the class-locked one —
    // which is the order of the question the list is open for.
    await expect(sets.sources("Tideglass Regalia", "Tideglass Robe")).toHaveText([
      /Tideglass Robe/,
      /Sea-Touched Vestment/,
      /Robe of the Tideglass Court/,
    ]);
    // Only the facts that differ between them, and here all three do.
    await expect(sets.sources("Tideglass Regalia", "Tideglass Robe").last()).toContainText(
      "Priest",
    );
    await expect(sets.sources("Tideglass Regalia", "Tideglass Robe").nth(1)).toContainText(
      "Level 45",
    );
    // And each is still its own item, with its own way out of the app.
    await expect(sets.link("Tideglass Regalia", "Sea-Touched Vestment")).toHaveAttribute(
      "href",
      "https://www.wowhead.com/item=30031",
    );

    // Collapsing a look does not put it on or take it off: the row above is still the button.
    await expect(sets.rows("Tideglass Regalia")).toHaveCount(3);
  });

  // The one fact a row volunteers without being opened, and the most useful thing this view
  // can say: a reader whose class cannot wear the set's own version of a look can still have
  // the look. Nothing else on the row would ever tell them so.
  await test.step("a look sold to everybody as well as to one class says so", async () => {
    await expect(sets.cardSaying("Tideglass Regalia", "Any class too")).toHaveCount(1);
    // The head is one item and says nothing of the kind.
    await expect(sets.rows("Tideglass Regalia").first()).not.toContainText("Any class too");
  });

  // The pictures come out of the game's own textures, and they arrive after the rows do —
  // so what is checked here is that every row ends up carrying one, not that it had one the
  // moment the list appeared.
  await test.step("every appearance carries the game's own picture of it", async () => {
    await expect(sets.iconFrames("Tideglass Regalia")).toHaveCount(3);
    await expect(sets.icons("Tideglass Regalia")).toHaveCount(3);
    // One per look now, and three different ones: the pictures were the clearest sign of the
    // old shape, where a set naming one appearance twice drew the same texture twice.
    const sources = await sets
      .icons("Tideglass Regalia")
      .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).currentSrc));
    expect(new Set(sources).size).toBe(3);
    for (const source of sources) expect(source).toContain("data:image/png;base64,");

    // Decoded, not merely fetched: a data url the browser could not read would leave the
    // element with no intrinsic size at all.
    const widths = await sets
      .icons("Tideglass Regalia")
      .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).naturalWidth));
    expect(widths).toEqual([8, 8, 8]);
  });

  // The change this whole view was rebuilt for: an appearance clicked in a set goes onto the
  // body, and the body is still there with the set still open behind it.
  await test.step("picking an appearance puts it on the character", async () => {
    // Clicked by the item's own name, which is the largest thing on the row and the one a
    // reader aims at — and which used to be the link out, so that the one part of the row
    // anybody would click was the one part that did not dress her.
    await sets.name("Tideglass Regalia", "Chest", "Tideglass Robe").click();
    await expect.poll(() => outfit.worn()).toEqual(["Tideglass Robe · Chest · Tideglass Regalia"]);
    await expect(outfit.summary()).toHaveText("1 of 13 slots filled");
    await expect(outfit.note()).toHaveText(
      "Worn on the character. Drag to turn it, right-drag to move it.",
    );

    // A body, not the item: 12 × 96, the same one part per geoset group a bare character
    // draws, out of the vertices those parts share. A robe that arrived as geometry of its
    // own would be a mesh of its own beside them.
    await expect.poll(() => outfit.drew("vertices")).toBe("1152");

    // And the armour has a colour on it. Geometry was all this ever asked for, and geometry
    // is the half that was never in doubt: a body with every texture refused draws the exact
    // shape of the robe in flat white and answers 1152 to the line above.
    //
    // The refusing is the page's Content Security Policy. A `.glb` carries its pictures
    // inside itself, three.js hands each one to the browser as a `blob:` URL, and a policy
    // naming neither `blob:` nor a wildcard turns every one of them away — through
    // `connect-src`, because the loader fetches them rather than pointing an `<img>` at them.
    //
    // Which is why this is here and not in a unit test. The atlas is right, the UVs read it,
    // the `.glb` carries it, and every one of those can be checked without a browser. The
    // only place the picture is refused is a real page under the real policy.
    // Two of them: the composited body atlas, and the hair's own — which is the picture that
    // stands between a hairstyle and a white cap on her head.
    await expect.poll(() => outfit.drew("pictures")).toBe("2");
    await expect.poll(() => outfit.drew("blank")).toBe("0");
  });

  // And the other half of that bargain: the corner of the row is the only part of it that
  // leaves. Taking it hands the url to the operating system and leaves her dressed exactly as
  // she was, rather than taking the piece back off on the way out.
  await test.step("the corner of a row leaves for Wowhead without undressing her", async () => {
    // The shoulder, which one item gives. The robe's row has no corner of its own — three
    // items give that look and none of them is the one the row means — and its items carry
    // their own, which the step above followed.
    await sets.link("Tideglass Regalia", "Tideglass Mantle").click();
    await shell.openedUrls().toContain("https://www.wowhead.com/item=30002");
    await expect.poll(() => outfit.worn()).toEqual(["Tideglass Robe · Chest · Tideglass Regalia"]);
  });

  // And the acceptance for the redesign itself: a piece out of one set and a piece out of
  // another, on one body at once, with both sets open behind them. A dialog made this the
  // hard way round — the first set had to be closed before the second could be reached.
  await test.step("pieces from two different sets go on at the same time", async () => {
    await sets.openSet("Emberforge Plate");
    await sets.wear("Emberforge Plate", "Head", "Emberforge Helm").click();
    await expect
      .poll(() => outfit.worn())
      .toEqual([
        "Emberforge Helm · Head · Emberforge Plate",
        "Tideglass Robe · Chest · Tideglass Regalia",
      ]);
    await expect(sets.rows("Tideglass Regalia")).toHaveCount(3);
    // Five of that set's six: the sixth is filed under a weapon slot with nothing saying a
    // hand, so it has nowhere on her to go and is left out until somebody asks for it.
    await expect(sets.rows("Emberforge Plate")).toHaveCount(5);

    // A body *and* a helm: 11 × 88 for the body — one part fewer than bare, because the helm
    // covers the hair, and eight vertices fewer between them for the same reason — plus the
    // helm's own eight. Two nodes in one scene is the shape the converter gained for that, and
    // a loader reading only the first would say 968.
    await expect.poll(() => outfit.drew("vertices")).toBe("976");
  });

  // The second half of the answer the chip on the card gives, and the half no chip could: "Any
  // plate wearer" says the lock lifts and never says which slot lifted it. The greaves of this
  // set are the Paladin's own, and the item that opens them belongs to no set at all — which is
  // why the read walks every item in the game rather than the set's own rows. See `openings.rs`.
  await test.step("an opened set says how anybody gets the looks it locks", async () => {
    await expect(sets.openingRow("Emberforge Plate", "Legs")).toContainText("Emberforge Greaves");
    await expect(sets.openingRow("Emberforge Plate", "Legs")).toContainText(
      "Greaves of the Wanderer · Rare · Level 30",
    );
    // And a way out of the app to it, the same corner every other item on this card offers.
    await expect(sets.link("Emberforge Plate", "Greaves of the Wanderer")).toHaveAttribute(
      "href",
      "https://www.wowhead.com/item=30025",
    );
    // One row rather than six: the set's other looks stop nobody, and a table where five rows
    // say "you were never kept from this" buries the one that says they were.
    await expect(sets.openingRows("Emberforge Plate")).toHaveCount(1);
    await expect(
      sets.cardSaying(
        "Emberforge Plate",
        "The one look this set locks is on an item anybody can wear",
      ),
    ).toBeVisible();
  });

  // And the row the whole panel is drawn for: a look nothing in the game sells around. The
  // sandals are the Druid's own and no other item gives that look, so the set is a wall for
  // everybody else — said in words, because a blank cell is a thing that failed to load.
  await test.step("a locked look nothing sells around says so", async () => {
    await sets.openSet("Tideglass Hide");
    await expect(sets.openingRow("Tideglass Hide", "Feet")).toContainText("Tideglass Sandals");
    await expect(sets.openingRow("Tideglass Hide", "Feet")).toContainText(
      "Nothing gives this look to another class",
    );
    await expect(
      sets.cardSaying(
        "Tideglass Hide",
        "Nothing in the game gives this set's one locked look to another class",
      ),
    ).toBeVisible();

    // And the last tier of that answer, behind a button on the very row that has none. Nothing
    // here is the game's own word for anything: the first row is two mesh signatures being equal
    // and the second is two thumbnails 3.9% apart under the cut this install measured for feet.
    // The panel has to say which is which, because lending the second the first's certainty is
    // the one thing this half of the feature must not do.
    await sets.showAlternatives("Tideglass Hide", "Tideglass Sandals").click();
    await expect(
      sets.alternative("Tideglass Hide", "Tideglass Sandals", "Boots of the Tidewalker"),
    ).toContainText("The same armour, another colour");
    await expect(
      sets.alternative("Tideglass Hide", "Tideglass Sandals", "Sandals of the Quiet Deep"),
    ).toContainText("96.1% alike");
    // The armour type on both, because the world drop that lifts a class lock nearly always
    // lifts the class and not the kind: the cloth row is no use whatever to the Druid who asked.
    await expect(
      sets.alternative("Tideglass Hide", "Tideglass Sandals", "Sandals of the Quiet Deep"),
    ).toContainText("Cloth");

    // What a person decides about a suggestion is the one thing on this panel a patch cannot
    // take away, both stores behind it being measured off the game again whenever it moves. So
    // it is stored, and what was stored is what is then drawn — including the order, a person's
    // answer outranking a measurement.
    await sets
      .ruleOn("Tideglass Hide", "Tideglass Sandals", "That is the one", "Sandals of the Quiet Deep")
      .click();
    await expect(
      sets.ruleOn(
        "Tideglass Hide",
        "Tideglass Sandals",
        "That is the one",
        "Sandals of the Quiet Deep",
      ),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      sets.alternatives("Tideglass Hide", "Tideglass Sandals").getByRole("listitem").first(),
    ).toContainText("Sandals of the Quiet Deep");

    await sets.closeSet("Tideglass Hide");
  });

  // The camera belongs to the reader and not to whatever is on the stage. A new body is drawn
  // for every piece put on or taken off, and framing each of them threw the reader's view away
  // once per click: somebody comparing two helms on a face they had zoomed in on had to zoom
  // in again for the second helm, and again after changing their mind.
  await test.step("a new piece leaves the camera where the reader left it", async () => {
    // A framed camera is always dead on the axis she faces down, and a dragged one never is,
    // so this pattern is the whole test: it says "this camera was placed by the framing"
    // without depending on how far out that framing happened to put it.
    const onHerAxis = /^\d+\.\d{3},0\.000,0\.000$/;
    await outfit.resetCamera();
    const framed = await outfit.framing();
    expect(framed.camera).toMatch(onHerAxis);

    await outfit.drag("left", 60, 20);
    const moved = await outfit.settled();
    expect(moved).not.toBe(framed.camera);
    const drawn = await outfit.drew("vertices");

    // A different body on the stage — the helm off again, which is a body of its own.
    await sets.wear("Emberforge Plate", "Head", "Emberforge Helm").click();
    await expect.poll(() => outfit.drew("vertices")).not.toBe(drawn);

    // And the reader's own view of her still in force. Framing every model put the camera back
    // where `framed` is at this point — a good thirty units away — once per click, whatever
    // the reader had been looking at instead.
    expect(await outfit.movedFrom(moved)).toBeLessThan(0.05);

    // The button is what puts it back, and it frames the body that is on the stage now rather
    // than the one the pane opened on — face to face with her again, pointed at her middle.
    await outfit.resetCamera();
    await expect.poll(() => outfit.drew("target")).toBe("0.000,0.000,0.000");
    await expect.poll(() => outfit.drew("camera")).toMatch(onHerAxis);

    // Back where the step found her, so the steps after this one still start from the outfit
    // the one before it built.
    await sets.wear("Emberforge Plate", "Head", "Emberforge Helm").click();
    await expect.poll(() => outfit.drew("vertices")).toBe("976");
  });

  // A place holds one thing. Two sets' shoulders are two different appearances for the same
  // pair of shoulders, so the second takes them rather than going on over the first — which
  // is what a reader trying pauldrons expects.
  await test.step("a second thing for the same place swaps rather than stacks", async () => {
    await sets.wear("Tideglass Regalia", "Shoulder", "Tideglass Mantle").click();
    await expect(outfit.slots()).toHaveCount(3);
    await sets.wear("Emberforge Plate", "Shoulder", "Emberforge Pauldrons").click();
    await expect
      .poll(() => outfit.worn())
      .toEqual([
        "Emberforge Helm · Head · Emberforge Plate",
        "Emberforge Pauldrons · Shoulder · Emberforge Plate",
        "Tideglass Robe · Chest · Tideglass Regalia",
      ]);
  });

  // And clicking the row that put a piece on takes it off again, which is how one comes off
  // without going over to the rail beside the character.
  await test.step("clicking the same row again takes that piece off", async () => {
    await sets.wear("Emberforge Plate", "Shoulder", "Emberforge Pauldrons").click();
    await expect(outfit.slots()).toHaveCount(2);
    await sets.wear("Emberforge Plate", "Shoulder", "Emberforge Pauldrons").click();
    await expect(outfit.slots()).toHaveCount(3);
  });

  // A set is a set of clothes, and looking at all of it at once is the ordinary thing to
  // want; clicking six rows to get there is not.
  await test.step("a whole set goes on in one go", async () => {
    await sets.wearAll("Emberforge Plate").click();
    // Five of its six rows: the sixth is an item the game withholds, so nothing says a hand.
    await expect
      .poll(() => outfit.worn())
      .toEqual([
        "Emberforge Helm · Head · Emberforge Plate",
        "Emberforge Pauldrons · Shoulder · Emberforge Plate",
        "Emberforge Breastplate · Chest · Emberforge Plate",
        "Emberforge Greaves · Legs · Emberforge Plate",
        "Emberforge Blade · Main hand · Emberforge Plate",
      ]);
    await expect(outfit.summary()).toHaveText("5 of 13 slots filled");
    await expect.poll(() => outfit.drew("vertices")).toBe("976");
  });

  // "On screen at all times" is not a figure of speech: a wardrobe of several thousand sets
  // is scrolled through, and the character has to still be there at the bottom of it. A
  // window short enough that the grid has somewhere to scroll to is what makes that a fact
  // about the app rather than about there being nothing to scroll.
  await test.step("the character stays on screen however far the sets are scrolled", async () => {
    await page.setViewportSize({ width: 1100, height: 400 });
    await sets.scrollToEnd();
    expect(await sets.scrollOffset()).toBeGreaterThan(0);
    await expect(outfit.panel).toBeInViewport();
    await expect(outfit.slots()).toHaveCount(5);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await test.step("closing a set hands back the grid, filters and all", async () => {
    await sets.closeSet("Emberforge Plate");
    await sets.closeSet("Tideglass Regalia");
    await expect(sets.sets()).toHaveCount(4);
    await expect(sets.klass()).toHaveValue("");
    await expect(sets.search()).toHaveValue("");
    // And what she has on outlives every set it was assembled from, which is the whole point
    // of the outfit living beside the sets rather than inside one of them.
    await expect(outfit.slots()).toHaveCount(5);
  });

  await test.step("a piece comes off again and the rest stays on", async () => {
    await outfit.takeOff("Emberforge Helm");
    await expect(outfit.slots()).toHaveCount(4);

    await outfit.clear();
    await expect(outfit.slots()).toHaveCount(0);
    await expect(outfit.summary()).toHaveText("Nothing on yet. Pick an appearance from any set.");
    await expect.poll(() => outfit.drew("vertices")).toBe("1152");
  });

  // An appearance the game encrypts is one of the two there is nowhere on her to put, so the
  // list leaves it out — and the card still accounts for it, because its own count includes
  // it and a list shorter than the number above it is what a reader would have to explain.
  await test.step("an appearance the game withholds is left out, and counted", async () => {
    await sets.openSet("Duskwoven Shroud");
    await expect(sets.rows("Duskwoven Shroud")).toHaveCount(1);
    await expect(sets.card("Duskwoven Shroud")).toContainText(
      "2 appearances · 1 the game keeps encrypted",
    );
    await expect(sets.card("Duskwoven Shroud")).toContainText(
      "1 appearance hidden, with nowhere on her to go",
    );
  });

  // And the box is for the reader who wants to see what a set is really made of: the row it
  // can say nothing about comes back, and says so where its name would be.
  await test.step("unticking the box hands back the rows a set really holds", async () => {
    await sets.hideUnwearable().uncheck();
    await expect(sets.rows("Duskwoven Shroud")).toHaveCount(2);
    await expect(sets.card("Duskwoven Shroud")).toContainText(
      "The game keeps this appearance encrypted",
    );
    // The other row got as far as an item and no further: the game encrypts that item's own
    // row too, so it is named by its id rather than left as a blank beside a slot.
    await expect(sets.link("Duskwoven Shroud", "Item 30011")).toHaveAttribute(
      "href",
      "https://www.wowhead.com/item=30011",
    );

    // One row names a texture this install does not hold and the other names none at all,
    // so neither has a picture to show — and both still keep the frame, so the list reads as
    // a column of icons with two blanks rather than as two rows that lost their indent.
    await expect(sets.iconFrames("Duskwoven Shroud")).toHaveCount(2);
    await expect(sets.icons("Duskwoven Shroud")).toHaveCount(0);
  });

  // The one row of that set the game does give a place for names a display it keeps
  // encrypted, so this install has nothing to put on her — which is a sentence and a bare
  // list rather than an error where the wardrobe was.
  await test.step("an outfit this install can show nothing for says so", async () => {
    await sets.wear("Duskwoven Shroud", "Chest", "Item 30011").click();
    await expect(outfit.slots()).toHaveCount(1);
    await expect(outfit.note()).toHaveText(
      "This install holds nothing to put on the character for these.",
    );
    await expect(outfit.canvas()).toBeHidden();
    await sets.closeSet("Duskwoven Shroud");
    await outfit.clear();
  });

  // The other appearance in the fixtures with nowhere on a body to go: it is filed under a
  // weapon slot and nothing says which hand — and a button that did nothing when clicked
  // would be worse than one that says why it cannot. The box is still unticked from the step
  // above, which is what a set opened afterwards has to obey as well.
  await test.step("an appearance there is nowhere to put says so instead of going on", async () => {
    await sets.openSet("Emberforge Plate");
    await expect(sets.rows("Emberforge Plate")).toHaveCount(6);
    await expect(sets.card("Emberforge Plate")).toContainText(
      "The game gives this appearance no place on a character.",
    );
    await expect(sets.wear("Emberforge Plate", "Weapon or shield", "Item 30017")).toBeDisabled();
  });

  // And ticking it again takes that row back out of an open set, which is the half that says
  // the box governs what is drawn rather than having only reached the set once.
  await test.step("ticking the box again puts the placeless row away", async () => {
    await sets.hideUnwearable().check();
    await expect(sets.rows("Emberforge Plate")).toHaveCount(5);
    await expect(sets.wear("Emberforge Plate", "Weapon or shield", "Item 30017")).toHaveCount(0);
    await expect(sets.card("Emberforge Plate")).toContainText(
      "1 appearance hidden, with nowhere on her to go",
    );
  });
});
