/**
 * The window: three views over one loaded dashboard.
 *
 * Timeline is what happened, Details is every row of it, Setup is the plumbing. All three
 * read the same `SEGMENTS` array, and every write goes through the backend and comes back
 * as a whole dashboard — so what is on screen is always what was stored, never what the
 * page hoped a write did.
 */

import { desktop, message } from "./bridge.js";
import { activityFields, activityLabel, fieldValue, parseMetadata } from "./activities.js";
import { buildSessions } from "./sessions.js";
import { createDetails } from "./details.js";
import { createSegmentModal } from "./segmentModal.js";
import { createTimeline } from "./timeline.js";
import { duration, escapeHtml, plural } from "./format.js";
import { installTooltip } from "./ui.js";

const $ = (id) => document.getElementById(id);

const PAYLOAD = await desktop.dashboard();
const SEGMENTS = PAYLOAD.segments || [];
// Kinds the backend can guess at, plus any the user has already invented, so the editor's
// picker offers what this history actually contains rather than only what the app ships with.
const KNOWN_KINDS = [...new Set([
  ...(PAYLOAD.knownActivityKinds || []),
  ...SEGMENTS.flatMap((segment) => (segment.activities || []).map((entry) => entry.kind)),
])].sort();

installTooltip();

/* ---------- the three views ---------- */

const modal = createSegmentModal({
  dialog: $("segment-detail"),
  onEditActivities: (segmentId) => openEditor(segmentId),
});

const timeline = createTimeline({
  host: $("timeline"),
  onOpenSegment: (segmentId, order) => modal.open(segmentId, order),
});

const details = createDetails({
  elements: {
    head: $("head"), rows: $("rows"), empty: $("empty"), count: $("count"),
    search: $("search"), character: $("character"), day: $("day"),
  },
  onOpenSegment: (segmentId, order) => modal.open(segmentId, order),
});

/** Redraws every view from `SEGMENTS`, including a detail modal left open over the top. */
function repaint() {
  const sessions = buildSessions(SEGMENTS);
  $("timeline-meta").textContent = SEGMENTS.length
    ? [
      plural(sessions.length, "play session"),
      plural(SEGMENTS.length, "segment"),
      plural(new Set(SEGMENTS.map((segment) => segment.character)).size, "character"),
      `${duration(SEGMENTS.reduce((total, segment) => total + (segment.seconds || 0), 0))} played`,
    ].join(" · ")
    : "Nothing collected yet.";
  timeline.render(sessions);
  details.render(SEGMENTS);
  modal.refresh(SEGMENTS);
}

const VIEWS = ["timeline", "details", "setup"];

function show(view) {
  for (const name of VIEWS) {
    $(`${name}-view`).hidden = name !== view;
    const tab = $(`${name}-tab`);
    tab.classList.toggle("primary", name === view);
    tab.setAttribute("aria-current", name === view ? "page" : "false");
  }
}

VIEWS.forEach((name) => $(`${name}-tab`).addEventListener("click", () => show(name)));

/* ---------- editing a segment's activities ---------- */

// Rows are keyed by activity id; a row the user has just added has none yet, so it carries a
// negative draft id until it is saved. That is what lets the same rendering code draw a row
// that exists in the database and one that does not.
let editing = null;
let draftSequence = 0;

const editorDialog = $("activity-editor");
const editorStatus = $("activity-editor-status");

const segmentById = (segmentId) => SEGMENTS.find((segment) => segment.segmentId === segmentId);

function kindOptions(selected) {
  const values = [...new Set([...KNOWN_KINDS, selected].filter(Boolean))].sort();
  return values.map((kind) =>
    `<option value="${escapeHtml(kind)}"${kind === selected ? " selected" : ""}>` +
    `${escapeHtml(activityLabel(kind))}</option>`).join("");
}

// The label sits beside its control rather than wrapping it: a wrapping label takes its
// accessible name from its whole text content, which for a select would swallow every
// option ("Beat the timer UnknownYesNo") and leave the field unaddressable by its name.
function fieldInput(row, field) {
  const value = fieldValue(row, field);
  const id = `field-${row.rowId}-${field.key}`;
  const control = field.type === "boolean"
    ? `<select id="${id}" data-field="${escapeHtml(field.key)}">
        <option value=""${value === "" ? " selected" : ""}>Unknown</option>
        <option value="yes"${value === "yes" ? " selected" : ""}>Yes</option>
        <option value="no"${value === "no" ? " selected" : ""}>No</option>
      </select>`
    : `<input id="${id}" data-field="${escapeHtml(field.key)}"
        type="${field.type === "number" ? "number" : "text"}"
        value="${escapeHtml(value)}">`;
  return `<div class="field">
    <label for="${id}">${escapeHtml(field.label)}</label>${control}
  </div>`;
}

function drawEditor() {
  const segment = segmentById(editing.segmentId);
  $("activity-editor-title").textContent = `Activities — ${segment.instance}`;
  $("activity-editor-sub").textContent =
    `${segment.character} · ${segment.day} · ${duration(segment.seconds)}`;

  $("activity-editor-list").innerHTML = editing.rows.map((row) => `
    <div class="editor-row" data-row="${row.rowId}">
      <div class="row-head">
        <select data-role="kind" aria-label="Activity kind">${kindOptions(row.kind)}</select>
        <button type="button" data-role="remove"
          aria-label="Remove ${escapeHtml(activityLabel(row.kind))}">Remove</button>
      </div>
      <div class="editor-fields">
        ${activityFields(row.kind).map((field) => fieldInput(row, field)).join("") ||
          '<span class="muted">Chronie has no fields for this kind; it will be saved by name.</span>'}
      </div>
    </div>`).join("") || '<div class="muted">No activities on this segment yet.</div>';

  $("activity-editor-list").querySelectorAll(".editor-row").forEach((element) => {
    const row = editing.rows.find((entry) => String(entry.rowId) === element.dataset.row);
    // Changing the kind swaps the whole field set, so the values typed so far are captured
    // before the redraw; anything the new kind also has survives the switch.
    element.querySelector('[data-role="kind"]').addEventListener("change", (event) => {
      row.metadata = collectRow(element, row.kind);
      row.kind = event.target.value;
      row.dirty = true;
      drawEditor();
    });
    element.querySelector('[data-role="remove"]').addEventListener("click", () => removeRow(row));
    element.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => { row.dirty = true; });
      input.addEventListener("change", () => { row.dirty = true; });
    });
  });
}

function collectRow(element, kind) {
  const values = {};
  element.querySelectorAll("[data-field]").forEach((input) => {
    values[input.dataset.field] = input.value;
  });
  return parseMetadata(kind, values);
}

/** Saves every row the user actually touched, then repaints from what came back. */
async function saveRows() {
  for (const row of editing.rows) {
    if (!row.dirty) continue;
    const element = $("activity-editor-list").querySelector(`[data-row="${row.rowId}"]`);
    const metadata = element ? collectRow(element, row.kind) : row.metadata || {};
    const payload = row.id === undefined
      ? await desktop.addActivity(editing.segmentId, row.kind, metadata)
      : await desktop.updateActivity(row.id, row.kind, metadata);
    applyDashboard(payload);
  }
}

async function runEdit(action) {
  editorStatus.textContent = "";
  try {
    await action();
    loadRows();
    drawEditor();
  } catch (error) {
    editorStatus.textContent = message(error);
  }
}

function removeRow(row) {
  // A draft the user added and changed their mind about was never stored, so it is simply
  // forgotten; anything else has to be deleted where it lives.
  if (row.id === undefined) {
    editing.rows = editing.rows.filter((entry) => entry !== row);
    drawEditor();
    return;
  }
  runEdit(async () => applyDashboard(await desktop.deleteActivity(row.id)));
}

/** Folds a fresh dashboard onto the segments already on screen and repaints what changed. */
function applyDashboard(payload) {
  const byId = new Map((payload.segments || []).map((segment) => [segment.segmentId, segment]));
  SEGMENTS.forEach((segment) => {
    const next = byId.get(segment.segmentId);
    if (next) segment.activities = next.activities || [];
  });
  repaint();
}

function loadRows() {
  const segment = segmentById(editing.segmentId) || {};
  editing.rows = (segment.activities || []).map((activity) => ({
    rowId: activity.id,
    id: activity.id,
    kind: activity.kind,
    metadata: activity.metadata || {},
    dirty: false,
  }));
}

function openEditor(segmentId) {
  editing = { segmentId, rows: [] };
  loadRows();
  editorStatus.textContent = "";
  drawEditor();
  editorDialog.showModal();
}

$("activity-add").addEventListener("click", () => {
  draftSequence -= 1;
  editing.rows.push({
    rowId: draftSequence,
    kind: KNOWN_KINDS[0] || "mythic_plus",
    metadata: {},
    dirty: true,
  });
  drawEditor();
});

$("activity-reset").addEventListener("click", () =>
  runEdit(async () => applyDashboard(await desktop.resetActivities(editing.segmentId))));

$("activity-close").addEventListener("click", async () => {
  editorStatus.textContent = "";
  try {
    await saveRows();
    editorDialog.close();
  } catch (error) {
    editorStatus.textContent = message(error);
  }
});

/* ---------- setup ---------- */

const settings = await desktop.settings();
$("wow-path").value = settings.wowPath || "";
$("last-sync").textContent = settings.lastSync
  ? `Last background sync: ${new Date(settings.lastSync).toLocaleString()}`
  : "No successful sync yet.";

async function run(button, action, success) {
  button.disabled = true;
  $("setup-status").textContent = "";
  try {
    const result = await action();
    $("setup-status").textContent = success(result);
    return result;
  } catch (error) {
    $("setup-status").textContent = message(error);
  } finally {
    button.disabled = false;
  }
}

$("browse-path").addEventListener("click", async () => {
  const selected = await desktop.chooseWowPath();
  if (selected) $("wow-path").value = selected;
});
$("save-path").addEventListener("click", (event) =>
  run(event.currentTarget, () => desktop.saveWowPath($("wow-path").value.trim()), () => "Game folder saved."));
$("sync-now").addEventListener("click", async (event) => {
  const result = await run(event.currentTarget, desktop.syncNow,
    (sync) => `Sync complete: ${sync.segmentCount} segments, ${sync.added} new.`);
  if (result && !globalThis.__Chronie_E2E__) setTimeout(() => window.location.reload(), 800);
});
$("install-addon").addEventListener("click", (event) =>
  run(event.currentTarget, desktop.installAddon,
    (result) => `Addon ${result.version} installed. Use /reload in game to load it.`));
$("check-update").addEventListener("click", (event) =>
  run(event.currentTarget, desktop.checkForAppUpdate,
    (result) => result.updated ? `Chronie ${result.version} is ready; restart to finish.` : "Chronie is up to date."));

/* ---------- go ---------- */

repaint();
// Nothing can be collected until the game folder is known, so a first run opens on the one
// screen that can do anything about it rather than on an empty timeline.
show(settings.wowPath ? "timeline" : "setup");

if (!globalThis.__Chronie_E2E__) {
  const segmentSignature = JSON.stringify(SEGMENTS.map((segment) => [segment.id, segment.endedAt]));
  setInterval(async () => {
    const next = await desktop.dashboard();
    const nextSignature = JSON.stringify((next.segments || []).map((segment) => [segment.id, segment.endedAt]));
    if (nextSignature !== segmentSignature) window.location.reload();
  }, 30_000);
}
