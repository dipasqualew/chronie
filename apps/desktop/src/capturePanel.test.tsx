import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapturePanel } from "./capturePanel";
import type { CaptureActions } from "./capturePanel";
import type { CaptureQuality, Settings } from "./types";

const said = (error: unknown): string => `The install said: ${String(error)}`;

/**
 * The panel over actions a test answers, and a store the answers come out of.
 *
 * The stub behaves the way the backend does — it records what it was told and answers with the
 * whole of the settings — because the panel's own rule is that it repaints from the answer
 * rather than from the click, and a stub that only acknowledged would let that rot unnoticed.
 */
function panel(settings: Settings = {}, overrides: Partial<CaptureActions> = {}) {
  const stored: Settings = { captureTriggers: [], captureQuality: "balanced", ...settings };
  const actions: CaptureActions = {
    setTriggers: vi.fn((triggers: string[]) =>
      Promise.resolve({ ...stored, captureTriggers: triggers }),
    ),
    setStorage: vi.fn((quality: CaptureQuality, keepOriginals: boolean) =>
      Promise.resolve({
        ...stored,
        captureQuality: quality,
        keepOriginalScreenshots: keepOriginals,
      }),
    ),
    onError: said,
    ...overrides,
  };
  render(<CapturePanel actions={actions} settings={stored} />);
  return actions;
}

const box = (name: string | RegExp): HTMLInputElement => screen.getByRole("checkbox", { name });
const level = (name: string | RegExp): HTMLInputElement => screen.getByRole("radio", { name });
const state = (): HTMLElement => screen.getByRole("status");
const section = (id: string): HTMLElement | null => document.getElementById(id);

afterEach(cleanup);

describe("CapturePanel", () => {
  // The three the issue asks for by name, drawn from the settings rather than from a default,
  // because a panel that shows every box unticked on an install that photographs account
  // firsts is telling somebody the opposite of what is happening.
  it("shows the rules the install is actually running", () => {
    panel({ captureTriggers: ["accountFirstAchievement", "mount"] });

    expect(box(/An achievement nobody on this account had/).checked).toBe(true);
    expect(box(/A mount added to the collection/).checked).toBe(true);
    expect(box(/Every achievement this character earns/).checked).toBe(false);
  });

  it("saves a rule as it is ticked, and says what that leaves", async () => {
    const actions = panel({ captureTriggers: ["accountFirstAchievement"] });

    fireEvent.click(box(/A mount added to the collection/));

    await waitFor(() =>
      expect(actions.setTriggers).toHaveBeenCalledWith(["accountFirstAchievement", "mount"]),
    );
    expect(state().textContent).toContain("2 kinds of moment");
  });

  it("saves the removal of a rule the same way", async () => {
    const actions = panel({ captureTriggers: ["accountFirstAchievement", "mount"] });

    fireEvent.click(box(/A mount added to the collection/));

    await waitFor(() =>
      expect(actions.setTriggers).toHaveBeenCalledWith(["accountFirstAchievement"]),
    );
  });

  // Turning everything off is a legitimate thing to want, and the panel has to say what that
  // leaves rather than looking like a broken feature.
  it("says the keybinding still works when nothing is automatic", async () => {
    const actions = panel({ captureTriggers: ["mount"] });

    fireEvent.click(box(/A mount added to the collection/));

    await waitFor(() => expect(actions.setTriggers).toHaveBeenCalledWith([]));
    expect(state().textContent).toContain("keybinding still works");
  });

  // The whole reason `narrows` exists: two boxes ticked where one of them is doing nothing on
  // its own is a state somebody will otherwise stare at.
  it("says when a broader rule already covers a narrower one", async () => {
    panel({ captureTriggers: ["accountFirstAchievement"] });
    expect(screen.queryByText(/Already covered by/)).toBeNull();

    fireEvent.click(box(/Every achievement this character earns/));

    await waitFor(() => expect(screen.getByText(/Already covered by/)).toBeTruthy());
    expect(screen.getByText(/Already covered by/).textContent).toContain(
      "Every achievement this character earns",
    );
    // Still ticked and still the reader's to untick: this is a note, not a correction.
    expect(box(/An achievement nobody on this account had/).checked).toBe(true);
  });

  // A hand-edited settings file, or an addon newer than this window. The panel writes the whole
  // list from its own boxes, so a name it cannot draw has to survive being written over.
  it("keeps a rule it has no box for, and says it is there", async () => {
    const actions = panel({ captureTriggers: ["mount", "somethingNewer"] });

    expect(section("capture-triggers-unknown")?.textContent).toContain("somethingNewer");

    fireEvent.click(box(/A toy added to the collection/));

    await waitFor(() =>
      expect(actions.setTriggers).toHaveBeenCalledWith(["mount", "toy", "somethingNewer"]),
    );
  });

  it("shows the stored quality, and saves the one that is chosen", async () => {
    const actions = panel({ captureQuality: "balanced" });

    expect(level(/Fits a retina display/).checked).toBe(true);
    fireEvent.click(level(/Exactly what the game wrote/));

    await waitFor(() => expect(actions.setStorage).toHaveBeenCalledWith("original", false));
    expect(level(/Exactly what the game wrote/).checked).toBe(true);
  });

  // An install whose settings predate the setting is on the default rather than on nothing,
  // and the panel has to show what is actually happening to that install's screenshots.
  it("falls back to the default quality when the settings do not say", () => {
    panel({ captureQuality: undefined });

    expect(level(/Fits a retina display/).checked).toBe(true);
  });

  // The two storage settings travel together because they are one decision about disk, and a
  // click on either has to save both rather than blanking the one it did not touch.
  it("saves the quality and the originals together", async () => {
    const actions = panel({ captureQuality: "small", keepOriginalScreenshots: false });

    fireEvent.click(box("Leave the game’s own copy where it is"));

    await waitFor(() => expect(actions.setStorage).toHaveBeenCalledWith("small", true));
  });

  // The two states are opposite risks — a folder that never stops growing, and a folder
  // somebody has curated for years losing files — so the panel says which one is running.
  it("says what happens to the game's own copy either way", async () => {
    panel({ keepOriginalScreenshots: false });
    expect(section("capture-storage-state")?.textContent).toContain("deletes the game’s copy");

    fireEvent.click(box("Leave the game’s own copy where it is"));

    await waitFor(() =>
      expect(section("capture-storage-state")?.textContent).toContain("goes on growing"),
    );
  });

  // Neither setting reaches into the store, and somebody deciding to save disk needs to know
  // that before they expect a year of screenshots to shrink.
  it("says that neither setting touches a picture already stored", () => {
    panel();

    expect(screen.getByText(/Nothing already in the store is re-compressed/)).toBeTruthy();
  });

  // A write that fails must leave the boxes showing what is still stored, not what the click
  // hoped — and must say what went wrong rather than failing silently.
  it("puts a rule back when the write fails, and says why", async () => {
    panel(
      { captureTriggers: ["mount"] },
      {
        setTriggers: () => Promise.reject(new Error("settings are read-only")),
      },
    );

    fireEvent.click(box(/A toy added to the collection/));

    await waitFor(() =>
      expect(state().textContent).toContain("The install said: Error: settings are read-only"),
    );
  });

  it("reports a storage write the backend refused", async () => {
    panel({}, { setStorage: () => Promise.reject(new Error("no game folder is set")) });

    fireEvent.click(level(/Fits a laptop screen/));

    await waitFor(() =>
      expect(state().textContent).toContain("The install said: Error: no game folder is set"),
    );
  });
});
