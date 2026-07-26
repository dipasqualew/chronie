import { invoke } from "@tauri-apps/api/core";

const mock = globalThis.__Chronie_E2E__;

export const desktop = {
  dashboard: () => mock ? Promise.resolve(structuredClone(mock.dashboard)) : invoke("dashboard"),
  settings: () => mock ? Promise.resolve(structuredClone(mock.settings)) : invoke("settings"),
  chooseWowPath: () => mock ? Promise.resolve(mock.chosenPath) : invoke("choose_wow_path"),
  saveWowPath: (wowPath) => {
    if (mock) {
      mock.settings.wowPath = wowPath;
      return Promise.resolve(mock.settings);
    }
    return invoke("save_wow_path", { wowPath });
  },
  syncNow: () => mock ? Promise.resolve(mock.syncResult) : invoke("sync_now"),
  // Every activity command answers with the whole dashboard, so the window repaints from
  // what was actually stored rather than from what the page hoped the write did. Under the
  // e2e mock the same shape is produced by editing the mock's dashboard in place.
  addActivity: (segmentId, kind, metadata) => mock
    ? Promise.resolve(mockEdit(bySegment(segmentId), (activities, nextId) => {
      dropInferred(activities, kind);
      activities.push({ id: nextId, kind, source: "manual", confidence: 1, metadata });
    }))
    : invoke("add_activity", { segmentId, kind, metadata }),
  updateActivity: (activityId, kind, metadata) => mock
    ? Promise.resolve(mockEdit(byActivity(activityId), (activities) => {
      const found = activities.find((entry) => entry.id === activityId);
      if (found) Object.assign(found, { kind, source: "manual", confidence: 1, metadata });
    }))
    : invoke("update_activity", { activityId, kind, metadata }),
  deleteActivity: (activityId) => mock
    ? Promise.resolve(mockEdit(byActivity(activityId), (activities) => {
      const at = activities.findIndex((entry) => entry.id === activityId);
      if (at >= 0) activities.splice(at, 1);
    }))
    : invoke("delete_activity", { activityId }),
  resetActivities: (segmentId) => mock
    ? Promise.resolve(mockEdit(bySegment(segmentId), (activities) => activities.splice(0)))
    : invoke("reset_activities", { segmentId }),
  installAddon: () => mock ? Promise.resolve(mock.installResult) : invoke("install_addon"),
  checkForAppUpdate: () => mock ? Promise.resolve(mock.appUpdate) : invoke("check_for_app_update"),
};

/** Drops the guess for a kind the user has just taken over, mirroring the backend's rule. */
function dropInferred(activities, kind) {
  const at = activities.findIndex((entry) => entry.kind === kind && entry.source === "inferred");
  if (at >= 0) activities.splice(at, 1);
}

const bySegment = (segmentId) => (segment) => segment.segmentId === segmentId;
const byActivity = (activityId) => (segment) =>
  segment.activities.some((entry) => entry.id === activityId);

/**
 * Applies an edit to the e2e mock's stored dashboard and hands back a fresh copy, so the
 * page under test sees the same "write, then repaint from storage" flow the real app gets
 * from the backend. `locate` picks the segment the edit belongs to.
 */
function mockEdit(locate, apply) {
  const segments = mock.dashboard.segments || [];
  for (const segment of segments) segment.activities = segment.activities || [];
  const nextId = 1 + Math.max(0, ...segments.flatMap((segment) =>
    segment.activities.map((entry) => entry.id || 0)));
  const target = segments.find(locate);
  if (target) apply(target.activities, nextId);
  return structuredClone(mock.dashboard);
}

export function message(error) {
  return error instanceof Error ? error.message : String(error);
}
