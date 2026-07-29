import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameItem } from "./item";
import { createItemBook } from "./items";
import type { IconsPayload, ItemDetail, ItemDetailsPayload } from "./types";

afterEach(cleanup);

const ICON = "data:image/png;base64,icon";

const MANTLE: ItemDetail = {
  id: 201,
  name: "Wanderer's Mantle",
  classId: 4,
  subclassId: 2,
  inventoryType: 3,
  quality: 3,
  requiredLevel: 25,
  allowableClass: 0xffff,
  iconFileDataId: 260001,
};

/**
 * The component over a backend a test answers, which is the only way to drive it: nothing
 * here talks to a real one and nothing monkey patches one.
 *
 * The requests are recorded rather than merely answered, because "two rows of the same item
 * are one lookup" is a statement about what crossed the bridge and only the request itself
 * can say it.
 */
function draw(
  children: (book: ReturnType<typeof createItemBook>) => React.ReactNode,
  known: Record<number, ItemDetail> = { 201: MANTLE },
) {
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
  const book = createItemBook({ load, loadIcons });
  return Object.assign(render(<>{children(book)}</>), { load, loadIcons });
}

const picture = (): HTMLImageElement | null => document.querySelector(".item-icon img");
const facts = (): string[] =>
  [...document.querySelectorAll(".item-facts .chip")].map((chip) => chip.textContent ?? "");

describe("GameItem", () => {
  // The whole of what the lookup is for: a segment records a number, and what the reader ends
  // up looking at is the piece of gear — named, pictured, and said what it is.
  it("fills in what the game says about an item the segment only numbered", async () => {
    draw((book) => <GameItem id={201} book={book} />);

    // Before the answer lands there is nothing to show but the id, which is what the app drew
    // before any of this existed.
    expect(screen.getByRole("link", { name: "Item 201" })).toBeTruthy();
    expect(picture()).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Wanderer's Mantle" })).toBeTruthy(),
    );
    expect(facts()).toEqual(["Leather", "Shoulders", "Level 25"]);
    await waitFor(() => expect(picture()?.src).toBe(ICON));
  });

  // The colour of an item's name is the one thing about a piece of gear every player reads
  // without being told. It is an attribute rather than a style because the packaged app's CSP
  // drops every inline style the page writes.
  it("marks the name and the frame with the quality the game gives it", async () => {
    draw((book) => <GameItem id={201} book={book} />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Wanderer's Mantle" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("link", { name: "Wanderer's Mantle" }).getAttribute("data-quality"),
    ).toBe("3");
    expect(document.querySelector(".item-icon")?.getAttribute("data-quality")).toBe("3");
  });

  // An install that cannot describe an item is the ordinary case for a build newer than the
  // one on disk, and the row still has to draw: the name the addon caught, and no more.
  it("keeps the name the addon caught for an item this install cannot describe", async () => {
    const shown = draw((book) => <GameItem id={404} name="Caught At The Time" book={book} />, {});

    await waitFor(() => expect(shown.load).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Caught At The Time" })).toBeTruthy();
    expect(facts()).toEqual([]);
    expect(picture()).toBeNull();
  });

  // The reason the book batches: a segment's worth of rows each ask for themselves, and the
  // read behind the request opens the game's largest table once per request.
  it("asks once for an item that is on the screen twice, and fills in both", async () => {
    const shown = draw((book) => (
      <>
        <GameItem id={201} book={book} />
        <GameItem id={201} book={book} />
      </>
    ));

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Wanderer's Mantle" })).toHaveLength(2),
    );
    expect(shown.load).toHaveBeenCalledTimes(1);
    expect(shown.load).toHaveBeenCalledWith([201]);
  });

  // Every item in the app links to the same place, and the link is what a reader follows for
  // the rest of the story. It leaves the window entirely — `installExternalLinks` hands it to
  // the operating system — which is why it is an anchor rather than a click handler.
  it("links out to the item, by the id the segment recorded", async () => {
    draw((book) => <GameItem id={201} book={book} />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Wanderer's Mantle" })).toBeTruthy(),
    );
    expect(screen.getByRole("link", { name: "Wanderer's Mantle" }).getAttribute("href")).toBe(
      "https://www.wowhead.com/item=201",
    );
  });

  // Inside something that is itself a control — an unfolded summary, where the row is a button
  // back to the segment — a link is not a thing a browser can make sense of.
  it("draws the name as text rather than a link where it sits inside a control", async () => {
    draw((book) => (
      <button type="button">
        <GameItem id={201} book={book} link={false} facts={false} />
      </button>
    ));

    await waitFor(() =>
      expect(screen.getByRole("button").textContent).toContain("Wanderer's Mantle"),
    );
    expect(screen.queryByRole("link")).toBeNull();
    // What is left out of the row is still said, where a reader can ask for it.
    expect(document.querySelector(".item-name")?.getAttribute("title")).toBe(
      "Wanderer's Mantle · Rare · Leather · Shoulders · Level 25",
    );
  });

  it("says who may wear an item that is not for everybody", async () => {
    draw((book) => <GameItem id={202} book={book} />, {
      202: {
        ...MANTLE,
        id: 202,
        name: "Bulwark Helm",
        subclassId: 4,
        inventoryType: 1,
        quality: 4,
        requiredLevel: 60,
        allowableClass: 0b10_0011,
      },
    });

    await waitFor(() => expect(screen.getByRole("link", { name: "Bulwark Helm" })).toBeTruthy());
    expect(facts()).toEqual(["Plate", "Head", "Warrior, Paladin, Death Knight only", "Level 60"]);
  });

  // What the row is drawn beside — whether the appearance was new, the item level of a slot,
  // the time it happened — belongs to whoever is drawing it rather than to the item.
  it("draws what the view puts beside the name", async () => {
    draw((book) => (
      <GameItem id={201} book={book}>
        <span className="appearance-new">new appearance</span>
      </GameItem>
    ));

    const line = document.querySelector(".item-line") as HTMLElement;
    expect(within(line).getByText("new appearance")).toBeTruthy();
  });
});
