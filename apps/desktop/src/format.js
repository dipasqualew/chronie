/**
 * How numbers, times and text become screen text.
 *
 * Every view needs the same handful of conversions, and each of them has a rule that is
 * easy to get subtly wrong — a negative gold delta that loses its sign, a duration that
 * rounds an hour away, an item name that carries angle brackets into the markup. They live
 * here as pure functions so the rules are stated once and tested once.
 */

/** Copper as the game writes it: gold, silver, copper, dropping the units that are noise. */
export function gold(copper) {
  const total = Math.max(Math.round(copper || 0), 0);
  const g = Math.floor(total / 10000);
  const s = Math.floor((total % 10000) / 100);
  const c = total % 100;
  if (g > 0) return `${g.toLocaleString()}g ${s}s`;
  if (s > 0) return `${s}s ${c}c`;
  return `${c}c`;
}

/** A net difference keeps its sign, so a segment that ended down on gold reads as a loss. */
export function signedGold(copper) {
  const value = Math.round(copper || 0);
  return value < 0 ? `-${gold(-value)}` : gold(value);
}

/** A wallet change worth mentioning at all: exactly zero is not news. */
export const isLoss = (copper) => Math.round(copper || 0) < 0;

export const signed = (amount) => `${amount >= 0 ? "+" : ""}${Number(amount || 0).toLocaleString()}`;

/**
 * A span of play, always carrying its units.
 *
 * A colon form — "17:17" — is unreadable beside the clock times it sits next to on a
 * segment, where it looks like another time of day rather than a length. Seconds are kept
 * below the hour because a keystone is won and lost in them, and dropped above it because
 * nobody reads an evening to the second.
 */
export function duration(seconds) {
  const total = Math.max(Math.round(seconds || 0), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return s ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
  return `${s}s`;
}

export const clock = (epoch) =>
  new Date((epoch || 0) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * A day as a person names it. Today and yesterday get their own words because a play
 * session that just happened is the one the eye is looking for.
 *
 * @param {string} day ISO `YYYY-MM-DD`, as the collector stores it.
 * @param {Date} [now] The moment to reckon "today" from; injected so the tests can pin it.
 */
export function dayLabel(day, now = new Date()) {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(day ?? "");
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((midnight - date) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The initials drawn inside a character's class circle. Names arrive as either "Aster" or
 * "Aster-Vale"; the realm suffix is a poor second letter, so only a real given-name break
 * contributes one.
 */
export function initials(name) {
  const bare = String(name || "").split("-")[0];
  return bare.slice(0, 2).toUpperCase() || "?";
}

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

/** Pluralises by count without the "1 items" tell. */
export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
