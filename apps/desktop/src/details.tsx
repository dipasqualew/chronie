/**
 * The details view: every segment as a row, sortable and filterable.
 *
 * The timeline is the story; this is the ledger. Nothing is summarised away, and the row a
 * reader lands on opens the same detail modal the timeline uses — navigating, from here,
 * through the table's current order rather than through a play session.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { equipsetDetail, equipsetTitle } from "./equipsets";
import { clock, duration, gold, signed, signedGold } from "./format";
import { eventsOf } from "./types";
import type {
  AchievementEvent,
  CollectibleEvent,
  CurrencyGain,
  EquipsetChangeEvent,
  EventListKey,
  EventOf,
  HousingItemEvent,
  LevelUpEvent,
  QuestEvent,
  ReputationGain,
  Segment,
  TransmogEvent,
} from "./types";
import { ClassDot, activityText, locationType } from "./ui";
import type { OpenSegment } from "./ui";

/**
 * A compact cell that names the first couple of entries and counts the rest, with the full
 * list in the title attribute so nothing is lost to the abbreviation.
 */
function listCell<T>(entries: T[] | undefined, asText: (items: T[]) => string): ReactNode {
  const list = entries || [];
  if (list.length === 0) return <span className="muted">—</span>;
  return <>
    <span title={asText(list)}>{asText(list.slice(0, 2))}</span>
    {list.length > 2 ? <> <span className="muted">+{list.length - 2} more</span></> : null}
  </>;
}

// A gain, then where it left the character: the standing a faction now sits at, and the
// holding a currency was left at. Both are dropped rather than faked when the client had
// nothing to say, so a row never claims a standing of none or a holding of zero.
const repText = (gains?: ReputationGain[]): string =>
  (gains || []).map((gain) => `${gain.faction} +${gain.amount.toLocaleString()}` +
    (gain.standing ? ` (${gain.standing})` : "")).join(", ");
const currencyText = (gains?: CurrencyGain[]): string =>
  (gains || []).map((gain) => `${gain.name} ${signed(gain.amount)}` +
    (gain.total == null ? "" : ` (${gain.total.toLocaleString()})`)).join(", ");
const achievementText = (earned?: AchievementEvent[]): string =>
  (earned || []).map((event) => `${event.name} (${event.accountFirst ? "account first" : "character first"})`).join(", ");
const levelUpText = (events?: LevelUpEvent[]): string =>
  (events || []).map((event) => `Level ${event.level}`).join(", ");
const collectionText = (events?: CollectibleEvent[]): string =>
  (events || []).map((event) => event.name).join(", ");
const housingText = (events?: HousingItemEvent[]): string =>
  (events || []).map((event) => `${event.name} (${event.warbandFirst ? "warband first" : "additional"})`).join(", ");
const transmogText = (events?: TransmogEvent[]): string => (events || []).map((event) =>
  `${event.name || `Item ${event.id}`} (${event.newAppearance === true
    ? "new" : event.newAppearance === false ? "variant" : "unknown"})`).join(", ");
const questText = (events?: QuestEvent[]): string =>
  (events || []).map((event) => event.name || `Quest ${event.id}`).join(", ");
const equipsetText = (events?: EquipsetChangeEvent[]): string =>
  (events || []).map((event) => `${equipsetTitle(event)} (${equipsetDetail(event)})`).join(", ");

/** Cells are compared against others from their own column, so both sides always match. */
type SortValue = string | number;

interface Column {
  key: string;
  title: string;
  num?: boolean;
  /** Kept even when this history has nothing to put in it. */
  always?: boolean;
  /** Dropped unless some segment has something in it. */
  optional?: boolean;
  /** A rule of its own for whether the column has earned its place. */
  when?: (segments: Segment[]) => boolean;
  cell: (segment: Segment, onOpen: () => void) => ReactNode;
  sort: (segment: Segment) => SortValue;
  /** Set on the event-list columns; what `columnsFor` asks to find out whether they are empty. */
  events?: (segment: Segment) => unknown[];
}

interface EventColumnSpec<K extends EventListKey> {
  key: K;
  title: string;
  text: (events?: Array<EventOf<K>>) => string;
  num?: boolean;
  always?: boolean;
  optional?: boolean;
  when?: (segments: Segment[]) => boolean;
  sort?: (segment: Segment) => SortValue;
}

/**
 * An event-list column reads and sorts the same way every time, so it is declared by its
 * formatter alone and the rest is filled in here. The key is tied to the formatter's event
 * type, so a column pointed at the wrong list will not compile.
 */
function eventColumn<K extends EventListKey>(spec: EventColumnSpec<K>): Column {
  const events = (segment: Segment): Array<EventOf<K>> => eventsOf(segment, spec.key);
  return {
    key: spec.key,
    title: spec.title,
    num: spec.num,
    always: spec.always,
    optional: spec.optional,
    when: spec.when,
    events,
    cell: (segment) => listCell(events(segment), spec.text),
    sort: spec.sort ?? ((segment) => events(segment).length),
  };
}

const ALL_COLUMNS: Column[] = [
  {
    key: "day",
    title: "Started – ended",
    sort: (segment) => segment.endedAt,
    // The row is what opens the segment, and this is what makes that reachable from a
    // keyboard and readable as an affordance. It answers the click itself rather than letting
    // it reach the row, or the same segment would be opened twice over.
    cell: (segment, onOpen) => (
      <button
        type="button" className="row-open"
        aria-label={`Open segment: ${segment.character} in ${segment.instance} at ${clock(segment.startedAt)}`}
        onClick={(event) => { event.stopPropagation(); onOpen(); }}
      >
        {segment.day}{" "}
        <span className="muted">{clock(segment.startedAt)} – {clock(segment.endedAt)}</span>
      </button>
    ),
  },
  {
    key: "character",
    title: "Character",
    sort: (segment) => segment.character,
    cell: (segment) => <>
      <ClassDot classFile={segment.classFile} />{segment.character}
      {segment.level == null ? null : <> <span className="muted">Level {segment.level}</span></>}
    </>,
  },
  { key: "instance", title: "Location", cell: (s) => s.instance, sort: (s) => s.instance },
  {
    key: "activities", title: "Activity", always: true,
    cell: (s) => listCell(s.activities, activityText), sort: (s) => activityText(s.activities),
  },
  {
    key: "type", title: "Type", sort: (s) => locationType(s),
    cell: (s) => <span className="badge">{locationType(s)}</span>,
  },
  {
    key: "difficulty", title: "Difficulty", sort: (s) => s.difficulty,
    cell: (s) => s.difficulty || <span className="muted">—</span>,
  },
  { key: "seconds", title: "Time", num: true, cell: (s) => duration(s.seconds), sort: (s) => s.seconds },
  {
    key: "lootValue", title: "Loot value", num: true, sort: (s) => s.lootValue,
    cell: (s) => <span className="gold">{gold(s.lootValue)}</span>,
  },
  {
    key: "goldDiff", title: "Gold Δ", num: true, sort: (s) => s.goldDiff,
    cell: (s) => <span className={s.goldDiff < 0 ? "loss" : "gold"}>{signedGold(s.goldDiff)}</span>,
  },
  eventColumn({ key: "achievements", title: "Achievements", text: achievementText, optional: true }),
  eventColumn({ key: "levelUps", title: "Level ups", text: levelUpText, optional: true }),
  eventColumn({
    key: "currencies", title: "Currency", text: currencyText, optional: true,
    sort: (s) => (s.currencies || []).reduce((total, gain) => total + gain.amount, 0),
  }),
  eventColumn({ key: "mounts", title: "Mounts", text: collectionText, optional: true }),
  eventColumn({ key: "pets", title: "Pets", text: collectionText, optional: true }),
  eventColumn({ key: "quests", title: "Quests", text: questText, optional: true }),
  eventColumn({
    key: "reputation", title: "Reputation", text: repText, optional: true,
    sort: (s) => (s.reputation || []).reduce((total, gain) => total + gain.amount, 0),
  }),
  eventColumn({ key: "toys", title: "Toys", text: collectionText, optional: true }),
  eventColumn({ key: "transmogs", title: "Transmog", text: transmogText, optional: true }),
  eventColumn({ key: "equipsetChanges", title: "Equipment sets", text: equipsetText, optional: true }),
  eventColumn({ key: "housingItems", title: "Housing items", text: housingText, optional: true }),
  {
    key: "housingXP", title: "Housing XP", num: true, sort: (s) => s.housingXP || 0,
    cell: (s) => (s.housingXP ? signed(s.housingXP) : <span className="muted">—</span>),
    when: (segments) => segments.some((segment) => (segment.housingXP || 0) !== 0),
  },
  eventColumn({ key: "housingLevelUps", title: "Housing levels", text: levelUpText, optional: true }),
];

/**
 * Which columns this history justifies. A column for something the player has never done is a
 * column of dashes, so it is left out — except Activity, which is the one column a user fills
 * in themselves and so must be visible before it has anything in it.
 */
function columnsFor(segments: Segment[]): Column[] {
  return ALL_COLUMNS.filter((column) => {
    if (column.always) return true;
    if (column.when) return column.when(segments);
    if (!column.optional) return true;
    return segments.some((segment) => (column.events?.(segment) ?? []).length > 0);
  });
}

/** Ordering within one column, where both values are always of the same kind. */
function ascendingOrder(a: SortValue, b: SortValue): number {
  const greater = typeof a === "number" && typeof b === "number" ? a > b : String(a) > String(b);
  return greater ? 1 : -1;
}

export interface DetailsProps {
  segments: Segment[];
  /**
   * Given the segment to show and the rows in their current order, so the modal's next and
   * previous follow whatever the reader had sorted and filtered to.
   */
  onOpenSegment: OpenSegment;
}

export function Details({ segments, onOpenSegment }: DetailsProps): ReactNode {
  const [term, setTerm] = useState("");
  const [character, setCharacter] = useState("");
  const [day, setDay] = useState("");
  const [sortKey, setSortKey] = useState("day");
  const [ascending, setAscending] = useState(false);

  const columns = useMemo(() => columnsFor(segments), [segments]);
  const characters = useMemo(
    () => [...new Set(segments.map((entry) => entry.character))].sort(), [segments],
  );
  const days = useMemo(
    () => [...new Set(segments.map((entry) => entry.day))].sort().reverse(), [segments],
  );

  const rows = useMemo(() => {
    const wanted = term.trim().toLowerCase();
    const filtered = segments.filter((segment) =>
      (!character || segment.character === character) &&
      (!day || segment.day === day) &&
      (!wanted || `${segment.instance} ${segment.character} ${segment.difficulty}`.toLowerCase().includes(wanted)));

    const column = columns.find((entry) => entry.key === sortKey) || columns[0];
    return filtered.sort((left, right) => {
      const a = column.sort(left), b = column.sort(right);
      if (a === b) return left.id < right.id ? -1 : 1;
      return ascendingOrder(a, b) * (ascending ? 1 : -1);
    });
  }, [segments, columns, term, character, day, sortKey, ascending]);

  // A filter narrowed to something no longer on offer would leave the table empty with no way
  // back, so a value this history has stopped holding falls back to "all".
  const chosenCharacter = characters.includes(character) ? character : "";
  const chosenDay = days.includes(day) ? day : "";

  const sortBy = (key: string): void => {
    if (key === sortKey) setAscending((up) => !up);
    else { setSortKey(key); setAscending(false); }
  };

  return (
    <section className="panel">
      <div className="table-head">
        <div className="controls">
          <input
            id="search" type="search" placeholder="Filter location or character…"
            aria-label="Filter segments" value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
          <select
            id="character" aria-label="Character" value={chosenCharacter}
            onChange={(event) => setCharacter(event.target.value)}
          >
            <option value="">All characters</option>
            {characters.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select
            id="day" aria-label="Day" value={chosenDay}
            onChange={(event) => setDay(event.target.value)}
          >
            <option value="">All days</option>
            {days.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <span className="count" id="count">{rows.length} of {segments.length} segments</span>
        </div>
      </div>
      <div className="scroller">
        <table>
          <thead>
            <tr id="head">
              {columns.map((column) => (
                <th
                  key={column.key} className={column.num ? "num" : undefined}
                  aria-sort={column.key === sortKey ? (ascending ? "ascending" : "descending") : "none"}
                  onClick={() => sortBy(column.key)}
                >
                  {column.title} {column.key === sortKey
                    ? <span className="arrow">{ascending ? "▲" : "▼"}</span>
                    : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody id="rows">
            {rows.map((segment) => (
              <tr
                key={segment.segmentId}
                onClick={(event) => {
                  // A link in a cell leads out of the window; opening the segment as well
                  // would take the reader somewhere they did not ask to go.
                  if (event.target instanceof Element && event.target.closest("a")) return;
                  onOpenSegment(segment.segmentId, rows);
                }}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.num ? "num" : undefined}>
                    {column.cell(segment, () => onOpenSegment(segment.segmentId, rows))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="empty" id="empty" hidden={rows.length > 0}>
        {segments.length ? "No segments match those filters." : "No segments collected yet."}
      </div>
    </section>
  );
}
