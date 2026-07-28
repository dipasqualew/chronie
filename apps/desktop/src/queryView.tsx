/**
 * The Query view: the history, and a way to ask it something the other tabs do not answer.
 *
 * Three things side by side, and the order of them is the argument. On the left, what is
 * actually in the database — a reader cannot write a query against tables they have to guess
 * at, and the alternative to this list is fourteen migration files. In the middle, the
 * editor, opened on a real question rather than on an empty box, and already answered: the
 * first thing this view shows is a chart of hours per character, because a blank SQL prompt
 * is a wall and a picture of your own year is an invitation. Below it, the answer as a chart
 * and as a table, in that order, because a shape is read faster than forty rows.
 *
 * The chart is two dropdowns rather than a chart builder. Which column runs along the bottom
 * and which runs up the side is the entire choice worth offering — everything else that a
 * charting tool would put in a dialog, SQL says better: grouping is `GROUP BY`, filtering is
 * `WHERE`, ordering is `ORDER BY`, and the top ten is `LIMIT 10`.
 *
 * `query.ts` holds every rule about what an answer means and where a bar goes;
 * `queryChart.tsx` draws it. What is left here is the screen.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import {
  DEFAULT_LIMIT, RECIPES, SHAPES, cellText, columnKinds, defaultAxes, everything, plot,
  recipeAxes, summary,
} from "./query";
import type { Axes, Recipe, Shape } from "./query";
import { QueryChart } from "./queryChart";
import type { QueryAnswer, QuerySchema } from "./types";

export interface QueryActions {
  /** Runs one statement and answers with rows, or refuses with a sentence saying why. */
  run: (sql: string, limit: number) => Promise<QueryAnswer>;
  /** What the history holds. Asked for once, the first time the view is opened. */
  schema: () => Promise<QuerySchema>;
  onError: (error: unknown) => string;
}

export interface QueryViewProps {
  actions: QueryActions;
  /** Whether anybody is looking. Nothing is asked for until somebody is. */
  visible: boolean;
}

/** How many rows a reader may ask for. The ceiling matches `query::MAX_ROWS`. */
const LIMITS = [100, DEFAULT_LIMIT, 2000, 5000];

const SHAPE_LABELS: Record<Shape, string> = {
  bar: "Bars",
  line: "Line",
  scatter: "Scatter",
};

export function QueryView({ actions, visible }: QueryViewProps): ReactNode {
  const opening = RECIPES[0];
  const [sql, setSql] = useState(opening?.sql ?? "");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [answer, setAnswer] = useState<QueryAnswer | null>(null);
  const [failure, setFailure] = useState("");
  const [running, setRunning] = useState(false);
  const [schema, setSchema] = useState<QuerySchema | null>(null);
  const [axes, setAxes] = useState<Axes | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  /** Whether the opening question has been asked, so re-entering the view does not re-ask it. */
  const asked = useRef(false);

  // The tables do not change while somebody is typing, so this is asked for once — and only
  // once anybody is here to read it, because a first run opens on Settings.
  useEffect(() => {
    if (!visible || schema) return;
    void actions.schema().then(setSchema).catch(() => setSchema({ tables: [] }));
  }, [actions, schema, visible]);

  // Opened already answered. The alternative is a blank editor over an empty table, which
  // asks the reader to invent a question before they have seen that any of this works.
  useEffect(() => {
    if (!visible || asked.current) return;
    asked.current = true;
    void ask(sql, opening);
    // Deliberately the first render's `sql` — this runs once, and what it runs is the recipe
    // the view opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  async function ask(statement: string, recipe?: Recipe | null): Promise<void> {
    setRunning(true);
    setFailure("");
    try {
      const fresh = await actions.run(statement, limit);
      setAnswer(fresh);
      // A recipe says which of its columns are worth plotting; anything else falls to the
      // convention — the first column that names things, and the first that counts them.
      setAxes(recipeAxes(fresh, recipe) ?? defaultAxes(fresh));
    } catch (error) {
      // The rows on screen are left where they are. A mistyped column name is one keystroke
      // from a working query, and taking the last answer away to say so is a punishment.
      setFailure(actions.onError(error));
    } finally {
      setRunning(false);
    }
  }

  /** Puts a name where the cursor is, which is what clicking one in the table list is for. */
  function insert(text: string): void {
    const box = editor.current;
    if (!box) return;
    const at = box.selectionStart ?? sql.length;
    const to = box.selectionEnd ?? at;
    setSql(`${sql.slice(0, at)}${text}${sql.slice(to)}`);
    box.focus();
    // After React has written the value back, or the caret lands where the old text ended.
    queueMicrotask(() => box.setSelectionRange(at + text.length, at + text.length));
  }

  function start(recipe: Recipe): void {
    setSql(recipe.sql);
    void ask(recipe.sql, recipe);
  }

  const kinds = useMemo(() => (answer ? columnKinds(answer) : []), [answer]);
  const drawn = useMemo(() => (answer && axes ? plot(answer, axes) : null), [answer, axes]);
  const numeric = useMemo(
    () => kinds.flatMap((kind, at) => (kind === "number" ? [at] : [])), [kinds],
  );

  return (
    <div className="query">
      <header className="view-head">
        <h1>Query</h1>
        <div className="sub">Your own history, in SQL. Reads only — nothing typed here can
          change what Chronie has collected.</div>
      </header>

      <div className="query-body">
        <aside className="query-tables" aria-label="Tables in the history">
          <h2>Tables</h2>
          {schema
            ? schema.tables.map((table) => (
              <details
                key={table.name} id={`query-table-${table.name}`} className="query-table"
                aria-label={table.name}
              >
                {/* The summary does what a summary does — nothing but open. Everything that
                    writes into the editor is a button inside it, so a click never has to be
                    guessed at. */}
                {/* Titled, because a summary carries no role and nothing else here would say
                    which table this one opens. */}
                <summary title={`What is in ${table.name}`}>
                  {table.name}
                  <span className="muted">
                    {table.view ? "view" : (table.rowCount ?? 0).toLocaleString()}
                  </span>
                </summary>
                <ul>
                  <li>
                    <button
                      type="button" className="query-seed"
                      onClick={() => start(everything(table.name))}
                    >{`SELECT * FROM ${table.name}`}</button>
                  </li>
                  {table.columns.map((column) => (
                    <li key={column.name}>
                      <button
                        type="button" aria-label={`Insert ${column.name}`}
                        onClick={() => insert(column.name)}
                      >{column.name}</button>
                      <span className="muted">{column.kind.toLowerCase()}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))
            : <p className="muted">Reading the schema…</p>}
        </aside>

        <section className="query-main" aria-label="The query and its answer">
          <div className="query-recipes">
            <span className="muted">Start from:</span>
            {RECIPES.map((recipe) => (
              <button
                key={recipe.name} type="button" className="chip recipe"
                title={recipe.about} onClick={() => start(recipe)}
              >{recipe.name}</button>
            ))}
          </div>

          <textarea
            id="query-sql" className="query-editor" ref={editor} spellCheck={false}
            aria-label="SQL" rows={9} value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={(event) => {
              // The shortcut every SQL editor has, because the query is several lines long
              // and Enter has to stay Enter.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void ask(sql);
              }
            }}
          />

          <div className="query-bar">
            <button
              type="button" className="primary" disabled={running}
              onClick={() => void ask(sql)}
            >{running ? "Running…" : "Run"}</button>
            <span className="muted">⌘↵</span>
            <label className="query-limit">
              At most
              <select
                aria-label="Rows at most" value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
              >
                {LIMITS.map((rows) => (
                  <option key={rows} value={rows}>{rows.toLocaleString()}</option>
                ))}
              </select>
              rows
            </label>
            <span className="query-summary" role="status">
              {running ? "Running…" : (answer ? summary(answer) : "")}
            </span>
          </div>

          {/* An alert rather than a status: a refused query is the one thing here that
              somebody has to be told about rather than left to notice. */}
          {failure ? <p className="query-failure" role="alert">{failure}</p> : null}

          {answer?.truncated
            ? <p className="query-truncated">Stopped at {plural(answer.rows.length, "row")}.
              There were more — the chart and the table below are of this much of it. Ask for
              more rows, or narrow the query down.</p>
            : null}

          {answer
            ? <>
              <section className="query-chart" aria-label="Chart">
                {axes && numeric.length
                  ? <>
                    <div className="query-axes">
                      <label>
                        Across
                        <select
                          aria-label="Horizontal axis" value={axes.x}
                          onChange={(event) =>
                            setAxes({ ...axes, x: Number(event.target.value) })}
                        >
                          {answer.columns.map((name, at) => (
                            <option key={`${name}-${at}`} value={at}>{name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Up
                        <select
                          aria-label="Vertical axis" value={axes.y}
                          onChange={(event) =>
                            setAxes({ ...axes, y: Number(event.target.value) })}
                        >
                          {/* Only the columns that hold numbers: a chart of a column of
                              names against anything is not a chart. */}
                          {numeric.map((at) => (
                            <option key={at} value={at}>{answer.columns[at]}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        As
                        <select
                          aria-label="Chart shape" value={axes.shape}
                          onChange={(event) =>
                            setAxes({ ...axes, shape: event.target.value as Shape })}
                        >
                          {SHAPES.map((shape) => (
                            <option key={shape} value={shape}>{SHAPE_LABELS[shape]}</option>
                          ))}
                        </select>
                      </label>
                      {drawn?.skipped
                        ? <span className="muted">
                          {plural(drawn.skipped, "row")} had no number to plot.
                        </span>
                        : null}
                    </div>
                    {drawn
                      ? <QueryChart plot={drawn} />
                      : <p className="muted">Nothing in those two columns can be drawn against
                        each other.</p>}
                  </>
                  : <p className="muted">Nothing that came back is a number, so there is
                    nothing to plot. Count something — <code>COUNT(*)</code>,
                    <code>SUM(duration_seconds)</code> — and the chart appears.</p>}
              </section>

              <div className="query-rows">
                <table className="rows">
                  <thead>
                    <tr>
                      {answer.columns.map((name, at) => (
                        <th
                          key={`${name}-${at}`} scope="col"
                          className={kinds[at] === "number" ? "num" : undefined}
                        >{name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody aria-label="What came back">
                    {answer.rows.map((row, at) => (
                      <tr key={at}>
                        {answer.columns.map((name, column) => (
                          <td
                            key={`${name}-${column}`}
                            className={kinds[column] === "number" ? "num" : undefined}
                          >{cellText(row[column] ?? null)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {answer.rows.length ? null : <p className="muted">No rows matched.</p>}
              </div>
            </>
            : null}
        </section>
      </div>
    </div>
  );
}
