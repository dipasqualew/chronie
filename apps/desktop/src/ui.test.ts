import { describe, expect, it } from "vitest";
import { CLASS_COLORS, characterCircle, classInk, highlightList } from "./ui";
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

/** The two inks `classInk` chooses between, as the stylesheet will receive them. */
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
  // The circle carries the colour on a custom property the stylesheet reads twice, for the
  // ring and for the fill inside it. Handing it a class the palette does not know leaves
  // both drawn in the muted grey, which is how a whole cast ends up looking alike.
  it.each([
    ["MAGE", "#3fc7eb"],
    ["DRUID", "#ff7c0a"],
    ["DEATHKNIGHT", "#c41e3a"],
  ])("draws a %s in the colour the game gives it", (classFile, colour) => {
    expect(characterCircle(character({ classFile }))).toContain(`--class-color:${colour}`);
  });

  it.each([
    ["a class nothing knows", "ARTIFICER"],
    ["a segment that never said", null],
    ["a segment that said nothing", undefined],
  ])("falls back to the muted grey for %s", (_case, classFile) => {
    expect(characterCircle(character({ classFile }))).toContain("--class-color:var(--text-muted)");
  });

  // The fill and the ink have to travel together, because the stylesheet cannot work the
  // second one out from the first: a circle that carried only the colour would fall back to
  // the body text and write a death knight's initials in near-black on dark red.
  it.each([
    ["MAGE", "#3fc7eb", INK_DARK],
    ["PRIEST", "#ffffff", INK_DARK],
    ["DEATHKNIGHT", "#c41e3a", INK_LIGHT],
    ["SHAMAN", "#0070dd", INK_LIGHT],
  ])("hands the stylesheet both the fill and the ink for a %s", (classFile, colour, ink) => {
    const html = characterCircle(character({ classFile }));

    expect(html).toContain(`--class-color:${colour}`);
    expect(html).toContain(`--class-ink:${ink}`);
  });
});

/**
 * WCAG 2.x contrast between two hex colours, written out here rather than imported.
 *
 * `ui.ts` keeps its own copy private, and a test that borrowed the implementation's maths
 * would agree with it whatever either of them said — including if both were wrong. This is
 * the second opinion that makes the ratio assertion below worth having.
 */
function contrastRatio(one: string, other: string): number {
  const relativeLuminance = (hex: string): number => {
    const weights = [0.2126, 0.7152, 0.0722];
    return [1, 3, 5].reduce((total, offset, index) => {
      const srgb = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      const linear = srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      return total + weights[index] * linear;
    }, 0);
  };
  const [dimmer, brighter] = [relativeLuminance(one), relativeLuminance(other)].sort((a, b) => a - b);
  return (brighter + 0.05) / (dimmer + 0.05);
}

describe("classInk", () => {
  // Every class in the palette, because the choice is per-colour and there is no rule of
  // thumb that covers all thirteen: priest's white and rogue's near-yellow want the dark
  // ink, while death knight red, demon hunter purple and shaman blue are dark enough to want
  // the white one. Getting one wrong writes a name in a colour close to what it sits on.
  it.each([
    ["DEATHKNIGHT", INK_LIGHT],
    ["DEMONHUNTER", INK_LIGHT],
    ["DRUID", INK_DARK],
    ["EVOKER", INK_DARK],
    ["HUNTER", INK_DARK],
    ["MAGE", INK_DARK],
    ["MONK", INK_DARK],
    ["PALADIN", INK_DARK],
    ["PRIEST", INK_DARK],
    ["ROGUE", INK_DARK],
    ["SHAMAN", INK_LIGHT],
    ["WARLOCK", INK_DARK],
    ["WARRIOR", INK_DARK],
  ])("writes a %s's initials in %s", (classFile, ink) => {
    expect(classInk(classFile)).toBe(ink);
  });

  // The literal above says what the choice is; this says why it is the right one. A palette
  // that gains a class, or an ink that is retuned, has to keep clearing the bar readable
  // text is held to — which is the whole reason the ink is measured rather than fixed.
  it.each(Object.keys(CLASS_COLORS))("reaches 4.5:1 against the %s fill", (classFile) => {
    expect(contrastRatio(classInk(classFile), CLASS_COLORS[classFile])).toBeGreaterThanOrEqual(4.5);
  });

  // A class the palette does not know is filled with the theme's muted grey, whose value the
  // stylesheet owns; the dark ink is the one that reads on it in either theme.
  it.each([
    ["a class nothing knows", "ARTIFICER"],
    ["a segment that never said", null],
    ["a segment that said nothing", undefined],
  ])("falls back to the dark ink for %s", (_case, classFile) => {
    expect(classInk(classFile)).toBe(INK_DARK);
  });
});
