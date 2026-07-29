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
import { createPlaceHeroes } from "./places";
import { SegmentModal } from "./segmentModal";
import type { BossPortraits } from "./bosses";
import type { PlaceHeroes } from "./places";
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
function draw(
  showing: Segment,
  bosses?: BossPortraits,
  { heroes, onClose = (): void => {} }: { heroes?: PlaceHeroes; onClose?: () => void } = {},
) {
  return render(
    <SegmentModal
      showing={{ order: [showing], index: 0 }}
      bosses={bosses}
      heroes={heroes}
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
      onClose={onClose}
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

/* ---------- the header ---------- */

const BANNER = "data:image/png;base64,deadmines";

/** A book of place banners over an install that draws whatever `held` names. */
function heroBook(held: Record<string, string>): PlaceHeroes {
  const load = (places: string[]): Promise<IconsPayload> =>
    Promise.resolve({
      icons: Object.fromEntries(
        places.filter((place) => held[place]).map((place) => [place, held[place] as string]),
      ),
    });
  return createPlaceHeroes({ load });
}

const hero = (view: ReturnType<typeof draw>): HTMLImageElement | null =>
  view.container.querySelector<HTMLImageElement>(".detail-hero img");

describe("the header the modal opens with", () => {
  /**
   * The place is named in the heading under the band, so the picture is decorative — a reader who
   * heard both would hear the place twice. What says the right one arrived is the source.
   */
  it("draws the banner the game gives the place the segment happened in", async () => {
    const view = draw(segment([]), undefined, {
      heroes: heroBook({ "The Deadmines": BANNER }),
    });

    await waitFor(() => expect(hero(view)).not.toBeNull());
    expect(hero(view)?.getAttribute("src")).toBe(BANNER);
    expect(hero(view)?.getAttribute("alt")).toBe("");
    expect(screen.getByRole("heading", { name: "The Deadmines" })).toBeTruthy();
  });

  /**
   * Nothing is drawn while the picture is still crossing the bridge, and nothing is drawn at all
   * on a window with no game install behind it: an empty band the height of a header would be a
   * hole in the modal rather than a header, which is the opposite bargain from the boss frames
   * above — those are held because a fight nearly always has a portrait, and this is the only
   * picture in the modal that is a block rather than an inline frame.
   */
  it("opens on the heading alone when nothing can look a banner up", () => {
    const view = draw(segment([]));

    expect(hero(view)).toBeNull();
    expect(screen.getByRole("heading", { name: "The Deadmines" })).toBeTruthy();
  });

  /** A place the book answers nothing for leaves the modal as it was rather than an empty band. */
  it("opens on the heading alone for a place the book cannot draw", async () => {
    const view = draw(segment([]), undefined, { heroes: heroBook({ Elsewhere: BANNER }) });

    await waitFor(() => expect(hero(view)).toBeNull());
  });
});

/* ---------- clicking away ---------- */

/**
 * A click at a point, which is what light dismissal is decided on: the backdrop is not an element
 * and a click on it arrives with the dialog as its target, so where the pointer was is the only
 * thing that tells one from a click on the modal itself. jsdom reports every box as zero, so the
 * dialog is given one — the box a real modal has, offset from the corner of the window.
 */
function clickAt(dialog: HTMLDialogElement, x: number, y: number): void {
  dialog.getBoundingClientRect = (): DOMRect =>
    ({ left: 100, right: 500, top: 80, bottom: 600 }) as DOMRect;
  dialog.dispatchEvent(
    new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, detail: 1 }),
  );
}

const dialogOf = (view: ReturnType<typeof draw>): HTMLDialogElement =>
  view.container.querySelector("dialog") as HTMLDialogElement;

describe("clicking outside the modal", () => {
  /** What a reader who opened it by clicking expects, and what `showModal` does not give. */
  it("closes when the click landed on the backdrop", () => {
    const onClose = vi.fn();
    const view = draw(segment([]), undefined, { onClose });

    clickAt(dialogOf(view), 40, 300);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The case `event.target === dialog` gets wrong: the modal's own padding and the gaps between
   * its sections are the dialog element, and a reader releasing the mouse there is reading rather
   * than dismissing.
   */
  it("stays open when the click landed inside it", () => {
    const onClose = vi.fn();
    const view = draw(segment([]), undefined, { onClose });

    clickAt(dialogOf(view), 300, 90);

    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * A `<button>` activated from the keyboard fires a click with no coordinates at all, which
   * reports as 0,0 — outside every box there is. Closing on that would have Enter on "Next
   * segment" shut the modal instead of stepping it.
   */
  it("stays open for a click the keyboard fired", () => {
    const onClose = vi.fn();
    const view = draw(segment([]), undefined, { onClose });

    dialogOf(view).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));

    expect(onClose).not.toHaveBeenCalled();
  });
});
