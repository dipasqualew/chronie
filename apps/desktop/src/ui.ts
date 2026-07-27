/**
 * The small pieces every view draws: a character's class circle, a highlight chip, the
 * badge on a location, the floating tooltip.
 *
 * These return HTML strings rather than nodes, because the views build their markup in one
 * pass and hand it to `innerHTML`; that keeps the rendering code readable as the shape of
 * the thing on screen. Everything user-supplied — a character name, an item name from the
 * game — goes through `escapeHtml` on the way in.
 */

import { activityIcon, activityLabel, activitySummary, isUncertain } from "./activities";
import type { PartialActivity } from "./activities";
import { clock, duration, escapeHtml, gold, initials, plural, signed, signedGold } from "./format";
import { highlights } from "./sessions";
import type { Highlight } from "./sessions";
import type { SessionCharacter } from "./sessions";
import type { Segment } from "./types";

/** The classes the stylesheet has a colour and an ink for, which is all thirteen of them. */
export const CLASS_FILES = [
  "DEATHKNIGHT", "DEMONHUNTER", "DRUID", "EVOKER", "HUNTER", "MAGE", "MONK",
  "PALADIN", "PRIEST", "ROGUE", "SHAMAN", "WARLOCK", "WARRIOR",
] as const;

/**
 * The attribute that puts a character's class colour on an element.
 *
 * The colour itself is not here, and deliberately: the packaged app's CSP carries a nonce
 * in `style-src`, which makes the browser ignore `'unsafe-inline'` and drop every `style=""`
 * attribute the page writes. So this hands the stylesheet a class rather than a colour, and
 * the stylesheet — nonced, and therefore trusted — turns it into `--class-color` and
 * `--class-ink`. Anything drawing in a class colour wants this and not a style attribute.
 *
 * A class the palette does not know still gets the attribute, empty. That is what makes it
 * fall to the muted grey rather than inherit the colour of the session around it.
 */
export function classAttr(classFile?: string | null): string {
  const known = CLASS_FILES.find((file) => file === classFile);
  return `data-class="${known ?? ""}"`;
}

/** "DEATHKNIGHT" is how the game files it and not how anyone says it. */
export function className(classFile?: string | null): string {
  if (!classFile) return "Unknown class";
  const spaced: Record<string, string> = { DEATHKNIGHT: "Death Knight", DEMONHUNTER: "Demon Hunter" };
  return spaced[classFile] || classFile.charAt(0) + classFile.slice(1).toLowerCase();
}

/** "none" for open world, else "instance"; used as a small badge on each segment. */
export const isInstance = (segment: Segment): boolean =>
  !!segment.instanceType && segment.instanceType !== "none";
export const locationType = (segment: Segment): string => (isInstance(segment) ? "instance" : "world");

export const classDot = (classFile?: string | null): string =>
  `<span class="dot" ${classAttr(classFile)}></span>`;

/**
 * A character as a circle filled with their class colour, carrying everything the hover
 * card needs.
 *
 * Focusable and named, so the detail is reachable without a mouse: the circle is the only
 * place a session says which characters were involved, and that must not be hover-only.
 */
export function characterCircle(character: SessionCharacter): string {
  const parts = [
    `${className(character.classFile)}${character.level == null ? "" : ` · level ${character.level}`}`,
    `${duration(character.seconds)} played`,
    plural(character.segmentCount, "segment"),
  ];
  if (character.lootValue) parts.push(`${gold(character.lootValue)} looted`);
  if (character.goldDiff) parts.push(`${signedGold(character.goldDiff)} in the wallet`);
  const places = (character.places || []).slice(0, 4).join(", ");
  const tip = `<b>${escapeHtml(character.name)}</b>${parts.map(escapeHtml).join(" · ")}` +
    (places ? `<span class="tip-places">${escapeHtml(places)}</span>` : "");
  const label = `${character.name}, ${parts.join(", ")}`;
  return `<span class="circle" role="img" tabindex="0" ${classAttr(character.classFile)}
    aria-label="${escapeHtml(label)}" data-tip="${escapeHtml(tip)}"
  >${escapeHtml(initials(character.name))}</span>`;
}

/* ---------- highlights ---------- */

/** How a running total reads: copper as gold, everything else as a signed count. */
export function highlightValue(entry: Highlight): string {
  const value = entry.value ?? 0;
  if (entry.kind === "gold") return signedGold(value);
  if (entry.kind === "loot") return gold(value);
  return signed(value);
}

/**
 * One thing worth remembering, or one summary of several.
 *
 * A summary that stands for a single thing takes you straight to the segment it happened
 * in, because that is the only place left to go. One that stands for twelve unfolds into
 * the twelve instead — the count is what a session card is for, and the names are what the
 * reader came back for.
 *
 * @param scope Namespaces the panel's id, so two sessions on screen do not share one.
 */
export function highlightChip(entry: Highlight, { scope, expanded, interactive }: ChipOptions): string {
  const detail = entry.detail ? ` <span class="detail">${escapeHtml(entry.detail)}</span>` : "";
  const body = `<span class="hl-icon" aria-hidden="true">${entry.icon}</span>` +
    `<span class="hl-label">${escapeHtml(entry.label)}</span>${detail}`;
  if (!interactive) return `<span class="hl hl-${escapeHtml(entry.kind)}">${body}</span>`;
  if (entry.segmentId != null) {
    return `<button type="button" class="hl hl-${escapeHtml(entry.kind)}"
      data-open-segment="${entry.segmentId}">${body}</button>`;
  }
  const open = expanded === entry.kind;
  return `<button type="button" class="hl hl-${escapeHtml(entry.kind)}${open ? " open" : ""}"
    data-unfold="${escapeHtml(entry.kind)}" aria-expanded="${open}"
    aria-controls="${escapeHtml(panelId(scope, entry.kind))}"
    >${body}<span class="hl-caret" aria-hidden="true">${open ? "▾" : "▸"}</span></button>`;
}

const panelId = (scope: string, kind: string): string => `hl-${scope}-${kind}`;

/**
 * What a summary unfolds into: every thing it counted, newest information first, each one a
 * way back to the segment it was recorded in.
 */
export function highlightPanel(entry: Highlight, scope: string): string {
  const rows = entry.items.map((item) => {
    const meta = [item.detail, item.character, item.at == null ? "" : clock(item.at)].filter(Boolean);
    return `<li><button type="button" class="hl-item" data-open-segment="${item.segmentId}"
      aria-label="Open the segment ${escapeHtml(item.label)} was recorded in">
      <span class="hl-item-name">${escapeHtml(item.label)}</span>
      <span class="hl-item-meta">${escapeHtml(meta.join(" · "))}</span>
    </button></li>`;
  }).join("");
  return `<ul class="hl-panel" id="${escapeHtml(panelId(scope, entry.kind))}">${rows}</ul>`;
}

/** A running total, drawn quieter than a milestone because it is context, not news. */
export function tallyItem(entry: Highlight): string {
  const tone = entry.kind === "gold" && (entry.value ?? 0) < 0
    ? " loss"
    : (entry.kind === "gold" ? " gold" : "");
  return `<span class="tally">
    <span class="tally-icon" aria-hidden="true">${entry.icon}</span>
    <span class="tally-label">${escapeHtml(entry.label)}</span>
    <span class="tally-value${tone}">${escapeHtml(highlightValue(entry))}</span>
  </span>`;
}

interface ChipOptions {
  scope: string;
  expanded?: string | null;
  interactive?: boolean;
}

export interface HighlightListOptions {
  /**
   * Namespaces the ids of any panels drawn, so two sessions on screen do not collide.
   * Required whenever `interactive`, and ignored otherwise.
   */
  scope?: string;
  /** False for the detail modal, which lists every milestone in full a few lines down. */
  milestones?: boolean;
  /** False on a segment row, where the numbers would drown the two things that happened. */
  tallies?: boolean;
  /** The kind whose things are unfolded beneath the chips, when one is. */
  expanded?: string | null;
  /** False inside a segment row, which is itself one button and can hold no others. */
  interactive?: boolean;
}

/**
 * Draws a set of highlights: the milestones as summary chips, the totals as a quiet strip
 * beneath, and — where the reader has asked for one — the things behind a summary.
 *
 * There is no cap, because there is nothing left to cap: a summary per kind is nine chips
 * at the very most, however long the evening was.
 *
 * `milestones: false` is for the detail modal, which lists every one of them in full a few
 * lines further down — repeating them as chips first would only make the same page longer.
 */
export function highlightList(
  entries: Highlight[],
  {
    scope = "", milestones: withChips = true, tallies: withTallies = true,
    expanded = null, interactive = true,
  }: HighlightListOptions = {},
): string {
  const milestones = withChips ? entries.filter((entry) => entry.family === "milestone") : [];
  const tallies = withTallies ? entries.filter((entry) => entry.family === "tally") : [];
  const parts: string[] = [];
  if (milestones.length) {
    parts.push(`<div class="hl-row">${milestones
      .map((entry) => highlightChip(entry, { scope, expanded, interactive })).join("")}</div>`);
    const unfolded = interactive
      ? milestones.find((entry) => entry.kind === expanded && entry.segmentId == null)
      : undefined;
    if (unfolded) parts.push(highlightPanel(unfolded, scope));
  }
  if (tallies.length) {
    parts.push(`<div class="tally-row">${tallies.map(tallyItem).join("")}</div>`);
  }
  return parts.join("");
}

/* ---------- standings ---------- */

/** As much of a standing as anything drawing one needs: the level, and where inside it. */
export interface Standing {
  /** The level's own name — "Honored", "Renown 12", "Best Friend". */
  standing?: string | null;
  current?: number | null;
  max?: number | null;
}

/**
 * Where a standing sits inside its own level, as a bar with the level's name beside it.
 *
 * The pair of numbers is a position inside one level rather than a faction's whole
 * reputation — the addon has already decided which of the client's reputation systems
 * answers for this faction and reduced its answer to that shape — so the bar is always read
 * the same way whether the level is Honored, Renown 12 or a friendship rank.
 *
 * A standing the client could not place gets nothing at all: an account-wide line read on a
 * character that has never met the faction has no standing to draw, and an empty track would
 * claim they were at the bottom of one.
 *
 * A standing whose level has no length to it — the client named the level and said nothing
 * about how long it is — gets its name and no bar, for the same reason. A bar drawn at zero
 * is announced as zero per cent, which is a claim about where the character stands, and the
 * one thing known here is that nobody knows.
 */
export function standingBar(standing: Standing, faction: string): string {
  const max = Math.max(standing.max || 0, 0);
  const current = Math.min(Math.max(standing.current || 0, 0), max);
  if (!standing.standing && max === 0) return "";
  const bar = max === 0 ? "" : `<progress class="rep-bar" value="${current}" max="${max}"
      aria-label="${escapeHtml(`${standing.standing || "Standing"} with ${faction}`)}"></progress>`;
  const numbers = max > 0 ? `${current.toLocaleString()} / ${max.toLocaleString()}` : "";
  const caption = [standing.standing, numbers].filter(Boolean).join(" ");
  return `<p class="rep-standing">
    ${bar}
    <span class="muted">${escapeHtml(caption)}</span>
  </p>`;
}

/* ---------- activities ---------- */

/**
 * A guess the backend was unsure about is drawn with a dashed border and says so in its
 * tooltip, so the eye can tell "Chronie thinks" apart from "I said so" at a glance.
 */
export function activityChip(activity: PartialActivity): string {
  const detail = activitySummary(activity);
  const guess = isUncertain(activity);
  const title = activity.source === "manual"
    ? "You set this activity"
    : `Guessed by Chronie · confidence ${Math.round((activity.confidence ?? 1) * 100)}%`;
  return `<span class="chip activity${guess ? " guess" : ""}" title="${escapeHtml(title)}">` +
    `${escapeHtml(activityIcon(activity.kind))} ${escapeHtml(activityLabel(activity.kind))}` +
    (detail ? ` <span class="detail">${escapeHtml(detail)}</span>` : "") +
    "</span>";
}

export const activityText = (activities?: PartialActivity[]): string =>
  (activities || []).map((activity) => {
    const detail = activitySummary(activity);
    return activityLabel(activity.kind) + (detail ? ` (${detail})` : "");
  }).join(", ");

/* ---------- a segment, as one row ---------- */

/**
 * A segment summarised the way its session is, and clickable for the same reason: the detail
 * modal it opens is where the summary comes apart, so the chips here stay inert — they are
 * what the row says, not another thing to press inside a thing to press.
 *
 * It lives here rather than in either view because both draw it: an evening on the timeline
 * unfolds into these rows, and so does a character on the roster. One row means a change to
 * what a segment says at a glance lands in both places at once, which is the only way the
 * two can be relied on to agree.
 *
 * The running totals are left off. On one segment they are four more numbers beside two
 * things that actually happened, and the modal has them a click away.
 *
 * The row carries its own character's class, not the surrounding view's: an evening spent on
 * three characters is exactly when the rail down the left of each row is worth having, and it
 * would say the opposite of the truth if every row took the colour of whoever led.
 */
export function segmentButton(segment: Segment): string {
  const label = `${segment.character} in ${segment.instance} at ${clock(segment.startedAt)}`;
  const summary = highlightList(highlights([segment]), { tallies: false, interactive: false });
  return `<button type="button" class="seg" data-open-segment="${segment.segmentId}"
    ${classAttr(segment.classFile)}
    aria-label="Open segment: ${escapeHtml(label)}">
    <span class="seg-time">${escapeHtml(clock(segment.startedAt))}</span>
    <span class="seg-body">
      <span class="seg-head">
        <span class="seg-who">${classDot(segment.classFile)}${escapeHtml(segment.character)}</span>
        <span class="seg-where">${escapeHtml(segment.instance)}</span>
        <span class="badge">${escapeHtml(locationType(segment))}</span>
        ${segment.difficulty ? `<span class="muted">${escapeHtml(segment.difficulty)}</span>` : ""}
      </span>
      <span class="seg-activities">${(segment.activities || []).map(activityChip).join("") ||
        '<span class="muted">No activity recorded</span>'}</span>
      ${summary ? `<span class="seg-summary">${summary}</span>` : ""}
    </span>
    <span class="seg-dur">${escapeHtml(duration(segment.seconds))}</span>
  </button>`;
}

/* ---------- the floating tooltip ---------- */

let tooltip: HTMLElement | null = null;

/** The nearest thing carrying a tip, for an event that may have fired on the document. */
function hostOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
}

/**
 * Wires the one floating tooltip to everything carrying `data-tip`, by delegation, so
 * repainting a view never has to re-attach anything. The tip's value is trusted HTML built
 * by the caller — every one of them escapes what came from the game first.
 */
export function installTooltip(): void {
  tooltip = document.getElementById("tooltip");
  const hide = (): void => { if (tooltip) tooltip.style.opacity = "0"; };
  const show = (event: Event): void => {
    const host = hostOf(event.target);
    if (!host || !tooltip) return hide();
    tooltip.innerHTML = host.dataset.tip ?? "";
    tooltip.style.opacity = "1";
    const box = tooltip.getBoundingClientRect();
    // Focus has no pointer position of its own, so the tip is hung off the element instead.
    const pointer = event as MouseEvent;
    const anchor = pointer.clientX ? { x: pointer.clientX, y: pointer.clientY } : anchorOf(host);
    tooltip.style.left = `${Math.max(Math.min(anchor.x + 14, window.innerWidth - box.width - 8), 8)}px`;
    tooltip.style.top = `${Math.max(anchor.y - box.height - 12, 8)}px`;
  };
  document.addEventListener("mousemove", show);
  document.addEventListener("mouseleave", hide);
  document.addEventListener("focusin", (event) => {
    if (hostOf(event.target)) show(event);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("scroll", hide, true);
}

function anchorOf(host: HTMLElement): { x: number; y: number } {
  const box = host.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top };
}
