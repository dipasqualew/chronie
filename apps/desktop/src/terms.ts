/**
 * `colour:brown`, and the rest of what a reader is allowed to ask a search box.
 *
 * Every browser in the transmog view has the same box over it, and until now the whole of what a
 * reader could type into it was words: the row was flattened into one string — see any of the
 * three `searchable` functions — and a word had to be somewhere in it. That is the right thing
 * for a name and the wrong thing for everything else on the row. Typing "brown" finds a look
 * measured to be brown *and* the Brownhide Vest; typing "horde" finds what somebody tagged
 * `faction: horde` and also every set out of the Horde's own collection; and there is no way at
 * all to ask for two of a reader's own tags at once, because the picker beside the box holds one.
 *
 * So a search is words **and** terms. A word is what it always was, matched against everything the
 * row says. A term is `key:value`, and it is matched against the row's [`Facet`]s — the things the
 * row says *under a name*. What is a facet is decided where the facts are: `markFacets` for what
 * the reader typed, `qualityFacets` for what the artwork was measured to be, and a handful in each
 * browser for what the game states. Terms narrow together, so `colour:brown size:large
 * faction:horde` is one question and the dropdown could never have been.
 *
 * Three things about the syntax are deliberate, and all three are because a reader types what they
 * are looking at rather than what a grammar wants:
 *
 * - **A chip prints `faction: horde` and that is a legal thing to type.** It parses as the term
 *   `faction:` — any value under the key — and the bare word "horde", which together narrow to
 *   very nearly what the exact term would. Nobody has to notice the space is meaningful.
 * - **A value with a space in it is quoted**, `colour:"dark red"`, which is what [`termText`]
 *   writes when a chip is clicked. Unquoted, "dark" is the term and "red" is a word, which again
 *   is nearly the same answer — so a reader who never meets a quotation mark is not punished.
 * - **A term nothing carries matches nothing**, rather than being ignored as a typo. `size:huge`
 *   leaving an empty list is the list saying the store holds no huge anything, which is true and
 *   is what was asked.
 */

/**
 * One thing a row says under a name a reader can type.
 *
 * The key is what goes before the colon and the value is what a facet has to contain. A value of
 * `""` is a tag that is a label rather than a property — the key was the whole of what was said —
 * and it is why `wishlist:` matches one and `wishlist:soon` does not.
 */
export interface Facet {
  key: string;
  value: string;
}

/** One thing asked of a row, out of a search box. A `value` of `""` is "under this key at all". */
export interface Term {
  key: string;
  value: string;
}

/** A search box, read: the bare words, and the terms. Both lowercased. */
export interface Query {
  words: string[];
  terms: Term[];
}

/** What an empty box comes to, and what a filter asked nothing leaves the list alone for. */
export const ASKED_NOTHING: Query = { words: [], terms: [] };

/** Whether anything at all was typed, which is what lets a filter skip building a row's words. */
export function asksAnything(query: Query): boolean {
  return query.words.length > 0 || query.terms.length > 0;
}

/**
 * What the box says, as words and terms.
 *
 * Lowercased here, once, rather than at every comparison downstream: a page of a hundred rows is
 * re-filtered on every keystroke and the query is the one thing in that loop that does not change.
 * A token with a colon anywhere but at its start is a term — `:foo` is a word, because a key of
 * nothing is not a question.
 */
export function parseQuery(search: string): Query {
  const words: string[] = [];
  const terms: Term[] = [];
  for (const token of tokens(search.toLowerCase())) {
    const colon = token.indexOf(":");
    if (colon > 0) terms.push({ key: token.slice(0, colon), value: token.slice(colon + 1) });
    else words.push(token);
  }
  return { words, terms };
}

/**
 * The box split into tokens, with quoted runs held together and the quotation marks dropped.
 *
 * A single pass rather than a regular expression, because the thing being handled is exactly the
 * one case a split on whitespace gets wrong: `colour:"dark red"` is one token and the quotes are
 * punctuation rather than characters anybody measured a colour with.
 */
function tokens(search: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoting = false;
  for (const char of search) {
    if (char === "\"") {
      quoting = !quoting;
      continue;
    }
    if (!quoting && /\s/.test(char)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Whether every bare word is somewhere in what the row says.
 *
 * Every word rather than the phrase, which is what all three browsers already did: "plate cata"
 * finds what neither word finds alone, and a reader narrowing a list of thousands does not know
 * what order the row happens to write its facts in.
 *
 * @param said Everything the row says, joined and already lowercased.
 */
export function matchesWords(words: string[], said: string): boolean {
  return words.every((word) => said.includes(word));
}

/**
 * Whether every term is answered by one of the row's facets.
 *
 * The value is contained rather than equal, for the reason the words above are: `class:mage`
 * should find the set labelled "Mage & Warlock", and somebody halfway through typing
 * `faction:hor` should be watching the list narrow rather than sitting at nothing until the last
 * letter. Several facets can share a key — a set has a class per alternate and a look has two
 * colours — and one of them answering is the key answering.
 */
export function matchesTerms(terms: Term[], facets: Facet[]): boolean {
  return terms.every((term) => facets.some((facet) =>
    facet.key.toLowerCase() === term.key && facet.value.toLowerCase().includes(term.value)));
}

/**
 * A key and a value as the term that asks for them, which is what a clicked chip types.
 *
 * Quoted where either half holds a space, because that is the half of the syntax a reader should
 * never have to work out for themselves: they clicked "dark red" and what appears in the box has
 * to be a thing that finds it again.
 */
export function termText(key: string, value: string | null): string {
  return `${quoted(key)}:${quoted(value ?? "")}`;
}

function quoted(text: string): string {
  return /\s/.test(text) ? `"${text}"` : text;
}

/**
 * The box with one more term in it, or unchanged where it already asks that.
 *
 * Added rather than replacing, because narrowing is the point: a reader who clicks brown and then
 * clicks large wants the brown large ones. Clicking the same chip twice is not an instruction to
 * ask twice, so a term already asked leaves the box exactly as it is — which also keeps a click on
 * a chip from moving the cursor in a box somebody is typing in.
 */
export function withTerm(search: string, term: string): string {
  const wanted = parseQuery(term).terms[0];
  const already = parseQuery(search).terms;
  if (wanted && already.some((one) => one.key === wanted.key && one.value === wanted.value)) {
    return search;
  }
  const trimmed = search.trim();
  return trimmed ? `${trimmed} ${term}` : term;
}
