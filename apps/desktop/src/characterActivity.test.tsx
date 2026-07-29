import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CharacterActivity } from "./characterActivity";
import { buildCharacters } from "./characters";
import { createItemBook } from "./items";
import type { ItemBook } from "./items";
import type { Segment } from "./types";

afterEach(cleanup);

/** A fixed moment to reckon every range from, so nothing here depends on when it is run. */
const NOW = 1_800_000_000;
const DAY = 86_400;

let nextId = 0;

const segment = (overrides: Partial<Segment> = {}): Segment => {
  nextId += 1;
  return {
    segmentId: nextId,
    id: `synthetic-${nextId}`,
    character: "Aster-Vale",
    classFile: "MAGE",
    level: 12,
    day: "2027-01-15",
    instance: "Glass Caverns",
    difficulty: "",
    instanceType: "party",
    startedAt: NOW - DAY,
    endedAt: NOW - DAY + 600,
    seconds: 600,
    lootValue: 0,
    goldDiff: 0,
    housingXP: 0,
    ...overrides,
  };
};

/** An install that can describe nothing, which is what most of these rows draw against. */
const book = (): ItemBook =>
  createItemBook({
    load: () => Promise.resolve({ items: {} }),
    loadIcons: () => Promise.resolve({ icons: {} }),
  });

/** Yesterday's evening: one Mythic+ run that also earned a mount. */
const RECENT = segment({
  day: "2027-01-15",
  endedAt: NOW - DAY,
  activities: [
    {
      id: 1,
      kind: "mythic_plus",
      source: "manual",
      confidence: 1,
      metadata: { keystoneLevel: 14, dungeon: "Glass Caverns" },
    },
  ],
  mounts: [{ id: 500, name: "Clockwork Glider", at: NOW - DAY }],
});

/** And a night forty days back, which no default range reaches. */
const OLD = segment({
  day: "2026-12-06",
  instance: "Copperwood Depths",
  startedAt: NOW - 40 * DAY,
  endedAt: NOW - 40 * DAY + 600,
  activities: [
    {
      id: 2,
      kind: "progress_raid",
      source: "manual",
      confidence: 1,
      metadata: { raid: "Emberforge" },
    },
  ],
});

function show(segments: Segment[], range = "fortnight") {
  const entry = buildCharacters(segments)[0]!;
  const onRange = vi.fn();
  const onOpenSegment = vi.fn();
  const drawn = render(
    <CharacterActivity
      entry={entry}
      range={range}
      onRange={onRange}
      now={NOW}
      items={book()}
      onOpenSegment={onOpenSegment}
    />,
  );
  return { onRange, onOpenSegment, rerender: drawn.rerender, entry };
}

describe("CharacterActivity", () => {
  it("opens on the last fortnight and shows what was done in it", () => {
    show([RECENT, OLD]);

    expect(screen.getByRole("combobox", { name: "Showing" })).toHaveProperty("value", "fortnight");
    const roll = screen.getByRole("list", { name: "What was done" });
    expect(within(roll).getAllByRole("listitem")).toHaveLength(1);
    expect(roll.textContent).toContain("Mythic+ run");
  });

  /** The one thing the range is for: a night forty days back is not what "lately" means. */
  it("leaves out what happened before the range began", () => {
    show([RECENT, OLD]);

    expect(screen.queryByText(/Progress raid/)).toBeNull();
    expect(screen.getByRole("status", { name: "What the range holds" }).textContent).toContain(
      "1 segment",
    );
  });

  it("takes in the older night once the range is widened", () => {
    show([RECENT, OLD], "all");

    expect(screen.getByRole("list", { name: "What was done" }).textContent).toContain(
      "Progress raid",
    );
    expect(screen.getByRole("status", { name: "What the range holds" }).textContent).toContain(
      "2 segments",
    );
  });

  it("hands the chosen range back rather than keeping it", () => {
    const shown = show([RECENT, OLD]);

    fireEvent.change(screen.getByRole("combobox", { name: "Showing" }), {
      target: { value: "quarter" },
    });

    expect(shown.onRange).toHaveBeenCalledWith("quarter");
  });

  /** The gains are things that *happened*, so they are reckoned over the range too. */
  it("summarises what the range got them", () => {
    show([RECENT, OLD]);

    const gains = screen.getByRole("region", { name: "What it got them" });
    expect(within(gains).getByText("Clockwork Glider")).toBeTruthy();
  });

  describe("a range that holds nothing", () => {
    /**
     * The screen a player opening Chronie after a month away is looking at. A blank one would
     * read as a history that had been lost.
     */
    it("says so, and says how much there is altogether", () => {
      show([OLD]);

      expect(screen.getByText("Nothing in this range")).toBeTruthy();
      expect(screen.getByText(/has 1 segment recorded altogether/)).toBeTruthy();
    });

    it("offers the way out of itself", () => {
      const shown = show([OLD]);

      fireEvent.click(screen.getByRole("button", { name: "Show all time" }));

      expect(shown.onRange).toHaveBeenCalledWith("all");
    });

    /** Widening is the only thing to offer, so a range that already holds it all offers none. */
    it("offers nothing to widen to when it is already the widest", () => {
      show([OLD], "all");

      expect(screen.queryByRole("button", { name: "Show all time" })).toBeNull();
      expect(screen.queryByText("Nothing in this range")).toBeNull();
    });
  });

  describe("the segments", () => {
    /** Forty rows above the two facts a reader came for is why they were moved down here. */
    it("folds them away under a count", () => {
      show([RECENT, OLD], "all");

      const folded = screen.getByRole("group", { name: "Every segment in this range" });
      expect(within(folded).getByText("2 segments")).toBeTruthy();
      expect(folded).toHaveProperty("open", false);
    });

    it("holds only the ones the range holds", () => {
      show([RECENT, OLD]);

      expect(
        within(screen.getByRole("group", { name: "Every segment in this range" })).getByText(
          "1 segment",
        ),
      ).toBeTruthy();
    });

    /**
     * Stepping to "the next segment" out of a fortnight and into something from March would be
     * stepping out of the question the reader asked, so the modal walks what is on screen.
     */
    it("opens a segment walking the range rather than the whole history", () => {
      const shown = show([RECENT, OLD]);

      fireEvent.click(screen.getByRole("button", { name: /^Open segment:/ }));

      expect(shown.onOpenSegment).toHaveBeenCalledWith(RECENT.segmentId, [
        expect.objectContaining({ segmentId: RECENT.segmentId }),
      ]);
    });
  });
});
