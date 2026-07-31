import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShelfList } from "./shelfList";
import type { AlternativeActions } from "./alternativesPanel";
import type {
  OpeningsPayload,
  SetWearers,
  TransmogPayload,
  TransmogSet,
  TransmogSetItemsPayload,
} from "./types";

afterEach(cleanup);

const set = (fields: Partial<TransmogSet> & Pick<TransmogSet, "id" | "name">): TransmogSet => ({
  group: "Tideglass Wardrobe",
  groupId: 1,
  classMask: 0x0e08,
  expansionId: 3,
  parentId: 0,
  flags: 0,
  uiOrder: 0,
  patchIntroduced: 100200,
  itemCount: 2,
  ...fields,
});

const said = (setId: number, openSlots: number, blockedSlots: number[]): SetWearers => ({
  setId,
  classMask: 0x0400,
  openSlots,
  blockedSlots,
});

/**
 * Three sets: one blocked where the geometry can answer, one where it cannot, and one nothing
 * stops at all.
 *
 * The third is the control the whole browser turns on — a shelf that listed it would be the
 * grid with extra words, and the claim being made is that this list is only the near misses.
 */
const SETS: TransmogPayload = {
  sets: [
    set({ id: 601, name: "Tideglass Hide" }),
    set({ id: 602, name: "Emberforge Plate", group: "Emberforge Armory", classMask: 0x0023 }),
    set({ id: 603, name: "Stormforged Vestments" }),
  ],
  readCount: 3,
  declaredCount: 3,
  withheldCount: 0,
};

const SAID = new Map<number, SetWearers>([
  // Feet: paint on a body every look in the slot shares, so only a ranking.
  [601, said(601, 1, [6])],
  // Head: geometry the game hangs, so an exact question.
  [602, said(602, 3, [0])],
  [603, said(603, 4, [])],
]);

/** What one of them turns out to be made of, which only arrives once a row is opened. */
const CONTENTS: TransmogSetItemsPayload = {
  setId: 601,
  readCount: 2,
  withheldCount: 0,
  appearances: [
    {
      modifiedAppearanceId: 71_004,
      itemId: 30_004,
      name: "Tideglass Sandals",
      appearanceId: 80_004,
      displayType: 6,
      inventoryType: 8,
      allowableClass: 0x0400,
      requiredLevel: 0,
      quality: 4,
      displayInfoId: 900_004,
      iconFileDataId: 130_004,
      hasModel: false,
    },
  ],
};

const OPENINGS: OpeningsPayload = {
  setId: 601,
  readCount: 0,
  withheldCount: 0,
  blocked: [80_004],
  openings: [],
};

const NOTHING_MEASURED: AlternativeActions = {
  found: new Map(),
  want: vi.fn(),
  said: [],
  rule: vi.fn(),
};

function view(
  options: {
    payload?: TransmogPayload | null;
    ready?: boolean;
    contents?: TransmogSetItemsPayload | string;
    openings?: OpeningsPayload;
    alternatives?: AlternativeActions;
  } = {},
) {
  const onOpen = vi.fn();
  render(
    <ShelfList
      hidden={false}
      payload={options.payload === undefined ? SETS : options.payload}
      wearersOf={(setId) => SAID.get(setId)}
      ready={options.ready ?? true}
      onOpen={onOpen}
      contentsOf={() => options.contents}
      openingsOf={() => options.openings}
      alternatives={options.alternatives ?? NOTHING_MEASURED}
      icons={new Map()}
    />,
  );
  return { onOpen };
}

/** The cards on the shelf, in the order they are drawn. */
const cards = (): string[] =>
  [...document.querySelectorAll<HTMLElement>("#shelf-list article h4")].map(
    (one) => one.textContent ?? "",
  );

/** What a card says, as one string — the shape of a claim about several lines at once. */
const says = (name: string): string => card(name).textContent ?? "";

const card = (name: string): HTMLElement => {
  const found = screen.getByRole("button", { name }).closest("article");
  if (!found) throw new Error(`${name} has no card`);
  return found as HTMLElement;
};

/** Which of the two sentences the list is ending on, if either — see the note in `shelfList`. */
const saying = (): string[] =>
  [...document.querySelectorAll<HTMLElement>("#shelf .empty")]
    .filter((one) => !one.hidden)
    .map((one) => one.querySelector(".empty-title")?.textContent ?? "");

describe("the shelf of sets one slot short", () => {
  // The whole browser in one claim: it is a list of near misses, and a set anybody can already
  // wear is not one — however much a grid beside it would show them side by side.
  it("lists only the sets a slot or two short, exactly answerable first", () => {
    view();
    expect(cards()).toEqual(["Emberforge Plate", "Tideglass Hide"]);
  });

  // The second half of the answer, and the reason this is a browser rather than a filter: a
  // helm is an exact question and a boot is a ranking, and drawing them alike would lend the
  // second the first's certainty — see `alternatives.ts`.
  it("says which kind of answer each obstacle has", () => {
    view();
    expect(says("Emberforge Plate")).toContain("exact question with an exact answer");
    expect(says("Tideglass Hide")).toContain("ranking to confirm by eye");
  });

  it("names the slot in the way, and how much of the set is not", () => {
    view();
    expect(says("Tideglass Hide")).toContain(
      "1 of 2 slots open to anybody · Feet is the whole of what stops it",
    );
    // And who can wear it as it stands, which is the chip the grid draws too.
    expect(says("Tideglass Hide")).toContain("Druid only");
  });

  it("counts the shelf over the list", () => {
    view();
    expect(
      screen.getByText(
        "2 sets one slot short · 1 of them blocked where the game's own geometry can answer exactly",
      ),
    ).toBeTruthy();
  });

  // The one control: words, over what the row itself says.
  it("narrows to what was typed", () => {
    view();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter the sets one slot short" }), {
      target: { value: "head" },
    });
    expect(cards()).toEqual(["Emberforge Plate"]);
    expect(saying()).toEqual([]);
  });

  it("says so when a search matches nothing", () => {
    view();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter the sets one slot short" }), {
      target: { value: "tabard" },
    });
    expect(saying()).toEqual(["Nothing matches"]);
  });

  // A wait rather than an answer. The read behind this browser is a second command after the
  // grid's own, and a shelf that said "nothing is one slot short" while it was still being read
  // would be the app reporting its own unfinished work as a fact about the game.
  it("says it is still reading before the answer lands", () => {
    view({ ready: false });
    expect(cards()).toEqual([]);
    expect(saying()).toEqual([]);
    expect(screen.getByText("Reading what every item in the game allows…")).toBeTruthy();
  });

  it("says so when nothing in the install is a near miss", () => {
    render(
      <ShelfList
        hidden={false}
        payload={SETS}
        wearersOf={() => undefined}
        ready
        onOpen={vi.fn()}
        contentsOf={() => undefined}
        openingsOf={() => undefined}
        alternatives={NOTHING_MEASURED}
        icons={new Map()}
      />,
    );
    expect(saying()).toEqual(["Nothing is one slot short"]);
  });

  // Opening a row is opening the set, which is what makes the shelf a road to the answer rather
  // than a second copy of it: the same read, and the same panel under it.
  it("reads the set when a row is opened, and draws its own answer", () => {
    const { onOpen } = view({ contents: CONTENTS, openings: OPENINGS });
    fireEvent.click(screen.getByRole("button", { name: "Tideglass Hide" }));
    expect(onOpen).toHaveBeenCalledWith(601);
    const opened = card("Tideglass Hide");
    expect(
      within(opened).getByRole("table", { name: "How anyone gets the looks Tideglass Hide locks" }),
    ).toBeTruthy();
    // And the button #247 put on the one row that has no exact answer, which this shelf is the
    // natural home for: a set one slot short is a set with one question to ask.
    expect(
      within(opened).getByRole("button", {
        name: "Show possible alternatives to Tideglass Sandals",
      }),
    ).toBeTruthy();
  });

  it("says what it is doing while the set is being read", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Tideglass Hide" }));
    expect(says("Tideglass Hide")).toContain("Reading what the set is made of…");
  });

  // A read that failed is the reader's business: they clicked to see what was in it.
  it("says why a set could not be read", () => {
    view({ contents: "The game is mid-patch" });
    fireEvent.click(screen.getByRole("button", { name: "Tideglass Hide" }));
    expect(says("Tideglass Hide")).toContain("The game is mid-patch");
  });
});
