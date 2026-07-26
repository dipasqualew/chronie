/**
 * The small pieces every view draws: a character's class circle, a highlight chip, the
 * badge on a location, the floating tooltip.
 *
 * These return HTML strings rather than nodes, because the views build their markup in one
 * pass and hand it to `innerHTML`; that keeps the rendering code readable as the shape of
 * the thing on screen. Everything user-supplied — a character name, an item name from the
 * game — goes through `escapeHtml` on the way in.
 */

import { activityIcon, activityLabel, activitySummary, isUncertain } from "./activities.js";
import { duration, escapeHtml, gold, initials, plural, signed, signedGold } from "./format.js";

/** The client's own class colours, so a character reads the same here as in game. */
export const CLASS_COLORS = {
  DEATHKNIGHT: "#c41e3a", DEMONHUNTER: "#a330c9", DRUID: "#ff7c0a", EVOKER: "#33937f",
  HUNTER: "#aad372", MAGE: "#3fc7eb", MONK: "#00ff98", PALADIN: "#f48cba",
  PRIEST: "#ffffff", ROGUE: "#fff468", SHAMAN: "#0070dd", WARLOCK: "#8788ee",
  WARRIOR: "#c69b6d",
};

export const classColor = (classFile) => CLASS_COLORS[classFile] || "var(--text-muted)";

/** "DEATHKNIGHT" is how the game files it and not how anyone says it. */
export function className(classFile) {
  if (!classFile) return "Unknown class";
  const spaced = { DEATHKNIGHT: "Death Knight", DEMONHUNTER: "Demon Hunter" }[classFile];
  return spaced || classFile.charAt(0) + classFile.slice(1).toLowerCase();
}

/** "none" for open world, else "instance"; used as a small badge on each segment. */
export const isInstance = (segment) => !!segment.instanceType && segment.instanceType !== "none";
export const locationType = (segment) => (isInstance(segment) ? "instance" : "world");

export const classDot = (classFile) =>
  `<span class="dot" style="background:${classColor(classFile)}"></span>`;

/**
 * A character as a circle in their class colour, carrying everything the hover card needs.
 *
 * Focusable and named, so the detail is reachable without a mouse: the circle is the only
 * place a session says which characters were involved, and that must not be hover-only.
 */
export function characterCircle(character) {
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
  return `<span class="circle" role="img" tabindex="0"
    style="--class-color:${classColor(character.classFile)}"
    aria-label="${escapeHtml(label)}" data-tip="${escapeHtml(tip)}"
  >${escapeHtml(initials(character.name))}</span>`;
}

/* ---------- highlights ---------- */

/** How a running total reads: copper as gold, everything else as a signed count. */
export function highlightValue(entry) {
  if (entry.kind === "gold") return signedGold(entry.value);
  if (entry.kind === "loot") return gold(entry.value);
  return signed(entry.value);
}

/**
 * One thing worth remembering. A highlight that came from a single known segment is a
 * button, because clicking it should take you to where it happened; one summed across a
 * whole evening has nowhere to go and stays a plain chip.
 */
export function highlightChip(entry) {
  const open = entry.segmentId != null;
  const tag = open ? "button" : "span";
  const detail = entry.detail
    ? ` <span class="detail">${escapeHtml(entry.detail)}</span>`
    : "";
  return `<${tag} class="hl hl-${escapeHtml(entry.kind)}"${open
    ? ` type="button" data-open-segment="${entry.segmentId}"`
    : ""}>` +
    `<span class="hl-icon" aria-hidden="true">${entry.icon}</span>` +
    `<span class="hl-label">${escapeHtml(entry.label)}</span>${detail}` +
    `</${tag}>`;
}

/** A running total, drawn quieter than a milestone because it is context, not news. */
export function tallyItem(entry) {
  const tone = entry.kind === "gold" && entry.value < 0 ? " loss" : (entry.kind === "gold" ? " gold" : "");
  return `<span class="tally">
    <span class="tally-icon" aria-hidden="true">${entry.icon}</span>
    <span class="tally-label">${escapeHtml(entry.label)}</span>
    <span class="tally-value${tone}">${escapeHtml(highlightValue(entry))}</span>
  </span>`;
}

/**
 * Draws a set of highlights: the milestones as chips, the totals as a quiet strip beneath.
 * `limit` caps the chips on a crowded session, with the remainder counted rather than lost.
 *
 * `milestones: false` is for the detail modal, which lists every one of them in full a few
 * lines further down — repeating them as chips first would only make the same page longer.
 */
export function highlightList(entries, { limit = Infinity, milestones: withChips = true } = {}) {
  const milestones = withChips ? entries.filter((entry) => entry.family === "milestone") : [];
  const tallies = entries.filter((entry) => entry.family === "tally");
  const shown = milestones.slice(0, limit);
  const hidden = milestones.length - shown.length;
  const parts = [];
  if (shown.length) {
    parts.push(`<div class="hl-row">${shown.map(highlightChip).join("")}` +
      (hidden > 0 ? `<span class="hl hl-more">+${hidden} more</span>` : "") +
      "</div>");
  }
  if (tallies.length) {
    parts.push(`<div class="tally-row">${tallies.map(tallyItem).join("")}</div>`);
  }
  return parts.join("");
}

/* ---------- activities ---------- */

/**
 * A guess the backend was unsure about is drawn with a dashed border and says so in its
 * tooltip, so the eye can tell "Chronie thinks" apart from "I said so" at a glance.
 */
export function activityChip(activity) {
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

export const activityText = (activities) =>
  (activities || []).map((activity) => {
    const detail = activitySummary(activity);
    return activityLabel(activity.kind) + (detail ? ` (${detail})` : "");
  }).join(", ");

/* ---------- the floating tooltip ---------- */

let tooltip = null;

/**
 * Wires the one floating tooltip to everything carrying `data-tip`, by delegation, so
 * repainting a view never has to re-attach anything. The tip's value is trusted HTML built
 * by the caller — every one of them escapes what came from the game first.
 */
export function installTooltip() {
  tooltip = document.getElementById("tooltip");
  const show = (event) => {
    const host = event.target.closest?.("[data-tip]");
    if (!host) return hide();
    tooltip.innerHTML = host.dataset.tip;
    tooltip.style.opacity = "1";
    const box = tooltip.getBoundingClientRect();
    const anchor = event.clientX ? { x: event.clientX, y: event.clientY } : anchorOf(host);
    tooltip.style.left = `${Math.max(Math.min(anchor.x + 14, window.innerWidth - box.width - 8), 8)}px`;
    tooltip.style.top = `${Math.max(anchor.y - box.height - 12, 8)}px`;
  };
  const hide = () => { if (tooltip) tooltip.style.opacity = "0"; };
  document.addEventListener("mousemove", show);
  document.addEventListener("mouseleave", hide);
  // Focus has no pointer position of its own, so the tip is hung off the element instead.
  document.addEventListener("focusin", (event) => {
    if (event.target.closest?.("[data-tip]")) show(event);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("scroll", hide, true);
}

function anchorOf(host) {
  const box = host.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top };
}
