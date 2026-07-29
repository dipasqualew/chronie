/**
 * Something the window has to go and ask for, with the whole of its life in one place.
 *
 * Eight places in this app had grown the same eleven lines: a piece of `useState` holding
 * `null`, an effect that asks for it the first time somebody looks, a second piece of state
 * holding either the word "loading" or the sentence a failure came back with, and a guard
 * spelled differently every time — `if (view !== "transmog" || transmog)`, `let alive = true`,
 * `if (mine === asked.current)`. They disagreed. Some forgot the guard, so a slow answer landing
 * after the reader had gone somewhere else wrote it onto the screen anyway; some remembered it
 * for the value and forgot it for the failure; none of them could be asked to try again.
 *
 * There are two shapes here because the app asks for two kinds of thing.
 *
 * [`useAsyncResource`] is for what cannot change under a running window: the game's own tables,
 * the schema of a database, a file in the bundle. Asked for once, kept, and — this is the part
 * a hand-written effect never got right — **asked for once even when React sets the effect up,
 * tears it down and sets it up again**, which is what development Strict Mode does to every
 * effect in the app to prove its cleanup is real. The request lives in a ref keyed by what it
 * was for, so the second setup finds the first one's promise and waits on it rather than
 * sending another.
 *
 * [`usePoll`] is for what does change: what the game is writing to its log folder right now,
 * whether the machine at the other end of the WiFi has accepted. A poll is *meant* to repeat,
 * so nothing here pretends a second ask is a mistake; what it promises is the other half — the
 * interval never outlives the component or the reason for asking, and no answer is applied
 * after the asking has stopped.
 *
 * Neither of them knows what it is asking for. Everything domain-specific — which command, what
 * a cache is keyed by, when an answer is worth keeping — stays with the view that asks.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Where a resource has got to. */
export type ResourceState = "idle" | "loading" | "ready" | "failed";

/**
 * A resource as the view drawing it reads it.
 *
 * `value` and `error` are both here rather than in a discriminated union, because that is how
 * the views want them: a failure leaves the last good answer on screen in several places, and a
 * shape that made "failed" exclude "has a value" would forbid the thing they do on purpose.
 */
export interface Resource<Value> {
  state: ResourceState;
  /** What came back, or null until something has. */
  value: Value | null;
  /** Why it did not, or null when nothing has gone wrong. */
  error: unknown;
  /** Asks again, forgetting the last attempt. Does nothing while one is in flight. */
  retry: () => void;
  /**
   * Puts a value in without asking for one.
   *
   * The write-through path: every write in this app answers with the whole payload, so the
   * screen after an edit is what was stored rather than what the page hoped. That answer is
   * the resource's new value, and it must count as one — otherwise the next mount asks again
   * and overwrites it with the version from before the edit.
   */
  put: (value: Value) => void;
}

export interface AsyncResourceOptions<Value> {
  /** Goes and gets it. Called at most once per `key`. */
  load: () => Promise<Value>;
  /**
   * Whether it is wanted yet. False is the whole reason the transmog view costs nothing until
   * it is opened: the game's tables are a second and a few hundred megabytes to read.
   */
  when?: boolean;
  /**
   * What the answer is *of*, when that can change — a character, an outfit, a look.
   *
   * A change abandons whatever was in flight rather than cancelling it: the request is already
   * gone and there is nothing to call back, so what changes is whether its answer is allowed
   * to reach the screen. The default is the one key an app-lifetime resource needs.
   */
  key?: string;
}

/** What one key's request came to, kept across a teardown so a remount does not re-ask. */
interface Attempt<Value> {
  key: string;
  promise: Promise<Value>;
}

const ONE_KEY = "";

/**
 * Something asked for once and kept.
 *
 * Nothing is asked for until `when`. When it is, the answer reaches the screen only if the
 * component is still mounted and still asking about the same key — so a reader who opens the
 * transmog view, waits half a second and leaves is not written to, and a slow answer for the
 * character they were looking at before cannot land on the one they are looking at now.
 */
export function useAsyncResource<Value>({
  load,
  when = true,
  key = ONE_KEY,
}: AsyncResourceOptions<Value>): Resource<Value> {
  const [held, setHeld] = useState<{ key: string; value: Value } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null);
  const [loading, setLoading] = useState(false);
  /** Counts the times somebody has asked for another go. See `retry`. */
  const [again, setAgain] = useState(0);

  /**
   * The request for the key being asked about, which outlives a teardown on purpose.
   *
   * This is what makes a setup → cleanup → setup pair one request rather than two. The second
   * setup finds this promise, recognises the key, and waits on the answer already on its way.
   */
  const attempt = useRef<Attempt<Value> | null>(null);
  /**
   * Which era of this component's life is being answered.
   *
   * Bumped by every teardown, so an answer that was in flight across one knows not to speak.
   * A counter rather than a boolean because a component is torn down and set up again more
   * than once — every time the key changes, and twice at mount under Strict Mode.
   */
  const era = useRef(0);

  useEffect(() => {
    if (!when) return undefined;
    const mine = era.current;
    // The request from before the teardown when the key has not moved, and a fresh one when it
    // has: a new key is a different question and the old answer is not an answer to it.
    if (!attempt.current || attempt.current.key !== key) {
      attempt.current = { key, promise: load() };
    }
    const { promise } = attempt.current;
    setLoading(true);
    promise.then(
      (value) => {
        if (mine !== era.current) return;
        setHeld({ key, value });
        setFailure(null);
        setLoading(false);
      },
      (error: unknown) => {
        if (mine !== era.current) return;
        // Forgotten rather than remembered as a failure, which is what makes `retry` and a
        // second look at the view both worth something: the reasons a read of the game's files
        // fails are the ones that pass — a folder not chosen yet, an install mid-patch.
        attempt.current = null;
        setFailure({ key, error });
        setLoading(false);
      },
    );
    return () => {
      era.current += 1;
    };
    // `again` is not read in here, and is a dependency on purpose: it is the only thing that can
    // make React run this effect a second time for a key it has already run it for, which is
    // the whole of what `retry` does.
  }, [load, when, key, again]);

  const retry = useCallback(() => {
    attempt.current = null;
    setFailure(null);
    setAgain((count) => count + 1);
  }, []);

  const put = useCallback(
    (value: Value) => {
      attempt.current = { key, promise: Promise.resolve(value) };
      setHeld({ key, value });
      setFailure(null);
      setLoading(false);
    },
    [key],
  );

  // Only what was asked about. A key change empties the screen rather than showing the last
  // character's answer under this one's name, which is the bug the guard exists to prevent.
  const mine = held && held.key === key ? held : null;
  const blame = failure && failure.key === key ? failure : null;
  const state: ResourceState = !when
    ? "idle"
    : blame
      ? "failed"
      : mine
        ? "ready"
        : loading
          ? "loading"
          : "idle";

  return { state, value: mine ? mine.value : null, error: blame ? blame.error : null, retry, put };
}

/** Whether the poll that started this ask still wants the answer. */
export type StillWanted = () => boolean;

export interface PollOptions {
  /** Whether to keep asking. False asks once and stops — the panel is off screen. */
  active: boolean;
  /** How long between asks, in milliseconds. */
  every: number;
}

/**
 * Asks something over and over while somebody could act on the answer.
 *
 * One ask straight away, then one every `every` for as long as `active`. `ask` is handed the
 * only thing it cannot work out for itself: whether the poll that started it is still running
 * by the time its answer arrives. Everything else — what to ask, what to do with the answer,
 * whether a write in flight makes this answer stale — belongs to the panel and stays there.
 *
 * `ask` must be stable, so wrap it in `useCallback`. It is a dependency of the interval, and an
 * `ask` rebuilt every render is a poll that restarts every render.
 */
export function usePoll(
  ask: (live: StillWanted) => Promise<void>,
  { active, every }: PollOptions,
): void {
  useEffect(() => {
    let alive = true;
    const live: StillWanted = () => alive;
    void ask(live);
    if (!active)
      return () => {
        alive = false;
      };
    const timer = setInterval(() => void ask(live), every);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ask, active, every]);
}
