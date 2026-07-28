import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REASONS } from "./modelPreview";
import { TransmogView } from "./transmogView";
import type { TransmogViewProps } from "./transmogView";
import type { Focus } from "./gallery";
import type { GalleryStage } from "./galleryStage";
import type { ModelStage } from "./modelViewer";
import type {
  CharacterPick, CustomSet, CustomSetPiece, CustomSetsPayload, GalleryKind, MarkSubjectKind,
  QualitiesFile, SetQualitiesFile, TransmogAppearance, TransmogMark, TransmogMarksPayload,
  TransmogPayload, TransmogSet, TransmogSetItemsPayload, WardrobeAppearance, WardrobePayload,
  WornPiece,
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

/**
 * The one graphics context a gallery is drawn through, faked.
 *
 * What is worth recording is which model went into which row, how it was framed and which way
 * round it was put: a helm framed like a whole body is the failure the focus table exists to
 * prevent, and a canvas is a rectangle that says nothing about any of it.
 *
 * The bytes are kept too, by identity. The real stage recognises the model it is already holding
 * by the array it was handed and skips the parse — so a window that decoded the `.glb` afresh
 * for every frame of a drag would re-parse a megabyte thirty times a second and still draw the
 * right picture. Nothing but the identity of these can tell those two apart.
 */
function fakeGalleryStage() {
  const painted: Array<{ label: string; holds: number; turn: number; glb: Uint8Array }> = [];
  const stage: GalleryStage = {
    paint: (target: HTMLCanvasElement, glb: Uint8Array, focus: Focus, turn = 0) => {
      painted.push({
        label: target.getAttribute("aria-label") ?? "", holds: focus.holds, turn, glb,
      });
      return Promise.resolve();
    },
    dispose: () => {},
  };
  return { createGalleryStage: () => stage, painted };
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

/** When a set was saved, as far as anything here is concerned. */
const SAVED_AT = 2_100_000_000;

/**
 * The two tables behind a set of the reader's own, faked.
 *
 * A store for the reason the marks are one: saving answers with *every* saved set and the window
 * holds what came back, so a double answering a fixture would let a view that never repainted
 * pass. The rules it keeps are the ones `customsets.rs` keeps and a test can tell apart from a
 * broken form — a name is required and tidied, an empty outfit is not a set, and a name already
 * used saves over the set that has it rather than making a second one.
 */
function fakeCustomSets(starting: CustomSet[] = []) {
  let sets = structuredClone(starting);
  const answer = (): CustomSetsPayload => ({ sets: structuredClone(sets) });
  return {
    starting: answer(),
    stored: (): CustomSet[] => structuredClone(sets),
    save: vi.fn((name: string, pieces: CustomSetPiece[]) => {
      const cleaned = name.trim().replace(/\s+/g, " ");
      if (!cleaned) {
        return Promise.reject(new Error("Give the set a name and it will be saved under it."));
      }
      if (!pieces.length) {
        return Promise.reject(
          new Error("Put something on her first, and then it can be saved as a set."),
        );
      }
      const at = sets.findIndex((set) => set.name.toLowerCase() === cleaned.toLowerCase());
      if (at >= 0) sets[at] = { ...sets[at]!, name: cleaned, updatedAt: SAVED_AT, pieces };
      else {
        const id = sets.reduce((highest, set) => Math.max(highest, set.id), 0) + 1;
        sets.push({ id, name: cleaned, createdAt: SAVED_AT, updatedAt: SAVED_AT, pieces });
      }
      sets.sort((left, right) => left.name.localeCompare(right.name));
      return Promise.resolve(answer());
    }),
    remove: vi.fn((id: number) => {
      sets = sets.filter((set) => set.id !== id);
      return Promise.resolve(answer());
    }),
  };
}

type FakeCustomSets = ReturnType<typeof fakeCustomSets>;

/**
 * The view with somewhere for a write's answer to land, which is what `app.tsx` is.
 *
 * The component takes both of the things that are the reader's own — the marks and the saved
 * sets — as props and never edits either itself, so a test driving a star or a save needs the
 * piece above it that holds the payloads. This is that piece and nothing else.
 */
function Marked(
  { store, saved, ...props }:
    Omit<TransmogViewProps, "marks" | "custom" | "inGame">
    & { store: FakeMarks; saved: FakeCustomSets; inGame?: TransmogViewProps["inGame"] },
): ReactNode {
  const [payload, setPayload] = useState<TransmogMarksPayload>(store.starting);
  const [sets, setSets] = useState<CustomSetsPayload>(saved.starting);
  const said = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error));
  return (
    <TransmogView
      {...props}
      inGame={props.inGame ?? NO_IN_GAME_SETS}
      marks={{
        payload,
        setFavourite: store.setFavourite,
        setTag: store.setTag,
        deleteTag: store.deleteTag,
        onApply: setPayload,
        onError: said,
      }}
      custom={{
        payload: sets,
        save: saved.save,
        remove: saved.remove,
        onApply: setSets,
        onError: said,
        sendToGame: () => Promise.resolve([]),
      }}
    />
  );
}

/**
 * A wardrobe Chronie has never read, for the tests that are about something else entirely.
 *
 * Null rather than an empty payload, because that is what the view is handed until the read
 * lands, and it is the state every one of these tests is actually in: they are about the game's
 * sets and the reader's own, and the fourth browser is not what they are looking at.
 */
const NO_IN_GAME_SETS = {
  payload: null,
  loadAppearances: () => Promise.resolve({ appearances: [], readCount: 0, withheldCount: 0 }),
};

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
 * Who she is, as a settings file that answers: the questions the game would ask about a body,
 * and what has been said about them so far.
 *
 * State rather than a fixture, for the reason the marks are — answering one has to be visible
 * to the next read, which is what the real backend's settings file does.
 */
function fakeHerself() {
  let picked: CharacterPick[] = [];
  let body = 2;
  return {
    load: vi.fn(() => Promise.resolve({
      bodies: [{ id: 1, name: "Human Male" }, { id: 2, name: "Human Female" }],
      body,
      questions: body === 2
        ? [
          {
            id: 16,
            name: "Hair Style",
            swatches: [{ id: 132, name: "Loose" }, { id: 133, name: "Braided" }],
          },
          // Unnamed, as most of the game's are: a skin tone is a square of colour.
          { id: 14, name: "Skin Color", swatches: [{ id: 85, name: "" }, { id: 86, name: "" }] },
        ]
        // The other body is asked its own questions, which is what changing body means.
        : [{ id: 13, name: "Beard", swatches: [{ id: 70, name: "Clean" }, { id: 71, name: "Full" }] }],
      picked: [...picked],
    })),
    save: vi.fn((chosen: number, answers: CharacterPick[]) => {
      body = chosen;
      picked = answers;
      return Promise.resolve({ body, picked: [...picked] });
    }),
    onError: String,
  };
}

type FakeHerself = ReturnType<typeof fakeHerself>;

/** And nobody the reader can be, for the tests that are about something else entirely. */
const NOT_ASKED = {
  load: () => Promise.resolve({ bodies: [], body: 0, questions: [], picked: [] }),
  save: (body: number, picked: CharacterPick[]) => Promise.resolve({ body, picked }),
  onError: String,
};

/** And no sets of anybody's own, for the same tests. */
const NO_SETS = {
  payload: { sets: [] },
  save: () => Promise.resolve({ sets: [] }),
  remove: () => Promise.resolve({ sets: [] }),
  onApply: () => {},
  onError: String,
  sendToGame: () => Promise.resolve([]),
};

/**
 * What the committed store measured of the fixtures above — see `qualities.ts`.
 *
 * Handed to the view rather than left to default, though the default is only a file in this
 * repository and would load: a test asserting on a colour has to be asserting on a colour it
 * stated, and the real store is regenerated whenever somebody runs the tool against a newer
 * install. The Coif is the row every assertion here is about; the Emberforge Helm is the row
 * beside it that the store says nothing about.
 */
const MEASURED: Record<number, QualitiesFile> = {
  0: {
    displayType: 0,
    build: "12.0.5.67823",
    sizeCuts: { geometry: { small: 0.38, large: 0.52, rows: 2 } },
    appearances: [{ id: 40, primary: "#4a3b2c", accent: "#2060e0", size: "large" }],
  },
};

const SET_QUALITIES: SetQualitiesFile = {
  build: "12.0.5.67823",
  sets: [{ id: 201, primary: "#2060e0", accent: "#f6f6f6" }],
};

/**
 * The view over doubles a test answers, which is the only way to drive it: nothing here talks
 * to a backend and nothing monkey patches one.
 */
function view(
  options: {
    payload?: TransmogPayload | null; marks?: FakeMarks; saved?: FakeCustomSets;
    herself?: FakeHerself;
  } = {},
) {
  const { stage, shown, resets } = fakeStage();
  const { createGalleryStage, painted } = fakeGalleryStage();
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
  // The gallery half of the wardrobe, recorded for the same reason the outfit is: what matters
  // about it is which page the window asked the backend for, and only the request can say.
  const loadGallery = vi.fn((pieces: WornPiece[]) => Promise.resolve({
    models: pieces.map((piece) => ({
      displayInfoId: piece.displayInfoId,
      kind: (piece.displayType >= 11 ? "held" : "worn") as GalleryKind,
      model: model(`${piece.displayInfoId} worn`),
    })),
  }));
  const marks = options.marks ?? fakeMarks();
  const saved = options.saved ?? fakeCustomSets();
  // Recorded as well as answered: "a slot's file is not downloaded until somebody browses that
  // slot" is a statement about what was asked for, and only the request can say it.
  const loadQualities = vi.fn((displayType: number) =>
    Promise.resolve(MEASURED[displayType] ?? null));
  const loadSetQualities = vi.fn(() => Promise.resolve(SET_QUALITIES));
  const herself = options.herself ?? fakeHerself();
  const rendered = render(
    <Marked
      payload={options.payload === undefined ? SETS : options.payload}
      status="Reading the game's transmog tables…"
      loadSet={loadSet}
      loadAppearances={loadAppearances}
      loadIcons={() => Promise.resolve({ icons: {} })}
      loadCharacter={loadCharacter}
      loadWorn={loadWorn}
      loadGallery={loadGallery}
      herself={herself}
      store={marks}
      saved={saved}
      createStage={() => stage}
      createGalleryStage={createGalleryStage}
      loadQualities={loadQualities}
      loadSetQualities={loadSetQualities}
    />,
  );
  return {
    rendered, loadWorn, loadCharacter, loadSet, loadAppearances, loadGallery, marks, saved,
    herself, shown, resets, painted, loadQualities, loadSetQualities,
  };
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

/**
 * What the rail beside the character says is on, by slot and item.
 *
 * The rail is pictures, so what it says is on its tips: the item in bold and the place it
 * occupies — with the set it came out of after that — on the line under. This reads them back
 * out in the order a row used to print them.
 */
function worn(): string[] {
  return wornTips().map((tip) => `${tip.place} ${tip.item}`);
}

/** The same tips, taken apart: what each piece is, where it is, and where it came from. */
function wornTips(): { item: string; place: string; from: string }[] {
  const list = document.querySelector("#outfit-list");
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>(".outfit-slot [data-tip]")].map((tile) => {
    const tip = document.createElement("div");
    tip.innerHTML = tile.dataset.tip ?? "";
    const [place, from] = (tip.querySelector(".tip-line")?.textContent ?? "").split(" · ");
    return { item: tip.querySelector("b")?.textContent ?? "", place: place ?? "", from: from ?? "" };
  });
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
        loadGallery={() => Promise.resolve({ models: [] })}
        herself={NOT_ASKED}
        marks={UNMARKED}
        inGame={NO_IN_GAME_SETS}
        custom={NO_SETS}
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
        loadGallery={() => Promise.resolve({ models: [] })}
        herself={NOT_ASKED}
        marks={UNMARKED}
        inGame={NO_IN_GAME_SETS}
        custom={NO_SETS}
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

  /* ---------- what the artwork was measured to be ---------- */

  // The colours of a whole set, out of the committed store rather than out of the install: the
  // window has no game to read and reads a file this repository ships.
  it("says what a set is like without asking an install anything", async () => {
    view();
    const card = screen.getByRole("button", { name: "Tideglass Regalia" }).closest("article")!;
    const chip = await within(card as HTMLElement).findByTitle(/blue and white/);
    expect(chip.textContent).toContain("blue");
  });

  // And the one thing that must be on the screen beside a reader's own stars and tags: which
  // of the two this was. A colour nobody typed has to say so, or it reads as somebody's note.
  it("says plainly that nobody typed the colours", async () => {
    view();
    const card = screen.getByRole("button", { name: "Tideglass Regalia" }).closest("article")!;
    const chip = await within(card as HTMLElement).findByTitle(/blue and white/);
    expect(chip.getAttribute("title")).toContain("Chronie worked this out, nobody typed it");
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

  /* ---------- what the artwork was measured to be, on a wardrobe row ---------- */

  // The store is a file per slot and a slot is a few hundred kilobytes, so a reader who never
  // opens the wardrobe should download none of it — the same claim the payload above makes.
  it("reads nothing of the store until the reader asks to see a slot", async () => {
    const shown = view();
    await waitFor(() => expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy());
    expect(shown.loadQualities).not.toHaveBeenCalled();

    await browseItems(shown);
    await waitFor(() => expect(shown.loadQualities).toHaveBeenCalledWith(0));
  });

  it("says how big a look is and what colour, beside the game's own facts", async () => {
    await browseItems();
    const row = (await screen.findByText("Coif of the Drowned Star")).closest("li")!;
    const chip = await within(row as HTMLElement).findByTitle(/large, brown and blue/);
    // The word rather than the colours, because the swatches beside it are the colours.
    expect(chip.textContent).toBe("large");
  });

  // A row the store says nothing about draws exactly as it drew before any of this existed,
  // which is what lets a store regenerated one patch late still be worth having.
  it("leaves a look the store does not hold exactly as it was", async () => {
    await browseItems();
    const row = (await screen.findByText("Emberforge Helm")).closest("li")!;
    expect(within(row as HTMLElement).queryByTitle(/Chronie worked this out/)).toBeNull();
  });

  // The whole reason the colours are named at all. "Brown" is in no item's name in the game,
  // and it is how somebody looking at five thousand chestpieces asks for the brown ones.
  it("finds a look by a colour that is in nothing the game wrote down", async () => {
    await browseItems();
    await screen.findByText("Emberforge Helm");
    fireEvent.change(screen.getByLabelText("Filter appearances"), { target: { value: "brown" } });

    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });

  it("finds a look by how big it is for its slot", async () => {
    await browseItems();
    await screen.findByText("Coif of the Drowned Star");
    fireEvent.change(screen.getByLabelText("Filter appearances"), { target: { value: "large" } });

    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
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
    expect(wornTips()).toEqual([{ item: "Coif of the Drowned Star", place: "Head", from: "" }]);
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
 * The wardrobe drawn as pictures of the thing rather than as a list of names.
 *
 * What every one of these is about is that a *page* is the unit. The backend builds one body and
 * dresses it once per row — see `gallery.rs` — so a page of twenty costs about what a row of one
 * costs, and a window that asked a row at a time would give all of that back.
 */
describe("the wardrobe as models", () => {
  afterEach(cleanup);

  /** Turns the gallery on, and waits for the page it asks for to arrive. */
  async function showWorn(already?: ReturnType<typeof view>): Promise<ReturnType<typeof view>> {
    const shown = await browseItems(already);
    fireEvent.click(screen.getByLabelText("Show worn"));
    await waitFor(() => expect(shown.loadGallery).toHaveBeenCalled());
    return shown;
  }

  // One request for the whole page, and it names every row of it. The two rows of the Head kind
  // are both wearable, so both are on her and both are in the one call.
  it("asks for a whole page of bodies in one request", async () => {
    const { loadGallery } = await showWorn();
    expect(loadGallery).toHaveBeenCalledTimes(1);
    expect(loadGallery.mock.calls[0]?.[0].map((piece) => piece.displayInfoId))
      .toEqual([900_040, 900_099]);
  });

  // And the page is a fifth of what the same list draws as names, because a row of names is a
  // string and a row of models is a character read out of the game's own files.
  it("draws fewer looks at a time than the same list of names does", async () => {
    const { loadGallery } = await showWorn();
    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "armour-3" } });
    await screen.findByText("Robe 000");

    expect(screen.getByText("20 of 120 appearances")).toBeTruthy();
    expect(screen.queryByText("Robe 020")).toBeNull();
    await waitFor(() => expect(loadGallery).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ displayInfoId: 901_019 })]),
    ));
    expect(loadGallery.mock.calls.at(-1)?.[0]).toHaveLength(20);

    // And the button under them goes on in pages of twenty rather than of a hundred.
    fireEvent.click(screen.getByRole("button", { name: "Show 20 more of 100 appearances" }));
    expect(await screen.findByText("Robe 020")).toBeTruthy();
  });

  // Each row is painted on the grid's one stage, framed on the part of the body its slot is on.
  // A helm held against two metres of character is four pixels of hat, which is the whole
  // reason there is a focus table rather than one framing for everything.
  it("frames each look on the part of her its slot is on", async () => {
    const { painted } = await showWorn();
    await waitFor(() => expect(painted).toHaveLength(2));
    expect(painted.map((one) => one.label))
      .toEqual(["Coif of the Drowned Star, drawn", "Emberforge Helm, drawn"]);
    for (const one of painted) expect(one.holds).toBeLessThan(1);
  });

  // What is already drawn is not asked for again. The two halves of the browser share looks —
  // the same helm is under Head and inside three sets — so going away and coming back has to
  // be free rather than another page of the game's tables.
  it("does not ask twice for a look it already holds", async () => {
    const { loadGallery } = await showWorn();
    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "armour-3" } });
    await screen.findByText("Robe 000");
    await waitFor(() => expect(loadGallery).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "armour-0" } });
    await screen.findByText("Coif of the Drowned Star");
    await waitFor(() => expect(screen.getAllByLabelText(/, drawn$/)).toHaveLength(2));
    expect(loadGallery).toHaveBeenCalledTimes(2);
  });

  // Turning it off puts the names back, and gives the graphics context back with them: twenty
  // live contexts is more than a browser hands out, and the one here is held only while the
  // reader is looking at pictures.
  it("goes back to the icons, and gives the context back", async () => {
    const disposals = { count: 0 };
    const stage: GalleryStage = { paint: () => Promise.resolve(), dispose: () => { disposals.count += 1; } };
    await browseItems(view());
    cleanup();

    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={(setId) => Promise.resolve(CONTENTS[setId] as TransmogSetItemsPayload)}
        loadAppearances={(displayTypes) =>
          Promise.resolve(WARDROBE[displayTypes.join(",")]
            ?? { displayTypes, appearances: [], readCount: 0, withheldCount: 0 })}
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        herself={NOT_ASKED}
        loadGallery={(pieces) => Promise.resolve({
          models: pieces.map((piece) => ({
            displayInfoId: piece.displayInfoId,
            kind: "worn" as GalleryKind,
            model: model("worn"),
          })),
        })}
        marks={UNMARKED}
        inGame={NO_IN_GAME_SETS}
        custom={NO_SETS}
        createStage={() => fakeStage().stage}
        createGalleryStage={() => stage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Items" }));
    await waitFor(() => expect(screen.getByLabelText("Kind of appearance")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Show worn"));
    await waitFor(() => expect(screen.getAllByLabelText(/, drawn$/)).toHaveLength(2));

    fireEvent.click(screen.getByLabelText("Show worn"));
    await waitFor(() => expect(screen.queryByLabelText(/, drawn$/)).toBeNull());
    expect(disposals.count).toBe(1);
  });

  // Dragging across a picture turns it. The angle is what the stage is told, and it is the only
  // thing about a turned model a test can see — a canvas draws the same rectangle whichever way
  // round the thing on it is.
  it("turns a picture when the reader drags across it", async () => {
    const { painted } = await showWorn();
    await waitFor(() => expect(painted.length).toBeGreaterThanOrEqual(2));
    const picture = screen.getAllByLabelText(/, drawn$/)[0]!;
    // Laid out, because the turn is a fraction of the picture's width and jsdom measures
    // everything as zero unless it is told otherwise.
    Object.defineProperty(picture, "clientWidth", { value: 200, configurable: true });
    picture.setPointerCapture = () => {};

    expect(painted.at(-1)?.turn).toBe(0);
    fireEvent.pointerDown(picture, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(picture, { pointerId: 1, clientX: 200 });

    await waitFor(() => expect(painted.at(-1)?.turn).toBeCloseTo(Math.PI));
    expect(painted.at(-1)?.label).toBe("Coif of the Drowned Star, drawn");
  });

  // And it keeps turning from where it was let go, rather than snapping back to the front: a
  // reader gets round to the back of a helm in as many drags as they like.
  it("carries a second drag on from where the first ended", async () => {
    const { painted } = await showWorn();
    await waitFor(() => expect(painted.length).toBeGreaterThanOrEqual(2));
    const picture = screen.getAllByLabelText(/, drawn$/)[0]!;
    Object.defineProperty(picture, "clientWidth", { value: 200, configurable: true });
    picture.setPointerCapture = () => {};

    fireEvent.pointerDown(picture, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(picture, { pointerId: 1, clientX: 200 });
    await waitFor(() => expect(painted.at(-1)?.turn).toBeCloseTo(Math.PI));
    fireEvent.pointerUp(picture, { pointerId: 1 });

    fireEvent.pointerDown(picture, { pointerId: 2, clientX: 0 });
    fireEvent.pointerMove(picture, { pointerId: 2, clientX: 100 });
    await waitFor(() => expect(painted.at(-1)?.turn).toBeCloseTo(Math.PI * 2));
  });

  // Every frame of a drag hands the stage the *same* array, which is how the stage knows it is
  // already holding that model and can skip the parse. Decoding the `.glb` afresh each time
  // would draw exactly the same picture while parsing a megabyte and re-uploading its textures
  // for every frame — the difference between turning a thumbnail and turning a live pane, and
  // invisible in anything but this.
  it("hands the stage the same bytes for every frame of a drag", async () => {
    const { painted } = await showWorn();
    const mine = "Coif of the Drowned Star, drawn";
    await waitFor(() => expect(painted.some((one) => one.label === mine)).toBe(true));
    const picture = screen.getAllByLabelText(/, drawn$/)[0]!;
    Object.defineProperty(picture, "clientWidth", { value: 200, configurable: true });
    picture.setPointerCapture = () => {};
    const first = painted.find((one) => one.label === mine)!.glb;

    for (const clientX of [110, 140, 180]) {
      fireEvent.pointerDown(picture, { pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(picture, { pointerId: 1, clientX });
      await waitFor(() => expect(painted.at(-1)?.turn).not.toBe(0));
    }

    const turned = painted.filter((one) => one.label === mine);
    expect(turned.length).toBeGreaterThan(1);
    for (const one of turned) expect(one.glb).toBe(first);
  });

  // Dragging a picture must not put the piece on the character. The picture is outside the
  // button once the gallery is on, and this is that arrangement asserted from the outside: the
  // thing a reader grabs is not the thing a reader clicks.
  it("does not wear a piece when its picture is dragged", async () => {
    await showWorn();
    await waitFor(() => expect(screen.getAllByLabelText(/, drawn$/)).toHaveLength(2));
    const picture = screen.getAllByLabelText(/, drawn$/)[0]!;
    Object.defineProperty(picture, "clientWidth", { value: 200, configurable: true });
    picture.setPointerCapture = () => {};

    fireEvent.pointerDown(picture, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(picture, { pointerId: 1, clientX: 200 });
    fireEvent.pointerUp(picture, { pointerId: 1 });
    fireEvent.click(picture);

    const wear = screen.getByRole("button", { name: "Wear Head: Coif of the Drowned Star" });
    expect(wear.getAttribute("aria-pressed")).toBe("false");
  });

  // A weapon is drawn as itself rather than on a body, so there is no part of a character to
  // point a camera at and the whole of what arrived is the picture. The backend says which it
  // sent and the window frames by that, rather than deciding a second time from the slot.
  it("holds all of a picture the backend drew without a body", async () => {
    const { painted } = await showWorn();
    await waitFor(() => expect(painted.length).toBeGreaterThanOrEqual(2));
    painted.length = 0;

    fireEvent.change(screen.getByLabelText("Kind of appearance"), { target: { value: "held" } });
    await waitFor(() => expect(painted.length).toBeGreaterThan(0));
    for (const one of painted) expect(one.holds).toBe(1);
  });

  // The same, for a reader who turns it off again before the first picture has been drawn.
  //
  // Making a stage is asynchronous — the module it comes out of is imported on demand — so
  // there is a window between a tile asking for a picture and there being a renderer at all,
  // and it is wide enough to click through. A window that disposed only what had finished
  // being made would let a context started inside that window escape with nothing pointing at
  // it, and the failure is invisible: the browser simply hands out one fewer next time, and
  // the grid starts going black at the top some pages later.
  it("gives back a context that was still being made when the gallery went off", async () => {
    const disposals = { count: 0 };
    // Never settles on its own, which is the window held open: the reader gets to the switch
    // before the renderer exists.
    let arrive = (_: GalleryStage) => {};
    const coming = new Promise<GalleryStage>((resolve) => { arrive = resolve; });
    await browseItems(view());
    cleanup();

    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={(setId) => Promise.resolve(CONTENTS[setId] as TransmogSetItemsPayload)}
        loadAppearances={(displayTypes) =>
          Promise.resolve(WARDROBE[displayTypes.join(",")]
            ?? { displayTypes, appearances: [], readCount: 0, withheldCount: 0 })}
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        herself={NOT_ASKED}
        loadGallery={(pieces) => Promise.resolve({
          models: pieces.map((piece) => ({
            displayInfoId: piece.displayInfoId,
            kind: "worn" as GalleryKind,
            model: model("worn"),
          })),
        })}
        marks={UNMARKED}
        inGame={NO_IN_GAME_SETS}
        custom={NO_SETS}
        createStage={() => fakeStage().stage}
        createGalleryStage={() => coming}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Items" }));
    await waitFor(() => expect(screen.getByLabelText("Kind of appearance")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Show worn"));
    // The tiles are on screen and have asked for their pictures; nothing has been drawn.
    await waitFor(() => expect(screen.getAllByLabelText(/, drawn$/)).toHaveLength(2));

    fireEvent.click(screen.getByLabelText("Show worn"));
    await waitFor(() => expect(screen.queryByLabelText(/, drawn$/)).toBeNull());
    expect(disposals.count).toBe(0);

    // And now it finishes being made, into a window that no longer wants it.
    arrive({ paint: () => Promise.resolve(), dispose: () => { disposals.count += 1; } });
    await waitFor(() => expect(disposals.count).toBe(1));
  });

  // A page that will not come leaves the list exactly as it was before anybody asked for
  // pictures: the names, the slots and the icons are what the wardrobe always had.
  it("keeps the list when a page of bodies will not come", async () => {
    cleanup();
    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={(setId) => Promise.resolve(CONTENTS[setId] as TransmogSetItemsPayload)}
        loadAppearances={(displayTypes) =>
          Promise.resolve(WARDROBE[displayTypes.join(",")]
            ?? { displayTypes, appearances: [], readCount: 0, withheldCount: 0 })}
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        herself={NOT_ASKED}
        loadGallery={() => Promise.reject(new Error("The game's files are not readable."))}
        marks={UNMARKED}
        inGame={NO_IN_GAME_SETS}
        custom={NO_SETS}
        createStage={() => fakeStage().stage}
        createGalleryStage={() => ({ paint: () => Promise.resolve(), dispose: () => {} })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Items" }));
    await waitFor(() => expect(screen.getByLabelText("Kind of appearance")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Show worn"));

    expect(await screen.findByText("Coif of the Drowned Star")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText(/, drawn$/)).toBeNull());
  });
});

/**
 * Who the character is, which is the one thing on this screen that changes every picture on it.
 *
 * The answers themselves are the backend's — it applies what the settings file holds to every
 * body it draws, so nothing here sends them. What the view has to do is the other half: every
 * body it is already holding is a picture of the woman who was there before, and going on
 * showing them is the failure worth catching. So each of these answers a question about her and
 * then asks whether the bodies were read out of the game again.
 */
describe("who the character is", () => {
  afterEach(cleanup);

  /** Opens the form under her and waits for the questions the game would ask. */
  async function askable(shown: ReturnType<typeof view>): Promise<void> {
    const details = screen.getByText("Who she is").closest("details");
    if (!details) throw new Error("the panel has no disclosure to open");
    // Set and then announced, which is the order a browser does it in — see the panel's own
    // suite. The end-to-end run is where a real click on it is driven.
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(shown.herself.load).toHaveBeenCalled());
    await screen.findByRole("combobox", { name: "Hair Style" });
  }

  // The bare body first, because that is what the view opens on and it is one model for every
  // outfit there is — which is exactly why it would otherwise outlive the woman it is of.
  it("reads the character again once she is somebody else", async () => {
    const shown = view();
    await waitFor(() => expect(shown.loadCharacter).toHaveBeenCalledTimes(1));
    await askable(shown);

    fireEvent.change(screen.getByRole("combobox", { name: "Hair Style" }), {
      target: { value: "133" },
    });

    await waitFor(() => expect(shown.loadCharacter).toHaveBeenCalledTimes(2));
  });

  // And the dressed one, which is the cache a reader fills by trying things on: every outfit
  // they have looked at is held under the outfit's own name, and every one of them is of her.
  it("reads an outfit again once she is somebody else", async () => {
    const shown = view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Chest: Robe of Tides" }));
    await waitFor(() => expect(shown.loadWorn).toHaveBeenCalledTimes(1));
    const dressed = shown.loadWorn.mock.calls[0]?.[0];
    await askable(shown);

    fireEvent.change(screen.getByRole("combobox", { name: "Hair Style" }), {
      target: { value: "133" },
    });

    // The same outfit, asked for again — because it is the woman under it that changed.
    await waitFor(() => expect(shown.loadWorn).toHaveBeenCalledTimes(2));
    expect(shown.loadWorn.mock.calls[1]?.[0]).toEqual(dressed);
  });

  // The gallery is twenty bodies rather than one, and it is the cache with the most to lose —
  // which is the reason it is emptied rather than left to be checked row by row.
  it("reads a page of the wardrobe again once she is somebody else", async () => {
    const shown = view();
    await browseItems(shown);
    fireEvent.click(screen.getByLabelText("Show worn"));
    await waitFor(() => expect(shown.loadGallery).toHaveBeenCalledTimes(1));
    await askable(shown);

    fireEvent.change(screen.getByRole("combobox", { name: "Hair Style" }), {
      target: { value: "133" },
    });

    await waitFor(() => expect(shown.loadGallery).toHaveBeenCalledTimes(2));
    expect(shown.loadGallery.mock.calls[1]?.[0].map((piece) => piece.displayInfoId))
      .toEqual([900_040, 900_099]);
  });

  // The other half of it, and the coarser one: another body entirely. Every picture in the
  // window is of one body or the other, so the same cache has to let go of all of them.
  it("reads the character again on the other body", async () => {
    const shown = view();
    await waitFor(() => expect(shown.loadCharacter).toHaveBeenCalledTimes(1));
    await askable(shown);

    fireEvent.change(screen.getByRole("combobox", { name: "Body" }), { target: { value: "1" } });

    await waitFor(() => expect(shown.loadCharacter).toHaveBeenCalledTimes(2));
    // And the form under the picker is that body's questions rather than hers relabelled.
    expect(await screen.findByRole("combobox", { name: "Beard" })).toBeTruthy();
  });

  // And what is on her survives it. She is the body under the clothes; changing her hair is not
  // a reason to take a reader's outfit off, and the outfit is what a set of their own is made
  // of.
  it("leaves the outfit on her", async () => {
    const shown = view();
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Chest: Robe of Tides" }));
    await waitFor(() => expect(shown.loadWorn).toHaveBeenCalledTimes(1));
    await askable(shown);

    fireEvent.change(screen.getByRole("combobox", { name: "Hair Style" }), {
      target: { value: "133" },
    });

    await waitFor(() => expect(shown.loadWorn).toHaveBeenCalledTimes(2));
    expect(worn()).toEqual(["Chest Robe of Tides"]);
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

/**
 * The third browser: the sets the reader made, which is the other thing on this screen that the
 * game knows nothing about.
 *
 * These drive the store the same way the marks do and for the same reason — a save that lit up
 * the browser and never crossed the bridge is the bug worth catching — and they go the whole
 * way round every time: dress her, save it, find it under "Yours", put it back on. Which is the
 * only claim that matters here, because every step of that round trip is a translation and a
 * translation that is right in one direction and wrong in the other loses the outfit silently.
 */
describe("the sets the reader puts together themselves", () => {
  /** The name box under the character, and the button that acts on what is typed in it. */
  const name = (): HTMLElement => screen.getByLabelText("Name for this set");
  const keep = (): HTMLElement =>
    screen.getByRole("button", { name: /^(Save as a set|Replace )/ });

  /** Dresses her out of one of the game's sets, which is where an outfit comes from. */
  const dress = async (): Promise<void> => {
    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear all of Tideglass Regalia" }));
    await waitFor(() => expect(worn()).toHaveLength(2));
  };

  /** Types a name and saves what she has on under it. */
  const saveAs = (called: string): void => {
    fireEvent.change(name(), { target: { value: called } });
    fireEvent.click(keep());
  };

  /** Switches to the third browser, where the saved sets are. */
  const browseYours = (): void => {
    fireEvent.click(screen.getByRole("button", { name: "Yours" }));
  };

  /** The card a saved set is drawn on, found by the heading the reader named it with. */
  const savedCard = (called: string): HTMLElement => {
    const heading = screen.getByRole("heading", { name: called, level: 4 });
    return heading.closest("article") as HTMLElement;
  };

  it("offers nothing to save while she is wearing nothing", async () => {
    view();
    await waitFor(() => expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy());
    // A form that could only ever be refused is worse than no form.
    expect(screen.queryByLabelText("Name for this set")).toBeNull();
  });

  it("saves what she has on, and finds it again under a name of the reader's own", async () => {
    const { saved } = view();
    await dress();

    saveAs("  Horde  look ");

    // Stored, tidied, and holding the two pieces that had somewhere on her to go — the arrows
    // of that set were never on her, so they are not in it.
    await waitFor(() => expect(saved.stored()).toHaveLength(1));
    const set = saved.stored()[0]!;
    expect(set.name).toBe("Horde look");
    expect(set.pieces.map((piece) => [piece.place, piece.name])).toEqual([
      ["armour-0", "Crown of Tides"],
      ["armour-3", "Robe of Tides"],
    ]);
    // Every number the character is drawn from survives, which is what makes it wearable again.
    expect(set.pieces[0]).toMatchObject({ appearanceId: 1, itemId: 1, displayInfoId: 900_001 });

    browseYours();
    const card = savedCard("Horde look");
    expect(within(card).getByText("Crown of Tides")).toBeTruthy();
    expect(within(card).getByText("2 pieces · saved just now")).toBeTruthy();
  });

  // The whole round trip, and the only claim worth making about a saved set: it goes back on.
  it("dresses the character in a saved set, out of what was stored and nothing else", async () => {
    const { loadWorn, saved } = view();
    await dress();
    saveAs("Horde look");
    await waitFor(() => expect(saved.stored()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Take it all off" }));
    await waitFor(() => expect(worn()).toEqual([]));

    browseYours();
    fireEvent.click(within(savedCard("Horde look"))
      .getByRole("button", { name: "Wear all of Horde look" }));

    await waitFor(() => expect(worn()).toEqual(["Head Crown of Tides", "Chest Robe of Tides"]));
    // The same body the game's own set asked for, which is what says nothing was lost on the
    // way through the database.
    expect(loadWorn).toHaveBeenLastCalledWith([
      { displayInfoId: 900_001, displayType: 0, inventoryType: 0 },
      { displayInfoId: 900_012, displayType: 3, inventoryType: 0 },
    ]);
  });

  it("puts one piece of a saved set on without the rest of it", async () => {
    const { saved } = view();
    await dress();
    saveAs("Horde look");
    await waitFor(() => expect(saved.stored()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Take it all off" }));
    await waitFor(() => expect(worn()).toEqual([]));

    browseYours();
    fireEvent.click(within(savedCard("Horde look"))
      .getByRole("button", { name: "Wear Head: Crown of Tides" }));

    await waitFor(() => expect(worn()).toEqual(["Head Crown of Tides"]));
  });

  // Names are unique without regard to case, so typing one that is taken saves over that set.
  // The button has to say so before the click, which is the whole difference between somebody
  // who meant it and somebody who forgot they had used the name.
  it("offers to replace a set whose name is typed again, and replaces exactly it", async () => {
    const { saved } = view();
    await dress();
    saveAs("Horde look");
    await waitFor(() => expect(saved.stored()).toHaveLength(1));
    const first = saved.stored()[0]!.id;

    // A different outfit and a different spelling of the same name.
    fireEvent.click(screen.getByRole("button", { name: "Take off Crown of Tides" }));
    await waitFor(() => expect(worn()).toHaveLength(1));
    fireEvent.change(name(), { target: { value: "horde LOOK" } });
    expect(screen.getByRole("button", { name: "Replace Horde look" })).toBeTruthy();
    fireEvent.click(keep());

    await waitFor(() => expect(saved.stored()[0]?.pieces).toHaveLength(1));
    expect(saved.stored()).toHaveLength(1);
    // The same set, which is what keeps whatever was said about it attached to it.
    expect(saved.stored()[0]?.id).toBe(first);
  });

  it("says why a save was refused rather than pretending it landed", async () => {
    const { saved } = view();
    await dress();
    saved.save.mockImplementationOnce(() =>
      Promise.reject(new Error("A set's name has to fit in 64 characters.")));

    saveAs("a".repeat(80));

    expect(await screen.findByRole("alert"))
      .toHaveProperty("textContent", "A set's name has to fit in 64 characters.");
    expect(saved.stored()).toEqual([]);
  });

  it("does not send a set with no name at all", async () => {
    const { saved } = view();
    await dress();

    saveAs("   ");

    await waitFor(() => expect(saved.save).not.toHaveBeenCalled());
  });

  // Saving is a note taken, not a door closed: the reader is still dressing her.
  it("leaves the outfit on her after it has been saved", async () => {
    const { saved } = view();
    await dress();

    saveAs("Horde look");

    await waitFor(() => expect(saved.stored()).toHaveLength(1));
    expect(worn()).toEqual(["Head Crown of Tides", "Chest Robe of Tides"]);
  });

  /** A set already saved, for the tests that are about what happens to one afterwards. */
  const already = (): FakeCustomSets => fakeCustomSets([{
    id: 7,
    name: "Horde look",
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
    pieces: [{
      place: "armour-0",
      appearanceId: 1,
      itemId: 1,
      name: "Crown of Tides",
      displayType: 0,
      inventoryType: 0,
      displayInfoId: 900_001,
      iconFileDataId: 0,
      hasModel: true,
    }],
  }]);

  // The issue's other half: a set of the reader's own takes any mark a Blizzard set takes, by
  // being a third kind of subject rather than a second feature.
  it("stars and tags a saved set the way the game's own sets are starred and tagged", async () => {
    const { marks } = view({ saved: already() });
    browseYours();
    const card = savedCard("Horde look");

    fireEvent.click(within(card).getByRole("button", { name: "Favourite Horde look" }));

    await waitFor(() => expect(marks.stored())
      .toEqual([{ kind: "custom", id: 7, favourite: true, tags: [] }]));

    tagIt(card, "Horde look", "faction", "horde");
    await waitFor(() => expect(marks.stored()[0]?.tags)
      .toEqual([{ key: "faction", value: "horde" }]));
    expect(within(card).getByText("faction: horde")).toBeTruthy();
  });

  it("narrows the saved sets to the starred ones", async () => {
    const saved = already();
    const store = fakeMarks([{ kind: "custom", id: 7, favourite: true, tags: [] }]);
    view({ saved: fakeCustomSets([...saved.stored(), {
      id: 8, name: "Alliance look", createdAt: SAVED_AT, updatedAt: SAVED_AT,
      pieces: saved.stored()[0]!.pieces,
    }]), marks: store });
    browseYours();

    fireEvent.click(within(document.querySelector("#custom-sets") as HTMLElement)
      .getByRole("checkbox", { name: "Favourites only" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Alliance look", level: 4 })).toBeNull());
    expect(screen.getByRole("heading", { name: "Horde look", level: 4 })).toBeTruthy();
  });

  // The thing the two browsers beside this one cannot offer: somebody who remembers putting a
  // piece in one of their sets and not which one.
  it("finds a saved set by what is in it", async () => {
    view({ saved: already() });
    browseYours();

    fireEvent.change(screen.getByLabelText("Filter your sets"), { target: { value: "crown" } });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Horde look", level: 4 })).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Filter your sets"), { target: { value: "aegis" } });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Horde look", level: 4 })).toBeNull());
  });

  // The one control in this view that destroys something the reader made.
  it("throws a saved set away, and only after a second click", async () => {
    const { saved } = view({ saved: already() });
    browseYours();
    const card = savedCard("Horde look");

    fireEvent.click(within(card).getByRole("button", { name: "Delete Horde look" }));
    // Nothing yet: the first click only asks.
    expect(saved.remove).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: "Delete Horde look" }));

    await waitFor(() => expect(saved.stored()).toEqual([]));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Horde look", level: 4 })).toBeNull());
  });

  it("says how to make one when there are none", async () => {
    view();
    browseYours();
    expect(await screen.findByText("No sets of your own yet")).toBeTruthy();
  });

  /** Fills in and submits the little form behind "+ tag" — the same one every mark uses. */
  function tagIt(host: HTMLElement, called: string, key: string, value = ""): void {
    fireEvent.click(within(host).getByRole("button", { name: `Tag ${called}` }));
    fireEvent.change(within(host).getByLabelText(`Tag name for ${called}`), {
      target: { value: key },
    });
    fireEvent.change(within(host).getByLabelText(`Tag value for ${called} (optional)`), {
      target: { value },
    });
    fireEvent.click(within(host).getByRole("button", { name: "Add" }));
  }
});
