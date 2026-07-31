import { describe, expect, it } from "vitest";

import {
  answerNote,
  answersExactly,
  anyExact,
  blockedLabel,
  filterShelf,
  shelfRows,
  shelfSummary,
} from "./shelf";
import type { SetWearers, TransmogSet } from "./types";

/** A set with only the fields the shelf reads spelled out. */
const set = (fields: Partial<TransmogSet> & Pick<TransmogSet, "id" | "name">): TransmogSet => ({
  group: "",
  groupId: 0,
  classMask: 0,
  expansionId: 0,
  parentId: 0,
  flags: 0,
  uiOrder: 0,
  patchIntroduced: 0,
  itemCount: 0,
  ...fields,
});

/** And what the items behind one say about it — see `wearers.rs`. */
const said = (setId: number, openSlots: number, blockedSlots: number[] = []): SetWearers => ({
  setId,
  classMask: 0x0023,
  openSlots,
  blockedSlots,
});

/** The read, as the shelf asks it: a lookup that answers for the sets it was given and no more. */
const from = (...rows: SetWearers[]) => {
  const by = new Map(rows.map((row) => [row.setId, row]));
  return (setId: number): SetWearers | undefined => by.get(setId);
};

/** The places on the body, as `ItemAppearance.DisplayType` numbers them. */
const HEAD = 0;
const SHOULDER = 1;
const CHEST = 3;
const FEET = 6;
const ONE_HAND = 11;

describe("answersExactly", () => {
  // The split the whole browser is built around, and it is a fact about the game rather than
  // about an install: a helm and a pauldron hang geometry the fingerprint store can compare
  // exactly, and a chestpiece is paint on a body every look in the slot shares.
  it.each<[string, number, boolean]>([
    ["a head", HEAD, true],
    ["a shoulder", SHOULDER, true],
    ["a thing held in a hand", ONE_HAND, true],
    ["a chest", CHEST, false],
    ["feet", FEET, false],
    ["legs", 5, false],
    ["a back", 9, false],
  ])("says the geometry answers for %s: %s", (_what, displayType, expected) => {
    expect(answersExactly(displayType)).toBe(expected);
  });
});

describe("shelfRows", () => {
  const SETS = [
    set({ id: 601, name: "Emberforge Bulwark" }),
    set({ id: 602, name: "Tideglass Hide" }),
    set({ id: 603, name: "Duskwoven Shroud" }),
  ];

  // The whole point of the shelf: a set anybody can nearly wear, with the obstacle named. Seven
  // slots open and one shut is the shape of Icecrown's Paladin tier, and the eighth row is the
  // whole answer.
  it("keeps a set one slot short and says which slot did it", () => {
    const rows = shelfRows(SETS, from(said(602, 7, [HEAD])));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.set.id).toBe(602);
    expect(rows[0]?.open).toBe(7);
    expect(rows[0]?.blocked).toEqual([{ displayType: HEAD, slot: "Head", exact: true }]);
  });

  // Two is where "one obstacle you could go and settle" stops being what the list is about.
  it.each<[string, number[], number]>([
    ["one slot short", [CHEST], 1],
    ["two slots short", [CHEST, FEET], 1],
    ["three slots short", [CHEST, FEET, HEAD], 0],
  ])("keeps a set %s: %i rows", (_what, blocked, expected) => {
    expect(shelfRows(SETS, from(said(602, 5, blocked)))).toHaveLength(expected);
  });

  // A set with nothing open is a wall rather than a near miss, whatever its count of shut
  // slots — "almost" is a claim about something you can nearly have.
  it("leaves out a set with no slot open at all", () => {
    expect(shelfRows(SETS, from(said(602, 0, [CHEST])))).toEqual([]);
  });

  // And a set nothing shuts is not a near miss either, being simply wearable.
  it("leaves out a set every slot of which has a way in", () => {
    expect(shelfRows(SETS, from(said(602, 5)))).toEqual([]);
  });

  // A set this install can describe no item of says nothing about being one slot short. The
  // shelf is arithmetic over what was read, and a set absent from that read is absent here.
  it("leaves out a set the read says nothing about", () => {
    expect(shelfRows(SETS, () => undefined)).toEqual([]);
  });

  // The fold the grid already makes: a set holding exactly another set's appearances is the
  // same clothes under a second name, and would be the same row blocked at the same slot.
  it("leaves out a set shown under another holding the same appearances", () => {
    const folded = [...SETS, set({ id: 610, name: "Deepglass Hide", sameLookAs: 602 })];
    const rows = shelfRows(folded, from(said(602, 5, [CHEST]), said(610, 5, [CHEST])));
    expect(rows.map((row) => row.set.id)).toEqual([602]);
  });

  // The reading order, and both of its steps: fewest obstacles first, and within that the ones
  // a reader can settle today — the geometry answers a helm exactly and can say nothing at all
  // about a chestpiece.
  it("puts the fewest obstacles first, and the exactly answerable before the rest", () => {
    const rows = shelfRows(
      SETS,
      from(said(601, 5, [CHEST, FEET]), said(602, 5, [CHEST]), said(603, 5, [SHOULDER])),
    );
    expect(rows.map((row) => row.set.id)).toEqual([603, 602, 601]);
  });
});

describe("filterShelf", () => {
  const ROWS = shelfRows(
    [
      set({ id: 601, name: "Emberforge Bulwark", group: "Emberforge Armory" }),
      set({ id: 602, name: "Tideglass Hide", group: "Tideglass Wardrobe" }),
    ],
    from(said(601, 5, [HEAD]), said(602, 5, [CHEST])),
  );
  const found = (search: string): number[] => filterShelf(ROWS, search).map((row) => row.set.id);

  it.each<[string, string, number[]]>([
    ["a name", "tideglass", [602]],
    ["a collection", "armory", [601]],
    ["the slot in the way", "chest", [602]],
    ["who can wear it", "plate", [601, 602]],
    ["two words at once", "emberforge head", [601]],
    ["nothing anything says", "mail", []],
  ])("finds a row by %s", (_what, search, expected) => {
    expect(found(search)).toEqual(expected);
  });

  it("leaves the list alone when nothing was typed", () => {
    expect(found("   ")).toEqual([601, 602]);
  });
});

describe("shelfSummary", () => {
  const SETS = [set({ id: 601, name: "One" }), set({ id: 602, name: "Two" })];

  // Two numbers rather than one, because a set one slot short is a single question and a set
  // two short is a pair of them.
  it("counts the two kinds of near miss apart", () => {
    const rows = shelfRows(SETS, from(said(601, 5, [CHEST]), said(602, 5, [CHEST, FEET])));
    expect(shelfSummary(rows)).toBe("1 set one slot short · 1 set two short");
  });

  // And the third number, which is how much of the list is work a person has to do by eye.
  it("says how many of them the geometry can answer exactly", () => {
    const rows = shelfRows(SETS, from(said(601, 5, [HEAD]), said(602, 5, [CHEST])));
    expect(shelfSummary(rows)).toBe(
      "2 sets one slot short · 1 of them blocked where the game's own geometry can answer exactly",
    );
  });

  it("says so when nothing is a slot short", () => {
    expect(shelfSummary([])).toBe(
      "No set the game knows about is a slot or two short of everybody",
    );
  });
});

describe("what a row says about its obstacles", () => {
  const SETS = [set({ id: 601, name: "One" })];
  const only = (blocked: number[], open = 7) => shelfRows(SETS, from(said(601, open, blocked)))[0]!;

  it("names the one slot in the way, and how much is not", () => {
    expect(blockedLabel(only([CHEST]))).toBe(
      "7 of 8 slots open to anybody · Chest is the whole of what stops it",
    );
  });

  it("names both where there are two", () => {
    expect(blockedLabel(only([HEAD, CHEST]))).toBe(
      "7 of 9 slots open to anybody · Head and Chest are what stop it",
    );
  });

  // The two kinds of answer, which the shelf exists to keep apart: an equality out of the
  // geometry, and a ranking somebody has to confirm by eye — see `alternatives.ts`.
  it("promises an exact question where the slot hangs a mesh", () => {
    expect(answerNote(only([HEAD]))).toContain("exact question with an exact answer");
    expect(anyExact(only([HEAD]))).toBe(true);
  });

  it("promises only a ranking where the slot is paint on the body", () => {
    expect(answerNote(only([CHEST]))).toContain("ranking to confirm by eye");
    expect(anyExact(only([CHEST]))).toBe(false);
  });

  // And a set blocked at one of each says both, which is the case a single sentence would have
  // had to round off in one direction or the other.
  it("says which of two slots each measure can speak for", () => {
    expect(answerNote(only([HEAD, CHEST]))).toBe(
      "Head the geometry can answer exactly; Chest only the pictures can rank.",
    );
  });
});
