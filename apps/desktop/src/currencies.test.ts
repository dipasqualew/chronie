import { describe, expect, it, vi } from "vitest";

import { createCurrencyIcons } from "./currencies";
import type { IconsPayload } from "./types";

const HONOR = 1792;
const VALORSTONES = 3008;
/** A currency the game names no picture for, which several hundred of the real table's rows are. */
const TALLY = 4001;

const PICTURE = "data:image/png;base64,honor";

/**
 * A book over an install that can draw whatever `held` names, with the batch held open so a
 * test can see what one request ended up carrying.
 */
function book(held: Record<number, string>, load?: (ids: number[]) => Promise<IconsPayload>) {
  const run: Array<() => void> = [];
  const asked = vi.fn(load ?? ((ids: number[]) => Promise.resolve({
    icons: Object.fromEntries(
      ids.filter((id) => held[id]).map((id) => [String(id), held[id]!]),
    ),
  })));
  const icons = createCurrencyIcons({ load: asked, schedule: (send) => run.push(send) });
  const flush = async (): Promise<void> => {
    for (const send of run.splice(0)) send();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { icons, asked, flush };
}

describe("createCurrencyIcons", () => {
  it("answers with the picture the game draws a currency with", async () => {
    const shown = book({ [HONOR]: PICTURE });
    shown.icons.learn([HONOR], () => {});

    await shown.flush();

    expect(shown.icons.icon(HONOR)).toBe(PICTURE);
  });

  /** A table of eight currencies is eight rows each asking for itself, and one table read. */
  it("sends one request for everything that asked in the same turn", async () => {
    const shown = book({ [HONOR]: PICTURE, [VALORSTONES]: "data:image/png;base64,valor" });
    shown.icons.learn([HONOR], () => {});
    shown.icons.learn([VALORSTONES], () => {});
    shown.icons.learn([HONOR], () => {});

    await shown.flush();

    expect(shown.asked).toHaveBeenCalledTimes(1);
    expect(shown.asked).toHaveBeenCalledWith([HONOR, VALORSTONES]);
  });

  /** Which is the point of the book: a roster of ten alts holds the same Honor ten times. */
  it("asks about a currency once, however many characters hold it", async () => {
    const shown = book({ [HONOR]: PICTURE });
    shown.icons.learn([HONOR], () => {});
    await shown.flush();

    shown.icons.learn([HONOR, VALORSTONES], () => {});
    await shown.flush();

    expect(shown.asked).toHaveBeenCalledTimes(2);
    expect(shown.asked).toHaveBeenLastCalledWith([VALORSTONES]);
  });

  /** To everything on screen, because whoever asked is not necessarily who is waiting. */
  it("tells every listener when an answer lands", async () => {
    const shown = book({ [HONOR]: PICTURE });
    const first = vi.fn();
    const second = vi.fn();
    shown.icons.learn([HONOR], first);
    shown.icons.learn([HONOR], second);

    await shown.flush();

    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("stops telling a listener that has gone away", async () => {
    const shown = book({ [HONOR]: PICTURE });
    const gone = vi.fn();
    shown.icons.learn([HONOR], gone)();

    await shown.flush();

    expect(gone).not.toHaveBeenCalled();
  });

  /**
   * A currency the game draws nothing for is remembered as such: the backend leaves it out of
   * the answer, and going back for it on every redraw would be a request that can never succeed.
   */
  it("does not ask twice about a currency the game has no picture for", async () => {
    const shown = book({ [HONOR]: PICTURE });
    shown.icons.learn([TALLY], () => {});
    await shown.flush();

    shown.icons.learn([TALLY], () => {});
    await shown.flush();

    expect(shown.asked).toHaveBeenCalledTimes(1);
    expect(shown.icons.icon(TALLY)).toBeUndefined();
  });

  /**
   * A failure is the whole game folder being unreadable — not chosen yet, or mid-patch — which
   * is worth another try when the reader opens the next character rather than never again.
   */
  it("forgets a request that failed, so the next character asks again", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("no game folder")));
    const shown = book({}, failing);
    shown.icons.learn([HONOR], () => {});
    await shown.flush();

    shown.icons.learn([HONOR], () => {});
    await shown.flush();

    expect(failing).toHaveBeenCalledTimes(2);
  });

  /** Nothing to ask about is not a request: a character holding no currencies sends none. */
  it("sends nothing when nothing was asked about", async () => {
    const shown = book({ [HONOR]: PICTURE });
    shown.icons.learn([], () => {});

    await shown.flush();

    expect(shown.asked).not.toHaveBeenCalled();
  });
});
