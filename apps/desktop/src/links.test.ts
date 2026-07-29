import { describe, expect, it } from "vitest";
import { externalUrl, installExternalLinks } from "./links";
import type { ClickLike, Linkish } from "./links";

/** An anchor with nothing on it but the href a test is asking about. */
const link = (href: string | null): Linkish => ({
  getAttribute: (name) => (name === "href" ? href : null),
});

describe("externalUrl", () => {
  it.each<[string, string]>([
    ["a wowhead quest", "https://www.wowhead.com/quest=12345"],
    ["a wowhead item", "https://www.wowhead.com/item=222446"],
    ["plain http", "http://example.test/page"],
    ["a mail link", "mailto:someone@example.test"],
  ])("takes %s out of the window", (_what, href) => {
    expect(externalUrl(link(href))).toBe(href);
  });

  // Everything the window does to itself stays in the window, and a click with no link
  // under it at all is the common case: most of the page is not a link.
  it.each<[string, string | null]>([
    ["a click on no link at all", null],
    ["an empty href", ""],
    ["the page itself", "#"],
    ["an anchor within the page", "#setup"],
    ["a relative path", "index.html"],
    ["a root-relative path", "/assets/app.js"],
  ])("leaves %s alone", (_what, href) => {
    expect(externalUrl(href === null ? null : link(href))).toBeNull();
  });

  // Markup wraps hrefs across lines, and the surrounding whitespace comes with them.
  it("ignores the whitespace a wrapped attribute carries", () => {
    expect(externalUrl(link("\n  https://www.wowhead.com/quest=1  "))).toBe(
      "https://www.wowhead.com/quest=1",
    );
  });
});

/** A click on a given href, which records whether the page was left to answer it itself. */
interface Click extends ClickLike {
  prevented: boolean;
}

const clickOn = (href: string | null): Click => ({
  // The window resolves a click's target to the link around it; here the target *is* the
  // href, so a test says which link was clicked and nothing has to stand in for the DOM.
  target: href,
  prevented: false,
  preventDefault(): void {
    this.prevented = true;
  },
});

/**
 * Something clicks are heard on, as a real one behaves: a set of listeners rather than the one
 * slot this test used to keep.
 *
 * The difference is what makes an installer that cannot be uninstalled visible at all. With one
 * slot, a second install simply replaced the first and every click was answered once whatever
 * the code did about removal; with a set, a listener nothing took off is a click answered twice.
 */
function clickSource() {
  const listeners = new Set<(event: ClickLike) => void>();
  return {
    /** How many are still attached, which is the whole question. */
    get listening(): number {
      return listeners.size;
    },
    root: {
      addEventListener: (_type: "click", given: (event: ClickLike) => void): void => {
        listeners.add(given);
      },
      removeEventListener: (_type: "click", given: (event: ClickLike) => void): void => {
        listeners.delete(given);
      },
    },
    /** One click, offered to everything attached the way a document offers it. */
    click(href: string | null): Click {
      const event = clickOn(href);
      for (const listener of [...listeners]) listener(event);
      return event;
    },
  };
}

/**
 * The window's link handling, installed over a click source a test can drive, with what it
 * asked the operating system for and what the operating system refused kept beside it.
 */
function installed(open: (url: string) => Promise<unknown>) {
  const opened: string[] = [];
  const failures: Array<[string, unknown]> = [];
  const source = clickSource();
  const install = (): (() => void) =>
    installExternalLinks({
      root: source.root,
      open: (url) => {
        opened.push(url);
        return open(url);
      },
      linkOf: (target) => (typeof target === "string" ? link(target) : null),
      onFailure: (url, error) => failures.push([url, error]),
    });
  const stop = install();
  return { opened, failures, click: source.click, source, install, stop };
}

const accepts = (): Promise<void> => Promise.resolve();

describe("installExternalLinks", () => {
  it("hands an external link to the operating system instead of the page", () => {
    const window = installed(accepts);

    const event = window.click("https://www.wowhead.com/quest=12345");

    expect(window.opened).toEqual(["https://www.wowhead.com/quest=12345"]);
    expect(event.prevented).toBe(true);
  });

  it.each<[string, string | null]>([
    ["a click on nothing", null],
    ["a link into the page", "#setup"],
  ])("leaves %s to the page", (_what, href) => {
    const window = installed(accepts);

    const event = window.click(href);

    expect(window.opened).toEqual([]);
    expect(event.prevented).toBe(false);
  });

  // A url the backend refuses — one outside the capability's scope, say — is a link that
  // does nothing when clicked, which is the whole bug this exists to fix.
  it("reports a link the operating system would not take", async () => {
    const window = installed(() =>
      Promise.reject(new Error("url not allowed on the configured scope")),
    );

    window.click("https://example.test/nope");
    await Promise.resolve();

    expect(window.failures).toHaveLength(1);
    expect(window.failures[0]?.[0]).toBe("https://example.test/nope");
    expect(String(window.failures[0]?.[1])).toContain("not allowed");
  });

  // What the window has no other way of arranging. The handler lives on the document rather than
  // on any anchor, so nothing goes away on its own when the app that installed it does.
  it("stops answering clicks once it has been stopped", () => {
    const window = installed(accepts);

    window.stop();
    const event = window.click("https://www.wowhead.com/item=222446");

    expect(window.source.listening).toBe(0);
    expect(window.opened).toEqual([]);
    expect(event.prevented).toBe(false);
  });

  /*
   * Set up, torn down, set up again — which is what React does to every effect in development to
   * prove the teardown is real, and what the window used to have no answer to. One click reaching
   * the operating system twice is two browser tabs on one link.
   */
  it("answers a click once after being set up, torn down and set up again", () => {
    const window = installed(accepts);

    window.stop();
    const stop = window.install();
    window.click("https://www.wowhead.com/quest=12345");

    expect(window.source.listening).toBe(1);
    expect(window.opened).toEqual(["https://www.wowhead.com/quest=12345"]);

    stop();
    expect(window.source.listening).toBe(0);
  });
});
