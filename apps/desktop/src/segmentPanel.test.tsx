/**
 * What the panel beside the timeline has to do for itself, because it is not a dialog.
 *
 * Everything a segment *says* is the modal's too and is tested where that is — here and in
 * `e2e/segments.spec.ts`. What is left is the handful of things `showModal` would have given a
 * dialog for nothing and this has to arrange by hand: Escape closes it, the arrow keys walk the
 * list wherever the focus has ended up inside it, and the focus goes into it when it opens and
 * comes back out to whatever opened it when it closes.
 *
 * None of that is visible from outside the window, which is why it is here rather than in the
 * browser suite: a spec out there can press a key, but it cannot say which element the panel
 * handed the focus back to.
 */

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAchievementBook } from "./achievements";
import { createCaptureAlbum } from "./captures";
import { createItemBook } from "./items";
import type { SegmentViewState } from "./segmentModal";
import { PANEL_LEAVE_MS, SegmentPanel, useDock } from "./segmentPanel";
import type { Segment } from "./types";

afterEach(cleanup);

// jsdom lays nothing out and therefore scrolls nothing, so it implements none of this — and
// stepping to another segment puts the body back to the top, which is a call straight into it.
beforeEach(() => {
  Element.prototype.scrollTo = function scrollTo(): void {};
});

const BASE = 1_785_063_600;

function segment(segmentId: number, instance: string): Segment {
  return {
    segmentId,
    id: `synthetic-${segmentId}`,
    character: "Aster-Vale",
    classFile: "MAGE",
    level: 12,
    day: "2026-07-26",
    instance,
    difficulty: "",
    instanceType: "dungeon",
    startedAt: BASE,
    endedAt: BASE + 1800,
    seconds: 1800,
    lootValue: 0,
    goldDiff: 0,
    housingXP: 0,
  };
}

const ORDER = [segment(1, "The Deadmines"), segment(2, "Glass Caverns")];

/** The panel on one segment of a list, with everything it needs and nothing it does not. */
function draw({
  showing = { order: ORDER, index: 0 },
  leaving = false,
  onStep = (): void => {},
  onClose = (): void => {},
}: {
  showing?: SegmentViewState | null;
  leaving?: boolean;
  onStep?: (by: number) => void;
  onClose?: () => void;
} = {}) {
  return render(
    <SegmentPanel
      showing={showing}
      leaving={leaving}
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
      onStep={onStep}
      onClose={onClose}
      onEditActivities={() => {}}
    />,
  );
}

const panel = (): HTMLElement => screen.getByRole("complementary");

describe("the panel the timeline docks a segment in", () => {
  it("draws the segment it is given, and nothing at all when there is none", () => {
    draw();
    expect(screen.getByRole("heading", { name: "The Deadmines" })).toBeTruthy();
    cleanup();

    // Nothing rather than an empty frame: the column it stands in is only there while it is,
    // and a bordered box with no segment in it would be a hole in the timeline. The modal is
    // the other way round — it is in the document from the start, closed.
    expect(draw({ showing: null }).container.innerHTML).toBe("");
  });

  /**
   * The two keys a reader presses at anything that opened over what they were reading. Neither
   * is the browser's doing here — a dialog is given both and this is not one — and both are
   * heard at the panel rather than at whatever inside it has the focus.
   */
  it("walks the list on the arrow keys and closes on Escape", () => {
    const onStep = vi.fn();
    const onClose = vi.fn();
    draw({ onStep, onClose });

    fireEvent.keyDown(panel(), { key: "ArrowRight" });
    fireEvent.keyDown(panel(), { key: "ArrowLeft" });
    expect(onStep.mock.calls).toEqual([[1], [-1]]);

    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * What a reader working the timeline from the keyboard would otherwise lose. The segment row
   * they pressed is what opened this, and it is where they are put back down — not the top of
   * the document, which is where an unmanaged focus goes when the element holding it is removed.
   */
  it("takes the focus when it opens and hands it back to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const view = draw();
    expect(document.activeElement).toBe(panel());

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  /** Which of the two animations is running is the one thing the stylesheet cannot work out. */
  it("says when it is on its way out", () => {
    expect(draw().container.querySelector("[data-closing]")).toBe(null);
    cleanup();
    expect(draw({ leaving: true }).container.querySelector("[data-closing]")).toBe(panel());
  });
});

/**
 * Holding the panel open for the beat it takes to go.
 *
 * The whole of what an exit animation needs and the one part of it React has to do: an element
 * out of the document animates nothing, so the window keeps the closed segment — and the column
 * it stands in — until the going is over. Issue #241.
 */
describe("what the timeline keeps beside itself", () => {
  const first = { order: ORDER, index: 0 };
  const second = { order: ORDER, index: 1 };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const dock = (open: SegmentViewState | null) =>
    renderHook(({ showing }: { showing: SegmentViewState | null }) => useDock(showing), {
      initialProps: { showing: open },
    });

  it("keeps a closed segment standing for the beat it goes in, then takes it away", () => {
    const { result, rerender } = dock(first);
    expect(result.current).toEqual({ showing: first, leaving: false });

    // Still drawn, and drawn as going — the same render the window closed it in, because an
    // effect would have run a paint too late and that paint has no panel in it.
    rerender({ showing: null });
    expect(result.current).toEqual({ showing: first, leaving: true });

    act(() => vi.advanceTimersByTime(PANEL_LEAVE_MS));
    expect(result.current).toEqual({ showing: null, leaving: false });
  });

  /**
   * A reader who closes a segment and opens another within that beat — which is one click on the
   * card underneath — must not have the second one taken away by the first one's timer.
   */
  it("gives up the going when something is opened again inside it", () => {
    const { result, rerender } = dock(first);
    rerender({ showing: null });
    rerender({ showing: second });
    expect(result.current).toEqual({ showing: second, leaving: false });

    act(() => vi.advanceTimersByTime(PANEL_LEAVE_MS * 3));
    expect(result.current).toEqual({ showing: second, leaving: false });
  });
});
