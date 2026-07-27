/**
 * The combat logging section of Setup: a switch, and an honest answer about what the game
 * is really doing.
 *
 * The switch is off until somebody deliberately turns it on, and the copy beside it says
 * what turning it on costs before they do — a raid night is hundreds of megabytes and
 * nothing in Chronie deletes an old log yet, so the number is the reader's to carry.
 *
 * Everything below the switch is reporting rather than promising. The backend has looked at
 * the game's own config and at the files in its `Logs/` folder; this states what it found,
 * including the two ways of being not-quite-on that are easy to mistake for working:
 * logging without the advanced flag, which produces a log with no positions in it, and a
 * setting that says yes over a folder nothing has been written to in days.
 */

import { ago, escapeHtml, fileSize } from "./format";
import type { CombatLogStatus } from "./types";

export interface CombatLogElements {
  toggle: HTMLInputElement;
  state: HTMLElement;
  detail: HTMLElement;
}

export interface CombatLogActions {
  /** What the install is doing, asked for on a timer while the panel is open. */
  status: () => Promise<CombatLogStatus>;
  /** Turns Chronie's setting on or off, and answers with the state that leaves. */
  set: (enabled: boolean) => Promise<CombatLogStatus>;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

/** Where the box a player has to tick themselves lives, named the way the game names it. */
const NETWORK_OPTIONS = "Advanced Combat Logging, in the game's Options › Network";

/**
 * The one line that says where this install stands.
 *
 * Four states, and the two unhappy ones are kept apart on purpose: `basic` is a box nobody
 * has ticked, `stale` is a log nobody is writing. Telling a player to go tick a box that is
 * already ticked is how a tool teaches people to stop reading it.
 */
export function stateSentence(status: CombatLogStatus, now?: number): string {
  switch (status.state) {
    case "off":
      return status.growing
        ? "Chronie is not asking for combat logging — though this install is writing a " +
          "combat log anyway, which somebody turned on outside Chronie."
        : "Combat logging is off. Nothing is being written and nothing is using disk.";
    case "basic":
      return status.advanced === null || status.advanced === undefined
        ? "Combat logging is on, but Chronie could not read the game's settings, so it " +
          `cannot confirm advanced logging. Check ${NETWORK_OPTIONS}.`
        : "Combat logging is on, but advanced combat logging is off — the log will have no " +
          `positions in it. Tick ${NETWORK_OPTIONS}, then log in again.`;
    case "advanced":
      return "Advanced combat logging is on, and the game is writing to it.";
    case "stale": {
      if (!status.log) {
        return "Advanced combat logging is set up, but this install has no combat log at " +
          "all yet. One appears the next time you log in.";
      }
      // A file this machine will not date is a file nothing can be said about the age of.
      // Reckoning from the epoch would put "20659 days ago" on screen, which is worse than
      // admitting the gap.
      const when = status.log.modified
        ? `nothing has been written ${ago(status.log.modified, now)}`
        : "this machine will not say when the log was last written";
      return `Advanced combat logging is set up, but ${when}. Expected while the game is ` +
        "closed; if you have been playing since, the game is not logging.";
    }
  }
}

/**
 * The evidence the sentence above was reached from, so a reader can disagree with it.
 *
 * Deliberately concrete — the file, its size, when it was last touched, and which config
 * the CVar was read out of. A status line nobody can check is a status line nobody should
 * believe.
 */
export function evidence(status: CombatLogStatus, now?: number): string[] {
  const lines: string[] = [];
  if (status.log) {
    const when = status.log.modified
      ? `last written ${ago(status.log.modified, now)}`
      : "with no date this machine will report";
    lines.push(`Newest log: ${status.log.name} — ${fileSize(status.log.bytes)}, ${when}.`);
  } else {
    lines.push("No combat log found in the game's Logs folder.");
  }
  if (status.source) {
    const reads = status.advanced ? "on" : "off";
    lines.push(`Advanced logging reads ${reads} in ${status.source}.`);
  } else {
    lines.push("No game config could be read, so the advanced setting is unknown.");
  }
  return lines;
}

export function createCombatLogging(options: {
  elements: CombatLogElements;
  actions: CombatLogActions;
}): { render: (status: CombatLogStatus) => void; refresh: () => Promise<void>;
  watch: (visible: () => boolean) => void } {
  const { elements, actions } = options;
  /** Set while a write is on its way to the backend. See `refresh`. */
  let writing = false;

  function render(status: CombatLogStatus): void {
    elements.toggle.checked = status.requested;
    elements.state.textContent = stateSentence(status);
    elements.state.dataset.state = status.state;
    elements.detail.innerHTML = evidence(status)
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join("");
  }

  async function refresh(): Promise<void> {
    // Never over the top of a switch somebody has just thrown. The poll and the write are
    // both in flight for a moment, and the poll's answer is the older of the two — drawing it
    // would flick the box back to where it was until the write landed.
    if (writing) return;
    try {
      const status = await actions.status();
      if (!writing) render(status);
    } catch (error) {
      elements.state.textContent = actions.onError(error);
    }
  }

  elements.toggle.addEventListener("change", () => {
    const wanted = elements.toggle.checked;
    elements.toggle.disabled = true;
    writing = true;
    // Said before the await, because turning this on reinstalls the addon and the game will
    // not read it until the next login — a switch that silently does nothing for an hour is
    // the thing this panel exists to prevent.
    elements.state.textContent = wanted
      ? "Turning combat logging on. It starts at your next login or /reload."
      : "Turning combat logging off. It stops at your next login or /reload.";
    void actions.set(wanted)
      .then(render)
      .catch((error: unknown) => {
        // Back to what it was: the setting did not change, so neither should the switch.
        elements.toggle.checked = !wanted;
        elements.state.textContent = actions.onError(error);
      })
      .finally(() => {
        elements.toggle.disabled = false;
        writing = false;
      });
  });

  return {
    render,
    refresh,
    /**
     * Asks again while somebody is looking at the answer.
     *
     * Slower than the WiFi panel's poll because nothing here is waiting on a person at
     * another machine: the question is whether a file grew, and the backend only learns that
     * by comparing two looks a while apart anyway.
     */
    watch(visible: () => boolean): void {
      setInterval(() => {
        if (visible()) void refresh();
      }, 5000);
    },
  };
}
