#!/usr/bin/env bun
/**
 * Writes the constants and the documentation table that come out of `docs/game-tables.json`.
 *
 *     bun run tables:generate
 *
 * Three files, and what each is for is in `game-tables.ts` beside this. Run it after changing
 * the registry — after verifying a game patch, after finding a column, after a table moves —
 * and commit what it writes. `scripts/game-tables.test.ts` fails the standard check when the
 * committed copies are not what this produces, so a registry edit that was never generated
 * cannot go in quietly.
 */

import { writeFileSync } from "node:fs";
import { relative } from "node:path";

import { registry, render } from "./game-tables";

const from = registry();
for (const { path, contents } of render(from)) {
  writeFileSync(path, contents);
  console.log(`${relative(process.cwd(), path)}  ${contents.length} bytes`);
}
console.log(`${from.tables.length} tables, registry version ${from.version}`);
