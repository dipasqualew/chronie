import { describe, expect, it, vi } from "vitest";

import { createPlaceIcons } from "./places";
import type { IconsPayload } from "./types";

const DUNGEON = "Deadmines";
/** An open-world zone, which the game draws no picture for anywhere. */
const ZONE = "Durotar";

const PICTURE = "data:image/png;base64,deadmines";

/**
 * A book over an install that can draw whatever `held` names, with the batch held open so a
 * test can see what one request ended up carrying.
 */
function book(held: Record<string, string>, load?: (places: string[]) => Promise<IconsPayload>) {
  const run: Array<() => void> = [];
  const asked = vi.fn(load ?? ((places: string[]) => Promise.resolve({
    icons: Object.fromEntries(
      places.filter((place) => held[place]).map((place) => [place, held[place]!]),
    ),
  })));
  const icons = createPlaceIcons({ load: asked, schedule: (send) => run.push(send) });
  const flush = async (): Promise<void> => {
    for (const send of run.splice(0)) send();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { icons, asked, flush };
}

describe("createPlaceIcons", () => {
  it("answers with the picture the game draws a dungeon with", async () => {
    const shown = book({ [DUNGEON]: PICTURE });
    shown.icons.learn([DUNGEON], () => {});

    await shown.flush();

    expect(shown.icons.icon(DUNGEON)).toBe(PICTURE);
  });

  /**
   * Which is most of a history rather than the exception: the game draws a picture for a
   * dungeon, a raid and a delve, and none at all for the open world. Going back for one on
   * every redraw would be a request that can never succeed.
   */
  it("does not ask twice about a zone the game has no picture for", async () => {
    const shown = book({ [DUNGEON]: PICTURE });
    shown.icons.learn([ZONE], () => {});
    await shown.flush();

    shown.icons.learn([ZONE], () => {});
    await shown.flush();

    expect(shown.asked).toHaveBeenCalledTimes(1);
    expect(shown.icons.icon(ZONE)).toBeUndefined();
  });

  /** An evening of forty segments in one raid is one request, not forty. */
  it("asks about a place once, however many evenings were spent in it", async () => {
    const shown = book({ [DUNGEON]: PICTURE });
    shown.icons.learn([DUNGEON], () => {});
    await shown.flush();

    shown.icons.learn([DUNGEON, ZONE], () => {});
    await shown.flush();

    expect(shown.asked).toHaveBeenCalledTimes(2);
    expect(shown.asked).toHaveBeenLastCalledWith([ZONE]);
  });

  /**
   * A segment opened before the world finished loading is filed under nothing at all. Asking
   * about it would take up a slot in the book for good and could never come back with
   * anything, because there is no row in any table named "".
   */
  it("sends nothing for a segment filed under no place at all", async () => {
    const shown = book({ [DUNGEON]: PICTURE });
    shown.icons.learn(["", "   "], () => {});

    await shown.flush();

    expect(shown.asked).not.toHaveBeenCalled();
  });

  /**
   * The name is the key on both sides of the bridge, and it crosses untouched — a place whose
   * name carries an apostrophe or a comma is spelled the way the client spelled it.
   */
  it("keys what it answers by the name the segment carries", async () => {
    const awkward = "Ara-Kara, City of Echoes";
    const shown = book({ [awkward]: PICTURE });
    shown.icons.learn([awkward], () => {});

    await shown.flush();

    expect(shown.asked).toHaveBeenCalledWith([awkward]);
    expect(shown.icons.icon(awkward)).toBe(PICTURE);
  });
});
