/**
 * The pictures the segment modal draws from the installed game, and what it does without one.
 *
 * The rest of the modal is what a reader sees and is driven end to end in `e2e/segments.spec.ts`.
 * What is here is the half that cannot be seen from outside: whether the frame beside a boss is
 * held while its portrait is still crossing the bridge, and whether it is there at all on a window
 * with no game behind it.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAchievementBook } from "./achievements";
import { createBossPortraits } from "./bosses";
import { createCaptureAlbum } from "./captures";
import { createItemBook } from "./items";
import { SegmentModal } from "./segmentModal";
import type { BossPortraits } from "./bosses";
import type { EncounterEvent, IconsPayload, Segment } from "./types";

afterEach(cleanup);

// jsdom has no `showModal`, and the modal drives the element rather than taking a prop — so
// without these the dialog is never open and nothing inside it is reachable.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
  };
});

const BASE = 1_785_063_600;

/** A fight the game has a portrait for, and one it has never heard of. */
const DRAWN = 2976;
const UNDRAWN = 99_999;
const PORTRAIT = "data:image/png;base64,glubtok";

function segment(encounters: EncounterEvent[]): Segment {
  return {
    segmentId: 1,
    id: "synthetic-1",
    character: "Aster-Vale",
    classFile: "MAGE",
    level: 12,
    day: "2026-07-26",
    instance: "The Deadmines",
    difficulty: "",
    instanceType: "dungeon",
    startedAt: BASE,
    endedAt: BASE + 1800,
    seconds: 1800,
    lootValue: 0,
    goldDiff: 0,
    housingXP: 0,
    encounters,
  };
}

/**
 * A book over an install that draws whatever `held` names.
 *
 * The lookup is the app's own and only its far end is fake, injected rather than patched — so what
 * is under test includes the batching and the redraw, not just the markup.
 */
function bossBook(held: Record<number, string>): BossPortraits {
  const load = (ids: number[]): Promise<IconsPayload> =>
    Promise.resolve({
      icons: Object.fromEntries(
        ids.filter((id) => held[id]).map((id) => [String(id), held[id] as string]),
      ),
    });
  return createBossPortraits({ load });
}

/** The modal open on one segment, with everything it needs and nothing it does not. */
function draw(showing: Segment, bosses?: BossPortraits) {
  return render(
    <SegmentModal
      showing={{ order: [showing], index: 0 }}
      bosses={bosses}
      achievements={createAchievementBook({
        load: () => Promise.resolve({ achievements: {} }),
        loadIcons: () => Promise.resolve({ icons: {} }),
      })}
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
      onStep={() => {}}
      onClose={() => {}}
      onEditActivities={() => {}}
    />,
  );
}

const portraits = (view: ReturnType<typeof draw>): HTMLImageElement[] =>
  Array.from(view.container.querySelectorAll<HTMLImageElement>(".boss-portrait img"));

const frames = (view: ReturnType<typeof draw>): number =>
  view.container.querySelectorAll(".boss-portrait").length;

describe("the portraits on the encounter list", () => {
  /**
   * The fight is named beside the picture, so the picture is decorative — a reader who heard both
   * would hear every boss twice. What says the right one arrived is the source on the `<img>`.
   */
  it("draws the portrait the game gives each fight that ended", async () => {
    const view = draw(
      segment([{ id: DRAWN, name: "Glubtok", at: BASE + 400, success: true }]),
      bossBook({ [DRAWN]: PORTRAIT }),
    );

    await waitFor(() => expect(portraits(view)).toHaveLength(1));
    expect(portraits(view)[0]?.getAttribute("src")).toBe(PORTRAIT);
    expect(portraits(view)[0]?.getAttribute("alt")).toBe("");
    expect(screen.getByText("Glubtok")).toBeTruthy();
  });

  /**
   * Unlike a place, a fight almost always has a picture — the game draws all but one of the
   * encounters its journal gives an id to — so the frame is held while the portrait is still on
   * its way. A list of eight bosses that indented itself as each one landed would be worse than
   * one that waited, which is the same bargain the achievement icon above it makes.
   */
  it("holds the frame for a fight the game has no portrait for", async () => {
    const view = draw(
      segment([
        { id: DRAWN, name: "Glubtok", at: BASE + 400, success: true },
        { id: UNDRAWN, name: "Sand-Wrought Colossus", at: BASE + 700, success: false },
      ]),
      bossBook({ [DRAWN]: PORTRAIT }),
    );

    await waitFor(() => expect(portraits(view)).toHaveLength(1));
    expect(frames(view)).toBe(2);
    expect(screen.getByText("Sand-Wrought Colossus")).toBeTruthy();
  });

  /**
   * A wipe and a kill on the same boss are two lines, and each asks about itself — so a fight
   * fought twice is drawn twice out of one answer rather than once.
   */
  it("draws the same boss on every attempt at it", async () => {
    const view = draw(
      segment([
        { id: DRAWN, name: "Glubtok", at: BASE + 400, success: false },
        { id: DRAWN, name: "Glubtok", at: BASE + 700, success: true },
      ]),
      bossBook({ [DRAWN]: PORTRAIT }),
    );

    await waitFor(() => expect(portraits(view)).toHaveLength(2));
    expect(portraits(view).map((image) => image.getAttribute("src"))).toEqual([PORTRAIT, PORTRAIT]);
  });

  /** A window with no game install behind it draws the list exactly as it always did. */
  it("draws the list without any frame when nothing can look a portrait up", () => {
    const view = draw(segment([{ id: DRAWN, name: "Glubtok", at: BASE + 400, success: true }]));

    expect(screen.getByText("Glubtok")).toBeTruthy();
    expect(frames(view)).toBe(0);
  });
});
