import { describe, expect, it } from "vitest";
import {
  equipsetDetail,
  equipsetLevelChange,
  equipsetSlotLine,
  equipsetTitle,
  slotName,
} from "./equipsets";
import type { EquipsetChangeEvent, EquipsetSlotChange } from "./types";

/** A change with only the parts a test is about; the rest is what the backend always sends. */
function change(overrides: Partial<EquipsetChangeEvent> = {}): EquipsetChangeEvent {
  return { setId: 3, name: "Raid", kind: "updated", at: 1_785_000_000, items: [], ...overrides };
}

/** One slot of a change. An absent id on either side is a slot holding nothing. */
function slot(overrides: Partial<EquipsetSlotChange> = {}): EquipsetSlotChange {
  return { slot: 1, ...overrides };
}

describe("slotName", () => {
  it("names the slot the way the character sheet does", () => {
    expect(slotName(1)).toBe("Head");
    expect(slotName(16)).toBe("Main hand");
    expect(slotName(19)).toBe("Tabard");
  });

  // A set recorded on a client this build has no name for still has to draw.
  it("falls back to the number for a slot it has no name for", () => {
    expect(slotName(42)).toBe("Slot 42");
  });
});

describe("equipsetLevelChange", () => {
  // Every slot the change does not mention holds what it held, so the difference across the
  // ones it does mention is the difference across the whole set.
  it("adds up both sides of the slots that changed", () => {
    const levels = equipsetLevelChange(change({
      items: [
        slot({ slot: 1, itemId: 101, itemLevel: 639, previousItemId: 100, previousItemLevel: 623 }),
        slot({ slot: 5, itemId: 201, itemLevel: 632, previousItemId: 200, previousItemLevel: 626 }),
      ],
    }));

    expect(levels).toEqual({ before: 623 + 626, after: 639 + 632 });
  });

  it("counts a slot with nothing on one side as nothing on that side", () => {
    const levels = equipsetLevelChange(change({
      items: [slot({ itemId: 101, itemLevel: 639 })],
    }));

    expect(levels).toEqual({ before: 0, after: 639 });
  });

  // Adding up only the levels that are known would report a drop of several hundred as
  // though the items nobody could ask about had been worth nothing.
  it("gives up when an item's level never reached the ledger", () => {
    const levels = equipsetLevelChange(change({
      items: [
        slot({ slot: 1, itemId: 101, itemLevel: 639, previousItemId: 100, previousItemLevel: 623 }),
        slot({ slot: 5, itemId: 201, previousItemId: 200, previousItemLevel: 626 }),
      ],
    }));

    expect(levels).toBeNull();
  });

  it("gives up when what a slot replaced has no level either", () => {
    expect(equipsetLevelChange(change({
      items: [slot({ itemId: 101, itemLevel: 639, previousItemId: 100 })],
    }))).toBeNull();
  });

  it("reads a change that touched no slot as no movement at all", () => {
    expect(equipsetLevelChange(change({ kind: "created", items: [] })))
      .toEqual({ before: 0, after: 0 });
  });
});

describe("equipsetTitle", () => {
  it("names the set and what became of it", () => {
    expect(equipsetTitle(change({ name: "Mythic Raid", kind: "created" })))
      .toBe("Mythic Raid created");
  });

  it("falls back to the set's id when the name never arrived", () => {
    expect(equipsetTitle(change({ name: "", setId: 7 }))).toBe("Set 7 updated");
  });
});

describe("equipsetDetail", () => {
  it("reports an edit as the slots it touched and where the item level went", () => {
    expect(equipsetDetail(change({
      items: [slot({ itemId: 101, itemLevel: 639, previousItemId: 100, previousItemLevel: 623 })],
    }))).toBe("1 slot, +16 ilvl");
  });

  it("reports a downgrade with a minus rather than a negative plus", () => {
    expect(equipsetDetail(change({
      items: [slot({ itemId: 100, itemLevel: 623, previousItemId: 101, previousItemLevel: 639 })],
    }))).toBe("1 slot, −16 ilvl");
  });

  it("says only what was touched when the item level did not move", () => {
    expect(equipsetDetail(change({
      items: [
        slot({ slot: 1, itemId: 101, itemLevel: 630, previousItemId: 100, previousItemLevel: 630 }),
        slot({ slot: 5, itemId: 201, itemLevel: 630, previousItemId: 200, previousItemLevel: 630 }),
      ],
    }))).toBe("2 slots");
  });

  it("says only what was touched when a level is missing and the sum cannot be trusted", () => {
    expect(equipsetDetail(change({
      items: [slot({ itemId: 101, previousItemId: 100, previousItemLevel: 623 })],
    }))).toBe("1 slot");
  });

  // A set made out of nothing did not gain 639 item levels; it is a 639 set. The average is
  // the number a player would recognise.
  it("reports a created set as its items and their average level", () => {
    expect(equipsetDetail(change({
      kind: "created",
      items: [
        slot({ slot: 1, itemId: 100, itemLevel: 640 }),
        slot({ slot: 5, itemId: 200, itemLevel: 638 }),
      ],
    }))).toBe("2 items, 639 ilvl");
  });

  it("reports a deleted set from what it was holding when it went", () => {
    expect(equipsetDetail(change({
      kind: "deleted",
      items: [slot({ previousItemId: 100, previousItemLevel: 623 })],
    }))).toBe("1 item, 623 ilvl");
  });

  it("says a created set held nothing rather than printing an empty count", () => {
    expect(equipsetDetail(change({ kind: "created", items: [] }))).toBe("no items");
  });

  it("leaves the level off a created set whose items could not be asked", () => {
    expect(equipsetDetail(change({
      kind: "created",
      items: [slot({ itemId: 100 })],
    }))).toBe("1 item");
  });

  it("survives a change that arrived with no items key at all", () => {
    expect(equipsetDetail({ setId: 3, name: "Raid", kind: "updated" })).toBe("0 slots");
  });
});

describe("equipsetSlotLine", () => {
  it("names both sides and what each was worth", () => {
    expect(equipsetSlotLine(slot({
      slot: 1,
      itemId: 101, itemLevel: 639, itemName: "Deepwater Crown",
      previousItemId: 100, previousItemLevel: 623, previousItemName: "Tideglass Crown",
    }))).toEqual({
      slot: "Head",
      before: "Tideglass Crown (623)",
      after: "Deepwater Crown (639)",
      itemId: 101,
      previousItemId: 100,
    });
  });

  // The ordinary shape of a change noticed at a later login: the id reached the ledger and
  // nothing else could be asked, because the item was no longer on the character.
  it("numbers an item it has no name for, and leaves out a level it has none for", () => {
    const line = equipsetSlotLine(slot({ itemId: 101 }));

    expect(line.after).toBe("Item 101");
  });

  it("leaves the side that holds nothing empty, on either side", () => {
    expect(equipsetSlotLine(slot({ previousItemId: 100, previousItemName: "Tideglass Crown" })).after)
      .toBe("");
    expect(equipsetSlotLine(slot({ itemId: 101, itemName: "Deepwater Crown" })).before)
      .toBe("");
  });
});
