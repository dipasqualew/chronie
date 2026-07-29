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
 * The window's link handling, installed over a click source a test can drive, with what it
 * asked the operating system for and what the operating system refused kept beside it.
 */
function installed(open: (url: string) => Promise<unknown>) {
  const opened: string[] = [];
  const failures: Array<[string, unknown]> = [];
  let listener: ((event: ClickLike) => void) | undefined;
  installExternalLinks({
    root: {
      addEventListener: (_type, given) => {
        listener = given;
      },
    },
    open: (url) => {
      opened.push(url);
      return open(url);
    },
    linkOf: (target) => (typeof target === "string" ? link(target) : null),
    onFailure: (url, error) => failures.push([url, error]),
  });
  return {
    opened,
    failures,
    click(href: string | null): Click {
      const event = clickOn(href);
      listener?.(event);
      return event;
    },
  };
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
});
