/**
 * Settings: everything Chronie has been told to do, in four categories.
 *
 * This was one scrolling page called Setup, and it stopped working as one the moment there
 * were four unrelated decisions on it — where the game is, what photographs itself, what to do
 * with combat logs, and moving the history between machines. So it is a rail and a pane: the
 * categories are on the left, one of them is on screen, and each is a decision somebody came
 * here to make rather than a section they scrolled past on the way to another.
 *
 * A category is hidden rather than unmounted when the reader is in another, for the same reason
 * the app's own views are: the WiFi panel is in the middle of a transfer, the retention panel
 * has a half-typed number in it, and neither survives being rebuilt. What *is* passed down is
 * whether anybody is looking, because three of the panels poll the backend and there is no
 * reason to do that for a category nobody is on.
 *
 * The game folder stays first and stays the one with the status line under it, because every
 * button in it reaches outside the window — the filesystem, the addon folder, an update server
 * — and a button that silently succeeded or silently failed is the same button.
 */

import "./settings.css";

import { useState } from "react";
import type { ReactNode } from "react";

import { CapturePanel } from "./capturePanel";
import type { CaptureActions } from "./capturePanel";
import { CombatLogPanel } from "./combatLogPanel";
import type { CombatLogActions } from "./combatLogPanel";
import { RetentionPanel } from "./retentionPanel";
import type { RetentionActions } from "./retentionPanel";
import { WifiPanel } from "./wifiPanel";
import type { WifiActions } from "./wifiPanel";
import type { AppUpdateResult, InstallResult, Settings as Stored, SyncResult } from "./types";

export interface SettingsActions {
  choosePath: () => Promise<string | null>;
  savePath: (wowPath: string) => Promise<Stored>;
  syncNow: () => Promise<SyncResult>;
  installAddon: () => Promise<InstallResult>;
  checkForAppUpdate: () => Promise<AppUpdateResult>;
  /** Called after a sync that changed something, because every view is now out of date. */
  onSynced: () => void;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

export interface SettingsProps {
  settings: Stored;
  actions: SettingsActions;
  captures: CaptureActions;
  combatLog: CombatLogActions;
  retention: RetentionActions;
  wifi: WifiActions;
  /** Whether Settings is the view on screen, which is what the panels poll on. */
  visible: boolean;
}

const CATEGORIES = [
  { id: "game", label: "Game and sync" },
  { id: "screenshots", label: "Screenshots" },
  { id: "logs", label: "Combat logs" },
  { id: "network", label: "Move this history" },
] as const;

type Category = typeof CATEGORIES[number]["id"];

export function Settings(
  { settings, actions, captures, combatLog, retention, wifi, visible }: SettingsProps,
): ReactNode {
  const [category, setCategory] = useState<Category>("game");
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

  /** Whether a given category is the one on screen, which is what its panels poll on. */
  const showing = (which: Category): boolean => visible && category === which;

  return <>
    <header className="view-head">
      <h1>Settings</h1>
      <div className="sub">Where the game is, what Chronie records of it, and what it is
        allowed to delete.</div>
    </header>

    <div className="settings-layout">
      <nav className="settings-rail" aria-label="Settings categories">
        {CATEGORIES.map((entry) => (
          <button
            key={entry.id} type="button" id={`${entry.id}-category`}
            aria-current={entry.id === category ? "true" : "false"}
            onClick={() => setCategory(entry.id)}
          >{entry.label}</button>
        ))}
      </nav>

      <div className="settings-sections">
        <section
          className="panel setup" hidden={category !== "game"}
          aria-labelledby="game-folder-heading"
        >
          <h2 id="game-folder-heading">Game and sync</h2>
          <p className="sub">Choose the game’s <strong>_retail_</strong> folder. Chronie syncs
            segments and manages the addon from there.</p>
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
        </section>

        <div hidden={category !== "screenshots"}>
          <CapturePanel actions={captures} settings={settings} />
        </div>

        <div className="settings-sections" hidden={category !== "logs"}>
          <CombatLogPanel
            actions={combatLog} requested={settings.combatLogging === true}
            visible={showing("logs")}
          />
          <RetentionPanel
            actions={retention} days={settings.retainLogDays ?? null}
            visible={showing("logs")}
          />
        </div>

        <div hidden={category !== "network"}>
          <WifiPanel actions={wifi} visible={showing("network")} />
        </div>
      </div>
    </div>
  </>;
}
