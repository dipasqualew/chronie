import { describe, expect, it } from "vitest";
import { describeVersion, REPOSITORY } from "./version";
import type { Release } from "./types";

/** A build as the backend describes one. */
const built = (commit: string, channel = "dev"): Release => ({ channel, commit });

const SHA = "95b5e08d2f1a4c3b6e7d8a9f0b1c2d3e4f5a6b7c";

describe("describeVersion", () => {
  it("names a build by its channel and the commit it was cut from", () => {
    expect(describeVersion(built(SHA)).label).toBe("dev#95b5e08");
  });

  // The whole point of showing it: a version somebody can follow back to the code. The commit
  // goes in full because seven characters is a thing to read, not a thing GitHub resolves.
  it("addresses the commit in full and the release by its tag", () => {
    const version = describeVersion(built(SHA));

    expect(version.commit).toBe("95b5e08");
    expect(version.commitUrl).toBe(`${REPOSITORY}/commit/${SHA}`);
    expect(version.channelUrl).toBe(`${REPOSITORY}/releases/tag/dev`);
  });

  it("takes the channel from the build rather than assuming the rolling one", () => {
    const version = describeVersion(built(SHA, "stable"));

    expect(version.label).toBe("stable#95b5e08");
    expect(version.channelUrl).toBe(`${REPOSITORY}/releases/tag/stable`);
  });

  // A build from a source tarball, or from a checkout with no git behind it. It is still on a
  // channel and that release still exists, so the half that can be linked is linked and the
  // half that cannot is absent rather than a link to a commit page that would 404.
  it.each<[string, string]>([
    ["a build with no commit at all", ""],
    ["whitespace where a commit should be", "   "],
    ["something that is not a commit", "unknown"],
    ["an abbreviation git wrote and GitHub would not resolve", "95b5e08"],
  ])("says what it can about %s", (_what, commit) => {
    const version = describeVersion(built(commit));

    expect(version.label).toBe("dev");
    expect(version.commit).toBeNull();
    expect(version.commitUrl).toBeNull();
    expect(version.channelUrl).toBe(`${REPOSITORY}/releases/tag/dev`);
  });

  // The window asks the backend which build it is and forgives the question failing, so this is
  // reachable: the app bar still has to draw something, and "dev" is what is true regardless.
  it.each<[string, Release | null | undefined]>([
    ["a backend that would not say", null],
    ["nothing asked at all", undefined],
  ])("falls back to the rolling channel for %s", (_what, release) => {
    const version = describeVersion(release);

    expect(version.label).toBe("dev");
    expect(version.channelUrl).toBe(`${REPOSITORY}/releases/tag/dev`);
  });

  // The backend hands over what git printed, and git's output arrives with its newline on it.
  it("ignores the whitespace a commit read off a command arrives with", () => {
    expect(describeVersion(built(` ${SHA}\n`)).commitUrl).toBe(`${REPOSITORY}/commit/${SHA}`);
  });

  // A channel is a git tag and goes into a path. Nothing puts one there but the backend today,
  // and that is exactly the kind of thing that stops being true quietly.
  it("escapes a channel that would otherwise reshape the url", () => {
    expect(describeVersion(built(SHA, "release/1.0")).channelUrl)
      .toBe(`${REPOSITORY}/releases/tag/release%2F1.0`);
  });
});
