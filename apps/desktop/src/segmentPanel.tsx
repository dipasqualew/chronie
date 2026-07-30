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

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { SegmentBody, SegmentHead, useSegmentStep, walkOnArrows } from "./segmentModal";
import type { SegmentViewProps } from "./segmentModal";

export function SegmentPanel({
  showing,
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
}: SegmentViewProps): ReactNode {
  const segment = showing?.order[showing.index];
  const { body, step } = useSegmentStep(onStep);
  const frame = useRef<HTMLElement>(null);
  const open = segment !== undefined;

  // What `showModal` would have done, done by hand, because nothing else about this is a modal.
  // The panel takes the focus when it opens — otherwise the arrow keys below are heard by the
  // segment row that was clicked, which is not what a reader who just opened a segment means by
  // "next" — and hands it back to that row when it closes, so a reader working the timeline from
  // the keyboard is put down where they were rather than at the top of the document.
  //
  // Keyed on whether anything is open rather than on which segment is, so stepping through a
  // session does not drag the focus out of whatever the reader is reading.
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
  }, [open]);

  if (!segment) return null;

  return (
    <aside
      className="panel segment-panel"
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
        ref={body}
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
