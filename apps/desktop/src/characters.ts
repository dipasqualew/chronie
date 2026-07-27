/**
 * Who has been played, and what is known about each of them.
 *
 * The timeline asks "what happened", the ledger asks "which segment"; this one asks "who".
 * A history is nearly always several characters deep and every other view cuts across them —
 * an evening holds three of them, a table row belongs to one and says nothing about the rest
 * of that character's year. This is the one place a character is the subject.
 *
 * The left column is the roster with the numbers that are known about each; picking one fills
 * the right with everything that character has ever done. Those segments are drawn with the
 * same row the timeline unfolds into and open the same detail modal every other view opens,
 * so a segment reads identically wherever it is met.
 *
 * `buildCharacters` is pure — segments and account holdings in, profiles out — which is where
 * the folding rules are tested. The drawing over it is `charactersView.tsx`.
 */

import { highlights } from "./sessions";
import type { Highlight } from "./sessions";
import type { AccountHoldings, CharacterStanding, Segment } from "./types";

/**
 * What one character is holding of a currency, against what the whole account holds.
 *
 * Both numbers are last known rather than live — `at` is when this character last reported —
 * and the account total travels with the holding because "have I got enough" and "have I got
 * enough *somewhere*" are two different questions and only the second can be answered here.
 */
export interface CharacterCurrency {
  id: number;
  name: string;
  total: number;
  accountTotal: number;
  at?: number | null;
}

/** Where one character stands with one faction, and whether anybody is ahead of them. */
export interface CharacterFaction extends CharacterStanding {
  faction: string;
  /** True when no other character on the account has got further up this faction's ladder. */
  leads: boolean;
}

/**
 * One character, and everything this history knows about them.
 *
 * The segments travel with the profile rather than being counted away, because they are what
 * the right-hand pane is drawn from and what the detail modal walks when one is opened — the
 * reader stepping through a character's history should be stepping through that character's
 * history, not through all of recorded time.
 */
export interface CharacterProfile {
  name: string;
  classFile?: string | null;
  /** The highest level ever seen on them, which is where they are now. */
  level: number | null;
  seconds: number;
  segmentCount: number;
  /** Days they were played at all, which is a different thing from how long for. */
  dayCount: number;
  firstSeen: number;
  lastSeen: number;
  lootValue: number;
  goldDiff: number;
  /** Where they spend their time, busiest first. */
  places: string[];
  /** Their segments, newest first. */
  segments: Segment[];
  /** What they are holding, biggest first. Empty on a history collected before any report. */
  currencies: CharacterCurrency[];
  /** Where they stand, furthest along first. */
  factions: CharacterFaction[];
  /** Everything they ever earned, summarised the way one segment's is. */
  highlights: Highlight[];
}

/**
 * Folds a history into one profile per character, most recently played first.
 *
 * Recency rather than time played, because the question the roster answers first is "what was
 * I doing" — the character somebody logged out of an hour ago is the one they came back for,
 * however many hours the bank alt has technically accumulated.
 */
export function buildCharacters(
  segments?: Segment[] | null,
  holdings?: AccountHoldings,
): CharacterProfile[] {
  const byName = new Map<string, Segment[]>();
  for (const segment of segments || []) {
    const found = byName.get(segment.character);
    if (found) found.push(segment);
    else byName.set(segment.character, [segment]);
  }
  return [...byName.entries()]
    .map(([name, list]) => profile(name, list, holdings))
    .sort((left, right) => right.lastSeen - left.lastSeen || (left.name < right.name ? -1 : 1));
}

function profile(name: string, list: Segment[], holdings?: AccountHoldings): CharacterProfile {
  const segments = [...list].sort(
    (left, right) => (right.startedAt || 0) - (left.startedAt || 0) || (right.endedAt || 0) - (left.endedAt || 0),
  );
  // Time spent per place, so the busiest is the one named first. A character's home is where
  // the hours went, not where the most separate visits happen to have been recorded.
  const byPlace = new Map<string, number>();
  let level: number | null = null;
  for (const segment of segments) {
    if (segment.instance) {
      byPlace.set(segment.instance, (byPlace.get(segment.instance) || 0) + (segment.seconds || 0));
    }
    if (segment.level != null) level = Math.max(level ?? 0, segment.level);
  }

  return {
    name,
    // A class never changes, but a segment recorded before the addon collected one has none,
    // so the newest segment that names a class is the one to believe.
    classFile: segments.find((segment) => segment.classFile)?.classFile ?? null,
    level,
    seconds: segments.reduce((total, segment) => total + (segment.seconds || 0), 0),
    segmentCount: segments.length,
    dayCount: new Set(segments.map((segment) => segment.day)).size,
    firstSeen: Math.min(...segments.map((segment) => segment.startedAt || 0)),
    lastSeen: Math.max(...segments.map((segment) => segment.endedAt || 0)),
    lootValue: segments.reduce((total, segment) => total + (segment.lootValue || 0), 0),
    goldDiff: segments.reduce((total, segment) => total + (segment.goldDiff || 0), 0),
    places: [...byPlace.entries()].sort((left, right) => right[1] - left[1]).map(([place]) => place),
    segments,
    currencies: currenciesOf(name, holdings),
    factions: factionsOf(name, holdings),
    highlights: highlights(segments),
  };
}

function currenciesOf(name: string, holdings?: AccountHoldings): CharacterCurrency[] {
  return (holdings?.currencies || [])
    .flatMap((currency) => {
      const held = currency.characters.find((holder) => holder.character === name);
      if (!held) return [];
      return [{
        id: currency.id,
        name: currency.name || `Currency ${currency.id}`,
        total: held.total,
        accountTotal: currency.total,
        at: held.at,
      }];
    })
    .sort((left, right) => right.total - left.total || (left.name < right.name ? -1 : 1));
}

/**
 * Where a character stands with every faction they have met.
 *
 * Sorted by how far up their own ladder they are, and a standing the client could not place
 * on one sorts last rather than first: it is not a rank of zero, it is no rank at all.
 */
function factionsOf(name: string, holdings?: AccountHoldings): CharacterFaction[] {
  return (holdings?.factions || [])
    .flatMap((faction) => {
      const standing = faction.characters.find((entry) => entry.character === name);
      if (!standing) return [];
      return [{ ...standing, faction: faction.faction, leads: faction.best?.character === name }];
    })
    .sort((left, right) => (right.rank ?? -1) - (left.rank ?? -1) || (left.faction < right.faction ? -1 : 1));
}

/** The day a moment falls on, in the `YYYY-MM-DD` a segment writes its own day as. */
export function dayOf(epoch: number): string {
  const date = new Date(epoch * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The segments under the day they happened on, newest day first.
 *
 * Grouped by walking rather than by bucketing, because the list arrives in order and a
 * character played across two months is a list nobody scrolls without the dates in it.
 */
export function byDay(segments: Segment[]): Array<{ day: string; segments: Segment[] }> {
  const groups: Array<{ day: string; segments: Segment[] }> = [];
  for (const segment of segments) {
    const open = groups[groups.length - 1];
    if (open && open.day === segment.day) open.segments.push(segment);
    else groups.push({ day: segment.day, segments: [segment] });
  }
  return groups;
}
