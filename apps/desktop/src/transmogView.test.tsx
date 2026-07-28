import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REASONS } from "./modelPreview";
import { TransmogView } from "./transmogView";
import type { TransmogViewProps } from "./transmogView";
import type { ModelStage } from "./modelViewer";
import type {
  MarkSubjectKind, TransmogAppearance, TransmogMark, TransmogMarksPayload, TransmogPayload,
  TransmogSet, TransmogSetItemsPayload, WardrobeAppearance, WardrobePayload, WornPiece,
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
  allowableClass: 0xffff,
  requiredLevel: 0,
  quality: 4,
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
/**
 * An appearance the game encrypts: no item behind it, so no name, no slot and nothing to look
 * up. The other way there is nowhere on her to put a row, and the only one with no id to link.
 */
const WITHHELD = appearance({
  appearanceId: 0, itemId: 0, name: "", displayType: 0, displayInfoId: 0,
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

/** One look out of the game's whole wardrobe, with only what a test cares about spelled out. */
const look = (
  fields: Partial<WardrobeAppearance> & Pick<WardrobeAppearance, "appearanceId" | "name">,
): WardrobeAppearance => ({
  itemId: 7000 + fields.appearanceId,
  displayType: 0,
  inventoryType: 1,
  classId: 4,
  subclassId: 1,
  allowableClass: 0xffff,
  requiredLevel: 0,
  quality: 4,
  displayInfoId: 900_001,
  iconFileDataId: 0,
  hasModel: true,
  itemCount: 1,
  liftsRestriction: false,
  ...fields,
});

/**
 * What the game holds for two kinds of place, as the other half of the browser reads them.
 *
 * The heads are the point of browsing this way: the Coif belongs to no set, so nothing in the
 * grid beside it could reach that look at all. The things held in a hand are one answer
 * covering five display types, which is what the kinds cut up — a staff and a two-handed
 * sword are both filed under 11, and only the item's own subclass separates them.
 */
const WARDROBE: Record<string, WardrobePayload> = {
  "0": {
    displayTypes: [0],
    readCount: 2,
    withheldCount: 1,
    appearances: [
      look({ appearanceId: 40, name: "Coif of the Drowned Star", displayInfoId: 900_040 }),
      // The same look set 203 holds, which is what says both halves dress one character.
      look({ appearanceId: 3, name: "Emberforge Helm", displayInfoId: 900_099, itemCount: 3, liftsRestriction: true }),
    ],
  },
  // A kind the size a real one is: 5,111 heads on a shipping install, and a list that drew
  // all of them would be forty screens of buttons nobody asked for.
  "3": {
    displayTypes: [3],
    readCount: 120,
    withheldCount: 0,
    appearances: Array.from({ length: 120 }, (_, index) => look({
      appearanceId: 500 + index,
      // Numbered so the order is legible: the backend sorts by name and this is what that
      // looks like when a kind holds more than a page of them.
      name: `Robe ${String(index).padStart(3, "0")}`,
      displayType: 3,
      inventoryType: 5,
      displayInfoId: 901_000 + index,
    })),
  },
  "11,12,13,14,15": {
    displayTypes: [11, 12, 13, 14, 15],
    readCount: 3,
    withheldCount: 0,
    appearances: [
      look({
        appearanceId: 41, name: "Emberforge Blade", displayType: 11, inventoryType: 13,
        classId: 2, subclassId: 7, displayInfoId: 900_007,
      }),
      look({
        appearanceId: 42, name: "Staff of the Quiet Tide", displayType: 11, inventoryType: 17,
        classId: 2, subclassId: 10, displayInfoId: 900_014,
      }),
      // Filed as armour rather than as a weapon, so a picker reading the display type alone
      // would have put it among the swords.
      look({
        appearanceId: 43, name: "Emberforge Aegis", displayType: 13, inventoryType: 14,
        classId: 4, subclassId: 6, displayInfoId: 900_015,
      }),
    ],
  },
};

const CONTENTS: Record<number, TransmogSetItemsPayload> = {
  201: { setId: 201, appearances: [HELM, ROBE, ARROWS], readCount: 3, withheldCount: 0 },
  203: { setId: 203, appearances: [OTHER_HELM, WITHHELD], readCount: 1, withheldCount: 1 },
};

/** The one box above the grid, which decides what every open set lists. */
function hideBox(): HTMLElement {
  return screen.getByRole("checkbox", { name: "Hide what she cannot wear" });
}

/** The row a piece is on, which is the thing the button and the link out both live inside. */
function rowFor(card: HTMLElement, name: string): HTMLElement {
  const row = within(card).getByRole("button", { name }).closest("li");
  if (!row) throw new Error(`${name} is on no row`);
  return row as HTMLElement;
}

/**
 * A stage that records what it was handed, which is the only thing worth asserting about the
 * 3D pane here: whether a body reached it, how many times, and whether the button over its
 * corner reached the camera. Where the camera actually ends up is three.js's, and the browser
 * suite is what drives that.
 */
function fakeStage() {
  const shown: number[] = [];
  const resets = { count: 0 };
  const stage: ModelStage = {
    show: (bytes: Uint8Array) => {
      shown.push(bytes.byteLength);
      return Promise.resolve();
    },
    resetCamera: () => { resets.count += 1; },
    dispose: () => {},
  } as ModelStage;
  return { stage, shown, resets };
}

/** A `.glb` in a data URL, the shape the backend hands one over in. */
const model = (body: string): string => `data:model/gltf-binary;base64,${btoa(body)}`;

/**
 * The two tables behind a mark, faked.
 *
 * A store rather than a stub answering fixtures, because the whole contract of marking is
 * "write, then repaint from what was stored": every command answers with *every* mark, and the
 * window holds what came back. A double that answered a fixed payload would let a view that
 * never repainted pass.
 *
 * The rules it keeps are the ones the migration keeps and a test can tell apart from a broken
 * one: a key already there is replaced rather than duplicated whatever its case, a value that
 * says nothing is a label, and a subject left saying nothing has no mark at all.
 */
function fakeMarks(starting: TransmogMark[] = []) {
  let marks = structuredClone(starting);
  const answer = (): TransmogMarksPayload => ({ marks: structuredClone(marks) });
  const edit = (
    kind: MarkSubjectKind, id: number, apply: (mark: TransmogMark) => void,
  ): Promise<TransmogMarksPayload> => {
    let mark = marks.find((one) => one.kind === kind && one.id === id);
    if (!mark) {
      mark = { kind, id, favourite: false, tags: [] };
      marks.push(mark);
    }
    apply(mark);
    if (!mark.favourite && !mark.tags.length) marks = marks.filter((one) => one !== mark);
    return Promise.resolve(answer());
  };
  const same = (left: string, right: string): boolean =>
    left.toLowerCase() === right.trim().toLowerCase();
  return {
    starting: answer(),
    stored: (): TransmogMark[] => structuredClone(marks),
    setFavourite: vi.fn((kind: MarkSubjectKind, id: number, favourite: boolean) =>
      edit(kind, id, (mark) => { mark.favourite = favourite; })),
    setTag: vi.fn((kind: MarkSubjectKind, id: number, key: string, value: string | null) => {
      const cleaned = key.trim();
      if (!cleaned) return Promise.reject(new Error("A tag needs a name."));
      return edit(kind, id, (mark) => {
        const at = mark.tags.findIndex((tag) => same(tag.key, cleaned));
        const written = { key: cleaned, value: (value ?? "").trim() || null };
        if (at >= 0) mark.tags[at] = written;
        else mark.tags.push(written);
        mark.tags.sort((left, right) => left.key.localeCompare(right.key));
      });
    }),
    deleteTag: vi.fn((kind: MarkSubjectKind, id: number, key: string) =>
      edit(kind, id, (mark) => {
        mark.tags = mark.tags.filter((tag) => !same(tag.key, key));
      })),
  };
}

type FakeMarks = ReturnType<typeof fakeMarks>;

/**
 * The view with somewhere for a write's answer to land, which is what `app.tsx` is.
 *
 * The component takes the marks as a prop and never edits them itself, so a test driving a
 * star needs the piece above it that holds the payload. This is that piece and nothing else.
 */
function Marked(
  { store, ...props }: Omit<TransmogViewProps, "marks"> & { store: FakeMarks },
): ReactNode {
  const [payload, setPayload] = useState<TransmogMarksPayload>(store.starting);
  return (
    <TransmogView
      {...props}
      marks={{
        payload,
        setFavourite: store.setFavourite,
        setTag: store.setTag,
        deleteTag: store.deleteTag,
        onApply: setPayload,
        onError: (error) => (error instanceof Error ? error.message : String(error)),
      }}
    />
  );
}

/** Marks nobody can write, for the tests that are about something else entirely. */
const UNMARKED = {
  payload: { marks: [] },
  setFavourite: () => Promise.resolve({ marks: [] }),
  setTag: () => Promise.resolve({ marks: [] }),
  deleteTag: () => Promise.resolve({ marks: [] }),
  onApply: () => {},
  onError: String,
};

/**
 * The view over doubles a test answers, which is the only way to drive it: nothing here talks
 * to a backend and nothing monkey patches one.
 */
function view(options: { payload?: TransmogPayload | null; marks?: FakeMarks } = {}) {
  const { stage, shown, resets } = fakeStage();
  // Recorded rather than merely answered: "the same outfit is not read out of the game twice"
  // is a statement about what crossed the bridge, and only the request itself can say it.
  const loadWorn = vi.fn((_pieces: WornPiece[]) =>
    Promise.resolve({ model: model("a dressed body") }));
  const loadCharacter = vi.fn(() => Promise.resolve({ model: model("a bare body") }));
  const loadSet = vi.fn((setId: number) =>
    Promise.resolve(CONTENTS[setId] ?? { setId, appearances: [], readCount: 0, withheldCount: 0 }));
  // The wardrobe half of the browser, which is not read at all until a reader asks for it —
  // recorded rather than answered, because that is the statement worth making about it.
  const loadAppearances = vi.fn((displayTypes: number[]) =>
    Promise.resolve(WARDROBE[displayTypes.join(",")]
      ?? { displayTypes, appearances: [], readCount: 0, withheldCount: 0 }));
  const marks = options.marks ?? fakeMarks();
  const rendered = render(
    <Marked
      payload={options.payload === undefined ? SETS : options.payload}
      status="Reading the game's transmog tables…"
      loadSet={loadSet}
      loadAppearances={loadAppearances}
      loadIcons={() => Promise.resolve({ icons: {} })}
      loadCharacter={loadCharacter}
      loadWorn={loadWorn}
      store={marks}
      createStage={() => stage}
    />,
  );
  return { rendered, loadWorn, loadCharacter, loadSet, loadAppearances, marks, shown, resets };
}

/** Opens a set in place, and waits for what it holds to arrive. */
async function open(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name }));
  const card = screen.getByRole("button", { name }).closest("article");
  if (!card) throw new Error(`${name} has no card`);
  await waitFor(() => expect(within(card).getAllByRole("listitem").length).toBeGreaterThan(0));
  return card as HTMLElement;
}

/**
 * Switches the browser to the game's whole wardrobe, which is what a reader does when the
 * sets are not where the look they want lives.
 */
async function browseItems(
  already?: ReturnType<typeof view>,
): Promise<ReturnType<typeof view>> {
  const shown = already ?? view();
  fireEvent.click(screen.getByRole("button", { name: "Items" }));
  await waitFor(() => expect(screen.getByLabelText("Kind of appearance")).toBeTruthy());
  return shown;
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

  // The way back from a drag that went too far. It is only offered over a stage with
  // something on it: a pane showing a sentence because the machine has no 3D has no camera
  // to put back, and a button there would be one that does nothing.
  it("offers the camera back only once there is something to look at", async () => {
    const { shown, resets } = view();
    expect(screen.queryByRole("button", { name: "Reset camera" })).toBeNull();

    await waitFor(() => expect(shown).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: "Reset camera" }));
    expect(resets.count).toBe(1);
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

  // A row the game gives no place on a body is a disabled button and an apology in among the
  // pieces it cannot be worn beside, so it is left out — and the count is what keeps a list
  // shorter than the card promised from reading as a bug.
  it("leaves out the rows there is nowhere on her to put, and says how many", async () => {
    view();
    const card = await open("Tideglass Regalia");
    expect(within(card).queryByText("A quiver of arrows")).toBeNull();
    expect(within(card).getByText("1 appearance hidden, with nowhere on her to go")).toBeTruthy();
  });

  // And the box is for the reader who wants to see what a set is really made of, either way
  // round: what it left out comes back, and goes away again.
  it("shows the rows again when asked, and hides them once more when unasked", async () => {
    view();
    const card = await open("Tideglass Regalia");

    fireEvent.click(hideBox());
    expect(within(card).getByText("A quiver of arrows")).toBeTruthy();
    expect(within(card).queryByText(/hidden, with nowhere on her to go/)).toBeNull();

    fireEvent.click(hideBox());
    expect(within(card).queryByText("A quiver of arrows")).toBeNull();
  });

  // It is a statement about what the reader is here for rather than about one card, so a set
  // opened afterwards obeys it too — which a per-card control would have got wrong.
  it("applies to a set opened after it was answered, not only to one already open", async () => {
    view();
    fireEvent.click(hideBox());
    const card = await open("Tideglass Regalia");
    expect(within(card).getByRole("button", { name: "Wear Ammo: A quiver of arrows" }))
      .toBeTruthy();
  });

  // An appearance the body has nowhere to put says so, rather than being a button that does
  // nothing when clicked — once the reader has asked to see it at all.
  it("will not put on something there is nowhere on the body for", async () => {
    view();
    fireEvent.click(hideBox());
    const card = await open("Tideglass Regalia");
    const arrows = within(card).getByRole("button", { name: "Wear Ammo: A quiver of arrows" });
    expect(arrows).toHaveProperty("disabled", true);
    expect(within(card).getByText(REASONS.nowhere)).toBeTruthy();
  });

  // The regression the whole row was rebuilt for. The name is the largest thing on a row and
  // the one a reader aims at, and it used to be the one part that did not dress the character
  // — it was the link out, and only the icon beside it put the piece on.
  it("puts the piece on when the item's own name is clicked", async () => {
    view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByText("Crown of Tides"));
    await waitFor(() => expect(worn()).toEqual(["Head Crown of Tides"]));
  });

  // Leaving the app is the rarer errand of the two, so it is a link in the corner of the row
  // rather than the width of it — and taking it leaves her wearing what she was wearing.
  it("leaves for Wowhead from the end of the row, without undressing her", async () => {
    view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Chest: Robe of Tides" }));
    await waitFor(() => expect(worn()).toEqual(["Chest Robe of Tides"]));

    const row = rowFor(card, "Wear Head: Crown of Tides");
    const link = within(row).getByRole("link", { name: "Crown of Tides on Wowhead" });
    expect(link.getAttribute("href")).toBe("https://www.wowhead.com/item=1");
    expect(row.lastElementChild).toBe(link);

    fireEvent.click(link);
    await waitFor(() => expect(worn()).toEqual(["Chest Robe of Tides"]));
  });

  // There is nothing to look up for an appearance the game encrypts: it has no item behind
  // it, so a link would go to item zero.
  it("gives an appearance the game withholds nothing to look up", async () => {
    view();
    fireEvent.click(hideBox());
    const card = await open("Emberforge Plate");
    const withheld = rowFor(card, "Wear Unknown slot: The game keeps this appearance encrypted");
    expect(within(withheld).queryByRole("link")).toBeNull();
    // Its neighbour has one, so the absence is about this row rather than about the set.
    expect(within(rowFor(card, "Wear Head: Emberforge Helm")).getByRole("link")).toBeTruthy();
  });

  it("says so when a set will not come", async () => {
    const { stage } = fakeStage();
    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={() => Promise.reject(new Error("The game keeps that one encrypted."))}
        loadAppearances={(displayTypes) =>
          Promise.resolve({ displayTypes, appearances: [], readCount: 0, withheldCount: 0 })}
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        marks={UNMARKED}
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
        loadAppearances={(displayTypes) =>
          Promise.resolve({ displayTypes, appearances: [], readCount: 0, withheldCount: 0 })}
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        marks={UNMARKED}
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

  /* ---------- browsing by item rather than by set ---------- */

  // The wardrobe costs the game's storage the same second the sets do, and a reader who never
  // leaves the sets should never pay it.
  it("reads nothing of the wardrobe until the reader asks to see it", async () => {
    const shown = view();
    await waitFor(() => expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy());
    expect(shown.loadAppearances).not.toHaveBeenCalled();

    await browseItems(shown);
    expect(shown.loadAppearances).toHaveBeenCalledWith([0]);
  });

  // The point of the whole half: a look no set names is unreachable from the grid, and here
  // it is the first row.
  it("lists every look the game has for a place, set or no set", async () => {
    await browseItems();
    expect(await screen.findByText("Coif of the Drowned Star")).toBeTruthy();
    expect(screen.getByText("Emberforge Helm")).toBeTruthy();
  });

  // The other point: what the two halves share is the character, so a reader can take a helm
  // out of a set and go looking for a staff without losing it.
  it("keeps the outfit across the switch, and marks what is already on", async () => {
    const shown = view();
    const card = await open("Emberforge Plate");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Emberforge Helm" }));
    await waitFor(() => expect(worn()).toEqual(["Head Emberforge Helm"]));

    await browseItems(shown);
    await screen.findByText("Coif of the Drowned Star");
    // Still on her, and the list says so: the look is the same display however it was reached.
    expect(worn()).toEqual(["Head Emberforge Helm"]);
    expect(screen.getByRole("button", { name: "Wear Head: Emberforge Helm" })
      .getAttribute("aria-pressed")).toBe("true");
  });

  it("puts a look picked out of the wardrobe on the character", async () => {
    const { loadWorn } = await browseItems();
    fireEvent.click(await screen.findByRole("button", { name: "Wear Head: Coif of the Drowned Star" }));

    await waitFor(() => expect(worn()).toEqual(["Head Coif of the Drowned Star"]));
    expect(loadWorn).toHaveBeenLastCalledWith([
      { displayInfoId: 900_040, displayType: 0, inventoryType: 1 },
    ]);
    // And says nothing about a set, because there is no set behind it — the line under the
    // name is where a set's name goes and inventing one would be a line saying nothing.
    expect(document.querySelector("#outfit-list .outfit-what .muted")).toBeNull();
  });

  // The reason the browser reads the item's own subclass at all: the game files a staff and a
  // two-handed sword under one display type, so a picker built on display types could offer
  // neither of them.
  it("picks one kind of weapon out of everything held in a hand", async () => {
    const { loadAppearances } = await browseItems();
    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "weapon-10" } });

    expect(await screen.findByText("Staff of the Quiet Tide")).toBeTruthy();
    expect(screen.queryByText("Emberforge Blade")).toBeNull();
    expect(loadAppearances).toHaveBeenLastCalledWith([11, 12, 13, 14, 15]);

    // And the seventeen kinds of weapon are that one answer: going from staves to swords is a
    // filter over what is already here rather than another second of the game's storage.
    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "weapon-7" } });
    expect(await screen.findByText("Emberforge Blade")).toBeTruthy();
    expect(loadAppearances).toHaveBeenCalledTimes(2);
  });

  // A shield is armour in the game's own filing and sits beside the swords in the same
  // answer, so the kind that finds it is reading the item rather than the slot.
  it("keeps a shield apart from the weapons it arrives with", async () => {
    await browseItems();
    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "shield" } });
    expect(await screen.findByText("Emberforge Aegis")).toBeTruthy();
    expect(screen.queryByText("Emberforge Blade")).toBeNull();
  });

  // A kind of place is thousands of looks, and the button under them is the honest version
  // of an endless scroll: it says how many more there are before it draws any of them.
  it("draws a kind a page at a time and says how much of it is left", async () => {
    await browseItems();
    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "armour-3" } });

    await screen.findByText("Robe 000");
    expect(screen.getByText("100 of 120 appearances")).toBeTruthy();
    expect(screen.queryByText("Robe 100")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show 20 more of 20 appearances" }));
    expect(await screen.findByText("Robe 119")).toBeTruthy();
    expect(screen.getByText("120 appearances")).toBeTruthy();
  });

  it("narrows a kind by name", async () => {
    await browseItems();
    await screen.findByText("Coif of the Drowned Star");
    fireEvent.change(screen.getByLabelText("Filter appearances"), { target: { value: "coif" } });
    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });
});

/**
 * Marking, which is the one thing on this screen that is the reader's rather than the game's.
 *
 * Every one of these drives the same controls a player would and then asks the *store* what it
 * ended up holding, because the contract is that a write goes to the backend and the screen
 * repaints from its answer. A test that only read the screen would pass against a view that
 * lit a star up locally and never stored it, which is exactly the bug worth catching.
 */
describe("what the reader says about the wardrobe", () => {
  /** The star on a card or a row, named by what pressing it would do. */
  const star = (within_: HTMLElement, name: string): HTMLElement =>
    within(within_).getByRole("button", { name: `Favourite ${name}` });

  /** The card a set is shown on, which is where its own star and tags live. */
  const cardFor = (name: string): HTMLElement => {
    const card = screen.getByRole("button", { name }).closest("article");
    if (!card) throw new Error(`${name} has no card`);
    return card as HTMLElement;
  };

  /** Fills in and submits the little form behind "+ tag". */
  const tagIt = (host: HTMLElement, name: string, key: string, value = ""): void => {
    fireEvent.click(within(host).getByRole("button", { name: `Tag ${name}` }));
    fireEvent.change(within(host).getByLabelText(`Tag name for ${name}`), {
      target: { value: key },
    });
    fireEvent.change(within(host).getByLabelText(`Tag value for ${name} (optional)`), {
      target: { value },
    });
    fireEvent.click(within(host).getByRole("button", { name: "Add" }));
  };

  it("stars a set and says so on the card", async () => {
    const { marks } = view();
    const card = cardFor("Tideglass Regalia");

    fireEvent.click(star(card, "Tideglass Regalia"));

    await waitFor(() => expect(marks.stored())
      .toEqual([{ kind: "set", id: 201, favourite: true, tags: [] }]));
    await waitFor(() =>
      expect(star(card, "Tideglass Regalia").getAttribute("aria-pressed")).toBe("true"));
  });

  // Un-starring deletes the row rather than storing a `false`, which is the migration's own
  // rule and the reason a mark saying nothing is no mark at all.
  it("takes a star off again and leaves nothing behind", async () => {
    const { marks } = view({ marks: fakeMarks([{ kind: "set", id: 201, favourite: true, tags: [] }]) });
    const card = cardFor("Tideglass Regalia");
    expect(star(card, "Tideglass Regalia").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(star(card, "Tideglass Regalia"));

    await waitFor(() => expect(marks.stored()).toEqual([]));
  });

  it("writes a tag with a value, and one without as a label", async () => {
    const { marks } = view();
    const card = cardFor("Tideglass Regalia");

    tagIt(card, "Tideglass Regalia", "faction", "horde");
    await waitFor(() => expect(marks.stored()[0]?.tags).toEqual([{ key: "faction", value: "horde" }]));

    tagIt(card, "Tideglass Regalia", "wishlist");
    await waitFor(() => expect(marks.stored()[0]?.tags).toEqual([
      { key: "faction", value: "horde" },
      { key: "wishlist", value: null },
    ]));
    // The label reads as the key alone; the property reads as the pair.
    expect(within(card).getByText("faction: horde")).toBeTruthy();
    expect(within(card).getByText("wishlist")).toBeTruthy();
  });

  it("takes a tag off from the chip it is written on", async () => {
    const { marks } = view({
      marks: fakeMarks([
        { kind: "set", id: 201, favourite: false, tags: [{ key: "faction", value: "horde" }] },
      ]),
    });
    const card = cardFor("Tideglass Regalia");

    fireEvent.click(within(card).getByRole("button", {
      name: "Remove the tag faction: horde from Tideglass Regalia",
    }));

    await waitFor(() => expect(marks.stored()).toEqual([]));
  });

  // What the reader typed is judged by the backend — the length limits and the cleaning are
  // `marks.rs` — so the one thing the view owes them is the sentence saying why nothing
  // happened, rather than a chip that appears and is gone on the next read.
  it("says why a write was refused rather than pretending it landed", async () => {
    const { marks } = view();
    const card = cardFor("Tideglass Regalia");
    marks.setTag.mockImplementationOnce(() =>
      Promise.reject(new Error("A tag's name has to fit in 48 characters.")));

    tagIt(card, "Tideglass Regalia", "a".repeat(60));

    expect(await within(card).findByRole("alert"))
      .toHaveProperty("textContent", "A tag's name has to fit in 48 characters.");
    expect(marks.stored()).toEqual([]);
  });

  // The form is the one place a click is stopped before it reaches the bridge, and only for
  // the case a stray Enter produces: a form nobody filled in.
  it("does not send an empty tag at all", async () => {
    const { marks } = view();
    const card = cardFor("Tideglass Regalia");

    tagIt(card, "Tideglass Regalia", "  ", "horde");

    await waitFor(() => expect(marks.setTag).not.toHaveBeenCalled());
  });

  it("narrows the grid to the starred sets", async () => {
    view({ marks: fakeMarks([{ kind: "set", id: 201, favourite: true, tags: [] }]) });

    fireEvent.click(screen.getByRole("checkbox", { name: "Favourites only" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Emberforge Plate" })).toBeNull());
    expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy();
  });

  it("narrows the grid to one tag, and offers only the tags in use", async () => {
    view({
      marks: fakeMarks([
        { kind: "set", id: 203, favourite: false, tags: [{ key: "wishlist", value: null }] },
      ]),
    });
    const picker = screen.getByLabelText("Tag");
    expect([...picker.querySelectorAll("option")].map((one) => one.textContent))
      .toEqual(["Any tag", "wishlist"]);

    fireEvent.change(picker, { target: { value: "wishlist" } });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Tideglass Regalia" })).toBeNull());
    expect(screen.getByRole("button", { name: "Emberforge Plate" })).toBeTruthy();
  });

  // An empty dropdown offering only "Any tag" is a control that can do nothing, and that is
  // what every install starts as.
  it("offers no tag picker at all until a tag exists", () => {
    view();
    expect(screen.queryByLabelText("Tag")).toBeNull();
  });

  it("finds a set by a word the reader filed it under", async () => {
    view({
      marks: fakeMarks([
        { kind: "set", id: 203, favourite: false, tags: [{ key: "faction", value: "horde" }] },
      ]),
    });

    fireEvent.change(screen.getByLabelText("Filter transmog sets"), { target: { value: "horde" } });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Tideglass Regalia" })).toBeNull());
    expect(screen.getByRole("button", { name: "Emberforge Plate" })).toBeTruthy();
  });

  // The whole argument for keying a mark on the appearance rather than on the item or on the
  // set that named it: the two halves of the browser are looking at one wardrobe.
  it("shows a look starred in a set as starred in the wardrobe beside it", async () => {
    const already = view();
    const card = await open("Emberforge Plate");
    fireEvent.click(star(card, "Emberforge Helm"));
    await waitFor(() => expect(already.marks.stored())
      .toEqual([{ kind: "appearance", id: 3, favourite: true, tags: [] }]));

    await browseItems(already);

    const row = screen.getByRole("button", { name: "Wear Head: Emberforge Helm" }).closest("li");
    expect(within(row as HTMLElement).getByRole("button", { name: "Favourite Emberforge Helm" })
      .getAttribute("aria-pressed")).toBe("true");
  });

  it("stars a look out of the game's whole wardrobe", async () => {
    const { marks } = await browseItems();
    const row = (await screen.findByText("Coif of the Drowned Star")).closest("li") as HTMLElement;

    fireEvent.click(star(row, "Coif of the Drowned Star"));

    await waitFor(() => expect(marks.stored())
      .toEqual([{ kind: "appearance", id: 40, favourite: true, tags: [] }]));
  });

  it("narrows a kind to the starred looks", async () => {
    await browseItems(view({
      marks: fakeMarks([{ kind: "appearance", id: 40, favourite: true, tags: [] }]),
    }));
    await screen.findByText("Emberforge Helm");

    fireEvent.click(screen.getByRole("checkbox", { name: "Favourites only" }));

    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });

  // An appearance the game encrypts has no id to store a mark against, so a star that could
  // only ever fail is not drawn at all.
  it("offers nothing to mark on a look the game withholds", async () => {
    view();
    fireEvent.click(hideBox());
    const card = await open("Emberforge Plate");
    const withheld = rowFor(card, "Wear Unknown slot: The game keeps this appearance encrypted");

    expect(within(withheld).queryByRole("button", { name: /^Favourite/ })).toBeNull();
    // Its neighbour has one, so the absence is about this row and not about the set.
    expect(star(rowFor(card, "Wear Head: Emberforge Helm"), "Emberforge Helm")).toBeTruthy();
  });
});
