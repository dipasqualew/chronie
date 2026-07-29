/**
 * The retention section of Settings: a switch, a number of days, and the files that would go.
 *
 * The list is the point. Deleting a combat log is the one thing Chronie does that cannot be
 * undone, and the first sweep on a machine that has been logging for a year could take the
 * year — so what would go is on screen, by name and by size, *before* the switch is thrown
 * rather than in a summary afterwards. Turning it on is then a thing somebody agreed to.
 *
 * Nothing is deleted from here. The switch records a setting; the sweep happens on the next
 * sync, immediately after the read that decides what is eligible.
 *
 * The wording lives in `retention.ts`.
 */

import "./retentionPanel.css";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { MAX_DAYS, MIN_DAYS, pileFiles, sweepDetail, sweepSentence, windowDays } from "./retention";
import type { LogRetention } from "./types";

export interface RetentionActions {
  /** What a sweep would do, asked for whenever this panel is on screen. */
  status: () => Promise<LogRetention>;
  /** Sets the window, or turns the sweeper off with `null`. Answers with the state that leaves. */
  set: (days: number | null) => Promise<LogRetention>;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

export interface RetentionPanelProps {
  actions: RetentionActions;
  /** The window from the saved settings, or null for off. What the controls show until the
   * backend has answered — and the ask fails outright until a game folder is chosen. */
  days: number | null;
  /** Whether anybody is looking. */
  visible: boolean;
}

/** How often the panel asks again. Slow: a folder does not change between two blinks, and the
 * answer costs a directory listing plus a query. */
const POLL_MS = 15000;

export function RetentionPanel({ actions, days, visible }: RetentionPanelProps): ReactNode {
  const [status, setStatus] = useState<LogRetention | null>(null);
  const [saying, setSaying] = useState("");
  const [busy, setBusy] = useState(false);
  /** What the number box shows, which is somebody's half-typed number until they commit it. */
  const [typed, setTyped] = useState(String(days ?? 7));
  /** Set while a write is on its way. The poll's answer is the older of the two. */
  const writing = useRef(false);

  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      if (writing.current) return;
      try {
        const answer = await actions.status();
        if (alive && !writing.current) {
          setStatus(answer);
          setSaying("");
        }
      } catch (error) {
        if (alive) setSaying(actions.onError(error));
      }
    };
    void refresh();
    if (!visible)
      return () => {
        alive = false;
      };
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [actions, visible]);

  function change(wanted: number | null): void {
    writing.current = true;
    setBusy(true);
    setStatus((was) => (was ? { ...was, enabled: wanted !== null } : was));
    void actions
      .set(wanted)
      .then((answer) => {
        setStatus(answer);
        setTyped(String(answer.days));
        setSaying("");
      })
      .catch((error: unknown) => {
        setStatus((was) => (was ? { ...was, enabled: wanted === null } : was));
        setSaying(actions.onError(error));
      })
      .finally(() => {
        writing.current = false;
        setBusy(false);
      });
  }

  const enabled = status ? status.enabled : days !== null;
  const lines = status ? sweepDetail(status) : [];
  // With the sweeper off these are the files turning it on would take, and with it on they are
  // the files the next sync takes. Either way they are named, because a number nobody can
  // check is not a thing anybody can agree to.
  const doomed = status ? pileFiles(status.doomed) : [];
  // And these are the ones Chronie will not take at any window. Named for the opposite reason:
  // clearing them is the reader's job, and they cannot do it without knowing which they are.
  const unread = status ? pileFiles(status.unread) : [];

  return (
    <section className="panel setup" aria-labelledby="log-retention-heading">
      <h2 id="log-retention-heading">Deleting old combat logs</h2>
      <p className="sub">
        Chronie can delete a combat log once it has read the whole of it and it is older than the
        window below. It <strong>never</strong> deletes one it has not finished reading, and never
        the file the game is writing to — so a log from before Chronie was watching stays where it
        is, and is listed here instead.
      </p>
      <label className="check">
        <input
          id="log-retention"
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => change(event.target.checked ? windowDays(Number(typed)) : null)}
        />
        Delete combat logs Chronie has finished reading
      </label>
      <div className="setup-grid">
        <label htmlFor="retain-days">
          Keep logs for
          <span className="path-row">
            {/* Named explicitly, because the label around it also carries the unit and the
                control is "keep logs for", not "keep logs for days". */}
            <input
              id="retain-days"
              type="number"
              aria-label="Keep logs for"
              min={MIN_DAYS}
              max={MAX_DAYS}
              value={typed}
              disabled={busy || !enabled}
              onChange={(event) => setTyped(event.target.value)}
              onBlur={() => {
                if (enabled) change(windowDays(Number(typed)));
              }}
            />
            <span className="sub">days</span>
          </span>
        </label>
      </div>
      {/* The stylesheet colours this from `data-state`: what is about to be deleted does not
          get to look like a success. */}
      <p
        id="log-retention-state"
        className="status"
        role="status"
        data-state={status && status.doomed.count > 0 ? "stale" : undefined}
      >
        {saying || (status ? sweepSentence(status) : "")}
      </p>
      {doomed.length > 0 && (
        <div id="log-retention-doomed" className="sub">
          <div>{enabled ? "Going on the next sync:" : "Would go on the next sync:"}</div>
          {doomed.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      <div id="log-retention-detail" className="sub">
        {lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      {unread.length > 0 && (
        <div id="log-retention-unread" className="sub">
          <div>Never deleted by Chronie:</div>
          {unread.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
    </section>
  );
}
