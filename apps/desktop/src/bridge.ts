import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { wornSetKey } from "./modelPreview";

import type {
  AchievementDetail,
  AchievementDetailsPayload,
  Activity,
  ActivityMetadata,
  AppUpdateResult,
  Capture,
  CaptureImagePayload,
  CaptureThumbnailsPayload,
  CharacterModelPayload,
  CombatLogStatus,
  DashboardPayload,
  IconsPayload,
  InstallResult,
  LogRetention,
  Segment,
  Settings,
  SyncResult,
  TransmogPayload,
  TransmogSetItemsPayload,
  WifiPeer,
  WifiReceipt,
  WifiReceiveStatus,
  WornPiece,
  WornSetPayload,
} from "./types";

const mock = globalThis.__Chronie_E2E__;

/** Picks the segment an edit belongs to. */
type Locate = (segment: Segment) => boolean;

/** Applies the edit to that segment's activity list, given the next free activity id. */
type Apply = (activities: Activity[], nextId: number) => void;

export const desktop = {
  dashboard: (): Promise<DashboardPayload> =>
    mock ? Promise.resolve(structuredClone(mock.dashboard)) : invoke<DashboardPayload>("dashboard"),
  // Reading the game's own tables takes about a second and a couple of hundred megabytes
  // of transient memory, so the window asks only when the view is first opened.
  transmogSets: (): Promise<TransmogPayload> =>
    mock ? Promise.resolve(structuredClone(mock.transmog)) : invoke<TransmogPayload>("transmog_sets"),
  // Opening a set walks four more of the game's tables, so it is asked for per set rather
  // than loaded with the grid — a wardrobe's worth of joins nobody has clicked on is waste.
  transmogSetItems: (setId: number): Promise<TransmogSetItemsPayload> => mock
    ? Promise.resolve(structuredClone(mock.transmogItems[setId] ?? emptySet(setId)))
    : invoke<TransmogSetItemsPayload>("transmog_set_items", { setId }),
  // What the game says about a list of achievements the segments named. The backend keeps
  // every one it has looked up, so a reader walking a history of them pays for each once.
  achievementDetails: (ids: number[]): Promise<AchievementDetailsPayload> => mock
    ? Promise.resolve({ achievements: mockAchievements(ids) })
    : invoke<AchievementDetailsPayload>("achievement_details", { ids }),
  // The pictures a list of rows needs, asked for once the rows are drawn. The backend keeps
  // every texture it has decoded, so this is answered from memory for everything a
  // neighbouring set or an earlier segment already showed.
  gameIcons: (iconFileDataIds: number[]): Promise<IconsPayload> => mock
    ? Promise.resolve({ icons: mockIcons(iconFileDataIds) })
    : invoke<IconsPayload>("game_icons", { iconFileDataIds }),
  // The body every appearance is worn on. One model for the whole app, so the window asks the
  // first time a set is opened and keeps it for every set after.
  characterModel: (): Promise<CharacterModelPayload> => mock
    ? Promise.resolve({ model: mock.characterModel })
    : invoke<CharacterModelPayload>("character_model"),
  // The same body wearing a set of clothes, which is how every slot is shown. A list rather
  // than one appearance because two of the three subsystems behind character rendering exist
  // to arbitrate between pieces — which of two owns a contested geoset group, and which of two
  // textures painting the same rectangle goes on top — and neither can be asked one piece at a
  // time. Each piece carries the slot, which says which geoset groups it drives and where it
  // sits in the stack, and where the item is worn, which says which hand a weapon is in.
  wornSet: (pieces: WornPiece[]): Promise<WornSetPayload> => mock
    ? Promise.resolve({ model: mock.wornSets[wornSetKey(pieces)] ?? null })
    : invoke<WornSetPayload>("worn_set", { pieces }),
  // Links leave the app entirely: the backend asks the operating system to open them, which
  // is the only way a page in a Tauri window reaches the reader's browser.
  openUrl: (url: string): Promise<void> => {
    if (mock) {
      mock.openedUrls.push(url);
      return Promise.resolve();
    }
    return openUrl(url);
  },
  settings: (): Promise<Settings> =>
    mock ? Promise.resolve(structuredClone(mock.settings)) : invoke<Settings>("settings"),
  chooseWowPath: (): Promise<string | null> =>
    mock ? Promise.resolve(mock.chosenPath) : invoke<string | null>("choose_wow_path"),
  saveWowPath: (wowPath: string): Promise<Settings> => {
    if (mock) {
      mock.settings.wowPath = wowPath;
      return Promise.resolve(mock.settings);
    }
    return invoke<Settings>("save_wow_path", { wowPath });
  },
  syncNow: (): Promise<SyncResult> =>
    mock ? Promise.resolve(mock.syncResult) : invoke<SyncResult>("sync_now"),
  // What the install is really doing about combat logs — read from the game's own config and
  // its Logs folder, not from the setting, which is why it is worth asking repeatedly.
  combatLogging: (): Promise<CombatLogStatus> =>
    mock ? Promise.resolve(structuredClone(mock.combatLog)) : invoke<CombatLogStatus>("combat_logging"),
  // Answers with the state the change leaves behind rather than an acknowledgement, so the
  // panel repaints from what the install now says. The mock advances its own state the way
  // the backend does: the setting moves, and nothing about the game's config moves with it.
  setCombatLogging: (enabled: boolean): Promise<CombatLogStatus> => {
    if (mock) {
      mock.settings.combatLogging = enabled;
      mock.combatLog.requested = enabled;
      mock.combatLog.state = mockCombatLogState(mock.combatLog);
      return Promise.resolve(structuredClone(mock.combatLog));
    }
    return invoke<CombatLogStatus>("set_combat_logging", { enabled });
  },
  // What a sweep of the game's Logs folder would delete, what it will not touch, and what it
  // already has. Asked for rather than assumed, because all three change under the app.
  logRetention: (): Promise<LogRetention> =>
    mock ? Promise.resolve(structuredClone(mock.logRetention)) : invoke<LogRetention>("log_retention"),
  // `null` turns the sweeper off. Nothing is deleted by this call: it records a setting, and
  // the sweep happens on the next sync. The mock moves the same two facts the backend does —
  // whether it is on, and at what window — and leaves the piles where they are, because what
  // is in the folder does not change just because somebody ticked a box.
  setLogRetention: (days: number | null): Promise<LogRetention> => {
    if (mock) {
      mock.settings.retainLogDays = days;
      mock.logRetention.enabled = days !== null;
      if (days !== null) mock.logRetention.days = days;
      return Promise.resolve(structuredClone(mock.logRetention));
    }
    return invoke<LogRetention>("set_log_retention", { days });
  },
  // Every activity command answers with the whole dashboard, so the window repaints from
  // what was actually stored rather than from what the page hoped the write did. Under the
  // e2e mock the same shape is produced by editing the mock's dashboard in place.
  addActivity: (segmentId: number, kind: string, metadata: ActivityMetadata): Promise<DashboardPayload> => mock
    ? Promise.resolve(mockEdit(bySegment(segmentId), (activities, nextId) => {
      dropInferred(activities, kind);
      activities.push({ id: nextId, kind, source: "manual", confidence: 1, metadata });
    }))
    : invoke<DashboardPayload>("add_activity", { segmentId, kind, metadata }),
  updateActivity: (activityId: number, kind: string, metadata: ActivityMetadata): Promise<DashboardPayload> => mock
    ? Promise.resolve(mockEdit(byActivity(activityId), (activities) => {
      const found = activities.find((entry) => entry.id === activityId);
      if (found) Object.assign(found, { kind, source: "manual", confidence: 1, metadata });
    }))
    : invoke<DashboardPayload>("update_activity", { activityId, kind, metadata }),
  deleteActivity: (activityId: number): Promise<DashboardPayload> => mock
    ? Promise.resolve(mockEdit(byActivity(activityId), (activities) => {
      const at = activities.findIndex((entry) => entry.id === activityId);
      if (at >= 0) activities.splice(at, 1);
    }))
    : invoke<DashboardPayload>("delete_activity", { activityId }),
  resetActivities: (segmentId: number): Promise<DashboardPayload> => mock
    ? Promise.resolve(mockEdit(bySegment(segmentId), (activities) => activities.splice(0)))
    : invoke<DashboardPayload>("reset_activities", { segmentId }),
  // The two ways a capture changes, answering with the whole dashboard the way the activity
  // edits do — so a note that looked saved and was not cannot happen. The mock edits its own
  // stored dashboard, which is the same "write, then repaint from storage" flow.
  setCaptureNote: (captureId: number, note: string): Promise<DashboardPayload> => mock
    ? Promise.resolve(mockCaptureEdit(captureId, (captures, at) => {
      const found = captures[at];
      // The backend cleans a note by the addon's own rules; the mock does the half of that a
      // test can tell apart from a working field — trimming, and no note at all for nothing.
      if (found) found.note = note.trim() || null;
    }))
    : invoke<DashboardPayload>("set_capture_note", { captureId, note }),
  deleteCapture: (captureId: number): Promise<DashboardPayload> => mock
    ? Promise.resolve(mockCaptureEdit(captureId, (captures, at) => {
      captures.splice(at, 1);
      if (mock) delete mock.captureImages[captureId];
    }))
    : invoke<DashboardPayload>("delete_capture", { captureId }),
  // The pictures a grid needs, asked for once the tiles are drawn. Answered from a cache on
  // disk after the first look at an evening, which is why asking for a whole grid is cheap.
  captureThumbnails: (captureIds: number[]): Promise<CaptureThumbnailsPayload> => mock
    ? Promise.resolve({ thumbnails: mockThumbnails(captureIds) })
    : invoke<CaptureThumbnailsPayload>("capture_thumbnails", { captureIds }),
  // One capture at the size it was taken, which is a few megabytes and is therefore asked for
  // only when somebody opens it.
  captureImage: (captureId: number): Promise<CaptureImagePayload> => {
    if (mock) {
      const held = mock.captureImages[captureId];
      return Promise.resolve(held
        ? { id: captureId, image: held.full, byteSize: held.byteSize }
        : { id: captureId, image: null });
    }
    return invoke<CaptureImagePayload>("capture_image", { captureId });
  },
  installAddon: (): Promise<InstallResult> =>
    mock ? Promise.resolve(mock.installResult) : invoke<InstallResult>("install_addon"),
  checkForAppUpdate: (): Promise<AppUpdateResult> =>
    mock ? Promise.resolve(mock.appUpdate) : invoke<AppUpdateResult>("check_for_app_update"),
  // Only the Chronies on this network that are waiting for a database answer, so this is a
  // short list and every entry in it can be sent to.
  wifiDiscover: (): Promise<WifiPeer[]> =>
    mock ? Promise.resolve(structuredClone(mock.wifi.peers)) : invoke<WifiPeer[]>("wifi_discover"),
  // Waits on somebody at the other machine reading an offer and answering it, so this call
  // is measured in minutes rather than milliseconds.
  wifiSend: (address: string): Promise<WifiReceipt> => {
    if (mock) {
      mock.wifi.sentTo.push(address);
      return Promise.resolve(structuredClone(mock.wifi.receipt));
    }
    return invoke<WifiReceipt>("wifi_send", { address });
  },
  wifiReceiveStart: (): Promise<WifiReceiveStatus> => mock
    ? Promise.resolve(mockReceive((status) => {
      status.listening = true;
      status.outcome = null;
      // The fixture's sender is already knocking, which is what a test needs to reach the
      // one screen in this feature that matters.
      status.offer = mock.wifi.incoming ? structuredClone(mock.wifi.incoming) : null;
    }))
    : invoke<WifiReceiveStatus>("wifi_receive_start"),
  wifiReceiveStop: (): Promise<WifiReceiveStatus> => mock
    ? Promise.resolve(mockReceive((status) => {
      status.listening = false;
      status.offer = null;
      status.addresses = [];
    }))
    : invoke<WifiReceiveStatus>("wifi_receive_stop"),
  wifiReceiveStatus: (): Promise<WifiReceiveStatus> =>
    mock ? Promise.resolve(mockReceive(() => {})) : invoke<WifiReceiveStatus>("wifi_receive_status"),
  wifiAnswerOffer: (accepted: boolean): Promise<WifiReceiveStatus> => mock
    ? Promise.resolve(mockReceive((status) => {
      const waiting = status.offer;
      if (!waiting) throw new Error("There is no database waiting to be accepted.");
      status.offer = null;
      status.outcome = accepted
        ? {
          stored: true,
          message: `Replaced this history with ${waiting.offer.device}'s: ` +
            `${waiting.offer.segmentCount} segments across ${waiting.offer.characterCount} characters.`,
        }
        : { stored: false, message: `Turned down the database from ${waiting.offer.device}.` };
    }))
    : invoke<WifiReceiveStatus>("wifi_answer_offer", { accepted }),
};

/**
 * Which state the mock's install is in once the setting has moved, mirroring the rule in
 * `combatlog::status`: the setting decides only whether anything was asked for, and the
 * game's own config and log files decide the rest.
 */
function mockCombatLogState(status: CombatLogStatus): CombatLogStatus["state"] {
  if (!status.requested) return "off";
  if (status.advanced !== true) return "basic";
  return status.growing ? "advanced" : "stale";
}

/**
 * Advances the e2e mock's receiving half and hands back a fresh copy, the way the real
 * station answers every call with its whole state.
 */
function mockReceive(advance: (status: WifiReceiveStatus) => void): WifiReceiveStatus {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  advance(mock.wifi.status);
  return structuredClone(mock.wifi.status);
}

/** A set the e2e mock says nothing about, which the real backend would answer for. */
const emptySet = (setId: number): TransmogSetItemsPayload =>
  ({ setId, appearances: [], readCount: 0, withheldCount: 0 });

/**
 * The icons the e2e mock holds among those asked for.
 *
 * An id it holds nothing for is left out rather than answered with an empty string, which is
 * what the real backend does for a texture the install cannot show.
 */
function mockIcons(wanted: number[]): Record<string, string> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, string> = {};
  for (const id of wanted) {
    const url = mock.gameIcons[id];
    if (url) found[String(id)] = url;
  }
  return found;
}

/** The achievements the e2e mock can describe among those asked for, keyed the same way. */
function mockAchievements(wanted: number[]): Record<string, AchievementDetail> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, AchievementDetail> = {};
  for (const id of wanted) {
    const detail = mock.achievementDetails[id];
    if (detail) found[String(id)] = detail;
  }
  return found;
}

/** The thumbnails the e2e mock holds among those asked for, keyed the way icons are. */
function mockThumbnails(wanted: number[]): Record<string, string> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, string> = {};
  for (const id of wanted) {
    const held = mock.captureImages[id];
    if (held) found[String(id)] = held.thumbnail;
  }
  return found;
}

/**
 * Applies an edit to the capture with a given id wherever it sits in the mock's dashboard, and
 * hands back a fresh copy — the same flow `mockEdit` gives the activity commands.
 */
function mockCaptureEdit(
  captureId: number,
  apply: (captures: Capture[], at: number) => void,
): DashboardPayload {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  for (const segment of mock.dashboard.segments || []) {
    const at = (segment.captures || []).findIndex((capture) => capture.id === captureId);
    if (at >= 0) apply(segment.captures ?? [], at);
  }
  return structuredClone(mock.dashboard);
}

/** Drops the guess for a kind the user has just taken over, mirroring the backend's rule. */
function dropInferred(activities: Activity[], kind: string): void {
  const at = activities.findIndex((entry) => entry.kind === kind && entry.source === "inferred");
  if (at >= 0) activities.splice(at, 1);
}

const bySegment = (segmentId: number): Locate => (segment) => segment.segmentId === segmentId;
const byActivity = (activityId: number): Locate => (segment) =>
  (segment.activities || []).some((entry) => entry.id === activityId);

/**
 * Applies an edit to the e2e mock's stored dashboard and hands back a fresh copy, so the
 * page under test sees the same "write, then repaint from storage" flow the real app gets
 * from the backend. `locate` picks the segment the edit belongs to.
 */
function mockEdit(locate: Locate, apply: Apply): DashboardPayload {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const segments = mock.dashboard.segments || [];
  for (const segment of segments) segment.activities ??= [];
  const nextId = 1 + Math.max(0, ...segments.flatMap((segment) =>
    (segment.activities || []).map((entry) => entry.id || 0)));
  const target = segments.find(locate);
  if (target) apply(target.activities ??= [], nextId);
  return structuredClone(mock.dashboard);
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
