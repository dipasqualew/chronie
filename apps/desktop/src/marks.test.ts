import { describe, expect, it } from "vitest";

import {
  NO_MARK_FILTER, choiceOf, indexMarks, markFacets, markWords, marksNarrow, sameKey,
  survivesMarks, tagChoices, tagLabel, tokenOf,
} from "./marks";
import type { MarkSubjectKind, TransmogMark, TransmogTag } from "./types";

const mark = (
  kind: MarkSubjectKind,
  id: number,
  fields: Partial<Omit<TransmogMark, "kind" | "id">> = {},
): TransmogMark => ({ kind, id, favourite: false, tags: [], ...fields });

const tag = (key: string, value: string | null = null): TransmogTag => ({ key, value });

/** The index a payload of these marks reads as, and the ids a browser would ask it about. */
const indexOf = (marks: TransmogMark[]) => indexMarks({ marks });

describe("finding what a reader said about one thing", () => {
  it("keeps a set and a look of the same number apart", () => {
    const index = indexOf([
      mark("set", 1834, { favourite: true }),
      mark("appearance", 1834, { tags: [tag("wishlist")] }),
    ]);

    expect(index.of("set", 1834)?.favourite).toBe(true);
    expect(index.of("appearance", 1834)?.favourite).toBe(false);
    expect(index.of("appearance", 1834)?.tags).toEqual([tag("wishlist")]);
  });

  // Absent rather than an empty mark, which is what the two tables store and what every
  // filter here reads: "not starred" and "never touched" are the same answer.
  it("says nothing at all about a subject nobody has touched", () => {
    expect(indexOf([mark("set", 1)]).of("set", 2)).toBeUndefined();
    expect(indexMarks(null).of("set", 1)).toBeUndefined();
    expect(indexMarks(null).count).toBe(0);
  });

  it("counts the subjects carrying anything", () => {
    expect(indexOf([mark("set", 1), mark("set", 2), mark("appearance", 1)]).count).toBe(3);
  });
});

describe("a key that was typed twice", () => {
  it("is one tag however it was capitalised", () => {
    expect(sameKey("Faction", "faction")).toBe(true);
    expect(sameKey("off hand", "OFF HAND")).toBe(true);
    expect(sameKey("faction", "fashion")).toBe(false);
  });
});

describe("what a tag reads as", () => {
  it("prints a label as itself and a property as a pair", () => {
    expect(tagLabel(tag("wishlist"))).toBe("wishlist");
    expect(tagLabel(tag("faction", "horde"))).toBe("faction: horde");
  });

  // The one case where an empty string would be indistinguishable from a label on screen,
  // which is why the backend refuses to store one at all.
  it("prints a property whose value is only spaces as the pair it is", () => {
    expect(tagLabel(tag("faction", " "))).toBe("faction:  ");
  });
});

describe("carrying a choice through a select", () => {
  it("survives a round trip whatever the key and value hold", () => {
    for (const [key, value] of [
      ["wishlist", null],
      ["faction", "horde"],
      // The characters an obvious separator would have broken on — the colon a chip prints
      // between the two halves, and the equals a query string would have used. None of them
      // can break a tab, because `marks::clean_key` leaves no key or value holding one.
      ["worn by", "the: alt = 2"],
      ["a=b", "c:d=e"],
    ] as Array<[string, string | null]>) {
      expect(choiceOf(tokenOf(key, value))).toEqual({ key, value });
    }
  });

  it("reads an empty token as no tag chosen at all", () => {
    expect(choiceOf("")).toBeNull();
  });
});

describe("the tags a picker offers", () => {
  const marks = [
    mark("set", 1, { tags: [tag("faction", "horde"), tag("wishlist")] }),
    mark("set", 2, { tags: [tag("Faction", "alliance")] }),
    mark("set", 3, { tags: [tag("faction", "horde")] }),
    // The other kind's tags are somebody else's question and must not leak in.
    mark("appearance", 1, { tags: [tag("hidden")] }),
  ];

  it("offers a key once and then each value under it", () => {
    const choices = tagChoices(indexOf(marks), "set", [1, 2, 3]);

    expect(choices.map((one) => one.label)).toEqual([
      "faction", "faction: alliance", "faction: horde", "wishlist",
    ]);
  });

  // A key nobody ever wrote a value against is one question, not two: "wishlist" and
  // "wishlist, whatever the value" are the same set of sets.
  it("offers no value row for a key only ever used as a label", () => {
    const choices = tagChoices(indexOf(marks), "set", [1, 2, 3]);
    const wishlist = choices.filter((one) => one.key === "wishlist");

    expect(wishlist).toHaveLength(1);
    expect(wishlist[0]!.value).toBeNull();
  });

  it("keeps the other kind of subject's tags out of it", () => {
    const forSets = tagChoices(indexOf(marks), "set", [1, 2, 3]);
    const forLooks = tagChoices(indexOf(marks), "appearance", [1]);

    expect(forSets.map((one) => one.key)).not.toContain("hidden");
    expect(forLooks.map((one) => one.label)).toEqual(["hidden"]);
  });

  it("asks nothing about the subjects it was not given", () => {
    expect(tagChoices(indexOf(marks), "set", [2])).toHaveLength(2);
    expect(tagChoices(indexOf(marks), "set", [])).toEqual([]);
  });

  it("offers one row for a key spelled two ways", () => {
    const keys = tagChoices(indexOf(marks), "set", [1, 2, 3])
      .filter((one) => one.value === null)
      .map((one) => one.key);

    expect(keys).toEqual(["faction", "wishlist"]);
  });
});

describe("what a mark filter leaves", () => {
  const starred = mark("set", 1, { favourite: true, tags: [tag("faction", "horde")] });
  const tagged = mark("set", 2, { tags: [tag("faction", "alliance")] });
  const labelled = mark("set", 3, { tags: [tag("faction")] });

  it("leaves everything alone until it is asked something", () => {
    expect(marksNarrow(NO_MARK_FILTER)).toBe(false);
    expect(survivesMarks(undefined, NO_MARK_FILTER)).toBe(true);
    expect(survivesMarks(starred, NO_MARK_FILTER)).toBe(true);
  });

  it("knows when it is narrowing", () => {
    expect(marksNarrow({ favourite: true, tag: "" })).toBe(true);
    expect(marksNarrow({ favourite: false, tag: "wishlist" })).toBe(true);
  });

  it("keeps only the starred when asked for favourites", () => {
    const filter = { favourite: true, tag: "" };

    expect(survivesMarks(starred, filter)).toBe(true);
    expect(survivesMarks(tagged, filter)).toBe(false);
    expect(survivesMarks(undefined, filter)).toBe(false);
  });

  // The choice a reader makes when they want a whole key: a label and a property alike, which
  // is the one place `null` means something different on a choice than it does on a tag.
  it("takes every value under a key, and the bare label too", () => {
    const filter = { favourite: false, tag: tokenOf("faction", null) };

    expect(survivesMarks(starred, filter)).toBe(true);
    expect(survivesMarks(tagged, filter)).toBe(true);
    expect(survivesMarks(labelled, filter)).toBe(true);
    expect(survivesMarks(undefined, filter)).toBe(false);
  });

  it("takes one value when one value is asked for", () => {
    const filter = { favourite: false, tag: tokenOf("faction", "horde") };

    expect(survivesMarks(starred, filter)).toBe(true);
    expect(survivesMarks(tagged, filter)).toBe(false);
    // A bare label is not the value "horde", however the key matches.
    expect(survivesMarks(labelled, filter)).toBe(false);
  });

  it("matches a key and a value without regard to case", () => {
    const filter = { favourite: false, tag: tokenOf("FACTION", "HORDE") };

    expect(survivesMarks(starred, filter)).toBe(true);
  });

  it("asks both questions at once", () => {
    const filter = { favourite: true, tag: tokenOf("faction", "alliance") };

    expect(survivesMarks(starred, filter)).toBe(false);
    expect(survivesMarks(tagged, filter)).toBe(false);
    expect(survivesMarks(
      mark("set", 4, { favourite: true, tags: [tag("faction", "alliance")] }),
      filter,
    )).toBe(true);
  });
});

describe("what a mark adds to the search box", () => {
  it("gives up both halves of a property and the key of a label", () => {
    expect(markWords(mark("set", 1, { tags: [tag("Faction", "Horde"), tag("Wishlist")] })))
      .toBe("faction horde wishlist");
  });

  it("gives a starred thing a word somebody could actually type", () => {
    expect(markWords(mark("set", 1, { favourite: true }))).toBe("favourite");
  });

  it("says nothing about a subject nobody has touched", () => {
    expect(markWords(undefined)).toBe("");
    expect(markWords(mark("set", 1))).toBe("");
  });
});

describe("what a mark adds to the terms the search box reads", () => {
  // The reason a tag was ever a key and a value: "horde" typed as a word finds the Horde's own
  // collections too, and `faction:horde` is the reader saying they meant the thing they filed.
  it("gives a property its value and a label none", () => {
    expect(markFacets(mark("set", 1, { tags: [tag("faction", "horde"), tag("wishlist")] })))
      .toEqual([{ key: "faction", value: "horde" }, { key: "wishlist", value: "" }]);
  });

  // The reader's own spelling, because it is theirs and it is what the chip prints. Whether
  // "Faction" answers `faction:` is settled where the term is matched, not here.
  it("keeps a key exactly as it was typed", () => {
    expect(markFacets(mark("set", 1, { tags: [tag("Faction", "Horde")] })))
      .toEqual([{ key: "Faction", value: "Horde" }]);
  });

  // A star is a checkbox above the list rather than a word under a key, and the box beside it
  // already reads it as one of the words — see `markWords`.
  it("says nothing under a name about a star", () => {
    expect(markFacets(mark("set", 1, { favourite: true }))).toEqual([]);
  });

  it("says nothing at all about a subject nobody has touched", () => {
    expect(markFacets(undefined)).toEqual([]);
    expect(markFacets(mark("set", 1))).toEqual([]);
  });
});
