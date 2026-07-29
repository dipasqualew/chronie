/**
 * The ledger's one piece of behaviour that is not a pure function of its props.
 *
 * `details.tsx` builds its rows in a `useMemo`, and that memo lists `learned` — a counter the
 * item book bumps when an answer lands — among its dependencies without reading it. ESLint
 * calls that an unnecessary dependency and ESLint is wrong: the book is a cache outside React,
 * so nothing about `items` changes identity when the game finally says what item 101 is called,
 * and the counter is the only thing that can tell the memo to look again.
 *
 * That is a stability contract stated in a comment and suppressed in a lint rule, which is
 * exactly the kind of claim that is worth nothing until something runs it. This is the test the
 * suppression in `details.tsx` points at.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Details } from "./details";
import { createItemBook } from "./items";
import type { ItemDetail, ItemDetailsPayload, Segment } from "./types";

const EVENING = 1_785_063_600;

/** The one item this history names, as the game would describe it. */
const CROWN: ItemDetail = {
  id: 101,
  name: "Crown of Tides",
  classId: 4,
  subclassId: 1,
  inventoryType: 1,
  quality: 4,
  requiredLevel: 80,
  allowableClass: 0xffff,
  iconFileDataId: 0,
};

/** A segment carrying one transmog the addon could not name when it wrote it down. */
const segment = (): Segment => ({
  segmentId: 1,
  id: "synthetic-001",
  character: "Aster-Vale",
  day: "2026-07-26",
  instance: "Glass Caverns",
  difficulty: "",
  instanceType: "scenario",
  startedAt: EVENING,
  endedAt: EVENING + 1800,
  seconds: 1800,
  lootValue: 0,
  goldDiff: 0,
  housingXP: 0,
  transmogs: [{ id: 101, name: null, newAppearance: true }],
});

/** Everything the table is showing, which is where a name either is or is not. */
const rows = (): string => screen.getByLabelText("Segments").textContent || "";

afterEach(cleanup);

describe("Details", () => {
  // The acceptance, and the whole of what the suppression claims: a row drawn before the book
  // answered says `Item 101`, and the same row says `Crown of Tides` once it has — without the
  // segments, the filters, the sort or the book itself having changed identity in between.
  it("names a transmog the addon could not, once the item book answers", async () => {
    // Held open so the two halves are separable: nothing has arrived while `load` is pending,
    // which is what makes the first assertion a statement about a real moment rather than a
    // race that happened to be lost.
    let answer: (payload: ItemDetailsPayload) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<ItemDetailsPayload>((resolve) => {
          answer = resolve;
        }),
    );
    const items = createItemBook({ load, loadIcons: () => Promise.resolve({ icons: {} }) });

    render(<Details segments={[segment()]} items={items} onOpenSegment={() => {}} />);

    await waitFor(() => expect(load).toHaveBeenCalledWith([101]));
    expect(rows()).toContain("Item 101");

    answer({ items: { 101: CROWN } });

    await waitFor(() => expect(rows()).toContain("Crown of Tides"));
    expect(rows()).not.toContain("Item 101");
  });

  // The other side of it. A history the addon named itself asks the game nothing, so the memo
  // that the test above proves recomputes must not be recomputing for every history.
  it("asks the game about nothing when the addon named everything itself", () => {
    const load = vi.fn(() => Promise.resolve<ItemDetailsPayload>({ items: {} }));
    const items = createItemBook({ load, loadIcons: () => Promise.resolve({ icons: {} }) });
    const named = segment();
    named.transmogs = [{ id: 101, name: "Crown of Tides", newAppearance: true }];

    render(<Details segments={[named]} items={items} onOpenSegment={() => {}} />);

    expect(load).not.toHaveBeenCalled();
    expect(rows()).toContain("Crown of Tides");
  });
});
