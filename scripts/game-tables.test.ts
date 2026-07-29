/**
 * The registry against what is committed out of it, and against the tree that must not duplicate
 * it.
 *
 * Three things are checked, and they fail for three different reasons.
 *
 * The **staleness** check regenerates every output in memory and compares it with the committed
 * copy. A red run there means `docs/game-tables.json` was edited and `bun run tables:generate`
 * was not, which is the failure a generated file nothing re-derives always has: it describes the
 * past and nothing says so.
 *
 * The **consistency** checks are `registry()`'s own, exercised on registries built to be wrong so
 * that the validator is known to report rather than to pass anything.
 *
 * The **authority** check reads the Rust tree and fails on a second declaration of a table's
 * FileDataID outside `tables.rs`. That is what makes "one authoritative entry" a property of the
 * repository rather than a claim in a document — the numbers were maintained in three places
 * before this, and nothing said so.
 *
 * What is *not* checked here is whether any of it is true of the game. That is `db2.rs`'s test
 * module, which declares its own literals and holds them against the committed fixture bytes.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DOCS_OPEN,
  provenanceCell,
  provenanceLine,
  registry,
  REGISTRY_PATH,
  render,
  type Registry,
} from "./game-tables";

const here = dirname(fileURLToPath(import.meta.url));
const rustSource = join(here, "..", "apps", "desktop", "src-tauri", "src");

/**
 * The registry with one field bent, read back through `registry()`.
 *
 * Through the real parser and off a real file, because what is under test is the check rather
 * than the shape: a validator that is only ever called on the committed registry is a validator
 * nobody knows the failure mode of.
 */
const readingBent = (change: (into: Registry) => void): (() => Registry) => {
  const copy = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
  change(copy);
  return () => {
    const scratch = mkdtempSync(join(tmpdir(), "chronie-registry-"));
    const path = join(scratch, "game-tables.json");
    writeFileSync(path, JSON.stringify(copy));
    try {
      return registry(path);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
};

describe("the committed files against the registry they come out of", () => {
  const from = registry();
  const written = render(from);

  for (const { path, contents } of written) {
    it(`${basename(path)} is what the registry writes`, () => {
      expect(readFileSync(path, "utf8")).toBe(contents);
    });
  }

  // The block has to still be marked off, or the docs comparison would splice a file into itself
  // and pass while the table it is about had quietly gone.
  it("marks the generated table off in the document", () => {
    expect(readFileSync(written[written.length - 1].path, "utf8")).toContain(DOCS_OPEN);
  });
});

describe("what the registry refuses to say", () => {
  it("reports two tables sharing one FileDataID", () => {
    expect(
      readingBent((into) => {
        into.tables[1].fileDataId = into.tables[0].fileDataId;
      }),
    ).toThrow(/are both 1376213/);
  });

  it("reports two constants claiming one column", () => {
    expect(
      readingBent((into) => {
        into.tables[0].columns[1].index = into.tables[0].columns[0].index;
      }),
    ).toThrow(/are both column 0/);
  });

  it("reports a table that records no build and no reason for having none", () => {
    expect(
      readingBent((into) => {
        into.tables[0].provenance = {};
      }),
    ).toThrow(/states no build and no reason/);
  });

  it("reports a name that could not be a Rust constant", () => {
    expect(
      readingBent((into) => {
        into.tables[0].rust = "transmogSet";
      }),
    ).toThrow(/is not a constant's name/);
  });

  it("reports an element width with no element count beside it", () => {
    expect(
      readingBent((into) => {
        const column = into.tables[0].columns[0];
        column.bits = 32;
        delete column.elements;
      }),
    ).toThrow(/states an element width and no count/);
  });

  it("reports a version it was not written for", () => {
    expect(
      readingBent((into) => {
        into.version = 2;
      }),
    ).toThrow(/version 2 is not one this knows/);
  });
});

describe("provenance, as the constants and the document read it", () => {
  it("names the build and the tool that settled a fact", () => {
    expect(provenanceLine({ build: "12.0.5.67", tool: "examples/dump_items" })).toBe(
      "Verified on 12.0.5.67 with `examples/dump_items`.",
    );
  });

  it("says plainly when a position is the community's rather than this repository's", () => {
    expect(provenanceLine({ note: "the community's table definitions" })).toBe(
      "Unverified — the community's table definitions.",
    );
    expect(provenanceCell({ note: "the community's table definitions" })).toBe("community");
  });
});

describe("the registry as the only place a table's identity is written down", () => {
  /**
   * Every `const NAME: u32 = <a FileDataID>` in the Rust tree outside the generated module, not
   * counting the test modules — which declare their own on purpose, and are the independent half
   * of the bargain the registry makes.
   */
  const declarations = (): string[] => {
    const found: string[] = [];
    for (const name of readdirSync(rustSource)) {
      if (!name.endsWith(".rs") || name === "tables.rs") continue;
      // Only what a shipping build compiles. The test module at the foot of a file is allowed to
      // hold literals, and has to, for the golden assertions to mean anything.
      const shipped = readFileSync(join(rustSource, name), "utf8").split("#[cfg(test)]")[0];
      for (const line of shipped.split("\n")) {
        if (/^\s*(pub )?const [A-Z][A-Z0-9_]*: u32 = [0-9_]{6,};/.test(line)) {
          found.push(`${name}: ${line.trim()}`);
        }
      }
    }
    return found;
  };

  it("is the only file that declares one", () => {
    expect(declarations()).toEqual([]);
  });
});
