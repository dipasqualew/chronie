import { describe, expect, it } from "vitest";

import {
  UNNAMED,
  appearanceIds,
  charactersWithSets,
  filterInGameSets,
  iconFrom,
  requestSummary,
  rowOf,
  rowsOf,
  setLabel,
  setSummary,
  setsFor,
  slotsFrom,
  transmogSlotOf,
  wardrobeSummary,
  wornFrom,
} from "./inGameSets";
import { NOTHING_ON, wear } from "./outfit";
import type { Outfit, Worn } from "./outfit";
import { ANY_CLASS } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type {
  InGameSet,
  InGameSetSlot,
  InGameSetsPayload,
  SetRequest,
  TransmogAppearance,
} from "./types";

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
      modifiedAppearanceId: 71_007,
      itemId: 30_007,
      name: "Emberforge Blade",
      appearanceId: 80_007,
      displayType: 11,
      inventoryType: 13,
      displayInfoId: 900_007,
    });

    expect(rowsOf([sword, sword])).toHaveLength(2);
  });
});

describe("wornFrom", () => {
  const CROWN = appearance();
  const MANTLE = appearance({
    modifiedAppearanceId: 71_002,
    name: "Tideglass Mantle",
    appearanceId: 80_002,
    displayType: 1,
    inventoryType: 3,
    displayInfoId: 900_002,
  });

  it("is the set as an outfit, in the order the appearances were answered", () => {
    expect(wornFrom([CROWN, MANTLE])).toEqual([
      { displayInfoId: 900_001, displayType: 0, inventoryType: 1 },
      { displayInfoId: 900_002, displayType: 1, inventoryType: 3 },
    ]);
  });

  // The two `wearable` refuses, and sending either would be asking the backend to put a look
  // somewhere no body has. The set is still what the set is; it has one fewer thing showing.
  it("leaves out a piece the character has nowhere to put", () => {
    const arrow = appearance({
      modifiedAppearanceId: 71_020,
      itemId: 30_020,
      name: "Emberforge Arrow",
      appearanceId: 80_020,
      displayType: 20,
      inventoryType: 24,
      displayInfoId: 900_020,
    });

    expect(wornFrom([CROWN, WITHHELD, arrow])).toEqual([
      { displayInfoId: 900_001, displayType: 0, inventoryType: 1 },
    ]);
  });

  // Which is the one place this differs from `rowsOf` above it, and deliberately: the two
  // hands are a fact about the set, and the picture of a body wearing one sword twice is the
  // picture of it wearing the sword once.
  it("wears one appearance once however many slots the set gave it", () => {
    const sword = appearance({
      modifiedAppearanceId: 71_007,
      itemId: 30_007,
      name: "Emberforge Blade",
      appearanceId: 80_007,
      displayType: 11,
      inventoryType: 13,
      displayInfoId: 900_007,
    });

    expect(wornFrom([sword, sword])).toHaveLength(1);
  });

  it("is nothing at all for a set that names nothing wearable", () => {
    expect(wornFrom([])).toEqual([]);
    expect(wornFrom([WITHHELD])).toEqual([]);
  });
});

describe("filterInGameSets", () => {
  const TIDEGLASS = set({ id: 4, name: "Tideglass court" });
  const EMBERFORGE = set({ id: 6, name: "Emberforge court" });
  const NAMELESS = set({ id: 5, name: "", slots: [] });
  const names = (sets: InGameSet[]): string[] => sets.map(setLabel);

  it("leaves every set alone when nothing is asked of it", () => {
    expect(names(filterInGameSets([TIDEGLASS, EMBERFORGE], "  "))).toEqual([
      "Tideglass court",
      "Emberforge court",
    ]);
  });

  it("matches the name the player gave it, whatever case it is typed in", () => {
    expect(names(filterInGameSets([TIDEGLASS, EMBERFORGE], "TIDEGLASS"))).toEqual([
      "Tideglass court",
    ]);
  });

  // Every word rather than the whole phrase, the way every other search in this view works —
  // so a reader who remembers two words about a set need not remember their order.
  it("wants every word rather than the whole phrase", () => {
    expect(names(filterInGameSets([TIDEGLASS, EMBERFORGE], "court emberforge"))).toEqual([
      "Emberforge court",
    ]);
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
    expect(charactersWithSets(PAYLOAD).map((one) => one.character)).toEqual([
      "Aster-Ravencrest",
      "Nerine-Ravencrest",
    ]);
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

/* ---------- and the one thing this app sends the other way ---------- */

/** One appearance as the row every browser in this view draws, which is what a send reads. */
const row = (fields: Partial<TransmogAppearance> = {}): AppearanceRow => rowOf(appearance(fields));

/** The outfit those rows come to, assembled the way a reader assembles one. */
const dressedIn = (...rows: AppearanceRow[]): Outfit =>
  rows.reduce((worn, one) => wear(worn, one), NOTHING_ON);

/**
 * The same, with the rows put where a test says rather than where `wear` would put them.
 *
 * For the two cases a reader cannot reach and the code guards anyway: `wear` refuses exactly
 * what `slotsFrom` refuses, so an outfit assembled the ordinary way can never hold a row the
 * send has nowhere to put. Forcing one in is what makes the guard under it assertable.
 */
const forced = (pieces: Record<string, AppearanceRow>): Outfit =>
  Object.fromEntries(
    Object.entries(pieces).map(([place, one]): [string, Worn] => [
      place,
      { place, row: one, from: "" },
    ]),
  );

describe("transmogSlotOf", () => {
  // The whole reason this is a written-out table rather than the display type passed through.
  // Both numberings cover the same eleven places and they disagree about eight of them, so
  // every disagreement is named here: getting one wrong puts a cloak where the shirt goes, and
  // is discovered by a player looking at their own character wearing it.
  it.each<[string, number, number]>([
    ["a shirt", 2, 4],
    ["a back", 9, 2],
    ["a tabard", 10, 5],
    ["a waist", 4, 8],
    ["legs", 5, 9],
    ["feet", 6, 10],
    ["a wrist", 7, 6],
    ["hands", 8, 7],
  ])("sends %s from display type %i to transmog slot %i", (_what, displayType, slot) => {
    expect(transmogSlotOf(row({ displayType }))).toBe(slot);
  });

  // And the three the two numberings happen to agree about, asserted rather than assumed —
  // they are what makes the table look like an identity to anybody reading only the top of it.
  it.each<[string, number]>([
    ["a head", 0],
    ["a shoulder", 1],
    ["a chest", 3],
  ])("leaves %s where both numberings already agree it goes", (_what, displayType) => {
    expect(transmogSlotOf(row({ displayType }))).toBe(displayType);
  });

  // The two the display type cannot answer at all: everything from 11 up is a weapon or a
  // shield, and which hand holds it is the item's own `InventoryType` — see `heldIn`.
  it.each<[string, number, number, number]>([
    ["a one-hander", 11, 13, 11],
    ["a two-hander", 11, 17, 11],
    ["an off-hand", 11, 22, 12],
    ["a shield", 13, 14, 12],
  ])("puts %s in the hand the game says holds it", (_what, displayType, inventoryType, slot) => {
    expect(transmogSlotOf(row({ displayType, inventoryType }))).toBe(slot);
  });

  // Arrows: filed under a weapon slot and held by nobody. `placeOf` has nowhere to put one
  // either, so a row that cannot go on the character in this app is one that is not sent to
  // the game — the two refusals have to agree or an outfit could be sent that was never worn.
  it("has nowhere to put a thing the game files under a weapon slot and nobody holds", () => {
    const arrows = row({ displayType: 11, inventoryType: 24 });

    expect(transmogSlotOf(arrows)).toBeNull();
  });

  /**
   * BUG, recorded rather than fixed: a withheld row is sent to the head.
   *
   * `transmogSlotOf` promises nothing "for exactly the things `outfit.ts` has nowhere to put
   * either — an appearance the game withholds, a thing filed under a weapon slot that nobody
   * holds". Keeping the first half takes asking about `withheld` *before* reading the display
   * type: the backend hands a withheld row over as zeroes, and zero is a perfectly good display
   * type, so a withheld row read off the table comes back a head — and what would then be sent
   * is a request naming slot 0 and no appearance at all.
   *
   * Unreachable through the window today — `wear` refuses a withheld row, so one cannot be in
   * an outfit — but the guard is what makes the promise true rather than lucky, and the next
   * caller of this function will not be `wear`.
   */
  it("has nowhere to put an appearance the game withholds", () => {
    expect(transmogSlotOf(rowOf(WITHHELD))).toBeNull();
  });
});

describe("slotsFrom", () => {
  // Ascending by the *game's* numbering, which is not the order the rail beside the character
  // reads: that one runs head downwards, so it lists the shirt above the chest, and the game
  // numbers the chest 3 and the shirt 4. A send that passed the rail's order through would
  // hand the client a list going 0, 4, 3.
  it("comes back in the game's own slot order rather than the body's", () => {
    const outfit = dressedIn(
      row({ displayType: 2, appearanceId: 80_002 }),
      row({ displayType: 3, appearanceId: 80_003 }),
      row({ displayType: 0, appearanceId: 80_001 }),
    );

    expect(slotsFrom(outfit)).toEqual([
      { slot: 0, appearanceId: 80_001 },
      { slot: 3, appearanceId: 80_003 },
      { slot: 4, appearanceId: 80_002 },
    ]);
  });

  // A place holds one thing here and one thing in the game, so there is nothing to reconcile:
  // the second helm took the first one's place on her, and the request names that place once.
  it("names a place once, with what she is actually wearing in it", () => {
    const first = row({ displayType: 0, appearanceId: 80_001 });
    const second = row({ displayType: 0, appearanceId: 80_042 });

    expect(slotsFrom(dressedIn(first, second))).toEqual([{ slot: 0, appearanceId: 80_042 }]);
  });

  it("has nothing to send for a character with nothing on", () => {
    expect(slotsFrom(NOTHING_ON)).toEqual([]);
  });

  // Both halves of "a row that cannot be worn is a row that is not sent". The arrows never
  // reach an outfit at all, because `wear` refuses them for the same reason; and the floor
  // under that is `slotsFrom` dropping one that was put there anyway.
  it("drops what it has nowhere to put, however it got into the outfit", () => {
    const arrows = row({ displayType: 11, inventoryType: 24, appearanceId: 80_024 });
    const helm = row({ displayType: 0, appearanceId: 80_001 });

    expect(slotsFrom(dressedIn(helm, arrows))).toEqual([{ slot: 0, appearanceId: 80_001 }]);
    expect(slotsFrom(forced({ "armour-0": helm, "hand-right": arrows }))).toEqual([
      { slot: 0, appearanceId: 80_001 },
    ]);
  });
});

describe("iconFrom", () => {
  // Not optional, whatever the type says: the client documents `NewCustomSet`'s `icon` as a
  // `fileID` that may not be nil, so the first piece holding a picture is the set's picture.
  it("takes the picture of the first piece that has one", () => {
    const outfit = dressedIn(
      row({ displayType: 0, iconFileDataId: 130_001 }),
      row({ displayType: 3, iconFileDataId: 130_003 }),
    );

    expect(iconFrom(outfit)).toBe(130_001);
  });

  // The game names no texture for some looks, and a zero handed to `NewCustomSet` is not a
  // picture — so a bare first slot is passed over rather than being the answer.
  it("passes over a piece the game gives no picture for", () => {
    const outfit = dressedIn(
      row({ displayType: 0, iconFileDataId: 0 }),
      row({ displayType: 3, iconFileDataId: 130_003 }),
    );

    expect(iconFrom(outfit)).toBe(130_003);
  });

  // Nothing is the honest answer only when there is no picture anywhere in the outfit, and it
  // is the caller's to deal with rather than a nil for the game to refuse.
  it.each<[string, Outfit]>([
    ["an outfit with nothing on it", NOTHING_ON],
    [
      "one whose every piece the game names no texture for",
      dressedIn(
        row({ displayType: 0, iconFileDataId: 0 }),
        row({ displayType: 3, iconFileDataId: 0 }),
      ),
    ],
  ])("has no picture to give for %s", (_what, outfit) => {
    expect(iconFrom(outfit)).toBeNull();
  });

  /**
   * BUG, recorded rather than fixed: the picture is picked in the rail's order, not the game's.
   *
   * `iconFrom` claims to pick the way Blizzard's own `WardrobeCustomSetManager:NewCustomSet`
   * does — "it walks the slots in order and takes the icon of the first one holding an
   * appearance" — so that a set sent from here wears the picture it would have worn if it had
   * been saved in game.
   *
   * The trap is that `wornPieces` answers in `PLACES`: head downwards, the order a reader's eye
   * goes, and deliberately not the game's numbering. The two agree for every outfit whose
   * earliest filled place is the head, which is nearly all of them, and disagree wherever the
   * body order and the slot order cross. A shirt and a chest is the plainest crossing: the game
   * numbers the chest 3 and the shirt 4, so it takes the chest's picture, while the rail lists
   * the shirt first.
   *
   * So the walk has to be the game's order and not the rail's, which is what `placed` is for.
   */
  it("takes the picture the game would have taken, not the one the rail lists first", () => {
    const outfit = dressedIn(
      row({ displayType: 2, iconFileDataId: 130_002 }),
      row({ displayType: 3, iconFileDataId: 130_003 }),
    );

    expect(iconFrom(outfit)).toBe(130_003);
  });
});

describe("requestSummary", () => {
  const request = (fields: Partial<SetRequest> = {}): SetRequest => ({
    id: 1,
    name: "Tideglass court",
    createdAt: 2_100_000_000,
    slots: [at(0, 80_001)],
    ...fields,
  });

  // The four the addon can answer with, each its own sentence: a reader who sent an outfit
  // wants to know whether it is in the game, and "sent" says nothing about that either way.
  it.each<[string, string]>([
    ["created", "Saved in game as Tideglass court."],
    ["updated", "Saved over the in-game set called Tideglass court."],
    ["refused", "Not saved: the game would not accept the name Tideglass court."],
  ])("says what %s came to", (outcome, said) => {
    expect(requestSummary(request({ outcome }))).toBe(said);
  });

  // The one refusal a reader can do something about, so it says what: the account is out of
  // slots, and the request is still waiting rather than lost.
  it("says how to make room when the account's sets are full", () => {
    expect(requestSummary(request({ outcome: "full" }))).toBe(
      "Not saved: the account's transmog sets are full. " +
        "Delete one in game and Tideglass court goes in next login.",
    );
  });

  // An outcome this app has never heard of is an addon newer than the window reading it —
  // `failed` is one the backend already writes and this has no sentence for. Saying something
  // plain is better than a blank where the answer goes.
  it.each<[string, string]>([
    ["the failure the addon already writes", "failed"],
    ["one from an addon newer than this window", "somethingNewer"],
  ])("has a plain sentence for %s", (_what, outcome) => {
    expect(requestSummary(request({ outcome }))).toBe("Could not save Tideglass court in game.");
  });

  // The state that matters most, because it is the ordinary one and the one nothing else
  // explains: nothing this app does reaches a running game, so the outfit is saved at the next
  // login and a line saying only "sent" would have people opening the game to look for it.
  it.each<[string, string | null | undefined]>([
    ["a request the addon has not answered yet", null],
    ["one stored before an outcome could be written at all", undefined],
  ])("explains that %s lands at next login", (_what, outcome) => {
    expect(requestSummary(request({ outcome }))).toBe(
      "Waiting for Tideglass court to be saved — it goes in next time you log that account in.",
    );
  });
});
