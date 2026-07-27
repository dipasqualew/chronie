/**
 * Renders a model to a PNG, offscreen, with no app running and nobody looking at anything.
 *
 * "Does the armour show?" was a question only a person squinting at a window could answer,
 * which meant it could not be answered twice the same way and could not be answered in CI at
 * all. This is the instrument that answers it: give it an appearance, get back a picture.
 *
 * ```sh
 * # From the committed fixtures — no game install, which is the mode CI can run.
 * bun run render worn/900012/3 robe.png
 * bun run render character character.png --unlit --view front
 *
 * # From a real install, which is the only place the game's own data can be looked at.
 * bun run render worn/712245/5 legs.png --install "/Applications/World of Warcraft"
 *
 * # Or a `.glb` somebody already has.
 * bun run render some-model.glb some-model.png
 * ```
 *
 * Two halves, and the split is deliberate. The **model** comes out of the Rust backend's own
 * `dump_model` example, so the bytes photographed here are the bytes the window is handed —
 * not a second implementation of the game's formats that could be right while the app is
 * wrong. The **picture** comes out of the app's own `modelViewer.ts`, loaded through the app's
 * own dev server, under the app's own Content Security Policy. A renderer written for this
 * tool would be quicker and would prove nothing about the product, which matters more here
 * than it usually does: the last two faults in this pipeline were the policy the page was
 * served under and a column index, and neither is visible to anything that renders a `.glb`
 * its own way.
 *
 * **`--unlit` is the mode to measure with.** The window's key light at 2.2 over an ambient at
 * 1.1, through ACES tone mapping, moves every colour it draws — a flat tan body comes out near
 * white, and reading "no texture" off that is a mistake this repository has already made once.
 * Unlit draws each texel as the colour it is. Lit is for the eye; unlit is for an assertion.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..");
const DESKTOP = join(ROOT, "apps", "desktop");
const FIXTURES = join(DESKTOP, "fixtures", "transmog");

/** The port the tool's own dev server takes. Not 1420, so that a `bun run dev` alongside it
 * keeps working. */
const PORT = 1421;

/** How long to wait for the dev server to come up, and for a model to draw. */
const PATIENCE_MS = 60_000;

/** The views `modelPreview.ts` knows how to place a camera for. */
const VIEWS = ["default", "front", "back", "left", "right"] as const;
type View = (typeof VIEWS)[number];

/** What the page says about what it drew, which is `renderStage.ts`'s `RenderReport`. */
interface Report {
  vertices: number;
  pictures: number;
  blank: number;
}

interface Options {
  /** What to draw: a path to a `.glb`, or a spec `dump_model` understands. */
  what: string;
  /** Where the PNG goes. */
  out: string;
  /** A World of Warcraft install to read the model out of, when it is not the fixtures. */
  install: string | null;
  unlit: boolean;
  view: View;
  size: number;
}

const options = parse(process.argv.slice(2));
const temp = mkdtempSync(join(tmpdir(), "chronie-render-"));
let server: ChildProcess | undefined;
try {
  const glb = model(options);
  console.log(`model  ${glb.length} bytes`);
  server = await serve();
  await render(options, glb);
} finally {
  server?.kill();
  rmSync(temp, { recursive: true, force: true });
}

async function render(options: Options, glb: Buffer): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: options.size, height: options.size } });
    // A page that logs its own refusals, because the interesting failures in this pipeline are
    // the silent ones: a texture the policy would not let through leaves a model in flat white
    // and says nothing anywhere else.
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`  page: ${message.text()}`);
    });
    page.on("pageerror", (error) => console.error(`  page: ${error.message}`));

    await page.goto(`http://127.0.0.1:${PORT}/render.html`);
    const report = await page.evaluate(
      // The page's own function, reached through `globalThis` because this file has no DOM to
      // name a `window` with — it never runs in one.
      (request) =>
        (globalThis as unknown as { renderModel(one: typeof request): Promise<Report> })
          .renderModel(request),
      {
        glb: glb.toString("base64"),
        size: options.size,
        unlit: options.unlit,
        view: options.view,
      },
    );
    console.log(
      `drawn  ${report.vertices} vertices, ` +
        `${report.pictures} textures with a picture, ${report.blank} without`,
    );
    if (report.vertices === 0) throw new Error("the model parsed into no geometry at all");

    await page.locator("#stage").screenshot({ path: options.out });
    console.log(`wrote  ${options.out}`);
  } finally {
    await browser.close();
  }
}

/**
 * The `.glb` to photograph, whether that is a file or something to be read out of the game.
 *
 * Anything that is not a path goes to `dump_model`, which is the backend's own converter — so
 * the tool never learns to read a game file for itself and can never disagree with the app
 * about what one says.
 */
function model(options: Options): Buffer {
  if (options.what.endsWith(".glb")) return readFileSync(options.what);

  const out = join(temp, "model.glb");
  const source = options.install ? [options.install] : ["--fixtures", FIXTURES];
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      join(DESKTOP, "src-tauri", "Cargo.toml"),
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

/**
 * The app's own dev server, up and answering.
 *
 * Its own server rather than a static file: the page imports `modelViewer.ts` by source, and
 * the Vite config is what serves it under the Content Security Policy the packaged window
 * runs under. Serving these bytes any other way would be more permissive than the product,
 * which is the one thing that would make the picture a lie.
 */
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

function parse(argv: string[]): Options {
  const positional: string[] = [];
  const options: Options = {
    what: "",
    out: "",
    install: null,
    unlit: false,
    view: "default",
    size: 640,
  };

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at]!;
    switch (argument) {
      case "--unlit":
        options.unlit = true;
        break;
      case "--install":
        options.install = argv[(at += 1)] ?? usage();
        break;
      case "--view": {
        const view = argv[(at += 1)];
        if (!VIEWS.includes(view as View)) usage();
        options.view = view as View;
        break;
      }
      case "--size":
        options.size = Number(argv[(at += 1)]);
        if (!Number.isFinite(options.size) || options.size <= 0) usage();
        break;
      default:
        if (argument.startsWith("--")) usage();
        positional.push(argument);
    }
  }

  if (positional.length !== 2) usage();
  options.what = positional[0]!;
  options.out = positional[1]!;
  return options;
}

function usage(): never {
  console.error(
    "usage: bun run render <model> <out.png> [--install <wow install>]\n" +
      "                     [--unlit] [--view default|front|back|left|right] [--size 640]\n" +
      "\n" +
      "  <model>  a path to a .glb, or what dump_model understands: a display id,\n" +
      "           `character`, or `worn/<displayInfoID>/<displayType>`.\n" +
      "\n" +
      "Without --install the model is read from the committed fixtures, which is the mode\n" +
      "that needs no game on the machine and is the one CI runs.",
  );
  process.exit(2);
}

