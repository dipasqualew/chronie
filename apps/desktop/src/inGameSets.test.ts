import { describe, expect, it } from "vitest";

import {
  UNNAMED, appearanceIds, charactersWithSets, filterInGameSets, rowOf, rowsOf, setLabel,
  setSummary, setsFor, wardrobeSummary,
} from "./inGameSets";
import { ANY_CLASS } from "./transmogModal";
import type { InGameSet, InGameSetSlot, InGameSetsPayload, TransmogAppearance } from "./types";

/** One appearance as the game's own tables answer for it, with only what a test spells out. */
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

/**
 * An appearance the game keeps encrypted, which is what the whole chain answers as zeroes.
 *
 * The item is the one that matters — no item is what "withheld" is decided by — but the rest
 * of the row arriving as zeroes is what the backend really hands over, and a fixture that
 * zeroed only the id would let a wrong claim about the class or the level go unnoticed.
 */
const WITHHELD = appearance({
  modifiedAppearanceId: 71_009,
  itemId: 0,
  name: "",
  appearanceId: 0,
  displayType: 0,
  inventoryType: 0,
  allowableClass: 0,
  requiredLevel: 0,
  quality: 0,
  displayInfoId: 0,
  iconFileDataId: 0,
  hasModel: false,
});

const at = (slot: number, appearanceId: number): InGameSetSlot => ({ slot, appearanceId });

const set = (fields: Partial<InGameSet> = {}): InGameSet => ({
  id: 4,
  name: "Tideglass",
  icon: 130_001,
  observedAt: null,
  slots: [at(0, 71_001), at(1, 71_002)],
  ...fields,
});

describe("setLabel", () => {
  it("reads under the name the player gave it in game", () => {
    expect(setLabel(set())).toBe("Tideglass");
  });

  // The client's own API is documented as sometimes answering nothing, so a card headed by an
  // empty string is a real state rather than a defensive guess — and a nameless card is one a
  // reader cannot click, search for or talk about.
  it.each<[string, string]>([
    ["a set the client would not name", ""],
    ["a name that is only whitespace", "   "],
  ])("falls back to a label for %s", (_what, name) => {
    expect(setLabel(set({ name }))).toBe(UNNAMED);
  });
});

describe("appearanceIds", () => {
  it("asks in slot order rather than in the order the database answered", () => {
    const saved = set({ slots: [at(11, 71_007), at(0, 71_001), at(9, 71_005)] });

    expect(appearanceIds(saved)).toEqual([71_001, 71_005, 71_007]);
  });

  // The one that matters, and the one a `Set` or a `uniq` would quietly break: an in-game set
  // names an appearance *per place on the body*, so one sword held in both hands is two slots
  // and two ids. Asking once would come back with one row, and the second hand would be empty.
  it("names an appearance once per slot that holds it, however many that is", () => {
    const twoHands = set({ slots: [at(11, 71_007), at(12, 71_007)] });

    expect(appearanceIds(twoHands)).toEqual([71_007, 71_007]);
  });

  // The backend answers one row per id in the order it was asked, and the caller lines those
  // rows back up with `set.slots` by position — so sorting the caller's own array would leave
  // the answer and the slots disagreeing about which piece went where.
  it("leaves the set it was given alone", () => {
    const saved = set({ slots: [at(11, 71_007), at(0, 71_001)] });

    appearanceIds(saved);

    expect(saved.slots.map((slot) => slot.slot)).toEqual([11, 0]);
  });
});

describe("rowOf", () => {
  it("comes back as the row every other part of this view draws", () => {
    expect(rowOf(appearance())).toMatchObject({
      slot: "Head",
      label: "Tideglass Crown",
      itemId: 30_001,
      appearanceId: 80_001,
      displayType: 0,
      inventoryType: 1,
      displayInfoId: 900_001,
      iconFileDataId: 130_001,
      hasModel: true,
      withheld: false,
    });
  });

  // The one thing a saved piece cannot do and this can: these numbers came out of `ItemSparse`
  // on this machine a moment ago, so the row claims them rather than shrugging at them.
  it("carries the game's own class, level and quality through", () => {
    const restricted = appearance({ allowableClass: 0x0010, requiredLevel: 45, quality: 3 });

    const one = rowOf(restricted);
    expect(one.sources).toHaveLength(1);
    expect(one.sources[0]).toMatchObject({
      label: "Tideglass Crown",
      itemId: 30_001,
      modifiedAppearanceId: 71_001,
      inventoryType: 1,
      allowableClass: 0x0010,
      requiredLevel: 45,
      quality: 3,
      itemCount: 1,
    });
    // Nothing here is several items reaching one look, so nothing can lift a restriction.
    expect(one.liftsRestriction).toBe(false);
  });

  // No item is the whole of what "the game withholds this" means, and the row says so in
  // words rather than leaving a blank beside a slot it cannot name either.
  it("says so where the game withheld the item, and names no slot", () => {
    const one = rowOf(WITHHELD);

    expect(one.withheld).toBe(true);
    expect(one.label).toBe("The game keeps this appearance encrypted");
    expect(one.slot).toBe("Unknown slot");
  });

  // The zero the backend hands over is "nothing was readable", and a class mask of zero read
  // literally is "no class may wear this" — the one claim this row has no business making. So
  // it claims the mask that excludes nobody instead.
  it("claims nothing about who may wear an appearance the game withholds", () => {
    expect(rowOf(WITHHELD).sources[0]?.allowableClass).toBe(ANY_CLASS);
    // And its neighbour is untouched, so the substitution is about the withheld row alone.
    expect(rowOf(appearance()).sources[0]?.allowableClass).toBe(ANY_CLASS);
    expect(rowOf(appearance({ allowableClass: 0x0010 })).sources[0]?.allowableClass).toBe(0x0010);
  });

  it("falls back to the id where the game gave the item no name", () => {
    expect(rowOf(appearance({ name: "", itemId: 30_042 })).label).toBe("Item 30042");
    expect(rowOf(appearance({ name: "", itemId: 30_042 })).sources[0]?.label).toBe("Item 30042");
  });

  // The badge is the game's word for the place, and for a weapon that is a question only the
  // inventory type answers — display type 11 is a sword and a two-hander alike.
  it.each<[string, number, number]>([
    ["Head", 0, 1],
    ["Shoulder", 1, 3],
    ["Chest", 3, 5],
    ["One-hand", 11, 13],
    ["Off hand", 11, 22],
    ["Shield", 13, 14],
  ])("names its slot %s", (slot, displayType, inventoryType) => {
    expect(rowOf(appearance({ displayType, inventoryType })).slot).toBe(slot);
  });
});

describe("rowsOf", () => {
  it("is every appearance the set named, in the order it was answered", () => {
    const rows = rowsOf([appearance(), appearance({ name: "Tideglass Mantle", displayType: 1 })]);

    expect(rows.map((one) => one.label)).toEqual(["Tideglass Crown", "Tideglass Mantle"]);
  });

  // One row per *slot*, never folded together the way a Blizzard set's items are. The same
  // sword in both hands arrives twice, and folding it would be losing the hand that came
  // second — which is a piece of the outfit the player actually put on.
  it("keeps two slots holding one appearance as two rows", () => {
    const sword = appearance({
      modifiedAppearanceId: 71_007, itemId: 30_007, name: "Emberforge Blade", appearanceId: 80_007,
      displayType: 11, inventoryType: 13, displayInfoId: 900_007,
    });

    expect(rowsOf([sword, sword])).toHaveLength(2);
  });
});

describe("filterInGameSets", () => {
  const TIDEGLASS = set({ id: 4, name: "Tideglass court" });
  const EMBERFORGE = set({ id: 6, name: "Emberforge court" });
  const NAMELESS = set({ id: 5, name: "", slots: [] });
  const names = (sets: InGameSet[]): string[] => sets.map(setLabel);

  it("leaves every set alone when nothing is asked of it", () => {
    expect(names(filterInGameSets([TIDEGLASS, EMBERFORGE], "  ")))
      .toEqual(["Tideglass court", "Emberforge court"]);
  });

  it("matches the name the player gave it, whatever case it is typed in", () => {
    expect(names(filterInGameSets([TIDEGLASS, EMBERFORGE], "TIDEGLASS")))
      .toEqual(["Tideglass court"]);
  });

  // Every word rather than the whole phrase, the way every other search in this view works —
  // so a reader who remembers two words about a set need not remember their order.
  it("wants every word rather than the whole phrase", () => {
    expect(names(filterInGameSets([TIDEGLASS, EMBERFORGE], "court emberforge")))
      .toEqual(["Emberforge court"]);
    expect(filterInGameSets([TIDEGLASS, EMBERFORGE], "tideglass emberforge")).toEqual([]);
  });

  // The label is what the card says, so it is what the box searches: a set the client would
  // not name is reachable by the words a reader can actually see on it.
  it("finds a nameless set by the label it is shown under", () => {
    expect(names(filterInGameSets([TIDEGLASS, NAMELESS], "unnamed"))).toEqual([UNNAMED]);
  });

  // The loss this browser accepts, stated rather than apologised for: an in-game set holds
  // appearance ids until somebody opens it, so there is nothing but the name to search. A
  // search that silently only worked on the sets already clicked would be worse.
  it("searches the names and nothing that is in them", () => {
    expect(filterInGameSets([TIDEGLASS], "71001")).toEqual([]);
  });
});

describe("setSummary", () => {
  const NOW = 2_100_000_000;

  it.each<[number, string]>([
    [1, "1 piece"],
    [2, "2 pieces"],
  ])("counts %i", (count, said) => {
    const saved = set({
      slots: Array.from({ length: count }, (_, index) => at(index, 71_001 + index)),
    });
    expect(setSummary(saved, NOW)).toBe(said);
  });

  // "Changed" rather than "read": the addon moves that moment only when two looks at the
  // wardrobe disagree, so a set nobody has touched for a day says a day even though Chronie
  // has looked at it every evening since.
  it("says when the game last differed about it", () => {
    expect(setSummary(set({ observedAt: NOW - 86_400 }), NOW)).toBe("2 pieces · changed yesterday");
  });

  // A wardrobe read before Chronie started keeping that moment, and a set the addon has never
  // seen change. Neither is "changed just now", which is what a missing moment read as zero
  // would eventually say — and both are honestly answered by saying nothing at all.
  it.each<[string, number | null | undefined]>([
    ["a set the addon has never seen differ", null],
    ["a set stored before the moment was kept", undefined],
  ])("dates %s not at all", (_what, observedAt) => {
    expect(setSummary(set({ observedAt }), NOW)).toBe("2 pieces");
  });
});

describe("charactersWithSets", () => {
  const PAYLOAD: InGameSetsPayload = {
    characters: [
      { character: "Aster-Ravencrest", sets: [set()] },
      { character: "Nerine-Ravencrest", sets: [] },
    ],
  };

  // Null is the state the window is in until the read lands, and it is not an empty roster:
  // an empty list here would have the view saying "no wardrobes read yet" before it asked.
  it("has nothing to say about a payload that has not arrived", () => {
    expect(charactersWithSets(null)).toEqual([]);
  });

  it("keeps the order the backend sorted them into", () => {
    expect(charactersWithSets(PAYLOAD).map((one) => one.character))
      .toEqual(["Aster-Ravencrest", "Nerine-Ravencrest"]);
  });
});

describe("setsFor", () => {
  const PAYLOAD: InGameSetsPayload = {
    characters: [
      { character: "Aster-Ravencrest", sets: [set()] },
      { character: "Nerine-Ravencrest", sets: [] },
    ],
  };

  it("hands over what one character has saved", () => {
    expect(setsFor(PAYLOAD, "Aster-Ravencrest")?.map(setLabel)).toEqual(["Tideglass"]);
  });

  // The distinction the whole return type exists for. A character Chronie has read and found
  // nothing on has an empty list; one it has never read has none at all — the first is the
  // game's answer and the second is a question this app has not asked.
  it("tells a character read and found empty from one never read at all", () => {
    expect(setsFor(PAYLOAD, "Nerine-Ravencrest")).toEqual([]);
    expect(setsFor(PAYLOAD, "Brin-Hearth")).toBeNull();
  });

  it("has read nobody's wardrobe until the payload arrives", () => {
    expect(setsFor(null, "Aster-Ravencrest")).toBeNull();
  });
});

describe("wardrobeSummary", () => {
  // The three sentences, and the middle one is why there are three: a player who saves their
  // outfits in this app and not in the game is being told that is what Chronie sees, rather
  // than shown a blank where a number goes.
  it.each<[string, InGameSet[] | null, string]>([
    ["a character never read", null, "Chronie has not read this character's wardrobe yet."],
    ["one read and holding nothing", [], "No sets saved in game."],
    ["one set", [set()], "1 set saved in game"],
    ["several", [set(), set({ id: 5 })], "2 sets saved in game"],
  ])("says its own sentence for %s", (_what, sets, said) => {
    expect(wardrobeSummary(sets)).toBe(said);
  });
});
