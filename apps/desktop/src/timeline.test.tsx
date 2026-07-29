/**
 * The session card, and what leads it.
 *
 * A session card is a summary of an evening, and the argument the whole view is built on is
 * about ordering: what somebody did comes before what it earned them. These tests hold that
 * ordering, and hold the one exception the page makes to its own rule — the activities are a
 * list before anybody asks for a list, because "a +14 and a +15" is the answer and "2 Mythic+
 * runs" is not.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCaptureAlbum } from "./captures";
import { createItemBook } from "./items";
import { buildSessions } from "./sessions";
import { Timeline } from "./timeline";
import type { Activity, Segment } from "./types";

const BASE = 1_785_063_600;

let nextSegmentId = 0;

function segment(overrides: Partial<Segment> = {}): Segment {
  nextSegmentId += 1;
  const startedAt = overrides.startedAt ?? BASE;
  const seconds = overrides.seconds ?? 1800;
  return {
    segmentId: nextSegmentId,
    id: `synthetic-${nextSegmentId}`,
    character: "Aster-Vale",
    classFile: "MAGE",
    level: 12,
    day: "2026-07-26",
    instance: "Glass Caverns",
    difficulty: "",
    instanceType: "none",
    startedAt,
    endedAt: startedAt + seconds,
    seconds,
    lootValue: 0,
    goldDiff: 0,
    housingXP: 0,
    activities: [],
    ...overrides,
  };
}

const key = (
  id: number,
  level: number,
  dungeon: string,
  extra: Partial<Activity> = {},
): Activity => ({
  id,
  kind: "mythic_plus",
  source: "inferred",
  confidence: 1,
  metadata: { keystoneLevel: level, dungeon, timed: true },
  ...extra,
});

/**
 * The timeline over segments, with the two caches it needs answered by doubles rather than by
 * a backend. `opened` is what a press did, which is the only way to see where a row goes.
 */
function draw(segments: Segment[]) {
  const opened: number[] = [];
  const view = render(
    <Timeline
      sessions={buildSessions(segments)}
      onOpenSegment={(segmentId) => opened.push(segmentId)}
      items={createItemBook({
        load: () => Promise.resolve({ items: {} }),
        loadIcons: () => Promise.resolve({ icons: {} }),
      })}
      album={createCaptureAlbum(vi.fn(() => Promise.resolve({ thumbnails: {} })))}
      captures={{
        loadImage: () => Promise.resolve({ id: 0, image: "", byteSize: 0 }),
        setNote: () => Promise.resolve({}),
        remove: () => Promise.resolve({}),
        onApply: () => {},
        onError: String,
      }}
    />,
  );
  return { ...view, opened };
}

afterEach(cleanup);

describe("the activities on a session card", () => {
  it("lists every run rather than folding them into a count", () => {
    const view = draw([
      segment({ startedAt: BASE, activities: [key(1, 14, "Glass Caverns")] }),
      segment({ startedAt: BASE + 1900, activities: [key(2, 15, "Copperwood Depths")] }),
    ]);

    const roll = view.container.querySelector(".act-roll");
    expect(within(roll as HTMLElement).getAllByRole("button")).toHaveLength(2);
    expect(roll?.textContent).toContain("+14");
    expect(roll?.textContent).toContain("+15");
  });

  it("orders them the way the evening went", () => {
    const view = draw([
      segment({ startedAt: BASE + 1900, activities: [key(2, 15, "Copperwood Depths")] }),
      segment({ startedAt: BASE, activities: [key(1, 14, "Glass Caverns")] }),
    ]);

    const rows = within(view.container.querySelector(".act-roll") as HTMLElement).getAllByRole(
      "button",
    );
    expect(rows[0].textContent).toContain("+14");
    expect(rows[1].textContent).toContain("+15");
  });

  // The row is the way into the segment, which is where everything the chip could not say
  // lives — the fight-by-fight, the pictures, and the place it can be corrected.
  it("opens the segment the run was recorded in", () => {
    const first = segment({ startedAt: BASE, activities: [key(1, 14, "Glass Caverns")] });
    const second = segment({ startedAt: BASE + 1900, activities: [key(2, 15, "Copperwood")] });
    const view = draw([first, second]);

    fireEvent.click(screen.getByRole("button", { name: /\+15 · Copperwood/ }));

    expect(view.opened).toEqual([second.segmentId]);
  });

  it("says who did it, on an evening that hopped characters", () => {
    const view = draw([
      segment({
        startedAt: BASE,
        character: "Brin-Hearth",
        classFile: "DRUID",
        activities: [key(1, 9, "Copperwood Depths")],
      }),
    ]);

    expect(view.container.querySelector(".act-who")?.textContent).toBe("Brin-Hearth");
    expect(view.container.querySelector(".act")?.getAttribute("data-class")).toBe("DRUID");
  });

  // The dashed mark is the difference between "Chronie thinks" and "I said so", and it has
  // to survive the move from a chip inside a segment row to a row on the card itself.
  it("marks a guess the backend was unsure about", () => {
    const view = draw([
      segment({ activities: [key(1, 14, "Glass Caverns", { confidence: 0.4 })] }),
    ]);

    expect(view.container.querySelector(".act.guess")).toBeTruthy();
  });

  it("draws nothing at all for an evening nobody labelled", () => {
    const view = draw([segment({ mounts: [{ id: 11, name: "Clockwork Glider" }] })]);

    expect(view.container.querySelector(".act-roll")).toBeNull();
  });

  // An evening with something to say for itself is not a quiet one, whichever half of the
  // card says it.
  it("keeps the quiet-session line for an evening with neither activities nor gains", () => {
    expect(draw([segment()]).container.textContent).toContain("A quiet session");
    cleanup();
    const labelled = draw([segment({ activities: [key(1, 14, "Glass Caverns")] })]);
    expect(labelled.container.textContent).not.toContain("A quiet session");
  });
});
