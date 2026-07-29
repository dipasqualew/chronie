/**
 * SQLite as this suite stubs it: a schema to browse and a table of prepared answers.
 *
 * On its own because these are answers to text a reader typed rather than to commands the
 * window sends, and because they are keyed by the recipes themselves — the one corner of the
 * mock that reaches back into the app's own source for its keys.
 */

import { RECIPES } from "../../src/query";
import type { E2EMock } from "../../src/types";

/**
 * A query as the mock's table of answers is keyed — whitespace collapsed, so a statement laid
 * out over six lines in the recipe is the same key as the one the page sends back.
 */
export const collapsed = (sql: string): string => sql.trim().replace(/\s+/g, " ");

// The database as the Query view may see it, and the answers to the four questions this
// suite asks of it. The queries are keyed by the recipes themselves rather than by copies
// of their text: what the view sends is the recipe, so a recipe somebody rewords stays
// answered and a view that stopped sending it does not.
export const query: E2EMock["query"] = {
  schema: {
    tables: [
      {
        name: "characters",
        view: false,
        rowCount: 3,
        columns: [
          { name: "id", kind: "INTEGER", primaryKey: true },
          { name: "name", kind: "TEXT", primaryKey: false },
          { name: "class_file", kind: "TEXT", primaryKey: false },
        ],
      },
      {
        name: "segments",
        view: false,
        rowCount: 1204,
        columns: [
          { name: "id", kind: "INTEGER", primaryKey: true },
          { name: "character_id", kind: "INTEGER", primaryKey: false },
          { name: "instance_name", kind: "TEXT", primaryKey: false },
          { name: "duration_seconds", kind: "INTEGER", primaryKey: false },
        ],
      },
    ],
  },
  answers: {
    [collapsed(RECIPES[0]?.sql ?? "")]: {
      columns: ["character", "hours"],
      rows: [
        ["Aster-Vale", 41.5],
        ["Brin-Hearth", 12],
        ["Corvin-Vale", 3.2],
      ],
      truncated: false,
      elapsedMs: 3,
    },
    [collapsed(RECIPES[1]?.sql ?? "")]: {
      columns: ["day", "hours"],
      rows: [
        ["2026-07-23", 2.5],
        ["2026-07-24", 4],
        ["2026-07-25", 0.75],
        ["2026-07-26", 3.25],
      ],
      truncated: false,
      elapsedMs: 5,
    },
    // What clicking a table in the list asks for. The null is the point of the row: an
    // empty cell and a cell holding nothing look identical, and only one of them is true.
    'SELECT * FROM "characters" LIMIT 50': {
      columns: ["id", "name", "class_file"],
      rows: [
        [1, "Aster-Vale", "MAGE"],
        [2, "Brin-Hearth", "PALADIN"],
        [3, "Corvin-Vale", null],
      ],
      truncated: false,
      elapsedMs: 1,
    },
    // A mistyped column, refused in SQLite's own words — the one answer this feature has
    // to get right, because it is the one every reader will meet.
    "SELECT charater FROM segments": { error: "no such column: charater" },
  },
};
