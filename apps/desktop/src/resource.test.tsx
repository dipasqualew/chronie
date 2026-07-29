import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAsyncResource, usePoll } from "./resource";
import type { Resource, ResourceState, StillWanted } from "./resource";

afterEach(cleanup);

/** A promise a test hands the answer to whenever it likes, to look at a load mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * The hook under a component, which is the only way this repository has of running one: there is
 * no hook-testing library here, and a hook whose whole subject is what React does to an effect
 * would be the wrong thing to run outside React anyway.
 *
 * Every render is recorded rather than only the last one, because most of what is claimed below is
 * about what did and did not reach the screen. "The character we were looking at before never
 * appeared under this one's name" is a statement about the whole sequence of renders and cannot be
 * read off the final state, which is right either way.
 *
 * The key is passed in as `subject` because `key` is React's own prop and a component cannot be
 * handed one.
 */
function Probe({
  seen,
  load,
  when,
  subject,
}: {
  seen: Resource<string>[];
  load: () => Promise<string>;
  when?: boolean;
  subject?: string;
}) {
  const resource = useAsyncResource({ load, when, key: subject });
  seen.push(resource);
  return <span>{resource.state}</span>;
}

/** A poll under a component. `ask` is a prop so its identity is the test's to keep stable. */
function Poller({
  ask,
  active,
  every,
}: {
  ask: (live: StillWanted) => Promise<void>;
  active: boolean;
  every: number;
}) {
  usePoll(ask, { active, every });
  return null;
}

/** What the most recent render was handed, which is what a reader is looking at. */
function latest<T>(seen: T[]): T {
  const last = seen.at(-1);
  if (last === undefined) throw new Error("The probe never rendered.");
  return last;
}

/** Every state the probe has ever been in, which is where a leaked answer would show up. */
const states = (seen: Resource<string>[]): ResourceState[] =>
  seen.map((resource) => resource.state);

describe("useAsyncResource", () => {
  // Nothing is asked for until somebody wants it, and that is not an optimisation: the transmog
  // view reads the game's own tables, which is a second and a few hundred megabytes, and a window
  // that paid for it on the way up would pay for it for every reader who never opened the view.
  it("asks for nothing at all while nothing wants it", () => {
    const seen: Resource<string>[] = [];
    const load = vi.fn(() => Promise.resolve("the game's tables"));
    render(<Probe seen={seen} load={load} when={false} />);

    expect(load).not.toHaveBeenCalled();
    expect(latest(seen).state).toBe("idle");
  });

  it("moves from loading to ready and hands over what came back", async () => {
    const seen: Resource<string>[] = [];
    const answer = deferred<string>();
    const load = vi.fn(() => answer.promise);
    render(<Probe seen={seen} load={load} />);

    // Said before the answer arrives rather than after, because a view with nothing to draw yet
    // and a view whose read failed are two different screens and this is what tells them apart.
    expect(latest(seen).state).toBe("loading");

    answer.resolve("the game's tables");

    await waitFor(() => expect(latest(seen).state).toBe("ready"));
    expect(latest(seen).value).toBe("the game's tables");
    expect(latest(seen).error).toBeNull();
  });

  // The headline property, and the one no hand-written effect in this app ever had. React sets an
  // effect up, tears it down and sets it up again to prove the teardown is real — Strict Mode does
  // it to every effect in the window — and a resource that took that literally would open the
  // game's largest tables twice on every mount.
  it("asks the backend once when React sets the effect up twice", async () => {
    const seen: Resource<string>[] = [];
    const load = vi.fn(() => Promise.resolve("the game's tables"));
    render(
      <StrictMode>
        <Probe seen={seen} load={load} />
      </StrictMode>,
    );

    await waitFor(() => expect(latest(seen).state).toBe("ready"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(latest(seen).value).toBe("the game's tables");
  });

  // The reasons a read of the game's files fails are the reasons that pass — a folder not chosen
  // yet, an install part way through a patch — so a failure has to be both said out loud and
  // forgotten, or the view is stuck on it for as long as the window is open.
  it("says why it could not load, and asks again when told to", async () => {
    const seen: Resource<string>[] = [];
    let asks = 0;
    const load = vi.fn((): Promise<string> => {
      asks += 1;
      return asks === 1
        ? Promise.reject(new Error("no game folder is set"))
        : Promise.resolve("the game's tables");
    });
    render(<Probe seen={seen} load={load} />);

    await waitFor(() => expect(latest(seen).state).toBe("failed"));
    expect(String(latest(seen).error)).toBe("Error: no game folder is set");

    act(() => {
      latest(seen).retry();
    });

    await waitFor(() => expect(latest(seen).state).toBe("ready"));
    expect(latest(seen).value).toBe("the game's tables");
    expect(load).toHaveBeenCalledTimes(2);
  });

  // A reader who opens the transmog view, waits half a second and leaves is a reader nothing may
  // be written to. The answer is already on its way and there is nothing to cancel, so the only
  // thing left to decide is whether it is allowed on screen.
  it("applies nothing to a component that has already gone", async () => {
    const seen: Resource<string>[] = [];
    const answer = deferred<string>();
    const load = vi.fn(() => answer.promise);
    const shown = render(<Probe seen={seen} load={load} />);

    expect(latest(seen).state).toBe("loading");
    shown.unmount();

    answer.resolve("the game's tables, long after anybody was looking");
    await act(async () => undefined);

    // React 19 says nothing about a `setState` after unmount — no warning, no console line — so
    // there is nothing to assert on but the renders themselves. That the answer never reached one
    // is the whole claim.
    expect(states(seen)).not.toContain("ready");
    expect(seen.every((resource) => resource.value === null)).toBe(true);
  });

  // The bug the key exists to prevent: a slow answer for the character the reader was looking at
  // before, arriving under the name of the one they are looking at now.
  it("abandons the answer to the question it was asked before", async () => {
    const seen: Resource<string>[] = [];
    const before = deferred<string>();
    const now = deferred<string>();
    let asks = 0;
    const load = vi.fn(() => {
      asks += 1;
      return asks === 1 ? before.promise : now.promise;
    });
    const shown = render(
      <Probe seen={seen} load={load} subject="the character we were looking at" />,
    );

    shown.rerender(<Probe seen={seen} load={load} subject="the one we are looking at now" />);
    expect(load).toHaveBeenCalledTimes(2);

    // The old question answered after the key has already moved on, which is the order that makes
    // this a test rather than a coincidence: whichever of the two lands first, only one of them is
    // an answer to what is on screen.
    before.resolve("the outfit of the character we left");
    now.resolve("the outfit of the one on screen");

    await waitFor(() => expect(latest(seen).value).toBe("the outfit of the one on screen"));
    expect(seen.some((resource) => resource.value === "the outfit of the character we left")).toBe(
      false,
    );
  });

  // Every write in this app answers with the whole payload, so what the screen shows after an edit
  // is what was stored rather than what the page hoped. That answer arrives without anybody having
  // asked for it, and it still has to count as the resource's value.
  it("shows a value the app put in without going and asking for one", () => {
    const seen: Resource<string>[] = [];
    const load = vi.fn(() => new Promise<string>(() => {}));
    render(<Probe seen={seen} load={load} />);

    expect(latest(seen).state).toBe("loading");
    act(() => {
      latest(seen).put("what the write answered with");
    });

    expect(latest(seen).state).toBe("ready");
    expect(latest(seen).value).toBe("what the write answered with");
  });

  // And the other half of it, which is the part that was actually broken: a value put in has to
  // count as the request for that key as well, or the next time the view is opened it asks again
  // and paints the version from before the edit over the top of the edit.
  it("does not ask again over the top of a value a write put in", async () => {
    const seen: Resource<string>[] = [];
    const load = vi.fn(() => Promise.resolve("the outfit as it was before the edit"));
    const shown = render(<Probe seen={seen} load={load} when />);

    await waitFor(() => expect(latest(seen).value).toBe("the outfit as it was before the edit"));
    act(() => {
      latest(seen).put("the outfit as the backend stored it");
    });

    // The view left and came back, which is all `when` is.
    shown.rerender(<Probe seen={seen} load={load} when={false} />);
    shown.rerender(<Probe seen={seen} load={load} when />);
    await act(async () => undefined);

    expect(latest(seen).state).toBe("ready");
    expect(latest(seen).value).toBe("the outfit as the backend stored it");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("usePoll", () => {
  /** Long enough that no real timer could be mistaken for it, which fake timers make free. */
  const EVERY = 5_000;

  /** Records every ask, and keeps the `live` each was handed so a test can ask it afterwards. */
  function asking() {
    const lives: StillWanted[] = [];
    const ask = vi.fn((live: StillWanted) => {
      lives.push(live);
      return Promise.resolve();
    });
    return { ask, lives };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  // Unmounted before the clock is put back, so that an interval is cleared by the same timers that
  // made it and every assertion above is about a poll that was genuinely still running.
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // The shape every panel in the app wants: something on screen straight away rather than after
  // the first interval, and then kept up to date for as long as somebody could act on it.
  it("asks once straight away, then once every interval while somebody is looking", () => {
    const { ask } = asking();
    render(<Poller ask={ask} active every={EVERY} />);

    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(EVERY);
    expect(ask).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(EVERY * 3);
    expect(ask).toHaveBeenCalledTimes(5);
  });

  // A panel off screen still answers the question once, because it is drawn as soon as it is
  // reached and drawing it empty would be a flicker. What it must not do is keep a clock going for
  // a reader who is looking at something else — three panels in this window poll.
  it("asks once and starts no clock at all when nobody is looking", () => {
    const { ask } = asking();
    render(<Poller ask={ask} active={false} every={EVERY} />);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(EVERY * 10);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("stops the clock and disowns its answers when the panel goes away", () => {
    const { ask, lives } = asking();
    const shown = render(<Poller ask={ask} active every={EVERY} />);
    vi.advanceTimersByTime(EVERY);

    expect(ask).toHaveBeenCalledTimes(2);
    expect(lives.every((live) => live())).toBe(true);

    shown.unmount();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(EVERY * 10);
    expect(ask).toHaveBeenCalledTimes(2);
    // An ask already in flight is the case a cleared interval does not cover, and `live` is the
    // only thing it can consult: the request is gone and its answer is about to arrive for a panel
    // that is not there to be written to.
    expect(lives.some((live) => live())).toBe(false);
  });

  // The same again for a panel still mounted that nobody is looking at, which is what every one of
  // them is as soon as the reader clicks another tab.
  it("stops the clock and disowns its answers when nobody is looking any more", () => {
    const { ask, lives } = asking();
    const shown = render(<Poller ask={ask} active every={EVERY} />);
    vi.advanceTimersByTime(EVERY);
    const started = lives.length;

    shown.rerender(<Poller ask={ask} active={false} every={EVERY} />);

    expect(vi.getTimerCount()).toBe(0);
    expect(lives.slice(0, started).some((live) => live())).toBe(false);
    vi.advanceTimersByTime(EVERY * 10);
    // One more ask on the way off screen — the panel is being drawn for the last time and that is
    // worth an answer — and then nothing.
    expect(ask).toHaveBeenCalledTimes(started + 1);
  });
});
