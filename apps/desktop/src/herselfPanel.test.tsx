import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Herself } from "./herselfPanel";
import type { HerselfProps } from "./herselfPanel";
import type { CharacterChosen, CharacterLookPayload, CharacterPick, CharacterQuestion } from "./types";

afterEach(cleanup);

/** What the game asks about a Human Female, cut down to the two shapes that differ: a question
 * whose swatches are named, and one whose are not. */
const HERS: CharacterQuestion[] = [
  {
    id: 16,
    name: "Hair Style",
    swatches: [{ id: 132, name: "Loose" }, { id: 133, name: "Braided" }],
  },
  { id: 14, name: "Skin Color", swatches: [{ id: 85, name: "" }, { id: 86, name: "" }] },
];

/** And what it asks about the other body, which is not the same list under other names: a
 * beard is a question no female body is ever asked. */
const HIS: CharacterQuestion[] = [
  { id: 11, name: "Hair Style", swatches: [{ id: 44, name: "Bald" }, { id: 45, name: "Peasant" }] },
  { id: 13, name: "Beard", swatches: [{ id: 70, name: "Clean" }, { id: 71, name: "Full" }] },
];

const ASKED: CharacterLookPayload = {
  bodies: [{ id: 1, name: "Human Male" }, { id: 2, name: "Human Female" }],
  body: 2,
  questions: HERS,
  picked: [],
};

/**
 * The panel over a settings file that answers.
 *
 * The stub stores what it is told and answers with it, because the panel's rule is that it
 * repaints from the answer rather than from the click — the same bargain the marks and the
 * capture settings make, and a stub that only acknowledged would let it rot unnoticed.
 */
function panel(overrides: Partial<HerselfProps> = {}) {
  let picked: CharacterPick[] = [...ASKED.picked];
  let body = ASKED.body;
  const props: HerselfProps = {
    load: vi.fn(() => Promise.resolve({
      ...ASKED,
      body,
      // The questions of whichever body is being drawn, which is what the backend re-reads.
      questions: body === ASKED.body ? HERS : HIS,
      picked: [...picked],
    })),
    save: vi.fn((chosen: number, answers: CharacterPick[]): Promise<CharacterChosen> => {
      body = chosen;
      picked = answers;
      return Promise.resolve({ body, picked: [...picked] });
    }),
    onChanged: vi.fn(),
    onError: (error: unknown) => String(error),
    ...overrides,
  };
  render(<Herself {...props} />);
  return props;
}

/**
 * Opens the disclosure, which is the only thing that reads anything.
 *
 * Set and then announced, because that is the order a browser does it in: a `<summary>` click
 * flips `open` and then fires `toggle`, and jsdom implements neither half of that on its own.
 * The end-to-end suite is where a real click on it is driven.
 */
function open(): void {
  const details = screen.getByText("Who she is").closest("details");
  if (!details) throw new Error("the panel has no disclosure to open");
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

const field = (name: string | RegExp): HTMLSelectElement =>
  screen.getByRole("combobox", { name });

describe("Herself", () => {
  // The panel walks five of the game's tables and the overwhelming majority of the time a
  // reader is here to try hats on. Every body drawn beside it already has this reader's answers
  // applied, because the backend keeps them — so reading them here is for the form and nothing
  // else, and a form nobody opened does not need one.
  it("reads nothing until somebody opens it", () => {
    const { load } = panel();

    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("asks what she may be the first time it is opened, and only then", async () => {
    const { load } = panel();

    open();
    await waitFor(() => expect(field("Hair Style")).toBeTruthy());
    open();

    expect(load).toHaveBeenCalledTimes(1);
  });

  // The swatch a question opens on is the first one, because that is what the body is drawn
  // from until somebody says otherwise — a select showing nothing would be showing a body that
  // does not exist.
  it("shows the swatch each question is on, answered or not", async () => {
    panel({ load: () => Promise.resolve({ ...ASKED, picked: [{ question: 14, swatch: 86 }] }) });

    open();

    await waitFor(() => expect(field("Hair Style").value).toBe("132"));
    expect(field("Skin Color").value).toBe("86");
  });

  // Most of the game's swatches have no name at all — 23 skin tones on a shipping build, not
  // one of them named — so the numbering is what a reader picks by rather than a fallback for
  // an unusual row.
  it("numbers the swatches the game does not name", async () => {
    panel();

    open();

    await waitFor(() => expect(field("Skin Color")).toBeTruthy());
    const named = [...field("Hair Style").options].map((option) => option.textContent);
    expect(named).toEqual(["Loose", "Braided"]);
    const numbered = [...field("Skin Color").options].map((option) => option.textContent);
    expect(numbered).toEqual(["Swatch 1", "Swatch 2"]);
  });

  // The point of the panel, and the reason there is no Save button over it: the answer is
  // stored as it is picked, and every question is stated rather than the one that moved.
  it("stores an answer as it is picked, and says she has changed", async () => {
    const { save, onChanged } = panel();
    open();
    await waitFor(() => expect(field("Hair Style")).toBeTruthy());

    fireEvent.change(field("Hair Style"), { target: { value: "133" } });

    const answered = [{ question: 16, swatch: 133 }, { question: 14, swatch: 85 }];
    await waitFor(() => expect(save).toHaveBeenCalledWith(2, answered));
    expect(onChanged).toHaveBeenCalledWith({ body: 2, picked: answered });
    expect(field("Hair Style").value).toBe("133");
  });

  // The form repaints from what was stored, so a second answer builds on the first rather than
  // on what the panel happened to be holding when it opened.
  it("keeps the answers already given when the next one is picked", async () => {
    const { save } = panel();
    open();
    await waitFor(() => expect(field("Hair Style")).toBeTruthy());

    fireEvent.change(field("Hair Style"), { target: { value: "133" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.change(field("Skin Color"), { target: { value: "86" } });

    await waitFor(() => expect(save).toHaveBeenLastCalledWith(2, [
      { question: 16, swatch: 133 },
      { question: 14, swatch: 86 },
    ]));
  });

  // An install whose tables this app cannot read says so. A form of empty selects would look
  // like a body nobody is allowed to change rather than a game nothing could be read out of.
  it("says so when the game can say nothing about how she is put together", async () => {
    panel({ load: () => Promise.resolve({ ...ASKED, bodies: [], questions: [] }) });

    open();

    await waitFor(() => expect(screen.getByText(/says nothing about how this body/)).toBeTruthy());
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says why when what she may be cannot be read at all", async () => {
    panel({ load: () => Promise.reject(new Error("Choose the game folder in Setup first.")) });

    open();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Choose the game folder"));
  });

  // A refusal from the write end leaves the form where it was rather than showing an answer
  // that was not stored — the same rule the marks follow.
  it("says why when an answer will not store, and does not report a change", async () => {
    const { onChanged } = panel({
      save: () => Promise.reject(new Error("That choice names no question of hers.")),
    });
    open();
    await waitFor(() => expect(field("Hair Style")).toBeTruthy());

    fireEvent.change(field("Hair Style"), { target: { value: "133" } });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("names no question"));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
