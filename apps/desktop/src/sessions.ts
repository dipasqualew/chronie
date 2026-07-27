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

import { equipsetDetail, equipsetTitle } from "./equipsets";
import { eventsOf } from "./types";
import type { EventListKey, EventOf, Segment } from "./types";

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
  | "housingLevel" | "housingItem" | "quest" | "equipset"
  | "gold" | "loot" | "currency" | "reputation" | "housingXP";

/**
 * `milestone` entries are the things a player would tell someone about; `tally` entries are
 * the running numbers giving those things context.
 */
export type HighlightFamily = "milestone" | "tally";

/**
 * One of the things a milestone summarises, with the way back to where it happened.
 *
 * A summary is only worth reading if it can be taken apart again — "12 achievements" says
 * what kind of evening it was, and these say which twelve.
 */
export interface HighlightEntry {
  /** What the thing is called: an achievement's name, "Level 12", a mount. */
  label: string;
  /** The quieter half of the line, when there is one: "account first", "variant". */
  detail: string;
  /** When it happened, where the game recorded a time. */
  at: number | null;
  /** Who it happened to, which is the thing a session-wide summary loses. */
  character: string;
  segmentId: number;
}

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
  items?: HighlightEntry[];
  /** Orders within a family; the bigger achievement of two leads. */
  weight?: number;
  /** A running total's number, on the tallies only. */
  value?: number;
}

export interface Highlight extends HighlightStyle {
  kind: HighlightKind;
  label: string;
  detail: string;
  /** How many things the summary stands for; one for a tally, which stands for itself. */
  count: number;
  items: HighlightEntry[];
  weight?: number;
  value?: number;
  /**
   * Where to go when the summary is of exactly one thing, and null when it is of several.
   * A chip that stands for twelve achievements has no single segment to open, so it opens
   * its own list instead — sending the click to whichever came first would be a lie about
   * where the rest of them came from.
   */
  segmentId: number | null;
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
  equipset: { rank: 10, family: "milestone", icon: "🎽" },
  gold: { rank: 11, family: "tally", icon: "💰" },
  loot: { rank: 12, family: "tally", icon: "🎒" },
  currency: { rank: 13, family: "tally", icon: "🪙" },
  reputation: { rank: 14, family: "tally", icon: "🎖️" },
  housingXP: { rank: 15, family: "tally", icon: "✨" },
};

/**
 * What the given segments amount to, best first — one summary per kind, never one per thing.
 *
 * An evening that turned up twelve achievements is one line reading "12 achievements", not
 * twelve lines competing for the same row: the count is what tells you what kind of evening
 * it was, and the twelve names are what you go looking for afterwards. So every summary
 * carries its `items`, and the view is free to unfold them where the reader asks.
 *
 * Takes an array rather than a session so the same summary can describe one segment in the
 * detail modal and a whole evening on the timeline — the difference between "this run" and
 * "this session" should be the input, not a second implementation.
 */
export function highlights(segments: Segment[]): Highlight[] {
  const list = [...milestones(segments), ...tallies(segments)];
  return list
    .map((entry) => {
      const items = entry.items || [];
      return {
        count: items.length || 1,
        detail: "",
        ...entry,
        items,
        // One thing has somewhere to go; a summary of several does not.
        segmentId: items.length === 1 ? items[0].segmentId : null,
        ...KINDS[entry.kind],
      };
    })
    .sort((left, right) => left.rank - right.rank || (right.weight || 0) - (left.weight || 0));
}

/** An event paired with the segment it was recorded in. */
interface Sourced<T> {
  event: T;
  segment: Segment;
}

/**
 * How a summary reads: the thing itself when it stands for one, the count when it stands
 * for several. "Clockwork Glider" is worth more of the row than "1 mount" ever is, and the
 * one thing it names is a click away from the run it came from either way.
 */
const counted = (items: HighlightEntry[], plural: string): string =>
  (items.length === 1 ? items[0].label : `${items.length} ${plural}`);

/**
 * The things a player would tell someone about, one summary each.
 *
 * Every kind is folded the same way — count them, say what is notable about the set, keep
 * every one of them as an entry — so the only thing that varies between kinds is the
 * wording, which is the part worth reading here.
 */
function milestones(segments: Segment[]): HighlightSeed[] {
  const out: HighlightSeed[] = [];
  const from = <K extends EventListKey>(key: K): Array<Sourced<EventOf<K>>> =>
    segments.flatMap((segment) => eventsOf(segment, key).map((event) => ({ event, segment })));
  // Who is on screen already: one segment is one character, and so is an evening that never
  // hopped alts. Naming them on a summary that sits directly under their name says nothing.
  const cast = new Set(segments.map((segment) => segment.character));

  const entry = <T extends { at?: number | null }>(
    { event, segment }: Sourced<T>,
    label: string,
    detail = "",
  ): HighlightEntry => ({
    label,
    detail,
    at: event.at ?? null,
    character: segment.character,
    segmentId: segment.segmentId,
  });

  const achievements = from("achievements");
  if (achievements.length) {
    const first = achievements.filter(({ event }) => event.accountFirst);
    // An account first is rarer than a character first, so it leads the list the summary
    // unfolds into — the reader opening twelve achievements wants the notable one on top.
    const items = [...first, ...achievements.filter(({ event }) => !event.accountFirst)]
      .map((sourced) => entry(sourced, sourced.event.name || `Achievement ${sourced.event.id}`,
        sourced.event.accountFirst ? "account first" : "character first"));
    out.push({
      kind: "achievement",
      label: counted(items, "achievements"),
      detail: items.length === 1
        ? items[0].detail
        : (first.length ? `${first.length} account first` : "character firsts"),
      weight: first.length * 100 + items.length,
      items,
    });
  }

  const levelUps = from("levelUps");
  if (levelUps.length) {
    const items = levelUps.map((sourced) => entry(sourced, `Level ${sourced.event.level}`));
    // The level a character finished on is the story, not the ones passed through on the
    // way; with an alt in the evening too, the count is all that fits and all that is meant.
    const reached = new Map<string, number>();
    for (const { event, segment } of levelUps) {
      reached.set(segment.character, Math.max(reached.get(segment.character) ?? 0, event.level));
    }
    const [[who, top]] = [...reached];
    // Several characters levelling has no single "now 12" to report; one has, and says so —
    // naming them only where somebody else played too, because a segment row and a
    // one-character evening have both said the name already a line above.
    const reach = `${cast.size > 1 ? `${who} ` : ""}now ${top}`;
    out.push({
      kind: "levelUp",
      label: counted(items, "levels"),
      detail: reached.size > 1
        ? `${reached.size} characters`
        : (items.length === 1 ? (cast.size > 1 ? who : "") : reach),
      weight: Math.max(...reached.values()),
      items,
    });
  }

  const collection = (key: "mounts" | "toys" | "pets", kind: HighlightKind, noun: string, plural: string): void => {
    const found = from(key);
    if (!found.length) return;
    const items = found.map((sourced) =>
      entry(sourced, sourced.event.name || `${noun} ${sourced.event.id}`));
    out.push({ kind, label: counted(items, plural), weight: items.length, items });
  };
  collection("mounts", "mount", "Mount", "mounts");
  collection("toys", "toy", "Toy", "toys");
  collection("pets", "pet", "Pet", "pets");

  const transmogs = from("transmogs");
  const fresh = transmogs.filter(({ event }) => event.newAppearance === true);
  const variants = transmogs.filter(({ event }) => event.newAppearance === false);
  if (fresh.length || variants.length) {
    // A brand new appearance is the collection growing; a variant is a colour of something
    // already owned. Leading with whichever actually happened keeps the chip honest, and
    // the list holds both, because "which of these were new" is the question it answers.
    const items = [...fresh, ...variants].map((sourced) =>
      entry(sourced, sourced.event.name || `Item ${sourced.event.id}`,
        sourced.event.newAppearance ? "new appearance" : "variant of one owned"));
    out.push({
      kind: "transmog",
      label: fresh.length ? `${fresh.length} new appearance${fresh.length === 1 ? "" : "s"}` : "New transmog source",
      detail: fresh.length && variants.length
        ? `+${variants.length} variant${variants.length === 1 ? "" : "s"}`
        : (fresh.length ? "" : `${variants.length} variant${variants.length === 1 ? "" : "s"}`),
      count: (fresh.length ? fresh : variants).length,
      weight: fresh.length * 10 + variants.length,
      items,
    });
  }

  const housingLevels = from("housingLevelUps");
  if (housingLevels.length) {
    const items = housingLevels.map((sourced) => entry(sourced, `Housing level ${sourced.event.level}`));
    const top = Math.max(...housingLevels.map(({ event }) => event.level));
    out.push({
      kind: "housingLevel",
      label: items.length === 1 ? items[0].label : `${items.length} housing levels`,
      detail: items.length === 1 ? "" : `now level ${top}`,
      weight: top,
      items,
    });
  }

  const housing = from("housingItems");
  if (housing.length) {
    const warband = housing.filter(({ event }) => event.warbandFirst);
    const items = housing.map((sourced) =>
      entry(sourced, sourced.event.name || `Decor ${sourced.event.id}`,
        sourced.event.warbandFirst ? "warband first" : "already known"));
    out.push({
      kind: "housingItem",
      label: counted(items, "decor"),
      detail: warband.length ? `${warband.length} warband first` : "already known",
      weight: warband.length * 100 + housing.length,
      items,
    });
  }

  const equipsets = from("equipsetChanges");
  if (equipsets.length) {
    // Which set, what happened to it, and whether the character ended up better dressed —
    // the three things a chip about an equipment set is worth reading for.
    const items = equipsets.map((sourced) =>
      entry(sourced, equipsetTitle(sourced.event), equipsetDetail(sourced.event)));
    const edits = equipsets.filter(({ event }) => event.kind === "updated");
    out.push({
      kind: "equipset",
      label: counted(items, "equipment set changes"),
      // With one change the line already says what happened, so the quieter half carries
      // the items. With several it carries the shape of the evening's fiddling instead.
      detail: items.length === 1
        ? items[0].detail
        : `${edits.length ? `${edits.length} edited` : ""}${
          edits.length && edits.length < items.length ? ", " : ""}${
          edits.length < items.length ? `${items.length - edits.length} created or deleted` : ""}`,
      weight: items.length,
      items,
    });
  }

  const quests = from("quests");
  if (quests.length) {
    const first = quests.filter(({ event }) => event.accountFirst);
    const items = quests.map((sourced) =>
      entry(sourced, sourced.event.name || `Quest ${sourced.event.id}`,
        sourced.event.accountFirst ? "account first" : ""));
    out.push({
      kind: "quest",
      label: counted(items, "quests"),
      detail: first.length ? `${first.length} account first` : "",
      weight: quests.length,
      items,
    });
  }

  return out;
}

/** The running numbers that give the milestones context; they stand for themselves. */
function tallies(segments: Segment[]): HighlightSeed[] {
  const out: HighlightSeed[] = [];

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
