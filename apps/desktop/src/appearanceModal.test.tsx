import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceModal } from "./appearanceModal";
import type { AppearanceModalState } from "./appearanceModal";
import type { ModelStage } from "./modelViewer";
import type { GalleryPayload, ItemAppearance, ItemAppearancesPayload, WornPiece } from "./types";

afterEach(cleanup);

// jsdom has no `showModal`, and the component drives the element rather than a prop — so
// without these a dialog is never open and nothing inside it is reachable.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void { this.open = true; };
  HTMLDialogElement.prototype.close = function close(): void { this.open = false; };
});

const SHOULDERS: ItemAppearance = {
  appearanceId: 80012, displayInfoId: 900012, displayType: 3, inventoryType: 3,
};

const model = (body: string): string => `data:model/gltf-binary;base64,${btoa(body)}`;

/**
 * The 3D pane, faked.
 *
 * What is worth recording is how many were ever made and what went on them: a modal that built
 * a renderer per opening would draw exactly the right picture and run a reader out of graphics
 * contexts by the tenth row, which nothing but a count can tell apart.
 */
function fakeStage() {
  const shown: string[] = [];
  const made = { count: 0, disposed: 0 };
  const stage: ModelStage = {
    show: (glb: Uint8Array) => {
      shown.push(new TextDecoder().decode(glb));
      return Promise.resolve();
    },
    resetCamera: () => {},
    dispose: () => { made.disposed += 1; },
  };
  return {
    shown,
    made,
    createStage: () => { made.count += 1; return stage; },
  };
}

function view(
  options: {
    showing?: AppearanceModalState | null;
    appearances?: Record<string, ItemAppearance>;
    models?: (pieces: WornPiece[]) => GalleryPayload;
  } = {},
) {
  const loadAppearance = vi.fn((itemIds: number[]): Promise<ItemAppearancesPayload> => {
    const found: Record<string, ItemAppearance> = {};
    for (const id of itemIds) {
      const look = (options.appearances ?? { 101: SHOULDERS })[String(id)];
      if (look) found[String(id)] = look;
    }
    return Promise.resolve({ appearances: found });
  });
  const loadGallery = vi.fn((pieces: WornPiece[]): Promise<GalleryPayload> =>
    Promise.resolve(options.models?.(pieces) ?? {
      models: pieces.map((piece) => ({
        displayInfoId: piece.displayInfoId,
        kind: "worn" as const,
        model: model("a body wearing it"),
      })),
    }));
  const stage = fakeStage();
  const rendered = render(
    <AppearanceModal
      showing={options.showing === undefined
        ? { itemId: 101, name: "Wanderer's Mantle" }
        : options.showing}
      onClose={() => {}}
      loadAppearance={loadAppearance}
      loadGallery={loadGallery}
      createStage={stage.createStage}
    />,
  );
  return { rendered, loadAppearance, loadGallery, ...stage };
}

describe("the appearance modal", () => {
  // The whole reason it is a modal rather than a picture on every row: a segment can name
  // thirty transmog sources and the tables behind one of them are the game's largest. Closed,
  // this costs a reader nothing at all.
  it("asks the game nothing until a row is clicked", () => {
    const { loadAppearance, loadGallery, made } = view({ showing: null });
    expect(loadAppearance).not.toHaveBeenCalled();
    expect(loadGallery).not.toHaveBeenCalled();
    expect(made.count).toBe(0);
  });

  // And what it does when one is: the item is resolved to the look it carries, that look is
  // drawn, and the `.glb` that came back is what goes on the stage.
  it("resolves the item and puts what came back on the stage", async () => {
    const { loadAppearance, loadGallery, shown } = view();
    await waitFor(() => expect(shown).toEqual(["a body wearing it"]));
    expect(loadAppearance).toHaveBeenCalledWith([101]);
    // The three numbers a render is asked for by, out of the hop rather than out of the segment
    // — a segment has none of them.
    expect(loadGallery).toHaveBeenCalledWith([
      { displayInfoId: 900012, displayType: 3, inventoryType: 3 },
    ]);
  });

  it("names the item it is showing", async () => {
    view();
    expect(await screen.findByText("Wanderer's Mantle")).toBeTruthy();
  });

  // Turning it is the point, so the reader is told — but only once there is something to turn.
  it("says how to turn it once there is something on the stage", async () => {
    view();
    expect(await screen.findByText(/Drag to turn it/)).toBeTruthy();
  });

  // An item the game says nothing about is an ordinary answer rather than a failure: the game
  // withholds what it has not shipped, and plenty of items carry no appearance at all. What it
  // must not do is leave an empty pane and a hint about dragging it.
  it("says so for an item that resolves to no look", async () => {
    view({ appearances: {} });
    await waitFor(() => expect(screen.queryByText(/Drag to turn it/)).toBeNull());
    expect(document.querySelector(".appearance-stage")?.getAttribute("data-state"))
      .toBe("empty");
  });

  // The same for a look this install can draw nothing for, which is the other half of the
  // chain and answers `null` rather than being absent.
  it("says so for a look the install can draw nothing for", async () => {
    view({
      models: (pieces) => ({
        models: pieces.map((piece) => ({
          displayInfoId: piece.displayInfoId, kind: "worn" as const, model: null,
        })),
      }),
    });
    await waitFor(() => expect(
      document.querySelector(".appearance-stage")?.getAttribute("data-state"),
    ).toBe("empty"));
  });

  // A machine with no working 3D — a remote desktop, a virtual machine, a driver the browser
  // has blocklisted — is told so rather than shown a blank rectangle for ever.
  it("says why when the machine cannot draw at all", async () => {
    render(
      <AppearanceModal
        showing={{ itemId: 101, name: "Wanderer's Mantle" }}
        onClose={() => {}}
        loadAppearance={() => Promise.resolve({ appearances: { 101: SHOULDERS } })}
        loadGallery={(pieces) => Promise.resolve({
          models: pieces.map((piece) => ({
            displayInfoId: piece.displayInfoId, kind: "worn" as const, model: model("a body"),
          })),
        })}
        createStage={() => { throw new Error("WebGL is not available."); }}
      />,
    );
    expect(await screen.findByText("WebGL is not available.")).toBeTruthy();
  });

  // One graphics context however many rows a reader clicks through. A browser hands out about
  // sixteen and then starts taking back the oldest, so a modal that made one per opening would
  // work for a while and then start showing black.
  it("makes one stage however many appearances are opened", async () => {
    const { rendered, made, shown, ...rest } = view();
    await waitFor(() => expect(shown).toHaveLength(1));

    for (const itemId of [102, 103, 104]) {
      rendered.rerender(
        <AppearanceModal
          showing={{ itemId, name: `Item ${itemId}` }}
          onClose={() => {}}
          loadAppearance={() => Promise.resolve({ appearances: { [itemId]: SHOULDERS } })}
          loadGallery={(pieces) => Promise.resolve({
            models: pieces.map((piece) => ({
              displayInfoId: piece.displayInfoId, kind: "worn" as const, model: model("another"),
            })),
          })}
          createStage={rest.createStage}
        />,
      );
      await waitFor(() => expect(shown.length).toBeGreaterThan(1));
    }
    expect(made.count).toBe(1);
  });

  // And it is given back when the modal goes away, rather than left running with nothing
  // pointing at it.
  it("gives the context back when it unmounts", async () => {
    const { rendered, made, shown } = view();
    await waitFor(() => expect(shown).toHaveLength(1));
    rendered.unmount();
    expect(made.disposed).toBe(1);
  });
});
