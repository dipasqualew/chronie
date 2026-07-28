/**
 * What build this is, said in the one way that means anything yet.
 *
 * There is no version number to show. `tauri.conf.json` carries a `0.1.<run number>` and it exists
 * for the updater's benefit — it is how one build compares itself to another — not for anybody
 * reading it. Every build is the same rolling `dev` release, and the only thing that distinguishes
 * two of them is the commit they were cut from. So that is the version: `dev#95b5e08`, the channel
 * and the commit, and both halves are somewhere a person can actually go and look.
 *
 * That is the whole reason this is a module rather than a template in the app bar. A version
 * nobody can follow is decoration; a bug report that names one is worth having, and it is worth
 * having only if the reader can get from what is on their screen to the code that is in front of
 * them. So the channel addresses the release its installer was uploaded to, and the commit
 * addresses the commit — the full forty characters, whatever is shown of them.
 *
 * A build with no commit behind it is a real case rather than a defensive one: a source tarball
 * has no git under it, and neither does a checkout with the tooling missing. It reports its
 * channel, links to the release, and does not pretend to a commit it cannot name.
 */

import type { Release } from "./types";

/** The repository every build of this comes out of, and everything below is addressed within. */
export const REPOSITORY = "https://github.com/dipasqualew/chronie";

/** The channel a release with nothing to say about itself is assumed to be on. */
const DEFAULT_CHANNEL = "dev";

/**
 * How much of a commit is put on screen. GitHub's own abbreviation, and the length at which two
 * commits in one repository still differ — the link carries all forty either way.
 */
const SHOWN = 7;

/** A full commit as git writes one, which is the only thing GitHub will resolve as a link. */
const COMMIT = /^[0-9a-f]{40}$/i;

/** A build, as the app bar draws it: what to show, and where each half of it goes. */
export interface Version {
  /** The whole of it in one string — `dev#95b5e08` — for a title, a report, a copy and paste. */
  label: string;
  channel: string;
  /** The release the channel's installer was uploaded to. Always somewhere; the tag is rolling. */
  channelUrl: string;
  /** The commit, abbreviated for reading, or null when this build cannot name one. */
  commit: string | null;
  /** Where that commit is, in full, or null alongside a commit there is none of. */
  commitUrl: string | null;
}

/** Whether a commit is one GitHub could be asked about, rather than a blank or an error message. */
const nameable = (commit: string): boolean => COMMIT.test(commit);

/** How a build says which build it is: the channel, and the commit when it has one. */
export function describeVersion(release: Release | null | undefined): Version {
  const channel = release?.channel.trim() || DEFAULT_CHANNEL;
  const commit = release?.commit.trim() ?? "";
  const known = nameable(commit);
  return {
    label: known ? `${channel}#${commit.slice(0, SHOWN)}` : channel,
    channel,
    channelUrl: `${REPOSITORY}/releases/tag/${encodeURIComponent(channel)}`,
    commit: known ? commit.slice(0, SHOWN) : null,
    commitUrl: known ? `${REPOSITORY}/commit/${commit}` : null,
  };
}
