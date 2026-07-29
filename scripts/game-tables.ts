/**
 * The registry of game tables, and the three files that are written out of it.
 *
 * `docs/game-tables.json` is the authority for every mechanical fact about the client's own
 * tables that this app depends on: which FileDataID a table is, which column a consumed field
 * sits in, how many elements an array column holds and how wide one of them is, and the build
 * each of those was last confirmed on. Before it existed the same numbers were maintained in
 * three places at once — the Rust readers, the fixture generators and `docs/game-files.md` —
 * and a verified-build update meant repeating them by hand with nothing to report disagreement.
 *
 * What comes out of it is deliberately uneven:
 *
 * - **[`rustModule`]** writes the readers' constants, columns and array widths. The readers are
 *   what a wrong column index makes wrong, so they get the whole registry.
 * - **[`tsModule`]** writes the FileDataIDs and *nothing else*. A synthetic table's column
 *   layout is decided in the `make-*-fixtures.ts` script that writes it, and must stay decided
 *   there: a fixture writer that took its column positions from the same place the reader takes
 *   them from would let one wrong index move both halves together, and the suite would prove
 *   only that two generated halves agree. Identity is bookkeeping and is safe to share; layout
 *   is the thing under test.
 * - **[`docsTable`]** writes the table of FileDataIDs and provenance in `docs/game-files.md`.
 *   The prose around it stays hand-written — that document is the explanation of traps and
 *   evidence, and only its mechanical table is generated.
 *
 * The independent side of the bargain is `db2.rs`'s test module, which declares its own literals
 * for the ids and columns it reads and holds them against the committed fixture bytes. That is
 * what can still catch a wrong value in here, and it is why it must not be refactored to import
 * anything generated.
 *
 * [`render`] is the whole output as a list of paths and contents, which is what both
 * `make-game-tables.ts` and `game-tables.test.ts` work from — one writes it, the other compares
 * it with what is committed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Where a verified fact came from. Without a build, it is not this repository's reading. */
export interface Provenance {
  build?: string;
  tool?: string;
  note?: string;
}

/** One column of a table, as the reader addresses it. */
export interface Column {
  /** The constant's name in the generated Rust module. */
  rust: string;
  /** Which column it is. Exactly one of `index` and `indices` is set. */
  index?: number;
  /** A list of columns under one name, which is what a set of text columns is. */
  indices?: number[];
  /** What the game's own table definition calls the field. */
  field?: string;
  /** How many elements the column holds, when it is a fixed-size array. */
  elements?: number;
  /** How wide one of those elements is, which the file itself does not record. */
  bits?: number;
  /** Where this column's position came from, when it is not the table's own provenance. */
  provenance?: Provenance;
  doc?: string[];
}

/** One table of the client's storage. */
export interface Table {
  /** The game's own name for it. */
  table: string;
  /** The FileDataID constant's name in the generated Rust module. */
  rust: string;
  /** The key it is reached by in the generated TypeScript module. */
  ts: string;
  /** The Rust module its columns are generated into. */
  module: string;
  fileDataId: number;
  /** `fixed` or `offset map`, as `docs/game-files.md` tabulates it. */
  records: string;
  /** What reading it takes, in the same words the document uses. */
  readable: string;
  provenance: Provenance;
  doc: string[];
  columns: Column[];
}

/**
 * One file of the client's storage that this app names on its own rather than through a table.
 *
 * A table is looked up because a row in it points somewhere; these are the few files the app
 * points at itself — art it draws where the game's own tables have nothing to offer. They are
 * here for the same reason the tables are: a FileDataID is a fact a patch can invalidate, and
 * it must be written down once, with the build it was last seen on and the path it belongs to.
 */
export interface Art {
  /** The constant's name in the generated Rust module. */
  rust: string;
  /** The path the listfile gives it, which is how it was found and how it is checked again. */
  path: string;
  fileDataId: number;
  provenance: Provenance;
  doc: string[];
}

export interface Registry {
  version: number;
  listfile: string;
  /** Absent in a registry that names no single files, which is what this started as. */
  files?: Art[];
  tables: Table[];
}

export const REGISTRY_PATH = join(root, "docs", "game-tables.json");
export const RUST_PATH = join(root, "apps", "desktop", "src-tauri", "src", "tables.rs");
export const TS_PATH = join(here, "tables.ts");
export const DOCS_PATH = join(root, "docs", "game-files.md");

/** What marks off the generated table in `docs/game-files.md`. */
export const DOCS_OPEN = "<!-- generated from docs/game-tables.json: tables -->";
export const DOCS_CLOSE = "<!-- /generated -->";

const BANNER = "bun run tables:generate";

/**
 * The registry, read and checked over.
 *
 * The checks are the ones a hand-maintained list of numbers actually gets wrong: the same
 * FileDataID under two names, two constants claiming one column, a name that cannot be a Rust
 * identifier, an array width on a column that is not an array. A registry that passes them can
 * still be wrong about the game — that is what the golden tests are for — but it cannot be
 * internally inconsistent.
 */
export function registry(path: string = REGISTRY_PATH): Registry {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Registry;
  const complaints: string[] = [];

  if (parsed.version !== 1) complaints.push(`version ${parsed.version} is not one this knows`);

  const byFileDataId = new Map<number, string>();
  const byModule = new Map<string, string>();
  for (const art of parsed.files ?? []) {
    const seen = byFileDataId.get(art.fileDataId);
    if (seen) complaints.push(`${art.path} and ${seen} are both ${art.fileDataId}`);
    byFileDataId.set(art.fileDataId, art.path);

    if (!/^[A-Z][A-Z0-9_]*$/.test(art.rust)) {
      complaints.push(`${art.path}'s Rust name ${art.rust} is not a constant's name`);
    }
    if (!art.provenance.build && !art.provenance.note) {
      complaints.push(`${art.path} states no build and no reason for having none`);
    }
  }
  for (const table of parsed.tables) {
    const seen = byFileDataId.get(table.fileDataId);
    if (seen) complaints.push(`${table.table} and ${seen} are both ${table.fileDataId}`);
    byFileDataId.set(table.fileDataId, table.table);

    const sharing = byModule.get(table.module);
    if (sharing) complaints.push(`${table.table} and ${sharing} share the module ${table.module}`);
    byModule.set(table.module, table.table);

    if (!/^[A-Z][A-Z0-9_]*$/.test(table.rust)) {
      complaints.push(`${table.table}'s Rust name ${table.rust} is not a constant's name`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(table.module)) {
      complaints.push(`${table.table}'s module ${table.module} is not a module's name`);
    }
    if (!table.provenance.build && !table.provenance.note) {
      complaints.push(`${table.table} states no build and no reason for having none`);
    }

    const byIndex = new Map<number, string>();
    const byName = new Set<string>();
    for (const column of table.columns) {
      if (byName.has(column.rust)) {
        complaints.push(`${table.table}.${column.rust} is declared twice`);
      }
      byName.add(column.rust);

      if (!/^[A-Z][A-Z0-9_]*$/.test(column.rust)) {
        complaints.push(`${table.table}.${column.rust} is not a constant's name`);
      }
      if ((column.index === undefined) === (column.indices === undefined)) {
        complaints.push(`${table.table}.${column.rust} needs exactly one of index and indices`);
      }
      if (column.index !== undefined) {
        const sharing = byIndex.get(column.index);
        if (sharing) {
          complaints.push(
            `${table.table}.${column.rust} and .${sharing} are both column ${column.index}`,
          );
        }
        byIndex.set(column.index, column.rust);
      }
      if (column.bits !== undefined && column.elements === undefined) {
        complaints.push(`${table.table}.${column.rust} states an element width and no count`);
      }
      if (column.provenance && !column.provenance.build && !column.provenance.note) {
        complaints.push(`${table.table}.${column.rust} states no build and no reason for none`);
      }
    }
  }

  if (complaints.length) {
    throw new Error(`docs/game-tables.json does not add up:\n  ${complaints.join("\n  ")}`);
  }
  return parsed;
}

/** A provenance as a sentence, which is how both the Rust doc comments and the docs read it. */
export const provenanceLine = ({ build, tool, note }: Provenance): string => {
  if (!build) return `Unverified — ${note ?? "no build recorded"}.`;
  return tool ? `Verified on ${build} with \`${tool}\`.` : `Verified on ${build}.`;
};

/** What the document's Verified column says, which is the build or why there is not one. */
export const provenanceCell = ({ build, tool }: Provenance): string => {
  if (!build) return "community";
  return tool ? `${build}, \`${tool}\`` : build;
};

const rustDoc = (lines: string[], indent: string): string[] =>
  lines.map((line) => (line ? `${indent}/// ${line}` : `${indent}///`));

const columnDoc = (column: Column): string[] => {
  const lines: string[] = [];
  if (column.field) lines.push(`\`${column.field}\``);
  if (column.doc?.length) {
    if (lines.length) lines.push("");
    lines.push(...column.doc);
  }
  if (column.provenance) {
    if (lines.length) lines.push("");
    lines.push(provenanceLine(column.provenance));
  }
  return lines;
};

/**
 * `apps/desktop/src-tauri/src/tables.rs` — every FileDataID, column and array width the readers
 * address the client's storage by.
 */
export function rustModule(from: Registry = registry()): string {
  const out: string[] = [
    `//! Where the game keeps what this app reads, and where each fact came from.`,
    `//!`,
    `//! Generated from \`docs/game-tables.json\` by \`${BANNER}\`. Do not edit: change the`,
    `//! registry and run that, which rewrites this, the FileDataIDs the fixture generators use`,
    `//! and the table in \`docs/game-files.md\` together.`,
    `//!`,
    `//! The few single files the app names outright rather than through a table are here too, for`,
    `//! the same reason: a FileDataID is a fact a patch can invalidate.`,
    `//!`,
    `//! Nothing here is an opinion about what a value means. A column's position is mechanical`,
    `//! and a game patch can invalidate it, which is why it is recorded once with the build it`,
    `//! was read off; what a class mask, a geoset group or a points column *is* stays in the`,
    `//! module that acts on it.`,
    `//!`,
    `//! The readers take their columns from here. The fixture generators deliberately do not —`,
    `//! see \`scripts/game-tables.ts\` — and \`db2.rs\`'s tests keep their own literals, so a`,
    `//! wrong number in the registry still has something independent to fail against.`,
    ``,
  ];

  for (const table of from.tables) {
    out.push(...rustDoc([...table.doc, "", provenanceLine(table.provenance)], ""));
    out.push(`pub const ${table.rust}: u32 = ${table.fileDataId};`);
    out.push(``);
  }

  for (const art of from.files ?? []) {
    out.push(
      ...rustDoc([...art.doc, "", `\`${art.path}\``, "", provenanceLine(art.provenance)], ""),
    );
    out.push(`pub const ${art.rust}: u32 = ${art.fileDataId};`);
    out.push(``);
  }

  for (const table of from.tables) {
    if (!table.columns.length) continue;
    out.push(...rustDoc([`Columns of \`${table.table}\` that this app reads.`], ""));
    out.push(`pub mod ${table.module} {`);
    let first = true;
    for (const column of table.columns) {
      if (!first) out.push(``);
      first = false;
      out.push(...rustDoc(columnDoc(column), "    "));
      if (column.indices) {
        const width = column.indices.length;
        out.push(
          `    pub const ${column.rust}: [usize; ${width}] = [${column.indices.join(", ")}];`,
        );
      } else {
        out.push(`    pub const ${column.rust}: usize = ${column.index};`);
      }
      if (column.elements !== undefined) {
        out.push(`    /// How many elements \`${column.rust}\` holds.`);
        out.push(`    pub const ${column.rust}_ELEMENTS: usize = ${column.elements};`);
      }
      if (column.bits !== undefined) {
        out.push(
          `    /// How wide one element of \`${column.rust}\` is; the file records only the total.`,
        );
        out.push(`    pub const ${column.rust}_BITS: u32 = ${column.bits};`);
      }
    }
    out.push(`}`);
    out.push(``);
  }

  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * `scripts/tables.ts` — the FileDataIDs the fixture generators write their invented tables
 * under, and nothing else.
 */
export function tsModule(from: Registry = registry()): string {
  const out: string[] = [
    `/**`,
    ` * What the game calls each table this app reads.`,
    ` *`,
    ` * Generated from \`docs/game-tables.json\` by \`${BANNER}\`. Do not edit.`,
    ` *`,
    ` * FileDataIDs only, on purpose. A fixture's *layout* — which column holds what, in which`,
    ` * storage, at which bit offset — is decided in the \`make-*-fixtures.ts\` script that writes`,
    ` * the table, and has to stay decided there: if the writer took its column positions from the`,
    ` * same registry the reader takes them from, one wrong index would move both halves together`,
    ` * and every test over them would still pass. Which table a file *is* carries no such risk,`,
    ` * and it was the number actually being copied between three places.`,
    ` */`,
    ``,
    `export const FILE_DATA_ID = {`,
  ];
  for (const table of from.tables) {
    out.push(`  /** \`${table.table}\` */`);
    out.push(`  ${table.ts}: ${table.fileDataId},`);
  }
  out.push(`} as const;`);
  return `${out.join("\n")}\n`;
}

/** The rows of the table in `docs/game-files.md`, between its markers. */
export function docsTable(from: Registry = registry()): string {
  const rows = [
    "| Table | FileDataID | Records | Readable | Verified |",
    "|---|---|---|---|---|",
    ...from.tables.map(
      (table) =>
        `| \`${table.table}\` | ${table.fileDataId} | ${table.records} | ${table.readable} | ` +
        `${provenanceCell(table.provenance)} |`,
    ),
  ];
  return rows.join("\n");
}

/**
 * `docs/game-files.md` with its generated table replaced.
 *
 * Takes the document rather than reading it, so that the check can hold the committed file to
 * this without a temporary copy of it.
 */
export function docsWith(document: string, from: Registry = registry()): string {
  const open = document.indexOf(DOCS_OPEN);
  const close = document.indexOf(DOCS_CLOSE);
  if (open < 0 || close < open) {
    throw new Error(`docs/game-files.md has no ${DOCS_OPEN} … ${DOCS_CLOSE} block`);
  }
  const head = document.slice(0, open + DOCS_OPEN.length);
  const tail = document.slice(close);
  return `${head}\n\n${docsTable(from)}\n\n${tail}`;
}

/** Every file the registry writes, as the path and the contents it should have. */
export function render(from: Registry = registry()): Array<{ path: string; contents: string }> {
  return [
    { path: RUST_PATH, contents: rustModule(from) },
    { path: TS_PATH, contents: tsModule(from) },
    { path: DOCS_PATH, contents: docsWith(readFileSync(DOCS_PATH, "utf8"), from) },
  ];
}
