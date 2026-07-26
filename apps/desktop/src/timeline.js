/**
 * The timeline: play sessions down a spine, newest first.
 *
 * This is the view that answers "what have I been doing", so a session leads with the
 * things that happened — an achievement, a mount, a level — and keeps the segments that
 * produced them folded away behind a count. Opening one is how you get from "a good
 * evening" to "which pull, exactly".
 */

import { clock, dayLabel, duration, escapeHtml, plural } from "./format.js";
import {
  activityChip, characterCircle, classColor, classDot, highlightList, locationType,
} from "./ui.js";

/** Milestone chips beyond this are counted rather than drawn; a session card is a summary. */
const CHIP_LIMIT = 10;

/**
 * @param {object} options
 * @param {HTMLElement} options.host Where the spine is drawn.
 * @param {(segmentId: number, order: Array<object>) => void} options.onOpenSegment
 *   Given the segment to show and the session it belongs to, so the detail modal's next and
 *   previous walk that evening rather than the whole of recorded history.
 */
export function createTimeline({ host, onOpenSegment }) {
  // Which sessions the user has opened, kept across repaints: an activity edit redraws the
  // whole view, and having it fold back up under the cursor would be maddening.
  const expanded = new Set();

  function render(sessions) {
    if (!sessions.length) {
      host.innerHTML = `<div class="empty">
        <p class="empty-title">No play sessions yet</p>
        <p>Play for a bit, then log out or <code>/reload</code> so the game writes its saved
        variables. Chronie picks them up within half a minute.</p>
      </div>`;
      return;
    }

    let lastDay = null;
    host.innerHTML = `<div class="spine">${sessions.map((session) => {
      const label = dayLabel(session.day);
      const divider = label === lastDay ? "" : `<div class="spine-day"><span>${escapeHtml(label)}</span></div>`;
      lastDay = label;
      return divider + card(session, expanded.has(session.id));
    }).join("")}</div>`;

    host.querySelectorAll("[data-toggle-session]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.toggleSession;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        render(sessions);
      });
    });
    // Both a highlight chip and a segment row open the modal, and both sit inside their
    // session's article — which is where the list to navigate comes from.
    const byId = new Map(sessions.map((session) => [session.id, session]));
    host.querySelectorAll("[data-open-segment]").forEach((button) => {
      button.addEventListener("click", () => {
        const session = byId.get(button.closest("[data-session]")?.dataset.session);
        onOpenSegment(Number(button.dataset.openSegment), session?.segments || []);
      });
    });
  }

  return { render };
}

function card(session, open) {
  const cast = session.characters;
  // The spine's node takes the colour of whoever played most, which makes an evening on
  // one character recognisable from the shape of the page alone.
  const lead = cast[0];
  return `<article class="session" data-session="${escapeHtml(session.id)}"
    style="--class-color:${classColor(lead?.classFile)}"
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
      ${highlightList(session.highlights, { limit: CHIP_LIMIT }) ||
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

function segmentRow(segment) {
  const label = `${segment.character} in ${segment.instance} at ${clock(segment.startedAt)}`;
  return `<li>
    <button type="button" class="seg" data-open-segment="${segment.segmentId}"
      aria-label="Open segment: ${escapeHtml(label)}">
      <span class="seg-time">${escapeHtml(clock(segment.startedAt))}</span>
      <span class="seg-body">
        <span class="seg-head">
          <span class="seg-who">${classDot(segment.classFile)}${escapeHtml(segment.character)}</span>
          <span class="seg-where">${escapeHtml(segment.instance)}</span>
          <span class="badge">${escapeHtml(locationType(segment))}</span>
          ${segment.difficulty ? `<span class="muted">${escapeHtml(segment.difficulty)}</span>` : ""}
        </span>
        <span class="seg-activities">${(segment.activities || []).map(activityChip).join("") ||
          '<span class="muted">No activity recorded</span>'}</span>
      </span>
      <span class="seg-dur">${escapeHtml(duration(segment.seconds))}</span>
    </button>
  </li>`;
}
