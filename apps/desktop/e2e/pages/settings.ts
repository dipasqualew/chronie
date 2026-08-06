/**
 * Settings: a rail of categories and one pane, and the four panels that live on it.
 *
 * Each panel is a landmark named after its own heading, so everything inside one is asked for
 * by role within it — the checkbox by the label beside it, the state line by its being a live
 * region. Nothing here knows an id or a class, so a panel can be rebuilt and this still
 * addresses it.
 *
 * What the backend was actually told is read back beside what the panel says, and that pairing
 * is the point: a control that reports a setting it never saved looks identical on screen to
 * one that did. Those readings come back as `Eventually` rather than as promises, because a
 * write lands when the command answers and not when the box was ticked — see `eventually.ts`.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { eventually } from "./eventually";
import type { Eventually } from "./eventually";
import { Shell } from "./shell";

/** The categories on the rail, by the words on them. */
type Category = "Game and sync" | "Screenshots" | "Combat logs" | "Move this history";

/**
 * Opens Settings on a given category, which every panel below is reached through.
 *
 * Two clicks, written down once — and the reason this is a function rather than a class is
 * that there is nothing to keep: what a caller wants is the panel, not the way in.
 */
export async function openSettings(page: Page, category: Category): Promise<void> {
  await new Shell(page).open("Settings");
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: category })
    .click();
}

/**
 * The first category: where the game is, and the four buttons that reach outside the window.
 *
 * Every one of them touches the filesystem, the addon folder or an update server, and a button
 * that silently succeeded or silently failed is the same button — so the status line under
 * them is the whole of what this panel is held to.
 */
export class GameAndSync {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Game and sync" });
  }

  async open(): Promise<void> {
    await openSettings(this.page, "Game and sync");
    await expect(this.panel).toBeVisible();
  }

  folder(): Locator {
    return this.panel.getByLabel("Game folder");
  }

  /** One of the buttons that reaches outside the window, by the words on it. */
  button(name: string): Locator {
    return this.panel.getByRole("button", { name });
  }

  /** What the last of those buttons did, which is announced as it changes. */
  state(): Locator {
    return this.panel.getByRole("status");
  }

  /** The one box on this panel: whether the addon walks the account off its own bat. */
  census(): Locator {
    return this.panel.getByRole("checkbox", {
      name: "Walk the whole account after a loading screen",
    });
  }

  /** And what the backend was actually told, as against what the box on screen drew. */
  storedCensus(): Eventually<boolean | undefined> {
    return eventually(() =>
      this.page.evaluate(() => window.__Chronie_E2E__?.settings.automaticCensus),
    );
  }
}

/**
 * The screenshots category: what photographs itself, and what is kept of it.
 *
 * Every control is addressed by the moment it is about — "a mount added to the collection" —
 * because that is what somebody is looking for and what a screen reader announces.
 */
export class CaptureSettings {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Screenshots" });
  }

  async open(): Promise<void> {
    await openSettings(this.page, "Screenshots");
    await expect(this.panel).toBeVisible();
  }

  /** One rule's box, named by the moment it photographs. */
  trigger(moment: string | RegExp): Locator {
    return this.panel.getByRole("checkbox", { name: moment });
  }

  /** One of the four things Chronie can keep of a picture. */
  quality(level: string | RegExp): Locator {
    return this.panel.getByRole("radio", { name: level });
  }

  originals(): Locator {
    return this.panel.getByRole("checkbox", { name: "Leave the game’s own copy where it is" });
  }

  /** What the panel says about the rules as they stand, which is announced as it changes. */
  state(): Locator {
    return this.panel.getByRole("status");
  }

  /** And what the backend was actually told to store, which is the other half of every claim. */
  stored(): Eventually<{ triggers: string[]; quality?: string; keepOriginals?: boolean }> {
    return eventually(() =>
      this.page.evaluate(() => ({
        triggers: window.__Chronie_E2E__?.settings.captureTriggers ?? [],
        quality: window.__Chronie_E2E__?.settings.captureQuality,
        keepOriginals: window.__Chronie_E2E__?.settings.keepOriginalScreenshots,
      })),
    );
  }
}

/**
 * The combat logging panel: one switch, and what the install is really doing.
 *
 * The two are separate facts and the panel says both — the setting Chronie holds, and what it
 * read off the game's own config and Logs folder.
 */
export class CombatLogging {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Combat logging" });
  }

  async open(): Promise<void> {
    await openSettings(this.page, "Combat logs");
    await expect(this.panel).toBeVisible();
  }

  /** The one box somebody has to tick themselves, named by the label wrapped around it. */
  toggle(): Locator {
    return this.panel.getByRole("checkbox", { name: "Start combat logging when I log in" });
  }

  /** Where the panel says this install stands, which is announced as it changes. */
  state(): Locator {
    return this.panel.getByRole("status");
  }

  /** What the backend was told, as against what the switch on screen drew. */
  stored(): Eventually<boolean | undefined> {
    return eventually(() =>
      this.page.evaluate(() => window.__Chronie_E2E__?.settings.combatLogging),
    );
  }
}

/**
 * The retention panel: a switch, a number of days, and — the reason the panel exists — the
 * files a sweep would take, by name, before anybody agrees to it.
 */
export class LogRetention {
  readonly page: Page;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Deleting old combat logs" });
  }

  toggle(): Locator {
    return this.panel.getByRole("checkbox", {
      name: "Delete combat logs Chronie has finished reading",
    });
  }

  /** How long a log is kept, which is a number and is addressed as one. */
  days(): Locator {
    return this.panel.getByRole("spinbutton", { name: "Keep logs for" });
  }

  state(): Locator {
    return this.panel.getByRole("status");
  }

  /** What was stored, which is `null` while Chronie is told to keep every log. */
  stored(): Eventually<number | null | undefined> {
    return eventually(() =>
      this.page.evaluate(() => window.__Chronie_E2E__?.settings.retainLogDays ?? null),
    );
  }
}
