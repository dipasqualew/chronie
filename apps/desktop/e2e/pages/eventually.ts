/**
 * A reading that has to arrive, and the only shape a page object hands one back in.
 *
 * A page object that returns a `Locator` gets Playwright's retrying assertions for nothing:
 * `expect(locator).toHaveText(…)` asks again until the page agrees or the deadline passes. A
 * page object that returns a promise gets the opposite — the value is read once and compared
 * once, so a window that has not finished answering fails an assertion about what it will say
 * a millisecond later. The two read almost identically at the call site and behave completely
 * differently, which is the whole of the trap: `expect(outfit.drew("vertices")).resolves` looks
 * like the web-first assertion it replaced and is not one.
 *
 * So a reading that cannot be a locator comes back as one of these instead. Every matcher on it
 * retries, and there is no promise at the call site to forget to wait for. `eslint.config.ts`
 * refuses `.resolves` anywhere under `e2e/` so the other shape cannot come back by hand.
 *
 *     stored(): Eventually<boolean | undefined> {
 *       return eventually(() => this.page.evaluate(() => …));
 *     }
 *
 *     await combat.stored().toBe(true);
 */

import { expect } from "@playwright/test";

/** An assertion over a value that arrives, rather than the value. Every matcher retries. */
export type Eventually<Value> = ReturnType<typeof expect.poll<Value>>;

/** Wraps a reading so that asserting on it keeps asking until it says what it should. */
export const eventually = <Value>(read: () => Promise<Value> | Value): Eventually<Value> =>
  expect.poll(read);
