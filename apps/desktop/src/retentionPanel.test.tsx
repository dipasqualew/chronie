import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RetentionPanel } from "./retentionPanel";
import type { RetentionActions } from "./retentionPanel";
import type { LogPile, LogRetention } from "./types";

const NOW = 1_785_000_000;
const DAY = 86_400;

const empty = (): LogPile => ({ count: 0, bytes: 0, files: [] });

/** Two old logs read to their end, and a gigabyte from before Chronie was watching. */
const report = (overrides: Partial<LogRetention> = {}): LogRetention => ({
  enabled: false,
  days: 7,
  doomed: {
    count: 2,
    bytes: 402_653_184,
    files: [
      { name: "WoWCombatLog-071026_201500.txt", bytes: 268_435_456, modified: NOW - 30 * DAY },
      { name: "WoWCombatLog-071126_193000.txt", bytes: 134_217_728, modified: NOW - 29 * DAY },
    ],
  },
  unread: {
    count: 1,
    bytes: 1_073_741_824,
    files: [{ name: "WoWCombatLog-032526_204500.txt", bytes: 1_073_741_824, modified: NOW - 120 * DAY }],
  },
  unfinished: empty(),
  removed: [],
  ...overrides,
});

const said = (error: unknown): string => `The install said: ${String(error)}`;

/**
 * The panel over actions a test answers. Nothing here reaches a backend and nothing patches
 * one; `visible` is off so the panel asks once rather than racing its own timer.
 */
function panel(actions: Partial<RetentionActions> = {}, days: number | null = null) {
  return render(
    <RetentionPanel
      days={days}
      visible={false}
      actions={{
        status: () => Promise.resolve(report()),
        set: (wanted) => Promise.resolve(report({ enabled: wanted !== null, days: wanted ?? 7 })),
        onError: said,
        ...actions,
      }}
    />,
  );
}

const toggle = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: "Delete combat logs Chronie has finished reading" });
const window_ = (): HTMLInputElement => screen.getByRole("spinbutton", { name: "Keep logs for" });
const state = (): HTMLElement => screen.getByRole("status");
const section = (id: string): HTMLElement | null => document.getElementById(id);

afterEach(cleanup);

describe("RetentionPanel", () => {
  // The dry run the whole feature turns on: what would go, by name, while the switch is still
  // off. A list that only appeared after the first sweep would be a receipt, not a choice.
  it("names the files a sweep would take before anybody has agreed to one", async () => {
    panel();

    await waitFor(() => expect(state().textContent).toContain("Chronie deletes no combat logs"));
    expect(toggle().checked).toBe(false);
    expect(section("log-retention-doomed")?.textContent).toContain("Would go on the next sync:");
    expect(section("log-retention-doomed")?.textContent)
      .toContain("WoWCombatLog-071026_201500.txt");
    expect(state().textContent).toContain("would delete 2 logs, 384.0 MB");
  });

  // The pile Chronie will never clear by itself. Naming it is the difference between handing
  // somebody a decision and telling them a number they can do nothing with.
  it("names the old logs it will never delete, and says whose job they are", async () => {
    panel();

    await waitFor(() => expect(section("log-retention-unread")).not.toBeNull());
    expect(section("log-retention-unread")?.textContent).toContain("Never deleted by Chronie:");
    expect(section("log-retention-unread")?.textContent)
      .toContain("WoWCombatLog-032526_204500.txt");
    expect(section("log-retention-detail")?.textContent).toContain("Removing them is yours to do.");
  });

  // The window is meaningless while nothing is being deleted, and an editable number that does
  // nothing is a control that lies.
  it("leaves the window alone until the sweeper is switched on", async () => {
    panel();

    await waitFor(() => expect(toggle().checked).toBe(false));
    expect(window_().disabled).toBe(true);
  });

  it("sends the window the box is showing when the switch goes on", async () => {
    const set = vi.fn((days: number | null) =>
      Promise.resolve(report({ enabled: days !== null, days: days ?? 7 })));
    panel({ set });

    await waitFor(() => expect(toggle().checked).toBe(false));
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().checked).toBe(true));
    expect(set).toHaveBeenCalledWith(7);
    expect(window_().disabled).toBe(false);
    expect(state().textContent).toContain("older than 7 days");
  });

  it("turns the sweeper off rather than setting it to zero", async () => {
    const set = vi.fn((days: number | null) =>
      Promise.resolve(report({ enabled: days !== null, days: days ?? 7 })));
    panel({ status: () => Promise.resolve(report({ enabled: true })), set }, 7);

    await waitFor(() => expect(toggle().checked).toBe(true));
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().checked).toBe(false));
    expect(set).toHaveBeenCalledWith(null);
  });

  // A number is committed when the reader leaves the box, not on every keystroke — half of
  // "30" is "3", and a sweeper briefly set to three days is not a typo anybody wants.
  it("commits a window when the box is left rather than while it is being typed", async () => {
    const set = vi.fn((days: number | null) =>
      Promise.resolve(report({ enabled: true, days: days ?? 7 })));
    panel({ status: () => Promise.resolve(report({ enabled: true })), set }, 7);

    await waitFor(() => expect(window_().disabled).toBe(false));
    fireEvent.change(window_(), { target: { value: "30" } });
    expect(set).not.toHaveBeenCalled();
    fireEvent.blur(window_());

    await waitFor(() => expect(set).toHaveBeenCalledWith(30));
  });

  it.each<[string, string, number]>([
    ["a zero somebody typed", "0", 1],
    ["a number longer than the app offers", "9999", 365],
  ])("brings %s inside what the backend will honour", async (_case, typed, expected) => {
    const set = vi.fn((days: number | null) =>
      Promise.resolve(report({ enabled: true, days: days ?? 7 })));
    panel({ status: () => Promise.resolve(report({ enabled: true })), set }, 7);

    await waitFor(() => expect(window_().disabled).toBe(false));
    fireEvent.change(window_(), { target: { value: typed } });
    fireEvent.blur(window_());

    await waitFor(() => expect(set).toHaveBeenCalledWith(expected));
  });

  // The panel is asked again while somebody is looking at it, so a backend that cannot answer
  // has to leave a sentence rather than an unhandled rejection nobody sees.
  it("reports a question the backend could not answer, without throwing", async () => {
    panel({ status: () => Promise.reject(new Error("no game folder is set")) });

    await waitFor(() =>
      expect(state().textContent).toContain("The install said: Error: no game folder is set"));
  });

  // A write that fails must leave the switch where the setting still is, not where the click
  // hoped it would be.
  it("puts the switch back when the write fails", async () => {
    panel({ set: () => Promise.reject(new Error("settings are read-only")) });

    await waitFor(() => expect(toggle().checked).toBe(false));
    fireEvent.click(toggle());

    await waitFor(() =>
      expect(state().textContent).toContain("The install said: Error: settings are read-only"));
    expect(toggle().checked).toBe(false);
  });

  // A log's name comes off the reader's own disk, so it reaches the screen as a name.
  it("puts a log's name on screen as text rather than as tags", async () => {
    panel({
      status: () => Promise.resolve(report({
        doomed: { count: 1, bytes: 12, files: [{ name: "<b>log</b>.txt", bytes: 12, modified: NOW }] },
      })),
    });

    await waitFor(() =>
      expect(section("log-retention-doomed")?.textContent).toContain("<b>log</b>.txt"));
    expect(section("log-retention-doomed")?.querySelector("b")).toBeNull();
  });

  // Until the backend has answered there is nothing to go on but what Chronie was told — and
  // the ask fails outright until a game folder has been chosen, which is a first run exactly.
  it("shows the saved window before the backend has answered", () => {
    panel({ status: () => new Promise<LogRetention>(() => {}) }, 14);

    expect(toggle().checked).toBe(true);
    expect(window_().value).toBe("14");
  });
});
