/**
 * What Chronie photographs by itself, and how much of the picture it keeps.
 *
 * The rules and the storage levels are the two halves of one decision and they live here
 * together, away from the panel that draws them, because both are catalogues with wording that
 * has to be right rather than markup. The names in `TRIGGER_GROUPS` are the same strings the
 * addon's `ns.newCaptureTriggers` matches on and the same strings the backend writes into
 * `src/Settings.lua`; a name invented here reaches the game and does nothing.
 *
 * One rule shapes most of this file. The addon offers a moment to the *specific* rule first and
 * the *general* one second — an account-first achievement is offered as `accountFirstAchievement`
 * and then as `achievement` — so allowing the general rule already covers the specific one. The
 * panel has to say that rather than leave somebody with two boxes ticked wondering whether the
 * narrower one is doing anything, which is what `narrows` and `supersededBy` are for.
 */

import type { CaptureQuality } from "./types";

/** One rule that can take a picture without being asked. */
export interface CaptureTrigger {
  /** The name that crosses into the addon. Letters only — anything else is dropped there. */
  name: string;
  /** The box's own label, written as the moment rather than as the rule. */
  label: string;
  /** The line under it: what it costs, or how often it fires. */
  detail: string;
  /**
   * The broader rule this one is a narrower case of, when it is one. Allowing the broader rule
   * already photographs everything this would, which is what the panel says instead of leaving
   * a ticked box doing nothing.
   */
  narrows?: string;
}

export interface TriggerGroup {
  title: string;
  triggers: CaptureTrigger[];
}

/**
 * Every rule this build of the addon has, grouped the way somebody thinks about them.
 *
 * Specific before general inside each group, which is the order the addon considers them in
 * and the order they read in: the rare thing worth a photograph every time comes before the
 * common one that mostly is not.
 */
export const TRIGGER_GROUPS: TriggerGroup[] = [
  {
    title: "Achievements",
    triggers: [
      {
        name: "accountFirstAchievement",
        label: "An achievement nobody on this account had",
        detail: "Rare, and worth a picture every time. What Chronie does unless told otherwise.",
        narrows: "achievement",
      },
      {
        name: "achievement",
        label: "Every achievement this character earns",
        detail: "Clearing an old raid fires thirty of these in a minute.",
      },
    ],
  },
  {
    title: "Collections",
    triggers: [
      { name: "mount", label: "A mount added to the collection", detail: "One per new mount." },
      { name: "pet", label: "A battle pet added to the collection", detail: "One per new species." },
      { name: "toy", label: "A toy added to the collection", detail: "One per new toy." },
      {
        name: "newAppearance",
        label: "A transmog appearance nobody on this account owned",
        detail: "The look itself is new, rather than another item that wears one already owned.",
        narrows: "transmog",
      },
      {
        name: "transmog",
        label: "Every transmog source collected",
        detail: "Emptying a bag at a vendor collects a dozen of these at once.",
      },
    ],
  },
  {
    title: "Milestones",
    triggers: [
      { name: "levelUp", label: "A level gained", detail: "Including every level of a levelling run." },
      {
        name: "keystoneOnTime",
        label: "A keystone run that beat the timer",
        detail: "Taken as the run ends, before the party leaves.",
        narrows: "keystone",
      },
      { name: "keystone", label: "Every keystone run finished", detail: "In time or not." },
    ],
  },
];

/** Every rule this build has, flattened, in the order the groups list them. */
export const ALL_TRIGGERS: CaptureTrigger[] = TRIGGER_GROUPS.flatMap((group) => group.triggers);

const BY_NAME = new Map(ALL_TRIGGERS.map((trigger) => [trigger.name, trigger]));

/**
 * The broader rule already photographing everything this one would, when it is on.
 *
 * `null` for a rule with nothing above it, and for one whose broader rule is off — which is the
 * ordinary case and the one where the box means exactly what it says.
 */
export function supersededBy(trigger: CaptureTrigger, chosen: string[]): CaptureTrigger | null {
  if (!trigger.narrows || !chosen.includes(trigger.narrows)) return null;
  return BY_NAME.get(trigger.narrows) ?? null;
}

/**
 * The list with one rule turned on or off, and everything else left exactly as it was.
 *
 * Names this build does not recognise are carried through rather than dropped. The settings
 * file can be edited by hand and a newer addon may know rules this window does not; a panel
 * that rewrote the whole list from its own checkboxes would quietly delete them the first time
 * anybody ticked anything. Order is the catalogue's, with the unknowns kept at the end, so the
 * file stays stable rather than reshuffling on every click.
 */
export function toggleTrigger(chosen: string[], name: string, on: boolean): string[] {
  const wanted = new Set(chosen);
  if (on) {
    wanted.add(name);
  } else {
    wanted.delete(name);
  }
  const known = ALL_TRIGGERS.filter((trigger) => wanted.has(trigger.name))
    .map((trigger) => trigger.name);
  const unknown = [...wanted].filter((held) => !BY_NAME.has(held));
  return [...known, ...unknown];
}

/** The chosen names this build has no rule for, which is what a hand-edited file leaves. */
export function unknownTriggers(chosen: string[]): string[] {
  return chosen.filter((name) => !BY_NAME.has(name));
}

/**
 * What the panel says about the rules as they stand.
 *
 * The rate limit is in the sentence rather than in a note somewhere, because it is the answer
 * to the question ticking a broad rule immediately raises: no, a raid clear is not thirty
 * screenshots.
 */
export function triggerSentence(chosen: string[]): string {
  const on = chosen.filter((name) => BY_NAME.has(name)).length;
  if (on === 0) {
    return "Chronie photographs nothing by itself. The keybinding still works.";
  }
  const kinds = on === 1 ? "one kind of moment" : `${on} kinds of moment`;
  return `Chronie photographs ${kinds} by itself, and at most one a minute.`;
}

/** One of the four things Chronie can keep of a screenshot. */
export interface QualityChoice {
  value: CaptureQuality;
  label: string;
  detail: string;
}

/**
 * The storage levels, largest first, so the list reads as a ladder down from the file itself.
 *
 * The pixel counts are the ones `captures::Quality` actually encodes at. They are written out
 * because "balanced" says nothing on its own, and a reader deciding what to do with years of
 * screenshots is deciding about sizes.
 */
export const CAPTURE_QUALITIES: QualityChoice[] = [
  {
    value: "original",
    label: "Exactly what the game wrote",
    detail: "Every pixel, in the game's own format. A 4K screenshot is around 10 MB of PNG.",
  },
  {
    value: "high",
    label: "Full size, compressed",
    detail: "Every pixel, re-encoded as a JPEG. Roughly a tenth of the disk, and hard to tell apart.",
  },
  {
    value: "balanced",
    label: "Fits a retina display",
    detail: "Scaled to 2560 pixels on the long side. Sharp in this window, a fraction of the disk.",
  },
  {
    value: "small",
    label: "Fits a laptop screen",
    detail: "Scaled to 1600 pixels. For somebody keeping years of them.",
  },
];

/** What every install that has never been told otherwise keeps. Mirrors `Quality::default`. */
export const DEFAULT_QUALITY: CaptureQuality = "balanced";

/**
 * What the panel says about the game's own copy of a picture Chronie now holds.
 *
 * Two sentences rather than a label, because the two settings are the opposite risks of each
 * other: leaving the originals means the folder this feature exists to stop growing keeps
 * growing, and taking them means a folder somebody has curated for years loses files.
 */
export function originalsSentence(keep: boolean): string {
  return keep
    ? "The game keeps its copy too, so its Screenshots folder goes on growing."
    : "Chronie deletes the game’s copy once it holds a verified one of its own.";
}

/**
 * What the two storage settings mean together, which is the thing worth knowing before either
 * is changed: neither of them touches a picture Chronie already has.
 */
export const STORAGE_APPLIES = "Both apply to the next screenshot Chronie takes custody of. " +
  "Nothing already in the store is re-compressed or given back.";
