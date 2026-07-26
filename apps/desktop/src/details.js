/**
 * The details view: every segment as a row, sortable and filterable.
 *
 * The timeline is the story; this is the ledger. Nothing is summarised away, and the row a
 * reader lands on opens the same detail modal the timeline uses — navigating, from here,
 * through the table's current order rather than through a play session.
 */

import { clock, duration, escapeHtml, gold, signed, signedGold } from "./format.js";
import { activityText, classDot, locationType } from "./ui.js";

/**
 * A compact cell that names the first couple of entries and counts the rest, with the
 * full list in the title attribute so nothing is lost to the abbreviation.
 */
function listCell(entries, asText) {
  const list = entries || [];
  if (list.length === 0) return '<span class="muted">—</span>';
  const shown = asText(list.slice(0, 2));
  const rest = list.length > 2 ? ` <span class="muted">+${list.length - 2} more</span>` : "";
  return `<span title="${escapeHtml(asText(list))}">${escapeHtml(shown)}</span>${rest}`;
}

const repText = (gains) =>
  (gains || []).map((gain) => `${gain.faction} +${gain.amount.toLocaleString()}`).join(", ");
const currencyText = (gains) =>
  (gains || []).map((gain) => `${gain.name} ${signed(gain.amount)}`).join(", ");
const achievementText = (earned) =>
  (earned || []).map((event) => `${event.name} (${event.accountFirst ? "account first" : "character first"})`).join(", ");
const levelUpText = (events) => (events || []).map((event) => `Level ${event.level}`).join(", ");
const collectionText = (events) => (events || []).map((event) => event.name).join(", ");
const housingText = (events) =>
  (events || []).map((event) => `${event.name} (${event.warbandFirst ? "warband first" : "additional"})`).join(", ");
const transmogText = (events) => (events || []).map((event) =>
  `${event.name || `Item ${event.id}`} (${event.newAppearance === true
    ? "new" : event.newAppearance === false ? "variant" : "unknown"})`).join(", ");
const questText = (events) => (events || []).map((event) => event.name || `Quest ${event.id}`).join(", ");

const ALL_COLUMNS = [
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
  { key: "achievements", title: "Achievements", text: achievementText, optional: true },
  { key: "levelUps", title: "Level ups", text: levelUpText, optional: true },
  {
    key: "currencies", title: "Currency", text: currencyText, optional: true,
    sort: (s) => (s.currencies || []).reduce((total, gain) => total + gain.amount, 0),
  },
  { key: "mounts", title: "Mounts", text: collectionText, optional: true },
  { key: "pets", title: "Pets", text: collectionText, optional: true },
  { key: "quests", title: "Quests", text: questText, optional: true },
  {
    key: "reputation", title: "Reputation", text: repText, optional: true,
    sort: (s) => (s.reputation || []).reduce((total, gain) => total + gain.amount, 0),
  },
  { key: "toys", title: "Toys", text: collectionText, optional: true },
  { key: "transmogs", title: "Transmog", text: transmogText, optional: true },
  { key: "housingItems", title: "Housing items", text: housingText, optional: true },
  {
    key: "housingXP", title: "Housing XP", num: true, sort: (s) => s.housingXP || 0,
    cell: (s) => (s.housingXP ? signed(s.housingXP) : '<span class="muted">—</span>'),
    when: (segments) => segments.some((segment) => (segment.housingXP || 0) !== 0),
  },
  { key: "housingLevelUps", title: "Housing levels", text: levelUpText, optional: true },
].map((column) => column.text
  // An event-list column reads and sorts the same way every time, so it is declared by its
  // formatter alone and the rest is filled in here.
  ? {
    cell: (segment) => listCell(segment[column.key], column.text),
    sort: (segment) => (segment[column.key] || []).length,
    ...column,
  }
  : column);

/**
 * Which columns this history justifies. A column for something the player has never done is
 * a column of dashes, so it is left out — except Activity, which is the one column a user
 * fills in themselves and so must be visible before it has anything in it.
 */
function columnsFor(segments) {
  return ALL_COLUMNS.filter((column) => {
    if (column.always) return true;
    if (column.when) return column.when(segments);
    if (!column.optional) return true;
    return segments.some((segment) => (segment[column.key] || []).length);
  });
}

/**
 * @param {object} options
 * @param {(segmentId: number, order: Array<object>) => void} options.onOpenSegment
 *   Given the segment to show and the rows in their current order, so the modal's next and
 *   previous follow whatever the reader had sorted and filtered to.
 */
export function createDetails({ elements, onOpenSegment }) {
  let segments = [];
  let columns = [];
  let sortKey = "day";
  let ascending = false;

  function options(select, values, allLabel) {
    const kept = select.value;
    select.innerHTML = [`<option value="">${allLabel}</option>`]
      .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`))
      .join("");
    if (values.includes(kept)) select.value = kept;
  }

  function visible() {
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
      return (a > b ? 1 : -1) * (ascending ? 1 : -1);
    });
  }

  function draw() {
    const rows = visible();

    elements.head.innerHTML = columns.map((column) => {
      const arrow = column.key === sortKey ? `<span class="arrow">${ascending ? "▲" : "▼"}</span>` : "";
      return `<th data-key="${column.key}"${column.num ? ' class="num"' : ""}
        aria-sort="${column.key === sortKey ? (ascending ? "ascending" : "descending") : "none"}"
      >${escapeHtml(column.title)} ${arrow}</th>`;
    }).join("");

    elements.head.querySelectorAll("th").forEach((cell) => {
      cell.addEventListener("click", () => {
        const key = cell.dataset.key;
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
    elements.rows.querySelectorAll("tr").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("a")) return;
        onOpenSegment(Number(row.dataset.segment), rows);
      });
    });

    elements.count.textContent = `${rows.length} of ${segments.length} segments`;
    elements.empty.hidden = rows.length > 0;
    elements.empty.textContent = segments.length
      ? "No segments match those filters."
      : "No segments collected yet.";
  }

  function render(next) {
    segments = next;
    columns = columnsFor(segments);
    options(elements.character, [...new Set(segments.map((s) => s.character))].sort(), "All characters");
    options(elements.day, [...new Set(segments.map((s) => s.day))].sort().reverse(), "All days");
    draw();
  }

  ["search", "character", "day"].forEach((key) => elements[key].addEventListener("input", draw));

  return { render };
}
