/**
 * What a reader says about the game's wardrobe, as against what the game says about it.
 *
 * Everything else the transmog view draws is read out of the installed game, so it is the same
 * for everybody on that build. A mark is the one thing on that screen that is theirs: a star,
 * and tags they invented — "wishlist", "faction: horde", "what the alt wears". The storage is
 * `marks.rs` and `0016_transmog_marks.sql`; this is what a mark *means* once it is on screen,
 * and it is where the browsers ask their two questions of one.
 *
 * **A label and a property are one thing**, which is `TransmogTag.value` being nullable and
 * nothing more. A key with a value is a property, a key without one is a label, and both are
 * added by the same form, drawn as the same chip and filtered by the same picker. What that
 * buys is one feature where the issue asked for two; what it costs is remembering that `null`
 * means two different things in the two shapes here — on a [`TransmogTag`] it is "this tag has
 * no value", and on a [`TagChoice`] it is "any value, or none". They are both said out loud
 * where they are declared, because a reader meeting the second one first would guess wrong.
 *
 * The keys collate without case — see the migration — so every comparison of one key against
 * another in this file has to go through [`sameKey`] rather than `===`. A reader who typed
 * "Faction" once and "faction" later has one tag, and a filter that split them in two would
 * show them half of what they marked.
 */

import type { Facet } from "./terms";
import type { MarkSubjectKind, TransmogMark, TransmogMarksPayload, TransmogTag } from "./types";

/** A subject nobody has said anything about, which is nearly all of them. */
export const UNMARKED: TransmogMark = { kind: "set", id: 0, favourite: false, tags: [] };

/**
 * Every mark, indexed by the subject it is against.
 *
 * The payload is a list because that is what the two tables read as; a browser wants a lookup
 * per row it draws, and a page of a hundred looks scanning a list of four hundred marks is
 * forty thousand comparisons per keystroke of the search box.
 */
export interface MarkIndex {
  /** What this reader has said about one subject, or nothing at all. */
  of: (kind: MarkSubjectKind, id: number) => TransmogMark | undefined;
  /** How many subjects carry anything, which is what the browser says it is filtering over. */
  count: number;
}

/** One key of the index: the kind and the id together, because the two countings overlap. */
const at = (kind: MarkSubjectKind, id: number): string => `${kind}:${id}`;

export function indexMarks(payload: TransmogMarksPayload | null): MarkIndex {
  const bySubject = new Map<string, TransmogMark>();
  for (const mark of payload?.marks ?? []) bySubject.set(at(mark.kind, mark.id), mark);
  return {
    of: (kind, id) => bySubject.get(at(kind, id)),
    count: bySubject.size,
  };
}

/** Whether two keys are the same tag, which is `COLLATE NOCASE` in the migration. */
export function sameKey(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** How a tag reads on a chip: the key alone where it is a label, and `key: value` otherwise. */
export function tagLabel(tag: TransmogTag): string {
  return tag.value === null ? tag.key : `${tag.key}: ${tag.value}`;
}

/**
 * One thing the tag picker above a browser can be set to.
 *
 * **A `value` of `null` here means "any value, or none"** — the choice a reader makes when they
 * want everything under a key, however they annotated it. That is deliberately not what `null`
 * means on the tag itself, where it means the tag has no value; a choice of `{ key, value:
 * null }` matches a bare label and a property alike, which is what "faction" as opposed to
 * "faction: horde" is asking for.
 */
export interface TagChoice {
  key: string;
  value: string | null;
  /** What the picker prints. */
  label: string;
  /** What the `<option>` carries, and what the view holds as its state. See [`tokenOf`]. */
  token: string;
}

/**
 * A choice as one string, so that a `<select>` and a piece of React state can carry it.
 *
 * The tab is the separator because a key and a value can hold anything a reader types except
 * whitespace that is not a plain space — `marks::clean_key` splits on whitespace and rejoins
 * with single spaces, so neither half can ever contain one. Anything more clever, a JSON blob
 * or an index into the list, either escapes badly or goes stale the moment an unrelated tag is
 * added somewhere else on the screen.
 */
export function tokenOf(key: string, value: string | null): string {
  return value === null ? key : `${key}\t${value}`;
}

/** The choice a token names, or nothing — which is the picker sitting on "any tag". */
export function choiceOf(token: string): { key: string; value: string | null } | null {
  if (!token) return null;
  const tab = token.indexOf("\t");
  if (tab < 0) return { key: token, value: null };
  return { key: token.slice(0, tab), value: token.slice(tab + 1) };
}

/**
 * Every tag in use against one kind of subject, as the picker offers them.
 *
 * A key that carries values earns a row of its own *and* a row per value: "faction" is how a
 * reader asks for both halves of a pair at once and "faction: horde" is how they ask for one.
 * A key only ever used as a label earns the one row, because "wishlist" and "wishlist, any
 * value" are the same question and offering both is offering a choice that does nothing.
 *
 * Sorted by key and then by value, both without case, so the list is the same list whatever
 * order the tags were invented in. The key printed is the first spelling the payload holds,
 * which is the one the backend stored last — a reader's own most recent correction.
 */
export function tagChoices(index: MarkIndex, kind: MarkSubjectKind, ids: number[]): TagChoice[] {
  const keys = new Map<string, { key: string; values: Map<string, string> }>();
  for (const id of ids) {
    for (const tag of index.of(kind, id)?.tags ?? []) {
      const folded = tag.key.toLowerCase();
      const held = keys.get(folded) ?? { key: tag.key, values: new Map<string, string>() };
      if (tag.value !== null) held.values.set(tag.value.toLowerCase(), tag.value);
      keys.set(folded, held);
    }
  }
  const choices: TagChoice[] = [];
  for (const folded of [...keys.keys()].sort()) {
    const held = keys.get(folded)!;
    choices.push({
      key: held.key,
      value: null,
      label: held.key,
      token: tokenOf(held.key, null),
    });
    for (const value of [...held.values.keys()].sort().map((one) => held.values.get(one)!)) {
      choices.push({
        key: held.key,
        value,
        label: `${held.key}: ${value}`,
        token: tokenOf(held.key, value),
      });
    }
  }
  return choices;
}

/**
 * What a browser is narrowed to beyond what the game says: the star, and one tag.
 *
 * One tag rather than several, because two tags at once is a query language and this is a
 * dropdown. A reader wanting "wishlist and not yet collected" has the free-text search, which
 * reads the tags too — see [`markWords`].
 */
export interface MarkFilter {
  /** Whether only the starred survive. */
  favourite: boolean;
  /** The token of the chosen tag, or `""` for any. See [`tokenOf`]. */
  tag: string;
}

/** A filter narrowing nothing, which is what both browsers open on. */
export const NO_MARK_FILTER: MarkFilter = { favourite: false, tag: "" };

/** Whether the filter would leave the list alone, which is what a count worth drawing is. */
export function marksNarrow(filter: MarkFilter): boolean {
  return filter.favourite || filter.tag !== "";
}

/**
 * Whether one subject's marks survive the filter.
 *
 * A subject nobody has marked survives an idle filter and nothing else, which is why the
 * unmarked case is `undefined` rather than an empty mark: "not starred" and "never touched"
 * filter identically, and only one of them needs a row in the database to say so.
 */
export function survivesMarks(mark: TransmogMark | undefined, filter: MarkFilter): boolean {
  if (filter.favourite && !mark?.favourite) return false;
  const wanted = choiceOf(filter.tag);
  if (!wanted) return true;
  return (mark?.tags ?? []).some((tag) => sameKey(tag.key, wanted.key)
    && (wanted.value === null || tag.value?.toLowerCase() === wanted.value.toLowerCase()));
}

/**
 * What a subject's marks add to what the free-text search reads, lowercased.
 *
 * So that typing "horde" finds what somebody filed under it without going near the picker,
 * which is the same argument the set search already makes for the expansion and the class: a
 * reader types the word they are thinking of, and the box is expected to know about it.
 */
export function markWords(mark: TransmogMark | undefined): string {
  if (!mark) return "";
  const tags = mark.tags.flatMap((tag) => (tag.value === null ? [tag.key] : [tag.key, tag.value]));
  // The word rather than a symbol, because a star is not typeable and "favourite" is what
  // somebody looking for their starred pieces would actually reach for.
  return [...(mark.favourite ? ["favourite"] : []), ...tags].join(" ").toLowerCase();
}

/**
 * And what they add to the terms it reads — one per tag, key and value as they were typed.
 *
 * [`markWords`]'s other half, and the reason a tag was a key and a value in the first place: a
 * label becomes a facet with no value, which is exactly what `wishlist:` asks for and what
 * `wishlist:soon` does not answer. Nothing about the star is here — "starred" is a checkbox above
 * the list rather than a word under a key, and the box beside it already reads [`markWords`].
 */
export function markFacets(mark: TransmogMark | undefined): Facet[] {
  return (mark?.tags ?? []).map((tag) => ({ key: tag.key, value: tag.value ?? "" }));
}
