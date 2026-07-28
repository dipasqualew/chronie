/**
 * The one form in this app that writes into somebody's WoW account.
 *
 * Everything else the panel does is drawn and driven through `transmogView.test.tsx`, which
 * renders the whole view over it. This is here on its own because sending is the half that
 * cannot be undone from the app — the addon carries it out at the next login, and by then
 * nobody is looking — so what the button is handed, and when it declines to hand over anything
 * at all, is worth asserting against the panel and nothing above it.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rowOf } from "./inGameSets";
import type { ModelStage } from "./modelViewer";
import { NOTHING_ON, wear } from "./outfit";
import type { Outfit, Worn } from "./outfit";
import { OutfitPanel } from "./outfitPanel";
import type { SaveActions } from "./outfitPanel";
import type { AppearanceRow } from "./transmogModal";
import type { InGameSetSlot, SetRequest, TransmogAppearance } from "./types";

afterEach(cleanup);

/** One appearance as the row a browser hands the panel, with only what a test spells out. */
const row = (fields: Partial<TransmogAppearance>): AppearanceRow => rowOf({
  modifiedAppearanceId: 71_001,
  itemId: 30_001,
  name: "Tideglass Crown",
  appearanceId: 80_001,
  displayType: 0,
  inventoryType: 1,
  allowableClass: 0xffff,
  requiredLevel: 0,
  quality: 4,
  displayInfoId: 900_001,
  iconFileDataId: 130_001,
  hasModel: true,
  ...fields,
});

const HELM = row({ displayType: 0, appearanceId: 80_001, iconFileDataId: 130_001 });
const ROBE = row({
  name: "Tideglass Robe", displayType: 3, appearanceId: 80_003, displayInfoId: 900_003,
  iconFileDataId: 130_003,
});
/** Arrows: the game files them under a weapon slot and nobody holds them. */
const ARROWS = row({
  name: "A quiver of arrows", displayType: 11, inventoryType: 24, appearanceId: 80_024,
  displayInfoId: 900_024,
});

const dressedIn = (...rows: AppearanceRow[]): Outfit =>
  rows.reduce((worn, one) => wear(worn, one), NOTHING_ON);

/**
 * The same, with a row put somewhere `wear` would never have put it.
 *
 * For the one state the send button's own guard is about: something on her that the game has
 * nowhere to keep. `wear` refuses exactly what `slotsFrom` refuses, so an outfit assembled the
 * ordinary way cannot reach it, and forcing the row in is what makes the guard assertable.
 */
const forced = (pieces: Record<string, AppearanceRow>): Outfit =>
  Object.fromEntries(Object.entries(pieces).map(
    ([place, one]): [string, Worn] => [place, { place, row: one, from: "" }],
  ));

/** A `.glb` in a data URL, the shape the backend hands one over in. */
const model = (body: string): string => `data:model/gltf-binary;base64,${btoa(body)}`;

/**
 * What the backend answers a send with, which is a request nobody has carried out yet.
 *
 * Unanswered on purpose: nothing in a desktop app reaches a running game, so this is the state
 * a real request is in from the moment it is written until the player next logs in. A double
 * answering "created" would be testing the sentence this app almost never shows.
 */
const waiting = (name: string, icon: number | null, slots: InGameSetSlot[]): SetRequest[] => [{
  id: 1,
  // Tidied by the backend rather than by the window, which is what the window then draws.
  name: name.trim().replace(/\s+/g, " "),
  icon,
  createdAt: 2_100_000_000,
  slots,
}];

const WAITING_FOR_LOGIN
  = "Waiting for Deeps run to be saved — it goes in next time you log that account in.";

/** The panel over doubles a test answers; nothing here talks to a backend. */
function panel(
  outfit: Outfit,
  actions: Partial<SaveActions> = {},
) {
  const onSendToGame = vi.fn(actions.onSendToGame
    ?? ((name: string, icon: number | null, slots: InGameSetSlot[]) =>
      Promise.resolve(waiting(name, icon, slots))));
  const onSave = vi.fn(actions.onSave ?? (() => Promise.resolve({ sets: [] })));
  const stage: ModelStage = {
    show: () => Promise.resolve(),
    resetCamera: () => {},
    dispose: () => {},
  } as ModelStage;
  render(
    <OutfitPanel
      outfit={outfit}
      save={{
        onSendToGame,
        onSave,
        sets: actions.sets ?? [],
        onSaved: actions.onSaved ?? (() => {}),
        onError: actions.onError ?? ((error: unknown) => String(error)),
      }}
      // Who she is, which this panel draws above the outfit and these tests are not about.
      // Nobody, answering nothing: the panel asks once when it opens and the pending promise
      // leaves the section drawing its own empty state, out of the way of the form below it.
      herself={{
        load: () => new Promise(() => {}),
        save: () => new Promise(() => {}),
        onChanged: () => {},
        onError: String,
      }}
      look=""
      onTakeOff={() => {}}
      onClearAll={() => {}}
      loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
      loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
      icons={new Map()}
      createStage={() => stage}
    />,
  );
  return { onSendToGame, onSave };
}

const nameBox = (): HTMLInputElement =>
  screen.getByRole("textbox", { name: "Name for this set" });
const send = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "Send to the game" });

/**
 * Everything the form is currently saying, as the live regions it says it through.
 *
 * Two of them are on screen at once — the pane's own note about the body it is drawing, and
 * the line under the buttons — and which is which is not what any of this is about.
 */
const said = (): string[] => screen.getAllByRole("status").map((one) => one.textContent ?? "");

describe("sending an outfit to the game", () => {
  // The whole errand: what she has on, under the name in the box, as the *game's* idea of an
  // outfit rather than this app's. The slots are the game's numbering and the picture is the
  // one the set will wear in the client's own list.
  it("hands over the name, the picture and the slots the game understands", async () => {
    const { onSendToGame } = panel(dressedIn(HELM, ROBE));

    fireEvent.change(nameBox(), { target: { value: "  Deeps  run " } });
    fireEvent.click(send());

    await waitFor(() => expect(onSendToGame).toHaveBeenCalledTimes(1));
    // The name as it was typed, because tidying it is the backend's job and a window that
    // tidied it differently would send one name and draw another.
    expect(onSendToGame).toHaveBeenCalledWith("  Deeps  run ", 130_001, [
      { slot: 0, appearanceId: 80_001 },
      { slot: 3, appearanceId: 80_003 },
    ]);
  });

  // And the answer is drawn from what came back rather than from the click, which is the whole
  // reason it is a sentence and not a tick: nothing here reaches a running game, and a reader
  // who is not told so goes looking in the game for something that is not there yet.
  it("says the request is waiting for the next login", async () => {
    panel(dressedIn(HELM, ROBE));

    fireEvent.change(nameBox(), { target: { value: "  Deeps  run " } });
    fireEvent.click(send());

    await waitFor(() => expect(said()).toContain(WAITING_FOR_LOGIN));
  });

  // A stray click on an empty box is not a request. The backend refuses one too, but a refusal
  // that arrives as "Give the set a name" for a button nobody meant to press is an error where
  // there was no mistake — so nothing crosses the bridge at all.
  it.each<[string, string]>([
    ["a box nobody has filled in", ""],
    ["one holding nothing but spaces", "   "],
  ])("sends nothing for %s", async (_what, typed) => {
    const { onSendToGame } = panel(dressedIn(HELM, ROBE));

    fireEvent.change(nameBox(), { target: { value: typed } });
    fireEvent.click(send());

    await waitFor(() => expect(nameBox().value).toBe(typed));
    expect(onSendToGame).not.toHaveBeenCalled();
    expect(said()).not.toContain(WAITING_FOR_LOGIN);
  });

  // Enter in the name box is the ordinary save, which is why the send is a `type="button"` in
  // a form whose submit is the other one. Sending an outfit into somebody's WoW account is not
  // what a stray keypress should do.
  it("leaves submitting the form to the save beside it", async () => {
    const { onSave, onSendToGame } = panel(dressedIn(HELM, ROBE));

    fireEvent.change(nameBox(), { target: { value: "Deeps run" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a set" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSendToGame).not.toHaveBeenCalled();
  });

  // Nothing on her is not a disabled button, because the form it is in is not there either:
  // a form that could do nothing but refuse is worse than no form, and the line under the
  // panel already says there is nothing on yet.
  it("offers no way to send a character who is wearing nothing", async () => {
    panel(NOTHING_ON);

    await waitFor(() => expect(said().join(" ")).toContain("Nothing is worn"));
    expect(screen.queryByRole("button", { name: "Send to the game" })).toBeNull();
  });

  // The other emptiness, and the one the button's own guard is for: something is on her, so
  // there is a form, and the game has nowhere to keep any of it. Sending would be a request
  // naming no slots, which the backend refuses — so the button says so before the click.
  it("will not send an outfit the game has nowhere to keep", () => {
    panel(forced({ "hand-right": ARROWS }));

    expect(send()).toHaveProperty("disabled", true);
  });

  // A send that will not go through says why, where the answer would have gone. The reason is
  // the backend's own words — the caller decides how to read an error — and it is an alert
  // rather than a status, because a reader who has been told nothing happened is being
  // interrupted rather than kept informed.
  it("says why a send was refused", async () => {
    panel(dressedIn(HELM, ROBE), {
      onSendToGame: () => Promise.reject(new Error("Chronie has not read that account yet.")),
      onError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    });

    fireEvent.change(nameBox(), { target: { value: "Deeps run" } });
    fireEvent.click(send());

    const shown = await screen.findByRole("alert");
    expect(shown.textContent).toBe("Chronie has not read that account yet.");
    // And the box still holds what was typed, so the reader can try it again rather than
    // rebuild the name they just lost.
    expect(nameBox().value).toBe("Deeps run");
    expect(said()).not.toContain(WAITING_FOR_LOGIN);
  });
});
