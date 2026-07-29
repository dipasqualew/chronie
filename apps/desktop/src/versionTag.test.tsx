import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VersionTag } from "./versionTag";
import type { Release } from "./types";

afterEach(cleanup);

const SHA = "95b5e08d2f1a4c3b6e7d8a9f0b1c2d3e4f5a6b7c";

const built = (commit: string, channel = "dev"): Release => ({ channel, commit });

/** A link addressed the way a reader reaches it: by what a screen reader would call it. */
const linkTo = (name: string): string | null =>
  screen.getByRole("link", { name }).getAttribute("href");

describe("VersionTag", () => {
  it("shows the build and points each half of it at GitHub", () => {
    render(<VersionTag release={built(SHA)} />);

    expect(linkTo("The dev release on GitHub")).toBe(
      "https://github.com/dipasqualew/chronie/releases/tag/dev",
    );
    expect(linkTo("Commit 95b5e08 on GitHub")).toBe(
      `https://github.com/dipasqualew/chronie/commit/${SHA}`,
    );
  });

  // What a reader copies into a bug report is the text, not the accessible names above it.
  it("reads as one version on screen", () => {
    render(<VersionTag release={built(SHA)} />);

    expect(screen.getByTitle("Chronie dev#95b5e08").textContent).toBe("dev#95b5e08");
  });

  // A build with nothing to say about its commit still says which channel it is on, and does
  // not offer a link to a commit page that would not resolve.
  it.each<[string, Release | null]>([
    ["a build with no commit behind it", built("")],
    ["a backend that would not say which build this is", null],
  ])("still names the channel for %s", (_what, release) => {
    render(<VersionTag release={release} />);

    expect(linkTo("The dev release on GitHub")).toBe(
      "https://github.com/dipasqualew/chronie/releases/tag/dev",
    );
    expect(screen.queryByRole("link", { name: /^Commit / })).toBeNull();
    expect(screen.getByTitle("Chronie dev").textContent).toBe("dev");
  });
});
