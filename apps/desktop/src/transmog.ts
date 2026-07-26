/**
 * The transmog view: every set the installed game knows about.
 *
 * This is the one view that reads the game's own files rather than the addon's history, so
 * it shows what exists rather than what a character has collected. The backend hands over a
 * flat list; everything below is how it gets grouped, filtered and named.
 */

import { escapeHtml, plural } from "./format";
import type { TransmogPayload, TransmogSet } from "./types";

/**
 * The classes, in the order the game's class mask numbers them.
 *
 * A set's mask is a bit per class from this list; a mask of zero belongs to no class in
 * particular, which is how the game marks the sets anyone can wear.
 */
const CLASSES = [
  "Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Death Knight", "Shaman",
  "Mage", "Warlock", "Monk", "Druid", "Demon Hunter", "Evoker",
] as const;

/** Every class at once, which the game writes as a full mask rather than as zero. */
const ALL_CLASSES = (1 << CLASSES.length) - 1;

/** The expansions, indexed by the id the game files use. */
const EXPANSIONS = [
  "Classic", "The Burning Crusade", "Wrath of the Lich King", "Cataclysm",
  "Mists of Pandaria", "Warlords of Draenor", "Legion", "Battle for Azeroth",
  "Shadowlands", "Dragonflight", "The War Within", "Midnight",
] as const;

/**
 * The armour a class wears, used to label the masks that pick out exactly one kind. Those
 * four masks account for most of the sets in the game, and "Cloth" reads better than a list
 * of three class names.
 */
const ARMOUR = new Map<number, string>([
  [0x0190, "Cloth"],
  [0x0e08, "Leather"],
  [0x1044, "Mail"],
  [0x0023, "Plate"],
]);

export function expansionName(id: number): string {
  return EXPANSIONS[id] ?? `Expansion ${id}`;
}

/** The classes a mask picks out, as names. */
export function classNames(mask: number): string[] {
  return CLASSES.filter((_, index) => (mask & (1 << index)) !== 0);
}

/** A short label for who a set is for. */
export function classLabel(mask: number): string {
  if (mask === 0 || mask === ALL_CLASSES) return "Any class";
  const armour = ARMOUR.get(mask);
  if (armour) return armour;
  const names = classNames(mask);
  if (names.length === 0) return "Any class";
  if (names.length <= 2) return names.join(" & ");
  return `${names.length} classes`;
}

/** The patch a set arrived in, which the game stores as one packed number. */
export function patchName(packed: number): string {
  if (!packed) return "";
  const major = Math.floor(packed / 10000);
  const minor = Math.floor(packed / 100) % 100;
  const patch = packed % 100;
  return `${major}.${minor}.${patch}`;
}

export interface TransmogElements {
  meta: HTMLElement;
  search: HTMLInputElement;
  expansion: HTMLSelectElement;
  klass: HTMLSelectElement;
  list: HTMLElement;
  empty: HTMLElement;
  count: HTMLElement;
}

export interface TransmogView {
  /** Draws a loaded payload. */
  render(payload: TransmogPayload): void;
  /** Draws the state the view is in before, or instead of, a payload. */
  status(message: string): void;
}

/** The sets a filter leaves, in the order the backend already sorted them. */
export function filterSets(
  sets: TransmogSet[],
  filters: { search: string; expansion: string; klass: string },
): TransmogSet[] {
  const search = filters.search.trim().toLowerCase();
  const expansion = filters.expansion === "" ? null : Number(filters.expansion);
  const klass = filters.klass === "" ? null : Number(filters.klass);
  return sets.filter((set) => {
    if (expansion !== null && set.expansionId !== expansion) return false;
    // A set with no class of its own is for everyone, so it survives a class filter.
    if (klass !== null && set.classMask !== 0 && (set.classMask & (1 << klass)) === 0) return false;
    if (!search) return true;
    return set.name.toLowerCase().includes(search) || set.group.toLowerCase().includes(search);
  });
}

/** Groups sets under their collection, keeping both orders the backend chose. */
export function groupSets(sets: TransmogSet[]): Array<{ group: string; sets: TransmogSet[] }> {
  const groups: Array<{ group: string; sets: TransmogSet[] }> = [];
  const byName = new Map<string, TransmogSet[]>();
  for (const set of sets) {
    const name = set.group || "Ungrouped";
    let bucket = byName.get(name);
    if (!bucket) {
      bucket = [];
      byName.set(name, bucket);
      groups.push({ group: name, sets: bucket });
    }
    bucket.push(set);
  }
  return groups;
}

export function createTransmog(elements: TransmogElements): TransmogView {
  let loaded: TransmogPayload | null = null;

  function draw(): void {
    if (!loaded) return;
    const sets = filterSets(loaded.sets, {
      search: elements.search.value,
      expansion: elements.expansion.value,
      klass: elements.klass.value,
    });

    elements.count.textContent = `${plural(sets.length, "set")} shown`;
    elements.empty.hidden = sets.length > 0;
    if (sets.length === 0) {
      elements.empty.innerHTML = '<p class="empty-title">Nothing matches</p>'
        + "<p>Try a different search, class or expansion.</p>";
      elements.list.innerHTML = "";
      return;
    }

    elements.list.innerHTML = groupSets(sets).map((group) => `
      <section class="mog-group">
        <h3>${escapeHtml(group.group)}<span class="muted"> · ${plural(group.sets.length, "set")}</span></h3>
        <div class="mog-grid">
          ${group.sets.map(card).join("")}
        </div>
      </section>`).join("");
  }

  function card(set: TransmogSet): string {
    const patch = patchName(set.patchIntroduced);
    const classes = classNames(set.classMask);
    return `<article class="mog-card"${classes.length ? ` title="${escapeHtml(classes.join(", "))}"` : ""}>
      <h4>${escapeHtml(set.name) || '<span class="muted">Unnamed set</span>'}</h4>
      <div class="mog-facts">
        <span class="chip">${escapeHtml(classLabel(set.classMask))}</span>
        <span class="chip">${escapeHtml(expansionName(set.expansionId))}</span>
        ${patch ? `<span class="chip">Patch ${escapeHtml(patch)}</span>` : ""}
      </div>
      <div class="mog-foot">
        <span>${plural(set.itemCount, "appearance")}</span>
        <span class="muted">#${set.id}</span>
      </div>
    </article>`;
  }

  for (const control of [elements.search, elements.expansion, elements.klass]) {
    control.addEventListener("input", draw);
    control.addEventListener("change", draw);
  }

  return {
    render(payload) {
      loaded = payload;

      // Only offer the expansions and classes this install actually has sets for.
      const expansions = [...new Set(payload.sets.map((set) => set.expansionId))].sort((a, b) => b - a);
      elements.expansion.innerHTML = '<option value="">All expansions</option>'
        + expansions.map((id) => `<option value="${id}">${escapeHtml(expansionName(id))}</option>`).join("");
      elements.klass.innerHTML = '<option value="">All classes</option>'
        + CLASSES.map((name, index) => `<option value="${index}">${escapeHtml(name)}</option>`).join("");

      const withheld = payload.withheldCount > 0
        ? ` · ${plural(payload.withheldCount, "set")} the game keeps encrypted`
        : "";
      elements.meta.textContent =
        `${plural(payload.sets.length, "set")} from the installed game${withheld}`;
      draw();
    },
    status(message) {
      loaded = null;
      elements.meta.textContent = message;
      elements.list.innerHTML = "";
      elements.count.textContent = "";
      elements.empty.hidden = true;
    },
  };
}
