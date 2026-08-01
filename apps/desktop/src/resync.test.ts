/**
 * What the screen is allowed to say about a walk somebody asked for.
 *
 * `resyncOf` is pure and takes the requests as an argument, so nothing here mocks anything — a
 * list of request literals and a pinned `now` are the whole world these rules live in. What is
 * worth testing is not the string building: it is that the button goes quiet while an ask is
 * outstanding, and that each sentence is reckoned from the moment it claims to be about.
 */

import { describe, expect, it } from "vitest";

import { resyncOf } from "./resync";

import type { CensusRequest } from "./bindings";

/** The moment every sentence below is reckoned from, so "2 days ago" is a fact and not a clock. */
const NOW = 1_785_000_000;

const DAY = 86_400;

/** One ask, spelled out only where a case actually depends on the field. */
const asked = (fields: Partial<CensusRequest> = {}): CensusRequest => ({
  id: 1,
  domains: [],
  createdAt: NOW - 2 * DAY,
  walked: [],
  ...fields,
});

describe("nothing has ever been asked for", () => {
  // There is no history to draw, only the offer — and a sentence about a request that was never
  // made would be the screen reporting on something that did not happen.
  it("says nothing, and leaves the offer standing", () => {
    expect(resyncOf(null, NOW)).toEqual({ state: "none", sentence: "", canAsk: true });
    expect(resyncOf([], NOW)).toEqual({ state: "none", sentence: "", canAsk: true });
  });
});

describe("an ask nobody has logged in for yet", () => {
  const waiting = () => resyncOf([asked()], NOW);

  // The state the whole affordance exists to explain. The addon reads the request at load and
  // answers at logout, so the screen has to talk about the next login rather than about now.
  it("says when it will be picked up, and how long ago it was asked for", () => {
    const { state, sentence } = waiting();

    expect(state).toBe("waiting");
    expect(sentence).toContain("2 days ago");
    expect(sentence).toContain("log in");
  });

  // The module's own claim, and the one thing here that is not decoration: a second ask is a
  // second row, a second entry in the addon's folder and exactly the same walk. The button going
  // quiet is the plainest way of saying the first one has not been collected yet.
  it("refuses a second ask while the first is outstanding", () => {
    expect(waiting().canAsk).toBe(false);
  });
});

describe("an ask the addon has answered", () => {
  // `appliedAt` and `createdAt` are deliberately different moments: one is when somebody pressed
  // the button, the other is when the walk in the game ended. The sentence is about the walk, so
  // a reader who asked last week and played yesterday is told about yesterday.
  it("names when the walk ended rather than when it was asked for", () => {
    const { state, sentence, canAsk } = resyncOf(
      [asked({ outcome: "walked", createdAt: NOW - 7 * DAY, appliedAt: NOW - DAY })],
      NOW,
    );

    expect(state).toBe("walked");
    expect(sentence).toContain("Walked yesterday");
    expect(sentence).not.toContain("7 days ago");
    expect(canAsk).toBe(true);
  });

  it("lists what was walked", () => {
    const { sentence } = resyncOf(
      [
        asked({
          outcome: "walked",
          appliedAt: NOW - 2 * DAY,
          walked: ["mounts", "appearances"],
        }),
      ],
      NOW,
    );

    expect(sentence).toContain("mounts, appearances");
  });

  // An addon that walked something without saying what still walked it. A dangling dash before
  // an empty list would read as a sentence that lost its end.
  it("leaves the list out of the sentence when the addon named nothing", () => {
    const { sentence } = resyncOf([asked({ outcome: "walked", appliedAt: NOW - 2 * DAY })], NOW);

    expect(sentence).toContain("Walked 2 days ago.");
    expect(sentence).not.toContain("—");
  });
});

describe("an ask the addon could not walk", () => {
  // The one failure worth a sentence of its own. Everything else on the screen would go on
  // reading as though a walk had happened, when the addon in the game answered for none of it —
  // which is what a targeted probe from a newer app against an older client build produces.
  it("says the client answers for none of what was named, and still offers another go", () => {
    const { state, sentence, canAsk } = resyncOf(
      [asked({ outcome: "unknown", appliedAt: NOW - DAY, domains: ["wardrobes"] })],
      NOW,
    );

    expect(state).toBe("unknown");
    expect(sentence).toContain("nothing it could walk");
    // Reckoned from when it was asked for, because there is no walk to date it from.
    expect(sentence).toContain("2 days ago");
    expect(canAsk).toBe(true);
  });
});

describe("several asks", () => {
  // They arrive newest first, and the newest is the only one worth a sentence: an older ask that
  // was answered says nothing a reader wants once a newer one is outstanding — and reading the
  // wrong end of the list would leave the button offered while a walk was already pending.
  it("describes the newest and ignores what came before it", () => {
    const { state, canAsk } = resyncOf(
      [
        asked({ id: 2, createdAt: NOW - DAY }),
        asked({ id: 1, createdAt: NOW - 7 * DAY, outcome: "walked", appliedAt: NOW - 6 * DAY }),
      ],
      NOW,
    );

    expect(state).toBe("waiting");
    expect(canAsk).toBe(false);
  });
});
