/**
 * The combat logging section of Settings: a switch, and an honest answer about what the game is
 * really doing.
 *
 * The switch is off until somebody deliberately turns it on, and the copy beside it says what
 * turning it on costs before they do — a raid night is hundreds of megabytes, and Chronie only
 * clears them up once the panel below this one has been told it may.
 *
 * Everything below the switch is reporting rather than promising, and `combatLog.ts` is where
 * the wording lives.
 */

import "./combatLogPanel.css";

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

import { evidence, stateSentence } from "./combatLog";
import { usePoll } from "./resource";
import type { StillWanted } from "./resource";
import type { CombatLogStatus } from "./types";

export interface CombatLogActions {
  /** What the install is doing, asked for on a timer while the panel is open. */
  status: () => Promise<CombatLogStatus>;
  /** Turns Chronie's setting on or off, and answers with the state that leaves. */
  set: (enabled: boolean) => Promise<CombatLogStatus>;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

export interface CombatLogPanelProps {
  actions: CombatLogActions;
  /**
   * What Chronie was told to do, from the saved settings. It is what the switch shows until
   * the install has been asked — and the ask fails outright until a game folder is chosen, so
   * on a first run this is the only thing the switch has to go on.
   */
  requested: boolean;
  /** Whether anybody is looking. The panel only asks again while somebody could act on it. */
  visible: boolean;
}

/** How often the panel asks again. Slower than the WiFi poll: nobody is waiting on a person
 * at another machine, and the backend only learns whether a file grew by looking twice. */
const POLL_MS = 5000;

export function CombatLogPanel({ actions, requested, visible }: CombatLogPanelProps): ReactNode {
  const [status, setStatus] = useState<CombatLogStatus | null>(null);
  const [saying, setSaying] = useState("");
  const [busy, setBusy] = useState(false);
  /** Set while a write is on its way to the backend. See the poll below. */
  const writing = useRef(false);

  // Never over the top of a switch somebody has just thrown. The poll and the write are both
  // in flight for a moment, and the poll's answer is the older of the two — drawing it would
  // flick the box back to where it was until the write landed.
  //
  // `live` is the other guard, and it is the poll's rather than this panel's: it says whether
  // the ask that is now answering is one the poll still wants — see `resource.ts`.
  const refresh = useCallback(
    async (live: StillWanted): Promise<void> => {
      if (writing.current) return;
      try {
        const answer = await actions.status();
        if (live() && !writing.current) {
          setStatus(answer);
          setSaying("");
        }
      } catch (error) {
        if (live()) setSaying(actions.onError(error));
      }
    },
    [actions],
  );
  usePoll(refresh, { active: visible, every: POLL_MS });

  function change(wanted: boolean): void {
    writing.current = true;
    setBusy(true);
    // Said before the await, because turning this on reinstalls the addon and the game will
    // not read it until the next login — a switch that silently does nothing for an hour is
    // the thing this panel exists to prevent.
    setSaying(
      wanted
        ? "Turning combat logging on. It starts at your next login or /reload."
        : "Turning combat logging off. It stops at your next login or /reload.",
    );
    setStatus((was) => (was ? { ...was, requested: wanted } : was));
    void actions
      .set(wanted)
      .then((answer) => {
        setStatus(answer);
        setSaying("");
      })
      .catch((error: unknown) => {
        // Back to what it was: the setting did not change, so neither should the switch.
        setStatus((was) => (was ? { ...was, requested: !wanted } : was));
        setSaying(actions.onError(error));
      })
      .finally(() => {
        writing.current = false;
        setBusy(false);
      });
  }

  const checked = status ? status.requested : requested;
  const lines = status ? evidence(status) : [];

  // A landmark rather than a plain panel, so the section a reader is being asked to make a
  // decision in is one they can reach and address by its name.
  return (
    <section className="panel setup" aria-labelledby="combat-log-heading">
      <h2 id="combat-log-heading">Combat logging</h2>
      <p className="sub">
        The game can write every combat event to a file, with the positions Chronie needs to say
        where something happened. It is off unless you turn it on here, because it is not cheap:{" "}
        <strong>a raid night is hundreds of megabytes</strong>. Chronie deletes nothing out of the
        game&apos;s <strong>Logs</strong> folder unless the panel below this one is turned on as
        well.
      </p>
      <label className="check">
        <input
          id="combat-logging"
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(event) => change(event.target.checked)}
        />
        Start combat logging when I log in
      </label>
      {/* The stylesheet colours this line from `data-state`, and only from that — a sentence
          that reads as a problem in the colour of a success is what it exists to prevent. */}
      <p id="combat-log-state" className="status" role="status" data-state={status?.state}>
        {saying || (status ? stateSentence(status) : "")}
      </p>
      <div id="combat-log-detail" className="sub">
        {lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    </section>
  );
}
