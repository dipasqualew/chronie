/**
 * How an activity reads on screen, and what its editor offers.
 *
 * Kept out of index.html so it can be tested without a browser: everything here is a pure
 * function of an activity, which is the only part of the feature worth a unit test. The
 * inference itself lives in the Rust backend — this module never guesses, it only presents.
 */

/**
 * The kinds the backend can guess at, with a human name and the metadata fields the editor
 * should offer for each. A kind the user types in themselves is still perfectly valid; it
 * simply falls back to a title-cased label and free-form key/value editing.
 *
 * `fields` is the whole reason this table exists: without it every activity would be edited
 * as raw JSON, and a keystone level would be as awkward to correct as it is easy to see.
 */
export const ACTIVITY_KINDS = {
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

/** Turns an unknown kind slug into something readable: "transmog_farm" → "Transmog farm". */
function titleCase(kind) {
  const words = String(kind || "").replace(/[_-]+/g, " ").trim();
  if (!words) return "Activity";
  return words[0].toUpperCase() + words.slice(1);
}

export function activityLabel(kind) {
  return ACTIVITY_KINDS[kind]?.label ?? titleCase(kind);
}

export function activityIcon(kind) {
  return ACTIVITY_KINDS[kind]?.icon ?? "•";
}

/** The fields to offer when editing this kind; empty for a kind the app does not know. */
export function activityFields(kind) {
  return ACTIVITY_KINDS[kind]?.fields ?? [];
}

const number = (value) => (typeof value === "number" ? value : null);

/**
 * The one-line detail shown beside an activity's name: the couple of numbers that actually
 * distinguish one run from another, not a dump of its metadata.
 *
 * A field the backend could not determine is left out rather than shown as a zero, because
 * "a +0 key" and "a key of unknown level" are very different things to read.
 */
export function activitySummary(activity) {
  const meta = activity?.metadata || {};
  const parts = [];
  switch (activity?.kind) {
    case "mythic_plus": {
      const level = number(meta.keystoneLevel);
      parts.push(level === null ? "level unknown" : `+${level}`);
      if (meta.dungeon) parts.push(meta.dungeon);
      if (meta.completed === false) parts.push("abandoned");
      else if (meta.timed === true) parts.push("timed");
      else if (meta.timed === false) parts.push("depleted");
      break;
    }
    case "progress_raid":
    case "legacy_raid": {
      if (meta.raid) parts.push(meta.raid);
      if (meta.difficulty) parts.push(meta.difficulty);
      const kills = number(meta.bossesKilled);
      if (kills !== null) parts.push(`${kills} boss${kills === 1 ? "" : "es"}`);
      const wipes = number(meta.wipes);
      if (wipes) parts.push(`${wipes} wipe${wipes === 1 ? "" : "s"}`);
      break;
    }
    case "levelling": {
      const percent = number(meta.percentOfLevel);
      if (percent !== null) parts.push(`${percent}% of a level`);
      const levels = number(meta.levelsGained);
      if (levels) parts.push(`${levels} level${levels === 1 ? "" : "s"}`);
      if (number(meta.endLevel) !== null) parts.push(`now ${meta.endLevel}`);
      break;
    }
    default:
      // An unknown kind carries whatever the user put on it, so show the first couple of
      // values rather than nothing at all.
      Object.entries(meta)
        .slice(0, 2)
        .forEach(([key, value]) => parts.push(`${key}: ${value}`));
  }
  return parts.join(" · ");
}

/**
 * Whether an activity is worth flagging as a guess in the UI. A user's own entry never is,
 * and neither is a guess the backend was sure about — marking those would train the eye to
 * ignore the marker exactly where it matters.
 */
export function isUncertain(activity) {
  return activity?.source === "inferred" && (activity.confidence ?? 1) < 0.9;
}

/**
 * Turns the editor's raw string inputs into the metadata object to store.
 *
 * Empty is absent, not zero: clearing "keystone level" has to mean "I do not know", or a
 * user tidying up a field would silently assert a +0 key. A number that will not parse is
 * dropped for the same reason.
 *
 * @param {string} kind
 * @param {Record<string, string>} values Raw field values, keyed by field key.
 * @returns {Record<string, unknown>}
 */
export function parseMetadata(kind, values) {
  const metadata = {};
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
export function fieldValue(activity, field) {
  const value = activity?.metadata?.[field.key];
  if (value === undefined || value === null) return "";
  if (field.type === "boolean") return value ? "yes" : "no";
  return String(value);
}
