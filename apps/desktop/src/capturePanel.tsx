/**
 * The screenshots section of Settings: what takes a picture by itself, and what is kept of it.
 *
 * Two halves that are written to two different places and are separated on screen for that
 * reason. The rules reach the *game* — they are compiled into the addon's `Settings.lua` and
 * only take effect at the next login or `/reload` — while the quality and the originals are
 * things the desktop app does to files it finds, and take effect on the next sync. A panel that
 * mixed them would leave somebody wondering why half of it needed a reload.
 *
 * Every control writes as it is clicked and repaints from the settings the backend answers
 * with, the same rule the rest of the app follows: what is on screen is what was stored.
 *
 * The wording and the catalogues live in `captureSettings.ts`.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import {
  CAPTURE_QUALITIES, DEFAULT_QUALITY, STORAGE_APPLIES, TRIGGER_GROUPS,
  originalsSentence, supersededBy, toggleTrigger, triggerSentence, unknownTriggers,
} from "./captureSettings";
import type { CaptureQuality, Settings } from "./types";

export interface CaptureActions {
  /** Records which rules photograph a moment, and reinstalls the addon so the game gets them. */
  setTriggers: (triggers: string[]) => Promise<Settings>;
  /** Records what is kept of a picture, and whether the game keeps its own copy. */
  setStorage: (quality: CaptureQuality, keepOriginals: boolean) => Promise<Settings>;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

export interface CapturePanelProps {
  actions: CaptureActions;
  /** The settings as they were loaded, which is what the controls start from. */
  settings: Settings;
}

export function CapturePanel({ actions, settings }: CapturePanelProps): ReactNode {
  // Held here rather than read off the prop, because every write answers with the whole of the
  // settings and this is where that answer lands. The prop is the opening position only.
  const [chosen, setChosen] = useState<string[]>(settings.captureTriggers ?? []);
  const [quality, setQuality] = useState<CaptureQuality>(settings.captureQuality ?? DEFAULT_QUALITY);
  const [keeping, setKeeping] = useState(settings.keepOriginalScreenshots === true);
  const [saying, setSaying] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Runs one write and folds whatever came back over the controls.
   *
   * The optimistic move happens first so a checkbox does not lag a click, and the answer
   * replaces it rather than confirming it — so a setting the backend refused or adjusted shows
   * as what was actually stored rather than as what was asked for.
   */
  function save(write: () => Promise<Settings>): void {
    setBusy(true);
    setSaying("");
    void write()
      .then((stored) => {
        setChosen(stored.captureTriggers ?? []);
        setQuality(stored.captureQuality ?? DEFAULT_QUALITY);
        setKeeping(stored.keepOriginalScreenshots === true);
      })
      .catch((error: unknown) => setSaying(actions.onError(error)))
      .finally(() => setBusy(false));
  }

  function toggle(name: string, on: boolean): void {
    const wanted = toggleTrigger(chosen, name, on);
    setChosen(wanted);
    save(() => actions.setTriggers(wanted));
  }

  function storage(nextQuality: CaptureQuality, nextKeeping: boolean): void {
    setQuality(nextQuality);
    setKeeping(nextKeeping);
    save(() => actions.setStorage(nextQuality, nextKeeping));
  }

  // Names in the stored list this build has no box for — a hand-edited settings file, or an
  // addon newer than this window. Shown rather than silently carried, because they are doing
  // something and there is nothing on screen that would otherwise account for it.
  const unknown = unknownTriggers(chosen);

  return (
    <section className="panel setup" aria-labelledby="captures-heading">
      <h2 id="captures-heading">Screenshots</h2>
      <p className="sub">Chronie can press the game’s own screenshot key when something worth
        remembering happens, then take custody of the file: it copies the picture into its own
        store, proves the copy, and files it against the segment it was taken in.</p>

      <h3 className="setup-subhead">What photographs itself</h3>
      <p className="sub">
        These reach the addon, so a change takes effect at the next login or <code>/reload</code>.
        Whatever is ticked, no more than one automatic screenshot is taken a minute — a raid
        clear is one photograph, not thirty.
      </p>

      {TRIGGER_GROUPS.map((group) => (
        <div className="capture-group" key={group.title}>
          <h4>{group.title}</h4>
          {group.triggers.map((trigger) => {
            const covered = supersededBy(trigger, chosen);
            return (
              <label className="capture-choice" key={trigger.name}>
                <input
                  type="checkbox" disabled={busy}
                  checked={chosen.includes(trigger.name)}
                  onChange={(event) => toggle(trigger.name, event.target.checked)}
                />
                <span>
                  {trigger.label}
                  <span className="sub">{trigger.detail}</span>
                  {/* The addon offers a moment to the narrow rule first and the broad one
                      second, so a broad rule already covers this one. Saying so beats leaving
                      a ticked box that changes nothing. */}
                  {covered && (
                    <span className="sub capture-covered">
                      Already covered by “{covered.label}”.
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      ))}

      <p id="capture-triggers-state" className="status" role="status">
        {saying || triggerSentence(chosen)}
      </p>
      {unknown.length > 0 && (
        <p id="capture-triggers-unknown" className="sub">
          Also set, and not a rule this version knows: {unknown.join(", ")}. It is left alone.
        </p>
      )}

      <h3 className="setup-subhead">What Chronie keeps</h3>
      <p className="sub">{STORAGE_APPLIES}</p>

      <fieldset className="capture-quality">
        <legend>Stored size</legend>
        {CAPTURE_QUALITIES.map((choice) => (
          <label className="capture-choice" key={choice.value}>
            <input
              type="radio" name="capture-quality" value={choice.value} disabled={busy}
              checked={quality === choice.value}
              onChange={() => storage(choice.value, keeping)}
            />
            <span>
              {choice.label}
              <span className="sub">{choice.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="check">
        <input
          id="keep-originals" type="checkbox" disabled={busy} checked={keeping}
          onChange={(event) => storage(quality, event.target.checked)}
        />
        Leave the game’s own copy where it is
      </label>
      <p id="capture-storage-state" className="sub">{originalsSentence(keeping)}</p>
    </section>
  );
}
