import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useModalDialog } from "./dialog";
import type { ModelStage } from "./modelViewer";
import { usePaneStage } from "./stage";
import type { MakeStage, PaneStage } from "./stage";

afterEach(cleanup);

/** One stage's whole life, as a test can see it from outside. */
interface StageLife {
  /** The pictures that went on it, in order. */
  shown: string[];
  cameras: number;
  disposed: number;
}

/** A `.glb` as the fakes below read it: a sentence, so a failure says which picture it was. */
const encode = (picture: string): Uint8Array => new TextEncoder().encode(picture);

/**
 * The stages a test hands out — a record for every one ever made, rather than one shared fake.
 *
 * A record each, because what is claimed here is about *which* renderer something happened to.
 * "Nothing is drawn on a stage that has been given back" cannot be told from a single object
 * standing in for every stage at once: it would answer the same whether the pane drew on the stage
 * it disposed or on the one that replaced it. `drawnDead` is that failure itself, recorded where
 * the browser records nothing at all — a discarded WebGL context throws no error, it just stops
 * being a picture — and every test below asserts it stayed empty.
 *
 * `slowly` holds the making of a stage open, which is the only way into the window this module
 * exists for: three.js and its loader are imported on demand, so there is a real gap between a pane
 * asking for a picture and there being a renderer, and a pane can go away inside it.
 */
function fakeStages({ slowly = false }: { slowly?: boolean } = {}) {
  const lives: StageLife[] = [];
  const drawnDead: string[] = [];
  const waiting: Array<() => void> = [];

  const createStage: MakeStage = () => {
    const life: StageLife = { shown: [], cameras: 0, disposed: 0 };
    lives.push(life);
    const stage: ModelStage = {
      show: (glb) => {
        const picture = new TextDecoder().decode(glb);
        if (life.disposed > 0) drawnDead.push(picture);
        life.shown.push(picture);
        return Promise.resolve();
      },
      resetCamera: () => {
        life.cameras += 1;
      },
      dispose: () => {
        life.disposed += 1;
      },
    };
    if (!slowly) return stage;
    return new Promise<ModelStage>((settle) => {
      waiting.push(() => settle(stage));
    });
  };

  return {
    lives,
    drawnDead,
    createStage,
    /** Lets every stage that is still being made arrive. */
    arrive: () => {
      for (const settle of waiting.splice(0)) settle();
    },
    shown: () => lives.flatMap((life) => life.shown),
    disposed: () => lives.reduce((count, life) => count + life.disposed, 0),
  };
}

/**
 * A pane that draws from an effect, which is what both real ones do.
 *
 * Drawing from the effect rather than from the test is what makes the Strict Mode case honest: the
 * draw is already in flight when React tears the effect down, which is the arrangement that used to
 * leave a renderer running with nothing pointing at it. `picture` left off is a pane that has
 * nothing to draw yet, so a test can drive `show` itself.
 */
function Pane({
  createStage,
  seen,
  drew,
  picture,
}: {
  createStage: MakeStage;
  seen: PaneStage[];
  drew: boolean[];
  picture?: string;
}) {
  const pane = usePaneStage(createStage);
  const box = useRef<HTMLDivElement>(null);
  seen.push(pane);

  useEffect(() => {
    const container = box.current;
    if (!container || picture === undefined) return;
    void pane.show(container, encode(picture)).then((on) => {
      drew.push(on);
    });
  }, [pane, picture, drew]);

  return <div ref={box} />;
}

/** The dialog under a component, driven by the prop the way all four real ones are. */
function Modal({ open }: { open: boolean }) {
  const dialog = useModalDialog(open);
  return <dialog ref={dialog}>what the reader clicked</dialog>;
}

/** What the most recent render was handed, which is what a click would reach. */
function latest<T>(seen: T[]): T {
  const last = seen.at(-1);
  if (last === undefined) throw new Error("The probe never rendered.");
  return last;
}

/**
 * Somewhere for a stage to be made in.
 *
 * The fakes never look at it and `usePaneStage` only hands it on, so a test can make its own rather
 * than digging the pane's own element out of the page.
 */
const somewhere = (): HTMLElement => document.createElement("div");

describe("usePaneStage", () => {
  // The count is the whole point. A browser hands out about sixteen WebGL contexts and then starts
  // silently taking back the oldest, so a pane that made one per picture would draw every one of
  // them correctly and then black out a pane somewhere else in the window.
  it("makes one stage however many pictures are asked for", async () => {
    const stages = fakeStages();
    const seen: PaneStage[] = [];
    render(<Pane createStage={stages.createStage} seen={seen} drew={[]} />);
    const container = somewhere();

    for (const picture of ["a helm", "a robe", "a whole outfit"]) {
      expect(await latest(seen).show(container, encode(picture))).toBe(true);
    }

    expect(stages.lives).toHaveLength(1);
    expect(stages.shown()).toEqual(["a helm", "a robe", "a whole outfit"]);
    expect(stages.drawnDead).toEqual([]);
  });

  it("gives the stage back when the pane goes away", async () => {
    const stages = fakeStages();
    const seen: PaneStage[] = [];
    const shown = render(<Pane createStage={stages.createStage} seen={seen} drew={[]} />);
    await latest(seen).show(somewhere(), encode("a whole outfit"));

    shown.unmount();

    await waitFor(() => expect(stages.disposed()).toBe(1));
  });

  // And a stage still being made when the pane went is given back just the same, which is the
  // reason the promise is what the hook holds rather than the stage. Disposing only what had
  // finished arriving lets a context started inside that window escape with nothing left pointing
  // at it and nothing on screen to say so.
  it("gives back a stage that was still being made when the pane went away", async () => {
    const stages = fakeStages({ slowly: true });
    const seen: PaneStage[] = [];
    const shown = render(<Pane createStage={stages.createStage} seen={seen} drew={[]} />);
    void latest(seen).show(somewhere(), encode("a whole outfit"));

    shown.unmount();
    stages.arrive();

    await waitFor(() => expect(stages.disposed()).toBe(1));
    expect(stages.lives).toHaveLength(1);
  });

  // The other half of the same moment: the pane that asked is gone, the stage it would have drawn
  // on has been disposed, and the honest answer to "is the picture on screen" is no.
  it("says nothing was drawn when the pane went away while the stage was being made", async () => {
    const stages = fakeStages({ slowly: true });
    const seen: PaneStage[] = [];
    const shown = render(<Pane createStage={stages.createStage} seen={seen} drew={[]} />);
    const drawing = latest(seen).show(somewhere(), encode("a whole outfit"));

    shown.unmount();
    stages.arrive();

    expect(await drawing).toBe(false);
    expect(stages.shown()).toEqual([]);
    expect(stages.drawnDead).toEqual([]);
  });

  // React sets an effect up, tears it down and sets it up again to prove the teardown is real, and
  // Strict Mode does it to every effect in the window. A pane drawing from an effect therefore has
  // a draw in flight across a teardown every single time it mounts — so both halves have to hold at
  // once: the picture the abandoned draw was carrying never reaches the disposed renderer, and the
  // renderer that draw made is still given back.
  it("draws nothing on a disposed stage when React sets the effect up twice", async () => {
    const stages = fakeStages();
    const seen: PaneStage[] = [];
    const drew: boolean[] = [];
    const shown = render(
      <StrictMode>
        <Pane createStage={stages.createStage} seen={seen} drew={drew} picture="a whole outfit" />
      </StrictMode>,
    );

    await waitFor(() => expect(drew).toHaveLength(2));
    // One draw answered for and one abandoned, whichever order the two settled in.
    expect(drew.filter((on) => on)).toHaveLength(1);
    expect(stages.drawnDead).toEqual([]);
    expect(stages.shown()).toEqual(["a whole outfit"]);

    shown.unmount();

    // Every stage the two setups made, and there is no third place for one to hide: a context
    // nobody is holding is exactly the leak that costs a picture elsewhere in the window.
    await waitFor(() => expect(stages.disposed()).toBe(stages.lives.length));
  });

  // The button the camera reset lives on is drawn over the picture, so a click on it can land while
  // the stage is still being made or after it turned out it could not be made at all. Neither is a
  // mistake worth an exception in the console.
  it("puts no camera back before there is a stage to put one on", async () => {
    const stages = fakeStages();
    const seen: PaneStage[] = [];
    render(<Pane createStage={stages.createStage} seen={seen} drew={[]} />);

    expect(() => {
      latest(seen).resetCamera();
    }).not.toThrow();
    expect(stages.lives).toHaveLength(0);

    // And it reaches the stage once there is one, so the no-op above is a guard rather than a
    // camera reset that never worked.
    await latest(seen).show(somewhere(), encode("a whole outfit"));
    latest(seen).resetCamera();
    expect(stages.lives[0]?.cameras).toBe(1);
  });
});

/**
 * `showModal` and `close`, as the browser has them and jsdom does not.
 *
 * The stub keeps `open` because `useModalDialog` reads it: the element's own state is what the hook
 * decides from, and a stub that only counted calls would report a second `showModal` as harmless
 * when the browser would have thrown `InvalidStateError` at it and left the modal shut. So a call
 * made in a state the browser would have refused is recorded as refused rather than merely counted,
 * and every test below asserts nothing was.
 */
function stubDialog() {
  const original = {
    showModal: HTMLDialogElement.prototype.showModal,
    close: HTMLDialogElement.prototype.close,
  };
  const calls: string[] = [];
  const refused: string[] = [];

  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    calls.push("showModal");
    if (this.open) refused.push("showModal on a dialog that is already open");
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    calls.push("close");
    if (!this.open) refused.push("close on a dialog that is not open");
    this.open = false;
  };

  return {
    calls,
    refused,
    // jsdom ships neither of these, so what is put back is their absence. Restoring it anyway is
    // what keeps this file's stub from being something the next test to run inherits by accident.
    restore: () => {
      HTMLDialogElement.prototype.showModal = original.showModal;
      HTMLDialogElement.prototype.close = original.close;
    },
  };
}

/** The element the probe drew. A closed dialog is hidden, so it cannot be asked for by role. */
const dialogElement = (): HTMLDialogElement => {
  const found = document.querySelector("dialog");
  if (!found) throw new Error("The probe drew no dialog.");
  return found;
};

describe("useModalDialog", () => {
  let dialogs: ReturnType<typeof stubDialog>;

  beforeEach(() => {
    dialogs = stubDialog();
  });

  afterEach(() => {
    dialogs.restore();
  });

  // `showModal` is what puts an element in the top layer, over its own backdrop, with everything
  // behind it inert and Escape wired up. React has no prop for it, so the prop the app does have
  // has to be turned into these two calls and nothing else.
  it("opens the element with showModal, and closes it when it is not wanted any more", () => {
    const shown = render(<Modal open={false} />);
    expect(dialogs.calls).toEqual([]);

    shown.rerender(<Modal open />);
    expect(dialogs.calls).toEqual(["showModal"]);
    expect(dialogElement().open).toBe(true);

    shown.rerender(<Modal open={false} />);
    expect(dialogs.calls).toEqual(["showModal", "close"]);
    expect(dialogElement().open).toBe(false);
    expect(dialogs.refused).toEqual([]);
  });

  // The reason this is shared rather than four copies of four lines. React sets an effect up, tears
  // it down and sets it up again — Strict Mode does it to every effect in the window — and a second
  // `showModal` on a dialog already showing is an `InvalidStateError` in the console and a modal
  // that does not open.
  it("opens the element once when React sets the effect up twice", () => {
    render(
      <StrictMode>
        <Modal open />
      </StrictMode>,
    );

    expect(dialogs.calls).toEqual(["showModal"]);
    expect(dialogs.refused).toEqual([]);
    expect(dialogElement().open).toBe(true);
  });

  // Escape and a click on the backdrop close a dialog without asking anybody, so the element can be
  // shut while the prop still says open. Closing it again from the effect would fire a second
  // `close` event, and every caller in this app puts its own state back from that event.
  it("never closes a dialog the reader has already closed", () => {
    const shown = render(<Modal open />);
    dialogElement().open = false;

    shown.rerender(<Modal open={false} />);

    expect(dialogs.calls).toEqual(["showModal"]);
    expect(dialogs.refused).toEqual([]);
  });
});
