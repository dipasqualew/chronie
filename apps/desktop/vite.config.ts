// `vitest/config` rather than `vite`, so the `test` block below is type checked rather
// than tolerated as an unknown key.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vitest/config";
// The server types come from vite itself; `vitest/config` re-exports the config surface and
// not the running server's.
import type { PreviewServer, ViteDevServer } from "vite";

/**
 * Serves the page under the same Content Security Policy the packaged app runs under.
 *
 * `tauri.conf.json` asks for `style-src 'self' 'unsafe-inline'`, and what the webview
 * actually receives is not that: Tauri stamps a nonce onto every `<style>` tag it embeds
 * and appends `'nonce-…'` to the directive. A nonce in `style-src` makes every browser
 * ignore `'unsafe-inline'` — that is the CSP rule, not a bug — and since a `style=""`
 * attribute has nowhere to carry a nonce, every inline style the app writes is dropped.
 *
 * Vite serves no CSP at all, so `bun run dev` and the browser suite were running under
 * rules the real window has never had. That is what let three attempts at the class
 * colours pass their tests and render grey in the app. The dev server is the wrong place
 * to be more permissive than the product, so it is not.
 */
function tauriCsp(): Plugin {
  const nonce = randomUUID();
  const csp = [
    "default-src 'self'",
    // `blob:` twice, and not as belt and braces. A `.glb` carries its pictures inside itself,
    // and three.js hands each one to the browser as a `blob:` URL — through `fetch` where
    // `createImageBitmap` exists and through an `<img>` where it does not. So the packaged app
    // hits `connect-src` on Windows, where the webview is Chromium, and `img-src` on macOS and
    // Linux, where it is WebKit and older than Safari 17. A policy naming only one of them
    // ships a model with no colour on half the platforms and nothing to say why.
    "connect-src 'self' ipc: http://ipc.localhost ws: http://localhost:1420 blob:",
    "img-src 'self' data: blob:",
    `style-src 'self' 'unsafe-inline' 'nonce-${nonce}'`,
    `script-src 'self' 'unsafe-inline' 'nonce-${nonce}'`,
  ].join("; ");
  // Tauri nonces the `<style>` and `<script>` tags it finds in the HTML it embeds; doing the
  // same here is what keeps the page's own stylesheet alive under a policy that has stopped
  // trusting inline. It deliberately does not reach `style=""` attributes — nothing can.
  //
  // The meta tag is the other half of that, and it is only the dev server's problem. A built
  // page reaches its CSS through a `<link>` that `'self'` already allows; a served one has
  // Vite hand each `.css` module to the browser as a `<style>` element it creates at runtime,
  // which no HTML transform can reach. Vite reads a nonce off `meta[property=csp-nonce]` and
  // puts it on every one of those, so telling it the nonce here is what keeps `bun run dev`
  // from opening on an unstyled page.
  const stamp = (html: string): string =>
    html
      .replace(/<(style|script)(?=[\s>])/g, `<$1 nonce="${nonce}"`)
      .replace("</head>", `<meta property="csp-nonce" nonce="${nonce}">\n</head>`);

  const policy = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use((_request, response, next) => {
      response.setHeader("Content-Security-Policy", csp);
      next();
    });
  };

  return {
    name: "chronie:tauri-csp",
    // Serving only. A nonce baked into `dist/index.html` would be the one thing Tauri's own
    // stamping skips — it leaves a tag that already has a `nonce` alone — so the shipped
    // page would carry a nonce the shipped policy has never heard of.
    apply: "serve",
    configureServer: policy,
    // Last, so that the tags other plugins inject are stamped too. React's dev server adds a
    // refresh preamble as an inline `<script>`, and a preamble the nonce missed is a blank
    // window under this policy — the one place a stricter dev server would be a worse one.
    transformIndexHtml: { order: "post", handler: stamp },
    // `vite preview` serves the build as static files, so nothing transforms its HTML on the
    // way out and the stamping has to happen here. This is the server the browser suite
    // runs against, which makes it the one that has to match the product.
    configurePreviewServer(server) {
      policy(server);
      server.middlewares.use((request, response, next) => {
        if (!["/", "/index.html"].includes((request.url ?? "").split("?")[0]!)) return next();
        response.setHeader("Content-Type", "text/html");
        response.end(stamp(readFileSync(join(import.meta.dirname, "dist/index.html"), "utf8")));
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [react(), tauriCsp()],
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // three.js is 630 kB on its own and is already split off into a chunk nobody downloads
    // until they open a model. Warning about it on every build would only teach us to ignore
    // the warning; anything above this is something new and worth looking at.
    chunkSizeWarningLimit: 700,
    target: "esnext",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: Boolean(process.env.TAURI_DEBUG),
  },
  test: {
    // The views are components, so the unit tests render them, and jsdom is the smallest
    // thing that can hold one. The pure modules beside them neither notice nor need it, and
    // standing a fresh jsdom up for each of their files was costing more than those files
    // spent running. The extension already says which is which: a `.tsx` test renders,
    // a `.ts` test does not.
    projects: [
      {
        extends: true,
        test: { name: "modules", include: ["src/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: { name: "views", include: ["src/**/*.test.tsx"], environment: "jsdom" },
      },
    ],
  },
});
