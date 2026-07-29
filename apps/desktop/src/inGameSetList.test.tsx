import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InGameSetList } from "./inGameSetList";
import { rowOf } from "./inGameSets";
import { NOTHING_ON, wear } from "./outfit";
import type { Outfit } from "./outfit";
import { ANY_CLASS } from "./transmogModal";
import type {
  CharacterInGameSets,
  InGameSet,
  InGameSetAppearancesPayload,
  InGameSetsPayload,
  TransmogAppearance,
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
  iconFileDataId: 130_002,
});
/**
 * The same one-handed sword, which a rogue wears in both hands at once.
 *
 * The whole reason the slot travels with the row. `ItemSparse` files this as inventory type 13,
 * a one-hander, and that is every word the game's files have to say about which hand holds it —
 * so `placeOf` puts both copies in the main hand and one of them disappears. Only the set knows,
 * because the set named the slots.
 */
const SWORD = appearance({
  modifiedAppearanceId: 71_004,
  itemId: 30_004,
  name: "Tideglass Edge",
  appearanceId: 80_004,
  displayType: 11,
  inventoryType: 13,
  displayInfoId: 900_004,
  iconFileDataId: 130_004,
});

const HELM = appearance({
  modifiedAppearanceId: 71_003,
  itemId: 30_003,
  name: "Emberforge Helm",
  appearanceId: 80_003,
  displayInfoId: 900_003,
  iconFileDataId: 0,
});

/**
 * Two characters, because this is the one browser in the view that is grouped by one.
 *
 * The same shape the browser suite's fixtures have, and for the same reason: an alt who saves
 * nothing in game is the case a single-character fixture can never show, and a set the client
 * would not name holding nothing at all is a set a player made this afternoon and has not
 * filled yet.
 */
const SETS: InGameSetsPayload = {
  characters: [
    {
      character: "Aster-Ravencrest",
      sets: [
        {
          id: 4,
          name: "Tideglass",
          icon: 130_001,
          observedAt: null,
          slots: [
            { slot: 0, appearanceId: 71_001 },
            { slot: 1, appearanceId: 71_002 },
          ],
        },
        { id: 5, name: "", icon: null, observedAt: null, slots: [] },
      ],
    },
    { character: "Nerine-Ravencrest", sets: [] },
  ],
};

/** What the game's files turn out to hold, keyed by the ids the window asks with. */
const CONTENTS: Record<string, InGameSetAppearancesPayload> = {
  "71001,71002": { appearances: [CROWN, MANTLE], readCount: 2, withheldCount: 0 },
  "71004,71004": { appearances: [SWORD, SWORD], readCount: 2, withheldCount: 0 },
};

/** A character wearing one sword in each hand, which is what only the set can say. */
const DUAL_WIELD: InGameSetsPayload = {
  characters: [
    {
      character: "Aster-Ravencrest",
      sets: [
        {
          id: 6,
          name: "Both hands",
          icon: 130_004,
          observedAt: null,
          slots: [
            { slot: 11, appearanceId: 71_004 },
            { slot: 12, appearanceId: 71_004 },
          ],
        },
      ],
    },
  ],
};

/**
 * The list over doubles a test answers, which is the only way to drive it.
 *
 * `loadAppearances` is recorded rather than merely answered because half of what is worth
 * saying about this list is about the request itself: a set is opened at the cost of four
 * walks of the game's own tables, and "it was asked for once" is a claim only the spy can make.
 */
function view(
  options: {
    payload?: InGameSetsPayload | null;
    contents?: Record<string, InGameSetAppearancesPayload>;
    refuses?: string;
    outfit?: Outfit;
  } = {},
) {
  const loadAppearances = vi.fn((ids: number[]): Promise<InGameSetAppearancesPayload> => {
    if (options.refuses) return Promise.reject(new Error(options.refuses));
    return Promise.resolve(
      (options.contents ?? CONTENTS)[ids.join(",")] ?? {
        appearances: [],
        readCount: 0,
        withheldCount: 0,
      },
    );
  });
  const wantIcons = vi.fn();
  const onWear = vi.fn();
  const onWearAll = vi.fn();
  const rendered = render(
    <InGameSetList
      hidden={false}
      payload={options.payload === undefined ? SETS : options.payload}
      loadAppearances={loadAppearances}
      icons={new Map()}
      wantIcons={wantIcons}
      outfit={options.outfit ?? NOTHING_ON}
      onWear={onWear}
      onWearAll={onWearAll}
    />,
  );
  return { rendered, loadAppearances, wantIcons, onWear, onWearAll };
}

/** Opens a set in place, the way a reader does, and waits for what it holds to arrive. */
async function open(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name }));
  const card = screen.getByRole("button", { name }).closest("article");
  if (!card) throw new Error(`${name} has no card`);
  await waitFor(() => expect(within(card).getAllByRole("listitem").length).toBeGreaterThan(0));
  return card as HTMLElement;
}

/** The one box above the list, which narrows the sets by name. */
const search = (): HTMLElement =>
  screen.getByRole("searchbox", { name: "Filter the sets you saved in game" });

/**
 * Which of the three sentences the list is ending on, if any.
 *
 * Read through `hidden` rather than through the words being in the markup at all, because all
 * three are always in it — a query that only asked whether the text existed would find every
 * one of them in every condition, and which one is *shown* is the whole of the claim.
 */
function saying(): string[] {
  return [...document.querySelectorAll<HTMLElement>("#ingame-sets .empty")]
    .filter((one) => !one.hidden)
    .map((one) => one.querySelector(".empty-title")?.textContent ?? "");
}

describe("the sets the player saved in the game", () => {
  // The one thing that makes this list different from the three beside it. Blizzard's sets and
  // the game's wardrobe are the same for everybody logged in; these belong to whoever Chronie
  // read them on, and a roster of ten alts is ten wardrobes.
  it("groups the sets under the character they were read on", () => {
    view();
    const heading = screen.getByRole("heading", { name: "Aster-Ravencrest", level: 3 });
    const group = heading.closest("section") as HTMLElement;

    expect(within(group).getByRole("button", { name: "Tideglass" })).toBeTruthy();
    // The set the client would not name is here under the label it is shown by, rather than
    // being dropped for having nothing to head it with.
    expect(within(group).getByRole("button", { name: "Unnamed set" })).toBeTruthy();
    expect(screen.getByText("2 sets shown")).toBeTruthy();
  });

  // A heading with nothing under it is a question the list has already answered elsewhere: the
  // sentence at the bottom is where "read, and found none" is said, once, for everybody.
  it("gives a character who saves nothing in game no heading of their own", () => {
    view();
    expect(screen.queryByRole("heading", { name: "Nerine-Ravencrest" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
  });

  it("opens a set in place and lists what the game says it is made of", async () => {
    const { loadAppearances } = view();
    const card = await open("Tideglass");

    expect(within(card).getByText("Tideglass Crown")).toBeTruthy();
    expect(within(card).getByText("Tideglass Mantle")).toBeTruthy();
    // Asked for by the ids the set names, in slot order, which is what lines the answer back
    // up with the slots.
    expect(loadAppearances).toHaveBeenCalledWith([71_001, 71_002]);
  });

  // Opening one costs the same four walks of the game's tables a Blizzard set costs, and a
  // reader comparing two sets goes back and forth between them.
  it("reads a set once however many times it is opened and closed", async () => {
    const { loadAppearances } = view();
    await open("Tideglass");
    fireEvent.click(screen.getByRole("button", { name: "Tideglass" }));
    await waitFor(() => expect(screen.queryByText("Tideglass Crown")).toBeNull());
    await open("Tideglass");

    expect(loadAppearances).toHaveBeenCalledTimes(1);
  });

  // The machine without the game installed, which is the whole trade this browser makes: the
  // names came out of Chronie's own database and can always be listed, and the opening is what
  // needs the game's files. A reader who clicked to see what is in it is owed the reason.
  it("says why a set will not open, in the words the failure gave", async () => {
    view({ refuses: "The game's files are not readable on this machine." });
    fireEvent.click(screen.getByRole("button", { name: "Tideglass" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The game's files are not readable on this machine.",
    );
    // The set beside it is untouched: one card failed, not the browser.
    expect(screen.getByRole("button", { name: "Unnamed set" })).toBeTruthy();
  });

  it("narrows the sets by name", async () => {
    view();
    fireEvent.change(search(), { target: { value: "tideglass" } });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Unnamed set" })).toBeNull());
    expect(screen.getByRole("button", { name: "Tideglass" })).toBeTruthy();
    expect(screen.getByText("1 set shown")).toBeTruthy();
  });

  // The sets are the account's but the wardrobes are read per character, so the answers are
  // kept by character and set together. Keyed by the set id alone, one alt's clothes would be
  // drawn under another alt's set of the same number — which the game hands out freely.
  it("keeps one character's answer out of another's set of the same number", async () => {
    const same = (character: string, name: string, appearanceId: number): CharacterInGameSets => ({
      character,
      sets: [{ id: 4, name, icon: null, observedAt: null, slots: [{ slot: 0, appearanceId }] }],
    });
    view({
      payload: {
        characters: [
          same("Aster-Ravencrest", "Tideglass", 71_001),
          same("Nerine-Ravencrest", "Emberforge", 71_003),
        ],
      },
      contents: {
        "71001": { appearances: [CROWN], readCount: 1, withheldCount: 0 },
        "71003": { appearances: [HELM], readCount: 1, withheldCount: 0 },
      },
    });

    const mine = await open("Tideglass");
    const theirs = await open("Emberforge");

    expect(within(mine).getByText("Tideglass Crown")).toBeTruthy();
    expect(within(theirs).getByText("Emberforge Helm")).toBeTruthy();
  });

  it("puts a piece on the character when it is picked", async () => {
    const { onWear } = view();
    const card = await open("Tideglass");

    fireEvent.click(within(card).getByRole("button", { name: "Wear Head: Tideglass Crown" }));

    expect(onWear).toHaveBeenCalledTimes(1);
    // The place goes up beside the row, because the set is the only thing that knows it: a
    // one-hander says nothing about which hand holds it, and this list has the slot.
    expect(onWear.mock.calls[0]?.[0]).toBe("armour-0");
    expect(onWear.mock.calls[0]?.[1]).toMatchObject({
      slot: "Head",
      label: "Tideglass Crown",
      displayInfoId: 900_001,
    });
  });

  // A set is a set of clothes, and looking at all of it at once is the ordinary thing to want.
  // The set goes up with the pieces because it is what the outfit is labelled by — a piece put
  // on this way says which set it came out of, and only the set knows its name. The places go
  // up too, and for the reason above: the set named the slots and nothing else can.
  it("hands the set and its pieces up when the whole of it goes on", async () => {
    const { onWearAll } = view();
    const card = await open("Tideglass");

    fireEvent.click(within(card).getByRole("button", { name: "Wear all of Tideglass" }));

    expect(onWearAll).toHaveBeenCalledTimes(1);
    const [set, pieces] = onWearAll.mock.calls[0] as [
      InGameSet,
      { place: string; row: { label: string } }[],
    ];
    expect(set.id).toBe(4);
    expect(pieces.map(({ place, row }) => [place, row.label])).toEqual([
      ["armour-0", "Tideglass Crown"],
      ["armour-1", "Tideglass Mantle"],
    ]);
  });

  // Dual wield is ordinary, and it is the case that decided the shape of both callbacks above.
  // The same sword in both hands is one appearance filling two slots, and the game's files say
  // only that it is a one-hander — so a list that worked the place out from the row would put
  // both copies in the main hand and hand up one piece where the player has two.
  it("keeps a sword in each hand, which only the set can say", async () => {
    const { onWearAll } = view({ payload: DUAL_WIELD });
    const card = await open("Both hands");

    fireEvent.click(within(card).getByRole("button", { name: "Wear all of Both hands" }));

    const [, pieces] = onWearAll.mock.calls[0] as [
      InGameSet,
      { place: string; row: { label: string } }[],
    ];
    expect(pieces.map(({ place }) => place)).toEqual(["hand-right", "hand-left"]);
  });

  // What she has on is the view's, not this list's, so the only claim worth making here is
  // that a piece already on her reads as pressed wherever it is met.
  it("marks a piece the character is already wearing", async () => {
    view({ outfit: wear(NOTHING_ON, rowOf(CROWN)) });
    const card = await open("Tideglass");

    expect(
      within(card)
        .getByRole("button", { name: "Wear Head: Tideglass Crown" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(card)
        .getByRole("button", { name: "Wear Shoulder: Tideglass Mantle" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  /* ---------- the three silences ---------- */

  // Nothing at all until the read lands: every sentence below is an answer, and the window has
  // not asked the question yet.
  it("says none of it while the wardrobes are still being read", () => {
    view({ payload: null });
    expect(saying()).toEqual([]);
    expect(screen.queryByText(/set(s)? shown/)).toBeNull();
  });

  it("tells a reader with no wardrobes read at all what makes one appear", () => {
    view({ payload: { characters: [] } });
    expect(saying()).toEqual(["No wardrobes read yet"]);
  });

  // Read, and found none — which is a real answer about a player who keeps their outfits in
  // this app rather than in the game, and not the same as never having looked.
  it("says the wardrobes were read and held nothing", () => {
    view({ payload: { characters: [{ character: "Nerine-Ravencrest", sets: [] }] } });
    expect(saying()).toEqual(["No sets saved in game"]);
  });

  it("says when the search matches nothing, and stops saying it when it does", async () => {
    view();
    fireEvent.change(search(), { target: { value: "nothing like it" } });

    await waitFor(() => expect(saying()).toEqual(["Nothing matches"]));

    fireEvent.change(search(), { target: { value: "" } });
    await waitFor(() => expect(saying()).toEqual([]));
  });
});
