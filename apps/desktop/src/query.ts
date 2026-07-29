/**
 * What an answer means, and what a chart of two of its columns looks like.
 *
 * The backend hands back columns and rows and nothing else — it has no opinion about which
 * of them is worth plotting, and should not have one. Everything between "here are 40 rows"
 * and "here is a bar per instance with a gold axis up the side" is here, as arithmetic over
 * plain values: which columns hold numbers, where a tick belongs, how tall a bar is.
 *
 * It is arithmetic rather than drawing on purpose. `queryChart.tsx` turns a [`Plot`] into
 * SVG and makes no decisions of its own, so every rule worth arguing about — a bar chart's
 * axis starting at zero, a row with no number in it being left out rather than drawn as
 * zero, a category axis thinning its labels rather than overprinting them — is settled here
 * where a test can hold it still.
 *
 * Nothing in here aggregates. Two rows with the same category are two bars, because the tool
 * on the other side of this is SQL and `GROUP BY` is how somebody says what they meant.
 */

import { escapeHtml } from "./format";
import type { QueryAnswer, QueryCell } from "./types";

/** How many rows one answer carries at most. Mirrors the ceiling in `query::MAX_ROWS`. */
export const MAX_ROWS = 5000;

/** How many rows are asked for unless somebody says otherwise. */
export const DEFAULT_LIMIT = 500;

/** The three shapes a pair of columns can be drawn as. */
export type Shape = "bar" | "line" | "scatter";

export const SHAPES: readonly Shape[] = ["bar", "line", "scatter"];

/** What a column holds, judged from the values that came back rather than from a declared
 * type — the column may be an expression nobody declared anything about. */
export type ColumnKind = "number" | "text" | "empty";

/** Which columns to plot against which, as indexes into `answer.columns`. */
export interface Axes {
  x: number;
  y: number;
  shape: Shape;
}

/* ---------- reading an answer ---------- */

/**
 * What each column holds.
 *
 * A column of numbers with nulls in it is still a column of numbers: `AVG` over a group with
 * nothing in it is null, and a column that stopped being plottable because one row was empty
 * would be maddening. A column with nothing but nulls is `empty`, which is neither.
 */
export function columnKinds(answer: QueryAnswer): ColumnKind[] {
  return answer.columns.map((_name, at) => {
    let seen = false;
    for (const row of answer.rows) {
      const cell = row[at];
      if (cell === null || cell === undefined) continue;
      if (typeof cell !== "number" || !Number.isFinite(cell)) return "text";
      seen = true;
    }
    return seen ? "number" : "empty";
  });
}

/** The columns something could be plotted up the side of. */
export const numericColumns = (answer: QueryAnswer): number[] =>
  columnKinds(answer).flatMap((kind, at) => (kind === "number" ? [at] : []));

/**
 * The pair of columns to draw before anybody has chosen one.
 *
 * The convention every reporting tool has settled on, because it is the shape a `GROUP BY`
 * comes back in: the first column that is not a number is what the rows are *of*, and the
 * first that is a number is what is being counted. An answer with no numbers in it has
 * nothing to plot and says so by answering `null`.
 */
export function defaultAxes(answer: QueryAnswer): Axes | null {
  const kinds = columnKinds(answer);
  const numbers = kinds.flatMap((kind, at) => (kind === "number" ? [at] : []));
  const first = numbers[0];
  if (first === undefined) return null;
  const labels = kinds.findIndex((kind) => kind !== "number");
  if (labels >= 0) return { x: labels, y: first, shape: "bar" };
  // Nothing but numbers, which is a relationship rather than a set of categories — and a bar
  // chart of one number against another is the wrong picture of one. Left to right in the
  // order they were selected, because `SELECT keystone_level, minutes` says which of the two
  // the reader thinks is doing the explaining.
  const second = numbers[1];
  if (second !== undefined) return { x: first, y: second, shape: "scatter" };
  // One column, and nothing to say what its rows are of: the values stand in for their own
  // labels, in the order the query returned them.
  return { x: first, y: first, shape: "bar" };
}

/** What the answer amounts to, for the line under the editor. */
export function summary(answer: QueryAnswer): string {
  const rows = answer.rows.length === 1 ? "1 row" : `${answer.rows.length.toLocaleString()} rows`;
  const columns = answer.columns.length === 1 ? "1 column" : `${answer.columns.length} columns`;
  return `${rows} · ${columns} · ${answer.elapsedMs.toLocaleString()} ms`;
}

/** One cell as a table shows it. A null is a dash, because an empty cell reads as a bug. */
export function cellText(cell: QueryCell): string {
  if (cell === null || cell === undefined) return "—";
  if (typeof cell === "number") {
    return Number.isInteger(cell)
      ? cell.toLocaleString()
      : cell.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return cell;
}

/* ---------- the chart ---------- */

/** One bar. Everything is in the plot's own coordinates, which the SVG is sized in. */
export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The row this came from, so a click can take somebody to it. */
  row: number;
  /** Markup for the shared floating tooltip. Escaped here, where the values are. */
  tip: string;
}

export interface Point {
  x: number;
  y: number;
  row: number;
  tip: string;
}

export interface Tick {
  /** Where the line or label sits, in plot coordinates. */
  at: number;
  label: string;
}

/** A chart, worked out but not yet drawn. */
export interface Plot {
  shape: Shape;
  width: number;
  height: number;
  /** The rectangle the data is drawn inside, leaving room for the two axes. */
  frame: { left: number; right: number; top: number; bottom: number };
  bars: Bar[];
  points: Point[];
  /** The `d` of the line through the points, empty for the shapes that have no line. */
  path: string;
  xTicks: Tick[];
  yTicks: Tick[];
  xLabel: string;
  yLabel: string;
  /** Rows whose value column held nothing to plot. Reported rather than drawn as zero. */
  skipped: number;
}

const WIDTH = 880;
const HEIGHT = 380;
const FRAME = { left: 78, right: 18, top: 18, bottom: 54 };
/** More category labels than this and they overprint, so only some of them are drawn. */
const MAX_X_LABELS = 12;
const MAX_LABEL_CHARS = 16;

/**
 * The chart for a pair of columns, or `null` when there is nothing to draw.
 *
 * Null rather than an empty chart: an axis with no data under it claims a range nobody
 * measured, and the view has something to say about "no rows to plot" that a picture cannot.
 */
export function plot(answer: QueryAnswer, axes: Axes): Plot | null {
  const { x: xAt, y: yAt, shape } = axes;
  if (!answer.columns[xAt] || !answer.columns[yAt]) return null;

  const usable = answer.rows.flatMap((row, at) => {
    const value = row[yAt];
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    return [{ row: at, value, label: cellText(row[xAt] ?? null), key: row[xAt] }];
  });
  const skipped = answer.rows.length - usable.length;
  if (!usable.length) return null;

  // A bar is read from its base, so its axis starts at zero however far away that is. A line
  // or a scatter is read from its shape, and forcing zero in flattens the thing being looked
  // at — a level that moved between 68 and 70 against an axis from 0 is a straight line.
  const values = usable.map((entry) => entry.value);
  const span = niceScale(
    shape === "bar" ? Math.min(0, ...values) : Math.min(...values),
    shape === "bar" ? Math.max(0, ...values) : Math.max(...values),
  );
  const plotHeight = HEIGHT - FRAME.top - FRAME.bottom;
  const plotWidth = WIDTH - FRAME.left - FRAME.right;
  const yOf = (value: number): number =>
    FRAME.top + plotHeight * (1 - (value - span.lo) / (span.hi - span.lo));

  const yTicks = span.ticks.map((value) => ({ at: yOf(value), label: axisNumber(value) }));
  const numericX = shape !== "bar" && usable.every((entry) => typeof entry.key === "number");

  const drawn = numericX
    ? [...usable].sort((one, other) => (one.key as number) - (other.key as number))
    : usable;

  const xSpan = numericX
    ? niceScale(
        Math.min(...drawn.map((entry) => entry.key as number)),
        Math.max(...drawn.map((entry) => entry.key as number)),
      )
    : null;
  // A category axis puts each row in the middle of its own band, which is what leaves a bar
  // room to be a bar. A numeric axis puts it where its value says.
  const band = plotWidth / drawn.length;
  const xOf = (entry: { key: QueryCell }, index: number): number =>
    xSpan
      ? FRAME.left + plotWidth * (((entry.key as number) - xSpan.lo) / (xSpan.hi - xSpan.lo))
      : FRAME.left + band * (index + 0.5);

  const xLabel = answer.columns[xAt] ?? "";
  const yLabel = answer.columns[yAt] ?? "";
  const tipOf = (entry: { label: string; value: number }): string =>
    `<b>${escapeHtml(clip(entry.label))}</b>${escapeHtml(yLabel)}: ${escapeHtml(cellText(entry.value))}`;

  const points = drawn.map((entry, index) => ({
    row: entry.row,
    x: xOf(entry, index),
    y: yOf(entry.value),
    tip: tipOf(entry),
  }));

  const base = yOf(Math.min(Math.max(0, span.lo), span.hi));
  const barWidth = Math.max(Math.min(band * 0.72, 64), 1);
  const bars =
    shape === "bar"
      ? drawn.map((entry, index) => {
          const top = yOf(entry.value);
          return {
            row: entry.row,
            x: xOf(entry, index) - barWidth / 2,
            // A bar for a value of zero would be invisible and unhoverable, so it keeps a hairline.
            y: Math.min(top, base),
            width: barWidth,
            height: Math.max(Math.abs(base - top), 1),
            tip: tipOf(entry),
          };
        })
      : [];

  return {
    shape,
    width: WIDTH,
    height: HEIGHT,
    frame: FRAME,
    bars,
    points: shape === "bar" ? [] : points,
    path: shape === "line" ? line(points) : "",
    xTicks: xSpan
      ? xSpan.ticks.map((value) => ({
          at: FRAME.left + plotWidth * ((value - xSpan.lo) / (xSpan.hi - xSpan.lo)),
          label: axisNumber(value),
        }))
      : thinned(
          drawn.map((entry, index) => ({
            at: xOf(entry, index),
            label: clip(entry.label),
          })),
        ),
    yTicks,
    xLabel,
    yLabel,
    skipped,
  };
}

/** The line through a set of points, in the order they are given. */
const line = (points: Point[]): string =>
  points.map((point, index) => `${index ? "L" : "M"}${round(point.x)} ${round(point.y)}`).join(" ");

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Every label that fits, and none of the ones that would sit on top of each other.
 *
 * Evenly spaced rather than "the first twelve", so a hundred days of play still reads as a
 * range from one date to another rather than as the first fortnight and then silence. The
 * last one is always kept, because the far end of an axis is half of what an axis says.
 */
function thinned(ticks: Tick[]): Tick[] {
  if (ticks.length <= MAX_X_LABELS) return ticks;
  const every = Math.ceil(ticks.length / MAX_X_LABELS);
  return ticks.filter((_tick, index) => index % every === 0 || index === ticks.length - 1);
}

const clip = (label: string): string =>
  label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;

/**
 * An axis somebody can read numbers off: round steps, and a range that ends on one.
 *
 * The 1-2-5 rule, which is what every plotting library has converged on because those are
 * the intervals people divide by in their heads. A single repeated value gets a range
 * invented around it — an axis of zero width has no positions on it at all.
 */
export function niceScale(
  low: number,
  high: number,
  count = 5,
): {
  lo: number;
  hi: number;
  ticks: number[];
} {
  let lo = Math.min(low, high);
  let hi = Math.max(low, high);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (lo === hi) {
    const room = Math.abs(lo) > 0 ? Math.abs(lo) / 2 : 1;
    lo -= room;
    hi += room;
  }
  const step = niceStep((hi - lo) / count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Counted rather than accumulated: adding a step to itself twenty times is how an axis
  // ends up labelled 0.30000000000000004.
  for (let index = 0; lo + index * step <= hi + step / 1000; index += 1) {
    ticks.push(exact(lo + index * step));
  }
  return { lo: exact(lo), hi: exact(hi), ticks };
}

function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rough) || 1));
  const scaled = Math.abs(rough) / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Away with the tail an IEEE double grows when a round number is divided and multiplied. */
const exact = (value: number): number => Number(value.toPrecision(12));

/**
 * A number as an axis says it: three digits at most, and a suffix past a thousand.
 *
 * An axis is scanned rather than read, and "1.2M" is scanned; "1,200,000" makes every label
 * as wide as the chart's margin and is not more informative at the resolution of a tick.
 */
export function axisNumber(value: number): string {
  const size = Math.abs(value);
  if (size >= 1e9) return `${trim(value / 1e9)}B`;
  if (size >= 1e6) return `${trim(value / 1e6)}M`;
  // From a thousand rather than from ten thousand, so that one axis cannot carry "8,000"
  // and "12k" as two of its own labels.
  if (size >= 1e3) return `${trim(value / 1e3)}k`;
  if (size >= 1) return trim(value);
  if (size === 0) return "0";
  return String(exact(value));
}

const trim = (value: number): string =>
  Number(value.toFixed(Math.abs(value) < 10 ? 1 : 0)).toLocaleString();

/* ---------- somewhere to start ---------- */

/** A question worth asking, the query that asks it, and the chart it is worth drawing as. */
export interface Recipe {
  name: string;
  /** What it answers, in the words somebody would use to want it. */
  about: string;
  sql: string;
  /** The columns to plot, by name, so a recipe survives a column being added to its select. */
  chart?: { x: string; y: string; shape: Shape };
}

/**
 * The queries the view opens with.
 *
 * Not documentation of the schema — the table list beside the editor is that. These are the
 * questions somebody has after a year of playing that no tab in this app answers, written
 * out so that the first thing a reader does with a SQL editor is press Run rather than go
 * and read fourteen migration files.
 */
export const RECIPES: Recipe[] = [
  {
    name: "Hours per character",
    about: "Where the time actually went, once every evening is added up.",
    sql: `SELECT c.name AS character,
       ROUND(SUM(s.duration_seconds) / 3600.0, 1) AS hours
FROM segments s
JOIN characters c ON c.id = s.character_id
GROUP BY c.name
ORDER BY hours DESC`,
    chart: { x: "character", y: "hours", shape: "bar" },
  },
  {
    name: "Hours per day",
    about: "The shape of a year: which weeks were played and which were not.",
    sql: `SELECT s.ended_day AS day,
       ROUND(SUM(s.duration_seconds) / 3600.0, 2) AS hours
FROM segments s
GROUP BY s.ended_day
ORDER BY s.ended_day`,
    chart: { x: "day", y: "hours", shape: "line" },
  },
  {
    name: "When the evening starts",
    about: "Play by hour of the day, on this machine's clock.",
    sql: `SELECT CAST(strftime('%H', s.started_at, 'unixepoch', 'localtime') AS INTEGER) AS hour_of_day,
       ROUND(SUM(s.duration_seconds) / 3600.0, 1) AS hours
FROM segments s
GROUP BY hour_of_day
ORDER BY hour_of_day`,
    chart: { x: "hour_of_day", y: "hours", shape: "bar" },
  },
  {
    name: "Gold per hour, by place",
    about: "What an hour is worth where, counting only places worth a quarter of one.",
    sql: `SELECT s.instance_name AS place,
       ROUND(SUM(s.loot_value) / 10000.0 / (SUM(s.duration_seconds) / 3600.0), 1) AS gold_per_hour,
       ROUND(SUM(s.duration_seconds) / 3600.0, 1) AS hours
FROM segments s
GROUP BY s.instance_name
HAVING SUM(s.duration_seconds) > 900
ORDER BY gold_per_hour DESC
LIMIT 20`,
    chart: { x: "place", y: "gold_per_hour", shape: "bar" },
  },
  {
    name: "Bosses, killed and not",
    about: "Every encounter recorded, and how many attempts it did not survive.",
    sql: `SELECT e.name AS boss,
       SUM(e.success) AS kills,
       COUNT(*) - SUM(e.success) AS wipes
FROM encounters e
GROUP BY e.name
ORDER BY wipes DESC, kills DESC
LIMIT 25`,
    chart: { x: "boss", y: "wipes", shape: "bar" },
  },
  {
    name: "Keystones, by level",
    about: "How long a run takes as the key goes up, counting only the ones completed.",
    sql: `SELECT k.level AS keystone_level,
       ROUND(AVG(k.duration_ms) / 60000.0, 1) AS average_minutes,
       COUNT(*) AS runs
FROM keystone_runs k
WHERE k.completed = 1 AND k.duration_ms IS NOT NULL
GROUP BY k.level
ORDER BY k.level`,
    chart: { x: "keystone_level", y: "average_minutes", shape: "line" },
  },
  {
    name: "Currency earned",
    about: "Every currency the account has been paid, most of it first.",
    sql: `SELECT g.name AS currency,
       SUM(g.amount) AS gained
FROM currency_gains g
GROUP BY g.name
ORDER BY gained DESC
LIMIT 20`,
    chart: { x: "currency", y: "gained", shape: "bar" },
  },
  {
    name: "The last fifty segments",
    about: "Everything recorded about the most recent evenings, column by column.",
    sql: `SELECT * FROM segments ORDER BY ended_at DESC LIMIT 50`,
  },
];

/**
 * What clicking a table in the list asks for: all of it, fifty rows deep.
 *
 * The name is quoted the way SQLite quotes an identifier rather than pasted in bare. Nothing
 * in this schema needs it, and the list is drawn from whatever the database actually holds —
 * so a table somebody's own migration named `order` would otherwise produce a query that
 * fails on a reserved word.
 */
export const everything = (table: string): Recipe => ({
  name: table,
  about: `Every column of ${table}.`,
  sql: `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 50`,
});

/**
 * The axes a recipe asked for, resolved against the answer that actually came back.
 *
 * By name rather than by position, and `null` when a name is not there: a query somebody has
 * edited since picking the recipe is the ordinary case, and pointing the chart at whatever
 * happens to be in column two would draw a confident picture of the wrong thing.
 */
export function recipeAxes(answer: QueryAnswer, recipe?: Recipe | null): Axes | null {
  if (!recipe?.chart) return null;
  const x = answer.columns.indexOf(recipe.chart.x);
  const y = answer.columns.indexOf(recipe.chart.y);
  return x < 0 || y < 0 ? null : { x, y, shape: recipe.chart.shape };
}
