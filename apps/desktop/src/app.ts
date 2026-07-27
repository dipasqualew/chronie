/**
 * The window: three views over one loaded dashboard.
 *
 * Timeline is what happened, Details is every row of it, Setup is the plumbing. All three
 * read the same `SEGMENTS` array, and every write goes through the backend and comes back
 * as a whole dashboard — so what is on screen is always what was stored, never what the
 * page hoped a write did.
 */

import { desktop, message } from "./bridge";
import { activityFields, activityLabel, fieldValue, parseMetadata } from "./activities";
import type { ActivityField } from "./activities";
import { buildSessions } from "./sessions";
import { createAchievementBook } from "./achievements";
import { createDetails } from "./details";
import { createSegmentModal } from "./segmentModal";
import { createTimeline } from "./timeline";
import { createTransmog } from "./transmog";
import { createTransmogModal } from "./transmogModal";
import { duration, escapeHtml, plural } from "./format";
import { installExternalLinks } from "./links";
import type { ActivityMetadata, DashboardPayload, Segment } from "./types";
import { installTooltip } from "./ui";
import { createWifiSync } from "./wifi";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The window is missing #${id}.`);
  return element as T;
};

const PAYLOAD = await desktop.dashboard();
const SEGMENTS: Segment[] = PAYLOAD.segments || [];
// Kinds the backend can guess at, plus any the user has already invented, so the editor's
// picker offers what this history actually contains rather than only what the app ships with.
const KNOWN_KINDS = [...new Set([
  ...(PAYLOAD.knownActivityKinds || []),
  ...SEGMENTS.flatMap((segment) => (segment.activities || []).map((entry) => entry.kind)),
])].sort();

installTooltip();
// Every link the window draws is a link out of it, and the window is the wrong place for a
// web page. A url the backend will not open is a dead link on screen, so it is worth saying.
installExternalLinks({
  root: document,
  open: desktop.openUrl,
  onFailure: (url, error) => console.error(`Chronie could not open ${url}: ${message(error)}`),
});

/* ---------- the three views ---------- */

// What the game says about an achievement outlives any one segment, so the book is made
// once here rather than per modal: a reader walking a history meets the same achievements
// over and over, and each is looked up the first time and never again.
const achievements = createAchievementBook({
  load: (ids) => desktop.achievementDetails(ids),
  loadIcons: (iconFileDataIds) => desktop.gameIcons(iconFileDataIds),
});

const modal = createSegmentModal({
  dialog: $<HTMLDialogElement>("segment-detail"),
  onEditActivities: (segmentId) => openEditor(segmentId),
  achievements,
});

const timeline = createTimeline({
  host: $("timeline"),
  onOpenSegment: (segmentId, order) => modal.open(segmentId, order),
});

const details = createDetails({
  elements: {
    head: $("head"), rows: $("rows"), empty: $("empty"), count: $("count"),
    search: $<HTMLInputElement>("search"),
    character: $<HTMLSelectElement>("character"),
    day: $<HTMLSelectElement>("day"),
  },
  onOpenSegment: (segmentId, order) => modal.open(segmentId, order),
});

const transmogDetail = createTransmogModal({
  dialog: $<HTMLDialogElement>("transmog-detail"),
  load: (setId) => desktop.transmogSetItems(setId),
  loadIcons: (iconFileDataIds) => desktop.gameIcons(iconFileDataIds),
  loadModel: (displayInfoId) => desktop.transmogModel(displayInfoId),
  loadCharacter: () => desktop.characterModel(),
  loadWorn: (displayInfoId, displayType) => desktop.wornModel(displayInfoId, displayType),
});

const transmog = createTransmog({
  elements: {
    meta: $("transmog-meta"),
    search: $<HTMLInputElement>("transmog-search"),
    expansion: $<HTMLSelectElement>("transmog-expansion"),
    klass: $<HTMLSelectElement>("transmog-class"),
    list: $("transmog-list"),
    empty: $("transmog-empty"),
    count: $("transmog-count"),
  },
  onOpenSet: (set) => transmogDetail.open(set),
});

// The sets come out of the game's own files, which costs a second and a few hundred
// megabytes to read, so the view asks for them the first time it is opened and keeps them.
let transmogLoad: Promise<void> | null = null;

function loadTransmog(): void {
  if (transmogLoad) return;
  transmog.status("Reading the game's transmog tables…");
  transmogLoad = desktop.transmogSets()
    .then((payload) => transmog.render(payload))
    .catch((error) => {
      transmogLoad = null;
      transmog.status(message(error));
    });
}

/** Redraws every view from `SEGMENTS`, including a detail modal left open over the top. */
function repaint(): void {
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

const VIEWS = ["timeline", "details", "transmog", "setup"] as const;

function show(view: string): void {
  for (const name of VIEWS) {
    $(`${name}-view`).hidden = name !== view;
    const tab = $(`${name}-tab`);
    tab.classList.toggle("primary", name === view);
    tab.setAttribute("aria-current", name === view ? "page" : "false");
  }
  if (view === "transmog") loadTransmog();
}

VIEWS.forEach((name) => $(`${name}-tab`).addEventListener("click", () => show(name)));

/* ---------- editing a segment's activities ---------- */

interface EditorRow {
  /** Keys the row's markup. A row the user has just added carries a negative draft id. */
  rowId: number;
  /** Absent until the row has been stored, which is what tells an add from an update. */
  id?: number;
  kind: string;
  metadata: ActivityMetadata;
  dirty: boolean;
}

interface EditorState {
  segmentId: number;
  rows: EditorRow[];
}

// Rows are keyed by activity id; a row the user has just added has none yet, so it carries a
// negative draft id until it is saved. That is what lets the same rendering code draw a row
// that exists in the database and one that does not.
let editing: EditorState | null = null;
let draftSequence = 0;

/** The segment the editor is open on; nothing below is reachable with the dialog closed. */
function editor(): EditorState {
  if (!editing) throw new Error("No segment is being edited.");
  return editing;
}

const editorDialog = $<HTMLDialogElement>("activity-editor");
const editorStatus = $("activity-editor-status");

const segmentById = (segmentId: number): Segment | undefined =>
  SEGMENTS.find((segment) => segment.segmentId === segmentId);

function kindOptions(selected: string): string {
  const values = [...new Set([...KNOWN_KINDS, selected].filter(Boolean))].sort();
  return values.map((kind) =>
    `<option value="${escapeHtml(kind)}"${kind === selected ? " selected" : ""}>` +
    `${escapeHtml(activityLabel(kind))}</option>`).join("");
}

// The label sits beside its control rather than wrapping it: a wrapping label takes its
// accessible name from its whole text content, which for a select would swallow every
// option ("Beat the timer UnknownYesNo") and leave the field unaddressable by its name.
function fieldInput(row: EditorRow, field: ActivityField): string {
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

function drawEditor(): void {
  const state = editor();
  const segment = segmentById(state.segmentId);
  if (!segment) return;
  $("activity-editor-title").textContent = `Activities — ${segment.instance}`;
  $("activity-editor-sub").textContent =
    `${segment.character} · ${segment.day} · ${duration(segment.seconds)}`;

  $("activity-editor-list").innerHTML = state.rows.map((row) => `
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

  $("activity-editor-list").querySelectorAll<HTMLElement>(".editor-row").forEach((element) => {
    const row = state.rows.find((entry) => String(entry.rowId) === element.dataset.row);
    if (!row) return;
    // Changing the kind swaps the whole field set, so the values typed so far are captured
    // before the redraw; anything the new kind also has survives the switch.
    element.querySelector<HTMLSelectElement>('[data-role="kind"]')?.addEventListener("change", (event) => {
      row.metadata = collectRow(element, row.kind);
      row.kind = (event.target as HTMLSelectElement).value;
      row.dirty = true;
      drawEditor();
    });
    element.querySelector<HTMLButtonElement>('[data-role="remove"]')
      ?.addEventListener("click", () => removeRow(row));
    element.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
      input.addEventListener("input", () => { row.dirty = true; });
      input.addEventListener("change", () => { row.dirty = true; });
    });
  });
}

function collectRow(element: Element, kind: string): ActivityMetadata {
  const values: Record<string, string> = {};
  element.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
    const key = input.dataset.field;
    if (key !== undefined) values[key] = input.value;
  });
  return parseMetadata(kind, values);
}

/** Saves every row the user actually touched, then repaints from what came back. */
async function saveRows(): Promise<void> {
  const state = editor();
  for (const row of state.rows) {
    if (!row.dirty) continue;
    const element = $("activity-editor-list").querySelector(`[data-row="${row.rowId}"]`);
    const metadata = element ? collectRow(element, row.kind) : row.metadata || {};
    const payload = row.id === undefined
      ? await desktop.addActivity(state.segmentId, row.kind, metadata)
      : await desktop.updateActivity(row.id, row.kind, metadata);
    applyDashboard(payload);
  }
}

async function runEdit(action: () => Promise<void>): Promise<void> {
  editorStatus.textContent = "";
  try {
    await action();
    loadRows();
    drawEditor();
  } catch (error) {
    editorStatus.textContent = message(error);
  }
}

function removeRow(row: EditorRow): void {
  const state = editor();
  // A draft the user added and changed their mind about was never stored, so it is simply
  // forgotten; anything else has to be deleted where it lives.
  if (row.id === undefined) {
    state.rows = state.rows.filter((entry) => entry !== row);
    drawEditor();
    return;
  }
  const activityId = row.id;
  void runEdit(async () => applyDashboard(await desktop.deleteActivity(activityId)));
}

/** Folds a fresh dashboard onto the segments already on screen and repaints what changed. */
function applyDashboard(payload: DashboardPayload): void {
  const byId = new Map((payload.segments || []).map((segment) => [segment.segmentId, segment]));
  SEGMENTS.forEach((segment) => {
    const next = byId.get(segment.segmentId);
    if (next) segment.activities = next.activities || [];
  });
  repaint();
}

function loadRows(): void {
  const state = editor();
  const segment = segmentById(state.segmentId);
  state.rows = (segment?.activities || []).map((activity) => ({
    rowId: activity.id,
    id: activity.id,
    kind: activity.kind,
    metadata: activity.metadata || {},
    dirty: false,
  }));
}

function openEditor(segmentId: number): void {
  editing = { segmentId, rows: [] };
  loadRows();
  editorStatus.textContent = "";
  drawEditor();
  editorDialog.showModal();
}

$("activity-add").addEventListener("click", () => {
  draftSequence -= 1;
  editor().rows.push({
    rowId: draftSequence,
    kind: KNOWN_KINDS[0] || "mythic_plus",
    metadata: {},
    dirty: true,
  });
  drawEditor();
});

$("activity-reset").addEventListener("click", () =>
  void runEdit(async () => applyDashboard(await desktop.resetActivities(editor().segmentId))));

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
$<HTMLInputElement>("wow-path").value = settings.wowPath || "";
$("last-sync").textContent = settings.lastSync
  ? `Last background sync: ${new Date(settings.lastSync).toLocaleString()}`
  : "No successful sync yet.";

async function run<T>(
  button: HTMLButtonElement,
  action: () => Promise<T>,
  success: (result: T) => string,
): Promise<T | undefined> {
  button.disabled = true;
  $("setup-status").textContent = "";
  try {
    const result = await action();
    $("setup-status").textContent = success(result);
    return result;
  } catch (error) {
    $("setup-status").textContent = message(error);
    return undefined;
  } finally {
    button.disabled = false;
  }
}

const pressed = (event: Event): HTMLButtonElement => event.currentTarget as HTMLButtonElement;

$("browse-path").addEventListener("click", async () => {
  const selected = await desktop.chooseWowPath();
  if (selected) $<HTMLInputElement>("wow-path").value = selected;
});
$("save-path").addEventListener("click", (event) =>
  void run(pressed(event), () => desktop.saveWowPath($<HTMLInputElement>("wow-path").value.trim()),
    () => "Game folder saved."));
$("sync-now").addEventListener("click", async (event) => {
  const result = await run(pressed(event), desktop.syncNow,
    (sync) => `Sync complete: ${sync.segmentCount} segments, ${sync.added} new.`);
  if (result && !globalThis.__Chronie_E2E__) setTimeout(() => window.location.reload(), 800);
});
$("install-addon").addEventListener("click", (event) =>
  void run(pressed(event), desktop.installAddon,
    (result) => `Addon ${result.version} installed. Use /reload in game to load it.`));
$("check-update").addEventListener("click", (event) =>
  void run(pressed(event), desktop.checkForAppUpdate,
    (result) => result.updated ? `Chronie ${result.version} is ready; restart to finish.` : "Chronie is up to date."));

/* ---------- moving the history between machines ---------- */

const wifi = createWifiSync({
  elements: {
    find: $<HTMLButtonElement>("wifi-find"),
    peers: $("wifi-peers"),
    address: $<HTMLInputElement>("wifi-address"),
    send: $<HTMLButtonElement>("wifi-send"),
    sendStatus: $("wifi-send-status"),
    wait: $<HTMLButtonElement>("wifi-wait"),
    receiveStatus: $("wifi-receive-status"),
    offer: $("wifi-offer"),
    offerText: $("wifi-offer-text"),
    accept: $<HTMLButtonElement>("wifi-accept"),
    decline: $<HTMLButtonElement>("wifi-decline"),
  },
  actions: {
    discover: desktop.wifiDiscover,
    send: desktop.wifiSend,
    startWaiting: desktop.wifiReceiveStart,
    stopWaiting: desktop.wifiReceiveStop,
    status: desktop.wifiReceiveStatus,
    answer: desktop.wifiAnswerOffer,
    // Every view on screen is of a history that has just been replaced, and folding a whole
    // new database into the page in flight is not worth inventing — the window starts again
    // from what is now stored.
    onReplaced: () => {
      if (!globalThis.__Chronie_E2E__) setTimeout(() => window.location.reload(), 1200);
    },
    onError: message,
  },
});

/* ---------- go ---------- */

repaint();
// Nothing can be collected until the game folder is known, so a first run opens on the one
// screen that can do anything about it rather than on an empty timeline.
show(settings.wowPath ? "timeline" : "setup");
await wifi.refresh();
wifi.watch(() => !$("setup-view").hidden);

if (!globalThis.__Chronie_E2E__) {
  const segmentSignature = JSON.stringify(SEGMENTS.map((segment) => [segment.id, segment.endedAt]));
  setInterval(async () => {
    const next = await desktop.dashboard();
    const nextSignature = JSON.stringify((next.segments || []).map((segment) => [segment.id, segment.endedAt]));
    if (nextSignature !== segmentSignature) window.location.reload();
  }, 30_000);
}
