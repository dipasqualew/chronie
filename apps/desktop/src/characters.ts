/**
 * The characters view: who has been played, and what is known about each of them.
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
 * the folding rules are tested. Everything below it is the drawing.
 */

import { ago, dayLabel, duration, escapeHtml, gold, initials, plural, signedGold } from "./format";
import { highlights } from "./sessions";
import type { Highlight } from "./sessions";
import type { OpenSegment } from "./timeline";
import type { AccountHoldings, CharacterStanding, Segment } from "./types";
import { classAttr, className, highlightList, segmentButton, standingBar } from "./ui";

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

/* ---------- the view ---------- */

export interface CharactersElements {
  /** The line under the heading saying how much of a roster this is. */
  meta: HTMLElement;
  /** The roster down the left. */
  list: HTMLElement;
  /** The chosen character's own page, on the right. */
  detail: HTMLElement;
}

export interface CharactersOptions {
  elements: CharactersElements;
  /**
   * Given the segment to show and the character's own segments, so the modal's next and
   * previous walk that character's history rather than everybody's.
   */
  onOpenSegment: OpenSegment;
}

export interface CharactersView {
  render: (segments: Segment[], holdings?: AccountHoldings) => void;
}

/** Only one summary is ever unfolded here, so its panels need only one namespace. */
const SCOPE = "character";

export function createCharacters({ elements, onOpenSegment }: CharactersOptions): CharactersView {
  let profiles: CharacterProfile[] = [];
  // Held by name rather than by index: an activity edit repaints the whole view, and the
  // reader should come back to the character they were reading, wherever they have moved to
  // in the roster since.
  let chosen: string | null = null;
  let unfolded: string | null = null;

  const current = (): CharacterProfile | undefined =>
    profiles.find((entry) => entry.name === chosen) ?? profiles[0];

  function draw(): void {
    const showing = current();
    chosen = showing?.name ?? null;

    elements.list.innerHTML = profiles.length
      ? `<ul class="roster-list">${profiles
        .map((entry) => `<li>${rosterEntry(entry, entry.name === chosen)}</li>`).join("")}</ul>`
      : '<p class="empty">No characters yet. Play for a bit and Chronie will fill this in.</p>';
    elements.detail.innerHTML = showing
      ? page(showing, unfolded)
      : '<p class="empty">Nothing to show until a character has been played.</p>';

    elements.list.querySelectorAll<HTMLElement>("[data-character]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.character === chosen) return;
        chosen = button.dataset.character ?? null;
        // A summary unfolded on one character means nothing on the next, so picking somebody
        // else starts them folded rather than opening a panel nobody asked for.
        unfolded = null;
        draw();
      });
    });
    elements.detail.querySelectorAll<HTMLElement>("[data-unfold]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.dataset.unfold;
        unfolded = unfolded === kind ? null : kind ?? null;
        draw();
      });
    });
    // A summary chip, one of the things it unfolded into, and a segment row all open the
    // modal, and all three walk the same list: this character's own segments.
    elements.detail.querySelectorAll<HTMLElement>("[data-open-segment]").forEach((button) => {
      button.addEventListener("click", () => {
        onOpenSegment(Number(button.dataset.openSegment), showing?.segments || []);
      });
    });
  }

  return {
    render(segments, holdings) {
      profiles = buildCharacters(segments, holdings);
      elements.meta.textContent = profiles.length
        ? [
          plural(profiles.length, "character"),
          plural(profiles.reduce((total, entry) => total + entry.segmentCount, 0), "segment"),
          `${duration(profiles.reduce((total, entry) => total + entry.seconds, 0))} played`,
        ].join(" · ")
        : "Nothing collected yet.";
      draw();
    },
  };
}

/**
 * One character in the roster: the class circle, who they are, and the numbers worth reading
 * without opening them.
 *
 * The circle is decorative here, unlike the one on a session card — the row spells the name
 * out beside it, and a focusable thing inside a button is a thing a keyboard cannot reach
 * past. The whole entry is the button instead, named with everything the eye gets.
 */
function rosterEntry(entry: CharacterProfile, chosen: boolean): string {
  const facts = [
    `${className(entry.classFile)}${entry.level == null ? "" : ` · level ${entry.level}`}`,
    `${duration(entry.seconds)} played`,
    plural(entry.segmentCount, "segment"),
    `last played ${ago(entry.lastSeen)}`,
  ];
  return `<button type="button" class="roster-entry" data-character="${escapeHtml(entry.name)}"
    ${classAttr(entry.classFile)} aria-pressed="${chosen}"
    aria-label="${escapeHtml(`${entry.name}, ${facts.join(", ")}`)}">
    <span class="circle" aria-hidden="true">${escapeHtml(initials(entry.name))}</span>
    <span class="roster-who">
      <span class="roster-name">${escapeHtml(entry.name)}</span>
      <span class="roster-class muted">${escapeHtml(facts[0])}</span>
    </span>
    <span class="roster-numbers">
      <span class="roster-played">${escapeHtml(duration(entry.seconds))}</span>
      <span class="muted">${escapeHtml(plural(entry.segmentCount, "segment"))}</span>
    </span>
  </button>`;
}

/** One row of the fact grid: dropped entirely rather than drawn as a dash when unknown. */
const stat = (label: string, value: string): string =>
  `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;

/** Everything known about the chosen character, and everything they did. */
function page(entry: CharacterProfile, unfolded: string | null): string {
  const where = entry.places.slice(0, 3).join(", ");
  return `<header class="profile-head" ${classAttr(entry.classFile)}>
    <span class="circle" aria-hidden="true">${escapeHtml(initials(entry.name))}</span>
    <div>
      <h2>${escapeHtml(entry.name)}</h2>
      <p class="sub">${escapeHtml(className(entry.classFile))}${
        entry.level == null ? "" : ` · level ${escapeHtml(entry.level)}`
      } · last played ${escapeHtml(ago(entry.lastSeen))}</p>
    </div>
  </header>
  <dl class="profile-stats">
    ${stat("Played", escapeHtml(duration(entry.seconds)))}
    ${stat("Segments", escapeHtml(String(entry.segmentCount)))}
    ${stat("Days", escapeHtml(String(entry.dayCount)))}
    ${stat("First seen", escapeHtml(dayLabel(dayOf(entry.firstSeen))))}
    ${stat("Looted", `<span class="gold">${escapeHtml(gold(entry.lootValue))}</span>`)}
    ${stat("Wallet", `<span class="${entry.goldDiff < 0 ? "loss" : "gold"}">${
      escapeHtml(signedGold(entry.goldDiff))}</span>`)}
  </dl>
  ${where ? `<p class="profile-where sub">Mostly in ${escapeHtml(where)}</p>` : ""}
  <div class="profile-highlights">${
    highlightList(entry.highlights, { scope: SCOPE, expanded: unfolded }) ||
    '<p class="muted">Nothing gained or collected yet.</p>'}</div>
  ${currencySection(entry)}
  ${factionSection(entry)}
  <section class="detail-section profile-segments">
    <h3>${escapeHtml(plural(entry.segmentCount, "segment"))}</h3>
    ${byDay(entry.segments).map((group) => `<section class="profile-day">
      <h4>${escapeHtml(dayLabel(group.day))}</h4>
      <ol class="segment-rows">${group.segments
        .map((segment) => `<li>${segmentButton(segment)}</li>`).join("")}</ol>
    </section>`).join("")}
  </section>`;
}

/**
 * What the character is carrying, against what the account has altogether.
 *
 * The account total is only worth saying when somebody else holds some too: on a currency
 * only this character has ever picked up, it is the number already on the line.
 */
function currencySection(entry: CharacterProfile): string {
  if (!entry.currencies.length) return "";
  return `<section class="detail-section">
    <h3>Currencies</h3>
    <ul>${entry.currencies.map((held) => {
      const elsewhere = held.accountTotal > held.total
        ? ` · ${held.accountTotal.toLocaleString()} across the account`
        : "";
      const read = held.at ? ` · read ${ago(held.at)}` : "";
      return `<li>🪙 ${escapeHtml(held.name)} <strong>${escapeHtml(held.total.toLocaleString())}</strong>
        <span class="muted">${escapeHtml(elsewhere + read)}</span></li>`;
    }).join("")}</ul>
  </section>`;
}

/** Where the character stands with everyone they have met, and where they lead the account. */
function factionSection(entry: CharacterProfile): string {
  if (!entry.factions.length) return "";
  return `<section class="detail-section">
    <h3>Reputation</h3>
    <ul>${entry.factions.map((standing) => `<li>
      🎖️ ${escapeHtml(standing.faction)}
      ${standing.leads ? '<span class="chip">furthest on the account</span>' : ""}
      ${standingBar(standing, standing.faction)}
    </li>`).join("")}</ul>
  </section>`;
}

/** The day a moment falls on, in the `YYYY-MM-DD` a segment writes its own day as. */
function dayOf(epoch: number): string {
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
