/**
 * The window as a window: the rules it is served under, and the build in the corner of it.
 *
 * Neither is about a feature, which is why they are here rather than in an area's file. The
 * first is about the harness itself — three attempts at the class colours were green in this
 * suite and grey in the app, because this suite was not running under the app's own Content
 * Security Policy — and the second is the one thing on every screen at once.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "./harness";
import { Shell } from "./pages/shell";

test("is served the policy the packaged window is, and says which build it is", async ({
  page,
}) => {
  const shell = new Shell(page);

  /**
   * Tauri serves the page under a CSP and stamps a nonce onto the `<style>` tags it embeds,
   * and a nonce in `style-src` makes every engine ignore `'unsafe-inline'`. A `style=""`
   * attribute has nowhere to put a nonce, so every colour the page sent that way was thrown
   * out before it was ever drawn. `vite.config.ts` now serves that same policy to the dev
   * server and to this one, and this says so out loud — because the day it silently stops
   * being true is the day every assertion about colour in this suite proves nothing.
   */
  const served = await test.step("the page is served a policy with a nonce in it", async () => {
    const csp = await shell.policy();

    // A nonce, specifically. `'unsafe-inline'` is in the directive too and is the thing the
    // nonce switches off, so a policy that had lost the nonce would still look permissive
    // while being far more permissive than the product.
    expect(csp).toMatch(/style-src[^;]*'nonce-/);
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    return csp;
  });

  await test.step("and the page survives it, stylesheet and all", async () => {
    // A body drawn in the browser default is what a mis-stamped nonce looks like, and it would
    // take every assertion about colour in this suite with it.
    await expect(shell.background()).resolves.toBe("rgb(246, 245, 242)");
  });

  await test.step("and grants everything the packaged policy grants", async () => {
    // The two policies are written out by hand in two files, and only one of them is ever
    // served to anything that could complain. The packaged one is the product's, and the day
    // it grants less than this one does is the day the suite goes back to being more
    // permissive than the window — which is how a model with every texture refused shipped
    // green.
    //
    // Not equality: the served policy legitimately carries the nonces above, the dev server's
    // websocket and its port. What has to hold is that nothing the page needs is missing from
    // the one the reader actually runs under.
    const packaged: string = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.conf.json"),
        "utf8",
      ),
    ).app.security.csp;
    for (const directive of ["connect-src", "img-src"]) {
      const granted = (policy: string): string[] =>
        policy
          .split(";")
          .find((one) => one.trim().startsWith(directive))
          ?.trim()
          .split(/\s+/) ?? [];
      // `blob:` by name, because it is the one every picture in every `.glb` arrives through —
      // as a `fetch` on Chromium and as an `<img>` on WebKit, so both directives or neither.
      expect(granted(packaged), `${directive} in tauri.conf.json`).toContain("blob:");
      expect(granted(served), `${directive} as served`).toContain("blob:");
    }
  });

  /**
   * A version is only worth showing if it can be followed: the reader writing down what went
   * wrong needs the commit, and the reader wondering whether their installer is the current one
   * needs the release. Neither is reachable from a string of hex on its own, so the test that
   * matters is not that the label is drawn — it is that clicking it leaves the window.
   */
  await test.step("the build is in the corner, and both halves of it go to GitHub", async () => {
    await expect(shell.build()).toHaveText("dev#95b5e08");

    await shell.build().getByRole("link", { name: "Commit 95b5e08 on GitHub" }).click();
    await shell.build().getByRole("link", { name: "The dev release on GitHub" }).click();

    await expect
      .poll(() => shell.openedUrls())
      .toEqual([
        // The whole sha, which is the only form GitHub resolves — the seven on screen are for
        // reading, and a link built out of them would be a link to nothing.
        "https://github.com/dipasqualew/chronie/commit/95b5e08d2f1a4c3b6e7d8a9f0b1c2d3e4f5a6b7c",
        "https://github.com/dipasqualew/chronie/releases/tag/dev",
      ]);
  });

  await test.step("and the window is still the window afterwards", async () => {
    // Handed out, not followed.
    expect(shell.url()).toContain("127.0.0.1:4399");
    await expect(shell.view("Timeline").getByRole("heading", { name: "Timeline" })).toBeVisible();
  });
});
