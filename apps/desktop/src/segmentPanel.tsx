/**
 * One segment, opened beside the timeline rather than over it.
 *
 * The same head and the same body the modal draws — see `segmentModal.tsx` — in the other frame
 * a reader meets a segment in. This is the one the timeline opens, and the difference is the
 * whole point of it: the evening the segment came out of is still on screen next to it, so a
 * reader who opened the wrong one clicks the right one instead of closing anything, and a reader
 * walking a raid night watches the card they are walking as they go. A modal cannot do either —
 * it paints out the page behind it and swallows every click that lands there.
 *
 * A panel and not a dialog, which is a claim about what it is rather than about how it is drawn:
 * nothing behind it is inert, nothing about it is waiting to be answered, and the reader may
 * leave it open for as long as they are reading the timeline. What it borrows from a dialog is
 * the two things a reader expects of anything opened this way — Escape closes it, and the focus
 * goes into it and comes back out to whatever opened it.
 */

import "./segmentPanel.css";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { SegmentBody, SegmentHead, useSegmentStep, walkOnArrows } from "./segmentModal";
import type { SegmentViewProps } from "./segmentModal";

/**
 * How long the panel is left standing after the window has closed it, in milliseconds.
 *
 * The going is an animation and an element out of the document does not animate, so the window
 * holds the column open for this long after the last click on it — `useDock` below, and the
 * `segment-panel-out` keyframes in `segmentPanel.css`, which may not run for longer than this.
 * They are two numbers in two languages and there is no third place to put the one: what a
 * mismatch costs is a frame left standing still after it has faded, so this is the generous
 * side of the animation rather than the exact length of it.
 */
export const PANEL_LEAVE_MS = 190;

/**
 * What the timeline draws beside itself: the segment the window has open, or the one it just
 * closed for as long as that one takes to go.
 *
 * The window's rather than the panel's, because the column the panel stands in is the window's —
 * `#timeline-view[data-panel]` in `app.css` — and a column that collapsed the moment a reader
 * pressed Escape would drop the panel into the flow above the timeline and slide it out from
 * there. Both have to last exactly as long, so both read this.
 *
 * Derived while rendering rather than in an effect, which is the difference between a frame that
 * goes and a frame that blinks: an effect runs after the paint that has already taken the panel
 * out of the document, and putting it back would play the *opening* animation on its way out.
 */
export function useDock<Open extends object>(
  open: Open | null,
): {
  showing: Open | null;
  leaving: boolean;
} {
  const [seen, setSeen] = useState<Open | null>(open);
  const [going, setGoing] = useState<Open | null>(null);

  if (open !== seen) {
    setSeen(open);
    // Opening, or being handed a redrawn copy of what is already open, ends any going in
    // progress — a reader who reopens within the beat gets the panel back rather than watching
    // the last one's timer take the new one away.
    setGoing(open ? null : seen);
  }

  useEffect(() => {
    if (!going) return;
    const timer = window.setTimeout(() => setGoing(null), PANEL_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [going]);

  return open ? { showing: open, leaving: false } : { showing: going, leaving: going !== null };
}

export function SegmentPanel({
  showing,
  leaving,
  onStep,
  onClose,
  onEditActivities,
  achievements: book,
  items,
  heroes,
  bosses,
  factions,
  holdings,
  album,
  captures,
  onShowAppearance,
}: SegmentViewProps & {
  /** Whether the window has closed it and it is on its way out. See `useDock`. */
  leaving?: boolean;
}): ReactNode {
  const segment = showing?.order[showing.index];
  // The whole frame is what scrolls here rather than the body inside it, so the ref that puts
  // the reading back to the top on a step is the same element the focus goes to.
  const { scroller: frame, step } = useSegmentStep<HTMLElement>(onStep);
  const open = segment !== undefined;

  // What `showModal` would have done, done by hand, because nothing else about this is a modal.
  // The panel takes the focus when it opens — otherwise the arrow keys below are heard by the
  // segment row that was clicked, which is not what a reader who just opened a segment means by
  // "next" — and hands it back to that row when it closes, so a reader working the timeline from
  // the keyboard is put down where they were rather than at the top of the document.
  //
  // Keyed on whether anything is open rather than on which segment is, so stepping through a
  // session does not drag the focus out of whatever the reader is reading — the ref beside it is
  // the same object for the life of the panel and never re-runs this.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    // Without `preventScroll` the browser brings the whole panel into view, and the panel is
    // taller than the window — so opening a segment scrolled the timeline out from under the
    // card the reader had just clicked, which is the one thing this frame exists not to do.
    frame.current?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open, frame]);

  if (!segment) return null;

  return (
    <aside
      className="panel segment-panel"
      // Which of the two animations in `segmentPanel.css` is running, and — while it is the one
      // going out — that nothing may be clicked on a frame the reader has already dismissed.
      data-closing={leaving ? "" : undefined}
      aria-labelledby="segment-panel-title"
      // Focusable but not in the tab order: it is a place to put the focus rather than a control,
      // and Tab from here goes on into the panel's own buttons.
      tabIndex={-1}
      ref={frame}
      onKeyDown={(event) => {
        walkOnArrows(step)(event);
        // Escape is what closes anything opened over a page, and a reader does not stop to
        // consider whether this one is a dialog. Nothing here is being edited, so nothing is lost.
        if (event.key === "Escape") onClose();
      }}
    >
      <SegmentHead
        showing={showing}
        segment={segment}
        heroes={heroes}
        titleId="segment-panel-title"
        onStep={step}
        onClose={onClose}
      />
      <SegmentBody
        segment={segment}
        book={book}
        items={items}
        bosses={bosses}
        factions={factions}
        holdings={holdings}
        album={album}
        captures={captures}
        onEditActivities={onEditActivities}
        onShowAppearance={onShowAppearance}
      />
    </aside>
  );
}
