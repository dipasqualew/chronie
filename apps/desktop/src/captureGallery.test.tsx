import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CaptureGallery } from "./captureGallery";
import type { CaptureActions } from "./captureGallery";
import { createCaptureAlbum } from "./captures";
import type { Capture, CaptureImagePayload, DashboardPayload, Segment } from "./types";

const EVENING = 1_785_063_600;

/** A picture, as the backend hands one over: a `data:` URL and nothing else. */
const THUMBNAIL = "data:image/png;base64,thumbnail";
const FULL_SIZE = "data:image/png;base64,fullsize";

const capture = (overrides: Partial<Capture> = {}): Capture => ({
  id: 11,
  sourceId: "TEST|1|11",
  at: EVENING + 1400,
  imageState: "stored",
  byteSize: 3_204_112,
  ...overrides,
});

const segment = (captures: Capture[]): Segment => ({
  segmentId: 1,
  id: "synthetic-001",
  character: "Aster-Vale",
  day: "2026-07-26",
  instance: "Glass Caverns",
  difficulty: "",
  instanceType: "scenario",
  startedAt: EVENING,
  endedAt: EVENING + 1800,
  seconds: 1800,
  lootValue: 0,
  goldDiff: 0,
  housingXP: 0,
  captures,
});

/** How the error double reports anything that went wrong, recognisable wherever it lands. */
const said = (error: unknown): string => `Chronie said: ${String(error)}`;

/**
 * The gallery over actions a test answers, which is the only way to drive it: nothing here
 * talks to a backend and nothing monkey patches one.
 */
function gallery(captures: Capture[], actions: Partial<CaptureActions> = {}) {
  const album = createCaptureAlbum((ids) =>
    Promise.resolve({ thumbnails: Object.fromEntries(ids.map((id) => [id, THUMBNAIL])) }));
  return render(
    <CaptureGallery
      segments={[segment(captures)]}
      album={album}
      actions={{
        loadImage: (captureId) =>
          Promise.resolve<CaptureImagePayload>({ id: captureId, image: FULL_SIZE, byteSize: 12 }),
        setNote: () => Promise.resolve<DashboardPayload>({ segments: [] }),
        remove: () => Promise.resolve<DashboardPayload>({ segments: [] }),
        onApply: () => {},
        onError: said,
        ...actions,
      }}
    />,
  );
}

const tiles = (): HTMLElement[] => screen.getAllByRole("button", { name: /Open the screenshot/ });
const viewer = (): HTMLElement => {
  const found = document.getElementById("capture-viewer");
  if (!found) throw new Error("The gallery has nowhere to show a picture.");
  return found;
};
const noteField = (): HTMLTextAreaElement =>
  within(viewer()).getByLabelText("Note") as HTMLTextAreaElement;

/** Opens the picture at a given place in the grid, and waits for it to arrive. */
async function open(at = 0): Promise<void> {
  fireEvent.click(tiles()[at]);
  await waitFor(() => expect(viewer().querySelector("img")).not.toBeNull());
}

/**
 * What jsdom is missing about `<dialog>`, which is the two methods that open and close one.
 *
 * jsdom implements the element and not its modality — there is no top layer in a document
 * nobody is looking at — so `showModal` is simply absent. Everything under test here is what
 * the dialog holds rather than how it stacks: a field, three buttons and a picture. The
 * modality itself is a browser behaviour and is exercised in the browser, by `e2e/desktop.spec.ts`.
 */
beforeAll(() => {
  const dialog = globalThis.HTMLDialogElement?.prototype;
  // Typed as always present and absent at runtime, which is exactly what "jsdom implements
  // the element and not its modality" looks like from here.
  if (!dialog || typeof dialog.showModal === "function") return;
  dialog.showModal = function showModal(this: HTMLDialogElement): void { this.open = true; };
  dialog.close = function close(this: HTMLDialogElement): void {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(cleanup);

describe("CaptureGallery", () => {
  it("draws a tile per capture and fills each with the picture when it arrives", async () => {
    gallery([capture(), capture({ id: 12, sourceId: "TEST|1|12", at: EVENING + 1500 })]);

    expect(tiles()).toHaveLength(2);
    await waitFor(() =>
      expect(document.querySelectorAll(".capture-thumb img")).toHaveLength(2));
    expect(document.querySelector<HTMLImageElement>(".capture-thumb img")?.src)
      .toBe(THUMBNAIL);
  });

  // Three different things to be told, and none of them is a broken image: a picture that has
  // not arrived, an entry that never asked for one, and a marker whose file was lost.
  it("says why a tile has no picture rather than showing a blank one", () => {
    gallery([
      capture({ id: 12, sourceId: "b", imageState: "none" }),
      capture({ id: 13, sourceId: "c", imageState: "missing" }),
    ]);

    expect(tiles()[0].textContent).toContain("A note, with no picture taken.");
    expect(tiles()[1].textContent).toContain("could not find the file");
    // And neither asks the backend for a picture that does not exist.
    expect(document.querySelectorAll(".capture-thumb img")).toHaveLength(0);
  });

  // The other way a picture can be absent, and the one the row cannot predict: it says the
  // file is stored and the file has gone from under it — restored onto another machine, or
  // reached by a database that arrived over WiFi without the store behind it. The row carries
  // a hash and a size precisely so this is detectable and can be said rather than drawn as an
  // image that never loads.
  it("says so when the file has gone from under a row that says it is there", async () => {
    gallery([capture()], {
      loadImage: (captureId) => Promise.resolve<CaptureImagePayload>({ id: captureId, image: null }),
    });

    fireEvent.click(tiles()[0]);

    await waitFor(() =>
      expect(viewer().textContent).toContain("no longer on disk"));
    expect(viewer().querySelector("img")).toBeNull();
  });

  it("asks for the full-size picture only once one is opened", async () => {
    const loadImage = vi.fn((captureId: number) =>
      Promise.resolve<CaptureImagePayload>({ id: captureId, image: FULL_SIZE, byteSize: 12 }));
    gallery([capture()], { loadImage });

    expect(loadImage).not.toHaveBeenCalled();
    await open();

    expect(loadImage).toHaveBeenCalledWith(11);
    expect(viewer().querySelector<HTMLImageElement>("img")?.src).toBe(FULL_SIZE);
  });

  // A note is the most user-supplied string in the application. Everywhere it appears in a
  // React tree it is a value and is written as text; this is what holds that to account.
  it("puts a note containing markup on screen as text", async () => {
    gallery([capture({ note: "<b>first</b> Yogg kill" })]);

    expect(tiles()[0].textContent).toContain("<b>first</b> Yogg kill");
    expect(tiles()[0].querySelector("b")).toBeNull();
    // And in the tooltip, which is handed HTML rather than a value, so it is escaped there.
    expect(tiles()[0].dataset.tip).toContain("&lt;b&gt;first&lt;/b&gt;");

    await open();

    expect(noteField().value).toBe("<b>first</b> Yogg kill");
    expect(viewer().querySelector("b")).toBeNull();
  });

  it("writes a note and repaints from what the backend stored", async () => {
    const setNote = vi.fn(() => Promise.resolve<DashboardPayload>({ segments: [] }));
    const onApply = vi.fn();
    gallery([capture()], { setNote, onApply });
    await open();

    fireEvent.change(noteField(), { target: { value: "first Yogg kill" } });
    fireEvent.click(within(viewer()).getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(setNote).toHaveBeenCalledWith(11, "first Yogg kill");
  });

  // A field somebody clicked into and out of again has not been edited, and a write for it
  // would repaint the whole window for nothing.
  it("will not write a note that has not changed", async () => {
    gallery([capture({ note: "first Yogg kill" })]);
    await open();

    const save = within(viewer()).getByRole("button", { name: "Save note" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Padding is not an edit: it is what the backend would trim off before storing it.
    fireEvent.change(noteField(), { target: { value: "first Yogg kill " } });
    expect(save.disabled).toBe(true);
  });

  it("clears a note by writing an empty one", async () => {
    const setNote = vi.fn(() => Promise.resolve<DashboardPayload>({ segments: [] }));
    gallery([capture({ note: "first Yogg kill" })], { setNote });
    await open();

    fireEvent.click(within(viewer()).getByRole("button", { name: "Clear note" }));

    await waitFor(() => expect(setNote).toHaveBeenCalledWith(11, ""));
    expect(noteField().value).toBe("");
  });

  // The note stands for what the backend was told. A write that failed changed nothing, so a
  // window that carried on as though it had would be claiming something it had not done.
  it("says so when a note could not be written", async () => {
    const onApply = vi.fn();
    gallery([capture()], {
      setNote: () => Promise.reject(new Error("the database is locked")),
      onApply,
    });
    await open();

    fireEvent.change(noteField(), { target: { value: "first Yogg kill" } });
    fireEvent.click(within(viewer()).getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(viewer().textContent).toContain("Chronie said: Error: the database is locked"));
    expect(onApply).not.toHaveBeenCalled();
    // And the sentence is still in the field, so it can be tried again rather than retyped.
    expect(noteField().value).toBe("first Yogg kill");
  });

  // Deleting takes a file with it and cannot be undone, so it is asked about first — and the
  // question says what goes, rather than asking about the entry alone.
  it("asks before deleting, and says the picture goes too", async () => {
    const remove = vi.fn(() => Promise.resolve<DashboardPayload>({ segments: [] }));
    gallery([capture()], { remove });
    await open();

    fireEvent.click(within(viewer()).getByRole("button", { name: "Delete" }));

    expect(remove).not.toHaveBeenCalled();
    expect(within(viewer()).getByRole("alert").textContent)
      .toContain("deleted from Chronie's storage");

    fireEvent.click(within(viewer()).getByRole("button", { name: "Yes, delete it" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(11));
  });

  it("leaves the capture alone when the question is answered no", async () => {
    const remove = vi.fn(() => Promise.resolve<DashboardPayload>({ segments: [] }));
    gallery([capture()], { remove });
    await open();

    fireEvent.click(within(viewer()).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(viewer()).getByRole("button", { name: "Keep it" }));

    expect(remove).not.toHaveBeenCalled();
    expect(within(viewer()).queryByRole("alert")).toBeNull();
  });

  // A note somebody abandoned by stepping to the next picture must not follow them onto it,
  // which is the whole reason the field is reset on the capture rather than on the note.
  it("puts the next picture's own note in the field when the reader steps on", async () => {
    gallery([
      capture({ note: "first Yogg kill" }),
      capture({ id: 12, sourceId: "TEST|1|12", at: EVENING + 1500, note: "the one after" }),
    ]);
    await open();

    fireEvent.change(noteField(), { target: { value: "half a thought" } });
    fireEvent.click(within(viewer()).getByRole("button", { name: "Next screenshot" }));

    await waitFor(() => expect(noteField().value).toBe("the one after"));
  });

  it("draws nothing at all for segments nobody photographed", () => {
    const { container } = gallery([]);

    expect(container.innerHTML).toBe("");
  });
});
