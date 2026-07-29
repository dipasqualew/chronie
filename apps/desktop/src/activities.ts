/**
 * How an activity reads on screen, and what its editor offers.
 *
 * Kept out of the components so it can be tested without a browser: everything here is a pure
 * function of an activity, which is the only part of the feature worth a unit test. The
 * inference itself lives in the Rust backend — this module never guesses, it only presents.
 */

import type { Activity, ActivityMetadata } from "./types";

export type ActivityFieldType = "text" | "number" | "boolean";

export interface ActivityField {
  key: string;
  label: string;
  type: ActivityFieldType;
}

export interface ActivityKind {
  label: string;
  icon: string;
  fields: ActivityField[];
}

/** Anything carrying enough of an activity to be described; the editor's rows are not whole. */
export type PartialActivity = Partial<Activity>;

/**
 * The kinds the backend can guess at, with a human name and the metadata fields the editor
 * should offer for each. A kind the user types in themselves is still perfectly valid; it
 * simply falls back to a title-cased label and free-form key/value editing.
 *
 * `fields` is the whole reason this table exists: without it every activity would be edited
 * as raw JSON, and a keystone level would be as awkward to correct as it is easy to see.
 *
 * Typed by its values rather than its keys: a lookup here always has to admit that the kind
 * may be one the user invented, which is exactly what the `| undefined` says.
 */
export const ACTIVITY_KINDS: Record<string, ActivityKind | undefined> = {
  mythic_plus: {
    label: "Mythic+ run",
    icon: "🔑",
    fields: [
      { key: "dungeon", label: "Dungeon", type: "text" },
      { key: "keystoneLevel", label: "Keystone level", type: "number" },
      { key: "timed", label: "Beat the timer", type: "boolean" },
      { key: "upgrades", label: "Key upgrades", type: "number" },
      { key: "durationSeconds", label: "Duration (seconds)", type: "number" },
    ],
  },
  progress_raid: {
    label: "Progress raid",
    icon: "⚔️",
    fields: [
      { key: "raid", label: "Raid", type: "text" },
      { key: "difficulty", label: "Difficulty", type: "text" },
      { key: "bossesKilled", label: "Bosses killed", type: "number" },
      { key: "wipes", label: "Wipes", type: "number" },
    ],
  },
  legacy_raid: {
    label: "Legacy raid",
    icon: "🏛️",
    fields: [
      { key: "raid", label: "Raid", type: "text" },
      { key: "difficulty", label: "Difficulty", type: "text" },
      { key: "bossesKilled", label: "Bosses killed", type: "number" },
      { key: "wipes", label: "Wipes", type: "number" },
    ],
  },
  prey: {
    label: "Prey hunt",
    icon: "🐾",
    fields: [
      { key: "title", label: "Prey", type: "text" },
      { key: "difficulty", label: "Difficulty", type: "text" },
      { key: "huntsCompleted", label: "Hunts completed", type: "number" },
    ],
  },
  levelling: {
    label: "Levelling",
    icon: "⬆️",
    fields: [
      { key: "experienceGained", label: "Experience gained", type: "number" },
      { key: "percentOfLevel", label: "Percent of a level", type: "number" },
      { key: "levelsGained", label: "Levels gained", type: "number" },
      { key: "startLevel", label: "Start level", type: "number" },
      { key: "endLevel", label: "End level", type: "number" },
    ],
  },
};

const spec = (kind?: string | null): ActivityKind | undefined => ACTIVITY_KINDS[kind ?? ""];

/** Turns an unknown kind slug into something readable: "transmog_farm" → "Transmog farm". */
function titleCase(kind?: string | null): string {
  const words = String(kind || "").replace(/[_-]+/g, " ").trim();
  if (!words) return "Activity";
  return words[0].toUpperCase() + words.slice(1);
}

export function activityLabel(kind?: string | null): string {
  return spec(kind)?.label ?? titleCase(kind);
}

export function activityIcon(kind?: string | null): string {
  return spec(kind)?.icon ?? "•";
}

/** The fields to offer when editing this kind; empty for a kind the app does not know. */
export function activityFields(kind?: string | null): ActivityField[] {
  return spec(kind)?.fields ?? [];
}

const number = (value: unknown): number | null => (typeof value === "number" ? value : null);

/**
 * The one-line detail shown beside an activity's name: the couple of numbers that actually
 * distinguish one run from another, not a dump of its metadata.
 *
 * A field the backend could not determine is left out rather than shown as a zero, because
 * "a +0 key" and "a key of unknown level" are very different things to read.
 */
export function activitySummary(activity?: PartialActivity | null): string {
  const meta: ActivityMetadata = activity?.metadata || {};
  const parts: string[] = [];
  switch (activity?.kind) {
    case "mythic_plus": {
      const level = number(meta.keystoneLevel);
      parts.push(level === null ? "level unknown" : `+${level}`);
      if (meta.dungeon) parts.push(String(meta.dungeon));
      if (meta.completed === false) parts.push("abandoned");
      else if (meta.timed === true) parts.push("timed");
      else if (meta.timed === false) parts.push("depleted");
      break;
    }
    case "progress_raid":
    case "legacy_raid": {
      if (meta.raid) parts.push(String(meta.raid));
      if (meta.difficulty) parts.push(String(meta.difficulty));
      const kills = number(meta.bossesKilled);
      if (kills !== null) parts.push(`${kills} boss${kills === 1 ? "" : "es"}`);
      const wipes = number(meta.wipes);
      if (wipes) parts.push(`${wipes} wipe${wipes === 1 ? "" : "s"}`);
      break;
    }
    case "prey": {
      if (meta.title) parts.push(String(meta.title));
      if (meta.difficulty) parts.push(String(meta.difficulty));
      // Only worth saying when there was more than one: the named hunt is the last of them,
      // and a bare title would otherwise read as the whole of what the segment held.
      const hunts = number(meta.huntsCompleted);
      if (hunts !== null && hunts > 1) parts.push(`${hunts} hunts`);
      break;
    }
    case "levelling": {
      const percent = number(meta.percentOfLevel);
      if (percent !== null) parts.push(`${percent}% of a level`);
      const levels = number(meta.levelsGained);
      if (levels) parts.push(`${levels} level${levels === 1 ? "" : "s"}`);
      const endLevel = number(meta.endLevel);
      if (endLevel !== null) parts.push(`now ${endLevel}`);
      break;
    }
    default:
      // An unknown kind carries whatever the user put on it, so show the first couple of
      // values rather than nothing at all.
      Object.entries(meta)
        .slice(0, 2)
        .forEach(([key, value]) => parts.push(`${key}: ${String(value)}`));
  }
  return parts.join(" · ");
}

/**
 * Whether an activity is worth flagging as a guess in the UI. A user's own entry never is,
 * and neither is a guess the backend was sure about — marking those would train the eye to
 * ignore the marker exactly where it matters.
 */
export function isUncertain(activity?: PartialActivity | null): boolean {
  return activity?.source === "inferred" && (activity.confidence ?? 1) < 0.9;
}

/**
 * Turns the editor's raw string inputs into the metadata object to store.
 *
 * Empty is absent, not zero: clearing "keystone level" has to mean "I do not know", or a
 * user tidying up a field would silently assert a +0 key. A number that will not parse is
 * dropped for the same reason.
 *
 * @param values Raw field values, keyed by field key.
 */
export function parseMetadata(
  kind: string | null | undefined,
  values: Record<string, string | null | undefined>,
): ActivityMetadata {
  const metadata: ActivityMetadata = {};
  for (const field of activityFields(kind)) {
    const raw = values[field.key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (field.type === "number") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) metadata[field.key] = parsed;
    } else if (field.type === "boolean") {
      if (raw === "yes" || raw === "no") metadata[field.key] = raw === "yes";
    } else {
      metadata[field.key] = String(raw);
    }
  }
  return metadata;
}

/**
 * The value to prefill a field's input with. Booleans use a three-way select — yes, no, and
 * an empty "unknown" — so an unset flag stays unset instead of defaulting to false.
 */
export function fieldValue(activity: PartialActivity | null | undefined, field: ActivityField): string {
  const value = activity?.metadata?.[field.key];
  if (value === undefined || value === null) return "";
  if (field.type === "boolean") return value ? "yes" : "no";
  return String(value);
}
