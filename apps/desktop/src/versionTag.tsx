/**
 * Which build this is, in the corner of the app bar.
 *
 * Small, quiet and on every screen, because the question it answers is never the one somebody
 * came here to ask — it is the one asked afterwards, by a person writing down what went wrong or
 * wondering whether the thing they read about is in front of them yet. A version behind a menu is
 * a version nobody quotes.
 *
 * Two links rather than one, because they go to two different places and both are worth reaching:
 * the channel to the release the installer came from, the commit to the code itself. Neither says
 * anything on its own to a screen reader — "dev" and seven hex characters — so each carries the
 * whole sentence as its accessible name and shows the short form.
 */

import type { ReactNode } from "react";

import { describeVersion } from "./version";
import type { Release } from "./types";

export interface VersionTagProps {
  /** The build, or nothing when the window could not ask the backend which one it is running. */
  release: Release | null;
}

export function VersionTag({ release }: VersionTagProps): ReactNode {
  const version = describeVersion(release);
  return (
    <span className="version" id="app-version" title={`Chronie ${version.label}`}>
      <a href={version.channelUrl} aria-label={`The ${version.channel} release on GitHub`}>
        {version.channel}
      </a>
      {version.commit && version.commitUrl && (
        <>
          <span aria-hidden="true">#</span>
          <a href={version.commitUrl} aria-label={`Commit ${version.commit} on GitHub`}>
            {version.commit}
          </a>
        </>
      )}
    </span>
  );
}
