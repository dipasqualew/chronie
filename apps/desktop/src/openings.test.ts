import { describe, expect, it } from "vitest";

import {
  locked,
  locksAnything,
  openingLabel,
  openingRows,
  openingSummary,
  unread,
} from "./openings";
import { ANY_CLASS } from "./transmogModal";
import type { AppearanceRow, AppearanceSource } from "./transmogModal";
import type { OpeningsPayload, SetOpening } from "./types";

/** The two masks every case here is written in: the set's own class, and somebody else's. */
const PALADIN = 0x0002;
const DRUID = 0x0400;

/**
 * One item that gives a look, with only the fields these tests turn on spelled out.
 *
 * Unrestricted by default, because that is what nearly every item in the game is — so a locked
 * row is a row that says so, rather than one that got there by leaving something out.
 */
const source = (fields: Partial<AppearanceSource> = {}): AppearanceSource => ({
  label: "Emberforge Greaves",
  itemId: 30009,
  modifiedAppearanceId: 71009,
  inventoryType: 7,
  allowableClass: ANY_CLASS,
  requiredLevel: 0,
  quality: 4,
  itemCount: 1,
  ...fields,
});

/**
 * One look of a set as the list beside the panel already drew it — see `appearanceRows`.
 *
 * The whole of what the panel is given about the set, and half of what it decides from; the
 * other half is the payload below.
 */
const row = (
  fields: Partial<AppearanceRow> & Pick<AppearanceRow, "appearanceId">,
): AppearanceRow => ({
  slot: "Legs",
  label: "Emberforge Greaves",
  itemId: 30009,
  displayType: 5,
  inventoryType: 7,
  displayInfoId: 900_006,
  iconFileDataId: 130_006,
  hasModel: false,
  withheld: false,
  sources: [source()],
  liftsRestriction: false,
  ...fields,
});

/** A look the set locks: its every item is somebody's own, which is the panel's input. */
const shut = (
  fields: Partial<AppearanceRow> & Pick<AppearanceRow, "appearanceId">,
): AppearanceRow => row({ sources: [source({ allowableClass: PALADIN })], ...fields });

/** What the backend read out of every item in the game — see `openings.rs`. */
const payload = (fields: Partial<OpeningsPayload> = {}): OpeningsPayload => ({
  setId: 203,
  openings: [],
  blocked: [],
  readCount: 0,
  withheldCount: 0,
  ...fields,
});

/** One way in, as the backend names it: the cheapest item nobody is locked out of. */
const opening = (fields: Partial<SetOpening> & Pick<SetOpening, "appearanceId">): SetOpening => ({
  itemId: 30025,
  name: "Greaves of the Wanderer",
  requiredLevel: 0,
  quality: 3,
  ...fields,
});

describe("whether the set's own items shut anybody out of a look", () => {
  // The question the whole panel hangs off, and it is asked of the set's own rows rather than of
  // the mask the set was filed under: one unrestricted item among the several that give a look is
  // the lock lifting, which is `liftsRestriction` read from the other side.
  it.each<[string, number[], boolean]>([
    ["one item anybody can wear", [ANY_CLASS], false],
    ["a class-locked item beside an unrestricted one", [ANY_CLASS, PALADIN], false],
    ["nothing but the set's own class", [PALADIN], true],
    ["two classes and neither of them everybody", [PALADIN, DRUID], true],
  ])("counts a look sold through %s", (_what, masks, expected) => {
    const sources = masks.map((mask) => source({ allowableClass: mask }));
    expect(locked(row({ appearanceId: 80_009, sources }))).toBe(expected);
  });

  // A row the game encrypts has no item behind it at all, so there is nothing to be locked out
  // of: it is the game declining to say rather than a wall, and the list beside the panel
  // already draws it as the apology it is.
  it("says nothing shut about a look the game withholds", () => {
    const withheld = row({
      appearanceId: 0,
      withheld: true,
      sources: [source({ allowableClass: 0 })],
    });
    expect(locked(withheld)).toBe(false);
  });

  /**
   * And a look reached only by an item the game encrypts the *row* of, which is not the same
   * thing and does not read the same way.
   *
   * Its mask is zero because `ItemSparse` said nothing, and zero cannot open anything — so the
   * look stays shut as far as anything here knows. That is the reading `openings.rs::said`
   * takes as well, which is what makes it worth pinning: the backend puts such a look in
   * neither list, so it lands in [`unread`] and is counted in the sentence over the table
   * rather than drawn as a row claiming a wall. A `locked` that answered false here would leave
   * that count permanently zero and the sentence unreachable.
   */
  it("keeps a look shut when the only item giving it is one the game says nothing about", () => {
    expect(locked(row({ appearanceId: 80_009, sources: [source({ allowableClass: 0 })] }))).toBe(
      true,
    );
  });
});

describe("whether a set is worth reading the panel for at all", () => {
  // The guard in front of the dearest read the window makes: a walk of `Item` and `ItemSparse`
  // per set opened, which two thirds of the game's sets have no question to spend it on.
  it("asks nothing of a set that shuts nobody out", () => {
    expect(locksAnything([row({ appearanceId: 80_006 }), row({ appearanceId: 80_007 })])).toBe(
      false,
    );
  });

  it("reads for a set where one look out of many is shut", () => {
    expect(locksAnything([row({ appearanceId: 80_006 }), shut({ appearanceId: 80_009 })])).toBe(
      true,
    );
  });
});

describe("the rows of the panel", () => {
  const HELM = row({ appearanceId: 80_006, slot: "Head", label: "Emberforge Helm" });
  const LEGS = shut({ appearanceId: 80_009, slot: "Legs", label: "Emberforge Greaves" });
  const FEET = shut({
    appearanceId: 80_004,
    slot: "Feet",
    displayType: 6,
    label: "Tideglass Sandals",
  });

  // The point of the panel, and the reason it is not a chip: a set of eight looks where seven are
  // on a world drop and one is on nothing is eight rows of which one is the answer.
  it("draws a row for each locked look and none for the ones nobody was stopped at", () => {
    const shown = openingRows(
      [HELM, LEGS],
      payload({ openings: [opening({ appearanceId: 80_009 })] }),
    );
    expect(shown).toEqual([
      {
        appearanceId: 80_009,
        displayType: 5,
        slot: "Legs",
        own: "Emberforge Greaves",
        open: opening({ appearanceId: 80_009 }),
      },
    ]);
  });

  // The set's own order, which is by slot: the table is read down the body beside the list it is
  // about rather than in whatever order the backend's hash map came out in.
  it("keeps the order the set's own list is already in", () => {
    const shown = openingRows(
      [LEGS, FEET],
      payload({
        // Deliberately the other way round, which is what the join has to survive.
        openings: [opening({ appearanceId: 80_004 }), opening({ appearanceId: 80_009 })],
      }),
    );
    expect(shown.map((one) => one.slot)).toEqual(["Legs", "Feet"]);
  });

  // The row the whole panel is read for. It is drawn rather than left out, because "nothing in
  // the game sells this look around" is the fact that decides whether the set is worth chasing.
  it("draws a locked look nothing sells around as a row with no way in", () => {
    const shown = openingRows([FEET], payload({ blocked: [80_004] }));
    expect(shown).toEqual([
      {
        appearanceId: 80_004,
        // Carried because this is the row "show possible alternatives" is asked from, and both
        // measures behind that answer are per slot — see `alternatives.ts`.
        displayType: 6,
        slot: "Feet",
        own: "Tideglass Sandals",
        open: null,
      },
    ]);
  });

  // And a look in neither list is one this install can say nothing whatever about, so it is left
  // out of the table entirely: a row of question marks would be this app inventing a wall out of
  // its own blindness. What accounts for it is the sentence above the table — see [`unread`].
  it("leaves out a locked look the read could say nothing about", () => {
    expect(openingRows([LEGS], payload())).toEqual([]);
  });

  it("counts the locked looks in neither list, and only those", () => {
    const rows = [HELM, LEGS, FEET];
    expect(unread(rows, payload({ openings: [opening({ appearanceId: 80_009 })] }))).toBe(1);
    expect(
      unread(rows, payload({ blocked: [80_004], openings: [opening({ appearanceId: 80_009 })] })),
    ).toBe(0);
    // The unlocked helm is in neither list either, and was never a row to be missing.
    expect(unread([HELM], payload())).toBe(0);
  });
});

describe("the one line over the table", () => {
  const opened = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      appearanceId: 80_000 + index,
      displayType: 5,
      slot: "Legs",
      own: "Emberforge Greaves",
      open: opening({ appearanceId: 80_000 + index }),
    }));
  const walls = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      appearanceId: 80_100 + index,
      displayType: 6,
      slot: "Feet",
      own: "Tideglass Sandals",
      open: null,
    }));

  // A count rather than a verdict, because the counts are what differ: "seven of eight" is the
  // sentence Icecrown's Paladin tier deserves and no phrase covering all three shapes would
  // say it.
  it.each<[string, number, number, string]>([
    ["every locked look open", 1, 0, "The one look this set locks is on an item anybody can wear"],
    [
      "every locked look open, several of them",
      3,
      0,
      "All 3 looks this set locks are on an item anybody can wear",
    ],
    [
      "one way in among several walls",
      1,
      2,
      "1 of the 3 looks this set locks is on an item anybody can wear",
    ],
    [
      "the set a reader can nearly have",
      7,
      1,
      "7 of the 8 looks this set locks are on an item anybody can wear",
    ],
    [
      "a set that is a wall",
      0,
      2,
      "Nothing in the game gives any of this set's 2 locked looks to another class",
    ],
    [
      "a single locked look, shut",
      0,
      1,
      "Nothing in the game gives this set's one locked look to another class",
    ],
  ])("says, for %s, what a reader who reads nothing else needs", (_what, open, shut, expected) => {
    expect(openingSummary([...opened(open), ...walls(shut)])).toBe(expected);
  });

  // What was read is said beside what could not be, because a table shorter than the set's
  // locked looks is otherwise a table a reader has to explain to themselves.
  it("says what the game keeps encrypted beside whatever was read", () => {
    expect(openingSummary(opened(1), 1)).toBe(
      "The one look this set locks is on an item anybody can wear · 1 look the game keeps encrypted",
    );
    expect(openingSummary(walls(1), 2)).toBe(
      "Nothing in the game gives this set's one locked look to another class · 2 looks the game keeps encrypted",
    );
  });

  // And the case there is no table at all for: every locked look sits in a section this install
  // holds no key to, so the sentence is the whole of the answer.
  it("says so when nothing of the set could be read", () => {
    expect(openingSummary([], 3)).toBe(
      "Nothing this set locks could be read · 3 looks the game keeps encrypted",
    );
    expect(openingSummary([])).toBe("Nothing this set locks could be read");
  });
});

describe("how a row names the way in", () => {
  // The quality always, because it is the word a reader recognises the item's colour by and the
  // one thing separating two similarly named drops.
  it("names the item and the colour the game writes it in", () => {
    expect(openingLabel(opening({ appearanceId: 80_009 }))).toBe("Greaves of the Wanderer · Rare");
  });

  // The level only where the game asks for one: a world drop out of an expansion nobody levels
  // through any more has no requirement left on it, and "Level 0" is a hurdle that is not there.
  it("says what it takes only where the game asks for anything", () => {
    expect(openingLabel(opening({ appearanceId: 80_009, requiredLevel: 45, quality: 4 }))).toBe(
      "Greaves of the Wanderer · Epic · Level 45",
    );
  });

  // The one thing a reader has when the game holds no name: the id, which is still enough to
  // look the item up — the same fallback a row of an opened set falls back to.
  it("names an item the game never named by its id", () => {
    expect(openingLabel(opening({ appearanceId: 80_009, itemId: 30_025, name: "" }))).toBe(
      "Item 30025 · Rare",
    );
  });
});
