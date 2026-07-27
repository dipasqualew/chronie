/**
 * Setup: the plumbing. Where the game is, what Chronie should do about it, and the two
 * panels that are features in their own right.
 *
 * Every button here reports what happened in the one status line beneath them, because every
 * one of them reaches outside the window — the filesystem, the addon folder, an update
 * server — and a button that silently succeeded or silently failed is the same button.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import { CombatLogPanel } from "./combatLogPanel";
import type { CombatLogActions } from "./combatLogPanel";
import { WifiPanel } from "./wifiPanel";
import type { WifiActions } from "./wifiPanel";
import type { AppUpdateResult, InstallResult, Settings, SyncResult } from "./types";

export interface SetupActions {
  choosePath: () => Promise<string | null>;
  savePath: (wowPath: string) => Promise<Settings>;
  syncNow: () => Promise<SyncResult>;
  installAddon: () => Promise<InstallResult>;
  checkForAppUpdate: () => Promise<AppUpdateResult>;
  /** Called after a sync that changed something, because every view is now out of date. */
  onSynced: () => void;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

export interface SetupProps {
  settings: Settings;
  actions: SetupActions;
  combatLog: CombatLogActions;
  wifi: WifiActions;
  /** Whether Setup is the view on screen, which is what the two panels poll on. */
  visible: boolean;
}

export function Setup(
  { settings, actions, combatLog, wifi, visible }: SetupProps,
): ReactNode {
  const [path, setPath] = useState(settings.wowPath || "");
  const [saying, setSaying] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function run<T>(
    name: string, action: () => Promise<T>, success: (result: T) => string,
  ): Promise<T | undefined> {
    setBusy(name);
    setSaying("");
    try {
      const result = await action();
      setSaying(success(result));
      return result;
    } catch (error) {
      setSaying(actions.onError(error));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  return <>
    <header className="view-head">
      <h1>Setup</h1>
      <div className="sub">Choose the game’s <strong>_retail_</strong> folder. Chronie syncs
        segments and manages the addon from there.</div>
    </header>
    <div className="panel setup">
      <div className="setup-grid">
        <label htmlFor="wow-path">Game folder
          <span className="path-row">
            <input
              id="wow-path" type="text" value={path}
              placeholder="C:\Program Files (x86)\World of Warcraft\_retail_"
              onChange={(event) => setPath(event.target.value)}
            />
            <button
              type="button" disabled={busy === "browse"}
              onClick={() => void (async () => {
                setBusy("browse");
                const chosen = await actions.choosePath().finally(() => setBusy(null));
                if (chosen) setPath(chosen);
              })()}
            >Browse…</button>
          </span>
        </label>
        <button
          type="button" className="primary" disabled={busy === "save"}
          onClick={() => void run("save", () => actions.savePath(path.trim()),
            () => "Game folder saved.")}
        >Save</button>
      </div>
      <div className="actions">
        <button
          type="button" disabled={busy === "sync"}
          onClick={() => void run("sync", actions.syncNow,
            (sync) => `Sync complete: ${sync.segmentCount} segments, ${sync.added} new.`)
            .then((result) => { if (result) actions.onSynced(); })}
        >Sync now</button>
        <button
          type="button" disabled={busy === "install"}
          onClick={() => void run("install", actions.installAddon,
            (result) => `Addon ${result.version} installed. Use /reload in game to load it.`)}
        >Install or update addon</button>
        <button
          type="button" disabled={busy === "update"}
          onClick={() => void run("update", actions.checkForAppUpdate, (result) => result.updated
            ? `Chronie ${result.version} is ready; restart to finish.`
            : "Chronie is up to date.")}
        >Check for app update</button>
      </div>
      <p id="setup-status" className="status" role="status">{saying}</p>
      <p className="sub">Chronie installs its own addon every time it starts, so the two are
        never out of step. The button above only does it again now, without waiting for a
        restart.</p>
      <p id="last-sync" className="sub">
        {settings.lastSync
          ? `Last background sync: ${new Date(settings.lastSync).toLocaleString()}`
          : "No successful sync yet."}
      </p>
    </div>

    <CombatLogPanel
      actions={combatLog} requested={settings.combatLogging === true} visible={visible}
    />
    <WifiPanel actions={wifi} visible={visible} />
  </>;
}
