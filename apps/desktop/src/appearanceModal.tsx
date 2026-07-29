/**
 * One appearance, drawn, on top of whatever the reader was already reading.
 *
 * A segment says a character learned a transmog source and names the item. What that *looks*
 * like is three tables away, and the point of this is that none of them is opened until somebody
 * asks: the modal is closed until a row is clicked, and a segment listing thirty sources costs
 * exactly what it always did until then.
 *
 * **A live pane rather than a gallery tile**, which is the opposite of the choice the wardrobe
 * makes and for the same reason. A gallery is twenty pictures at once, so it is one off-screen
 * context and twenty bitmaps; this is one picture and never more than one, so it can afford the
 * real thing — `modelViewer.ts`, with orbit controls, damping and a reset. Turning it is what
 * the reader came for, and nothing here has to ration contexts to give them that.
 *
 * What it draws is what the wardrobe's gallery draws, through the same command: armour on a
 * body, because a chestpiece is paint on a character and there is no chestpiece, and a weapon
 * or a shield as its own mesh. `gallery.rs` decides which, and this only shows what came back.
 */

import "./appearanceModal.css";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { focusOf } from "./gallery";
import { REASONS, glbBytes } from "./modelPreview";
import type { ModelStage } from "./modelViewer";
import type { GalleryPayload, ItemAppearancesPayload } from "./types";

/** What the modal is showing, or nothing at all when it is closed. */
export interface AppearanceModalState {
  /** The item the segment named, which is all a segment has. */
  itemId: number;
  /** And what it called it, so the modal has a title before any table has been opened. */
  name: string;
}

export interface AppearanceModalProps {
  showing: AppearanceModalState | null;
  onClose: () => void;
  /** The hop from an item id to the look it carries. Asked once per item and then kept. */
  loadAppearance: (itemIds: number[]) => Promise<ItemAppearancesPayload>;
  /** And the picture of that look, which is the same command the wardrobe's gallery uses. */
  loadGallery: (
    pieces: { displayInfoId: number; displayType: number; inventoryType: number }[],
  ) => Promise<GalleryPayload>;
  /**
   * Makes the 3D pane. Passed in because it is the one thing here that needs a graphics card:
   * a machine without working 3D throws, and the reader is told so rather than shown nothing.
   */
  createStage?: (container: HTMLElement) => ModelStage | Promise<ModelStage>;
}

/** What the pane is saying, which is what its `data-state` says and what the note reads. */
interface PaneState {
  state: "loading" | "shown" | "empty";
  note: string;
}

const READING = "Reading what the game draws this with…";

export function AppearanceModal({
  showing,
  onClose,
  loadAppearance,
  loadGallery,
  createStage = lazyStage,
}: AppearanceModalProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState<PaneState>({ state: "loading", note: READING });

  // One stage for as long as the modal is mounted, made the first time something is drawn on
  // it. Each is a graphics context of its own, and a browser hands out only so many — so a
  // reader opening one appearance after another gets the one that is already there.
  const stage = useRef<ModelStage | null>(null);
  const starting = useRef<Promise<ModelStage> | null>(null);
  // Which item the pane is currently answering. A reader clicking through rows faster than the
  // models arrive would otherwise be left looking at whichever finished last.
  const asked = useRef(0);

  // `showModal` and `close` are the dialog's own state and React has no prop for them, so the
  // element is driven here. The reverse direction is `onClose`: Escape closes a dialog without
  // asking anybody, and the browser fires the event either way.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (showing && !element.open) element.showModal();
    if (!showing && element.open) element.close();
  }, [showing]);

  // The context is given back when the modal unmounts and not when it closes. A reader
  // stepping through a segment's transmog opens several in a row, and building a renderer for
  // each of them is the cost this is arranged to avoid.
  useEffect(
    () => () => {
      stage.current?.dispose();
      stage.current = null;
    },
    [],
  );

  const draw = useCallback(
    async (itemId: number, mine: number): Promise<void> => {
      const container = pane.current;
      if (!container) return;
      try {
        const looks = await loadAppearance([itemId]);
        const look = looks.appearances[String(itemId)];
        // Nothing is an ordinary answer: the game withholds what it has not shipped, and plenty
        // of items carry no appearance at all. It is not a failure and does not read as one.
        if (!look) {
          if (mine === asked.current) setSaid({ state: "empty", note: REASONS.unshowable });
          return;
        }

        const page = await loadGallery([
          {
            displayInfoId: look.displayInfoId,
            displayType: look.displayType,
            inventoryType: look.inventoryType,
          },
        ]);
        const drawn = page.models[0];
        const glb = drawn?.model;
        if (!drawn || !glb) {
          if (mine === asked.current) setSaid({ state: "empty", note: REASONS.unshowable });
          return;
        }

        // One stage, and one attempt to make one: two quick clicks would otherwise each start a
        // renderer and the second would be left running with nothing pointing at it.
        starting.current ??= Promise.resolve(createStage(container));
        stage.current = await starting.current;
        // Framed on the part of her the slot is on, out of the same table the thumbnails use.
        // What comes back for a chestpiece is a whole two-metre character with the appearance
        // painted somewhere on her, so a pane that framed all of it showed the reader a woman
        // when they had asked about a helm — and orbited her pelvis while they tried to turn it.
        await stage.current.show(glbBytes(glb), focusOf(look.displayType, drawn.kind));
        if (mine === asked.current) setSaid({ state: "shown", note: "" });
      } catch (error: unknown) {
        // A machine with no working 3D — a remote desktop, a virtual machine, a driver the
        // browser has blocklisted — falls back to a sentence, the same as the outfit pane.
        if (mine === asked.current) setSaid({ state: "empty", note: message(error) });
      }
    },
    [loadAppearance, loadGallery, createStage],
  );

  useEffect(() => {
    if (!showing) return;
    const mine = (asked.current += 1);
    setSaid({ state: "loading", note: READING });
    void draw(showing.itemId, mine);
  }, [showing, draw]);

  return (
    <dialog
      id="appearance-detail"
      aria-labelledby="appearance-detail-title"
      ref={dialog}
      className="appearance-modal"
      onClose={onClose}
    >
      <div className="detail-head">
        <h2 className="detail-title" id="appearance-detail-title">
          {showing?.name ?? ""}
        </h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {/* A figure rather than a bare box: what is in it is a picture of the thing the modal is
          named after, and saying so is what makes it addressable by anything but its class. */}
      <div
        className="appearance-stage"
        data-state={said.state}
        ref={pane}
        role="figure"
        aria-label="Where the appearance is drawn"
      />
      {said.state === "shown" ? (
        // Only once there is something to turn. A hint over an empty pane is an instruction to
        // do a thing that will not work.
        <p className="muted appearance-hint">Drag to turn it. Scroll to zoom.</p>
      ) : (
        <p className="muted appearance-hint">{said.note}</p>
      )}
    </dialog>
  );
}

/**
 * The real stage, loaded the first time a reader asks to see one.
 *
 * three.js and its loader are most of this app's JavaScript, and the same import the wardrobe
 * makes: a reader who never clicks through to a picture never downloads it, and one who has
 * already opened the wardrobe pays nothing here because the module is already in memory.
 */
const lazyStage = (container: HTMLElement): Promise<ModelStage> =>
  import("./modelViewer").then((viewer) =>
    viewer.createModelStage(container, { label: "The appearance, drawn" }),
  );

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
