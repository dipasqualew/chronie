/**
 * What the account holds, held against what the game has.
 *
 * The census walks the client's own lists and writes down what an account owns; the installed
 * game's tables say what there is to own. Neither half is interesting alone — a list of 4,100
 * earned achievements says nothing, and 13,732 rows of `Achievement` says less — and no addon
 * can do the subtraction, because the names of the things somebody has *not* got exist only in
 * the game's files. This is that subtraction, and every rule about it lives here rather than in
 * the component that draws it.
 *
 * **One rule governs the lot, and it is the reason this module is careful rather than clever:**
 *
 * > An absence means a removal only inside a reading that says it is complete.
 *
 * `docs/account-census.md` argues it from the addon's end. From this end it means every count
 * below is qualified by the claim the walk made about itself, and a screen that presented a
 * half-finished walk as a finished one would be inventing losses out of a logout. So nothing
 * here answers "you are missing N" outright: it answers with a [`Verdict`] beside the number,
 * and the view is obliged to draw it. That is the same bargain `gap.ts` makes about a hole in
 * the timeline, for the same reason — a number nobody can check is worse than no number.
 */

import type {
  AccountCensusPayload,
  CatalogueAchievement,
  CatalogueMount,
  CensusReading,
  CollectionCataloguePayload,
  EarnedAchievement,
} from "./types";

import { ago } from "./format";

/** The domains the census walks, by the addon's own word for each. */
export const ACHIEVEMENTS = "achievements";
export const MOUNTS = "mounts";

/**
 * How much of a claim a reading is.
 *
 * - `unwalked` — no pass has ever covered this domain. Nothing at all can be said: an empty
 *   list is a list nobody has looked at, not an account that owns nothing.
 * - `partial` — a pass started and did not finish. What it found is true; what it did not
 *   mention proves nothing, so no subtraction from it is safe.
 * - `whole` — a pass asked about every id the client named, and the subtraction holds.
 */
export type Verdict = "unwalked" | "partial" | "whole";

export function verdictOf(reading: CensusReading | null): Verdict {
  if (!reading) return "unwalked";
  return reading.complete ? "whole" : "partial";
}

/** The reading for one domain, or `null` when no walk has ever covered it. */
export function readingOf(
  census: AccountCensusPayload | null,
  domain: string,
): CensusReading | null {
  return (census?.readings || []).find((reading) => reading.domain === domain) ?? null;
}

/**
 * What the reading itself says, so a reader can weigh the numbers under it.
 *
 * Always drawn, unlike `gap.ts`'s sentence, and the difference is what the two are for. A gap
 * notice appears only when there is a hole, because a page that said "no gap found" every time
 * would teach people to stop reading it. This is not a warning — it is the provenance of every
 * figure on the screen, and a figure whose provenance is only shown when it is bad is a figure
 * nobody learns to check.
 *
 * @param now Epoch seconds, injected so the tests can pin what "four days ago" means.
 */
export function readingSentence(reading: CensusReading | null, now?: number): string {
  if (!reading) {
    return "Chronie has never walked this. Log in with the addon installed and it will, ten seconds after the world arrives.";
  }
  const who = reading.walkedBy ? ` on ${reading.walkedBy}` : "";
  const when = reading.completedAt ?? reading.observedAt;
  const build = reading.build ? `, on build ${reading.build}` : "";
  if (!reading.complete) {
    return `Read${who}${build}, ${ago(when, now)} — and not to the end. This is part of one walk, so what it found is here and what it did not reach is not missing, only unasked.`;
  }
  return `Read${who}${build}, ${ago(when, now)}, all the way through.`;
}

/**
 * The evidence behind that sentence, as lines a reader can hold against the game.
 *
 * The client's own counter is the interesting one, and only when it disagrees: a count above
 * what was written down means the walk is out of date, which is exactly the condition the
 * addon's audit provokes a fresh walk on.
 */
export function readingEvidence(reading: CensusReading | null): string[] {
  if (!reading) return [];
  const lines = [`${reading.held.toLocaleString()} written down, at revision ${reading.revision}.`];
  if (reading.counted != null && reading.counted !== reading.held) {
    lines.push(
      `The client counted ${reading.counted.toLocaleString()} at the same moment, so this reading is behind the game — the next login will walk it again.`,
    );
  }
  return lines;
}

/** How far through something the account is, and how much of that total is unreadable. */
export interface Progress {
  held: number;
  /** What the game holds. `null` when no catalogue has been read — there is no install. */
  total: number | null;
  /** Rows of the game's table this install could not read, which no total can account for. */
  withheld: number;
  verdict: Verdict;
}

/**
 * What is left when the census is taken away from the catalogue.
 *
 * `null` for the total, rather than a zero, on a machine with no game installed. The two are
 * not the same claim and a screen that drew "4,100 of 0" would be saying something absurd where
 * the honest answer is "4,100, and nothing to hold them against".
 */
export function remaining(progress: Progress): number | null {
  if (progress.total == null) return null;
  return Math.max(progress.total - progress.held, 0);
}

export function achievementProgress(
  census: AccountCensusPayload | null,
  catalogue: CollectionCataloguePayload | null,
): Progress {
  return {
    held: census?.achievements.length ?? 0,
    total: catalogue ? catalogue.achievements.length : null,
    withheld: catalogue?.withheldAchievements ?? 0,
    verdict: verdictOf(readingOf(census, ACHIEVEMENTS)),
  };
}

export function mountProgress(
  census: AccountCensusPayload | null,
  catalogue: CollectionCataloguePayload | null,
): Progress {
  return {
    held: census?.mounts.length ?? 0,
    total: catalogue ? catalogue.mounts.length : null,
    withheld: catalogue?.withheldMounts ?? 0,
    verdict: verdictOf(readingOf(census, MOUNTS)),
  };
}

/**
 * What the account's achievements are worth, by the catalogue's reckoning and not the client's.
 *
 * The census carries the points the client had loaded at the moment it walked, and the
 * catalogue carries the points the game's own table states. They usually agree; when they do
 * not, the catalogue wins, because the earned total and the total available have to be counted
 * out of the same book or the fraction between them means nothing.
 *
 * Points the catalogue says nothing about fall back to the client's, which is what an
 * achievement a patch retired comes back as: still earned, still worth what it was worth.
 */
export function pointsEarned(
  census: AccountCensusPayload | null,
  catalogue: CollectionCataloguePayload | null,
): number {
  const worth = pointsBook(catalogue);
  return (census?.achievements || []).reduce(
    (total, earned) => total + (worth.get(earned.id) ?? earned.points ?? 0),
    0,
  );
}

export function pointsAvailable(catalogue: CollectionCataloguePayload | null): number | null {
  if (!catalogue) return null;
  return catalogue.achievements.reduce((total, found) => total + found.points, 0);
}

function pointsBook(catalogue: CollectionCataloguePayload | null): Map<number, number> {
  return new Map((catalogue?.achievements || []).map((found) => [found.id, found.points]));
}

/** One achievement the account has not earned, as a row of the list of what is left. */
export interface Missing {
  id: number;
  title: string;
  description: string;
  points: number;
  iconFileDataId: number;
  /** The innermost category the game files it under, for a list grouped by the outermost. */
  under: string;
}

/** One branch of the game's own achievement tree, and how much of it the account has. */
export interface CategoryRow {
  name: string;
  held: number;
  total: number;
  points: number;
  pointsTotal: number;
  /** What is left in it, worth the most first. */
  missing: Missing[];
}

/**
 * The catalogue grouped the way the game's own achievement pane groups it, with the account's
 * half filled in.
 *
 * By the **outermost** category rather than the innermost, which is the difference between
 * fifteen rows a player recognises — Quests, Exploration, Dungeons & Raids — and four hundred
 * they do not. Each missing achievement still names the branch it actually sits in, because
 * "Dungeons & Raids" is not somewhere anybody can go and look.
 *
 * Ranked by points inside a category, because that is the order somebody choosing what to do
 * next wants them in, and because it puts the half of the table worth nothing at all — feats of
 * strength, statistics, the legacy tree — at the bottom where it belongs rather than scattered
 * through.
 *
 * Empty when there is no catalogue. There is nothing to group: the census knows what it earned
 * and nothing whatever about the tree those sit in.
 */
export function byCategory(
  census: AccountCensusPayload | null,
  catalogue: CollectionCataloguePayload | null,
): CategoryRow[] {
  if (!catalogue) return [];
  const earned = new Set((census?.achievements || []).map((found) => found.id));
  const rows = new Map<string, CategoryRow>();

  for (const found of catalogue.achievements) {
    const name = found.category[0] ?? UNFILED;
    let row = rows.get(name);
    if (!row) {
      row = { name, held: 0, total: 0, points: 0, pointsTotal: 0, missing: [] };
      rows.set(name, row);
    }
    row.total += 1;
    row.pointsTotal += found.points;
    if (earned.has(found.id)) {
      row.held += 1;
      row.points += found.points;
    } else {
      row.missing.push(missingOf(found));
    }
  }

  for (const row of rows.values()) {
    row.missing.sort(byWorth);
  }
  // The fullest branches first: a category with four hundred achievements in it is more of the
  // game than one with six, whichever way round the alphabet puts them.
  return [...rows.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Where an achievement whose category this install cannot read is filed instead. */
export const UNFILED = "Filed nowhere the game will say";

function missingOf(found: CatalogueAchievement): Missing {
  return {
    id: found.id,
    title: found.title,
    description: found.description,
    points: found.points,
    iconFileDataId: found.iconFileDataId,
    under: found.category[found.category.length - 1] ?? UNFILED,
  };
}

const byWorth = (a: Missing, b: Missing): number =>
  b.points - a.points || a.title.localeCompare(b.title);

/** One character's share of the account's achievements. */
export interface Carrier {
  character: string;
  earned: number;
  points: number;
}

/**
 * Who has been carrying the account, by count and by what they earned.
 *
 * This is the question the census pays for. `GetAchievementInfo` reports completion for the
 * *account* and hands over the name of the alt that actually did it, so one character's walk
 * attributes the whole history — nothing has to be unioned across a roster and nothing waits
 * for an alt nobody has logged into since 2011.
 *
 * The achievements the client named nobody for are left out rather than filed under an
 * "Unknown" that would sort into the middle of the list as though it were somebody. What is not
 * attributed is not a character.
 */
export function carriers(
  census: AccountCensusPayload | null,
  catalogue: CollectionCataloguePayload | null,
): Carrier[] {
  const worth = pointsBook(catalogue);
  const rows = new Map<string, Carrier>();
  for (const earned of census?.achievements || []) {
    if (!earned.earnedBy) continue;
    const row = rows.get(earned.earnedBy) ?? {
      character: earned.earnedBy,
      earned: 0,
      points: 0,
    };
    row.earned += 1;
    row.points += worth.get(earned.id) ?? earned.points ?? 0;
    rows.set(earned.earnedBy, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.points - a.points || b.earned - a.earned || a.character.localeCompare(b.character),
  );
}

/** One year of the account's history. */
export interface Year {
  year: number;
  earned: number;
  points: number;
}

/**
 * The account's achievements year by year, oldest first.
 *
 * A real timeline rather than a history of what Chronie watched — the whole reason the census
 * exists. An achievement earned in 2009 is not a gain anybody saw and never will be, and it is
 * on this list all the same.
 *
 * Years with nothing in them are filled in rather than skipped, so a gap in somebody's play
 * reads as a gap instead of two adjacent bars. The undated ones are left out entirely: the
 * client dated them at nothing and no year here would be one it stated.
 */
export function byYear(
  census: AccountCensusPayload | null,
  catalogue: CollectionCataloguePayload | null,
): Year[] {
  const worth = pointsBook(catalogue);
  const rows = new Map<number, Year>();
  for (const earned of census?.achievements || []) {
    const year = yearOf(earned);
    if (year == null) continue;
    const row = rows.get(year) ?? { year, earned: 0, points: 0 };
    row.earned += 1;
    row.points += worth.get(earned.id) ?? earned.points ?? 0;
    rows.set(year, row);
  }
  if (!rows.size) return [];
  const years = [...rows.keys()];
  const filled: Year[] = [];
  for (let year = Math.min(...years); year <= Math.max(...years); year += 1) {
    filled.push(rows.get(year) ?? { year, earned: 0, points: 0 });
  }
  return filled;
}

/** How many the client dated at nothing, which is a number worth saying rather than hiding. */
export function undated(census: AccountCensusPayload | null): number {
  return (census?.achievements || []).filter((earned) => yearOf(earned) == null).length;
}

function yearOf(earned: EarnedAchievement): number | null {
  if (!earned.earnedOn) return null;
  const year = Number(earned.earnedOn.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

/** One mount the account has not got. */
export interface MissingMount {
  id: number;
  name: string;
  /** Where the game says it comes from. Empty for the handful it says nothing about. */
  source: string;
}

/**
 * The mounts the catalogue holds and the census did not walk, by name.
 *
 * By name and not by anything else, because that is the whole of what the game will say about a
 * mount without a hop through `SpellMisc` that nothing in this app makes — see `mounts.rs`. The
 * source line beside it is the useful half anyway: somebody who has not got a mount wants to
 * know where it is, and a 64-pixel picture does not say.
 */
export function missingMounts(
  census: AccountCensusPayload | null,
  catalogue: CollectionCataloguePayload | null,
): MissingMount[] {
  if (!catalogue) return [];
  const held = new Set((census?.mounts || []).map((mount) => mount.id));
  return catalogue.mounts
    .filter((mount: CatalogueMount) => !held.has(mount.id))
    .map((mount) => ({ id: mount.id, name: mount.name, source: mount.source }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a screen must say about a subtraction, given what the reading claims.
 *
 * `null` when the subtraction is sound and needs no hedge at all.
 */
export interface Caveat {
  text: string;
  /**
   * Whether the number under it is unsound, as against merely short.
   *
   * The difference is worth a type, because it decides how loudly the view says it and getting
   * that wrong is its own failure. A reading that did not finish means the count is not what it
   * looks like, and somebody has to notice. Rows the install could not decrypt mean the count is
   * a little low — which is true of *every* install, permanently, because the game always ships
   * content it has not unlocked. Drawn at the same weight, that second one is a red box nobody
   * ever sees change, and a red box nobody ever sees change is how a reader learns to stop
   * looking at red boxes. `gap.ts` refuses to say "no gap found" for exactly this reason.
   */
  grave: boolean;
}

export function caveat(progress: Progress): Caveat | null {
  if (progress.verdict === "unwalked") {
    return {
      grave: true,
      text: "Nothing has walked this yet, so this is not a count of what the account holds — it is a count of what Chronie happens to have watched it collect.",
    };
  }
  if (progress.verdict === "partial") {
    return {
      grave: true,
      text: "The last walk did not finish, so this is at least what the account holds and possibly not all of it. What is left is an upper bound.",
    };
  }
  if (progress.total != null && progress.withheld) {
    return {
      grave: false,
      text: `${progress.withheld.toLocaleString()} ${progress.withheld === 1 ? "row" : "rows"} of the game's own table came through encrypted, so the total is that many short of what the game really has.`,
    };
  }
  return null;
}
