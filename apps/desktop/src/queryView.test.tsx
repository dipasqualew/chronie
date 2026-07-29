import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMIT, RECIPES } from "./query";
import { QueryView } from "./queryView";
import type { QueryActions } from "./queryView";
import type { QueryAnswer, QueryCell, QuerySchema } from "./types";

afterEach(cleanup);

/** An answer with only the parts a test cares about; the shape is the backend's own. */
function answer(
  columns: string[],
  rows: QueryCell[][],
  overrides: Partial<QueryAnswer> = {},
): QueryAnswer {
  return { columns, rows, truncated: false, elapsedMs: 4, ...overrides };
}

/** What the first recipe asks for, so the view opens on a chart it can actually name. */
const HOURS = answer(
  ["character", "hours"],
  [
    ["Aster-Vale", 12.5],
    ["Brin-Hearth", 4],
  ],
);

/** Two number columns, so there is something for the vertical axis dropdown to move between. */
const BOSSES = answer(
  ["boss", "kills", "wipes"],
  [
    ["Onyxia", 3, 7],
    ["Ragnaros", 1, 12],
  ],
);

const SCHEMA: QuerySchema = {
  tables: [
    {
      name: "segments",
      view: false,
      rowCount: 1420,
      columns: [
        { name: "segment_id", kind: "INTEGER", primaryKey: true },
        { name: "zone_id", kind: "INTEGER", primaryKey: false },
      ],
    },
  ],
};

const said = (error: unknown): string => `The database said: ${String(error)}`;

/**
 * The view over actions a test answers. Nothing here reaches a backend and nothing patches
 * one — the promises are handed in, so a refusal is a rejected promise rather than a mock.
 */
function view(actions: Partial<QueryActions> = {}, visible = true) {
  return render(
    <QueryView
      visible={visible}
      actions={{
        run: () => Promise.resolve(HOURS),
        schema: () => Promise.resolve(SCHEMA),
        onError: said,
        ...actions,
      }}
    />,
  );
}

const editor = (): HTMLTextAreaElement =>
  screen.getByRole("textbox", { name: "SQL" }) as HTMLTextAreaElement;
const chart = (): HTMLElement => screen.getByRole("img");
const runButton = (): HTMLElement => screen.getByRole("button", { name: "Run" });
const dropdown = (name: string): HTMLElement => screen.getByRole("combobox", { name });

/** The rows the table is showing, without the header row above them. */
const bodyRows = (): HTMLElement[] => screen.getAllByRole("row").slice(1);

const textOf = (row: HTMLElement): string[] =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");

/** A run that answers differently each time it is asked, so a second Run can fail. */
const answering = (...replies: (QueryAnswer | Error)[]) => {
  let at = 0;
  return vi.fn((_sql: string, _limit: number) => {
    const reply = replies[Math.min(at, replies.length - 1)];
    at += 1;
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply as QueryAnswer);
  });
};

describe("QueryView", () => {
  // A blank SQL prompt over an empty table asks the reader to invent a question before they
  // have seen that any of this works. What opens the view is a picture of their own year.
  it("opens already answered, with both a chart and its rows on screen", async () => {
    const run = answering(HOURS);
    view({ run });

    await waitFor(() => expect(chart()).toBeTruthy());
    expect(run).toHaveBeenCalledWith(RECIPES[0]?.sql, DEFAULT_LIMIT);
    expect(editor().value).toBe(RECIPES[0]?.sql);
    // The recipe named its own two columns, so the chart is of those rather than of whichever
    // pair the convention would have picked.
    expect(chart().getAttribute("aria-label")).toBe(
      "hours by character, as a bar chart of 2 values",
    );
    expect(bodyRows()).toHaveLength(2);
    expect(textOf(bodyRows()[0]!)).toEqual(["Aster-Vale", "12.5"]);
    expect(textOf(bodyRows()[1]!)).toEqual(["Brin-Hearth", "4"]);
  });

  // A first run of the app opens on Settings, and a view nobody has looked at yet must not be
  // spending the reader's first seconds running a query against a year of history.
  it("asks the backend nothing at all while nobody is looking at it", async () => {
    const run = answering(HOURS);
    const schema = vi.fn(() => Promise.resolve(SCHEMA));
    view({ run, schema }, false);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Query" })).toBeTruthy());
    expect(run).not.toHaveBeenCalled();
    expect(schema).not.toHaveBeenCalled();
  });

  // A mistyped column name is one keystroke from a working query. Taking the last answer away
  // to say so is a punishment, and the database's own sentence is the only useful thing to say.
  it("shows the database's own words and leaves the last rows where they were", async () => {
    const run = answering(HOURS, new Error("no such column: hors"));
    view({ run });

    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    fireEvent.click(runButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "The database said: Error: no such column: hors",
      ),
    );
    expect(bodyRows()).toHaveLength(2);
    expect(textOf(bodyRows()[0]!)).toEqual(["Aster-Vale", "12.5"]);
  });

  // An empty chart frame over a perfectly good answer reads as a broken view. Saying what is
  // missing — a number — is what tells the reader which word to add to their query.
  it("says an answer has nothing to plot rather than drawing an empty chart", async () => {
    view({ run: () => Promise.resolve(answer(["character", "realm"], [["Aster", "Vale"]])) });

    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Chart").textContent).toContain("nothing to plot");
  });

  // Which columns to plot is the whole choice the view offers, and the answer is already in
  // hand — changing the picture must not cost another trip to the database.
  it("redraws the same answer as a line without asking for it again", async () => {
    const run = answering(HOURS);
    view({ run });

    await waitFor(() => expect(chart()).toBeTruthy());
    fireEvent.change(dropdown("Chart shape"), { target: { value: "line" } });

    expect(chart().getAttribute("aria-label")).toBe(
      "hours by character, as a line chart of 2 values",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("redraws against another column when the vertical axis is changed", async () => {
    view({ run: () => Promise.resolve(BOSSES) });

    // The opening recipe names columns this answer does not have, so the convention picks the
    // axes: the first column that names things, and the first that counts them.
    await waitFor(() =>
      expect(chart().getAttribute("aria-label")).toBe("kills by boss, as a bar chart of 2 values"),
    );
    fireEvent.change(dropdown("Vertical axis"), { target: { value: "2" } });

    expect(chart().getAttribute("aria-label")).toBe("wipes by boss, as a bar chart of 2 values");
  });

  // Only the columns holding numbers, because a chart of a column of names against anything
  // is not a chart — and an option that draws nothing is a control that lies.
  it("offers only the number columns up the side", async () => {
    view({ run: () => Promise.resolve(BOSSES) });

    await waitFor(() => expect(chart()).toBeTruthy());
    const offered = within(dropdown("Vertical axis")).getAllByRole("option");

    expect(offered.map((option) => option.textContent)).toEqual(["kills", "wipes"]);
  });

  // The ceiling is what stands between a reader and a query over a year of segments, so the
  // number the dropdown is showing has to be the number the next run is asked for.
  it("asks for the number of rows the dropdown is showing", async () => {
    const run = answering(HOURS);
    view({ run });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    fireEvent.change(dropdown("Rows at most"), { target: { value: "2000" } });
    fireEvent.click(runButton());

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]).toEqual([RECIPES[0]?.sql, 2000]);
  });

  // The list beside the editor is the alternative to reading fourteen migration files, and a
  // column name is only useful there if it can be got into the query without being retyped.
  it("writes a column name into the editor when its name is clicked", async () => {
    const run = answering(HOURS);
    view({ run });

    const name = await screen.findByRole("button", { name: "Insert zone_id" });
    fireEvent.click(name);

    expect(editor().value).toContain("zone_id");
    // Clicking a name is an edit, not a question: nothing is asked of the database for it.
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The first thing to do with a table you have just found is look at it, and the query that
  // does that is the same every time — so it is a button rather than something to type.
  it("runs a table's own query when its SELECT is clicked", async () => {
    const run = answering(HOURS);
    view({ run });

    const seed = await screen.findByRole("button", { name: "SELECT * FROM segments" });
    fireEvent.click(seed);

    const expected = 'SELECT * FROM "segments" LIMIT 50';
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]).toEqual([expected, DEFAULT_LIMIT]);
    // The editor shows what ran, so the next question starts from it rather than from nothing.
    expect(editor().value).toBe(expected);
  });

  // The shortcut every SQL editor has, and the reason it needs a modifier: the query is
  // several lines long, so Enter has to stay Enter.
  it.each<[string, { ctrlKey?: boolean; metaKey?: boolean }]>([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("runs the query on %s+Enter", async (_case, held) => {
    const run = answering(HOURS);
    view({ run });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(editor(), { key: "Enter", ...held });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it("leaves a plain Enter to the editor, so a query can have a second line", async () => {
    const run = answering(HOURS);
    view({ run });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(editor(), { key: "Enter" });

    expect(run).toHaveBeenCalledTimes(1);
  });

  // A chart of the first five hundred rows of a year, presented as a chart of the year, is
  // the one way this view can be quietly wrong. It says so instead.
  it("says so when the answer was cut short", async () => {
    view({
      run: () =>
        Promise.resolve(
          answer(["character", "hours"], [["Aster", 12]], {
            truncated: true,
          }),
        ),
    });

    await waitFor(() => expect(screen.getByText(/Stopped at 1 row\./)).toBeTruthy());
  });

  // The rows that had nothing to plot are not on the chart, so the only place a reader can
  // learn they existed is a line beside it.
  it("counts the rows the chart had to leave out", async () => {
    view({
      run: () =>
        Promise.resolve(
          answer(
            ["place", "gold_per_hour"],
            [
              ["Vale", 120],
              ["Caverns", null],
              ["Hearth", null],
            ],
          ),
        ),
    });

    await waitFor(() => expect(chart()).toBeTruthy());
    expect(screen.getByLabelText("Chart").textContent).toContain("2 rows had no number to plot");
  });

  // A schema the backend cannot answer for must not leave the list saying "Reading the
  // schema…" forever, and must not take the editor down with it.
  it("still answers the query when the schema could not be read", async () => {
    const run = answering(HOURS);
    view({ run, schema: () => Promise.reject(new Error("the database is locked")) });

    await waitFor(() => expect(chart()).toBeTruthy());
    expect(screen.queryByText("Reading the schema…")).toBeNull();
  });

  // An empty table with a header on it looks like a table that failed to draw. The count in
  // the status line beside it is what settles that the query ran and matched nothing.
  it("says nothing matched rather than showing an empty table", async () => {
    view({ run: () => Promise.resolve(answer(["character", "hours"], [])) });

    await waitFor(() => expect(screen.getByText("No rows matched.")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toBe("0 rows · 2 columns · 4 ms");
  });
});
