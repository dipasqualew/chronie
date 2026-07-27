import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLASS_FILES, characterCircle, classDot, highlightList } from "./ui";
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

const draw = (segments: Segment[], options = {}): string =>
  highlightList(highlights(segments), { scope: "session-1", ...options });

describe("highlightList", () => {
  // A summary that stands for one thing has one place to go, so it goes there; the reader
  // pressing "Clockwork Glider" means the run it dropped in, not a list of one.
  it("sends a summary of a single thing straight to its segment", () => {
    const only = segment({ mounts: [{ id: 11, name: "Clockwork Glider" }] });

    const html = draw([only]);

    expect(html).toContain(`data-open-segment="${only.segmentId}"`);
    expect(html).not.toContain("data-unfold");
  });

  it("makes a summary of several into something to unfold instead", () => {
    const html = draw([three()]);

    expect(html).toContain('data-unfold="achievement"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("3 achievements");
    // Folded, it is a count and nothing else: the names are what unfolding is for.
    expect(html).not.toContain("Warband First");
  });

  it("lists what a summary counted once it is the one unfolded", () => {
    const html = draw([three()], { expanded: "achievement" });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Warband First");
    expect(html).toContain("Just Me");
    expect(html).toContain("Also Just Me");
  });

  // The panel is what the chip says it controls, and two sessions on screen must not both
  // claim the same id — a reader on the second would be pointed at the first one's list.
  it("names the panel after the session it belongs to", () => {
    const html = draw([three()], { expanded: "achievement", scope: "session-42" });

    expect(html).toContain('aria-controls="hl-session-42-achievement"');
    expect(html).toContain('id="hl-session-42-achievement"');
  });

  it("leaves the other summaries folded when one is opened", () => {
    const html = draw([three(), segment({ quests: [{ id: 1 }, { id: 2 }] })], { expanded: "achievement" });

    expect(html).toContain("2 quests");
    expect(html).toContain('data-unfold="quest"');
    expect((html.match(/class="hl-panel"/g) || []).length).toBe(1);
  });

  // Each row carries the way back to where it happened, which is the whole reason the
  // summary is allowed to swallow the names in the first place.
  it("gives every unfolded thing its own way back to its segment", () => {
    const first = segment({ startedAt: BASE, mounts: [{ id: 11, name: "Clockwork Glider" }] });
    const second = segment({ startedAt: BASE + 700, mounts: [{ id: 12, name: "Dust Strider" }] });

    const html = draw([first, second], { expanded: "mount" });

    expect(html).toContain(`data-open-segment="${first.segmentId}"`);
    expect(html).toContain(`data-open-segment="${second.segmentId}"`);
  });

  // A segment row is itself one button, and a button inside a button is not a thing a
  // browser or a screen reader can make sense of.
  it("draws nothing pressable where the summary sits inside something pressable", () => {
    const html = highlightList(highlights([three()]), { interactive: false });

    expect(html).toContain("3 achievements");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("data-open-segment");
  });

  it("leaves the running totals off where they were not asked for", () => {
    const rich = segment({ goldDiff: 4200, lootValue: 900, mounts: [{ id: 11, name: "Clockwork Glider" }] });

    expect(draw([rich])).toContain("tally-row");
    expect(draw([rich], { tallies: false })).not.toContain("tally-row");
  });

  it("keeps only the totals for the detail modal, which lists the rest in full below", () => {
    const rich = segment({ goldDiff: 4200, mounts: [{ id: 11, name: "Clockwork Glider" }] });

    const html = highlightList(highlights([rich]), { milestones: false });

    expect(html).toContain("tally-row");
    expect(html).not.toContain("Clockwork Glider");
  });

  it("has nothing to draw for a segment nothing happened in", () => {
    expect(draw([segment()])).toBe("");
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

describe("characterCircle", () => {
  // The circle names its class and lets the stylesheet find the colour. Naming it is the
  // whole of the contract from here, so that is what is asserted — the colour that comes
  // back out is the palette's business, and `the class palette` below holds it to it.
  it.each(["MAGE", "DRUID", "DEATHKNIGHT"])("names the class of a %s", (classFile) => {
    expect(characterCircle(character({ classFile }))).toContain(`data-class="${classFile}"`);
  });

  // Empty rather than absent, because absent is not neutral: a circle with no `data-class`
  // inherits `--class-color` from the session card around it and draws an unknown character
  // in the lead's colour, which is worse than drawing them in nothing.
  it.each([
    ["a class nothing knows", "ARTIFICER"],
    ["a segment that never said", null],
    ["a segment that said nothing", undefined],
  ])("claims no class at all for %s", (_case, classFile) => {
    expect(characterCircle(character({ classFile }))).toContain('data-class=""');
  });
});

/**
 * Every element the renderers hand back, so a style attribute cannot creep into any of them.
 *
 * This is the test the class colours needed and did not have. The packaged app is served
 * under a CSP with a nonce in `style-src`, which makes the browser ignore `'unsafe-inline'`
 * and drop `style=""` outright — so a renderer that writes one produces markup that works
 * in every test and renders colourless in the only window that matters.
 */
describe("the markup the renderers build", () => {
  const drawings: Record<string, string> = {
    characterCircle: characterCircle(character()),
    classDot: classDot("MAGE"),
  };

  it.each(Object.keys(drawings))("gives %s no style attribute to lose", (name) => {
    expect(drawings[name]).not.toMatch(/\sstyle\s*=/);
  });
});

/**
 * The palette as `index.html` states it: class file to fill and ink, read back out of the
 * stylesheet that owns it.
 *
 * Parsing the CSS is the point rather than a workaround. The colours used to live in this
 * module and travel to the page on a style attribute, which is precisely what the CSP
 * throws away; they live in the stylesheet now, and this is how a unit test still gets to
 * hold them to being the game's colours and to being readable.
 */
const palette = ((): Record<string, { fill: string; ink: string }> => {
  const css = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const rule = /\[data-class="(\w+)"\]\s*{\s*--class-color:\s*(#[0-9a-f]{6});\s*--class-ink:\s*(#[0-9a-f]{6});/g;
  return Object.fromEntries(
    [...css.matchAll(rule)].map(([, classFile, fill, ink]) => [classFile, { fill: fill!, ink: ink! }]),
  );
})();

/**
 * WCAG 2.x contrast between two hex colours, written out here rather than imported.
 *
 * Nothing in the app computes this any more — the inks are chosen once and written down —
 * so this is not a second opinion on an implementation, it is the only opinion. It is what
 * turns thirteen colour literals in a stylesheet into a claim that can be false.
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
  // A class the renderers will name and the stylesheet has never heard of draws in the muted
  // grey, which is how a whole cast ends up looking alike. The two lists have to agree.
  it("has a rule for every class the renderers can name", () => {
    expect(Object.keys(palette).sort()).toEqual([...CLASS_FILES].sort());
  });

  // The colours are the client's own, and a character who reads as a mage in game reading as
  // something else here is the failure. Spot-checked across the range rather than restated
  // in full: a copy of all thirteen would only be this file agreeing with itself.
  it.each([
    ["DEATHKNIGHT", "#c41e3a"],
    ["MAGE", "#3fc7eb"],
    ["PRIEST", "#ffffff"],
    ["WARRIOR", "#c69b6d"],
  ])("fills a %s with the colour the game gives them", (classFile, fill) => {
    expect(palette[classFile]!.fill).toBe(fill);
  });

  // The ink is per-colour and there is no rule of thumb covering all thirteen: priest's
  // white and rogue's near-yellow want the dark one, death knight red and shaman blue the
  // white one. So each is measured against its own fill rather than asserted as a literal —
  // a colour that is retuned, or a class that is added, has to keep clearing the bar
  // readable text is held to.
  it.each(Object.keys(palette))("writes a %s's initials in an ink that reaches 4.5:1", (classFile) => {
    const { fill, ink } = palette[classFile]!;

    expect([INK_DARK, INK_LIGHT]).toContain(ink);
    expect(contrastRatio(ink, fill)).toBeGreaterThanOrEqual(4.5);
  });
});
