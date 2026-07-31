import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REASONS } from "./modelPreview";
import { TransmogView } from "./transmogView";
import type { StatusRecourse, TransmogViewProps } from "./transmogView";
import type { Focus } from "./gallery";
import type { GalleryStage } from "./galleryStage";
import type { ModelStage } from "./modelViewer";
import type {
  CharacterModelPayload,
  CharacterPick,
  CustomSet,
  CustomSetPiece,
  CustomSetsPayload,
  GalleryKind,
  MarkSubjectKind,
  AlternativesPayload,
  LookalikesPayload,
  LookalikeVerdict,
  OpeningsPayload,
  QualitiesFile,
  SetGalleryPayload,
  SetQualitiesFile,
  TransmogAppearance,
  TransmogMark,
  TransmogMarksPayload,
  TransmogPayload,
  TransmogSet,
  TransmogSetItemsPayload,
  WardrobeAppearance,
  WardrobePayload,
  WearersPayload,
  WornPiece,
  WornSetPayload,
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
  appearanceId: 1,
  itemId: 1,
  name: "Crown of Tides",
  displayType: 0,
  displayInfoId: 900_001,
  hasModel: true,
});
const ROBE = appearance({
  appearanceId: 2,
  itemId: 2,
  name: "Robe of Tides",
  displayType: 3,
  displayInfoId: 900_012,
});
const OTHER_HELM = appearance({
  appearanceId: 3,
  itemId: 3,
  name: "Emberforge Helm",
  displayType: 0,
  displayInfoId: 900_099,
  hasModel: true,
});
/** Arrows: the game files them under a weapon slot and nobody holds them. */
const ARROWS = appearance({
  appearanceId: 4,
  itemId: 4,
  name: "A quiver of arrows",
  displayType: 11,
  inventoryType: 24,
});
/**
 * An appearance the game encrypts: no item behind it, so no name, no slot and nothing to look
 * up. The other way there is nowhere on her to put a row, and the only one with no id to link.
 */
const WITHHELD = appearance({
  appearanceId: 0,
  itemId: 0,
  name: "",
  displayType: 0,
  displayInfoId: 0,
});

const SETS: TransmogPayload = {
  sets: [
    set({ id: 201, name: "Tideglass Regalia", classMask: 0x0190 }),
    set({
      id: 203,
      name: "Emberforge Plate",
      group: "Emberforge Armory",
      classMask: 0x0023,
      expansionId: 4,
    }),
  ],
  readCount: 2,
  declaredCount: 2,
  withheldCount: 0,
};

/**
 * More sets than the grid draws pictures for, which is the only thing this payload is for.
 *
 * Sixteen, against a page of twelve — a few more than a page, so that turning the pictures on
 * visibly shortens the grid and the button under it has something to say. One collection, so
 * nothing here turns on how the groups happen to fall.
 */
const MANY_SETS: TransmogPayload = {
  sets: Array.from({ length: 16 }, (_, index) =>
    set({
      id: 301 + index,
      name: `Wardrobe of the Deep ${String(index).padStart(2, "0")}`,
      group: "Deepwater Collection",
    }),
  ),
  readCount: 16,
  declaredCount: 16,
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
      look({
        appearanceId: 3,
        name: "Emberforge Helm",
        displayInfoId: 900_099,
        itemCount: 3,
        liftsRestriction: true,
      }),
    ],
  },
  // A kind the size a real one is: 5,111 heads on a shipping install, and a list that drew
  // all of them would be forty screens of buttons nobody asked for.
  "3": {
    displayTypes: [3],
    readCount: 120,
    withheldCount: 0,
    appearances: Array.from({ length: 120 }, (_, index) =>
      look({
        appearanceId: 500 + index,
        // Numbered so the order is legible: the backend sorts by name and this is what that
        // looks like when a kind holds more than a page of them.
        name: `Robe ${String(index).padStart(3, "0")}`,
        displayType: 3,
        inventoryType: 5,
        displayInfoId: 901_000 + index,
      }),
    ),
  },
  "11,12,13,14,15": {
    displayTypes: [11, 12, 13, 14, 15],
    readCount: 3,
    withheldCount: 0,
    appearances: [
      look({
        appearanceId: 41,
        name: "Emberforge Blade",
        displayType: 11,
        inventoryType: 13,
        classId: 2,
        subclassId: 7,
        displayInfoId: 900_007,
      }),
      look({
        appearanceId: 42,
        name: "Staff of the Quiet Tide",
        displayType: 11,
        inventoryType: 17,
        classId: 2,
        subclassId: 10,
        displayInfoId: 900_014,
      }),
      // Filed as armour rather than as a weapon, so a picker reading the display type alone
      // would have put it among the swords.
      look({
        appearanceId: 43,
        name: "Emberforge Aegis",
        displayType: 13,
        inventoryType: 14,
        classId: 4,
        subclassId: 6,
        displayInfoId: 900_015,
      }),
    ],
  },
};

/**
 * A set the game locks to one class, which is what the openings panel is drawn for.
 *
 * Three looks and two of them the Paladin's own: a helm something outside the set sells to
 * everybody, and a pair of greaves nothing does. The third is unrestricted and is the control —
 * it stops nobody, so it is not a row of the panel however open the set's other two are.
 */
const LIGHTSWORN_HELM = appearance({
  appearanceId: 10,
  itemId: 10,
  modifiedAppearanceId: 10,
  name: "Lightsworn Helm",
  displayType: 0,
  displayInfoId: 900_101,
  allowableClass: 0x0002,
});
const LIGHTSWORN_GREAVES = appearance({
  appearanceId: 11,
  itemId: 11,
  modifiedAppearanceId: 11,
  name: "Lightsworn Greaves",
  displayType: 5,
  displayInfoId: 900_102,
  allowableClass: 0x0002,
});
const LIGHTSWORN_BREASTPLATE = appearance({
  appearanceId: 12,
  itemId: 12,
  modifiedAppearanceId: 12,
  name: "Lightsworn Breastplate",
  displayType: 3,
  displayInfoId: 900_103,
});

const CONTENTS: Record<number, TransmogSetItemsPayload> = {
  201: { setId: 201, appearances: [HELM, ROBE, ARROWS], readCount: 3, withheldCount: 0 },
  203: { setId: 203, appearances: [OTHER_HELM, WITHHELD], readCount: 1, withheldCount: 1 },
  // The class-locked set the openings panel is about — see the describe of that name below.
  701: {
    setId: 701,
    appearances: [LIGHTSWORN_HELM, LIGHTSWORN_GREAVES, LIGHTSWORN_BREASTPLATE],
    readCount: 3,
    withheldCount: 0,
  },
  // The two members of the family below, which hold different clothes: the whole reason a rail
  // is worth clicking is that the harder difficulty is a different set of armour.
  401: { setId: 401, appearances: [HELM], readCount: 1, withheldCount: 0 },
  402: { setId: 402, appearances: [ROBE], readCount: 1, withheldCount: 0 },
};

/**
 * A raid tier as the game files one, and a set that is in no family at all.
 *
 * 402 names 401 as its parent, which is the game saying they are one set of clothes at two
 * difficulties — Icecrown Citadel is 30 rows and 10 of these. They differ by name, by what they
 * are made of and by what the artwork was measured to be, which is everything the card has to
 * redraw when a reader picks one off the rail.
 */
const FAMILY: TransmogPayload = {
  sets: [
    set({
      id: 401,
      name: "Scourgelord's Battlegear",
      group: "Icecrown Citadel",
      classMask: 0x0023,
      expansionId: 2,
      itemCount: 5,
    }),
    set({
      id: 402,
      name: "Sanctified Scourgelord's Battlegear",
      group: "Icecrown Citadel",
      classMask: 0x0023,
      expansionId: 2,
      patchIntroduced: 30300,
      itemCount: 9,
      parentId: 401,
    }),
    set({ id: 421, name: "Duskwoven Shroud", group: "Duskwoven Attire" }),
  ],
  readCount: 3,
  declaredCount: 3,
  withheldCount: 0,
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
    resetCamera: () => {
      resets.count += 1;
    },
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
        label: target.getAttribute("aria-label") ?? "",
        holds: focus.holds,
        turn,
        glb,
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
 * The two reads that draw her, held open until the test lets one answer.
 *
 * What the pane does *between* asking the game for a body and being handed one is the only
 * thing several of these tests are about, and a double that answers straight away has been
 * through that moment before anything can look at it. Each call parks instead, and the test
 * says when it is over — so "the body already drawn is still on the stage" is an assertion
 * made at a moment that exists rather than a race with a resolved promise.
 *
 * The queues are kept apart because the two reads are asked for under different conditions:
 * a dressed body arrives when a piece goes on, and the bare one when everything comes off or
 * when she becomes somebody else, and a test usually holds one open while letting the other
 * through.
 */
function heldBodies() {
  const dressed: Array<(glb: string) => void> = [];
  const bare: Array<(glb: string) => void> = [];
  const park = <T,>(queue: Array<(glb: string) => void>): Promise<T> =>
    new Promise<T>((resolve) => {
      queue.push((body: string) => resolve({ model: model(body) } as T));
    });
  const answer = (queue: Array<(glb: string) => void>, body: string): void => {
    const waiting = queue.shift();
    if (!waiting) throw new Error(`nothing is waiting for ${body}`);
    waiting(body);
  };
  return {
    loadWorn: vi.fn((_pieces: WornPiece[]): Promise<WornSetPayload> => park(dressed)),
    loadCharacter: vi.fn((): Promise<CharacterModelPayload> => park(bare)),
    /** Hands over the dressed body the pane is waiting on, oldest read first. */
    answerWorn: (body = "a dressed body"): void => answer(dressed, body),
    /** The same for the bare one, which is what an outfit with nothing in it comes to. */
    answerBare: (body = "a bare body"): void => answer(bare, body),
  };
}

type HeldBodies = ReturnType<typeof heldBodies>;

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
    kind: MarkSubjectKind,
    id: number,
    apply: (mark: TransmogMark) => void,
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
      edit(kind, id, (mark) => {
        mark.favourite = favourite;
      }),
    ),
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
      }),
    ),
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
function Marked({
  store,
  saved,
  ...props
}: Omit<TransmogViewProps, "marks" | "custom" | "inGame"> & {
  store: FakeMarks;
  saved: FakeCustomSets;
  inGame?: TransmogViewProps["inGame"];
}): ReactNode {
  const [payload, setPayload] = useState<TransmogMarksPayload>(store.starting);
  const [sets, setSets] = useState<CustomSetsPayload>(saved.starting);
  const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));
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
    load: vi.fn(() =>
      Promise.resolve({
        bodies: [
          { id: 1, name: "Human Male" },
          { id: 2, name: "Human Female" },
        ],
        body,
        questions:
          body === 2
            ? [
                {
                  id: 16,
                  name: "Hair Style",
                  swatches: [
                    { id: 132, name: "Loose" },
                    { id: 133, name: "Braided" },
                  ],
                },
                // Unnamed, as most of the game's are: a skin tone is a square of colour.
                {
                  id: 14,
                  name: "Skin Color",
                  swatches: [
                    { id: 85, name: "" },
                    { id: 86, name: "" },
                  ],
                },
              ]
            : // The other body is asked its own questions, which is what changing body means.
              [
                {
                  id: 13,
                  name: "Beard",
                  swatches: [
                    { id: 70, name: "Clean" },
                    { id: 71, name: "Full" },
                  ],
                },
              ],
        picked: [...picked],
        // The reader's own roster, which the panel's other tests are about — these are about
        // what changing her does to the pictures above, and a roster does not change that.
        characters: [],
      }),
    ),
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
  load: () => Promise.resolve({ bodies: [], body: 0, questions: [], picked: [], characters: [] }),
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
  // 402 is deliberately absent: 213 sets of a shipping install were measured of nothing, and a
  // rail that lost a member wherever a colour was missing would be a rail nobody could count.
  sets: [
    { id: 201, primary: "#2060e0", accent: "#f6f6f6" },
    { id: 401, primary: "#4a3b2c" },
  ],
};

/**
 * The view over doubles a test answers, which is the only way to drive it: nothing here talks
 * to a backend and nothing monkey patches one.
 */
function view(
  options: {
    payload?: TransmogPayload | null;
    marks?: FakeMarks;
    saved?: FakeCustomSets;
    herself?: FakeHerself;
    /** Reads the test answers by hand, for the moments that only exist while one is in flight. */
    bodies?: HeldBodies;
    /** What the view says instead of a wardrobe. Reading, by default. */
    status?: string;
    /** And what it offers about it, which only a coded failure ever produces. */
    statusRecourse?: StatusRecourse | null;
    /**
     * Who the items behind each set say can really wear it — see `wearers.rs`.
     *
     * Left out by default, which is the view's own default too: nothing is read, every card
     * draws the mask the game filed its set under, and every test that predates any of this is
     * looking at the grid it was written against.
     */
    wearers?: () => Promise<WearersPayload>;
    /**
     * And which of one set's locked looks something outside it sells to anybody — see
     * `openings.ts`.
     *
     * Left out by default, the same way the wearers read is: a set that shuts nobody out has no
     * question to ask, and every test that predates the panel is looking at the card it was
     * written against.
     */
    openings?: (setId: number) => Promise<OpeningsPayload>;
    /**
     * And what else in the game might do for a look nothing sells around — see
     * `alternatives.ts`. Left out by default for the reason both reads above are: it is behind
     * a button on the one row of the panel that has no answer, and nothing asks it until then.
     */
    alternatives?: (appearanceId: number, displayType: number) => Promise<AlternativesPayload>;
    /** What anybody has decided about one of those suggestions, and deciding one. */
    lookalikes?: {
      load: () => Promise<LookalikesPayload>;
      rule: (
        appearanceId: number,
        alternativeId: number,
        verdict: string | null,
      ) => Promise<LookalikesPayload>;
    };
  } = {},
) {
  const { stage, shown, resets } = fakeStage();
  const { createGalleryStage, painted } = fakeGalleryStage();
  // Recorded rather than merely answered: "the same outfit is not read out of the game twice"
  // is a statement about what crossed the bridge, and only the request itself can say it.
  const loadWorn =
    options.bodies?.loadWorn ??
    vi.fn((_pieces: WornPiece[]): Promise<WornSetPayload> =>
      Promise.resolve({ model: model("a dressed body") }),
    );
  const loadCharacter =
    options.bodies?.loadCharacter ??
    vi.fn((): Promise<CharacterModelPayload> => Promise.resolve({ model: model("a bare body") }));
  const loadSet = vi.fn((setId: number) =>
    Promise.resolve(CONTENTS[setId] ?? { setId, appearances: [], readCount: 0, withheldCount: 0 }),
  );
  // The wardrobe half of the browser, which is not read at all until a reader asks for it —
  // recorded rather than answered, because that is the statement worth making about it.
  const loadAppearances = vi.fn((displayTypes: number[]) =>
    Promise.resolve(
      WARDROBE[displayTypes.join(",")] ?? {
        displayTypes,
        appearances: [],
        readCount: 0,
        withheldCount: 0,
      },
    ),
  );
  // The gallery half of the wardrobe, recorded for the same reason the outfit is: what matters
  // about it is which page the window asked the backend for, and only the request can say.
  const loadGallery = vi.fn((pieces: WornPiece[]) =>
    Promise.resolve({
      models: pieces.map((piece) => ({
        displayInfoId: piece.displayInfoId,
        kind: (piece.displayType >= 11 ? "held" : "worn") as GalleryKind,
        model: model(`${piece.displayInfoId} worn`),
      })),
    }),
  );
  // And the set grid drawn as characters, recorded for the reason the wardrobe's page is: what
  // matters about it is which cards the window asked the backend for, and only the request can
  // say. Ids rather than clothes, because a card holds nothing else until somebody opens it.
  const loadSetGallery = vi.fn((setIds: number[]): Promise<SetGalleryPayload> =>
    Promise.resolve({
      models: setIds.map((setId) => ({ setId, model: model(`set ${setId} worn`) })),
    }),
  );
  const marks = options.marks ?? fakeMarks();
  const saved = options.saved ?? fakeCustomSets();
  // Recorded as well as answered: "a slot's file is not downloaded until somebody browses that
  // slot" is a statement about what was asked for, and only the request can say it.
  const loadQualities = vi.fn((displayType: number) =>
    Promise.resolve(MEASURED[displayType] ?? null),
  );
  const loadSetQualities = vi.fn(() => Promise.resolve(SET_QUALITIES));
  const herself = options.herself ?? fakeHerself();
  const rendered = render(
    <Marked
      payload={options.payload === undefined ? SETS : options.payload}
      status={options.status ?? "Reading the game's transmog tables…"}
      statusRecourse={options.statusRecourse ?? null}
      loadSet={loadSet}
      loadAppearances={loadAppearances}
      loadIcons={() => Promise.resolve({ icons: {} })}
      loadCharacter={loadCharacter}
      loadWorn={loadWorn}
      loadGallery={loadGallery}
      loadSetGallery={loadSetGallery}
      herself={herself}
      store={marks}
      saved={saved}
      createStage={() => stage}
      createGalleryStage={createGalleryStage}
      loadQualities={loadQualities}
      loadSetQualities={loadSetQualities}
      loadWearers={options.wearers}
      loadOpenings={options.openings}
      loadAlternatives={options.alternatives}
      loadLookalikes={options.lookalikes?.load}
      setLookalike={options.lookalikes?.rule}
    />,
  );
  return {
    rendered,
    loadWorn,
    loadCharacter,
    loadSet,
    loadAppearances,
    loadGallery,
    loadSetGallery,
    marks,
    saved,
    herself,
    shown,
    resets,
    painted,
    loadQualities,
    loadSetQualities,
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
async function browseItems(already?: ReturnType<typeof view>): Promise<ReturnType<typeof view>> {
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

/**
 * What the pane around the character says it is doing, which the stylesheet reads and nothing
 * else does. `outfitPanel.css` hides the stage for two of the values and leaves it alone for the
 * rest, so this string is the whole of whether the reader is looking at a body or at nothing.
 */
function paneState(): string {
  return document.querySelector<HTMLElement>(".outfit-preview")?.dataset.state ?? "";
}

/** The same tips, taken apart: what each piece is, where it is, and where it came from. */
function wornTips(): { item: string; place: string; from: string }[] {
  const list = document.querySelector("#outfit-list");
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>(".outfit-slot [data-tip]")].map((tile) => {
    const tip = document.createElement("div");
    tip.innerHTML = tile.dataset.tip ?? "";
    const [place, from] = (tip.querySelector(".tip-line")?.textContent ?? "").split(" · ");
    return {
      item: tip.querySelector("b")?.textContent ?? "",
      place: place ?? "",
      from: from ?? "",
    };
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
    expect(document.querySelector("#outfit-summary")?.textContent).toBe(
      "Nothing on yet. Pick an appearance from any set.",
    );
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

  /* ---------- what is on the stage while the next body is being read ---------- */

  // The regression. Every piece put on is a second or two of the game's own storage, and the
  // pane used to answer that second by hiding the woman who was already standing there — so a
  // reader trying five hats saw five white rectangles rather than five hats. She stays.
  it("keeps the body already drawn on the stage while the next one is read", async () => {
    const bodies = heldBodies();
    const { loadCharacter, loadWorn, shown } = view({ bodies });
    // The bare body first: there has to be something on the stage before there is anything to
    // keep on it, and that is what the view opens on.
    await waitFor(() => expect(loadCharacter).toHaveBeenCalledTimes(1));
    bodies.answerBare();
    await waitFor(() => expect(shown).toHaveLength(1));

    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Crown of Tides" }));
    await waitFor(() => expect(loadWorn).toHaveBeenCalledTimes(1));

    // The dressed body is still in flight, and this is the moment the bug lives in. The
    // stylesheet hides the stage for exactly two of these values —
    // `.outfit-preview[data-state="empty"] .outfit-stage,
    // .outfit-preview[data-state="loading"] .outfit-stage { visibility: hidden; }` in
    // `outfitPanel.css` — so the pane saying either of them here *is* the white flash.
    expect(paneState()).toBe("redrawing");
    // And nothing new has reached the stage, which is what makes the picture still on it the
    // one that was there before the click.
    expect(shown).toHaveLength(1);

    bodies.answerWorn();
    await waitFor(() => expect(shown).toHaveLength(2));
    expect(paneState()).toBe("shown");
  });

  // The other side of it, and the one state that is blank on purpose: nothing has ever been
  // drawn here, so there is nothing to keep and an empty canvas must not be dressed up as a
  // picture of anybody.
  it("has nothing to keep on the stage before the first body has ever arrived", async () => {
    const bodies = heldBodies();
    const { loadCharacter, shown } = view({ bodies });

    await waitFor(() => expect(loadCharacter).toHaveBeenCalledTimes(1));
    expect(shown).toEqual([]);
    expect(paneState()).toBe("loading");
  });

  // The button belongs to the picture rather than to the pane, so it goes where the picture
  // goes: a body that is being redrawn is still a body somebody can have dragged too far.
  it("still offers the camera back while the next body is being read", async () => {
    const bodies = heldBodies();
    const { loadCharacter, loadWorn, resets, shown } = view({ bodies });
    await waitFor(() => expect(loadCharacter).toHaveBeenCalledTimes(1));
    bodies.answerBare();
    await waitFor(() => expect(shown).toHaveLength(1));
    await screen.findByRole("button", { name: "Reset camera" });

    const card = await open("Tideglass Regalia");
    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Crown of Tides" }));
    await waitFor(() => expect(loadWorn).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
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
    expect(
      within(card).getByRole("button", { name: "Wear Ammo: A quiver of arrows" }),
    ).toBeTruthy();
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
          Promise.resolve({ displayTypes, appearances: [], readCount: 0, withheldCount: 0 })
        }
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        loadGallery={() => Promise.resolve({ models: [] })}
        loadSetGallery={() => Promise.resolve({ models: [] })}
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
          Promise.resolve({ displayTypes, appearances: [], readCount: 0, withheldCount: 0 })
        }
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        loadGallery={() => Promise.resolve({ models: [] })}
        loadSetGallery={() => Promise.resolve({ models: [] })}
        herself={NOT_ASKED}
        marks={UNMARKED}
        inGame={NO_IN_GAME_SETS}
        custom={NO_SETS}
        createStage={() => {
          throw new Error("This machine cannot draw 3D.");
        }}
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
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Tideglass Regalia" })).toBeNull(),
    );
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy(),
    );
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy(),
    );
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
    expect(
      screen
        .getByRole("button", { name: "Wear Head: Emberforge Helm" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("puts a look picked out of the wardrobe on the character", async () => {
    const { loadWorn } = await browseItems();
    fireEvent.click(
      await screen.findByRole("button", { name: "Wear Head: Coif of the Drowned Star" }),
    );

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
    fireEvent.change(screen.getByLabelText("Kind of appearance"), {
      target: { value: "weapon-10" },
    });

    expect(await screen.findByText("Staff of the Quiet Tide")).toBeTruthy();
    expect(screen.queryByText("Emberforge Blade")).toBeNull();
    expect(loadAppearances).toHaveBeenLastCalledWith([11, 12, 13, 14, 15]);

    // And the seventeen kinds of weapon are that one answer: going from staves to swords is a
    // filter over what is already here rather than another second of the game's storage.
    fireEvent.change(screen.getByLabelText("Kind of appearance"), {
      target: { value: "weapon-7" },
    });
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
    fireEvent.change(screen.getByLabelText("Kind of appearance"), {
      target: { value: "armour-3" },
    });

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
 * A set and the difficulties and colours the game itself files under it.
 *
 * The largest fold the grid makes: 1,724 of a shipping install's rows are one of these, and a
 * card each is a raid tier shown thirteen times over. What the card owes the reader in exchange
 * is a way back to every one of them, which is the rail — see `foldFamilies`.
 */
describe("a set's variants", () => {
  afterEach(cleanup);

  /** The rail on a card, which is the one list on it that is not appearances. */
  function rail(card: HTMLElement): HTMLElement {
    return within(card).getByRole("list", {
      name: /^Difficulties and colours of /,
    });
  }

  /** The card a family draws, found by whichever member it is currently drawn as. */
  function cardOf(name: string): HTMLElement {
    const card = screen.getByRole("button", { name }).closest("article");
    if (!card) throw new Error(`${name} is on no card`);
    return card as HTMLElement;
  }

  it("draws one card for the family, as the set the game calls its root", () => {
    view({ payload: FAMILY });
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Scourgelord's Battlegear" })).toBeTruthy();
    // The variant is on the rail rather than on a card, and the heading it would have had is
    // nowhere on the screen.
    expect(
      screen.queryByRole("button", { name: "Sanctified Scourgelord's Battlegear" }),
    ).toBeNull();
  });

  // The grid is shorter than the count above it, and a reader counting cards against that
  // number has to be told why — the same sentence the other fold already earns.
  it("says how much of the game the rails are carrying", () => {
    view({ payload: FAMILY });
    expect(screen.getByText(/1 set shown as a variant on another's card/)).toBeTruthy();
  });

  it("names every member on the rail, and marks the one being shown", () => {
    view({ payload: FAMILY });
    const card = cardOf("Scourgelord's Battlegear");
    const picks = within(rail(card)).getAllByRole("button");
    expect(picks.map((pick) => pick.getAttribute("aria-label"))).toEqual([
      "Show Scourgelord's Battlegear",
      "Show Sanctified Scourgelord's Battlegear",
    ]);
    expect(picks.map((pick) => pick.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  // A set the game files under no parent is the ordinary case — two thirds of them — and its
  // card is exactly the card it was before any of this existed.
  it("draws no rail on a set with no variants", () => {
    view({ payload: FAMILY });
    const card = cardOf("Duskwoven Shroud");
    expect(within(card).queryByRole("list", { name: /^Difficulties and colours of / })).toBeNull();
  });

  it("redraws the card as the member picked off the rail", () => {
    view({ payload: FAMILY });
    const card = cardOf("Scourgelord's Battlegear");
    expect(card.textContent).toContain("5 items");
    fireEvent.click(
      within(card).getByRole("button", { name: "Show Sanctified Scourgelord's Battlegear" }),
    );
    expect(
      screen.getByRole("button", { name: "Sanctified Scourgelord's Battlegear" }),
    ).toBeTruthy();
    const swapped = cardOf("Sanctified Scourgelord's Battlegear");
    // Everything above the rail is about the member being shown: its name, what it is made of,
    // and the patch it arrived in.
    expect(swapped.textContent).toContain("9 items");
    expect(swapped.textContent).toContain("Patch 3.3.0");
    expect(swapped.textContent).toContain("#402");
    // And the rail is still the whole family, now pressed the other way round.
    const picks = within(rail(swapped)).getAllByRole("button");
    expect(picks.map((pick) => pick.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    // Still one card: picking a member swaps what is drawn rather than unfolding the family.
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  // The rail is for comparing the difficulties of a set, and a reader who has to open the card
  // again after every click is comparing nothing.
  it("keeps an open card open on the member picked, and reads what that one holds", async () => {
    const { loadSet } = view({ payload: FAMILY });
    const card = await open("Scourgelord's Battlegear");
    expect(within(card).getByRole("button", { name: /^Wear .*Crown of Tides$/ })).toBeTruthy();

    fireEvent.click(
      within(card).getByRole("button", { name: "Show Sanctified Scourgelord's Battlegear" }),
    );
    const swapped = cardOf("Sanctified Scourgelord's Battlegear");
    await waitFor(() =>
      expect(within(swapped).getByRole("button", { name: /^Wear .*Robe of Tides$/ })).toBeTruthy(),
    );
    expect(loadSet.mock.calls.map(([setId]) => setId)).toEqual([401, 402]);
  });

  // A card shut stays shut. Reading what a set is made of costs four tables, and a reader
  // clicking down a rail to look at the colours has asked for none of it.
  it("reads nothing for a member picked on a card that was never opened", () => {
    const { loadSet } = view({ payload: FAMILY });
    const card = cardOf("Scourgelord's Battlegear");
    fireEvent.click(
      within(card).getByRole("button", { name: "Show Sanctified Scourgelord's Battlegear" }),
    );
    expect(loadSet).not.toHaveBeenCalled();
  });

  // The picture on a card is of the set the card is drawn as, which is the whole point of the
  // rail once the grid is pictures: eighteen shades of one robe are eighteen bodies.
  it("draws the member picked when the cards are characters", async () => {
    const { loadSetGallery } = view({ payload: FAMILY });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show each set worn" }));
    await waitFor(() => expect(loadSetGallery).toHaveBeenCalled());
    expect(loadSetGallery.mock.calls[0]?.[0]).toEqual([401, 421]);

    const card = cardOf("Scourgelord's Battlegear");
    fireEvent.click(
      within(card).getByRole("button", { name: "Show Sanctified Scourgelord's Battlegear" }),
    );
    await waitFor(() => expect(loadSetGallery).toHaveBeenCalledTimes(2));
    expect(loadSetGallery.mock.calls[1]?.[0]).toEqual([402]);
  });

  // The whole risk of folding a set away, asked of the larger fold: a reader who types the name
  // of a difficulty has to land on the card carrying it rather than on nothing.
  it("finds the card by a name only the variant carries", async () => {
    view({ payload: FAMILY });
    fireEvent.change(screen.getByLabelText("Filter transmog sets"), {
      target: { value: "sanctified" },
    });
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Scourgelord's Battlegear" })).toBeTruthy();
  });
});

/**
 * The first chip on a card: who can really wear the set, rather than what mask it was filed under.
 *
 * The card used to draw `classLabel(set.classMask)` and so said "Cloth" and "Paladin" in one
 * voice, as though an armour type and a class lock were the same kind of fact. They are not: the
 * backend works out, from every item in the game that gives one of the set's looks, who can put
 * the whole thing on — see `wearers.rs` and `whoWears` — and that read is its own command,
 * arriving after the grid. So the chip has three states and this is all three: the mask before
 * the read lands, the phrase once it has, and the mask again for the sets it says nothing about.
 */
describe("who a card says can wear the set", () => {
  afterEach(cleanup);

  /**
   * Two sets whose masks say one thing and whose items say another.
   *
   * 601 is the case that motivated the issue: the game locks it to Paladins, and every one of
   * its looks is sold by something else to every class that can wear plate. 602 is the control —
   * the read says nothing about it, because this install can describe no item of it.
   */
  const WEARABLE: TransmogPayload = {
    sets: [
      set({ id: 601, name: "Emberforge Bulwark", group: "Emberforge Armory", classMask: 1 << 1 }),
      set({ id: 602, name: "Duskwoven Shroud", group: "Duskwoven Attire", classMask: 0x0190 }),
    ],
    readCount: 2,
    declaredCount: 2,
    withheldCount: 0,
  };

  const SAID: WearersPayload = {
    wearers: [{ setId: 601, classMask: 0x0023, openSlots: 4, blockedSlots: [] }],
    readCount: 1,
  };

  /**
   * The read, held open until the test lets it answer — or refuses it.
   *
   * Held rather than resolved, because two thirds of what this describe is about happens while
   * it is still in flight: a card that drew nothing, or drew the wrong thing, in the second
   * between the grid arriving and this landing is a card a reader has already looked at.
   */
  function heldWearers() {
    let hand: ((payload: WearersPayload) => void) | null = null;
    let refuse: ((error: unknown) => void) | null = null;
    return {
      loadWearers: vi.fn(
        () =>
          new Promise<WearersPayload>((resolve, reject) => {
            hand = resolve;
            refuse = reject;
          }),
      ),
      answer: (payload: WearersPayload): void => {
        if (!hand) throw new Error("nothing has asked who can wear anything");
        hand(payload);
      },
      /** What a machine mid-patch does: the tables are there and cannot be read. */
      refuse: (): void => {
        if (!refuse) throw new Error("nothing has asked who can wear anything");
        refuse(new Error("The game is being patched."));
      },
    };
  }

  /** The card a set is drawn on, found by the heading a reader opens it with. */
  function cardOf(name: string): HTMLElement {
    const card = screen.getByRole("button", { name }).closest("article");
    if (!card) throw new Error(`${name} is on no card`);
    return card as HTMLElement;
  }

  // The whole of the change, seen from the reader's side: a set the game calls a Paladin's says
  // a Warrior can have the clothes.
  it("draws what the items say once the read has landed", async () => {
    const held = heldWearers();
    view({ payload: WEARABLE, wearers: held.loadWearers });
    await waitFor(() => expect(held.loadWearers).toHaveBeenCalledTimes(1));

    await act(async () => {
      held.answer(SAID);
    });
    expect(within(cardOf("Emberforge Bulwark")).getByText("Any plate wearer")).toBeTruthy();
    expect(within(cardOf("Emberforge Bulwark")).queryByText("Paladin")).toBeNull();
  });

  // And the classes themselves, which the chip has no room for and the card can carry: the
  // title is the list of who, and it has to be the same fact the chip is about.
  it("titles the card with the classes the items really allow", async () => {
    const held = heldWearers();
    view({ payload: WEARABLE, wearers: held.loadWearers });
    await waitFor(() => expect(held.loadWearers).toHaveBeenCalledTimes(1));
    // The game's own mask until then, which is three names shorter than the truth.
    expect(cardOf("Emberforge Bulwark").getAttribute("title")).toBe("Paladin");

    await act(async () => {
      held.answer(SAID);
    });
    expect(cardOf("Emberforge Bulwark").getAttribute("title")).toBe(
      "Warrior, Paladin, Death Knight",
    );
  });

  // The second the grid is up and this is not. A card drawn blank, or drawn as though nobody
  // could wear anything, is a card a reader reads before the answer arrives.
  it("draws the game's own mask while the read is still in flight", async () => {
    const held = heldWearers();
    view({ payload: WEARABLE, wearers: held.loadWearers });
    await waitFor(() => expect(held.loadWearers).toHaveBeenCalledTimes(1));

    expect(within(cardOf("Emberforge Bulwark")).getByText("Paladin")).toBeTruthy();
    expect(screen.queryByText("Any plate wearer")).toBeNull();
  });

  // And a set the answer says nothing about keeps the mask for good, because that is the whole
  // of what is known about it: every item behind it sits in a section this install has no key to.
  it("keeps the game's own mask on a set the read says nothing about", async () => {
    const held = heldWearers();
    view({ payload: WEARABLE, wearers: held.loadWearers });
    await waitFor(() => expect(held.loadWearers).toHaveBeenCalledTimes(1));

    await act(async () => {
      held.answer(SAID);
    });
    expect(within(cardOf("Duskwoven Shroud")).getByText("Cloth")).toBeTruthy();
    expect(cardOf("Duskwoven Shroud").getAttribute("title")).toBe("Priest, Mage, Warlock");
  });

  // The read is a walk of `Item` and `ItemSparse` and can fail on its own, and the grid it is
  // about arrived without it. Every card is exactly the card it was before any of this existed.
  it("leaves every card as it was when the read fails", async () => {
    const held = heldWearers();
    view({ payload: WEARABLE, wearers: held.loadWearers });
    await waitFor(() => expect(held.loadWearers).toHaveBeenCalledTimes(1));

    await act(async () => {
      held.refuse();
    });
    expect(within(cardOf("Emberforge Bulwark")).getByText("Paladin")).toBeTruthy();
    expect(within(cardOf("Duskwoven Shroud")).getByText("Cloth")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  // Nothing to ask about. The read walks the game's own tables and there is no install to walk
  // when the grid itself could not be read, so it waits for the payload rather than for the view.
  it("asks nobody who can wear anything until there are sets to ask about", async () => {
    const held = heldWearers();
    view({ payload: null, wearers: held.loadWearers });
    await waitFor(() =>
      expect(screen.getByText("Reading the game's transmog tables…")).toBeTruthy(),
    );
    expect(held.loadWearers).not.toHaveBeenCalled();
  });
});

/**
 * The panel inside an opened class-locked set: how anybody gets the looks it keeps from them.
 *
 * The chip above says whether the lock stands for the whole set; this says which slot did it, and
 * where to go instead. That is the difference between "Paladin only" and the eight rows a reader
 * standing in front of a raid tier actually needs — seven of them on a world drop and the eighth
 * on nothing at all. See `openings.ts` for the rows and `openings.rs` for the read behind them.
 */
describe("how anybody gets the looks a set locks", () => {
  afterEach(cleanup);

  const LOCKED: TransmogPayload = {
    sets: [
      set({ id: 701, name: "Lightsworn Plate", group: "Icecrown Citadel", classMask: 0x0002 }),
    ],
    readCount: 1,
    declaredCount: 1,
    withheldCount: 0,
  };

  /**
   * What the backend read out of every item in the game for that set.
   *
   * The helm is opened by an item belonging to no set at all — which is where 87% of these live,
   * and the whole reason the read walks the game rather than the set — and the greaves are in
   * `blocked`, which is the one row the panel exists to draw.
   */
  const SOLD_AROUND: OpeningsPayload = {
    setId: 701,
    openings: [
      {
        appearanceId: 10,
        itemId: 30_025,
        name: "Crown of the Wanderer",
        requiredLevel: 30,
        quality: 3,
      },
    ],
    blocked: [11],
    readCount: 1,
    withheldCount: 0,
  };

  /** The read, held open until a test lets it answer — the panel says so meanwhile. */
  function heldOpenings() {
    let hand: ((payload: OpeningsPayload) => void) | null = null;
    return {
      loadOpenings: vi.fn(
        (_setId: number) =>
          new Promise<OpeningsPayload>((resolve) => {
            hand = resolve;
          }),
      ),
      answer: (payload: OpeningsPayload): void => {
        if (!hand) throw new Error("nothing has asked how anybody gets anything");
        hand(payload);
      },
    };
  }

  /** The panel's table, which is named after the set whose locks it is about. */
  async function panelOf(card: HTMLElement, name: string): Promise<HTMLElement> {
    return within(card).findByRole("table", { name: `How anyone gets the looks ${name} locks` });
  }

  /**
   * One row of it, found by the slot it is named after.
   *
   * The slot is the row's header rather than a cell, which is what lets a reader scanning the
   * body find the row and a screen reader announce which look each answer belongs to.
   */
  function slotRow(table: HTMLElement, slot: string): HTMLElement {
    const row = within(table).getByRole("rowheader", { name: slot }).closest("tr");
    if (!row) throw new Error(`${slot} is on no row of the panel`);
    return row as HTMLElement;
  }

  // The whole feature, seen from the reader's side: the slot that locked them out, the item they
  // cannot have, and the item anybody can — which is in no set and unreachable from this grid.
  it("names the item anybody can wear for a look the set keeps to one class", async () => {
    const held = heldOpenings();
    view({ payload: LOCKED, openings: held.loadOpenings });
    const card = await open("Lightsworn Plate");
    await waitFor(() => expect(held.loadOpenings).toHaveBeenCalledWith(701));

    await act(async () => {
      held.answer(SOLD_AROUND);
    });
    const table = await panelOf(card, "Lightsworn Plate");
    const head = slotRow(table, "Head");
    expect(within(head).getByRole("cell", { name: "Lightsworn Helm" })).toBeTruthy();
    // The level and the colour beside the name, which are what a reader recognises a drop by.
    expect(
      within(head).getByRole("cell", { name: /Crown of the Wanderer · Rare · Level 30/ }),
    ).toBeTruthy();
    // And the count over the table, which is the answer for a reader who reads nothing else.
    expect(
      within(card).getByText("1 of the 2 looks this set locks is on an item anybody can wear"),
    ).toBeTruthy();
  });

  // The row the panel is read for, and the reason it is a sentence rather than an empty cell: a
  // blank is a thing that failed to load, and this is the fact that decides whether the set is
  // worth chasing at all.
  it("says in words when nothing in the game sells a locked look around", async () => {
    const held = heldOpenings();
    view({ payload: LOCKED, openings: held.loadOpenings });
    const card = await open("Lightsworn Plate");
    await waitFor(() => expect(held.loadOpenings).toHaveBeenCalledWith(701));

    await act(async () => {
      held.answer(SOLD_AROUND);
    });
    const table = await panelOf(card, "Lightsworn Plate");
    expect(
      within(slotRow(table, "Legs")).getByText("Nothing gives this look to another class"),
    ).toBeTruthy();
    // And the look the set already sells to everybody is no row at all: nobody was stopped at
    // it, and a table where half the rows say "you were never kept from this" buries the one
    // that says they were.
    expect(within(table).queryByRole("rowheader", { name: "Chest" })).toBeNull();
  });

  // The cost guard. The read is the walk of `Item` and `ItemSparse` the item browser pays for one
  // slot at a time, and it is paid again per set opened — so a set that shuts nobody out must not
  // ask it. Only what the set holds can say that, which is why it is asked after the contents
  // land rather than when the card is clicked.
  it("asks nothing at all for a set that locks nobody out", async () => {
    const held = heldOpenings();
    view({ openings: held.loadOpenings });
    const card = await open("Tideglass Regalia");

    expect(held.loadOpenings).not.toHaveBeenCalled();
    expect(within(card).queryByRole("table")).toBeNull();
  });

  // A read in flight is a second of the game's own storage, and the panel's whole content is
  // what could not be found — so it says it is still looking rather than drawing an empty table
  // a reader would read as an answer.
  it("says it is still reading until the answer lands", async () => {
    const held = heldOpenings();
    view({ payload: LOCKED, openings: held.loadOpenings });
    const card = await open("Lightsworn Plate");
    await waitFor(() => expect(held.loadOpenings).toHaveBeenCalledWith(701));

    expect(within(card).getByText("Reading who else sells these looks…")).toBeTruthy();
    expect(
      within(card).queryByRole("table", {
        name: "How anyone gets the looks Lightsworn Plate locks",
      }),
    ).toBeNull();
  });

  /* ---------- and what else might do, where nothing sells it around ---------- */

  /**
   * What the two measures had to say about the greaves nothing in the game sells around.
   *
   * Both kinds of claim, because the panel's whole job is not to draw them alike: the first row
   * is an equality between two mesh signatures and the second is two thumbnails 3.9% apart under
   * a threshold this install cut for the legs. See `alternatives.rs`.
   */
  const MIGHT_DO: AlternativesPayload = {
    appearanceId: 11,
    geometryAnswers: true,
    lookalikesReady: true,
    sameMesh: [
      {
        appearanceId: 12,
        itemId: 12,
        name: "Greaves of the Wanderer",
        requiredLevel: 30,
        quality: 3,
        iconFileDataId: 0,
        classId: 4,
        subclassId: 4,
      },
    ],
    lookalikes: [
      {
        appearanceId: 13,
        itemId: 13,
        name: "Legwraps of the Quiet Deep",
        requiredLevel: 0,
        quality: 2,
        iconFileDataId: 0,
        classId: 4,
        subclassId: 1,
        distance: 0.039,
      },
    ],
  };

  /** A set opened on its blocked row, with the suggestions already drawn. */
  async function suggestions(
    over: Partial<AlternativesPayload> = {},
    lookalikes?: NonNullable<Parameters<typeof view>[0]>["lookalikes"],
  ) {
    const held = heldOpenings();
    const alternatives = vi.fn((appearanceId: number, _displayType: number) =>
      Promise.resolve({ ...MIGHT_DO, appearanceId, ...over }),
    );
    view({ payload: LOCKED, openings: held.loadOpenings, alternatives, lookalikes });
    const card = await open("Lightsworn Plate");
    await waitFor(() => expect(held.loadOpenings).toHaveBeenCalledWith(701));
    await act(async () => {
      held.answer(SOLD_AROUND);
    });
    const table = await panelOf(card, "Lightsworn Plate");
    await act(async () => {
      fireEvent.click(
        within(table).getByRole("button", {
          name: "Show possible alternatives to Lightsworn Greaves",
        }),
      );
    });
    return { card, table, alternatives };
  }

  // The whole of the last tier, from the reader's side: the red row carries a way on, and behind
  // it are the two things still worth saying — the same armour in another colour, and something
  // the pictures say is near, with the number it was ranked by on it.
  it("offers what else might do behind a button on the row that has no answer", async () => {
    const { table, alternatives } = await suggestions();
    // Asked for the look and its slot, both measures behind the answer being per slot.
    expect(alternatives).toHaveBeenCalledWith(11, 5);

    const list = await within(table).findByRole("list", {
      name: "Possible alternatives to Lightsworn Greaves",
    });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Greaves of the Wanderer"),
      expect.stringContaining("Legwraps of the Quiet Deep"),
    ]);
    // An equality reads as an equality and a distance reads as a distance. A panel that drew
    // them alike would lend the second the first's certainty, which is the one thing this
    // half of the feature must not do.
    expect(rows[0]?.textContent).toContain("The same armour, another colour");
    expect(rows[1]?.textContent).toContain("96.1% alike");
    // And the kind of armour on both, because the world drop that lifts a class lock nearly
    // always lifts the class and not the kind: a cloth answer is no use to a plate wearer.
    expect(rows[0]?.textContent).toContain("Plate");
    expect(rows[1]?.textContent).toContain("Cloth");
  });

  // Nothing is asked until the button is pressed. Both measures cost a walk of the game's own
  // files and one of them starts half a minute of decoding textures, so a reader who came for
  // the certain half pays for none of it.
  it("asks nothing about what else might do until somebody presses the button", async () => {
    const held = heldOpenings();
    const alternatives = vi.fn(() => Promise.resolve(MIGHT_DO));
    view({ payload: LOCKED, openings: held.loadOpenings, alternatives });
    const card = await open("Lightsworn Plate");
    await waitFor(() => expect(held.loadOpenings).toHaveBeenCalledWith(701));
    await act(async () => {
      held.answer(SOLD_AROUND);
    });
    await panelOf(card, "Lightsworn Plate");

    expect(alternatives).not.toHaveBeenCalled();
  });

  // The state that is not an answer. Half a minute of decoding the game's textures stands
  // between a fresh install and the ranked half, and a panel that said "nothing looks like this"
  // meanwhile would be the app reporting its own unfinished work as a fact about the game.
  it("says the pictures are still being read rather than that nothing matched", async () => {
    const { table } = await suggestions({
      sameMesh: [],
      lookalikes: [],
      lookalikesReady: false,
    });
    expect(
      await within(table).findByText(
        "Chronie is reading the game's own textures to answer this — about a minute, once per patch",
      ),
    ).toBeTruthy();
  });

  // And what a person says about a suggestion, which is the one thing here that outlives a
  // patch: both stores are thrown away and measured again, and this is not.
  it("keeps what somebody decided about a suggestion", async () => {
    let said: LookalikeVerdict[] = [];
    const rule = vi.fn((appearanceId: number, alternativeId: number, verdict: string | null) => {
      said = verdict ? [{ appearanceId, alternativeId, verdict }] : [];
      return Promise.resolve({ said });
    });
    const { table } = await suggestions({}, { load: () => Promise.resolve({ said }), rule });

    const list = await within(table).findByRole("list", {
      name: "Possible alternatives to Lightsworn Greaves",
    });
    await act(async () => {
      fireEvent.click(
        within(list).getByRole("button", {
          name: "That is the one: Legwraps of the Quiet Deep",
        }),
      );
    });
    expect(rule).toHaveBeenCalledWith(11, 13, "yes");

    // What was stored is what is drawn: the row is now pressed, and it has been lifted above
    // the exact one, a person's answer outranking a measurement.
    const after = within(list).getByRole("button", {
      name: "That is the one: Legwraps of the Quiet Deep",
    });
    expect(after.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => row.textContent?.includes("Legwraps of the Quiet Deep")),
    ).toEqual([true, false]);
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
    expect(loadGallery.mock.calls[0]?.[0].map((piece) => piece.displayInfoId)).toEqual([
      900_040, 900_099,
    ]);
  });

  // And the page is a fifth of what the same list draws as names, because a row of names is a
  // string and a row of models is a character read out of the game's own files.
  it("draws fewer looks at a time than the same list of names does", async () => {
    const { loadGallery } = await showWorn();
    fireEvent.change(screen.getByLabelText("Kind of appearance"), {
      target: { value: "armour-3" },
    });
    await screen.findByText("Robe 000");

    expect(screen.getByText("20 of 120 appearances")).toBeTruthy();
    expect(screen.queryByText("Robe 020")).toBeNull();
    await waitFor(() =>
      expect(loadGallery).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.objectContaining({ displayInfoId: 901_019 })]),
      ),
    );
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
    expect(painted.map((one) => one.label)).toEqual([
      "Coif of the Drowned Star, drawn",
      "Emberforge Helm, drawn",
    ]);
    for (const one of painted) expect(one.holds).toBeLessThan(1);
  });

  // What is already drawn is not asked for again. The two halves of the browser share looks —
  // the same helm is under Head and inside three sets — so going away and coming back has to
  // be free rather than another page of the game's tables.
  it("does not ask twice for a look it already holds", async () => {
    const { loadGallery } = await showWorn();
    fireEvent.change(screen.getByLabelText("Kind of appearance"), {
      target: { value: "armour-3" },
    });
    await screen.findByText("Robe 000");
    await waitFor(() => expect(loadGallery).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText("Kind of appearance"), {
      target: { value: "armour-0" },
    });
    await screen.findByText("Coif of the Drowned Star");
    await waitFor(() => expect(screen.getAllByLabelText(/, drawn$/)).toHaveLength(2));
    expect(loadGallery).toHaveBeenCalledTimes(2);
  });

  // Turning it off puts the names back, and gives the graphics context back with them: twenty
  // live contexts is more than a browser hands out, and the one here is held only while the
  // reader is looking at pictures.
  it("goes back to the icons, and gives the context back", async () => {
    const disposals = { count: 0 };
    const stage: GalleryStage = {
      paint: () => Promise.resolve(),
      dispose: () => {
        disposals.count += 1;
      },
    };
    await browseItems(view());
    cleanup();

    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={(setId) => Promise.resolve(CONTENTS[setId] as TransmogSetItemsPayload)}
        loadAppearances={(displayTypes) =>
          Promise.resolve(
            WARDROBE[displayTypes.join(",")] ?? {
              displayTypes,
              appearances: [],
              readCount: 0,
              withheldCount: 0,
            },
          )
        }
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        herself={NOT_ASKED}
        loadGallery={(pieces) =>
          Promise.resolve({
            models: pieces.map((piece) => ({
              displayInfoId: piece.displayInfoId,
              kind: "worn" as GalleryKind,
              model: model("worn"),
            })),
          })
        }
        loadSetGallery={(setIds) =>
          Promise.resolve({
            models: setIds.map((setId) => ({ setId, model: model(`set ${setId} worn`) })),
          })
        }
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
    const coming = new Promise<GalleryStage>((resolve) => {
      arrive = resolve;
    });
    await browseItems(view());
    cleanup();

    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={(setId) => Promise.resolve(CONTENTS[setId] as TransmogSetItemsPayload)}
        loadAppearances={(displayTypes) =>
          Promise.resolve(
            WARDROBE[displayTypes.join(",")] ?? {
              displayTypes,
              appearances: [],
              readCount: 0,
              withheldCount: 0,
            },
          )
        }
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        herself={NOT_ASKED}
        loadGallery={(pieces) =>
          Promise.resolve({
            models: pieces.map((piece) => ({
              displayInfoId: piece.displayInfoId,
              kind: "worn" as GalleryKind,
              model: model("worn"),
            })),
          })
        }
        loadSetGallery={(setIds) =>
          Promise.resolve({
            models: setIds.map((setId) => ({ setId, model: model(`set ${setId} worn`) })),
          })
        }
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
    arrive({
      paint: () => Promise.resolve(),
      dispose: () => {
        disposals.count += 1;
      },
    });
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
          Promise.resolve(
            WARDROBE[displayTypes.join(",")] ?? {
              displayTypes,
              appearances: [],
              readCount: 0,
              withheldCount: 0,
            },
          )
        }
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        herself={NOT_ASKED}
        loadGallery={() => Promise.reject(new Error("The game's files are not readable."))}
        loadSetGallery={() => Promise.resolve({ models: [] })}
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
 * The set grid drawn as the clothes it is, rather than as a list of names.
 *
 * A card is a name, a count and a row of chips, and none of that says what a set of clothes
 * looks like — which is what issue #143 is. What every one of these is about is that the *page*
 * is the unit, the same way it is for the wardrobe beside it: the backend builds one body and
 * dresses it once per card, so a page costs about what a card costs and a window that asked a
 * card at a time would give all of that back.
 */
describe("the sets as models", () => {
  afterEach(cleanup);

  /** Turns the pictures on, and waits for the page the grid asks for to arrive. */
  async function showSets(already?: ReturnType<typeof view>): Promise<ReturnType<typeof view>> {
    const shown = already ?? view();
    fireEvent.click(screen.getByLabelText("Show each set worn"));
    await waitFor(() => expect(shown.loadSetGallery).toHaveBeenCalled());
    return shown;
  }

  /** The picture on one card, found by the set it is of. */
  function shot(name: string): HTMLElement {
    return screen.getByLabelText(`${name}, drawn`);
  }

  // One request for the whole page, and it names every card of it by id — because an id is all
  // a card holds until somebody opens it, and reading what a set is made of to draw a picture
  // of it is the trip this exists to avoid.
  it("asks for a whole page of sets in one request", async () => {
    const { loadSetGallery } = await showSets();
    expect(loadSetGallery).toHaveBeenCalledTimes(1);
    expect(loadSetGallery.mock.calls[0]?.[0]).toEqual([201, 203]);
  });

  // And each of them is painted on the grid's one stage, holding the whole of her. A set is a
  // body's worth of clothes and there is no part of her it is about — which is the one framing
  // decision a card makes, and the opposite of the wardrobe's.
  it("draws every card as the whole of the character wearing that set", async () => {
    const { painted } = await showSets();
    await waitFor(() => expect(painted).toHaveLength(2));
    expect(painted.map((one) => one.label)).toEqual([
      "Tideglass Regalia, drawn",
      "Emberforge Plate, drawn",
    ]);
    for (const one of painted) expect(one.holds).toBe(1);
  });

  // The picture is something to drag, so it is not inside the button that opens the set: a
  // click that turned out to be a drag would otherwise open a set every time somebody turned
  // one round to look at the back of it.
  it("keeps the picture out of the button that opens the set", async () => {
    await showSets();
    const picture = shot("Tideglass Regalia");
    expect(picture.closest("button")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Tideglass Regalia" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  // A card this install can put nothing on her for keeps everything it had. The name, the
  // count and the chips are what the grid was before any of this, and they are still the
  // answer to what the set is.
  it("keeps a card the install can draw nothing for", async () => {
    const shown = view();
    shown.loadSetGallery.mockImplementation((setIds: number[]) =>
      Promise.resolve({
        models: setIds.map((setId) => ({ setId, model: setId === 201 ? null : model("worn") })),
      }),
    );
    await showSets(shown);
    await waitFor(() => expect(shot("Emberforge Plate")).toBeTruthy());
    expect(screen.queryByLabelText("Tideglass Regalia, drawn")).toBeNull();
    expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy();
  });

  // A page that will not come leaves the grid exactly as it was before anybody asked for
  // pictures, rather than a column of cards waiting for ever.
  it("keeps the grid when a page of sets will not come", async () => {
    const shown = view();
    shown.loadSetGallery.mockImplementation(() =>
      Promise.reject(new Error("The game's files are not readable.")),
    );
    await showSets(shown);
    await waitFor(() => expect(shown.loadSetGallery).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/, drawn$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy();
  });

  // The grid is paged once there is a body behind each card, and only then: a grid of names is
  // cheap to draw whole, and seeing every set a search left is what it is for.
  it("draws fewer sets at a time than the same grid of names does", async () => {
    const shown = view({ payload: MANY_SETS });
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(MANY_SETS.sets.length);
    expect(screen.getByText("16 sets shown")).toBeTruthy();

    await showSets(shown);
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(12);
    expect(screen.getByText("12 of 16 sets")).toBeTruthy();
    expect(shown.loadSetGallery.mock.calls[0]?.[0]).toHaveLength(12);

    fireEvent.click(screen.getByRole("button", { name: "Show 4 more of 4 sets" }));
    await waitFor(() => expect(shown.loadSetGallery).toHaveBeenCalledTimes(2));
    // Only the four that were not already on screen: what is drawn stays drawn, and the second
    // page is the four cards it added rather than the sixteen now showing.
    expect(shown.loadSetGallery.mock.calls[1]?.[0]).toEqual([313, 314, 315, 316]);
  });

  // A search starts the grid again from the top. Otherwise a reader who had gone five pages
  // down and then typed a name would be shown the sixtieth card of what the name left.
  it("starts the grid again when the reader narrows it", async () => {
    const shown = view({ payload: MANY_SETS });
    await showSets(shown);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more of 4 sets" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(16));

    fireEvent.change(screen.getByLabelText("Filter transmog sets"), { target: { value: "deep" } });
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(12));
    expect(screen.getByText("12 of 16 sets")).toBeTruthy();
  });

  // Turning it off puts the plain cards back, and gives the graphics context back with them —
  // one context is held only while somebody is looking at pictures.
  it("goes back to the plain cards, and gives the context back", async () => {
    const disposals = { count: 0 };
    const stage: GalleryStage = {
      paint: () => Promise.resolve(),
      dispose: () => {
        disposals.count += 1;
      },
    };
    render(
      <TransmogView
        payload={SETS}
        status=""
        loadSet={(setId) => Promise.resolve(CONTENTS[setId] as TransmogSetItemsPayload)}
        loadAppearances={(displayTypes) =>
          Promise.resolve({ displayTypes, appearances: [], readCount: 0, withheldCount: 0 })
        }
        loadIcons={() => Promise.resolve({ icons: {} })}
        loadCharacter={() => Promise.resolve({ model: model("a bare body") })}
        loadWorn={() => Promise.resolve({ model: model("a dressed body") })}
        loadGallery={() => Promise.resolve({ models: [] })}
        loadSetGallery={(setIds) =>
          Promise.resolve({
            models: setIds.map((setId) => ({ setId, model: model(`set ${setId} worn`) })),
          })
        }
        herself={NOT_ASKED}
        marks={UNMARKED}
        custom={NO_SETS}
        inGame={NO_IN_GAME_SETS}
        createStage={() => fakeStage().stage}
        createGalleryStage={() => stage}
      />,
    );
    fireEvent.click(screen.getByLabelText("Show each set worn"));
    await waitFor(() => expect(screen.getAllByLabelText(/, drawn$/)).toHaveLength(2));

    fireEvent.click(screen.getByLabelText("Show each set worn"));
    expect(screen.queryByLabelText(/, drawn$/)).toBeNull();
    await waitFor(() => expect(disposals.count).toBe(1));
    // And the cards are the cards they always were.
    expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy();
  });

  // Every card is a picture of her, so answering a question about her body makes all of them
  // pictures of somebody else — and the page is asked for again rather than checked card by
  // card.
  it("reads the page again once she is somebody else", async () => {
    const shown = await showSets();
    const details = screen.getByText("Who she is").closest("details");
    if (!details) throw new Error("the panel has no disclosure to open");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(shown.herself.load).toHaveBeenCalled());
    await screen.findByRole("combobox", { name: "Hair Style" });

    fireEvent.change(screen.getByRole("combobox", { name: "Hair Style" }), {
      target: { value: "133" },
    });

    await waitFor(() => expect(shown.loadSetGallery).toHaveBeenCalledTimes(2));
    expect(shown.loadSetGallery.mock.calls[1]?.[0]).toEqual([201, 203]);
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
    expect(shown.loadGallery.mock.calls[1]?.[0].map((piece) => piece.displayInfoId)).toEqual([
      900_040, 900_099,
    ]);
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

  // And she stays on the stage while the woman she has just become is read out of the game.
  // Answering a question about her hair throws away every body the window holds, which is the
  // right thing to do with them and no reason at all to take the picture down in the meantime:
  // the reader is comparing two hairstyles and would be comparing one of them with a blank.
  it("keeps her on the stage while the body she is now is read", async () => {
    const bodies = heldBodies();
    const shown = view({ bodies });
    await waitFor(() => expect(shown.loadCharacter).toHaveBeenCalledTimes(1));
    bodies.answerBare();
    await waitFor(() => expect(shown.shown).toHaveLength(1));
    await askable(shown);

    fireEvent.change(screen.getByRole("combobox", { name: "Hair Style" }), {
      target: { value: "133" },
    });
    await waitFor(() => expect(shown.loadCharacter).toHaveBeenCalledTimes(2));

    // The braided one is still being read, and the loose one is what is on the stage until it
    // arrives — see the stylesheet's hide rule, which names neither this state nor "shown".
    expect(paneState()).toBe("redrawing");
    expect(shown.shown).toHaveLength(1);

    bodies.answerBare("a bare body, braided");
    await waitFor(() => expect(shown.shown).toHaveLength(2));
    expect(paneState()).toBe("shown");
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

    await waitFor(() =>
      expect(marks.stored()).toEqual([{ kind: "set", id: 201, favourite: true, tags: [] }]),
    );
    await waitFor(() =>
      expect(star(card, "Tideglass Regalia").getAttribute("aria-pressed")).toBe("true"),
    );
  });

  // Un-starring deletes the row rather than storing a `false`, which is the migration's own
  // rule and the reason a mark saying nothing is no mark at all.
  it("takes a star off again and leaves nothing behind", async () => {
    const { marks } = view({
      marks: fakeMarks([{ kind: "set", id: 201, favourite: true, tags: [] }]),
    });
    const card = cardFor("Tideglass Regalia");
    expect(star(card, "Tideglass Regalia").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(star(card, "Tideglass Regalia"));

    await waitFor(() => expect(marks.stored()).toEqual([]));
  });

  it("writes a tag with a value, and one without as a label", async () => {
    const { marks } = view();
    const card = cardFor("Tideglass Regalia");

    tagIt(card, "Tideglass Regalia", "faction", "horde");
    await waitFor(() =>
      expect(marks.stored()[0]?.tags).toEqual([{ key: "faction", value: "horde" }]),
    );

    tagIt(card, "Tideglass Regalia", "wishlist");
    await waitFor(() =>
      expect(marks.stored()[0]?.tags).toEqual([
        { key: "faction", value: "horde" },
        { key: "wishlist", value: null },
      ]),
    );
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

    fireEvent.click(
      within(card).getByRole("button", {
        name: "Remove the tag faction: horde from Tideglass Regalia",
      }),
    );

    await waitFor(() => expect(marks.stored()).toEqual([]));
  });

  // What the reader typed is judged by the backend — the length limits and the cleaning are
  // `marks.rs` — so the one thing the view owes them is the sentence saying why nothing
  // happened, rather than a chip that appears and is gone on the next read.
  it("says why a write was refused rather than pretending it landed", async () => {
    const { marks } = view();
    const card = cardFor("Tideglass Regalia");
    marks.setTag.mockImplementationOnce(() =>
      Promise.reject(new Error("A tag's name has to fit in 48 characters.")),
    );

    tagIt(card, "Tideglass Regalia", "a".repeat(60));

    expect(await within(card).findByRole("alert")).toHaveProperty(
      "textContent",
      "A tag's name has to fit in 48 characters.",
    );
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

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Emberforge Plate" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy();
  });

  it("narrows the grid to one tag, and offers only the tags in use", async () => {
    view({
      marks: fakeMarks([
        { kind: "set", id: 203, favourite: false, tags: [{ key: "wishlist", value: null }] },
      ]),
    });
    const picker = screen.getByLabelText("Tag");
    expect([...picker.querySelectorAll("option")].map((one) => one.textContent)).toEqual([
      "Any tag",
      "wishlist",
    ]);

    fireEvent.change(picker, { target: { value: "wishlist" } });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Tideglass Regalia" })).toBeNull(),
    );
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

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Tideglass Regalia" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Emberforge Plate" })).toBeTruthy();
  });

  // The whole argument for keying a mark on the appearance rather than on the item or on the
  // set that named it: the two halves of the browser are looking at one wardrobe.
  it("shows a look starred in a set as starred in the wardrobe beside it", async () => {
    const already = view();
    const card = await open("Emberforge Plate");
    fireEvent.click(star(card, "Emberforge Helm"));
    await waitFor(() =>
      expect(already.marks.stored()).toEqual([
        { kind: "appearance", id: 3, favourite: true, tags: [] },
      ]),
    );

    await browseItems(already);

    const row = screen.getByRole("button", { name: "Wear Head: Emberforge Helm" }).closest("li");
    expect(
      within(row as HTMLElement)
        .getByRole("button", { name: "Favourite Emberforge Helm" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("stars a look out of the game's whole wardrobe", async () => {
    const { marks } = await browseItems();
    const row = (await screen.findByText("Coif of the Drowned Star")).closest("li") as HTMLElement;

    fireEvent.click(star(row, "Coif of the Drowned Star"));

    await waitFor(() =>
      expect(marks.stored()).toEqual([{ kind: "appearance", id: 40, favourite: true, tags: [] }]),
    );
  });

  it("narrows a kind to the starred looks", async () => {
    await browseItems(
      view({
        marks: fakeMarks([{ kind: "appearance", id: 40, favourite: true, tags: [] }]),
      }),
    );
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
 * Asking for a look by clicking what is written on it, rather than by knowing what to type.
 *
 * A chip states one thing about a row under a name — brown, large, `faction: horde` — and the box
 * above the list reads exactly that shape of question. So every chip is the way in: clicking one
 * writes its term into the box, and that is also the whole of how anybody finds out the box takes
 * terms at all. What a term means and how one parses is `terms.test.ts`; what these ask is the
 * other half, which only the assembled view can answer — that the chip a reader can see and the
 * box above it are wired to each other, and that a chip on a row the box does not filter is not
 * offered as a way of filtering it.
 */
describe("narrowing a list by clicking what is written on it", () => {
  /** The one box above the wardrobe, which is where a clicked chip writes what it asks for. */
  const box = (): HTMLInputElement =>
    screen.getByLabelText("Filter appearances") as HTMLInputElement;

  /** The row one look is on, which is where its own chips are. */
  const rowOf = (label: string): HTMLElement => {
    const row = screen.getByText(label).closest("li");
    if (!row) throw new Error(`${label} is on no row`);
    return row as HTMLElement;
  };

  /** A chip on that row, which is named by what clicking it would ask the list for. */
  const chip = (label: string, asks: string): HTMLElement =>
    within(rowOf(label)).getByRole("button", { name: `Filter by ${asks}` });

  /**
   * The same, for a chip the reader wrote rather than one the artwork was measured for.
   *
   * The two are named apart on purpose: "filter by brown" out of a row carrying both would not
   * say which of them it came from — see `marksEditor`.
   */
  const tagChip = (label: string, asks: string): HTMLElement =>
    within(rowOf(label)).getByRole("button", { name: `Filter by the tag ${asks}` });

  /** Waits for the slot's measurements, without which a row has nothing measured to click. */
  const measured = (): Promise<HTMLElement> =>
    screen.findByRole("button", { name: "Filter by size: large" });

  // The colour is the whole reason the artwork was measured, and the swatch is the only place a
  // reader ever meets the word "brown" — so it has to be the way to ask for the brown ones.
  it("finds the browns when the swatch beside a name is clicked", async () => {
    await browseItems();
    await measured();

    fireEvent.click(chip("Coif of the Drowned Star", "colour: brown"));

    expect(box().value).toBe("colour:brown");
    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });

  // And the word beside the swatches asks about the size rather than about the colour, which is
  // the difference the key in the term is there to keep.
  it("finds the large ones when the word beside the swatches is clicked", async () => {
    await browseItems();

    fireEvent.click(await measured());

    expect(box().value).toBe("size:large");
    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });

  // No two parts of one chip ask the same thing. A set is a body's worth of clothes and has no
  // size, so the word beside its swatches *is* the primary colour's name — and a swatch there
  // asking for that colour a second time would be two buttons doing one thing under one name,
  // which is a list to get past for anybody reading the card through a screen reader. A look
  // with a size is the other case: the word is spent on the size, so the square under it is the
  // only way to the colour and has to stay a control.
  it("offers one way to ask for a colour rather than two", async () => {
    const shown = view();
    const card = screen
      .getByRole("button", { name: "Tideglass Regalia" })
      .closest("article") as HTMLElement;
    await within(card).findByTitle(/blue and white/);

    // The word says blue and the swatch beside it is blue, and between them there is one button.
    expect(within(card).getAllByRole("button", { name: "Filter by colour: blue" })).toHaveLength(1);
    // The accent is the colour the word does not say, so that square is still a way to ask.
    expect(within(card).getByRole("button", { name: "Filter by colour: white" })).toBeTruthy();

    // And a look whose word is its size says the two things separately, which is the whole
    // reason a term carries a key at all.
    await browseItems(shown);
    await measured();
    const row = rowOf("Coif of the Drowned Star");
    expect(within(row).getByRole("button", { name: "Filter by colour: brown" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Filter by size: large" })).toBeTruthy();
  });

  // The reader's own half of it: "I filed six of these under horde" to seeing the six, without
  // going to the picker for it or remembering what they called it.
  it("finds what the reader filed a look under from the tag written on it", async () => {
    await browseItems(
      view({
        marks: fakeMarks([
          {
            kind: "appearance",
            id: 40,
            favourite: false,
            tags: [{ key: "faction", value: "horde" }],
          },
        ]),
      }),
    );
    await screen.findByText("Emberforge Helm");

    fireEvent.click(tagChip("Coif of the Drowned Star", "faction: horde"));

    expect(box().value).toBe("faction:horde");
    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });

  // Narrowing is the point of a second click, so the second term is added to the first rather
  // than put in its place. Both looks carry the label, so a box that replaced would hand the
  // helm back — which is what nobody who clicked two chips is asking for.
  it("asks for both when a second chip is clicked, rather than for the second one", async () => {
    await browseItems(
      view({
        marks: fakeMarks([
          {
            kind: "appearance",
            id: 40,
            favourite: false,
            tags: [
              { key: "faction", value: "horde" },
              { key: "wishlist", value: null },
            ],
          },
          { kind: "appearance", id: 3, favourite: false, tags: [{ key: "wishlist", value: null }] },
        ]),
      }),
    );
    await screen.findByText("Emberforge Helm");

    fireEvent.click(tagChip("Coif of the Drowned Star", "faction: horde"));
    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    fireEvent.click(tagChip("Coif of the Drowned Star", "wishlist"));

    expect(box().value).toBe("faction:horde wishlist:");
    expect(screen.queryByText("Emberforge Helm")).toBeNull();
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });

  // And the same question typed rather than clicked, because the chips are a way to the box and
  // not a way round it: what a reader can be shown once, they can type ever after.
  it("narrows a kind by a term typed into the box by hand", async () => {
    await browseItems();
    await screen.findByText("Emberforge Helm");

    fireEvent.change(box(), { target: { value: "size:large" } });

    await waitFor(() => expect(screen.queryByText("Emberforge Helm")).toBeNull());
    expect(screen.getByText("Coif of the Drowned Star")).toBeTruthy();
  });

  // The rows inside an opened set are looks and the box above that grid filters *sets*, so a
  // chip there that narrowed the grid by its own tag would be answering another question.
  it("leaves the chips inside an opened set as the words they were", async () => {
    view({
      marks: fakeMarks([
        { kind: "set", id: 201, favourite: false, tags: [{ key: "faction", value: "horde" }] },
        { kind: "appearance", id: 1, favourite: false, tags: [{ key: "wishlist", value: null }] },
      ]),
    });
    const card = await open("Tideglass Regalia");
    const row = rowFor(card, "Wear Head: Crown of Tides");

    expect(within(row).getByText("wishlist")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Filter by the tag wishlist" })).toBeNull();
    // The set's own chip on the card above it is a button, so what the row is missing is about
    // the row rather than about the feature.
    expect(
      within(card).getByRole("button", { name: "Filter by the tag faction: horde" }),
    ).toBeTruthy();
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
  const keep = (): HTMLElement => screen.getByRole("button", { name: /^(Save as a set|Replace )/ });

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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tideglass Regalia" })).toBeTruthy(),
    );
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
    fireEvent.click(
      within(savedCard("Horde look")).getByRole("button", { name: "Wear all of Horde look" }),
    );

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
    fireEvent.click(
      within(savedCard("Horde look")).getByRole("button", { name: "Wear Head: Crown of Tides" }),
    );

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
      Promise.reject(new Error("A set's name has to fit in 64 characters.")),
    );

    saveAs("a".repeat(80));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "A set's name has to fit in 64 characters.",
    );
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
  const already = (): FakeCustomSets =>
    fakeCustomSets([
      {
        id: 7,
        name: "Horde look",
        createdAt: SAVED_AT,
        updatedAt: SAVED_AT,
        pieces: [
          {
            place: "armour-0",
            appearanceId: 1,
            itemId: 1,
            name: "Crown of Tides",
            displayType: 0,
            inventoryType: 0,
            displayInfoId: 900_001,
            iconFileDataId: 0,
            hasModel: true,
          },
        ],
      },
    ]);

  // The issue's other half: a set of the reader's own takes any mark a Blizzard set takes, by
  // being a third kind of subject rather than a second feature.
  it("stars and tags a saved set the way the game's own sets are starred and tagged", async () => {
    const { marks } = view({ saved: already() });
    browseYours();
    const card = savedCard("Horde look");

    fireEvent.click(within(card).getByRole("button", { name: "Favourite Horde look" }));

    await waitFor(() =>
      expect(marks.stored()).toEqual([{ kind: "custom", id: 7, favourite: true, tags: [] }]),
    );

    tagIt(card, "Horde look", "faction", "horde");
    await waitFor(() =>
      expect(marks.stored()[0]?.tags).toEqual([{ key: "faction", value: "horde" }]),
    );
    expect(within(card).getByText("faction: horde")).toBeTruthy();
  });

  it("narrows the saved sets to the starred ones", async () => {
    const saved = already();
    const store = fakeMarks([{ kind: "custom", id: 7, favourite: true, tags: [] }]);
    view({
      saved: fakeCustomSets([
        ...saved.stored(),
        {
          id: 8,
          name: "Alliance look",
          createdAt: SAVED_AT,
          updatedAt: SAVED_AT,
          pieces: saved.stored()[0]!.pieces,
        },
      ]),
      marks: store,
    });
    browseYours();

    fireEvent.click(
      within(document.querySelector("#custom-sets") as HTMLElement).getByRole("checkbox", {
        name: "Favourites only",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Alliance look", level: 4 })).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "Horde look", level: 4 })).toBeTruthy();
  });

  // The thing the two browsers beside this one cannot offer: somebody who remembers putting a
  // piece in one of their sets and not which one.
  it("finds a saved set by what is in it", async () => {
    view({ saved: already() });
    browseYours();

    fireEvent.change(screen.getByLabelText("Filter your sets"), { target: { value: "crown" } });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Horde look", level: 4 })).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Filter your sets"), { target: { value: "aegis" } });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Horde look", level: 4 })).toBeNull(),
    );
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
      expect(screen.queryByRole("heading", { name: "Horde look", level: 4 })).toBeNull(),
    );
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

/**
 * The one thing on this screen the backend's failure codes are for.
 *
 * There is no wardrobe here for two ordinary reasons — nobody has said where the game is, and the
 * game is being patched — and both of them have an answer a reader can reach in one click. For as
 * long as a failed command came back as a string, this view could only print the sentence: the
 * three cases below are the same failure shape distinguished by nothing but its code.
 */
describe("what the view offers about a wardrobe it could not read", () => {
  it("offers Setup when nothing has said where the game is", () => {
    const opened = vi.fn();
    view({
      payload: null,
      status: "Choose the game folder in Setup first.",
      statusRecourse: { label: "Open Setup", act: opened },
    });

    expect(screen.getByText("Choose the game folder in Setup first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Setup" }));

    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("offers another go when the game's files were only temporarily unreadable", () => {
    const asked = vi.fn();
    view({
      payload: null,
      status: "Chronie could not read the game's files.",
      statusRecourse: { label: "Try again", act: asked },
    });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("offers nothing at all when there is nothing honest to offer", () => {
    view({
      payload: null,
      status: "Chronie hit a problem it did not expect.",
      statusRecourse: null,
    });

    const meta = screen.getByText("Chronie hit a problem it did not expect.");
    expect(within(meta).queryByRole("button")).toBeNull();
  });

  it("says nothing about recourse once the wardrobe has arrived", () => {
    view({ statusRecourse: { label: "Open Setup", act: vi.fn() } });

    expect(screen.queryByRole("button", { name: "Open Setup" })).toBeNull();
  });
});
