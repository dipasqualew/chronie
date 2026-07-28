import { describe, expect, it } from "vitest";

import {
  ASKED_NOTHING, asksAnything, matchesTerms, matchesWords, parseQuery, termText, withTerm,
} from "./terms";
import type { Facet, Term } from "./terms";

/** One thing a row says under a name. A value of `""` is a label rather than a property. */
const facet = (key: string, value = ""): Facet => ({ key, value });

/** And one thing asked of it, as a box that had been read would hold it. */
const term = (key: string, value = ""): Term => ({ key, value });

describe("reading a search box", () => {
  it("takes a word nobody put a key on as a word", () => {
    expect(parseQuery("brown plate")).toEqual({ words: ["brown", "plate"], terms: [] });
  });

  it("takes key:value as one thing asked under a name", () => {
    expect(parseQuery("colour:brown")).toEqual({ words: [], terms: [term("colour", "brown")] });
  });

  // Which is "is there one of these at all", and is the only way in to a key a reader has only
  // ever used as a label — they never wrote a value, so there is no value to type.
  it("takes a key with nothing after it as asking for the key at all", () => {
    expect(parseQuery("wishlist:")).toEqual({ words: [], terms: [term("wishlist")] });
  });

  // A chip prints `faction: horde`, space and all, and somebody typing what they are looking at
  // has to land on very nearly what they meant rather than on an error.
  it("reads a chip's own printing as the key and the word beside it", () => {
    expect(parseQuery("faction: horde")).toEqual({ words: ["horde"], terms: [term("faction")] });
  });

  it("holds a quoted value together and keeps the quotation marks out of it", () => {
    expect(parseQuery("colour:\"dark red\""))
      .toEqual({ words: [], terms: [term("colour", "dark red")] });
  });

  // A key of nothing is not a question, and a colon is a character somebody may well be typing
  // for its own sake.
  it("reads a leading colon as a word rather than as a term", () => {
    expect(parseQuery(":horde")).toEqual({ words: [":horde"], terms: [] });
  });

  // Once, here, rather than at every comparison downstream: a page of rows is filtered again on
  // every keystroke and the query is the one thing in that loop that does not change.
  it("folds the case of a key and of a value alike", () => {
    expect(parseQuery("Colour:Dark Plate"))
      .toEqual({ words: ["plate"], terms: [term("colour", "dark")] });
  });

  it("makes nothing at all out of an empty box", () => {
    expect(parseQuery("")).toEqual(ASKED_NOTHING);
    expect(parseQuery("   \t ")).toEqual(ASKED_NOTHING);
  });
});

describe("whether the box was asked anything", () => {
  // What lets a filter skip building a row's words, which is the expensive half of the loop.
  it.each<[string, string, boolean]>([
    ["nothing at all", "", false],
    ["only whitespace", "  ", false],
    ["a word", "brown", true],
    ["a term", "colour:brown", true],
    ["both", "brown size:large", true],
  ])("knows %s for what it is", (_what, search, expected) => {
    expect(asksAnything(parseQuery(search))).toBe(expected);
  });

  it("is nothing asked for the query an untouched box stands for", () => {
    expect(asksAnything(ASKED_NOTHING)).toBe(false);
  });
});

describe("matching the words on a row", () => {
  const said = "stormforged helm head brown large";

  it("wants every word rather than the phrase", () => {
    expect(matchesWords(["storm", "helm"], said)).toBe(true);
    expect(matchesWords(["helm", "storm"], said)).toBe(true);
    expect(matchesWords(["helm", "crown"], said)).toBe(false);
  });

  // So that somebody halfway through a word is watching the list narrow rather than sitting at
  // nothing until the last letter.
  it("takes a word that is only the beginning of one", () => {
    expect(matchesWords(["stormf"], said)).toBe(true);
  });

  it("wants nothing of a row it was asked nothing about", () => {
    expect(matchesWords([], said)).toBe(true);
  });
});

describe("matching what a row says under a name", () => {
  it("answers a term with the facet filed under that key", () => {
    expect(matchesTerms([term("colour", "brown")], [facet("colour", "brown")])).toBe(true);
    expect(matchesTerms([term("size", "brown")], [facet("colour", "brown")])).toBe(false);
  });

  // Contained rather than equal, for the reason a word is: the reader asking for the Mage sets
  // typed the class, and the phrase around it is the game's rather than theirs.
  it("finds a value inside the phrase the game wrote it into", () => {
    expect(matchesTerms([term("class", "mage")], [facet("class", "Mage & Warlock")])).toBe(true);
  });

  it("matches a key the reader capitalised differently from the row", () => {
    expect(matchesTerms([term("faction", "horde")], [facet("Faction", "Horde")])).toBe(true);
  });

  // The half of the syntax the labels need: a tag with no value is the key being the whole of
  // what was said, and a bare key is how a reader asks for one.
  it("takes any value under a key the term named none for", () => {
    expect(matchesTerms([term("wishlist")], [facet("wishlist")])).toBe(true);
    expect(matchesTerms([term("wishlist")], [facet("wishlist", "soon")])).toBe(true);
  });

  it("does not answer a term that named a value with a label carrying none", () => {
    expect(matchesTerms([term("wishlist", "soon")], [facet("wishlist")])).toBe(false);
  });

  // A look is two colours and a set is a class per alternate, so a key is not one answer.
  it("lets one of several facets under a key answer for the key", () => {
    const colours = [facet("colour", "brown"), facet("colour", "gold")];

    expect(matchesTerms([term("colour", "gold")], colours)).toBe(true);
    expect(matchesTerms([term("colour", "blue")], colours)).toBe(false);
  });

  // Terms narrow together, which is the whole of what the dropdown beside the box could not do.
  it("wants every term rather than any of them", () => {
    const measured = [facet("colour", "brown"), facet("size", "large")];

    expect(matchesTerms([term("colour", "brown"), term("size", "large")], measured)).toBe(true);
    expect(matchesTerms([term("colour", "brown"), term("size", "small")], measured)).toBe(false);
  });

  // Rather than ignored as a typo: an empty list is the answer to "how many huge ones are
  // there", and it is the true one.
  it("answers nothing for a key the row does not carry at all", () => {
    expect(matchesTerms([term("size", "huge")], [facet("colour", "brown")])).toBe(false);
    expect(matchesTerms([term("colour", "brown")], [])).toBe(false);
  });

  it("asks nothing of a row when no term was typed", () => {
    expect(matchesTerms([], [])).toBe(true);
  });
});

describe("what a clicked chip types into the box", () => {
  it.each<[string, string, string | null, string]>([
    ["a plain pair", "colour", "brown", "colour:brown"],
    ["a value with a space in it", "colour", "dark red", "colour:\"dark red\""],
    ["a key with a space in it", "worn by", "the alt", "\"worn by\":\"the alt\""],
    ["a label, which has no value at all", "wishlist", null, "wishlist:"],
  ])("writes %s", (_what, key, value, expected) => {
    expect(termText(key, value)).toBe(expected);
  });

  // The whole point of the quoting: a reader clicked "dark red", and what appears in the box has
  // to be a thing that finds it again.
  it("writes a term that reads back as the pair it was given", () => {
    expect(parseQuery(termText("colour", "dark red")).terms)
      .toEqual([term("colour", "dark red")]);
    expect(parseQuery(termText("worn by", "the alt")).terms)
      .toEqual([term("worn by", "the alt")]);
  });
});

describe("adding a term to what is already typed", () => {
  // Narrowing is the point: somebody who clicks brown and then clicks large wants the brown
  // large ones rather than the large ones.
  it("adds to what is there rather than replacing it", () => {
    expect(withTerm("brown", "size:large")).toBe("brown size:large");
    expect(withTerm("colour:brown", "size:large")).toBe("colour:brown size:large");
  });

  it("is the term by itself where the box is empty", () => {
    expect(withTerm("", "colour:brown")).toBe("colour:brown");
    expect(withTerm("   ", "colour:brown")).toBe("colour:brown");
  });

  // Clicking the same chip twice is not an instruction to ask twice — and leaving the box byte
  // for byte alone is what keeps the click from moving the cursor of somebody typing in it.
  it("leaves the box exactly as it is where it already asks that", () => {
    expect(withTerm("plate colour:brown", "colour:brown")).toBe("plate colour:brown");
    expect(withTerm("colour:Brown", "colour:brown")).toBe("colour:Brown");
  });

  it("adds a second value under a key already asked about", () => {
    expect(withTerm("colour:brown", "colour:gold")).toBe("colour:brown colour:gold");
  });
});
