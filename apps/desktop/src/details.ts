/**
 * The details view: every segment as a row, sortable and filterable.
 *
 * The timeline is the story; this is the ledger. Nothing is summarised away, and the row a
 * reader lands on opens the same detail modal the timeline uses — navigating, from here,
 * through the table's current order rather than through a play session.
 */

import { clock, duration, escapeHtml, gold, signed, signedGold } from "./format";
import type { OpenSegment } from "./timeline";
import { eventsOf } from "./types";
import type {
  AchievementEvent,
  CollectibleEvent,
  CurrencyGain,
  EventListKey,
  EventOf,
  HousingItemEvent,
  LevelUpEvent,
  QuestEvent,
  ReputationGain,
  Segment,
  TransmogEvent,
} from "./types";
import { activityText, classDot, locationType } from "./ui";

/**
 * A compact cell that names the first couple of entries and counts the rest, with the
 * full list in the title attribute so nothing is lost to the abbreviation.
 */
function listCell<T>(entries: T[] | undefined, asText: (items: T[]) => string): string {
  const list = entries || [];
  if (list.length === 0) return '<span class="muted">—</span>';
  const shown = asText(list.slice(0, 2));
  const rest = list.length > 2 ? ` <span class="muted">+${list.length - 2} more</span>` : "";
  return `<span title="${escapeHtml(asText(list))}">${escapeHtml(shown)}</span>${rest}`;
}

const repText = (gains?: ReputationGain[]): string =>
  (gains || []).map((gain) => `${gain.faction} +${gain.amount.toLocaleString()}`).join(", ");
const currencyText = (gains?: CurrencyGain[]): string =>
  (gains || []).map((gain) => `${gain.name} ${signed(gain.amount)}`).join(", ");
const achievementText = (earned?: AchievementEvent[]): string =>
  (earned || []).map((event) => `${event.name} (${event.accountFirst ? "account first" : "character first"})`).join(", ");
const levelUpText = (events?: LevelUpEvent[]): string =>
  (events || []).map((event) => `Level ${event.level}`).join(", ");
const collectionText = (events?: CollectibleEvent[]): string =>
  (events || []).map((event) => event.name).join(", ");
const housingText = (events?: HousingItemEvent[]): string =>
  (events || []).map((event) => `${event.name} (${event.warbandFirst ? "warband first" : "additional"})`).join(", ");
const transmogText = (events?: TransmogEvent[]): string => (events || []).map((event) =>
  `${event.name || `Item ${event.id}`} (${event.newAppearance === true
    ? "new" : event.newAppearance === false ? "variant" : "unknown"})`).join(", ");
const questText = (events?: QuestEvent[]): string =>
  (events || []).map((event) => event.name || `Quest ${event.id}`).join(", ");

/** Cells are compared against others from their own column, so both sides always match. */
type SortValue = string | number;

interface Column {
  key: string;
  title: string;
  num?: boolean;
  /** Kept even when this history has nothing to put in it. */
  always?: boolean;
  /** Dropped unless some segment has something in it. */
  optional?: boolean;
  /** A rule of its own for whether the column has earned its place. */
  when?: (segments: Segment[]) => boolean;
  cell: (segment: Segment) => string;
  sort: (segment: Segment) => SortValue;
  /** Set on the event-list columns; what `columnsFor` asks to find out whether they are empty. */
  events?: (segment: Segment) => unknown[];
}

interface EventColumnSpec<K extends EventListKey> {
  key: K;
  title: string;
  text: (events?: Array<EventOf<K>>) => string;
  num?: boolean;
  always?: boolean;
  optional?: boolean;
  when?: (segments: Segment[]) => boolean;
  sort?: (segment: Segment) => SortValue;
}

/**
 * An event-list column reads and sorts the same way every time, so it is declared by its
 * formatter alone and the rest is filled in here. The key is tied to the formatter's event
 * type, so a column pointed at the wrong list will not compile.
 */
function eventColumn<K extends EventListKey>(spec: EventColumnSpec<K>): Column {
  const events = (segment: Segment): Array<EventOf<K>> => eventsOf(segment, spec.key);
  return {
    key: spec.key,
    title: spec.title,
    num: spec.num,
    always: spec.always,
    optional: spec.optional,
    when: spec.when,
    events,
    cell: (segment) => listCell(events(segment), spec.text),
    sort: spec.sort ?? ((segment) => events(segment).length),
  };
}

const ALL_COLUMNS: Column[] = [
  {
    key: "day",
    title: "Started – ended",
    sort: (segment) => segment.endedAt,
    cell: (segment) => `<button type="button" class="row-open" data-open-segment="${segment.segmentId}"
      aria-label="Open segment: ${escapeHtml(segment.character)} in ${escapeHtml(segment.instance)} at ${escapeHtml(clock(segment.startedAt))}">
      ${escapeHtml(segment.day)} <span class="muted">${escapeHtml(clock(segment.startedAt))} – ${escapeHtml(clock(segment.endedAt))}</span>
    </button>`,
  },
  {
    key: "character",
    title: "Character",
    sort: (segment) => segment.character,
    cell: (segment) => classDot(segment.classFile) + escapeHtml(segment.character) +
      (segment.level == null ? "" : ` <span class="muted">Level ${escapeHtml(segment.level)}</span>`),
  },
  { key: "instance", title: "Location", cell: (s) => escapeHtml(s.instance), sort: (s) => s.instance },
  {
    key: "activities", title: "Activity", always: true,
    cell: (s) => listCell(s.activities, activityText), sort: (s) => activityText(s.activities),
  },
  {
    key: "type", title: "Type", sort: (s) => locationType(s),
    cell: (s) => `<span class="badge">${escapeHtml(locationType(s))}</span>`,
  },
  {
    key: "difficulty", title: "Difficulty", sort: (s) => s.difficulty,
    cell: (s) => escapeHtml(s.difficulty) || '<span class="muted">—</span>',
  },
  { key: "seconds", title: "Time", num: true, cell: (s) => duration(s.seconds), sort: (s) => s.seconds },
  {
    key: "lootValue", title: "Loot value", num: true, sort: (s) => s.lootValue,
    cell: (s) => `<span class="gold">${escapeHtml(gold(s.lootValue))}</span>`,
  },
  {
    key: "goldDiff", title: "Gold Δ", num: true, sort: (s) => s.goldDiff,
    cell: (s) => `<span class="${s.goldDiff < 0 ? "loss" : "gold"}">${escapeHtml(signedGold(s.goldDiff))}</span>`,
  },
  eventColumn({ key: "achievements", title: "Achievements", text: achievementText, optional: true }),
  eventColumn({ key: "levelUps", title: "Level ups", text: levelUpText, optional: true }),
  eventColumn({
    key: "currencies", title: "Currency", text: currencyText, optional: true,
    sort: (s) => (s.currencies || []).reduce((total, gain) => total + gain.amount, 0),
  }),
  eventColumn({ key: "mounts", title: "Mounts", text: collectionText, optional: true }),
  eventColumn({ key: "pets", title: "Pets", text: collectionText, optional: true }),
  eventColumn({ key: "quests", title: "Quests", text: questText, optional: true }),
  eventColumn({
    key: "reputation", title: "Reputation", text: repText, optional: true,
    sort: (s) => (s.reputation || []).reduce((total, gain) => total + gain.amount, 0),
  }),
  eventColumn({ key: "toys", title: "Toys", text: collectionText, optional: true }),
  eventColumn({ key: "transmogs", title: "Transmog", text: transmogText, optional: true }),
  eventColumn({ key: "housingItems", title: "Housing items", text: housingText, optional: true }),
  {
    key: "housingXP", title: "Housing XP", num: true, sort: (s) => s.housingXP || 0,
    cell: (s) => (s.housingXP ? signed(s.housingXP) : '<span class="muted">—</span>'),
    when: (segments) => segments.some((segment) => (segment.housingXP || 0) !== 0),
  },
  eventColumn({ key: "housingLevelUps", title: "Housing levels", text: levelUpText, optional: true }),
];

/**
 * Which columns this history justifies. A column for something the player has never done is
 * a column of dashes, so it is left out — except Activity, which is the one column a user
 * fills in themselves and so must be visible before it has anything in it.
 */
function columnsFor(segments: Segment[]): Column[] {
  return ALL_COLUMNS.filter((column) => {
    if (column.always) return true;
    if (column.when) return column.when(segments);
    if (!column.optional) return true;
    return segments.some((segment) => (column.events?.(segment) ?? []).length > 0);
  });
}

/** Ordering within one column, where both values are always of the same kind. */
function ascendingOrder(a: SortValue, b: SortValue): number {
  const greater = typeof a === "number" && typeof b === "number" ? a > b : String(a) > String(b);
  return greater ? 1 : -1;
}

export interface DetailsElements {
  head: HTMLElement;
  rows: HTMLElement;
  empty: HTMLElement;
  count: HTMLElement;
  search: HTMLInputElement;
  character: HTMLSelectElement;
  day: HTMLSelectElement;
}

export interface DetailsOptions {
  elements: DetailsElements;
  /**
   * Given the segment to show and the rows in their current order, so the modal's next and
   * previous follow whatever the reader had sorted and filtered to.
   */
  onOpenSegment: OpenSegment;
}

export interface Details {
  render: (segments: Segment[]) => void;
}

export function createDetails({ elements, onOpenSegment }: DetailsOptions): Details {
  let segments: Segment[] = [];
  let columns: Column[] = [];
  let sortKey = "day";
  let ascending = false;

  function options(select: HTMLSelectElement, values: string[], allLabel: string): void {
    const kept = select.value;
    select.innerHTML = [`<option value="">${allLabel}</option>`]
      .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`))
      .join("");
    if (values.includes(kept)) select.value = kept;
  }

  function visible(): Segment[] {
    const term = elements.search.value.trim().toLowerCase();
    const character = elements.character.value;
    const day = elements.day.value;

    const rows = segments.filter((segment) =>
      (!character || segment.character === character) &&
      (!day || segment.day === day) &&
      (!term || `${segment.instance} ${segment.character} ${segment.difficulty}`.toLowerCase().includes(term)));

    const column = columns.find((entry) => entry.key === sortKey) || columns[0];
    return rows.sort((left, right) => {
      const a = column.sort(left), b = column.sort(right);
      if (a === b) return left.id < right.id ? -1 : 1;
      return ascendingOrder(a, b) * (ascending ? 1 : -1);
    });
  }

  function draw(): void {
    const rows = visible();

    elements.head.innerHTML = columns.map((column) => {
      const arrow = column.key === sortKey ? `<span class="arrow">${ascending ? "▲" : "▼"}</span>` : "";
      return `<th data-key="${column.key}"${column.num ? ' class="num"' : ""}
        aria-sort="${column.key === sortKey ? (ascending ? "ascending" : "descending") : "none"}"
      >${escapeHtml(column.title)} ${arrow}</th>`;
    }).join("");

    elements.head.querySelectorAll<HTMLTableCellElement>("th").forEach((cell) => {
      cell.addEventListener("click", () => {
        const key = cell.dataset.key;
        if (key === undefined) return;
        if (key === sortKey) ascending = !ascending;
        else { sortKey = key; ascending = false; }
        draw();
      });
    });

    elements.rows.innerHTML = rows.map((segment) =>
      `<tr data-segment="${segment.segmentId}">${columns.map((column) =>
        `<td${column.num ? ' class="num"' : ""}>${column.cell(segment)}</td>`).join("")}</tr>`).join("");

    // Wired once per repaint on the table rather than per row: a long history is a lot of
    // rows, and the row a click lands in is right there on the event.
    elements.rows.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("a")) return;
        onOpenSegment(Number(row.dataset.segment), rows);
      });
    });

    elements.count.textContent = `${rows.length} of ${segments.length} segments`;
    elements.empty.hidden = rows.length > 0;
    elements.empty.textContent = segments.length
      ? "No segments match those filters."
      : "No segments collected yet.";
  }

  function render(next: Segment[]): void {
    segments = next;
    columns = columnsFor(segments);
    options(elements.character, [...new Set(segments.map((s) => s.character))].sort(), "All characters");
    options(elements.day, [...new Set(segments.map((s) => s.day))].sort().reverse(), "All days");
    draw();
  }

  const FILTERS = ["search", "character", "day"] as const;
  FILTERS.forEach((key) => elements[key].addEventListener("input", draw));

  return { render };
}
