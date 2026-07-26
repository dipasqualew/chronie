/**
 * Play sessions: the shape the timeline is drawn from.
 *
 * A segment is what the addon records — one stretch in one place on one character. That is
 * the wrong unit for "what did I do on Saturday", because an evening of play is a dozen of
 * them: a dungeon, the walk out, an alt, a raid. A *session* stitches those back together.
 * Two segments belong to the same session when the later one starts within five minutes of
 * the last one ending, whichever character either was on, so hopping alts keeps the evening
 * whole while going to bed ends it.
 *
 * Everything here is pure: sessions in, summaries out. The rendering lives elsewhere, which
 * is what lets the grouping rule and the "what mattered" rule be tested without a browser.
 */

import { eventsOf } from "./types";
import type {
  AchievementEvent,
  CollectibleEvent,
  EventListKey,
  EventOf,
  HousingItemEvent,
  LevelUpEvent,
  QuestEvent,
  Segment,
  TransmogEvent,
} from "./types";

/** The gap that ends a play session. Five minutes is long enough to cover a loading screen. */
export const SESSION_GAP_SECONDS = 300;

export interface SessionCharacter {
  name: string;
  classFile?: string | null;
  level: number | null;
  seconds: number;
  segmentCount: number;
  lootValue: number;
  goldDiff: number;
  places: string[];
}

export interface Session {
  id: string;
  startedAt: number;
  endedAt: number;
  day: string;
  /** Time the addon was actually recording. */
  playedSeconds: number;
  /** How much of the evening the session took up, recording or not. */
  spanSeconds: number;
  segments: Segment[];
  characters: SessionCharacter[];
  totals: {
    lootValue: number;
    goldDiff: number;
    housingXP: number;
  };
  highlights: Highlight[];
}

/** The totals a session sums straight off its segments. */
type NumericSegmentKey = "lootValue" | "goldDiff" | "housingXP";

/**
 * Folds segments into play sessions, newest session first.
 *
 * @param segments Segments in any order; the collector hands them over newest first.
 * @param gapSeconds Silence that ends a session.
 * @returns Sessions, each with its segments in the order they happened.
 */
export function buildSessions(
  segments?: Segment[] | null,
  gapSeconds: number = SESSION_GAP_SECONDS,
): Session[] {
  const ordered = [...(segments || [])].sort(
    (left, right) => (left.startedAt || 0) - (right.startedAt || 0) || (left.endedAt || 0) - (right.endedAt || 0),
  );

  const groups: Segment[][] = [];
  let open: Segment[] | null = null;
  // The frontier is the latest end seen so far, not the previous segment's end: two
  // characters can overlap, and a short segment nested inside a long one must not make the
  // session look like it ended early and split the evening in half.
  let frontier = 0;
  for (const segment of ordered) {
    if (open && (segment.startedAt || 0) - frontier <= gapSeconds) {
      open.push(segment);
      frontier = Math.max(frontier, segment.endedAt || 0);
      continue;
    }
    open = [segment];
    groups.push(open);
    frontier = segment.endedAt || 0;
  }

  return groups.map(summarise).reverse();
}

function summarise(segments: Segment[]): Session {
  const startedAt = Math.min(...segments.map((segment) => segment.startedAt || 0));
  const endedAt = Math.max(...segments.map((segment) => segment.endedAt || 0));
  return {
    id: `session-${startedAt}`,
    startedAt,
    endedAt,
    day: segments[0].day,
    // Two different numbers, and the difference is the point: "played" is time the addon
    // was actually recording, "span" is how much of the evening it took up.
    playedSeconds: segments.reduce((total, segment) => total + (segment.seconds || 0), 0),
    spanSeconds: Math.max(endedAt - startedAt, 0),
    segments,
    characters: charactersIn(segments),
    totals: {
      lootValue: sum(segments, "lootValue"),
      goldDiff: sum(segments, "goldDiff"),
      housingXP: sum(segments, "housingXP"),
    },
    highlights: highlights(segments),
  };
}

const sum = (segments: Segment[], key: NumericSegmentKey): number =>
  segments.reduce((total, segment) => total + (segment[key] || 0), 0);

/**
 * Who played, busiest first. A session's identity on screen is its cast, so each entry
 * carries enough for the circle's tooltip without going back to the segments.
 */
export function charactersIn(segments: Segment[]): SessionCharacter[] {
  const byName = new Map<string, SessionCharacter>();
  for (const segment of segments) {
    const found: SessionCharacter = byName.get(segment.character) || {
      name: segment.character,
      classFile: segment.classFile,
      level: null,
      seconds: 0,
      segmentCount: 0,
      lootValue: 0,
      goldDiff: 0,
      places: [],
    };
    found.seconds += segment.seconds || 0;
    found.segmentCount += 1;
    found.lootValue += segment.lootValue || 0;
    found.goldDiff += segment.goldDiff || 0;
    // The level at the end of the session is the one worth showing; segments arrive in
    // order, so the largest seen is where the character finished.
    if (segment.level != null) found.level = Math.max(found.level ?? 0, segment.level);
    if (segment.instance && !found.places.includes(segment.instance)) found.places.push(segment.instance);
    byName.set(segment.character, found);
  }
  return [...byName.values()].sort((left, right) => right.seconds - left.seconds);
}

/* ---------- what mattered ---------- */

export type HighlightKind =
  | "achievement" | "levelUp" | "mount" | "toy" | "pet" | "transmog"
  | "housingLevel" | "housingItem" | "quest"
  | "gold" | "loot" | "currency" | "reputation" | "housingXP";

/**
 * `milestone` entries are the things a player would tell someone about and get a chip each;
 * `tally` entries are the running numbers giving those things context.
 */
export type HighlightFamily = "milestone" | "tally";

/** Whatever the highlight was built from, kept so a caller can look past the summary. */
export type HighlightItem =
  | AchievementEvent | LevelUpEvent | CollectibleEvent
  | TransmogEvent | QuestEvent | HousingItemEvent;

interface HighlightStyle {
  rank: number;
  family: HighlightFamily;
  icon: string;
}

/** What the builders below push: everything but the styling, which is filled in from `KINDS`. */
interface HighlightSeed {
  kind: HighlightKind;
  label: string;
  detail?: string;
  count?: number;
  items?: HighlightItem[];
  /** Orders within a family; the bigger achievement of two leads. */
  weight?: number;
  /** A running total's number, on the tallies only. */
  value?: number;
  /** The segment this came from, when it came from exactly one. */
  segmentId?: number | null;
}

export interface Highlight extends HighlightStyle {
  kind: HighlightKind;
  label: string;
  detail: string;
  count: number;
  items: HighlightItem[];
  weight?: number;
  value?: number;
  segmentId?: number | null;
}

/**
 * The order the session's achievements are read in, and how each is drawn.
 *
 * `milestone` entries are the things a player would tell someone about — a mount, an
 * achievement, a level — and get a chip each. `tally` entries are the running numbers that
 * give those things context, and share a single quiet strip. Rank orders within a family.
 */
const KINDS: Record<HighlightKind, HighlightStyle> = {
  achievement: { rank: 1, family: "milestone", icon: "🏆" },
  levelUp: { rank: 2, family: "milestone", icon: "⬆️" },
  mount: { rank: 3, family: "milestone", icon: "🐎" },
  toy: { rank: 4, family: "milestone", icon: "🧸" },
  pet: { rank: 5, family: "milestone", icon: "🐾" },
  transmog: { rank: 6, family: "milestone", icon: "👘" },
  housingLevel: { rank: 7, family: "milestone", icon: "🏡" },
  housingItem: { rank: 8, family: "milestone", icon: "🪑" },
  quest: { rank: 9, family: "milestone", icon: "📜" },
  gold: { rank: 10, family: "tally", icon: "💰" },
  loot: { rank: 11, family: "tally", icon: "🎒" },
  currency: { rank: 12, family: "tally", icon: "🪙" },
  reputation: { rank: 13, family: "tally", icon: "🎖️" },
  housingXP: { rank: 14, family: "tally", icon: "✨" },
};

/**
 * What the given segments amount to, best first.
 *
 * Takes an array rather than a session so the same summary can describe one segment in the
 * detail modal and a whole evening on the timeline — the difference between "this run" and
 * "this session" should be the input, not a second implementation.
 *
 * @returns Highlights carrying enough to render and to navigate back to the segment they
 *   came from, where they came from exactly one.
 */
export function highlights(segments: Segment[]): Highlight[] {
  const list = [...collectibles(segments), ...aggregates(segments)];
  return list
    .map((entry) => ({
      count: 1,
      items: [] as HighlightItem[],
      detail: "",
      ...entry,
      ...KINDS[entry.kind],
    }))
    .sort((left, right) => left.rank - right.rank || (right.weight || 0) - (left.weight || 0));
}

/** The things that happened once and are worth naming individually. */
function collectibles(segments: Segment[]): HighlightSeed[] {
  const out: HighlightSeed[] = [];
  const each = <K extends EventListKey>(
    key: K,
    visit: (event: EventOf<K>, segment: Segment) => void,
  ): void => segments.forEach((segment) => eventsOf(segment, key).forEach((event) => visit(event, segment)));

  each("achievements", (event, segment) =>
    out.push({
      kind: "achievement",
      label: event.name || `Achievement ${event.id}`,
      detail: event.accountFirst ? "account first" : "character first",
      // An account first is rarer than a character first, so it leads when both landed.
      weight: event.accountFirst ? 2 : 1,
      segmentId: segment.segmentId,
      items: [event],
    }));

  // A character that gained three levels in an evening is one line reading "Level 12", not
  // three competing for the same space; the levels below the last are implied by the count.
  interface LevelRun {
    count: number;
    level: number;
    segmentId: number | null;
    items: LevelUpEvent[];
  }
  const levels = new Map<string, LevelRun>();
  each("levelUps", (event, segment) => {
    const found: LevelRun = levels.get(segment.character) || { count: 0, level: 0, segmentId: null, items: [] };
    found.count += 1;
    found.items.push(event);
    if (event.level >= found.level) {
      found.level = event.level;
      found.segmentId = segment.segmentId;
    }
    levels.set(segment.character, found);
  });
  for (const [character, found] of levels) {
    out.push({
      kind: "levelUp",
      label: `Level ${found.level}`,
      detail: found.count > 1 ? `${character} · +${found.count} levels` : character,
      weight: found.level,
      count: found.count,
      segmentId: found.segmentId,
      items: found.items,
    });
  }

  const collection = (key: "mounts" | "toys" | "pets", kind: HighlightKind, noun: string): void =>
    each(key, (event, segment) =>
      out.push({
        kind,
        label: event.name || `${noun} ${event.id}`,
        segmentId: segment.segmentId,
        items: [event],
      }));
  collection("mounts", "mount", "Mount");
  collection("toys", "toy", "Toy");
  collection("pets", "pet", "Pet");

  each("housingLevelUps", (event, segment) =>
    out.push({
      kind: "housingLevel",
      label: `Housing level ${event.level}`,
      weight: event.level,
      segmentId: segment.segmentId,
      items: [event],
    }));

  return out;
}

/** An event paired with the segment it was recorded in. */
interface Sourced<T> {
  event: T;
  segment: Segment;
}

/** The things that only mean something added up. */
function aggregates(segments: Segment[]): HighlightSeed[] {
  const out: HighlightSeed[] = [];
  const from = <K extends EventListKey>(key: K): Array<Sourced<EventOf<K>>> =>
    segments.flatMap((segment) => eventsOf(segment, key).map((event) => ({ event, segment })));

  // A source segment is only offered when every entry came from the same one: sending a
  // click somewhere arbitrary is worse than not offering the click at all.
  const only = (entries: Array<Sourced<unknown>>): number | null => {
    const ids = new Set(entries.map(({ segment }) => segment.segmentId));
    return ids.size === 1 ? entries[0].segment.segmentId : null;
  };

  const transmogs = from("transmogs");
  const fresh = transmogs.filter(({ event }) => event.newAppearance === true);
  const variants = transmogs.filter(({ event }) => event.newAppearance === false);
  if (fresh.length || variants.length) {
    // A brand new appearance is the collection growing; a variant is a colour of something
    // already owned. Leading with whichever actually happened keeps the chip honest.
    const leading = fresh.length ? fresh : variants;
    out.push({
      kind: "transmog",
      label: fresh.length ? `${fresh.length} new appearance${fresh.length === 1 ? "" : "s"}` : "New transmog source",
      detail: fresh.length && variants.length
        ? `+${variants.length} variant${variants.length === 1 ? "" : "s"}`
        : (fresh.length ? "" : `${variants.length} variant${variants.length === 1 ? "" : "s"}`),
      count: leading.length,
      weight: fresh.length * 10 + variants.length,
      segmentId: only(leading),
      items: leading.map(({ event }) => event),
    });
  }

  const housing = from("housingItems");
  if (housing.length) {
    const warband = housing.filter(({ event }) => event.warbandFirst);
    out.push({
      kind: "housingItem",
      label: `${housing.length} decor`,
      detail: warband.length ? `${warband.length} warband first` : "already known",
      count: housing.length,
      weight: warband.length * 10 + housing.length,
      segmentId: only(housing),
      items: housing.map(({ event }) => event),
    });
  }

  const quests = from("quests");
  if (quests.length) {
    const first = quests.filter(({ event }) => event.accountFirst);
    out.push({
      kind: "quest",
      label: `${quests.length} quest${quests.length === 1 ? "" : "s"}`,
      detail: first.length ? `${first.length} account first` : "",
      count: quests.length,
      weight: quests.length,
      segmentId: only(quests),
      items: quests.map(({ event }) => event),
    });
  }

  const goldDiff = sum(segments, "goldDiff");
  if (goldDiff !== 0) {
    out.push({ kind: "gold", label: "Gold", value: goldDiff, weight: Math.abs(goldDiff) });
  }

  const lootValue = sum(segments, "lootValue");
  if (lootValue > 0) {
    out.push({ kind: "loot", label: "Looted", value: lootValue, weight: lootValue });
  }

  // Currencies and reputations are named things earned repeatedly across an evening; each
  // name is one line carrying its total, rather than one line per segment that touched it.
  for (const [name, amount] of totalsByName(segments, (segment) => segment.currencies, (event) => event.name)) {
    out.push({ kind: "currency", label: name, value: amount, weight: Math.abs(amount) });
  }
  for (const [faction, amount] of totalsByName(segments, (segment) => segment.reputation, (event) => event.faction)) {
    out.push({ kind: "reputation", label: faction, value: amount, weight: Math.abs(amount) });
  }

  const housingXP = sum(segments, "housingXP");
  if (housingXP !== 0) {
    out.push({ kind: "housingXP", label: "Housing XP", value: housingXP, weight: Math.abs(housingXP) });
  }

  return out;
}

function totalsByName<T extends { amount: number }>(
  segments: Segment[],
  gains: (segment: Segment) => T[] | undefined,
  name: (event: T) => string,
): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const segment of segments) {
    for (const event of gains(segment) || []) {
      totals.set(name(event), (totals.get(name(event)) || 0) + (event.amount || 0));
    }
  }
  return [...totals.entries()].sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]));
}
