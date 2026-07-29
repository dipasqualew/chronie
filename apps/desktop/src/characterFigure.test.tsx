import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CharacterFigure } from "./characterFigure";
import type { GalleryStage } from "./galleryStage";
import { ANY_CLASS } from "./transmogModal";
import type {
  InGameSet, InGameSetAppearancesPayload, TransmogAppearance, WornPiece, WornSetPayload,
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
  modifiedAppearanceId: 71_002, itemId: 30_002, name: "Tideglass Mantle", appearanceId: 80_002,
  displayType: 1, inventoryType: 3, displayInfoId: 900_002,
});
/** A row the game encrypts, which has no place on a body and nothing to draw. */
const WITHHELD = appearance({
  modifiedAppearanceId: 71_009, itemId: 0, name: "", appearanceId: 0,
  displayType: 0, inventoryType: 0, displayInfoId: 0, iconFileDataId: 0, hasModel: false,
});

const TIDEGLASS: InGameSet = {
  id: 4,
  name: "Tideglass",
  icon: 130_001,
  observedAt: null,
  slots: [{ slot: 0, appearanceId: 71_001 }, { slot: 1, appearanceId: 71_002 }],
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

/** A stage that paints nothing, so the tests need no WebGL and no `.glb` to parse. */
const stage = (): GalleryStage => ({
  paint: () => Promise.resolve(),
  dispose: () => {},
}) as unknown as GalleryStage;

interface Shown {
  loadAppearances: ReturnType<typeof vi.fn>;
  loadWorn: ReturnType<typeof vi.fn>;
}

function show(
  sets: InGameSet[] | null,
  {
    drawn = { model: GLB } as WornSetPayload,
    appearances = CONTENTS,
    failWith,
  }: {
    drawn?: WornSetPayload;
    appearances?: Record<string, InGameSetAppearancesPayload>;
    failWith?: string;
  } = {},
): Shown {
  const loadAppearances = vi.fn((ids: number[]) => (failWith
    ? Promise.reject(new Error(failWith))
    : Promise.resolve(appearances[ids.join(",")]
      ?? { appearances: [], readCount: 0, withheldCount: 0 })));
  const loadWorn = vi.fn((_character: string, _pieces: WornPiece[]) => Promise.resolve(drawn));
  render(
    <CharacterFigure
      character="Aster-Vale" sets={sets}
      loadAppearances={loadAppearances} loadWorn={loadWorn} createGalleryStage={stage}
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
    show([TIDEGLASS], { drawn: { model: null } });

    await expect(
      screen.findByText(/holds nothing to draw this set/),
    ).resolves.toBeTruthy();
  });

  /**
   * Which is the failure a reader on a machine with no game installed meets on every character,
   * and a blank frame would read as a bug in Chronie rather than as an app with no game to read.
   */
  it("says why out loud when the game's files cannot be reached", async () => {
    show([TIDEGLASS], { failWith: "The game folder has not been chosen." });

    await expect(
      screen.findByText("The game folder has not been chosen."),
    ).resolves.toBeTruthy();
  });
});
