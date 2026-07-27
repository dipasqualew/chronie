/**
 * The small pieces every view draws: a character's class circle, a highlight chip, the
 * badge on a location, one segment as a row.
 *
 * These are components rather than strings of markup, and that is most of the point of the
 * move: a character name or an item name out of the game is put in as a value and React writes
 * it as text, so there is no longer an escape to forget. The one exception is spelled out on
 * the circle below, and it still escapes by hand.
 *
 * They live together because more than one view draws each of them, and a segment that reads
 * one way on the timeline and another on a character's page would be the same bug twice.
 */

import type { ReactNode } from "react";

import { activityIcon, activityLabel, activitySummary, isUncertain } from "./activities";
import type { PartialActivity } from "./activities";
import { clock, duration, escapeHtml, gold, initials, plural, signed, signedGold } from "./format";
import { highlights } from "./sessions";
import type { Highlight, SessionCharacter } from "./sessions";
import type { Segment } from "./types";

/**
 * Given the segment to show and the list it sits in, so the detail modal's next and previous
 * walk whatever the reader was already looking at — a play session, a character's history,
 * or the table's current sort.
 */
export type OpenSegment = (segmentId: number, order: Segment[]) => void;

/** The classes the stylesheet has a colour and an ink for, which is all thirteen of them. */
export const CLASS_FILES = [
  "DEATHKNIGHT", "DEMONHUNTER", "DRUID", "EVOKER", "HUNTER", "MAGE", "MONK",
  "PALADIN", "PRIEST", "ROGUE", "SHAMAN", "WARLOCK", "WARRIOR",
] as const;

/**
 * The attribute that puts a character's class colour on an element.
 *
 * The colour itself is not here, and deliberately: the packaged app's CSP carries a nonce in
 * `style-src`, which makes the browser ignore `'unsafe-inline'` and drop every `style=""`
 * attribute the page writes. So this hands the stylesheet a class rather than a colour, and
 * the stylesheet — nonced, and therefore trusted — turns it into `--class-color` and
 * `--class-ink`. Anything drawing in a class colour spreads this and never a `style` prop.
 *
 * A class the palette does not know still gets the attribute, empty. That is what makes it
 * fall to the muted grey rather than inherit the colour of the session around it.
 */
export function classProps(classFile?: string | null): { "data-class": string } {
  const known = CLASS_FILES.find((file) => file === classFile);
  return { "data-class": known ?? "" };
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

export const ClassDot = ({ classFile }: { classFile?: string | null }): ReactNode =>
  <span className="dot" {...classProps(classFile)} />;

/**
 * A character as a circle filled with their class colour, carrying everything the hover card
 * needs.
 *
 * Focusable and named, so the detail is reachable without a mouse: the circle is the only
 * place a session says which characters were involved, and that must not be hover-only.
 *
 * The tip is the one string of markup left in this module. It is handed to the floating
 * tooltip as HTML because that is the only shape a single shared element can take it in, which
 * is also the one place left where a name out of the game still has to be escaped by hand.
 */
export function CharacterCircle({ character }: { character: SessionCharacter }): ReactNode {
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
  return (
    <span
      className="circle" role="img" tabIndex={0} {...classProps(character.classFile)}
      aria-label={label} data-tip={tip}
    >{initials(character.name)}</span>
  );
}

/* ---------- highlights ---------- */

/** How a running total reads: copper as gold, everything else as a signed count. */
export function highlightValue(entry: Highlight): string {
  const value = entry.value ?? 0;
  if (entry.kind === "gold") return signedGold(value);
  if (entry.kind === "loot") return gold(value);
  return signed(value);
}

interface ChipProps {
  entry: Highlight;
  /** Namespaces the panel's id, so two sessions on screen do not share one. */
  scope: string;
  expanded?: string | null;
  interactive?: boolean;
  onUnfold?: (kind: string) => void;
  onOpenSegment?: (segmentId: number) => void;
}

/**
 * One thing worth remembering, or one summary of several.
 *
 * A summary that stands for a single thing takes you straight to the segment it happened in,
 * because that is the only place left to go. One that stands for twelve unfolds into the
 * twelve instead — the count is what a session card is for, and the names are what the reader
 * came back for.
 */
export function HighlightChip(
  { entry, scope, expanded, interactive, onUnfold, onOpenSegment }: ChipProps,
): ReactNode {
  const body = <>
    <span className="hl-icon" aria-hidden="true">{entry.icon}</span>
    <span className="hl-label">{entry.label}</span>
    {entry.detail ? <span className="detail">{entry.detail}</span> : null}
  </>;
  if (!interactive) return <span className={`hl hl-${entry.kind}`}>{body}</span>;
  if (entry.segmentId != null) {
    const segmentId = entry.segmentId;
    return (
      <button type="button" className={`hl hl-${entry.kind}`}
        onClick={() => onOpenSegment?.(segmentId)}>{body}</button>
    );
  }
  const open = expanded === entry.kind;
  return (
    <button
      type="button" className={`hl hl-${entry.kind}${open ? " open" : ""}`}
      aria-expanded={open} aria-controls={panelId(scope, entry.kind)}
      onClick={() => onUnfold?.(entry.kind)}
    >{body}<span className="hl-caret" aria-hidden="true">{open ? "▾" : "▸"}</span></button>
  );
}

const panelId = (scope: string, kind: string): string => `hl-${scope}-${kind}`;

/**
 * What a summary unfolds into: every thing it counted, newest information first, each one a
 * way back to the segment it was recorded in.
 */
export function HighlightPanel(
  { entry, scope, onOpenSegment }:
  { entry: Highlight; scope: string; onOpenSegment?: (segmentId: number) => void },
): ReactNode {
  return (
    <ul className="hl-panel" id={panelId(scope, entry.kind)}>
      {entry.items.map((item, index) => {
        const meta = [item.detail, item.character, item.at == null ? "" : clock(item.at)].filter(Boolean);
        return (
          <li key={`${item.segmentId}-${item.label}-${index}`}>
            <button
              type="button" className="hl-item"
              aria-label={`Open the segment ${item.label} was recorded in`}
              onClick={() => onOpenSegment?.(item.segmentId)}
            >
              <span className="hl-item-name">{item.label}</span>
              <span className="hl-item-meta">{meta.join(" · ")}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A running total, drawn quieter than a milestone because it is context, not news. */
export function TallyItem({ entry }: { entry: Highlight }): ReactNode {
  const tone = entry.kind === "gold" && (entry.value ?? 0) < 0
    ? " loss"
    : (entry.kind === "gold" ? " gold" : "");
  return (
    <span className="tally">
      <span className="tally-icon" aria-hidden="true">{entry.icon}</span>
      <span className="tally-label">{entry.label}</span>
      <span className={`tally-value${tone}`}>{highlightValue(entry)}</span>
    </span>
  );
}

export interface HighlightListProps {
  entries: Highlight[];
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
  onUnfold?: (kind: string) => void;
  onOpenSegment?: (segmentId: number) => void;
}

/**
 * Which of a set of highlights a given list would actually draw.
 *
 * Every caller has something to say when the answer is none of them — "a quiet session",
 * "nothing gained or collected yet" — and a component cannot be asked whether it drew
 * anything, so this is what they ask instead.
 */
export function shownHighlights(
  entries: Highlight[],
  { milestones = true, tallies = true }: { milestones?: boolean; tallies?: boolean } = {},
): Highlight[] {
  return entries.filter((entry) =>
    (milestones && entry.family === "milestone") || (tallies && entry.family === "tally"));
}

/**
 * Draws a set of highlights: the milestones as summary chips, the totals as a quiet strip
 * beneath, and — where the reader has asked for one — the things behind a summary.
 *
 * There is no cap, because there is nothing left to cap: a summary per kind is nine chips at
 * the very most, however long the evening was.
 *
 * `milestones={false}` is for the detail modal, which lists every one of them in full a few
 * lines further down — repeating them as chips first would only make the same page longer.
 */
export function HighlightList(
  {
    entries, scope = "", milestones: withChips = true, tallies: withTallies = true,
    expanded = null, interactive = true, onUnfold, onOpenSegment,
  }: HighlightListProps,
): ReactNode {
  const milestones = withChips ? entries.filter((entry) => entry.family === "milestone") : [];
  const tallies = withTallies ? entries.filter((entry) => entry.family === "tally") : [];
  const unfolded = interactive
    ? milestones.find((entry) => entry.kind === expanded && entry.segmentId == null)
    : undefined;
  return <>
    {milestones.length
      ? <div className="hl-row">
        {milestones.map((entry) => (
          <HighlightChip
            key={entry.kind} entry={entry} scope={scope} expanded={expanded}
            interactive={interactive} onUnfold={onUnfold} onOpenSegment={onOpenSegment}
          />
        ))}
      </div>
      : null}
    {unfolded
      ? <HighlightPanel entry={unfolded} scope={scope} onOpenSegment={onOpenSegment} />
      : null}
    {tallies.length
      ? <div className="tally-row">
        {tallies.map((entry) => <TallyItem key={`${entry.kind}-${entry.label}`} entry={entry} />)}
      </div>
      : null}
  </>;
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
 * reputation — the addon has already decided which of the client's reputation systems answers
 * for this faction and reduced its answer to that shape — so the bar is always read the same
 * way whether the level is Honored, Renown 12 or a friendship rank.
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
export function StandingBar(
  { standing, faction }: { standing: Standing; faction: string },
): ReactNode {
  const max = Math.max(standing.max || 0, 0);
  const current = Math.min(Math.max(standing.current || 0, 0), max);
  if (!standing.standing && max === 0) return null;
  const numbers = max > 0 ? `${current.toLocaleString()} / ${max.toLocaleString()}` : "";
  const caption = [standing.standing, numbers].filter(Boolean).join(" ");
  return (
    <p className="rep-standing">
      {max === 0
        ? null
        : <progress
          className="rep-bar" value={current} max={max}
          aria-label={`${standing.standing || "Standing"} with ${faction}`}
        />}
      <span className="muted">{caption}</span>
    </p>
  );
}

/* ---------- activities ---------- */

/**
 * A guess the backend was unsure about is drawn with a dashed border and says so in its
 * tooltip, so the eye can tell "Chronie thinks" apart from "I said so" at a glance.
 */
export function ActivityChip({ activity }: { activity: PartialActivity }): ReactNode {
  const detail = activitySummary(activity);
  const guess = isUncertain(activity);
  const title = activity.source === "manual"
    ? "You set this activity"
    : `Guessed by Chronie · confidence ${Math.round((activity.confidence ?? 1) * 100)}%`;
  return (
    <span className={`chip activity${guess ? " guess" : ""}`} title={title}>
      {`${activityIcon(activity.kind)} ${activityLabel(activity.kind)}`}
      {detail ? <> <span className="detail">{detail}</span></> : null}
    </span>
  );
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
 * what a segment says at a glance lands in both places at once, which is the only way the two
 * can be relied on to agree.
 *
 * The running totals are left off. On one segment they are four more numbers beside two
 * things that actually happened, and the modal has them a click away.
 *
 * The row carries its own character's class, not the surrounding view's: an evening spent on
 * three characters is exactly when the rail down the left of each row is worth having, and it
 * would say the opposite of the truth if every row took the colour of whoever led.
 */
export function SegmentButton(
  { segment, onOpen }: { segment: Segment; onOpen: () => void },
): ReactNode {
  const label = `${segment.character} in ${segment.instance} at ${clock(segment.startedAt)}`;
  const summary = highlights([segment]);
  const activities = segment.activities || [];
  return (
    <button
      type="button" className="seg" {...classProps(segment.classFile)}
      aria-label={`Open segment: ${label}`} onClick={onOpen}
    >
      <span className="seg-time">{clock(segment.startedAt)}</span>
      <span className="seg-body">
        <span className="seg-head">
          <span className="seg-who"><ClassDot classFile={segment.classFile} />{segment.character}</span>
          <span className="seg-where">{segment.instance}</span>
          <span className="badge">{locationType(segment)}</span>
          {segment.difficulty ? <span className="muted">{segment.difficulty}</span> : null}
        </span>
        <span className="seg-activities">
          {activities.length
            ? activities.map((activity, index) =>
              <ActivityChip key={activity.id ?? index} activity={activity} />)
            : <span className="muted">No activity recorded</span>}
        </span>
        {shownHighlights(summary, { tallies: false }).length
          ? <span className="seg-summary">
            <HighlightList entries={summary} tallies={false} interactive={false} />
          </span>
          : null}
      </span>
      <span className="seg-dur">{duration(segment.seconds)}</span>
    </button>
  );
}
