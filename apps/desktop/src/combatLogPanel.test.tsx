import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CombatLogPanel } from "./combatLogPanel";
import type { CombatLogActions } from "./combatLogPanel";
import type { CombatLogStatus } from "./types";

/** The moment every sentence below is reckoned from, so "3 days ago" is a fact, not a clock. */
const NOW = 1_785_000_000;
const HOUR = 3600;

/** An install doing the thing properly: asked for, ticked, and writing. */
const status = (overrides: Partial<CombatLogStatus> = {}): CombatLogStatus => ({
  requested: true,
  advanced: true,
  source: "WTF/Account/EXAMPLE/config-cache.wtf",
  log: { name: "WoWCombatLog-072612_183012.txt", bytes: 4_404_019, modified: NOW - HOUR },
  growing: true,
  state: "advanced",
  ...overrides,
});

/** How the error double reports anything that went wrong, recognisable wherever it lands. */
const said = (error: unknown): string => `The install said: ${String(error)}`;

/** A promise a test hands the outcome to whenever it likes, to look at the panel mid-change. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * The panel over actions a test answers, which is the only way to drive it: nothing here talks
 * to a backend, and nothing monkey patches one.
 *
 * `visible` is left off, so the panel asks once and does not then poll — a test that wants to
 * see the answer to one question should not be racing a timer asking it again.
 */
function panel(actions: Partial<CombatLogActions> = {}, requested = false) {
  return render(
    <CombatLogPanel
      requested={requested}
      visible={false}
      actions={{
        status: () => Promise.resolve(status()),
        set: (enabled) => Promise.resolve(status({ requested: enabled })),
        onError: said,
        ...actions,
      }}
    />,
  );
}

const toggle = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: "Start combat logging when I log in" });
const state = (): HTMLElement => screen.getByRole("status");
const detail = (): HTMLElement => {
  const found = document.getElementById("combat-log-detail");
  if (!found) throw new Error("The panel has nowhere to put its evidence.");
  return found;
};

afterEach(cleanup);

describe("CombatLogPanel", () => {
  it("ticks the box from the setting and states where the install stands", async () => {
    panel({
      status: () => Promise.resolve(status({ state: "basic", advanced: false, growing: false })),
    });

    await waitFor(() => expect(state().textContent).toContain("advanced combat logging is off"));
    expect(toggle().checked).toBe(true);
    // The stylesheet colours the line from this, and only from this — a sentence that reads as
    // a problem in the colour of a success is the failure it exists to prevent.
    expect(state().dataset.state).toBe("basic");
    expect(detail().textContent).toContain("WoWCombatLog-072612_183012.txt");
    expect(detail().textContent).toContain("config-cache.wtf");
  });

  it("unticks the box for an install nothing has asked to log", async () => {
    panel({
      status: () => Promise.resolve(status({ requested: false, state: "off", growing: false })),
    });

    await waitFor(() => expect(state().dataset.state).toBe("off"));
    expect(toggle().checked).toBe(false);
  });

  // Until the install has been asked there is nothing to go on but what Chronie was told — and
  // the ask fails outright until a game folder has been chosen, which is exactly a first run.
  it("shows the saved setting before the install has answered", () => {
    panel({ status: () => new Promise<CombatLogStatus>(() => {}) }, true);

    expect(toggle().checked).toBe(true);
  });

  // A log's name comes off the reader's own disk, so it must arrive on screen as a name and
  // not as markup.
  it("puts a log's name on screen as text rather than as tags", async () => {
    panel({
      status: () =>
        Promise.resolve(status({ log: { name: "<b>log</b>.txt", bytes: 12, modified: NOW } })),
    });

    await waitFor(() => expect(detail().textContent).toContain("<b>log</b>.txt"));
    expect(detail().querySelector("b")).toBeNull();
  });

  // The panel is polled while somebody is looking at it, so a backend that cannot answer must
  // leave a sentence behind rather than an unhandled rejection nobody sees.
  it("reports a question the backend could not answer, without throwing", async () => {
    panel({ status: () => Promise.reject(new Error("no game folder is set")) });

    await waitFor(() =>
      expect(state().textContent).toContain("The install said: Error: no game folder is set"),
    );
  });

  it.each<[string, boolean, string]>([
    ["ticking it", true, "stale"],
    ["unticking it", false, "off"],
  ])("%s tells the backend, then repaints from what that left", async (_case, wanted, expected) => {
    const set = vi.fn((enabled: boolean) =>
      Promise.resolve(
        status({
          requested: enabled,
          growing: false,
          state: enabled ? "stale" : "off",
        }),
      ),
    );
    panel({ status: () => Promise.resolve(status({ requested: !wanted })), set });

    await waitFor(() => expect(toggle().checked).toBe(!wanted));
    fireEvent.click(toggle());

    await waitFor(() => expect(state().dataset.state).toBe(expected));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(wanted);
    expect(toggle().checked).toBe(wanted);
    expect(toggle().disabled).toBe(false);
  });

  // The game reads the addon's files at load and never again, so the switch does nothing at
  // all until the next login. Saying so while the write is still in flight is the point: a
  // control that silently takes an hour to mean anything is what this copy exists to prevent.
  it.each<[string, boolean, string]>([
    ["on", true, "Turning combat logging on. It starts at your next login or /reload."],
    ["off", false, "Turning combat logging off. It stops at your next login or /reload."],
  ])(
    "says a change to %s waits for the next login while the write is in flight",
    async (_case, wanted, copy) => {
      const answer = deferred<CombatLogStatus>();
      panel({
        status: () => Promise.resolve(status({ requested: !wanted })),
        set: () => answer.promise,
      });

      await waitFor(() => expect(toggle().checked).toBe(!wanted));
      fireEvent.click(toggle());

      await waitFor(() => expect(state().textContent).toContain(copy));
      // And nothing can be clicked again in the meantime, so two writes cannot cross.
      expect(toggle().disabled).toBe(true);

      answer.resolve(
        status({ requested: wanted, growing: false, state: wanted ? "stale" : "off" }),
      );
      await waitFor(() => expect(toggle().disabled).toBe(false));
      expect(state().textContent).not.toContain(copy);
    },
  );

  // The switch stands for what the backend was told. A write that failed changed nothing, so a
  // box left ticked would be the app claiming it had done something it had not.
  it("puts the switch back where it was when the setting could not be written", async () => {
    panel({
      status: () => Promise.resolve(status({ requested: false, state: "off", growing: false })),
      set: () => Promise.reject(new Error("the addon folder is read-only")),
    });

    await waitFor(() => expect(toggle().checked).toBe(false));
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().checked).toBe(false));
    expect(state().textContent).toContain("The install said: Error: the addon folder is read-only");
    // And it can be tried again, which a switch left disabled could not be.
    expect(toggle().disabled).toBe(false);
  });
});
