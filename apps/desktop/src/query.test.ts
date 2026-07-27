import { describe, expect, it } from "vitest";

import {
  RECIPES, axisNumber, cellText, columnKinds, defaultAxes, everything, niceScale, plot,
  recipeAxes, summary,
} from "./query";
import type { ColumnKind, Recipe } from "./query";
import type { QueryAnswer, QueryCell } from "./types";

/**
 * An answer with only the parts a test cares about.
 *
 * The shape is the backend's own — columns, rows, whether it was cut short, how long it took —
 * so nothing here is a story about a fake type that the real one could drift away from.
 */
function answer(
  columns: string[],
  rows: QueryCell[][],
  overrides: Partial<QueryAnswer> = {},
): QueryAnswer {
  return { columns, rows, truncated: false, elapsedMs: 3, ...overrides };
}

const FRAME_RIGHT = 880 - 18;
const FRAME_BOTTOM = 380 - 54;

describe("columnKinds", () => {
  it.each<[string, ColumnKind, QueryCell[][]]>([
    ["a column of numbers", "number", [[1], [2], [3]]],
    // `AVG` over a group with nothing in it is null, and a column that stopped being
    // plottable because one evening had no loot in it would be maddening.
    ["numbers with a null among them", "number", [[1], [null], [3]]],
    // Nothing to plot and nothing to read either, so neither of the other two answers is true.
    ["nothing but nulls", "empty", [[null], [null]]],
    ["no rows at all", "empty", []],
    // A column SQLite handed back as text once is text, wherever in it that happened: half a
    // column of numbers plotted against a gap is a picture of the wrong thing.
    ["a number and then a word", "text", [[1], ["n/a"]]],
    ["a word and then a number", "text", [["n/a"], [1]]],
    ["a figure that came back as a string", "text", [["12"], ["13"]]],
  ])("says %s is a %s column", (_case, expected, rows) => {
    expect(columnKinds(answer(["value"], rows))).toEqual([expected]);
  });

  it("judges every column separately", () => {
    const kinds = columnKinds(answer(["place", "hours", "note"], [["Vale", 2, null]]));

    expect(kinds).toEqual(["text", "number", "empty"]);
  });
});

describe("defaultAxes", () => {
  // The shape a `GROUP BY` comes back in, which is what makes this the convention every
  // reporting tool has settled on: the names go along the bottom, the count goes up the side.
  it("puts the first column that names things across the bottom", () => {
    const grouped = answer(["character", "hours", "gold"], [["Aster-Vale", 12, 500]]);

    expect(defaultAxes(grouped)).toEqual({ x: 0, y: 1, shape: "bar" });
  });

  it("finds the labels wherever they are, not only in the first column", () => {
    const grouped = answer(["hours", "character"], [[12, "Aster-Vale"]]);

    expect(defaultAxes(grouped)).toEqual({ x: 1, y: 0, shape: "bar" });
  });

  // Two numbers are a relationship rather than a set of categories, and a bar chart of one
  // number against another draws bands where there are none. Left to right in the order they
  // were selected, because `SELECT keystone_level, minutes` says which of the two the reader
  // thinks is doing the explaining.
  it("draws a pair of number columns as a scatter, in the order they were selected", () => {
    const pair = answer(["keystone_level", "minutes"], [[10, 24], [12, 27]]);

    expect(defaultAxes(pair)).toEqual({ x: 0, y: 1, shape: "scatter" });
  });

  // A single column of numbers has nothing to say what its rows are of, so the values stand in
  // for their own labels rather than the view refusing to draw anything at all.
  it("falls back to plotting a lone number column against itself", () => {
    expect(defaultAxes(answer(["hours"], [[1], [2]]))).toEqual({ x: 0, y: 0, shape: "bar" });
  });

  it.each<[string, QueryAnswer]>([
    ["every column is text", answer(["character", "realm"], [["Aster", "Vale"]])],
    ["every column is empty", answer(["note"], [[null]])],
    ["there are no rows to judge by", answer(["character", "hours"], [])],
  ])("answers null when %s", (_case, nothing) => {
    expect(defaultAxes(nothing)).toBeNull();
  });
});

describe("recipeAxes", () => {
  const recipe: Recipe = {
    name: "Hours per character",
    about: "Where the time went.",
    sql: "SELECT 1",
    chart: { x: "character", y: "hours", shape: "bar" },
  };

  // By name rather than by position, so adding a column to the select does not silently move
  // the chart one along.
  it("resolves the columns a recipe named to wherever they came back", () => {
    const shifted = answer(["realm", "character", "gold", "hours"], [["Vale", "Aster", 5, 12]]);

    expect(recipeAxes(shifted, recipe)).toEqual({ x: 1, y: 3, shape: "bar" });
  });

  it.each<[string, QueryAnswer]>([
    ["the column it plots along the bottom is gone", answer(["hours"], [[12]])],
    ["the column it plots up the side is gone", answer(["character"], [["Aster"]])],
  ])("answers null when %s", (_case, edited) => {
    // Somebody editing the query after picking the recipe is the ordinary case, and pointing
    // the chart at whatever happens to be in column two would draw a confident wrong picture.
    expect(recipeAxes(edited, recipe)).toBeNull();
  });

  it.each<[string, Recipe | null | undefined]>([
    ["a recipe with nothing worth charting", { name: "Rows", about: "All of it", sql: "SELECT 1" }],
    ["no recipe at all", null],
    ["nothing passed", undefined],
  ])("answers null for %s", (_case, without) => {
    expect(recipeAxes(answer(["character", "hours"], [["Aster", 12]]), without)).toBeNull();
  });

  // The recipes are the view's own opening question, so a chart naming a column its own SQL
  // does not select would leave the first thing a reader sees blank.
  it("resolves every recipe's chart against the columns that recipe selects", () => {
    for (const shipped of RECIPES) {
      if (!shipped.chart) continue;
      const columns = [...new Set([shipped.chart.x, shipped.chart.y])];
      expect(recipeAxes(answer(columns, [[1, 2]]), shipped)).not.toBeNull();
    }
  });
});

describe("everything", () => {
  // Nothing in this schema needs quoting, but the list is drawn from whatever the database
  // holds — a table somebody's own migration named `order` would fail on a reserved word.
  it("quotes the table name the way SQLite quotes an identifier", () => {
    expect(everything("order").sql).toBe('SELECT * FROM "order" LIMIT 50');
  });

  // The only character that can end the quoting early, so it is the only one worth doubling.
  it("doubles a double quote inside the name rather than ending the quoting", () => {
    expect(everything('we"ird').sql).toBe('SELECT * FROM "we""ird" LIMIT 50');
  });

  it("names the recipe after the table, so the chip reads as the table it opens", () => {
    expect(everything("segments").name).toBe("segments");
    expect(everything("segments").chart).toBeUndefined();
  });
});

describe("summary", () => {
  it.each<[string, QueryAnswer, string]>([
    // "1 rows" is the tell that nobody read the line before shipping it.
    ["one of each", answer(["hours"], [[1]], { elapsedMs: 1 }), "1 row · 1 column · 1 ms"],
    ["several", answer(["a", "b"], [[1, 2], [3, 4]], { elapsedMs: 12 }),
      "2 rows · 2 columns · 12 ms"],
    ["none", answer(["a", "b"], [], { elapsedMs: 0 }), "0 rows · 2 columns · 0 ms"],
  ])("says what %s amounts to", (_case, given, expected) => {
    expect(summary(given)).toBe(expected);
  });

  // A five figure row count read as "12345" is a number somebody has to count the digits of.
  it("groups a large row count the way the reader's locale does", () => {
    const many = answer(["hours"], Array.from({ length: 1234 }, () => [1]), { elapsedMs: 2048 });
    const rows = (1234).toLocaleString();
    const elapsed = (2048).toLocaleString();

    expect(summary(many)).toBe(`${rows} rows · 1 column · ${elapsed} ms`);
  });
});

describe("cellText", () => {
  it.each<[string, string, QueryCell]>([
    // An empty cell reads as a bug in the table rather than as an empty cell in the database.
    ["a null", "—", null],
    ["a whole number", (1234).toLocaleString(), 1234],
    ["a fraction", "12.5", 12.5],
    // Four places is where a rounded average stops being a number and starts being noise.
    ["a fraction longer than the table can show", "0.3333", 1 / 3],
    ["a zero", "0", 0],
    ["a negative", "-5", -5],
    ["text", "Aster-Vale", "Aster-Vale"],
    ["empty text, which is not a null", "", ""],
  ])("shows %s as %s", (_case, expected, cell) => {
    expect(cellText(cell)).toBe(expected);
  });
});

describe("niceScale", () => {
  // The 1-2-5 rule: the intervals people divide by in their heads, so the axis can be read
  // rather than decoded.
  it.each<[number, number, number[]]>([
    [0, 97, [0, 20, 40, 60, 80, 100]],
    [0, 1, [0, 0.2, 0.4, 0.6, 0.8, 1]],
    [0, 10, [0, 2, 4, 6, 8, 10]],
  ])("puts round steps between %s and %s", (low, high, ticks) => {
    expect(niceScale(low, high).ticks).toEqual(ticks);
  });

  // An axis of zero width has no positions on it at all, which is a chart that cannot be drawn
  // rather than a chart of one value.
  it("invents a range around a value that never changed", () => {
    const span = niceScale(50, 50);

    expect(span.lo).toBeLessThan(50);
    expect(span.hi).toBeGreaterThan(50);
    expect(span.ticks.length).toBeGreaterThan(1);
  });

  it("gives a column of zeroes a range too, where halving the value would not", () => {
    const span = niceScale(0, 0);

    expect(span.lo).toBeLessThan(0);
    expect(span.hi).toBeGreaterThan(0);
  });

  // Adding a step to itself twenty times is how an axis ends up labelled 0.30000000000000004.
  // The ticks are the strings a reader sees, so a tail in one of them is a tail on the chart.
  it.each<[number, number]>([[0, 1], [0, 0.7], [-0.3, 0.3], [0, 3]])(
    "leaves no floating point tail in the ticks between %s and %s",
    (low, high) => {
      const span = niceScale(low, high);

      for (const tick of span.ticks) {
        expect(String(tick).replace("-", "").replace(".", "").length).toBeLessThanOrEqual(6);
        expect(tick).toBe(Number(tick.toPrecision(12)));
      }
    },
  );

  it("takes the two ends in either order", () => {
    expect(niceScale(97, 0)).toEqual(niceScale(0, 97));
  });

  // A range nobody measured — an empty column reaching this through `Math.min` of nothing —
  // gets a range rather than an axis of NaN ticks.
  it("stands something in for a range that is not a number", () => {
    const span = niceScale(Number.NaN, Number.POSITIVE_INFINITY);

    expect(span).toEqual({ lo: 0, hi: 1, ticks: [0, 1] });
  });
});

describe("axisNumber", () => {
  // An axis is scanned rather than read: "1.2M" is scanned, "1,200,000" is as wide as the
  // margin and no more informative at the resolution of a tick.
  it.each<[number, string]>([
    [0, "0"],
    [5, "5"],
    // A tick is a position, not a measurement: past ten there is no room for a decimal place
    // and no question a chart answers by carrying one.
    [12.5, "13"],
    // From a thousand rather than from ten thousand, so that one axis cannot carry "8,000"
    // and "12k" as two of its own labels.
    [1200, "1.2k"],
    [8000, "8k"],
    [12_000, "12k"],
    [1_500_000, "1.5M"],
    [2_500_000_000, "2.5B"],
    [-1_500_000, "-1.5M"],
    [0.25, "0.25"],
    [-0.5, "-0.5"],
  ])("says %s as %s", (value, expected) => {
    expect(axisNumber(value)).toBe(expected);
  });
});

describe("plot", () => {
  const LEVELS = answer(["day", "level"], [["Mon", 68], ["Tue", 70], ["Wed", 69]]);

  // A bar is read from its base, so the base has to be on the chart. Bars of 68, 69 and 70
  // against an axis starting at 68 say the middle one is a third of the last one.
  it("starts a bar chart's axis at zero however far away the values are", () => {
    const drawn = plot(LEVELS, { x: 0, y: 1, shape: "bar" });

    expect(drawn?.yTicks.map((tick) => tick.label)).toContain("0");
  });

  // A line is read from its shape, and forcing zero in flattens the thing being looked at —
  // a level that moved between 68 and 70 against an axis from 0 is a straight line.
  it.each<["line" | "scatter"]>([["line"], ["scatter"]])(
    "leaves zero off a %s chart's axis when nothing is near it",
    (shape) => {
      const drawn = plot(LEVELS, { x: 0, y: 1, shape });

      // The ticks run from the bottom of the axis up, and the bottom of this one is the
      // smallest level seen rather than an origin nothing was measured against.
      expect(drawn?.yTicks.map((tick) => tick.label)).not.toContain("0");
      expect(drawn?.yTicks[0]?.label).toBe("68");
    },
  );

  // Drawing a row with nothing in its value column as a bar of zero invents a measurement.
  // Counting it out loud is what lets a reader tell "no loot" from "no row".
  it("counts the rows with no number in them instead of drawing them as zero", () => {
    const patchy = answer(
      ["place", "gold_per_hour"],
      [["Vale", 120], ["Caverns", null], ["Hearth", "unknown"]],
    );

    const drawn = plot(patchy, { x: 0, y: 1, shape: "bar" });

    expect(drawn?.skipped).toBe(2);
    expect(drawn?.bars).toHaveLength(1);
    expect(drawn?.bars[0]?.row).toBe(0);
  });

  // The SVG is sized in these coordinates and does not clip, so a bar outside the frame is a
  // bar drawn over the axis labels.
  it("keeps every bar inside the frame the axes leave for it", () => {
    const places = answer(
      ["place", "hours"],
      [["Vale", 12], ["Caverns", 3], ["Hearth", 40], ["Reach", 21], ["Spire", 7]],
    );

    const drawn = plot(places, { x: 0, y: 1, shape: "bar" });

    expect(drawn?.bars).toHaveLength(5);
    for (const bar of drawn?.bars ?? []) {
      expect(bar.x).toBeGreaterThanOrEqual(drawn?.frame.left ?? 0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(FRAME_RIGHT);
      expect(bar.y).toBeGreaterThanOrEqual(drawn?.frame.top ?? 0);
      expect(bar.y + bar.height).toBeLessThanOrEqual(FRAME_BOTTOM);
    }
  });

  // A bar of no height is a bar nobody can hover, and "the place with no loot" is exactly the
  // row somebody is looking for the tooltip of.
  it("leaves a hairline where a bar has no height to draw", () => {
    const nothing = answer(["place", "hours"], [["Reach", 0], ["Vale", 12]]);

    const drawn = plot(nothing, { x: 0, y: 1, shape: "bar" });

    expect(drawn?.bars[0]?.height).toBe(1);
    expect(drawn?.bars[0]?.y).toBe(FRAME_BOTTOM);
  });

  // A line joins its points in the order it is given them, so a line over a numeric axis has
  // to be sorted or it doubles back — `ORDER BY` in the query is not the reader's job.
  it("walks a line up a numeric column rather than through the rows as they arrived", () => {
    const hours = answer(["hour_of_day", "hours"], [[20, 30], [18, 10], [19, 20]]);

    const drawn = plot(hours, { x: 0, y: 1, shape: "line" });

    expect(drawn?.points.map((point) => point.row)).toEqual([1, 2, 0]);
    const across = drawn?.points.map((point) => point.x) ?? [];
    expect([...across].sort((one, other) => one - other)).toEqual(across);
    expect(drawn?.path.startsWith("M")).toBe(true);
  });

  // Every label a category axis could carry is more than fits, and labels that overprint are
  // worse than labels that are missing. The far end of an axis is half of what an axis says,
  // so whichever ones go, the last one stays.
  it("thins a category axis past twelve labels and still keeps the last one", () => {
    const days = answer(
      ["day", "hours"],
      Array.from({ length: 40 }, (_row, at) => [`day-${String(at).padStart(2, "0")}`, at]),
    );

    const drawn = plot(days, { x: 0, y: 1, shape: "bar" });

    expect(drawn?.bars).toHaveLength(40);
    expect(drawn?.xTicks.length).toBeLessThanOrEqual(12);
    expect(drawn?.xTicks.at(-1)?.label).toBe("day-39");
  });

  it("leaves a short category axis with a label per bar", () => {
    const drawn = plot(LEVELS, { x: 0, y: 1, shape: "bar" });

    expect(drawn?.xTicks.map((tick) => tick.label)).toEqual(["Mon", "Tue", "Wed"]);
  });

  it.each<[string, QueryAnswer, number, number]>([
    ["the column up the side holds no numbers", answer(["a", "b"], [["one", "two"]]), 0, 1],
    ["there are no rows", answer(["day", "hours"], []), 0, 1],
    ["a column was asked for that is not there", LEVELS, 0, 9],
  ])("draws nothing at all when %s", (_case, given, x, y) => {
    // Null rather than an empty chart: an axis with no data under it claims a range nobody
    // measured, and the view has a sentence for this that a picture cannot say.
    expect(plot(given, { x, y, shape: "bar" })).toBeNull();
  });

  // The tooltip is the one thing in this view built out of a string, and the strings in it came
  // out of a database that holds whatever a quest or an item was named.
  it("escapes markup that came back from the database into a tooltip", () => {
    const nasty = answer(["boss", "kills"], [["<b>Onyxia</b>", 3]]);

    const tip = plot(nasty, { x: 0, y: 1, shape: "bar" })?.bars[0]?.tip ?? "";

    expect(tip).toContain("&lt;b&gt;Onyxia&lt;/b&gt;");
    expect(tip).not.toContain("<b>Onyxia");
  });

  it("names both axes after the columns they were drawn from", () => {
    const drawn = plot(LEVELS, { x: 0, y: 1, shape: "bar" });

    expect(drawn?.xLabel).toBe("day");
    expect(drawn?.yLabel).toBe("level");
  });

  // Two rows with the same category are two bars: the tool on the other side of this is SQL,
  // and `GROUP BY` is how somebody says they wanted them added up.
  it("draws a bar per row rather than adding up rows that share a category", () => {
    const repeated = answer(["place", "hours"], [["Vale", 2], ["Vale", 3]]);

    expect(plot(repeated, { x: 0, y: 1, shape: "bar" })?.bars).toHaveLength(2);
  });
});
