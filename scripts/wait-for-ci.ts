#!/usr/bin/env bun
/**
 * Waits for GitHub Actions to finish on a branch, then says exactly what went wrong.
 *
 * Pushing and then guessing is the failure mode this exists to remove: a branch is not
 * finished when the push succeeds, it is finished when every workflow the push triggered has
 * gone green. So this blocks until each run for the branch's head commit reaches a
 * conclusion, and on anything other than success it prints the failed jobs, the steps inside
 * them that failed, every check annotation GitHub recorded, and the error lines from the job
 * logs — enough to fix the thing without opening a browser.
 *
 * It talks to GitHub through the `gh` CLI when there is one, and falls back to the REST API
 * with `GH_TOKEN`/`GITHUB_TOKEN` when there is not, so it works the same in a sandbox that
 * has only a token as on a laptop that has only `gh`.
 *
 *   bun run ci:wait                        # the current branch
 *   bun run ci:wait some-branch            # a named branch
 *   bun run ci:wait --sha 1a2b3c4          # a specific commit, whatever branch it is on
 *   bun run ci:wait --timeout 3600         # give up after an hour rather than 45 minutes
 *
 * Exits 0 only when every run concluded successfully.
 */

import { execFileSync } from "node:child_process";

/** Actions sets this itself; elsewhere it is the hook for GitHub Enterprise or a stub. */
const GITHUB_API = process.env.GITHUB_API_URL || "https://api.github.com";

/** How long to keep asking, and how often, unless told otherwise. */
const DEFAULTS = {
  timeoutSeconds: 45 * 60,
  intervalSeconds: 15,
  /** A push takes a moment to become a workflow run; an empty answer before this is normal. */
  startupGraceSeconds: 180,
};

/** Per failing job, so a broken build cannot bury the terminal. */
const LOG_LIMITS = {
  errorLines: 60,
  tailLines: 40,
};

interface Options {
  branch?: string;
  sha?: string;
  timeoutSeconds: number;
  intervalSeconds: number;
}

interface Repository {
  owner: string;
  repo: string;
}

interface WorkflowRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  event: string;
  run_attempt?: number;
}

interface JobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  steps?: JobStep[];
}

interface Annotation {
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  annotation_level: string | null;
  title: string | null;
  message: string | null;
  raw_details: string | null;
}

/** Conclusions that mean the branch is fine. Anything else is a reason to stay red. */
const GREEN = new Set(["success", "skipped", "neutral"]);

/* ---------- arguments ---------- */

function parseArguments(argv: string[]): Options {
  const options: Options = {
    timeoutSeconds: DEFAULTS.timeoutSeconds,
    intervalSeconds: DEFAULTS.intervalSeconds,
  };
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    const value = (): string => {
      const next = argv[at + 1];
      if (next === undefined) throw new Error(`${argument} needs a value.`);
      at += 1;
      return next;
    };
    if (argument === "--sha") options.sha = value();
    else if (argument === "--branch") options.branch = value();
    else if (argument === "--timeout") options.timeoutSeconds = Number(value());
    else if (argument === "--interval") options.intervalSeconds = Number(value());
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (argument.startsWith("-")) throw new Error(`Unknown option ${argument}.`);
    else options.branch = argument;
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds.");
  }
  if (!Number.isFinite(options.intervalSeconds) || options.intervalSeconds < 1) {
    throw new Error("--interval must be at least one second.");
  }
  return options;
}

const usage = (): string => `Usage: bun run ci:wait [branch] [--sha <commit>] \
[--timeout <seconds>] [--interval <seconds>]\n`;

/* ---------- git ---------- */

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** The repository CI runs for, from the environment first so a fork's remote cannot mislead. */
function resolveRepository(): Repository {
  const configured = process.env.CHRONIE_REPOSITORY || process.env.GITHUB_REPOSITORY;
  const slug = configured || remoteSlug();
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`Cannot read an owner/repo out of "${slug}".`);
  return { owner, repo: repo.replace(/\.git$/, "") };
}

/**
 * The owner and repo out of whatever the origin remote happens to look like.
 *
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo` and a sandbox's local
 * git proxy standing in front of either all end in the same two path segments, which is the
 * only part the API needs — so the last two are what this takes, rather than insisting on a
 * github.com host that a proxied clone does not have.
 */
function remoteSlug(): string {
  const url = git("remote", "get-url", "origin");
  const segments = url
    .replace(/\.git$/, "")
    .split(/[:/]/)
    .filter(Boolean);
  const repo = segments.pop();
  const owner = segments.pop();
  if (!owner || !repo)
    throw new Error(`Cannot read an owner/repo out of the origin remote (${url}).`);
  return `${owner}/${repo}`;
}

const currentBranch = (): string => git("rev-parse", "--abbrev-ref", "HEAD");

/* ---------- talking to GitHub ---------- */

const haveGh = ((): boolean => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * One GET, as text, through whichever transport this machine has.
 *
 * Transient failures are retried rather than ending a wait that may already be twenty
 * minutes old; a 404 is not transient and comes straight back to the caller.
 */
async function get(path: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return haveGh ? await viaGh(path) : await viaFetch(path);
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
      lastError = error;
      await sleep(2 ** attempt);
    }
  }
  throw lastError;
}

async function viaGh(path: string): Promise<string> {
  try {
    return execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status = /HTTP (\d{3})/.exec(detail)?.[1];
    throw new HttpError(status ? Number(status) : 0, `gh api ${path} failed: ${detail}`);
  }
}

async function viaFetch(path: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "chronie-wait-for-ci",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${GITHUB_API}${path}`, { headers });
  if (!response.ok) {
    // The body is where the reason lives, and a bare "403 Forbidden" sends the reader off
    // checking their token when the answer — a rate limit, a repository the token cannot
    // see, a gateway that has GitHub access switched off entirely — was right there.
    const body = await response.text().catch(() => "");
    const reason = body.trim() ? ` ${body.trim().slice(0, 500)}` : "";
    throw new HttpError(
      response.status,
      `GET ${path} answered ${response.status} ${response.statusText}.${reason}`,
    );
  }
  return await response.text();
}

const getJson = async <T>(path: string): Promise<T> => JSON.parse(await get(path)) as T;

/* ---------- the pieces of a run ---------- */

const headShaOf = async ({ owner, repo }: Repository, branch: string): Promise<string> => {
  const commit = await getJson<{ sha: string }>(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
  );
  return commit.sha;
};

const runsFor = async ({ owner, repo }: Repository, sha: string): Promise<WorkflowRun[]> => {
  const answer = await getJson<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
  );
  return answer.workflow_runs || [];
};

const jobsOf = async ({ owner, repo }: Repository, runId: number): Promise<Job[]> => {
  const answer = await getJson<{ jobs: Job[] }>(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return answer.jobs || [];
};

/** A job's id is also its check run's id, which is where GitHub files the annotations. */
async function annotationsOf({ owner, repo }: Repository, jobId: number): Promise<Annotation[]> {
  try {
    return await getJson<Annotation[]>(`/repos/${owner}/${repo}/check-runs/${jobId}/annotations`);
  } catch {
    return [];
  }
}

async function logOf({ owner, repo }: Repository, jobId: number): Promise<string> {
  try {
    return await get(`/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
  } catch {
    return "";
  }
}

/* ---------- reporting ---------- */

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};
const progress = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Actions stamps every log line with a timestamp that is only noise once it is quoted. */
const strip = (line: string): string => line.replace(/^\S+Z\s/, "").trimEnd();

/**
 * The lines worth quoting out of a job log: what the runner itself marked as an error, or
 * failing that the tail, which is where a command that died without a marker left its say.
 */
function logExcerpt(log: string): { title: string; lines: string[] } | null {
  if (!log.trim()) return null;
  const lines = log.split("\n").map(strip).filter(Boolean);
  const marked = lines.filter((line) => /##\[error\]|##\[warning\]/.test(line));
  if (marked.length) {
    return { title: "log errors", lines: marked.slice(0, LOG_LIMITS.errorLines) };
  }
  return { title: "log tail", lines: lines.slice(-LOG_LIMITS.tailLines) };
}

function reportAnnotations(annotations: Annotation[]): void {
  if (!annotations.length) return;
  out("    annotations:");
  for (const note of annotations) {
    const where = note.path
      ? `${note.path}${note.start_line ? `:${note.start_line}` : ""}`
      : "(no file)";
    const level = (note.annotation_level || "notice").toUpperCase();
    out(`      ${level} ${where} — ${note.title || ""}`.trimEnd());
    for (const line of (note.message || "").split("\n")) {
      if (line.trim()) out(`        ${line.trim()}`);
    }
    for (const line of (note.raw_details || "").split("\n")) {
      if (line.trim()) out(`        ${line.trim()}`);
    }
  }
}

async function reportRun(repository: Repository, run: WorkflowRun): Promise<void> {
  out();
  out(`✗ ${run.name || "workflow"} — ${run.conclusion} (${run.event})`);
  out(`  ${run.html_url}`);

  const jobs = await jobsOf(repository, run.id);
  const failed = jobs.filter((job) => job.conclusion && !GREEN.has(job.conclusion));
  if (!failed.length) {
    out("  No job reported a failure; the run itself was stopped or never started.");
    return;
  }

  for (const job of failed) {
    out(`  job "${job.name}" — ${job.conclusion}`);
    if (job.html_url) out(`    ${job.html_url}`);
    for (const step of job.steps || []) {
      if (step.conclusion && !GREEN.has(step.conclusion)) {
        out(`    failed step: ${step.name} (${step.conclusion})`);
      }
    }
    reportAnnotations(await annotationsOf(repository, job.id));
    const excerpt = logExcerpt(await logOf(repository, job.id));
    if (excerpt) {
      out(`    ${excerpt.title}:`);
      for (const line of excerpt.lines) out(`      ${line}`);
    }
  }
}

/* ---------- the wait ---------- */

const summarise = (runs: WorkflowRun[]): string =>
  runs
    .map(
      (run) => `${run.name || run.id}:${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`,
    )
    .join("  ");

async function main(): Promise<number> {
  const options = parseArguments(process.argv.slice(2));
  const repository = resolveRepository();
  const branch = options.branch || currentBranch();

  if (!haveGh && !token) {
    progress("No gh CLI and no GH_TOKEN/GITHUB_TOKEN; falling back to anonymous API calls.");
  }

  const sha = options.sha || (await headShaOf(repository, branch));
  progress(
    `Waiting for CI on ${repository.owner}/${repository.repo}@${branch} (${sha.slice(0, 8)})`,
  );
  progress(
    `  polling every ${options.intervalSeconds}s, giving up after ${options.timeoutSeconds}s`,
  );

  const startedAt = Date.now();
  const elapsed = (): number => (Date.now() - startedAt) / 1000;
  let lastLine = "";
  let runs: WorkflowRun[];

  for (;;) {
    runs = await runsFor(repository, sha);

    if (!runs.length) {
      if (elapsed() > DEFAULTS.startupGraceSeconds) {
        out(`No workflow run was ever triggered for ${sha}.`);
        return 1;
      }
      progress(`  no runs yet (${Math.round(elapsed())}s)`);
    } else {
      const line = summarise(runs);
      if (line !== lastLine) {
        progress(`  ${line}`);
        lastLine = line;
      }
      if (runs.every((run) => run.status === "completed")) break;
    }

    if (elapsed() > options.timeoutSeconds) {
      out(`Gave up after ${Math.round(elapsed())}s with runs still going: ${summarise(runs)}`);
      for (const run of runs) out(`  ${run.html_url}`);
      return 1;
    }
    await sleep(options.intervalSeconds);
  }

  const red = runs.filter((run) => !run.conclusion || !GREEN.has(run.conclusion));
  if (!red.length) {
    out(
      `CI is green on ${branch} (${sha.slice(0, 8)}): ` +
        runs.map((run) => `${run.name || run.id} ${run.conclusion}`).join(", "),
    );
    return 0;
  }

  out(`CI failed on ${branch} (${sha.slice(0, 8)}).`);
  for (const run of red) await reportRun(repository, run);
  out();
  out(`${red.length} of ${runs.length} runs did not succeed.`);
  return 1;
}

try {
  process.exit(await main());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
