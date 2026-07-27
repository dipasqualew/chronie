/**
 * The timeline: play sessions down a spine, newest first.
 *
 * This is the view that answers "what have I been doing", and the answer is a summary at
 * every level. A session leads with what kind of evening it was — twelve achievements, two
 * mounts, four levels — rather than with twelve achievements; each of those unfolds into what
 * it counted when the reader asks; and the segments that produced them stay folded away
 * behind a count, each one summarised the same way. Nothing on this page is a list until
 * somebody has asked for a list.
 */

import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { CaptureFold } from "./captureGallery";
import type { CaptureActions } from "./captureGallery";
import type { CaptureAlbum } from "./captures";
import { clock, dayLabel, duration, plural } from "./format";
import type { ItemBook } from "./items";
import type { Session } from "./sessions";
import { CharacterCircle, HighlightList, SegmentButton, classProps, shownHighlights } from "./ui";
import type { OpenSegment } from "./ui";

export interface TimelineProps {
  sessions: Session[];
  onOpenSegment: OpenSegment;
  /** What the game says about an item, for the summaries that unfold into transmog. */
  items: ItemBook;
  /** The thumbnails the window has already been handed, shared with every other grid. */
  album: CaptureAlbum;
  captures: CaptureActions;
}

export function Timeline(
  { sessions, onOpenSegment, items, album, captures }: TimelineProps,
): ReactNode {
  // What the user has opened, kept across repaints: an activity edit redraws the whole view,
  // and having it fold back up under the cursor would be maddening.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // At most one summary is unfolded per session — opening a second closes the first — so a
  // card never grows two lists at once and the page stays the length the reader expects.
  const [unfolded, setUnfolded] = useState<ReadonlyMap<string, string>>(() => new Map());
  // The evening's pictures, folded away like everything else on this page until asked for.
  const [showing, setShowing] = useState<ReadonlySet<string>>(() => new Set());

  if (!sessions.length) {
    return (
      <div className="empty">
        <p className="empty-title">No play sessions yet</p>
        <p>Play for a bit, then log out or <code>/reload</code> so the game writes its saved
        variables. Chronie picks them up within half a minute.</p>
      </div>
    );
  }

  const toggleSegments = (id: string): void => setExpanded((open) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const toggleCaptures = (id: string): void => setShowing((open) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const unfold = (id: string, kind: string): void => setUnfolded((open) => {
    const next = new Map(open);
    if (next.get(id) === kind) next.delete(id);
    else next.set(id, kind);
    return next;
  });

  let lastDay: string | null = null;
  return (
    <div className="spine">
      {sessions.map((session) => {
        const label = dayLabel(session.day);
        const divider = label === lastDay
          ? null
          : <div className="spine-day"><span>{label}</span></div>;
        lastDay = label;
        // A fragment rather than a wrapper, because the day label sticks to the top of the
        // page as the reader scrolls past it — and an element only sticks within its own
        // parent's box, so a div per session would peel each label off after one card.
        return (
          <Fragment key={session.id}>
            {divider}
            <SessionCard
              session={session}
              open={expanded.has(session.id)}
              unfolded={unfolded.get(session.id) ?? null}
              items={items}
              album={album}
              captures={captures}
              showingCaptures={showing.has(session.id)}
              onToggleCaptures={() => toggleCaptures(session.id)}
              onToggleSegments={() => toggleSegments(session.id)}
              onUnfold={(kind) => unfold(session.id, kind)}
              // A summary chip, one of the things it unfolded into, and a segment row all
              // open the modal, and all three walk this evening rather than all of history.
              onOpenSegment={(segmentId) => onOpenSegment(segmentId, session.segments)}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

interface SessionCardProps {
  session: Session;
  open: boolean;
  unfolded: string | null;
  items: ItemBook;
  album: CaptureAlbum;
  captures: CaptureActions;
  showingCaptures: boolean;
  onToggleCaptures: () => void;
  onToggleSegments: () => void;
  onUnfold: (kind: string) => void;
  onOpenSegment: (segmentId: number) => void;
}

function SessionCard(
  {
    session, open, unfolded, items, album, captures, showingCaptures, onToggleCaptures,
    onToggleSegments, onUnfold, onOpenSegment,
  }: SessionCardProps,
): ReactNode {
  const cast = session.characters;
  // The spine's node takes the colour of whoever played most, which makes an evening on one
  // character recognisable from the shape of the page alone.
  const lead = cast[0];
  return (
    <article
      className="session" {...classProps(lead?.classFile)}
      aria-label={`Play session ${dayLabel(session.day)} ${clock(session.startedAt)}`}
    >
      <div className="session-node" aria-hidden="true" />
      <div className="panel session-card">
        <header className="session-head">
          <div className="session-when">
            <span className="session-clock">
              {clock(session.startedAt)} – {clock(session.endedAt)}
            </span>
            <span className="session-cast">
              {cast.map((character) =>
                <CharacterCircle key={character.name} character={character} />)}
            </span>
          </div>
          <div className="session-time">
            <span className="session-played">{duration(session.playedSeconds)}</span>
            <span className="session-elapsed">
              played · {duration(session.spanSeconds)} elapsed
            </span>
          </div>
        </header>
        {shownHighlights(session.highlights).length
          ? <HighlightList
            entries={session.highlights} scope={session.id} expanded={unfolded} items={items}
            onUnfold={onUnfold} onOpenSegment={onOpenSegment}
          />
          : <p className="session-quiet">A quiet session — nothing new to show for it.</p>}
        {/* The evening's pictures, above the segments that produced them: a photograph is
            what somebody came back to this card for, and the segments are the ledger. */}
        <CaptureFold
          segments={session.segments} album={album} actions={captures}
          open={showingCaptures} onToggle={onToggleCaptures}
        />
        <button
          type="button" className="session-toggle" aria-expanded={open}
          onClick={onToggleSegments}
        >
          <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          {plural(session.segments.length, "segment")}
        </button>
        {open
          ? <ol className="session-segments">
            {session.segments.map((segment) => (
              <li key={segment.segmentId}>
                <SegmentButton segment={segment} onOpen={() => onOpenSegment(segment.segmentId)} />
              </li>
            ))}
          </ol>
          : null}
      </div>
    </article>
  );
}
