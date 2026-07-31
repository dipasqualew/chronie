import { describe, expect, it } from "vitest";

import { NOTHING_COLLECTED, collectedNote, indexCollected } from "./collected";

import type { CensusReading, CollectedAppearancesPayload } from "./types";

const reading = (over: Partial<CensusReading> = {}): CensusReading => ({
  domain: "appearances",
  // Down permanently, which is the whole shape of this domain: the client answers about the
  // wardrobe through the logged-in character's class filter.
  complete: false,
  revision: 1,
  held: 2,
  observedAt: 2_000_000_100,
  ...over,
});

const payload = (over: Partial<CollectedAppearancesPayload> = {}): CollectedAppearancesPayload => ({
  reading: reading(),
  appearances: [1101, 1102],
  ...over,
});

describe("indexCollected", () => {
  it("says which looks the account has been seen to own", () => {
    const looks = indexCollected(payload());

    expect(looks.has(1101)).toBe(true);
    expect(looks.has(9999)).toBe(false);
    expect(looks.count).toBe(2);
    expect(looks.state).toBe("walked");
  });

  // Nothing is marked either way, and the difference is only in what may be *said*: a browser
  // still waiting for the answer has no idea whether there is a shortfall to announce, and a
  // browser that has been told nobody has walked the wardrobe does.
  it("marks nothing while the answer has not come back", () => {
    expect(indexCollected(null)).toEqual(NOTHING_COLLECTED);
    expect(indexCollected(null).state).toBe("unread");
  });

  it("marks nothing on a database no walk has ever covered", () => {
    const looks = indexCollected(payload({ reading: null, appearances: [] }));

    expect(looks.has(1101)).toBe(false);
    expect(looks.state).toBe("unwalked");
  });

  it("carries the client's own count of the same thing", () => {
    const looks = indexCollected(payload({ reading: reading({ counted: 9 }) }));

    expect(looks.counted).toBe(9);
  });
});

describe("collectedNote", () => {
  it("says so where nothing has walked the wardrobe", () => {
    const looks = indexCollected(payload({ reading: null, appearances: [] }));

    expect(collectedNote(looks)).toContain("Nothing has walked the wardrobe yet");
  });

  // The one that would be a lie rather than a hedge. Until the answer lands there is no known
  // shortfall, and a sentence announcing one for the half-second before it does is a sentence
  // about nothing.
  it("says nothing at all while the answer has not come back", () => {
    expect(collectedNote(indexCollected(null))).toBeNull();
  });

  // The one a reader could not possibly work out and would otherwise be misled by. An unmarked
  // row in a wardrobe reads as "not collected", and on a union reading that is wrong for every
  // look the walking characters' classes were never shown.
  it("says how much the roster has not been able to see", () => {
    const looks = indexCollected(payload({ reading: reading({ counted: 9 }) }));

    expect(collectedNote(looks)).toContain("7 more collected looks");
    expect(collectedNote(looks)).toContain("its own class can wear");
  });

  it("counts one missing look as one look", () => {
    const looks = indexCollected(payload({ reading: reading({ counted: 3 }) }));

    expect(collectedNote(looks)).toContain("1 more collected look than this");
  });

  // A walk that has caught up with the client's own counter has nothing left to hedge, and a
  // hedge nobody ever sees change is how a reader learns to stop reading hedges.
  it.each([
    ["the roster has seen everything the client counts", 2],
    ["the client offers no count at all", null],
  ])("says nothing where %s", (_what, counted) => {
    const looks = indexCollected(payload({ reading: reading({ counted }) }));

    expect(collectedNote(looks)).toBeNull();
  });
});
