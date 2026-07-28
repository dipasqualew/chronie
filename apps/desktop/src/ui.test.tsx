import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// The page itself, as text. Read through the bundler rather than off the disk so this asks
// the same file the window is built from, wherever the suite happens to be run from.
import indexHtml from "../index.html?raw";
import { CLASS_FILES, CharacterCircle, ClassDot, HighlightList } from "./ui";
import type { HighlightListProps } from "./ui";
import { highlights } from "./sessions";
import type { SessionCharacter } from "./sessions";
import type { Segment } from "./types";

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

const three = (): Segment => segment({
  achievements: [
    { id: 1, name: "Just Me", accountFirst: false, at: BASE + 60 },
    { id: 2, name: "Warband First", accountFirst: true, at: BASE + 120 },
    { id: 3, name: "Also Just Me", accountFirst: false },
  ],
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
    for (const name of ["Warband First", "Just Me", "Also Just Me"]) {
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

  it("leaves the running totals off where they were not asked for", () => {
    const rich = segment({ goldDiff: 4200, mounts: [{ id: 11, name: "Clockwork Glider" }] });

    expect(draw([rich]).container.querySelector(".tally-row")).toBeTruthy();
    cleanup();
    expect(draw([rich], { tallies: false }).container.querySelector(".tally-row")).toBeNull();
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
   * Saving a set of gear is housekeeping: worth a mark on the card, not worth the width of
   * "Raid · 2 slots, +16 item levels" beside a mount and an account first.
   */
  describe("an equipment set change", () => {
    const changed = (): Segment => segment({
      equipsetChanges: [{
        setId: 3, name: "Raid", kind: "updated",
        items: [{ slot: 1, itemId: 101, itemLevel: 639, previousItemId: 100, previousItemLevel: 623 }],
      }],
    });

    it("is drawn as its icon, with the words moved into the hover", () => {
      const view = draw([changed()]);

      const chip = view.container.querySelector(".hl-equipset");
      expect(chip?.textContent).toBe("🎽");
      expect(chip?.getAttribute("data-tip")).toContain("Raid");
    });

    // A chip with no words on it still has to say what it is to anybody not looking at it.
    it("still says what it is to a screen reader", () => {
      draw([changed()]);

      expect(screen.getByRole("button", { name: /Raid/ })).toBeTruthy();
    });

    it("keeps its label where it is not the one drawn quietly", () => {
      const view = draw([segment({ mounts: [{ id: 11, name: "Clockwork Glider" }] })]);

      expect(view.container.querySelector(".hl-mount")?.textContent).toContain("Clockwork Glider");
    });
  });

  it("keeps only the totals for the detail modal, which lists the rest in full below", () => {
    const rich = segment({ goldDiff: 4200, mounts: [{ id: 11, name: "Clockwork Glider" }] });

    const view = draw([rich], { milestones: false });

    expect(view.container.querySelector(".tally-row")).toBeTruthy();
    expect(view.container.textContent).not.toContain("Clockwork Glider");
  });

  it("has nothing to draw for a segment nothing happened in", () => {
    expect(draw([segment()]).container.textContent).toBe("");
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
 * The palette as `index.html` states it: class file to fill and ink, read back out of the
 * stylesheet that owns it.
 *
 * Parsing the CSS is the point rather than a workaround. The colours used to live in this
 * module and travel to the page on a style attribute, which is precisely what the CSP throws
 * away; they live in the stylesheet now, and this is how a unit test still gets to hold them
 * to being the game's colours and to being readable.
 */
const palette = ((): Record<string, { fill: string; ink: string }> => {
  const rule = /\[data-class="(\w+)"\]\s*{\s*--class-color:\s*(#[0-9a-f]{6});\s*--class-ink:\s*(#[0-9a-f]{6});/g;
  return Object.fromEntries(
    [...indexHtml.matchAll(rule)].map(([, classFile, fill, ink]) => [classFile, { fill: fill!, ink: ink! }]),
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
