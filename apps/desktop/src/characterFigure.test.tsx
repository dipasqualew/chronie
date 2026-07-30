import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CharacterFigure } from "./characterFigure";
import type { ModelStage } from "./modelViewer";
import type { MakeStage } from "./stage";
import { ANY_CLASS } from "./transmogModal";
import type {
  CharacterWornSetPayload,
  InGameSet,
  InGameSetAppearancesPayload,
  TransmogAppearance,
  WornPiece,
} from "./types";

afterEach(cleanup);

const appearance = (fields: Partial<TransmogAppearance> = {}): TransmogAppearance => ({
  modifiedAppearanceId: 71_001,
  itemId: 30_001,
  name: "Tideglass Crown",
  appearanceId: 80_001,
  displayType: 0,
  inventoryType: 1,
  allowableClass: ANY_CLASS,
  requiredLevel: 0,
  quality: 4,
  displayInfoId: 900_001,
  iconFileDataId: 130_001,
  hasModel: true,
  ...fields,
});

const CROWN = appearance();
const MANTLE = appearance({
  modifiedAppearanceId: 71_002,
  itemId: 30_002,
  name: "Tideglass Mantle",
  appearanceId: 80_002,
  displayType: 1,
  inventoryType: 3,
  displayInfoId: 900_002,
});
/** A row the game encrypts, which has no place on a body and nothing to draw. */
const WITHHELD = appearance({
  modifiedAppearanceId: 71_009,
  itemId: 0,
  name: "",
  appearanceId: 0,
  displayType: 0,
  inventoryType: 0,
  displayInfoId: 0,
  iconFileDataId: 0,
  hasModel: false,
});

const TIDEGLASS: InGameSet = {
  id: 4,
  name: "Tideglass",
  icon: 130_001,
  observedAt: null,
  slots: [
    { slot: 0, appearanceId: 71_001 },
    { slot: 1, appearanceId: 71_002 },
  ],
};
const EMBERFORGE: InGameSet = {
  id: 6,
  name: "Emberforge",
  icon: null,
  observedAt: null,
  slots: [{ slot: 0, appearanceId: 71_009 }],
};
/** A set the player made this afternoon and has not filled, which nobody can wear. */
const EMPTY: InGameSet = { id: 5, name: "", icon: null, observedAt: null, slots: [] };

const CONTENTS: Record<string, InGameSetAppearancesPayload> = {
  "71001,71002": { appearances: [CROWN, MANTLE], readCount: 2, withheldCount: 0 },
  "71009": { appearances: [WITHHELD], readCount: 0, withheldCount: 1 },
};

const GLB = "data:model/gltf-binary;base64,AAAA";

/** The body drawn on a character the addon has read at a barber's chair, which is the good case. */
const HERSELF: CharacterWornSetPayload = { model: GLB, likeness: "themselves" };

/**
 * A stage that draws nothing, so the tests need no WebGL and no `.glb` to parse.
 *
 * It names its canvas the way `createModelStage` does, because that is the whole of what anything
 * outside the pane can see of what is on it — and what the assertions below are written against.
 */
const stage =
  (): MakeStage =>
  (container: HTMLElement, label?: string): ModelStage => {
    const canvas = container.ownerDocument.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label ?? "The model, drawn");
    container.replaceChildren(canvas);
    return {
      show: () => Promise.resolve(),
      resetCamera: () => {},
      dispose: () => {},
    };
  };

interface Shown {
  loadAppearances: ReturnType<typeof vi.fn>;
  loadWorn: ReturnType<typeof vi.fn>;
}

function show(
  sets: InGameSet[] | null,
  {
    drawn = HERSELF,
    appearances = CONTENTS,
    failWith,
    createStage = stage(),
  }: {
    drawn?: CharacterWornSetPayload;
    appearances?: Record<string, InGameSetAppearancesPayload>;
    failWith?: string;
    createStage?: MakeStage;
  } = {},
): Shown {
  const loadAppearances = vi.fn((ids: number[]) =>
    failWith
      ? Promise.reject(new Error(failWith))
      : Promise.resolve(
          appearances[ids.join(",")] ?? { appearances: [], readCount: 0, withheldCount: 0 },
        ),
  );
  const loadWorn = vi.fn((_character: string, _pieces: WornPiece[]) => Promise.resolve(drawn));
  render(
    <CharacterFigure
      character="Aster-Vale"
      sets={sets}
      loadAppearances={loadAppearances}
      loadWorn={loadWorn}
      createStage={createStage}
    />,
  );
  return { loadAppearances, loadWorn };
}

describe("CharacterFigure", () => {
  /**
   * The whole point of the pane: the wearer is already decided, so the request carries who they
   * are and the backend resolves their body. Everywhere else in the app a look is being chosen
   * and is drawn on the person the reader assembled.
   */
  it("asks for the outfit on the body of the character whose page it is", async () => {
    const shown = show([TIDEGLASS]);

    await waitFor(() => expect(shown.loadWorn).toHaveBeenCalled());
    expect(shown.loadWorn).toHaveBeenCalledWith("Aster-Vale", [
      { displayInfoId: 900_001, displayType: 0, inventoryType: 1 },
      { displayInfoId: 900_002, displayType: 1, inventoryType: 3 },
    ]);
  });

  it("draws the character wearing the set, named by both", async () => {
    show([TIDEGLASS]);

    await expect(
      screen.findByRole("img", { name: "Aster-Vale wearing Tideglass, drawn" }),
    ).resolves.toBeTruthy();
  });

  /** A set with nothing in it is not something to wear, so it is not on the list. */
  it("leaves an empty set off the picker and opens on one that can be worn", async () => {
    show([EMPTY, TIDEGLASS]);

    await waitFor(() => expect(screen.getByText(/Wearing Tideglass/)).toBeTruthy());
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("offers the sets a character has more than one of, and redraws on the one picked", async () => {
    const shown = show([TIDEGLASS, EMBERFORGE]);
    await waitFor(() => expect(shown.loadWorn).toHaveBeenCalled());

    fireEvent.change(screen.getByRole("combobox", { name: "Wearing" }), {
      target: { value: String(EMBERFORGE.id) },
    });

    await waitFor(() => expect(shown.loadAppearances).toHaveBeenCalledWith([71_009]));
  });

  /** Flipping back to a set already looked at costs the game's tables nothing a second time. */
  it("reads each set once while the character is the one on screen", async () => {
    const shown = show([TIDEGLASS, EMBERFORGE]);
    await waitFor(() => expect(shown.loadAppearances).toHaveBeenCalledTimes(1));
    const picker = screen.getByRole("combobox", { name: "Wearing" });

    fireEvent.change(picker, { target: { value: String(EMBERFORGE.id) } });
    await waitFor(() => expect(shown.loadAppearances).toHaveBeenCalledTimes(2));
    fireEvent.change(picker, { target: { value: String(TIDEGLASS.id) } });

    await waitFor(() => expect(screen.getByText(/Wearing/)).toBeTruthy());
    expect(shown.loadAppearances).toHaveBeenCalledTimes(2);
  });

  /**
   * Chronie has never looked at this character's wardrobe, which is a question the app has not
   * asked rather than one the game answered — and a frame saying nothing is worse than no frame.
   */
  it("says nothing at all where no wardrobe has ever been read", () => {
    const shown = show(null);

    expect(screen.queryByRole("figure")).toBeNull();
    expect(shown.loadAppearances).not.toHaveBeenCalled();
  });

  it("says so where the character saves nothing in game", () => {
    show([]);

    expect(screen.getByText(/No transmog sets saved in game/)).toBeTruthy();
  });

  /** Every piece of the set is one the game gives no place on a body. */
  it("says so where nothing in the set can be worn", async () => {
    show([EMBERFORGE]);

    await expect(
      screen.findByText("Nothing in this set can be worn on a character."),
    ).resolves.toBeTruthy();
  });

  /** The pieces have places and this install has no model to put in them. */
  it("says so where the install can draw the set on nobody", async () => {
    show([TIDEGLASS], { drawn: { model: null, likeness: "race" } });

    await expect(screen.findByText(/holds nothing to draw this set/)).resolves.toBeTruthy();
  });

  /**
   * The fault behind #222, as a reader met it.
   *
   * The backend used to fall back to the *reader's* own invented body for a character it could not
   * recognise, so a page whose whole job is "who is this" answered it with a stranger and said
   * nothing at all about having done so. On the machine that reported it, no character had ever
   * had a look stored, which made that every character on the roster.
   */
  it("draws nobody, and says so, where it has not read who the character is", async () => {
    show([TIDEGLASS], { drawn: { model: null, likeness: "nobody" } });

    await expect(
      screen.findByText(/Chronie has not read who Aster-Vale is yet/),
    ).resolves.toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  /**
   * Most of a roster, and the other half of #222's third complaint: the race is readable wherever
   * a character is standing and their colouring is only readable at a barber's chair, so the body
   * is the right shape at the game's own default skin. That is worth drawing and it is worth
   * saying, because a reader who is not told reads the default skin as Chronie being wrong.
   */
  it("says the colouring is the game's own where only the race has been read", async () => {
    show([TIDEGLASS], { drawn: { model: GLB, likeness: "race" } });

    await expect(
      screen.findByText(/at the colours the game itself opens on/),
    ).resolves.toBeTruthy();
  });

  /** And says nothing of the sort about a character the addon caught at a barber's chair. */
  it("says nothing about colouring for a character read as themselves", async () => {
    show([TIDEGLASS]);

    await screen.findByRole("img", { name: "Aster-Vale wearing Tideglass, drawn" });
    expect(screen.queryByText(/at the colours the game itself opens on/)).toBeNull();
  });

  /**
   * A live pane, not a gallery tile — the other half of #222.
   *
   * A gallery stage draws a 256-pixel bitmap onto a plain 2D canvas because a grid cannot afford
   * twenty WebGL contexts; a portrait is one picture and can afford the real thing, which is what
   * makes it big, sharp, and a model rather than a bitmap when the reader drags it. The observable
   * difference is that it is the app's one live stage doing the drawing, and that it offers the way
   * back out of a drag that only a live camera has.
   */
  it("draws on the app's own live pane, with a way back out of a drag", async () => {
    const made: string[] = [];
    const reset = vi.fn();
    const createStage: MakeStage = (container, label) => {
      made.push(label ?? "");
      container.replaceChildren(container.ownerDocument.createElement("canvas"));
      return { show: () => Promise.resolve(), resetCamera: reset, dispose: () => {} };
    };
    show([TIDEGLASS], { createStage });

    const back = await screen.findByRole("button", { name: "Reset camera" });
    fireEvent.click(back);

    expect(made).toEqual(["Aster-Vale wearing Tideglass, drawn"]);
    expect(reset).toHaveBeenCalled();
  });

  /**
   * A machine with no working 3D at all — a remote desktop, a virtual machine, a driver the
   * browser has blocklisted — is told why rather than shown an empty rectangle.
   */
  it("says why out loud when the pane cannot be made at all", async () => {
    const createStage: MakeStage = () => Promise.reject(new Error("WebGL is not available here."));
    show([TIDEGLASS], { createStage });

    await expect(screen.findByText("WebGL is not available here.")).resolves.toBeTruthy();
  });

  /**
   * Which is the failure a reader on a machine with no game installed meets on every character,
   * and a blank frame would read as a bug in Chronie rather than as an app with no game to read.
   */
  it("says why out loud when the game's files cannot be reached", async () => {
    show([TIDEGLASS], { failWith: "The game folder has not been chosen." });

    await expect(screen.findByText("The game folder has not been chosen.")).resolves.toBeTruthy();
  });
});
