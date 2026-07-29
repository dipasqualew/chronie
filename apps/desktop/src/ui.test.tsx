import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CLASS_FILES, CharacterCircle, ClassDot, HighlightList, SegmentButton } from "./ui";
import type { HighlightListProps } from "./ui";
import { createItemBook } from "./items";
import type { ItemBook } from "./items";
import { highlights } from "./sessions";
import type { SessionCharacter } from "./sessions";
import type { IconsPayload, ItemDetail, ItemDetailsPayload, Segment } from "./types";

const BASE = 1_785_000_000;

let nextSegmentId = 0;

/** A segment with only the fields a highlight is built from; everything else stays empty. */
function segment(overrides: Partial<Segment> = {}): Segment {
  nextSegmentId += 1;
  return {
    segmentId: nextSegmentId,
    id: `synthetic-${nextSegmentId}`,
    character: "Aster-Vale",
    classFile: "MAGE",
    level: null,
    day: "2026-07-26",
    instance: "Glass Caverns",
    difficulty: "",
    instanceType: "none",
    startedAt: BASE,
    endedAt: BASE + 600,
    seconds: 600,
    lootValue: 0,
    goldDiff: 0,
    housingXP: 0,
    activities: [],
    encounters: [],
    transmogs: [],
    currencies: [],
    reputation: [],
    achievements: [],
    levelUps: [],
    mounts: [],
    pets: [],
    quests: [],
    toys: [],
    housingItems: [],
    housingLevelUps: [],
    ...overrides,
  };
}

/**
 * Three of the loud sort, which is the shortest way to a chip that stands for several.
 *
 * All three are account firsts on purpose: a character first is drawn as a mark now, and a
 * mixed evening would split into a chip and a mark rather than into the one summary these
 * tests are about. Which sort goes where is `sessions.ts`' rule and is held to there.
 */
const three = (): Segment => segment({
  achievements: [
    { id: 1, name: "Warband First", accountFirst: true, at: BASE + 60 },
    { id: 2, name: "Another First", accountFirst: true, at: BASE + 120 },
    { id: 3, name: "A Third First", accountFirst: true },
  ],
});

/** A piece of gear as the game's own tables answer for it; only the name is read here. */
const piece = (id: number, name: string): ItemDetail => ({
  id,
  name,
  classId: 4,
  subclassId: 2,
  inventoryType: 10,
  quality: 3,
  requiredLevel: 25,
  allowableClass: 0xffff,
  iconFileDataId: 260_001,
});

/** The pieces the game will answer for, for the marks that are about one. */
const WARDROBE: Record<number, ItemDetail> = {
  4200: piece(4200, "Insanity's Grip"),
  4201: piece(4201, "Boulderfist Belt"),
  4202: piece(4202, "Ashwood Sandals"),
};

/**
 * A real book over a backend a test answers, built the way `item.test.tsx` builds one: the
 * lookup is the app's own and only its far end is fake, injected rather than patched.
 */
function itemBook(known: Record<number, ItemDetail> = WARDROBE): ItemBook {
  const load = (ids: number[]): Promise<ItemDetailsPayload> => Promise.resolve({
    items: Object.fromEntries(
      ids.filter((id) => known[id]).map((id) => [String(id), known[id] as ItemDetail]),
    ),
  });
  const loadIcons = (fdids: number[]): Promise<IconsPayload> => Promise.resolve({
    icons: Object.fromEntries(fdids.map((fdid) => [String(fdid), "data:image/png;base64,icon"])),
  });
  return createItemBook({ load, loadIcons });
}

/**
 * A book that has already been answered, so what is drawn from it is a decision rather than a
 * race: a card that counts because the names had not arrived yet counts for the wrong reason.
 */
async function answered(ids: number[]): Promise<ItemBook> {
  const book = itemBook();
  book.learn(ids, () => {});
  await waitFor(() => expect(book.detail(ids[0] as number)).toBeTruthy());
  return book;
}

/** However many pieces of the addon's commonest catch: an id, a variant, and no name at all. */
const variants = (count: number): Segment => segment({
  transmogs: Array.from({ length: count }, (_unused, index) => ({
    id: 4200 + index, newAppearance: false,
  })),
});

/**
 * Draws a set of highlights and hands back what a reader could do with them.
 *
 * `opened` collects the segments the list asked to open, because "the way back to where it
 * happened" is the whole reason a summary is allowed to swallow the names in the first place,
 * and the only way to see it is to press the thing and watch where it goes.
 */
function draw(segments: Segment[], options: Partial<HighlightListProps> = {}) {
  const opened: number[] = [];
  const view = render(
    <HighlightList
      entries={highlights(segments)} scope="session-1"
      onOpenSegment={(segmentId) => opened.push(segmentId)}
      {...options}
    />,
  );
  return { ...view, opened };
}

afterEach(cleanup);

describe("HighlightList", () => {
  // A summary that stands for one thing has one place to go, so it goes there; the reader
  // pressing "Clockwork Glider" means the run it dropped in, not a list of one.
  it("sends a summary of a single thing straight to its segment", () => {
    const only = segment({ mounts: [{ id: 11, name: "Clockwork Glider" }] });

    const view = draw([only]);
    fireEvent.click(screen.getByRole("button", { name: /Clockwork Glider/ }));

    expect(view.opened).toEqual([only.segmentId]);
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("makes a summary of several into something to unfold instead", () => {
    draw([three()]);

    const chip = screen.getByRole("button", { name: /3 achievements/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    // Folded, it is a count and nothing else: the names are what unfolding is for.
    expect(screen.queryByText("Warband First")).toBeNull();
  });

  it("lists what a summary counted once it is the one unfolded", () => {
    draw([three()], { expanded: "achievement" });

    expect(screen.getByRole("button", { name: /3 achievements/ }).getAttribute("aria-expanded"))
      .toBe("true");
    for (const name of ["Warband First", "Another First", "A Third First"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  // The panel is what the chip says it controls, and two sessions on screen must not both
  // claim the same id — a reader on the second would be pointed at the first one's list.
  it("names the panel after the session it belongs to", () => {
    const view = draw([three()], { expanded: "achievement", scope: "session-42" });

    expect(screen.getByRole("button", { name: /3 achievements/ }).getAttribute("aria-controls"))
      .toBe("hl-session-42-achievement");
    expect(view.container.querySelector("#hl-session-42-achievement")).toBeTruthy();
  });

  it("leaves the other summaries folded when one is opened", () => {
    const view = draw(
      [three(), segment({ quests: [{ id: 1 }, { id: 2 }] })], { expanded: "achievement" },
    );

    expect(screen.getByRole("button", { name: /2 quests/ }).getAttribute("aria-expanded"))
      .toBe("false");
    expect(view.container.querySelectorAll(".hl-panel")).toHaveLength(1);
  });

  // Each row carries the way back to where it happened, which is the whole reason the summary
  // is allowed to swallow the names in the first place.
  it("gives every unfolded thing its own way back to its segment", () => {
    const first = segment({ startedAt: BASE, mounts: [{ id: 11, name: "Clockwork Glider" }] });
    const second = segment({ startedAt: BASE + 700, mounts: [{ id: 12, name: "Dust Strider" }] });

    const view = draw([first, second], { expanded: "mount" });
    for (const name of ["Clockwork Glider", "Dust Strider"]) {
      fireEvent.click(screen.getByRole("button", { name: `Open the segment ${name} was recorded in` }));
    }

    expect(view.opened).toEqual([first.segmentId, second.segmentId]);
  });

  // A segment row is itself one button, and a button inside a button is not a thing a browser
  // or a screen reader can make sense of.
  it("draws nothing pressable where the summary sits inside something pressable", () => {
    const view = draw([three()], { interactive: false });

    expect(view.container.textContent).toContain("3 achievements");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  // A segment row asks for no running numbers: on one segment they are four more figures
  // beside the two things that actually happened. What it keeps is the marks that are things
  // rather than numbers — a quest handed in on that run belongs to that run.
  it("leaves the running totals off where they were not asked for", () => {
    const rich = segment({
      goldDiff: 4200, mounts: [{ id: 11, name: "Clockwork Glider" }], quests: [{ id: 81 }],
    });

    expect(draw([rich]).container.querySelectorAll(".tally")).toHaveLength(1);
    cleanup();

    const row = draw([rich], { tallies: false }).container;
    expect(row.querySelectorAll(".tally")).toHaveLength(0);
    expect(row.querySelector(".tally-row .hl-quest")).toBeTruthy();
  });

  /**
   * The running numbers are context, not news, and they used to be written out in full: a
   * night that touched five factions ended in five lines of name and number under a card
   * whose job is to say what happened. Each kind is now one mark, and the numbers are in
   * the hover — which is also the only shape in which several of them read as one fact.
   */
  describe("the running totals", () => {
    const earned = (): Segment => segment({
      goldDiff: 4200,
      currencies: [
        { id: 7, name: "Glass Token", amount: 4 },
        { id: 10, name: "Warband Chit", amount: 100 },
      ],
      reputation: [{ faction: "Cavern Cartographers", amount: 25 }],
    });

    it("draws one mark per kind, however many things it counted", () => {
      const view = draw([earned()]);

      // Gold, currency, reputation — not gold and two currencies and a faction.
      expect(view.container.querySelectorAll(".tally")).toHaveLength(3);
    });

    it("puts every number of a kind into the one hover", () => {
      draw([earned()]);

      const currency = screen.getByRole("img", { name: /Currency/ });
      expect(currency.dataset.tip).toContain("Glass Token +4");
      expect(currency.dataset.tip).toContain("Warband Chit +100");
    });

    // The card's only statement of what the evening earned, so it cannot be hover-only:
    // a name and a tab stop are what make it reachable without a mouse.
    it("names each mark and leaves it reachable from the keyboard", () => {
      draw([earned()]);

      const wallet = screen.getByRole("img", { name: "Gold: 42s 0c" });
      expect(wallet.tabIndex).toBe(0);
    });

    // A vendor price for things mostly sold or disenchanted, agreeing with neither the
    // wallet beside it nor anything a player decided.
    it("has no mark for what the loot was worth", () => {
      const view = draw([segment({ lootValue: 900_000, goldDiff: 4200 })]);

      expect(view.container.querySelectorAll(".tally")).toHaveLength(1);
      expect(view.container.textContent).not.toContain("Looted");
    });
  });

  /**
   * The small change of an evening: a character catching up on an achievement the warband
   * already had, another colour of a piece already owned, a quest handed in, a set of gear
   * saved. Each is worth a mark on the card — somebody who reshuffled their raid set on Tuesday
   * can find the evening again — and none is worth the width of "Raid · 1 slot, +16 ilvl"
   * beside a mount and an account first. So each is drawn where the running numbers are drawn,
   * as its icon, and the sentence it gave up becomes the hover and the name.
   */
  describe("the quiet milestones", () => {
    const raid = {
      setId: 3, name: "Raid", kind: "updated" as const,
      items: [{ slot: 1, itemId: 101, itemLevel: 639, previousItemId: 100, previousItemLevel: 623 }],
    };

    /** Each quiet kind: what turns it up, the class it draws under, its icon, and its sentence. */
    const quiet: Array<[string, Partial<Segment>, string, string, string]> = [
      ["an achievement that only caught this character up",
        { achievements: [{ id: 9, name: "Into the Light", accountFirst: false }] },
        "hl-achievementCharacter", "🏆", "Into the Light · character first"],
      ["another colour of a piece already owned",
        { transmogs: [{ id: 4200, name: "Storm Cloak", newAppearance: false }] },
        "hl-transmogVariant", "👘", "Storm Cloak · variant of one owned"],
      ["a quest handed in", { quests: [{ id: 81 }] }, "hl-quest", "📜", "Quest 81"],
      ["a set of gear saved", { equipsetChanges: [raid] },
        "hl-equipset", "🎽", "Raid updated · 1 slot, +16 ilvl"],
    ];

    it.each(quiet)("draws %s as its icon, down in the strip", (_case, happened, style, icon) => {
      const view = draw([segment(happened)]);

      const mark = view.container.querySelector(`.tally-row .${style}`);
      expect(mark?.textContent).toBe(icon);
      // And nowhere near the chips, which is the half of it a reader would actually notice.
      expect(view.container.querySelector(`.hl-row .${style}`)).toBeNull();
    });

    // A chip with no words on it still has to say what it is to anybody not looking at it,
    // and still has to be readable by whoever does look — which is the whole bargain that
    // made drawing it quietly acceptable in the first place.
    it.each(quiet)("moves the sentence of %s into the hover and the name",
      (_case, happened, style, _icon, said) => {
        const view = draw([segment(happened)]);

        expect(view.container.querySelector(`.${style}`)?.getAttribute("data-tip")).toBe(said);
        expect(screen.getByRole("button", { name: said })).toBeTruthy();
      });

    /**
     * A mark about a piece of gear has to call it what the game calls it.
     *
     * The addon catches a name only when the client happened to have the item loaded at the
     * moment the source was learned, which is almost never — the backend's own table has
     * nowhere to keep one — so the sentence baked in `sessions.ts` came out as the number:
     * "Item 39473 · variant of one owned", on a real evening, as the mark's entire words. The
     * list that same mark unfolds into draws its rows through the game's tables and reads
     * "Insanity's Grip", so the card disagreed with itself about the same piece of gear.
     *
     * The lookup is asynchronous, so the id is what it says until the answer lands. That is
     * the same fallback every other item in the app draws and is not the defect.
     */
    describe("a piece the addon caught no name for", () => {
      it("names the one piece a mark stands for, once the game has answered", async () => {
        const view = draw([variants(1)], { items: itemBook() });
        const mark = (): Element | null => view.container.querySelector(".hl-transmogVariant");

        expect(mark()?.getAttribute("data-tip")).toBe("Item 4200 · variant of one owned");

        await waitFor(() => expect(mark()?.getAttribute("data-tip"))
          .toBe("Insanity's Grip · variant of one owned"));
        expect(screen.getByRole("button", { name: "Insanity's Grip · variant of one owned" }))
          .toBeTruthy();
      });

      // The count is what a mark of several is for, and naming the first of three would be a
      // claim about the other two. The names are what unfolding it is for.
      it("still counts where the mark stands for several", async () => {
        const view = draw([variants(3)], { items: await answered([4200, 4201, 4202]) });

        expect(view.container.querySelector(".hl-transmogVariant")?.getAttribute("data-tip"))
          .toBe("3 variants");
      });
    });

    it("keeps its label where it is not the one drawn quietly", () => {
      const view = draw([segment({ mounts: [{ id: 11, name: "Clockwork Glider" }] })]);

      expect(view.container.querySelector(".hl-mount")?.textContent).toContain("Clockwork Glider");
      expect(view.container.querySelector(".hl-row .hl-mount")).toBeTruthy();
    });

    // A mark gives up its words, not its list. The reader who presses one still gets the things
    // it counted, and gets them under the strip they pressed rather than above it — a list that
    // opens somewhere other than where it was asked for is a list nobody sees arrive.
    it("unfolds a mark of several into its entries, underneath the strip", () => {
      const view = draw(
        [segment({ goldDiff: 4200, quests: [{ id: 81 }, { id: 82 }] })], { expanded: "quest" },
      );

      expect(screen.getByRole("button", { name: "2 quests" }).getAttribute("aria-expanded"))
        .toBe("true");
      expect(screen.getByText("Quest 81")).toBeTruthy();
      expect(screen.getByText("Quest 82")).toBeTruthy();

      const strip = view.container.querySelector(".tally-row")!;
      const panel = view.container.querySelector(".hl-panel")!;
      expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    // A loud chip's list goes the other way, above the strip, for exactly the same reason.
    it("leaves a chip's list above the strip, where that is where it was asked for", () => {
      const view = draw(
        [segment({ goldDiff: 4200, achievements: three().achievements })],
        { expanded: "achievement" },
      );

      const strip = view.container.querySelector(".tally-row")!;
      const panel = view.container.querySelector(".hl-panel")!;
      expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    });

    // Nothing else on the card earned a number, and the strip is still where these go: there
    // is no second row for them, because they are the same sort of not-news.
    it("makes the strip on its own, for an evening that earned no numbers at all", () => {
      const view = draw([segment({ quests: [{ id: 81 }] })]);

      expect(view.container.querySelector(".tally-row .hl-quest")).toBeTruthy();
      expect(view.container.querySelectorAll(".tally")).toHaveLength(0);
    });
  });

  // Every milestone is listed in full a few lines further down there, the quiet ones included,
  // so repeating any of them as marks first would only make the same page longer.
  it("keeps only the totals for the detail modal, which lists the rest in full below", () => {
    const rich = segment({
      goldDiff: 4200, mounts: [{ id: 11, name: "Clockwork Glider" }], quests: [{ id: 81 }],
    });

    const view = draw([rich], { milestones: false });

    expect(view.container.querySelectorAll(".tally")).toHaveLength(1);
    expect(view.container.textContent).not.toContain("Clockwork Glider");
    expect(view.container.querySelector(".hl-quest")).toBeNull();
  });

  it("has nothing to draw for a segment nothing happened in", () => {
    expect(draw([segment()]).container.textContent).toBe("");
  });
});

/**
 * The row an evening on the timeline and a character's history both unfold into.
 *
 * Its summary is drawn inert — the row is itself one button and can hold no others — but it is
 * the same summary the card above it draws, so a piece named one way here and another way
 * there is the one disagreement told twice. The row is where a reader is likeliest to meet a
 * transmog variant at all, and it is the only one of the three that was never handed the book.
 */
describe("SegmentButton", () => {
  it("names the piece its summary stands for, the way the rest of the app does", async () => {
    const view = render(
      <SegmentButton segment={variants(1)} items={itemBook()} onOpen={() => {}} />,
    );

    await waitFor(() => expect(view.container.querySelector(".hl-transmogVariant")
      ?.getAttribute("data-tip")).toBe("Insanity's Grip · variant of one owned"));
    expect(screen.getByLabelText("Insanity's Grip · variant of one owned")).toBeTruthy();
  });
});

/** The two inks the palette writes initials in, as the stylesheet spells them. */
const INK_DARK = "#0b0b0b";
const INK_LIGHT = "#ffffff";

/** A character with only what the circle draws from; the rest of the card is elsewhere. */
const character = (overrides: Partial<SessionCharacter> = {}): SessionCharacter => ({
  name: "Aster-Vale",
  classFile: "MAGE",
  level: 12,
  seconds: 1800,
  segmentCount: 2,
  lootValue: 0,
  goldDiff: 0,
  places: [],
  ...overrides,
});

const circleFor = (overrides: Partial<SessionCharacter> = {}): HTMLElement => {
  render(<CharacterCircle character={character(overrides)} />);
  return screen.getByRole("img");
};

describe("CharacterCircle", () => {
  // The circle names its class and lets the stylesheet find the colour. Naming it is the whole
  // of the contract from here, so that is what is asserted — the colour that comes back out is
  // the palette's business, and `the class palette` below holds it to it.
  it.each(["MAGE", "DRUID", "DEATHKNIGHT"])("names the class of a %s", (classFile) => {
    expect(circleFor({ classFile }).dataset.class).toBe(classFile);
  });

  // Empty rather than absent, because absent is not neutral: a circle with no `data-class`
  // inherits `--class-color` from the session card around it and draws an unknown character in
  // the lead's colour, which is worse than drawing them in nothing.
  it.each([
    ["a class nothing knows", "ARTIFICER"],
    ["a segment that never said", null],
    ["a segment that said nothing", undefined],
  ])("claims no class at all for %s", (_case, classFile) => {
    expect(circleFor({ classFile }).dataset.class).toBe("");
  });

  // The circle is the only place a session says who played, so it must be reachable without a
  // mouse and it must say who it is without one.
  it("is focusable and names who it stands for", () => {
    const circle = circleFor();

    expect(circle.getAttribute("tabindex")).toBe("0");
    expect(circle.getAttribute("aria-label")).toContain("Aster-Vale, Mage · level 12");
  });
});

/**
 * Every element the components hand back, so a style attribute cannot creep into any of them.
 *
 * This is the test the class colours needed and did not have. The packaged app is served under
 * a CSP with a nonce in `style-src`, which makes the browser ignore `'unsafe-inline'` and drop
 * `style=""` outright — so a component that writes one produces markup that works in every
 * test and renders colourless in the only window that matters.
 */
describe("the markup the components build", () => {
  it.each([
    ["CharacterCircle", <CharacterCircle character={character()} key="circle" />],
    ["ClassDot", <ClassDot classFile="MAGE" key="dot" />],
  ])("gives %s no style attribute to lose", (_name, element) => {
    const { container } = render(element);

    expect(container.innerHTML).not.toMatch(/\sstyle\s*=/);
  });
});

/**
 * The palette as `ui.css` states it: class file to fill and ink, read back out of the
 * stylesheet that owns it.
 *
 * Parsing the CSS is the point rather than a workaround. The colours used to live in this
 * module and travel to the page on a style attribute, which is precisely what the CSP throws
 * away; they live in the stylesheet now, and this is how a unit test still gets to hold them
 * to being the game's colours and to being readable.
 */
const palette = ((): Record<string, { fill: string; ink: string }> => {
  // Off the disk, and relative to this file rather than to a working directory, so the suite
  // asks the same sheet `ui.tsx` imports wherever it is run from. Not through the bundler:
  // Vitest answers every `.css` import with an empty module — `?raw` included — so a sheet
  // imported here would parse as a palette of nothing and pass every assertion below.
  //
  // `dirname` rather than `new URL(…, import.meta.url)`, because these files run in a jsdom
  // whose `URL` resolves a relative path against the document rather than against the base it
  // was handed: `./ui.css` there comes out as `http://localhost:3000/src/ui.css`.
  const here = dirname(fileURLToPath(import.meta.url));
  const stylesheet = readFileSync(join(here, "ui.css"), "utf8");
  const rule = /\[data-class="(\w+)"\]\s*{\s*--class-color:\s*(#[0-9a-f]{6});\s*--class-ink:\s*(#[0-9a-f]{6});/g;
  return Object.fromEntries(
    [...stylesheet.matchAll(rule)].map(([, classFile, fill, ink]) => [classFile, { fill: fill!, ink: ink! }]),
  );
})();

/**
 * WCAG 2.x contrast between two hex colours, written out here rather than imported.
 *
 * Nothing in the app computes this any more — the inks are chosen once and written down — so
 * this is not a second opinion on an implementation, it is the only opinion. It is what turns
 * thirteen colour literals in a stylesheet into a claim that can be false.
 */
function contrastRatio(one: string, other: string): number {
  const relativeLuminance = (hex: string): number => {
    const weights = [0.2126, 0.7152, 0.0722];
    return [1, 3, 5].reduce((total, offset, index) => {
      const srgb = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      const linear = srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      return total + weights[index]! * linear;
    }, 0);
  };
  const [dimmer, brighter] = [relativeLuminance(one), relativeLuminance(other)].sort((a, b) => a - b);
  return (brighter! + 0.05) / (dimmer! + 0.05);
}

describe("the class palette", () => {
  // A class the components will name and the stylesheet has never heard of draws in the muted
  // grey, which is how a whole cast ends up looking alike. The two lists have to agree.
  it("has a rule for every class the components can name", () => {
    expect(Object.keys(palette).sort()).toEqual([...CLASS_FILES].sort());
  });

  // The colours are the client's own, and a character who reads as a mage in game reading as
  // something else here is the failure. Spot-checked across the range rather than restated in
  // full: a copy of all thirteen would only be this file agreeing with itself.
  it.each([
    ["DEATHKNIGHT", "#c41e3a"],
    ["MAGE", "#3fc7eb"],
    ["PRIEST", "#ffffff"],
    ["WARRIOR", "#c69b6d"],
  ])("fills a %s with the colour the game gives them", (classFile, fill) => {
    expect(palette[classFile]!.fill).toBe(fill);
  });

  // The ink is per-colour and there is no rule of thumb covering all thirteen: priest's white
  // and rogue's near-yellow want the dark one, death knight red and shaman blue the white one.
  // So each is measured against its own fill rather than asserted as a literal — a colour that
  // is retuned, or a class that is added, has to keep clearing the bar readable text is held to.
  it.each(Object.keys(palette))("writes a %s's initials in an ink that reaches 4.5:1", (classFile) => {
    const { fill, ink } = palette[classFile]!;

    expect([INK_DARK, INK_LIGHT]).toContain(ink);
    expect(contrastRatio(ink, fill)).toBeGreaterThanOrEqual(4.5);
  });
});
