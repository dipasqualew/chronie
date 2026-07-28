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

import { useEffect, useReducer } from "react";
import type { ReactNode } from "react";

import { activityIcon, activityLabel, activitySummary, isUncertain } from "./activities";
import type { PartialActivity } from "./activities";
import { clock, duration, escapeHtml, initials, plural, signed, signedGold } from "./format";
import { GameItem } from "./item";
import type { ItemBook } from "./items";
import { highlights } from "./sessions";
import type { Highlight, HighlightKind, SessionActivity, SessionCharacter } from "./sessions";
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
 * The kinds drawn as their icon and nothing else, with the words moved into the hover.
 *
 * Saving a set of gear is housekeeping. It is worth a mark on the card — somebody who
 * reshuffled their raid set on Tuesday can find the evening again — and it is not worth the
 * width of "Raid · 2 slots, +16 item levels" beside a mount and an account first. So the chip
 * shrinks to its icon and the sentence goes into the tooltip, where the reader who cares can
 * still reach it and the reader who does not never has to read past it.
 */
const ICON_ONLY: ReadonlySet<string> = new Set(["equipset"]);

/** The whole of what a chip says, for the tooltip and the accessible name of an icon. */
const chipText = (entry: Highlight): string =>
  [entry.label, entry.detail].filter(Boolean).join(" · ");

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
  const quiet = ICON_ONLY.has(entry.kind);
  const text = chipText(entry);
  // A chip with no words on it still has to be reachable and still has to say what it is, so
  // the sentence it dropped becomes both its tooltip and the name a screen reader reads.
  const named = quiet
    ? { "aria-label": text, "data-tip": escapeHtml(text) }
    : {};
  const body = quiet
    ? <span className="hl-icon" aria-hidden="true">{entry.icon}</span>
    : <>
      <span className="hl-icon" aria-hidden="true">{entry.icon}</span>
      <span className="hl-label">{entry.label}</span>
      {entry.detail ? <span className="detail">{entry.detail}</span> : null}
    </>;
  const style = `hl hl-${entry.kind}${quiet ? " hl-quiet" : ""}`;
  if (!interactive) return <span className={style} {...named}>{body}</span>;
  if (entry.segmentId != null) {
    const segmentId = entry.segmentId;
    return (
      <button type="button" className={style} {...named}
        onClick={() => onOpenSegment?.(segmentId)}>{body}</button>
    );
  }
  const open = expanded === entry.kind;
  return (
    <button
      type="button" className={`${style}${open ? " open" : ""}`} {...named}
      aria-expanded={open} aria-controls={panelId(scope, entry.kind)}
      onClick={() => onUnfold?.(entry.kind)}
    >{body}{quiet ? null : <span className="hl-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>}</button>
  );
}

const panelId = (scope: string, kind: string): string => `hl-${scope}-${kind}`;

/**
 * What a summary unfolds into: every thing it counted, newest information first, each one a
 * way back to the segment it was recorded in.
 */
export function HighlightPanel(
  { entry, scope, items, onOpenSegment }: {
    entry: Highlight;
    scope: string;
    /** What the game says about an item, for the entries that are about one. */
    items?: ItemBook;
    onOpenSegment?: (segmentId: number) => void;
  },
): ReactNode {
  // The book is a cache outside React, so an answer landing changes nothing React would
  // notice. The rows redraw themselves; this is here for the one thing they cannot — the name
  // in each button's own label, which has to say what the row ended up showing.
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const named = entry.items.map((item) => item.itemId).filter((id): id is number => !!id);
  // The whole panel in one request rather than one per row: the rows would each ask for
  // themselves anyway, and asking here means the answer is already in hand when they draw.
  const wanted = named.join(",");
  useEffect(() => items?.learn(
    wanted ? wanted.split(",").map(Number) : [], redraw,
  ), [items, wanted]);

  return (
    <ul className="hl-panel" id={panelId(scope, entry.kind)}>
      {entry.items.map((item, index) => {
        const meta = [item.detail, item.character, item.at == null ? "" : clock(item.at)].filter(Boolean);
        // An entry about an item is drawn as one — the picture, the game's own name, the
        // colour of its quality — and everything else as the label the summary built. The
        // button around it is what it always was: a way back to the segment, and it is named
        // by whatever the row ended up showing rather than by the label underneath it.
        const shown = (item.itemId && items?.detail(item.itemId)?.name) || item.label;
        return (
          <li key={`${item.segmentId}-${item.label}-${index}`}>
            <button
              type="button" className="hl-item"
              aria-label={`Open the segment ${shown} was recorded in`}
              onClick={() => onOpenSegment?.(item.segmentId)}
            >
              <span className="hl-item-name">
                {items && item.itemId
                  ? <GameItem
                    id={item.itemId} name={item.label} book={items} facts={false} link={false}
                  />
                  : item.label}
              </span>
              <span className="hl-item-meta">{meta.join(" · ")}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- the running numbers ---------- */

/** What a badge of running numbers calls itself, however many things it stands for. */
const TALLY_NAMES: Partial<Record<HighlightKind, string>> = {
  gold: "Gold",
  currency: "Currency",
  reputation: "Reputation",
  housingXP: "Housing XP",
};

/** Every tally of one kind, folded into the single mark that stands for all of them. */
export interface TallyBadge {
  kind: HighlightKind;
  icon: string;
  /** What the badge is of: "Gold", "Currency", "Reputation". */
  title: string;
  /** One line per thing counted, already worded: "Glass Token +4". */
  lines: string[];
}

/**
 * The evening's running numbers, folded to one badge per kind.
 *
 * These are context, not news, and they used to be written out in full: every currency and
 * every faction its own line of name and number, under a card whose job is to say what
 * happened. A night that touched five factions therefore ended in five lines of small print
 * nobody reads, sitting where the two things that actually happened should have been.
 *
 * So each kind collapses to its icon. A reader who wants the numbers hovers one and gets all
 * of them at once — which is also the only shape in which "Glass Token +4, Warband Chit +100"
 * reads as one fact about the evening rather than two competing lines.
 */
export function tallyBadges(entries: Highlight[]): TallyBadge[] {
  const byKind = new Map<HighlightKind, TallyBadge>();
  for (const entry of entries) {
    if (entry.family !== "tally") continue;
    const badge = byKind.get(entry.kind) ?? {
      kind: entry.kind,
      icon: entry.icon,
      title: TALLY_NAMES[entry.kind] ?? entry.label,
      lines: [],
    };
    // Gold names itself, so "Gold +3g 29s" under a heading reading "Gold" would say it
    // twice; a currency does not, and its name is the whole point of the line.
    badge.lines.push(entry.label === badge.title
      ? highlightValue(entry)
      : `${entry.label} ${highlightValue(entry)}`);
    byKind.set(entry.kind, badge);
  }
  return [...byKind.values()];
}

/**
 * One kind of running total, as an icon carrying its numbers in the hover.
 *
 * Focusable and named for the same reason the character circle is: this is the only place the
 * card says what the evening earned, and it must not be reachable by pointer alone.
 */
export function TallyMark({ badge }: { badge: TallyBadge }): ReactNode {
  const tip = `<b>${escapeHtml(badge.title)}</b>` +
    badge.lines.map((line) => `<span class="tip-line">${escapeHtml(line)}</span>`).join("");
  return (
    <span
      className={`tally tally-${badge.kind}`} role="img" tabIndex={0}
      aria-label={`${badge.title}: ${badge.lines.join(", ")}`} data-tip={tip}
    >{badge.icon}</span>
  );
}

export interface HighlightListProps {
  entries: Highlight[];
  /**
   * What the game says about the items the entries name, for the summaries that unfold into
   * items. Absent where nothing can unfold — a segment row is one button and holds no others
   * — and the panel then draws the name the addon caught, which is what it always drew.
   */
  items?: ItemBook;
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
    entries, items, scope = "", milestones: withChips = true, tallies: withTallies = true,
    expanded = null, interactive = true, onUnfold, onOpenSegment,
  }: HighlightListProps,
): ReactNode {
  const milestones = withChips ? entries.filter((entry) => entry.family === "milestone") : [];
  const tallies = withTallies ? tallyBadges(entries) : [];
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
      ? <HighlightPanel
        entry={unfolded} scope={scope} items={items} onOpenSegment={onOpenSegment}
      />
      : null}
    {tallies.length
      // Named for the same reason the cast is: a row of marks each announcing a number of its
      // own is a set of unrelated figures until something says what they are a set of.
      ? <div className="tally-row" role="group" aria-label="Running totals">
        {tallies.map((badge) => <TallyMark key={badge.kind} badge={badge} />)}
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

/** Where an activity came from, in the words a hover uses to say so. */
const provenance = (activity: PartialActivity): string =>
  (activity.source === "manual"
    ? "You set this activity"
    : `Guessed by Chronie · confidence ${Math.round((activity.confidence ?? 1) * 100)}%`);

/**
 * A guess the backend was unsure about is drawn with a dashed border and says so in its
 * tooltip, so the eye can tell "Chronie thinks" apart from "I said so" at a glance.
 */
export function ActivityChip({ activity }: { activity: PartialActivity }): ReactNode {
  const detail = activitySummary(activity);
  const guess = isUncertain(activity);
  return (
    <span className={`chip activity${guess ? " guess" : ""}`} title={provenance(activity)}>
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

/**
 * The evening's activities, listed out in the order they happened.
 *
 * This is the one thing on a session card that is a list before anybody asks for one, and it
 * is the exception the rest of the page is designed around. Everything else a card says — a
 * dozen achievements, four factions, a wallet — is a count or a total, because the reader
 * wants to know what kind of evening it was before they want the particulars. An activity is
 * already the answer to that question: "a +14 and a heroic night" is what somebody would say
 * if you asked them how Tuesday went, and folding four keys into "4 Mythic+ runs" throws away
 * the four levels and the four dungeons that are the entire content of the sentence.
 *
 * Each row is the way back into the segment it was recorded in, which is where the rest of it
 * lives — the fight-by-fight, the loot, the pictures — and where it can be corrected.
 */
export function ActivityRoll(
  { activities, onOpenSegment }: {
    activities: SessionActivity[];
    onOpenSegment: (segmentId: number) => void;
  },
): ReactNode {
  if (!activities.length) return null;
  return (
    <ol className="act-roll" aria-label="What was done">
      {activities.map((entry, index) => {
        const detail = activitySummary(entry.activity);
        const label = activityLabel(entry.activity.kind);
        const said = [label, detail].filter(Boolean).join(" · ");
        return (
          <li key={`${entry.segmentId}-${entry.activity.id ?? index}`}>
            <button
              type="button"
              className={`act${isUncertain(entry.activity) ? " guess" : ""}`}
              {...classProps(entry.classFile)}
              // Named by what it did and who did it, rather than by the segment it opens:
              // the row is read as a thing that happened, and the segment is where it goes.
              aria-label={`Open the segment ${said} was recorded in, ${entry.character} at ${clock(entry.at)}`}
              data-tip={escapeHtml(provenance(entry.activity))}
              onClick={() => onOpenSegment(entry.segmentId)}
            >
              <span className="act-icon" aria-hidden="true">{activityIcon(entry.activity.kind)}</span>
              <span className="act-body">
                <span className="act-name">{label}</span>
                {detail ? <span className="act-detail">{detail}</span> : null}
              </span>
              <span className="act-who">{entry.character}</span>
              <span className="act-time">{clock(entry.at)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

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

/**
 * The mark on a link that leaves the window: a box with an arrow leaving it, drawn rather
 * than written.
 *
 * Drawn because there is nothing to write it with. The window ships no icon font and loads
 * nothing from the network, and the arrows in the fonts it does have are a lottery across
 * machines — so the one glyph the wardrobe needs is eleven points of SVG in the markup. Both
 * halves of the transmog browser draw it, which is why it is here.
 */
export function LinkOut(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5L7.5 8.5" />
      <path d="M12 9.5V13C12 13.3 11.8 13.5 11.5 13.5H3C2.7 13.5 2.5 13.3 2.5 13V4.5C2.5 4.2 2.7 4 3 4H6.5" />
    </svg>
  );
}

/**
 * The star that says somebody wants this one, filled or hollow.
 *
 * Drawn for the same reason [`LinkOut`] is: the window ships no icon font and loads nothing
 * from the network, and U+2605 renders as anything from a glyph to a coloured emoji to a box
 * depending on which machine the app was opened on. Eleven points of SVG is the same star
 * everywhere, and it takes `currentColor` so the stylesheet decides what a starred one looks
 * like rather than the character set.
 */
export function Star({ filled }: { filled: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"
      fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2-.7-4.3-3.1-3 4.3-.6z" />
    </svg>
  );
}
