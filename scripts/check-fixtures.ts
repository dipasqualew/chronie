#!/usr/bin/env bun
/**
 * The committed game-file fixtures against the generators they came out of.
 *
 * `apps/desktop/fixtures/` is 105 binary files that no reviewer can read and that nothing has
 * ever re-derived: a change to `make-item-fixtures.ts` that nobody re-ran left the committed
 * bytes describing the old table while the script described the new one, and the suite went on
 * passing against the stale bytes. This is what says so.
 *
 * Every generator is run into a temporary directory — `CHRONIE_FIXTURE_ROOT`, which is the only
 * reason `emit` takes a root at all — and what comes out is compared byte for byte with what is
 * committed. Writing over the real ones to find out would be a check that quietly fixes the
 * thing it is checking.
 *
 * Nothing here reads a World of Warcraft install. The generators invent every byte they write,
 * which is what makes this the same check on a runner as on a machine that has the game.
 *
 *     bun run test:fixtures
 *
 * A red run means one of two things, and the message says which: a generator was changed and
 * the fixtures were not regenerated — run the `make-*-fixtures.ts` script it names — or a
 * generator stopped being deterministic, which is a bug in the generator.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const committed = join(here, "..", "apps", "desktop", "fixtures");

/** Which script writes which area, so a failure can name the command that fixes it. */
const GENERATORS: Record<string, string> = {
  achievements: "scripts/make-achievement-fixtures.ts",
  currencies: "scripts/make-currency-fixtures.ts",
  items: "scripts/make-item-fixtures.ts",
  journal: "scripts/make-journal-fixtures.ts",
  maps: "scripts/make-map-fixtures.ts",
  transmog: "scripts/make-transmog-fixtures.ts",
};

/**
 * Committed fixtures that no generator here writes, and that something else already holds.
 *
 * These four are `.glb` files the browser suite loads into three.js, and they are not invented
 * game files — they are what this app's own converter makes *out of* the invented ones. So the
 * thing that can tell whether they are stale is the converter, and `character.rs` and
 * `models.rs` each run it and compare, in tests that read the committed bytes and no install.
 * Regenerating them from here would mean linking the Rust tree out of a TypeScript script to
 * re-derive an answer that is already checked; naming them is the honest alternative to a
 * silent `endsWith(".glb")`.
 */
const HELD_ELSEWHERE: Record<string, string> = {
  "transmog/character.glb": "character.rs — writes_the_glbs_the_browser_tests_load",
  "transmog/robe.glb": "character.rs — writes_the_glbs_the_browser_tests_load",
  "transmog/worn-helm.glb": "character.rs — writes_the_glbs_the_browser_tests_load",
  "transmog/helm.glb": "models.rs — the helm.glb comparison",
};

const names = (directory: string): string[] => {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
};

function main(): number {
  const scratch = mkdtempSync(join(tmpdir(), "chronie-fixtures-"));
  const complaints: string[] = [];

  try {
    for (const [area, script] of Object.entries(GENERATORS)) {
      execFileSync("bun", ["run", join(here, "..", script)], {
        env: { ...process.env, CHRONIE_FIXTURE_ROOT: scratch },
        stdio: ["ignore", "ignore", "inherit"],
      });

      const fresh = names(join(scratch, area));
      const held = names(join(committed, area));
      const rerun = `run \`bun run ${script}\` and commit what it writes`;

      for (const name of fresh) {
        if (!held.includes(name)) {
          complaints.push(
            `${area}/${name} is written by ${script} and is not committed — ${rerun}`,
          );
        }
      }
      for (const name of held) {
        if (fresh.includes(name) || HELD_ELSEWHERE[`${area}/${name}`]) continue;
        complaints.push(`${area}/${name} is committed and no longer written by ${script}`);
      }
      for (const name of fresh.filter((name) => held.includes(name))) {
        const a = readFileSync(join(scratch, area, name));
        const b = readFileSync(join(committed, area, name));
        if (a.equals(b)) continue;
        const size =
          a.length === b.length ? `${a.length} bytes` : `${b.length} → ${a.length} bytes`;
        complaints.push(`${area}/${name} differs from what ${script} writes (${size}) — ${rerun}`);
      }
    }
    // An exemption for a file that is gone is the same kind of rot as a stale fixture, and it
    // is the kind that hides the next one. The list has to name things that are really there.
    for (const [path, holder] of Object.entries(HELD_ELSEWHERE)) {
      const [area, name] = path.split("/");
      if (names(join(committed, area)).includes(name)) continue;
      complaints.push(`${path} is exempted here as held by ${holder}, and is not committed`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (complaints.length) {
    process.stderr.write(`The committed fixtures are not what the generators produce:\n\n`);
    for (const complaint of complaints) process.stderr.write(`  ${complaint}\n`);
    process.stderr.write("\n");
    return 1;
  }

  const total = Object.keys(GENERATORS).reduce(
    (count, area) => count + names(join(committed, area)).length,
    0,
  );
  const exempt = Object.keys(HELD_ELSEWHERE).length;
  process.stdout.write(
    `${total - exempt} committed fixtures across ${Object.keys(GENERATORS).length} areas are ` +
      `what their generators write; ${exempt} are held by the Rust suite instead.\n`,
  );
  return 0;
}

process.exit(main());
