import { describe, expect, it, vi } from "vitest";

import { createItemBook, itemLine } from "./items";
import type { ItemBookOptions } from "./items";
import type { IconsPayload, ItemDetail, ItemDetailsPayload } from "./types";

/** The armour and weapon classes as the game numbers them. */
const ARMOR = 4;
const WEAPON = 2;

const ANY_CLASS = 0xffff;

const detail = (overrides: Partial<ItemDetail> = {}): ItemDetail => ({
  id: 201,
  name: "Wanderer's Mantle",
  classId: ARMOR,
  subclassId: 2,
  inventoryType: 3,
  quality: 3,
  requiredLevel: 25,
  allowableClass: ANY_CLASS,
  iconFileDataId: 260001,
  ...overrides,
});

describe("itemLine", () => {
  it("reads an item out of the game's own facts about it", () => {
    expect(itemLine(201, null, detail())).toEqual({
      name: "Wanderer's Mantle",
      quality: 3,
      qualityName: "Rare",
      kind: "Leather",
      slot: "Shoulders",
      restriction: "",
      requirement: "Level 25",
      iconFileDataId: 260001,
    });
  });

  // Three ways a row gets its name, in the order it tries them. The game's spelling wins
  // because it is the one that is definitely the game's; the addon's is what an install that
  // cannot describe the item at all is left with; the id is what neither of them said.
  it.each([
    ["the game's name over the addon's", "Caught At The Time", detail(), "Wanderer's Mantle"],
    [
      "the addon's where the game says nothing",
      "Caught At The Time",
      undefined,
      "Caught At The Time",
    ],
    ["the id where nothing said anything", null, undefined, "Item 201"],
    // A row the small table describes and the big one cannot name: half an answer, and the
    // half that is missing is exactly the one the addon might have.
    [
      "the addon's where the game's row has no name",
      "Caught At The Time",
      detail({ name: "" }),
      "Caught At The Time",
    ],
  ])("names a row by %s", (_what, recorded, found, expected) => {
    expect(itemLine(201, recorded, found).name).toBe(expected);
  });

  // A quality is a colour, and an item nothing is known about must not be given one: zero is
  // poor — the grey of a broken sword — and "not looked up yet" is not grey, it is uncoloured.
  it("has no quality at all for an item it has not been told about", () => {
    expect(itemLine(201, "Caught At The Time").quality).toBeNull();
    expect(itemLine(201, "Caught At The Time").qualityName).toBe("");
    expect(itemLine(201, null, detail({ quality: 0 })).quality).toBe(0);
    expect(itemLine(201, null, detail({ quality: 0 })).qualityName).toBe("Poor");
  });

  it.each([
    ["cloth", detail({ subclassId: 1 }), "Cloth"],
    ["leather", detail({ subclassId: 2 }), "Leather"],
    ["mail", detail({ subclassId: 3 }), "Mail"],
    ["plate", detail({ subclassId: 4 }), "Plate"],
    // A ring is armour by class and nothing by armour class, and a chip saying "Miscellaneous"
    // on every ring in the history would be noise rather than information.
    [
      "a ring, which is filed under no armour class at all",
      detail({ subclassId: 0, inventoryType: 11 }),
      "",
    ],
    // The game keeps one-handed and two-handed swords apart; the slot beside this already
    // says which, so saying it again here would say it twice.
    ["a one-handed sword", detail({ classId: WEAPON, subclassId: 7, inventoryType: 13 }), "Sword"],
    ["a two-handed sword", detail({ classId: WEAPON, subclassId: 8, inventoryType: 17 }), "Sword"],
    ["a bow", detail({ classId: WEAPON, subclassId: 2, inventoryType: 15 }), "Bow"],
    // Not armour and not a weapon: a hearthstone has no kind worth naming.
    ["a token nobody wears", detail({ classId: 15, subclassId: 0, inventoryType: 0 }), ""],
  ])("says what kind of thing %s is", (_what, found, expected) => {
    expect(itemLine(201, null, found).kind).toBe(expected);
  });

  it.each([
    ["a helm", 1, "Head"],
    ["a chestpiece", 5, "Chest"],
    // A robe is the chest slot under a number of its own, and reads as the chest.
    ["a robe", 20, "Chest"],
    ["a one-hander", 13, "One-hand"],
    ["a two-hander", 17, "Two-hand"],
    ["a cloak", 16, "Back"],
    // Worn nowhere, which is a fact about the item rather than a slot to name.
    ["a thing that is not worn", 0, ""],
  ])("says where %s is worn", (_what, inventoryType, expected) => {
    expect(itemLine(201, null, detail({ inventoryType })).slot).toBe(expected);
  });

  // The class mask is the only "restriction" the game keeps that a player acts on, and it is
  // read against the classes that exist: a legacy item can carry bits for classes that never
  // shipped, and a mask covering everybody is not a restriction however many spare bits it has.
  it.each([
    ["nobody, when anybody may wear it", ANY_CLASS, ""],
    ["nobody, when the mask is empty", 0, ""],
    ["the three that wear plate", 0b10_0011, "Warrior, Paladin, Death Knight only"],
    ["one class", 0b1000, "Rogue only"],
    [
      "the newest class, which is the highest bit that means anything",
      0b1_0000_0000_0000,
      "Evoker only",
    ],
    // Every class the game has, plus two bits set aside for classes that never arrived.
    ["nobody, when every class that exists is allowed", 0b111_1111_1111_1111, ""],
  ])("names %s", (_what, allowableClass, expected) => {
    expect(itemLine(201, null, detail({ allowableClass })).restriction).toBe(expected);
  });

  it("says what level it takes, and says nothing where it takes none", () => {
    expect(itemLine(201, null, detail({ requiredLevel: 60 })).requirement).toBe("Level 60");
    expect(itemLine(201, null, detail({ requiredLevel: 0 })).requirement).toBe("");
  });
});

/* ---------- the book ---------- */

const ICON = "data:image/png;base64,icon";

/**
 * A book over a backend a test answers, with the batch held until the test releases it.
 *
 * Nothing here is monkey patched and nothing waits on a timer: the schedule is injected, so
 * "everything that asked in this turn shares one request" is something a test states rather
 * than something it hopes a microtask arranged.
 */
function book(known: Record<number, ItemDetail>, overrides: Partial<ItemBookOptions> = {}) {
  const run: Array<() => void> = [];
  const load = vi.fn((ids: number[]): Promise<ItemDetailsPayload> =>
    Promise.resolve({
      items: Object.fromEntries(
        ids.filter((id) => known[id]).map((id) => [String(id), known[id] as ItemDetail]),
      ),
    }),
  );
  const loadIcons = vi.fn((fdids: number[]): Promise<IconsPayload> =>
    Promise.resolve({
      icons: Object.fromEntries(fdids.map((fdid) => [String(fdid), ICON])),
    }),
  );
  const made = createItemBook({
    load,
    loadIcons,
    schedule: (send) => run.push(send),
    ...overrides,
  });
  /** Sends the batch that has piled up, and settles both halves of the answer. */
  const flush = async (): Promise<void> => {
    for (const send of run.splice(0)) send();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { book: made, load, loadIcons, flush };
}

describe("createItemBook", () => {
  // What the batching is for: a segment of twenty pieces is drawn as twenty rows, each of
  // which asks for itself, and the read behind the request opens the game's largest table
  // once per request however many ids that request carries.
  it("sends one request for everything that asked in the same turn", async () => {
    const shown = book({ 201: detail(), 202: detail({ id: 202, name: "Bulwark Helm" }) });
    shown.book.learn([201], () => {});
    shown.book.learn([202], () => {});
    shown.book.learn([201], () => {});

    await shown.flush();

    expect(shown.load).toHaveBeenCalledTimes(1);
    expect(shown.load).toHaveBeenCalledWith([201, 202]);
    expect(shown.book.detail(202)?.name).toBe("Bulwark Helm");
  });

  // A history names the same piece over and over — a set collected slot by slot, a weapon
  // transmogged onto everything — and what the game says about it cannot change while the
  // app is running.
  it("asks after an item once and never again", async () => {
    const shown = book({ 201: detail() });
    shown.book.learn([201], () => {});
    await shown.flush();
    shown.book.learn([201], () => {});
    await shown.flush();

    expect(shown.load).toHaveBeenCalledTimes(1);
  });

  // Whether an install can describe an item is a fact about the install rather than about the
  // moment, so a second look would cost a request to arrive back at the same nothing.
  it("does not go looking again for an item the install could not describe", async () => {
    const shown = book({});
    shown.book.learn([404], () => {});
    await shown.flush();
    shown.book.learn([404], () => {});
    await shown.flush();

    expect(shown.load).toHaveBeenCalledTimes(1);
    expect(shown.book.detail(404)).toBeUndefined();
  });

  // Who asked is not who is waiting: the second row naming an item adds nothing to the
  // request, and it still has to be told when the answer lands or it draws the id forever.
  it("tells every row on screen, not only the one that asked first", async () => {
    const shown = book({ 201: detail() });
    const first = vi.fn();
    const second = vi.fn();
    shown.book.learn([201], first);
    shown.book.learn([201], second);

    await shown.flush();

    // Once for the words and once for the picture, to each of them.
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(shown.book.icon(201)).toBe(ICON);
  });

  it("stops telling a row that has left the screen", async () => {
    const shown = book({ 201: detail() });
    const gone = vi.fn();
    const unsubscribe = shown.book.learn([201], gone);
    unsubscribe();

    await shown.flush();

    expect(gone).not.toHaveBeenCalled();
    expect(shown.book.detail(201)).toEqual(detail());
  });

  // Two items sharing one picture is ordinary — a tier set is one icon per slot across every
  // colour of it — and the second is answered from what the first decoded.
  it("asks for a picture once however many items name it", async () => {
    const shown = book({
      201: detail(),
      202: detail({ id: 202, name: "Bulwark Helm", iconFileDataId: 260001 }),
    });
    shown.book.learn([201, 202], () => {});
    await shown.flush();

    expect(shown.loadIcons).toHaveBeenCalledTimes(1);
    expect(shown.loadIcons).toHaveBeenCalledWith([260001]);
    expect(shown.book.icon(202)).toBe(ICON);
  });

  // The reasons a lookup fails are the ones that stop the whole game folder being readable —
  // it has not been chosen yet, or it is mid-patch — and those are worth one more try when the
  // reader opens the next segment.
  it("tries again after a lookup that failed", async () => {
    const shown = book(
      { 201: detail() },
      {
        load: vi.fn(() => Promise.reject(new Error("Choose the game folder in Setup first."))),
      },
    );
    shown.book.learn([201], () => {});
    await shown.flush();
    expect(shown.book.detail(201)).toBeUndefined();

    const second = book({ 201: detail() });
    second.book.learn([201], () => {});
    await second.flush();
    expect(second.book.detail(201)).toEqual(detail());
  });

  // An item with no picture — the game names none, or the install holds no such file — must
  // not leave a request for icon zero on its way out.
  it("asks for no picture at all when the item names none", async () => {
    const shown = book({ 201: detail({ iconFileDataId: 0 }) });
    shown.book.learn([201], () => {});
    await shown.flush();

    expect(shown.loadIcons).not.toHaveBeenCalled();
    expect(shown.book.icon(201)).toBeUndefined();
  });

  // An event with no item behind it at all comes across as a zero, and a zero is not an id.
  it("never asks after an id that is not one", async () => {
    const shown = book({});
    shown.book.learn([0], () => {});
    await shown.flush();

    expect(shown.load).not.toHaveBeenCalled();
  });
});
