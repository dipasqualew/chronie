import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REASONS } from "./modelPreview";
import { TransmogView } from "./transmogView";
import type { ModelStage } from "./modelViewer";
import type {
  TransmogAppearance, TransmogPayload, TransmogSet, TransmogSetItemsPayload, WornPiece,
} from "./types";

afterEach(cleanup);

const set = (fields: Partial<TransmogSet> & Pick<TransmogSet, "id" | "name">): TransmogSet => ({
  group: "Tideglass Wardrobe",
  groupId: 1,
  classMask: 0,
  expansionId: 3,
  parentId: 0,
  flags: 0,
  uiOrder: 0,
  patchIntroduced: 0,
  itemCount: 2,
  ...fields,
});

const appearance = (fields: Partial<TransmogAppearance> = {}): TransmogAppearance => ({
  modifiedAppearanceId: 1,
  itemId: 5001,
  name: "A thing",
  appearanceId: 11,
  displayType: 3,
  inventoryType: 0,
  displayInfoId: 900_012,
  iconFileDataId: 0,
  hasModel: false,
  ...fields,
});

const HELM = appearance({
  appearanceId: 1, itemId: 1, name: "Crown of Tides",
  displayType: 0, displayInfoId: 900_001, hasModel: true,
});
const ROBE = appearance({
  appearanceId: 2, itemId: 2, name: "Robe of Tides", displayType: 3, displayInfoId: 900_012,
});
const OTHER_HELM = appearance({
  appearanceId: 3, itemId: 3, name: "Emberforge Helm",
  displayType: 0, displayInfoId: 900_099, hasModel: true,
});
/** Arrows: the game files them under a weapon slot and nobody holds them. */
const ARROWS = appearance({
  appearanceId: 4, itemId: 4, name: "A quiver of arrows", displayType: 11, inventoryType: 24,
});

const SETS: TransmogPayload = {
  sets: [
    set({ id: 201, name: "Tideglass Regalia", classMask: 0x0190 }),
    set({ id: 203, name: "Emberforge Plate", group: "Emberforge Armory", classMask: 0x0023, expansionId: 4 }),
  ],
  readCount: 2,
  declaredCount: 2,
  withheldCount: 0,
};

const CONTENTS: Record<number, TransmogSetItemsPayload> = {
  201: { setId: 201, appearances: [HELM, ROBE, ARROWS], readCount: 3, withheldCount: 0 },
  203: { setId: 203, appearances: [OTHER_HELM], readCount: 1, withheldCount: 0 },
};

/**
 * A stage that records what it was handed, which is the only thing worth asserting about the
 * 3D pane here: whether a body reached it, and how many times.
 */
function fakeStage() {
  const shown: number[] = [];
  const stage: ModelStage = {
    show: (bytes: Uint8Array) => {
      shown.push(bytes.byteLength);
      return Promise.resolve();
    },
    dispose: () => {},
  } as ModelStage;
  return { stage, shown };
}

/** A `.glb` in a data URL, the shape the backend hands one over in. */
const model = (body: string): string => `data:model/gltf-binary;base64,${btoa(body)}`;

/**
 * The view over doubles a test answers, which is the only way to drive it: nothing here talks
 * to a backend and nothing monkey patches one.
 */
function view(options: { payload?: TransmogPayload | null } = {}) {
  const { stage, shown } = fakeStage();
  // Recorded rather than merely answered: "the same outfit is not read out of the game twice"
  // is a statement about what crossed the bridge, and only the request itself can say it.
  const loadWorn = vi.fn((_pieces: WornPiece[]) =>
    Promise.resolve({ model: model("a dressed body") }));
  const loadCharacter = vi.fn(() => Promise.resolve({ model: model("a bare body") }));
  const loadSet = vi.fn((setId: number) =>
    Promise.resolve(CONTENTS[setId] ?? { setId, appearances: [], readCount: 0, withheldCount: 0 }));
  const rendered = render(
    <TransmogView
      payload={options.payload === undefined ? SETS : options.payload}
      status="Reading the game's transmog tables…"
      loadSet={loadSet}
      loadIcons={() => Promise.resolve({ icons: {} })}
      loadCharacter={loadCharacter}
      loadWorn={loadWorn}
      createStage={() => stage}
    />,
  );
  return { rendered, loadWorn, loadCharacter, loadSet, shown };
}

/** Opens a set in place, and waits for what it holds to arrive. */
async function open(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name }));
  const card = screen.getByRole("button", { name }).closest("article");
  if (!card) throw new Error(`${name} has no card`);
  await waitFor(() => expect(within(card).getAllByRole("listitem").length).toBeGreaterThan(0));
  return card as HTMLElement;
}

/** What the outfit list says is on, by slot and item. */
function worn(): string[] {
  const list = document.querySelector("#outfit-list");
  if (!list) return [];
  return [...list.querySelectorAll(".outfit-slot")].map((slot) =>
    `${slot.querySelector(".outfit-where")?.textContent} ${slot.querySelector(".outfit-item")?.textContent}`);
}

describe("TransmogView", () => {
  it("says what it is doing while the game's tables are being read", () => {
    view({ payload: null });
    expect(screen.getByText("Reading the game's transmog tables…")).toBeTruthy();
  });

  // The character is there before anything has been picked, which is the whole point of the
  // redesign: the body is the view rather than something a dialog opens over it.
  it("opens on the bare character, before any set has been touched", async () => {
    const { loadCharacter, loadWorn, shown } = view();
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(loadCharacter).toHaveBeenCalledTimes(1);
    expect(loadWorn).not.toHaveBeenCalled();
    expect(document.querySelector("#outfit-summary")?.textContent)
      .toBe("Nothing on yet. Pick an appearance from any set.");
  });

  it("opens a set in place and lists what the game says it is made of", async () => {
    view();
    const card = await open("Tideglass Regalia");
    expect(within(card).getByText("Crown of Tides")).toBeTruthy();
    expect(within(card).getByText("Robe of Tides")).toBeTruthy();
    // The set beside it stays closed, and its contents were never asked for.
    expect(screen.queryByText("Emberforge Helm")).toBeNull();
  });

  it("reads a set once however many times it is opened and closed", async () => {
    const { loadSet } = view();
    await open("Tideglass Regalia");
    fireEvent.click(screen.getByRole("button", { name: "Tideglass Regalia" }));
    await open("Tideglass Regalia");
    expect(loadSet).toHaveBeenCalledTimes(1);
  });

  // The acceptance: an appearance clicked in a set goes onto the body, and the body is redrawn
  // with it on rather than the set being replaced by a preview of it.
  it("puts an appearance on the character when it is picked", async () => {
    const { loadWorn } = view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Crown of Tides" }));

    await waitFor(() => expect(worn()).toEqual(["Head Crown of Tides"]));
    expect(loadWorn).toHaveBeenLastCalledWith([
      { displayInfoId: 900_001, displayType: 0, inventoryType: 0 },
    ]);
  });

  // A set is a set of clothes, and looking at all of it at once is the ordinary thing to want.
  it("puts a whole set on in one go", async () => {
    const { loadWorn } = view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear all of Tideglass Regalia" }));

    // The arrows in that set have nowhere on a body to go, so two of its three rows go on.
    await waitFor(() => expect(worn()).toEqual(["Head Crown of Tides", "Chest Robe of Tides"]));
    expect(loadWorn).toHaveBeenLastCalledWith([
      { displayInfoId: 900_001, displayType: 0, inventoryType: 0 },
      { displayInfoId: 900_012, displayType: 3, inventoryType: 0 },
    ]);
  });

  // Clicking a row a second time is how one piece comes off without going to the list beside
  // the character.
  it("takes a piece off again when its own row is clicked twice", async () => {
    view();
    const card = await open("Tideglass Regalia");
    const helm = within(card).getByRole("button", { name: "Wear Head: Crown of Tides" });
    fireEvent.click(helm);
    await waitFor(() => expect(worn()).toHaveLength(1));
    fireEvent.click(helm);
    await waitFor(() => expect(worn()).toEqual([]));
  });

  // And the other half of it: pieces out of two different sets, on one body at once, with both
  // sets still open behind them. This is what a modal made the hard way round.
  it("keeps pieces taken out of different sets on at the same time", async () => {
    view();
    const tideglass = await open("Tideglass Regalia");
    fireEvent.click(within(tideglass).getByRole("button", { name: "Wear Chest: Robe of Tides" }));
    const emberforge = await open("Emberforge Plate");
    fireEvent.click(within(emberforge).getByRole("button", { name: "Wear Head: Emberforge Helm" }));

    await waitFor(() => expect(worn()).toEqual(["Head Emberforge Helm", "Chest Robe of Tides"]));
    // Both sets are still open, which is what made picking from each of them possible.
    expect(within(tideglass).getByText("Robe of Tides")).toBeTruthy();
    expect(within(emberforge).getByText("Emberforge Helm")).toBeTruthy();
  });

  it("swaps rather than stacks when a second thing is picked for the same place", async () => {
    view();
    const tideglass = await open("Tideglass Regalia");
    fireEvent.click(within(tideglass).getByRole("button", { name: "Wear Head: Crown of Tides" }));
    const emberforge = await open("Emberforge Plate");
    fireEvent.click(within(emberforge).getByRole("button", { name: "Wear Head: Emberforge Helm" }));

    await waitFor(() => expect(worn()).toEqual(["Head Emberforge Helm"]));
  });

  it("takes one piece off and leaves the rest on", async () => {
    view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Crown of Tides" }));
    fireEvent.click(within(card).getByRole("button", { name: "Wear Chest: Robe of Tides" }));
    await waitFor(() => expect(worn()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Take off Crown of Tides" }));
    await waitFor(() => expect(worn()).toEqual(["Chest Robe of Tides"]));
  });

  it("takes it all off at once", async () => {
    view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Crown of Tides" }));
    await waitFor(() => expect(worn()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Take it all off" }));
    await waitFor(() => expect(worn()).toEqual([]));
  });

  // Assembling a body is a read of the game's own storage, and a reader trying hats goes back
  // and forth over the same handful of outfits.
  it("does not read the same outfit out of the game twice", async () => {
    const { loadWorn, loadCharacter } = view();
    const card = await open("Tideglass Regalia");
    const helm = within(card).getByRole("button", { name: "Wear Head: Crown of Tides" });
    fireEvent.click(helm);
    await waitFor(() => expect(worn()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Take off Crown of Tides" }));
    await waitFor(() => expect(worn()).toEqual([]));
    fireEvent.click(helm);
    await waitFor(() => expect(worn()).toHaveLength(1));

    // The helm went on twice and was read once; the bare body was gone back to and read once.
    expect(loadWorn).toHaveBeenCalledTimes(1);
    expect(loadCharacter).toHaveBeenCalledTimes(1);
  });

  // An appearance the body has nowhere to put says so, rather than being a button that does
  // nothing when clicked.
  it("will not put on something there is nowhere on the body for", async () => {
    view();
    const card = await open("Tideglass Regalia");
    const arrows = within(card).getByRole("button", { name: "Wear Ammo: A quiver of arrows" });
    expect(arrows).toHaveProperty("disabled", true);
    expect(within(card).getByText(REASONS.nowhere)).toBeTruthy();
  });

  it("says so when a set will not come", async () => {
    const { stage } = fakeStage();
    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={() => Promise.reject(new Error("The game keeps that one encrypted."))}
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        createStage={() => stage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tideglass Regalia" }));
    await screen.findByText("The game keeps that one encrypted.");
  });

  // A machine with no working 3D — a remote desktop, a virtual machine, a blocklisted driver
  // — still has a wardrobe worth browsing, so the failure is a sentence rather than the view.
  it("keeps the sets and the list when the body will not draw", async () => {
    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={(setId) => Promise.resolve(CONTENTS[setId] as TransmogSetItemsPayload)}
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        createStage={() => { throw new Error("This machine cannot draw 3D."); }}
      />,
    );
    await screen.findByText("This machine cannot draw 3D.");
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Crown of Tides" }));
    await waitFor(() => expect(worn()).toEqual(["Head Crown of Tides"]));
  });

  it("narrows the sets by everything the game says about them", async () => {
    view();
    fireEvent.change(screen.getByLabelText("Filter transmog sets"), { target: { value: "plate" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Tideglass Regalia" })).toBeNull());
    expect(screen.getByRole("button", { name: "Emberforge Plate" })).toBeTruthy();
  });
});
