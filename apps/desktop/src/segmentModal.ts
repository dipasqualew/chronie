/**
 * One segment, in full, with a way through to the ones either side of it.
 *
 * The timeline and the details table both hand this the list a segment sits in — a play
 * session in one case, the current sort and filter in the other — so "next" always means
 * the next one in whatever the reader was already looking at.
 */

import { highlights } from "./sessions";
import { clock, dayLabel, duration, escapeHtml, plural, signed } from "./format";
import { eventsOf } from "./types";
import type { EventListKey, EventOf, Segment } from "./types";
import { activityChip, classDot, className, highlightList, locationType } from "./ui";

const wowhead = (kind: string, id: number, text: string): string =>
  `<a href="https://www.wowhead.com/${kind}=${encodeURIComponent(id)}"
    target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;

const at = (event: { at?: number | null }): string =>
  (event.at ? `<span class="muted">${escapeHtml(clock(event.at))}</span>` : "");

interface Section {
  title: string;
  /** The section's list drawn off a segment, or nothing at all when it has none. */
  render: (segment: Segment) => string;
}

/**
 * Every list a section can be built from. Activities are the exception: they are the one
 * thing on a segment the user writes rather than the game, they are drawn as chips at the
 * top rather than as a list, and they carry no time of their own to print.
 */
type SectionKey = Exclude<EventListKey, "activities">;

interface SectionSpec<K extends SectionKey> {
  key: K;
  title: string;
  line: (event: EventOf<K>) => string;
}

/** Ties a section's heading to the list it reads and the way one of its events is written. */
function section<K extends SectionKey>(spec: SectionSpec<K>): Section {
  return {
    title: spec.title,
    render: (segment) => {
      const events = eventsOf(segment, spec.key);
      if (!events.length) return "";
      return `<section class="detail-section">
        <h3>${escapeHtml(spec.title)}</h3>
        <ul>${events.map((event) => `<li>${spec.line(event)} ${at(event)}</li>`).join("")}</ul>
      </section>`;
    },
  };
}

/**
 * Every list of events a segment can carry, and how each one reads in full. The table
 * columns abbreviate; this is the place that does not, because it is where someone comes
 * when the abbreviation was not enough.
 */
const SECTIONS: Section[] = [
  section({
    key: "encounters",
    title: "Encounters",
    line: (event) => `${escapeHtml(event.name || `Encounter ${event.id}`)} ` +
      `<span class="${event.success ? "ok" : "loss"}">${event.success ? "killed" : "wipe"}</span>` +
      (event.groupSize ? ` <span class="muted">${escapeHtml(plural(event.groupSize, "player"))}</span>` : ""),
  }),
  section({
    key: "achievements",
    title: "Achievements",
    line: (event) => `🏆 ${escapeHtml(event.name || `Achievement ${event.id}`)} ` +
      `<span class="muted">${event.accountFirst ? "account first" : "character first"}</span>`,
  }),
  section({ key: "levelUps", title: "Level ups", line: (event) => `⬆️ Level ${escapeHtml(event.level)}` }),
  section({ key: "mounts", title: "Mounts", line: (event) => `🐎 ${escapeHtml(event.name || `Mount ${event.id}`)}` }),
  section({ key: "pets", title: "Pets", line: (event) => `🐾 ${escapeHtml(event.name || `Pet ${event.id}`)}` }),
  section({ key: "toys", title: "Toys", line: (event) => `🧸 ${escapeHtml(event.name || `Toy ${event.id}`)}` }),
  section({
    key: "transmogs",
    title: "Transmog",
    line: (event) => `👘 ${wowhead("item", event.id, event.name || `Item ${event.id}`)} ` +
      (event.newAppearance === true
        ? '<span class="appearance-new">new appearance</span>'
        : event.newAppearance === false
          ? '<span class="appearance-variant">variant of one owned</span>'
          : '<span class="muted">unknown</span>'),
  }),
  section({
    key: "quests",
    title: "Quests",
    line: (event) => `📜 ${wowhead("quest", event.id, event.name || `Quest ${event.id}`)}` +
      (event.accountFirst ? ' <span class="muted">account first</span>' : ""),
  }),
  section({
    key: "housingItems",
    title: "Housing",
    line: (event) => `🪑 ${escapeHtml(event.name || `Decor ${event.id}`)} ` +
      `<span class="muted">${event.warbandFirst ? "warband first" : "already known"}</span>`,
  }),
  section({
    key: "housingLevelUps",
    title: "Housing levels",
    line: (event) => `🏡 Housing level ${escapeHtml(event.level)}`,
  }),
  section({
    key: "currencies",
    title: "Currency",
    line: (event) => `🪙 ${escapeHtml(event.name)} <span class="muted">${escapeHtml(signed(event.amount))}</span>`,
  }),
  section({
    key: "reputation",
    title: "Reputation",
    line: (event) => `🎖️ ${escapeHtml(event.faction)} <span class="muted">${escapeHtml(signed(event.amount))}</span>`,
  }),
];

export interface SegmentModalOptions {
  dialog: HTMLDialogElement;
  onEditActivities: (segmentId: number) => void;
}

export interface SegmentModal {
  open: (segmentId: number, segments: Segment[]) => void;
  refresh: (segments: Segment[]) => void;
  current: () => Segment | undefined;
  isOpen: () => boolean;
}

/** The dialog's own furniture, which index.html is required to carry. */
function part<T extends Element = HTMLElement>(dialog: HTMLDialogElement, selector: string): T {
  const found = dialog.querySelector<T>(selector);
  if (!found) throw new Error(`The segment detail dialog is missing ${selector}.`);
  return found;
}

export function createSegmentModal({ dialog, onEditActivities }: SegmentModalOptions): SegmentModal {
  // The list is held rather than copied out of, so that a repaint after an edit finds the
  // same neighbours the reader was navigating a moment ago.
  let order: Segment[] = [];
  let index = 0;

  const current = (): Segment | undefined => order[index];

  function open(segmentId: number, segments: Segment[]): void {
    if (!segments?.length) return;
    order = segments;
    index = Math.max(segments.findIndex((segment) => segment.segmentId === segmentId), 0);
    draw();
    if (!dialog.open) dialog.showModal();
  }

  function step(by: number): void {
    const next = index + by;
    if (next < 0 || next >= order.length) return;
    index = next;
    draw();
    dialog.querySelector(".detail-body")?.scrollTo({ top: 0 });
  }

  /** Re-resolves the segments on screen against a freshly loaded dashboard. */
  function refresh(segments: Segment[]): void {
    if (!dialog.open) return;
    const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
    order = order.map((segment) => byId.get(segment.segmentId) || segment);
    draw();
  }

  function draw(): void {
    const segment = current();
    if (!segment) {
      dialog.close();
      return;
    }
    part(dialog, ".detail-position").textContent = `${index + 1} of ${order.length}`;
    part<HTMLButtonElement>(dialog, '[data-role="prev"]').disabled = index === 0;
    part<HTMLButtonElement>(dialog, '[data-role="next"]').disabled = index >= order.length - 1;
    part(dialog, ".detail-title").textContent = segment.instance;
    part(dialog, ".detail-body").innerHTML = body(segment);
    dialog.querySelector("[data-edit-activities]")
      ?.addEventListener("click", () => onEditActivities(segment.segmentId));
  }

  part(dialog, '[data-role="prev"]').addEventListener("click", () => step(-1));
  part(dialog, '[data-role="next"]').addEventListener("click", () => step(1));
  part(dialog, '[data-role="close"]').addEventListener("click", () => dialog.close());
  // Arrow keys are what a reader reaches for once they realise the modal walks a list, and
  // nothing inside it wants them: the body scrolls, it does not select.
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });

  return { open, refresh, current, isOpen: () => dialog.open };
}

function body(segment: Segment): string {
  const facts = [
    `${escapeHtml(dayLabel(segment.day))} · ${escapeHtml(clock(segment.startedAt))} – ${escapeHtml(clock(segment.endedAt))}`,
    escapeHtml(duration(segment.seconds)),
    `<span class="badge">${escapeHtml(locationType(segment))}</span>`,
  ];
  if (segment.difficulty) facts.push(escapeHtml(segment.difficulty));

  return `
    <p class="detail-who">
      ${classDot(segment.classFile)}<strong>${escapeHtml(segment.character)}</strong>
      <span class="muted">${escapeHtml(className(segment.classFile))}${
        segment.level == null ? "" : ` · level ${escapeHtml(segment.level)}`}</span>
    </p>
    <p class="detail-facts">${facts.join(" · ")}</p>
    <div class="detail-activities">
      ${(segment.activities || []).map(activityChip).join("") ||
        '<span class="muted">No activity recorded</span>'}
      <button type="button" data-edit-activities>Edit activities</button>
    </div>
    ${keystone(segment)}
    ${experience(segment)}
    <div class="detail-highlights">${
      highlightList(highlights([segment]), { milestones: false }) ||
      '<p class="muted">Nothing was gained or collected in this segment.</p>'}</div>
    ${SECTIONS.map((entry) => entry.render(segment)).join("")}
  `;
}

function keystone(segment: Segment): string {
  const run = segment.keystone;
  if (!run) return "";
  const outcome = !run.completed
    ? '<span class="loss">abandoned</span>'
    : run.onTime === false
      ? '<span class="loss">depleted</span>'
      : '<span class="ok">timed</span>';
  const upgrades = run.upgrades ? ` · +${escapeHtml(run.upgrades)} upgrade${run.upgrades === 1 ? "" : "s"}` : "";
  return `<section class="detail-section">
    <h3>Keystone</h3>
    <p>🔑 <strong>+${escapeHtml(run.level)}</strong> ${outcome}${upgrades}${
      run.durationMs ? ` <span class="muted">${escapeHtml(duration(run.durationMs / 1000))}</span>` : ""}</p>
  </section>`;
}

function experience(segment: Segment): string {
  const gained = segment.experience;
  if (!gained) return "";
  const reached = gained.endLevel == null ? "" : ` <span class="muted">now level ${escapeHtml(gained.endLevel)}</span>`;
  return `<section class="detail-section">
    <h3>Experience</h3>
    <p>${escapeHtml(signed(gained.gained))} XP · ${escapeHtml(Math.round(gained.percent * 10) / 10)}% of a level${reached}</p>
  </section>`;
}
