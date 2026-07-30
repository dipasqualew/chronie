/**
 * The rule in `eslint.config.ts` that keeps a single read out of the browser suite.
 *
 * A rule nobody has watched fail is a rule nobody knows is running, and this one is the whole
 * reason `CLAUDE.md` no longer carries a paragraph asking people to remember the difference
 * between an assertion that retries and one that reads once. So it is held to both halves of
 * what it is for: it refuses `.resolves` in the suite, by a message that says what to write
 * instead, and it leaves the unit tests beside the app alone — `bridge.test.ts` asserts on
 * promises it has just created itself, and there is nothing for it to wait for.
 */

import { join } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** What a linter reading the repository's own configuration says about one file's worth of code. */
async function complaints(code: string, path: string): Promise<string[]> {
  const [result] = await new ESLint({ cwd: ROOT }).lintText(code, { filePath: join(ROOT, path) });
  return (result?.messages ?? []).map((message) => message.message);
}

const ASSERTION = `
import { expect, test } from "./harness";

test("reads a promise once", async () => {
  await expect(Promise.resolve(1)).resolves.toBe(1);
});
`;

describe("the browser suite's assertions", () => {
  it("refuses `.resolves` in a spec, and says what to write instead", async () => {
    const said = await complaints(ASSERTION, "apps/desktop/e2e/example.spec.ts");

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("reads a promise once");
    expect(said[0]).toContain("eventually.ts");
  });

  it("refuses it in a page object too, which is where the promise would be handed back", async () => {
    const said = await complaints(ASSERTION, "apps/desktop/e2e/pages/example.ts");

    expect(said).toHaveLength(1);
  });

  it("leaves the unit tests beside the app alone", async () => {
    expect(await complaints(ASSERTION, "apps/desktop/src/example.test.ts")).toEqual([]);
  });
});
