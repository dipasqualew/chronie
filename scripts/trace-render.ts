/**
 * Where the wait goes when a reader puts an outfit on the character.
 *
 * Two halves, measured separately, because the wait crosses a process boundary and neither
 * half can see the other. The **backend** half is `examples/trace_render`, which runs the same
 * calls the `worn_set` command runs and reports the spans underneath them; that is where the
 * detail is, and running it directly is the thing to do when only that half is in question.
 * The **frontend** half is this file's own job: the `.glb` the backend hands over still has to
 * cross the IPC as a data URL, be decoded, be parsed by three.js and be uploaded to the GPU,
 * and none of that shows up in a Rust span.
 *
 * ```sh
 * bun run trace                                     # both halves, from the fixtures
 * bun run trace --install "/Applications/World of Warcraft" --what set/5570
 * bun run trace --backend-only --runs 5
 * ```
 *
 * **Release, always** — the backend is built with `--release` here whatever the caller does,
 * because a debug build measures `cargo tauri dev` and not the product. The first run of the
 * backend against a real install is measured on its own: it pays for a cold page cache over a
 * 123GB install, and the runs after it are what a reader clicking through a wardrobe waits for.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..");
const DESKTOP = join(ROOT, "apps", "desktop");
const MANIFEST = join(DESKTOP, "src-tauri", "Cargo.toml");
const FIXTURES = join(DESKTOP, "fixtures", "transmog");

/** Not 1420, so a `bun run dev` alongside this keeps working. Not 1421 either, so does a render. */
const PORT = 1422;
const PATIENCE_MS = 60_000;

interface Options {
  /** What to put on the character: `set/<id>`, `worn/<display>/<slot>`, or `character`. */
  what: string;
  install: string | null;
  runs: number;
  backendOnly: boolean;
  /** Whether the backend keeps one open CASC across runs, which nothing in the app does yet. */
  reuse: boolean;
}

/** What the page timed, in milliseconds. */
interface Timings {
  /** The data URL's payload turning back into bytes. A function of size and nothing else. */
  decode: number;
  /** Three.js reading the `.glb`, building the scene, and the two frames that draw it. */
  load: number;
  vertices: number;
}

const options = parse(process.argv.slice(2));
const temp = mkdtempSync(join(tmpdir(), "chronie-trace-"));
let server: ChildProcess | undefined;
try {
  backend(options);
  if (!options.backendOnly) {
    server = await serve();
    await frontend(options);
  }
} finally {
  server?.kill();
  rmSync(temp, { recursive: true, force: true });
}

/**
 * The Rust half, which prints its own report.
 *
 * Inherited stdio rather than captured: the example's table is the output, and re-formatting it
 * here would be a second thing to keep in step with it.
 */
function backend(options: Options): void {
  const source = options.install ? [options.install] : ["--fixtures", FIXTURES];
  execFileSync(
    "cargo",
    [
      "run",
      "--release",
      "--quiet",
      "--manifest-path",
      MANIFEST,
      "--example",
      "trace_render",
      "--",
      ...source,
      options.what,
      "--runs",
      String(options.runs),
      ...(options.reuse ? ["--reuse"] : []),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

/**
 * The browser half: what the window does with the bytes after the backend is finished with them.
 *
 * The same `.glb` the backend just produced, through the app's own stage on the app's own dev
 * server — so what is timed is the loader, the materials and the upload the product uses, and
 * not a second renderer written for a measurement.
 *
 * Two numbers rather than four, because two is what can be measured from outside the page
 * without the stage growing marks for the benefit of a script. **decode** is the data URL's
 * payload turning back into bytes, which is a function of how large the payload is and nothing
 * else; **load** is everything after it — the loader, the scene, the texture upload and the two
 * frames it takes for them to be drawn.
 */
async function frontend(options: Options): Promise<void> {
  const glb = model(options);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
    page.on("pageerror", (error) => console.error(`  page: ${error.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/render.html`);

    console.log(`\n=== frontend  ${glb.length} bytes of glb, ${options.runs} runs`);
    console.log(`${"run".padEnd(6)}${"decode".padStart(10)}${"load".padStart(10)}`);
    for (let run = 1; run <= options.runs; run += 1) {
      const timings = await page.evaluate(measured, glb.toString("base64"));
      console.log(
        `${String(run).padEnd(6)}${ms(timings.decode)}${ms(timings.load)}` +
          (run === 1 ? `   ${timings.vertices} vertices` : ""),
      );
    }
  } finally {
    await browser.close();
  }
}

/** Runs in the page. Deliberately standalone — it is serialised across, so it closes over nothing. */
async function measured(base64: string): Promise<Timings> {
  const stage = globalThis as unknown as {
    renderModel(one: { glb: string; size: number }): Promise<{ vertices: number }>;
    __timings?: { decode: number; parse: number };
  };
  const start = performance.now();
  const binary = atob(base64);
  Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decode = performance.now() - start;

  const loading = performance.now();
  const report = await stage.renderModel({ glb: base64, size: 640 });
  // `renderModel` decodes the same payload again inside itself; that repeat is timed above and
  // subtracted, so what is left is the loader, the upload and the two frames.
  const load = performance.now() - loading - decode;
  return { decode, load, vertices: report.vertices };
}

/** The `.glb` itself, out of the backend's own converter. */
function model(options: Options): Buffer {
  const out = join(temp, "model.glb");
  const source = options.install ? [options.install] : ["--fixtures", FIXTURES];
  execFileSync(
    "cargo",
    [
      "run",
      "--release",
      "--quiet",
      "--manifest-path",
      MANIFEST,
      "--example",
      "dump_model",
      "--",
      ...source,
      options.what,
      out,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return readFileSync(out);
}

async function serve(): Promise<ChildProcess> {
  const started = spawn(
    "bun",
    ["x", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: DESKTOP, stdio: ["ignore", "ignore", "inherit"] },
  );
  const until = Date.now() + PATIENCE_MS;
  while (Date.now() < until) {
    try {
      const answer = await fetch(`http://127.0.0.1:${PORT}/render.html`);
      if (answer.ok) return started;
    } catch {
      /* Not up yet. */
    }
    await new Promise((wait) => setTimeout(wait, 200));
  }
  started.kill();
  throw new Error(`the dev server did not come up on ${PORT}`);
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`.padStart(10);
}

function parse(argv: string[]): Options {
  const options: Options = {
    what: "set/5570",
    install: null,
    runs: 3,
    backendOnly: false,
    reuse: false,
  };
  for (let at = 0; at < argv.length; at += 1) {
    switch (argv[at]) {
      case "--install":
        options.install = argv[(at += 1)] ?? usage();
        break;
      case "--what":
        options.what = argv[(at += 1)] ?? usage();
        break;
      case "--runs":
        options.runs = Number(argv[(at += 1)]);
        if (!Number.isFinite(options.runs) || options.runs <= 0) usage();
        break;
      case "--backend-only":
        options.backendOnly = true;
        break;
      case "--reuse":
        options.reuse = true;
        break;
      default:
        usage();
    }
  }
  return options;
}

function usage(): never {
  console.error(
    "usage: bun run trace [--what set/5570] [--install <wow install>]\n" +
      "                    [--runs 3] [--reuse] [--backend-only]\n" +
      "\n" +
      "Without --install everything is read from the committed fixtures, which is the mode\n" +
      "that needs no game on the machine. --reuse keeps one open CASC across the backend's\n" +
      "runs, which is the counterfactual the app does not have today.",
  );
  process.exit(2);
}
