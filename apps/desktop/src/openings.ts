/**
 * How anybody gets the looks a set locks — the rows of the panel, decided out of two payloads.
 *
 * The chip on a card says *whether* a class-locked set is really locked: "Any plate wearer" is
 * the lock lifting and "Paladin only" is it standing — see `whoWears` and `wearers.rs`. That is
 * one sentence for a body's worth of clothes, and it is the wrong grain for the reader actually
 * standing in front of one. Icecrown Citadel's Paladin tier locks eight slots, seven of which
 * some world drop sells to everybody; the eighth is the helm, and the helm is the whole answer.
 *
 * So this joins what the window already has — the set's own rows, from `transmogModal` — to what
 * the backend read out of every item in the game, from `openings.rs`, and produces one row per
 * look the set locks. Three states, and the middle one is why the panel exists:
 *
 * - **Opened** — the set's own item is class-locked and something else gives the look to
 *   anybody. The row names that something, which is where the reader goes.
 * - **Blocked** — nothing does. This is the row that decides whether the set is worth chasing.
 * - **Unread** — this install can read no item of the look, the game encrypting content it has
 *   not shipped. Left out of the table and counted in the sentence over it, because a blank
 *   drawn as a wall is this app inventing one.
 *
 * A look the set already sells to everybody is not a row here at all. It locks nobody out, the
 * reader is not being kept from it, and a table of eight rows where seven say "you were never
 * stopped" buries the one that says they were.
 */

import { plural } from "./format";
import { ANY_CLASS, qualityLabel } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type { OpeningsPayload, SetOpening } from "./types";

/**
 * Whether the set's own items shut anybody out of this look.
 *
 * Any one unrestricted source is enough, which is exactly `liftsRestriction` seen from the other
 * side: a look the set itself sells openly is a look nobody was stopped at. A source the game
 * withholds says nothing either way and cannot open anything — its class mask is zero because
 * the row is encrypted, not because the item is for nobody.
 */
export function locked(row: AppearanceRow): boolean {
  if (row.withheld) return false;
  return !row.sources.some((source) => source.allowableClass === ANY_CLASS);
}

/** Whether a set locks anything at all, which is what decides the panel is worth reading for. */
export function locksAnything(rows: AppearanceRow[]): boolean {
  return rows.some(locked);
}

/** One locked look of the set, and what a reader locked out of it can do about it. */
export interface OpeningRow {
  appearanceId: number;
  /**
   * Which place the look fills, as `ItemAppearance` numbers them.
   *
   * Carried because the row is where "show possible alternatives" is asked from, and both
   * measures behind that answer are per slot: a chestpiece is ranked against chestpieces and
   * cut at the threshold this install measured for chestpieces — see `alternatives.ts`.
   */
  displayType: number;
  /** Where on the body it goes, as the row above it already says it. */
  slot: string;
  /** The set's own item — the one the reader cannot have. */
  own: string;
  /**
   * The cheapest item in the game giving the same look that no class is locked out of, or
   * `null` where there is none and the slot is a wall.
   */
  open: SetOpening | null;
}

/**
 * The rows of the panel: the set's locked looks, each joined to its way in.
 *
 * In the order the set's own list is already in, which is by slot — so the table reads down the
 * body beside the list it is about rather than in whatever order the backend's hash map came out
 * in. A locked look the payload mentions in neither list is one this install can say nothing
 * about, and is left out: see [`unread`], which is what the sentence over the table counts.
 */
export function openingRows(rows: AppearanceRow[], payload: OpeningsPayload): OpeningRow[] {
  const open = new Map(payload.openings.map((one) => [one.appearanceId, one]));
  const blocked = new Set(payload.blocked);
  const found: OpeningRow[] = [];
  for (const row of rows) {
    if (!locked(row)) continue;
    const way = open.get(row.appearanceId);
    if (!way && !blocked.has(row.appearanceId)) continue;
    found.push({
      appearanceId: row.appearanceId,
      displayType: row.displayType,
      slot: row.slot,
      own: row.label,
      open: way ?? null,
    });
  }
  return found;
}

/** How many of the set's locked looks this install could say nothing whatever about. */
export function unread(rows: AppearanceRow[], payload: OpeningsPayload): number {
  const known = new Set([...payload.openings.map((one) => one.appearanceId), ...payload.blocked]);
  return rows.filter((row) => locked(row) && !known.has(row.appearanceId)).length;
}

/**
 * The one line over the table, which is the answer for a reader who reads nothing else.
 *
 * A count rather than a verdict, because the counts are what differ: every look open is a set
 * somebody else's class can simply have, one look shut is a set they can nearly have, and none
 * open is a wall. Seven of eight is the sentence Icecrown's Paladin tier deserves and no phrase
 * covering all three would say it.
 */
export function openingSummary(rows: OpeningRow[], unreadCount = 0): string {
  const said = unreadCount ? ` · ${plural(unreadCount, "look")} the game keeps encrypted` : "";
  if (!rows.length) return `Nothing this set locks could be read${said}`;
  const total = rows.length;
  const opened = rows.filter((row) => row.open).length;
  if (opened === 0) {
    return total === 1
      ? `Nothing in the game gives this set's one locked look to another class${said}`
      : `Nothing in the game gives any of this set's ${total} locked looks to another class${said}`;
  }
  if (opened === total) {
    return total === 1
      ? `The one look this set locks is on an item anybody can wear${said}`
      : `All ${total} looks this set locks are on an item anybody can wear${said}`;
  }
  return `${opened} of the ${total} looks this set locks ${
    opened === 1 ? "is" : "are"
  } on an item anybody can wear${said}`;
}

/**
 * How a row names the way in, which is the item and what it takes to have it.
 *
 * The level only where the game asks for one, which it does not for most of what answers here —
 * a world drop out of an expansion nobody levels through any more has no requirement left on it.
 * The quality always, because it is the word a reader recognises the item's colour by and the
 * one thing that separates two similarly named drops.
 */
export function openingLabel(open: SetOpening): string {
  const name = open.name || `Item ${open.itemId}`;
  const level = open.requiredLevel > 0 ? ` · Level ${open.requiredLevel}` : "";
  return `${name} · ${qualityLabel(open.quality)}${level}`;
}
