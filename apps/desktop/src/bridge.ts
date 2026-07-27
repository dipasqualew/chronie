import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  AchievementDetail,
  AchievementDetailsPayload,
  Activity,
  ActivityMetadata,
  AppUpdateResult,
  DashboardPayload,
  IconsPayload,
  InstallResult,
  Segment,
  Settings,
  SyncResult,
  TransmogModelPayload,
  TransmogPayload,
  TransmogSetItemsPayload,
  WifiPeer,
  WifiReceipt,
  WifiReceiveStatus,
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
  // One appearance's model, asked for when a reader picks that row and not before: a set's
  // worth of geometry is tens of megabytes nobody has clicked on. Most rows have none, and
  // `null` is what says so.
  transmogModel: (displayInfoId: number): Promise<TransmogModelPayload> => mock
    ? Promise.resolve({ displayInfoId, model: mock.transmogModels[displayInfoId] ?? null })
    : invoke<TransmogModelPayload>("transmog_model", { displayInfoId }),
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
