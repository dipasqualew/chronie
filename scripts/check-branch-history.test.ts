import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CHECK = join(import.meta.dirname, "check-branch-history.sh");

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();
}

function commit(repository: string, name: string, contents: string): string {
  writeFileSync(join(repository, name), contents);
  git(repository, "add", name);
  git(repository, "commit", "-m", contents);
  return git(repository, "rev-parse", "HEAD");
}

function inRepository(run: (repository: string, base: string) => void): void {
  const repository = mkdtempSync(join(tmpdir(), "chronie-branch-history-"));
  try {
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Chronie Test");
    git(repository, "config", "user.email", "test@chronie.dev");
    const base = commit(repository, "base.txt", "base");
    run(repository, base);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function check(repository: string, base: string, head: string): SpawnSyncReturns<string> {
  return spawnSync("bash", [CHECK, base, head], { cwd: repository, encoding: "utf8" });
}

describe("the pull request branch history", () => {
  it("accepts a linear branch", () => {
    inRepository((repository, base) => {
      git(repository, "checkout", "-b", "feature");
      const head = commit(repository, "feature.txt", "feature");

      expect(check(repository, base, head).status).toBe(0);
    });
  });

  it("rejects a branch that merged main into itself", () => {
    inRepository((repository) => {
      git(repository, "checkout", "-b", "feature");
      commit(repository, "feature.txt", "feature");
      git(repository, "checkout", "main");
      const base = commit(repository, "main.txt", "main moved");
      git(repository, "checkout", "feature");
      git(repository, "merge", "--no-ff", "main", "-m", "Merge origin/main");
      const head = git(repository, "rev-parse", "HEAD");

      const result = check(repository, base, head);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Merge origin/main");
      expect(result.stdout).toContain("git rebase origin/main");
    });
  });

  it("allows a merge from another feature branch", () => {
    inRepository((repository, base) => {
      git(repository, "checkout", "-b", "dependency");
      commit(repository, "dependency.txt", "dependency");
      git(repository, "checkout", "-b", "feature", base);
      commit(repository, "feature.txt", "feature");
      git(repository, "merge", "--no-ff", "dependency", "-m", "Merge dependency");
      const head = git(repository, "rev-parse", "HEAD");

      expect(check(repository, base, head).status).toBe(0);
    });
  });
});
