/**
 * The timeline: play sessions down a spine, newest first.
 *
 * This is the view that answers "what have I been doing", and the answer is a summary at
 * every level. A session leads with what kind of evening it was — twelve achievements, two
 * mounts, four levels — rather than with twelve achievements; each of those unfolds into
 * what it counted when the reader asks; and the segments that produced them stay folded
 * away behind a count, each one summarised the same way. Nothing on this page is a list
 * until somebody has asked for a list.
 */

import { clock, dayLabel, duration, escapeHtml, plural } from "./format";
import type { Session } from "./sessions";
import type { Segment } from "./types";
import { characterCircle, classAttr, highlightList, segmentButton } from "./ui";

/**
 * Given the segment to show and the session it belongs to, so the detail modal's next and
 * previous walk that evening rather than the whole of recorded history.
 */
export type OpenSegment = (segmentId: number, order: Segment[]) => void;

export interface TimelineOptions {
  /** Where the spine is drawn. */
  host: HTMLElement;
  onOpenSegment: OpenSegment;
}

export interface Timeline {
  render: (sessions: Session[]) => void;
}

export function createTimeline({ host, onOpenSegment }: TimelineOptions): Timeline {
  // What the user has opened, kept across repaints: an activity edit redraws the whole
  // view, and having it fold back up under the cursor would be maddening.
  const expanded = new Set<string>();
  // At most one summary is unfolded per session — opening a second closes the first — so a
  // card never grows two lists at once and the page stays the length the reader expects.
  const unfolded = new Map<string, string>();

  function render(sessions: Session[]): void {
    if (!sessions.length) {
      host.innerHTML = `<div class="empty">
        <p class="empty-title">No play sessions yet</p>
        <p>Play for a bit, then log out or <code>/reload</code> so the game writes its saved
        variables. Chronie picks them up within half a minute.</p>
      </div>`;
      return;
    }

    let lastDay: string | null = null;
    host.innerHTML = `<div class="spine">${sessions.map((session) => {
      const label = dayLabel(session.day);
      const divider = label === lastDay ? "" : `<div class="spine-day"><span>${escapeHtml(label)}</span></div>`;
      lastDay = label;
      return divider + card(session, expanded.has(session.id), unfolded.get(session.id) ?? null);
    }).join("")}</div>`;

    /** The session an element sits in, which is how every click below knows its context. */
    const sessionOf = (element: HTMLElement): string =>
      element.closest<HTMLElement>("[data-session]")?.dataset.session ?? "";

    host.querySelectorAll<HTMLElement>("[data-toggle-session]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.toggleSession;
        if (id === undefined) return;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        render(sessions);
      });
    });
    host.querySelectorAll<HTMLElement>("[data-unfold]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = sessionOf(button);
        const kind = button.dataset.unfold;
        if (kind === undefined) return;
        if (unfolded.get(id) === kind) unfolded.delete(id);
        else unfolded.set(id, kind);
        render(sessions);
      });
    });
    // A summary chip, one of the things it unfolded into, and a segment row all open the
    // modal, and all three sit inside their session's article — which is where the list to
    // navigate comes from.
    const byId = new Map(sessions.map((session) => [session.id, session]));
    host.querySelectorAll<HTMLElement>("[data-open-segment]").forEach((button) => {
      button.addEventListener("click", () => {
        const session = byId.get(sessionOf(button));
        onOpenSegment(Number(button.dataset.openSegment), session?.segments || []);
      });
    });
  }

  return { render };
}

function card(session: Session, open: boolean, unfolded: string | null): string {
  const cast = session.characters;
  // The spine's node takes the colour of whoever played most, which makes an evening on
  // one character recognisable from the shape of the page alone.
  const lead = cast[0];
  return `<article class="session" data-session="${escapeHtml(session.id)}" ${classAttr(lead?.classFile)}
    aria-label="Play session ${escapeHtml(dayLabel(session.day))} ${escapeHtml(clock(session.startedAt))}">
    <div class="session-node" aria-hidden="true"></div>
    <div class="panel session-card">
      <header class="session-head">
        <div class="session-when">
          <span class="session-clock">${escapeHtml(clock(session.startedAt))} – ${escapeHtml(clock(session.endedAt))}</span>
          <span class="session-cast">${cast.map(characterCircle).join("")}</span>
        </div>
        <div class="session-time">
          <span class="session-played">${escapeHtml(duration(session.playedSeconds))}</span>
          <span class="session-elapsed">played · ${escapeHtml(duration(session.spanSeconds))} elapsed</span>
        </div>
      </header>
      ${highlightList(session.highlights, { scope: session.id, expanded: unfolded }) ||
        '<p class="session-quiet">A quiet session — nothing new to show for it.</p>'}
      <button type="button" class="session-toggle" data-toggle-session="${escapeHtml(session.id)}"
        aria-expanded="${open}">
        <span class="caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
        ${escapeHtml(plural(session.segments.length, "segment"))}
      </button>
      ${open ? `<ol class="session-segments">${session.segments.map(segmentRow).join("")}</ol>` : ""}
    </div>
  </article>`;
}

/** The shared row, in the list a session unfolds into. */
const segmentRow = (segment: Segment): string => `<li>${segmentButton(segment)}</li>`;
