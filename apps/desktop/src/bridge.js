import { invoke } from "@tauri-apps/api/core";

const mock = globalThis.__WDP_E2E__;

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
  installAddon: () => mock ? Promise.resolve(mock.installResult) : invoke("install_addon"),
  checkForAppUpdate: () => mock ? Promise.resolve(mock.appUpdate) : invoke("check_for_app_update"),
};

export function message(error) {
  return error instanceof Error ? error.message : String(error);
}
