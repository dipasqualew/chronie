/**
 * What the account holds, and — the half no addon can answer — what it does not.
 *
 * The census walks the client's own lists at a logout and writes down every achievement and
 * every mount the account owns. On its own that is a list nobody needs: the game already has a
 * pane for it. What this screen is for is the subtraction against the game's own tables, which
 * needs both an install and a database and is therefore the one question only the desktop app is
 * in a position to ask.
 *
 * Two things about it are load-bearing.
 *
 * **The provenance is drawn before the numbers, always.** Every figure here is a subtraction
 * made against a reading, and a reading that did not finish licenses no subtraction at all — so
 * what the walk claimed about itself is the first thing on the screen rather than a footnote
 * under it. `collection.ts` decides what may be said; this only draws it. That is the same
 * bargain the timeline's gap notice makes, and `docs/account-census.md` argues for it from the
 * addon's end.
 *
 * **The two halves fail separately.** The census is Chronie's own database and answers in a
 * millisecond; the catalogue is the game's storage and costs a second and a few hundred
 * megabytes — and is simply absent on a machine with no install. So they are two reads, the
 * lists draw off the first, and the second failing leaves a screen that says what the account
 * holds without pretending to know what that is out of.
 *
 * The rules are `collection.ts`. This file has none.
 */

import "./collectionView.css";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  ACHIEVEMENTS,
  MOUNTS,
  achievementProgress,
  byCategory,
  byYear,
  carriers,
  caveat,
  missingMounts,
  mountProgress,
  pointsAvailable,
  pointsEarned,
  readingEvidence,
  readingOf,
  readingSentence,
  remaining,
} from "./collection";
import type { CategoryRow, Progress } from "./collection";
import { plural } from "./format";
import type { AccountCensusPayload, CollectionCataloguePayload } from "./types";

/** How many of a category's missing achievements are drawn before the list is cut off. */
const SHOWN = 12;

/** How many mounts are listed at once, for a catalogue with sixteen hundred rows in it. */
const MOUNTS_SHOWN = 60;

export interface CollectionRecourse {
  label: string;
  act: () => void;
}

export interface CollectionViewProps {
  /** What the census walked. `null` while the read is still out. */
  census: AccountCensusPayload | null;
  /** The game's own tables. `null` when there is no install, or the read has not landed. */
  catalogue: CollectionCataloguePayload | null;
  /** Whatever the catalogue read is saying for itself: still reading, or why it would not. */
  catalogueStatus: string;
  /** The one thing a reader can do about that, when there is one. */
  catalogueRecourse: CollectionRecourse | null;
}

type Half = "achievements" | "mounts";

export function CollectionView({
  census,
  catalogue,
  catalogueStatus,
  catalogueRecourse,
}: CollectionViewProps): ReactNode {
  const [half, setHalf] = useState<Half>("achievements");

  const achievements = useMemo(() => achievementProgress(census, catalogue), [census, catalogue]);
  const mounts = useMemo(() => mountProgress(census, catalogue), [census, catalogue]);
  const categories = useMemo(() => byCategory(census, catalogue), [census, catalogue]);
  const cast = useMemo(() => carriers(census, catalogue), [census, catalogue]);
  const years = useMemo(() => byYear(census, catalogue), [census, catalogue]);
  const absent = useMemo(() => missingMounts(census, catalogue), [census, catalogue]);
  const earned = useMemo(() => pointsEarned(census, catalogue), [census, catalogue]);
  const available = useMemo(() => pointsAvailable(catalogue), [catalogue]);

  return (
    <>
      <header className="view-head">
        <h1>Collection</h1>
        <div className="sub" role="status" aria-label="What the collection holds">
          {summary(achievements, mounts)}
        </div>
        {catalogueStatus ? (
          <div className="sub" id="collection-catalogue-status">
            <span>{catalogueStatus}</span>{" "}
            {catalogueRecourse ? (
              <button type="button" onClick={catalogueRecourse.act}>
                {catalogueRecourse.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* Two buttons rather than a select, the same way the transmog browsers are switched:
          there are two of them and both are worth being one click away. */}
      <div className="col-modes" role="group" aria-label="Look at">
        <button
          type="button"
          aria-pressed={half === "achievements"}
          onClick={() => setHalf("achievements")}
        >
          Achievements
        </button>
        <button type="button" aria-pressed={half === "mounts"} onClick={() => setHalf("mounts")}>
          Mounts
        </button>
      </div>

      <section
        className="col-half"
        aria-label="Achievements"
        hidden={half !== "achievements"}
        id="collection-achievements"
      >
        <Reading census={census} domain={ACHIEVEMENTS} progress={achievements} noun="achievement" />
        <Tally progress={achievements} noun="achievement" points={earned} available={available} />

        <section aria-label="Achievements by category">
          <h2>By category</h2>
          {categories.length ? (
            <ul className="col-categories">
              {categories.map((row) => (
                <Category key={row.name} row={row} />
              ))}
            </ul>
          ) : (
            <p className="sub">
              The game&rsquo;s own tables are what say which category an achievement is in, and
              Chronie has not read them.
            </p>
          )}
        </section>

        <section aria-label="Who earned them">
          <h2>Who earned them</h2>
          {/* The question the census pays for: one character&rsquo;s walk attributes the whole
              account&rsquo;s history, so this needs no alt to have been logged in. */}
          {cast.length ? (
            <table className="col-cast">
              <caption className="sub">
                One character&rsquo;s walk reports the whole account, and names who did each.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Character</th>
                  <th scope="col">Earned</th>
                  <th scope="col">Points</th>
                </tr>
              </thead>
              <tbody>
                {cast.map((row) => (
                  <tr key={row.character}>
                    <th scope="row">{row.character}</th>
                    <td>{row.earned.toLocaleString()}</td>
                    <td>{row.points.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sub">Nothing walked so far names the character that earned it.</p>
          )}
        </section>

        <section aria-label="By year">
          <h2>By year</h2>
          {years.length ? (
            <>
              {/* A real timeline rather than a history of what Chronie watched — an achievement
                  earned in 2009 is not a gain anybody saw and is on this list all the same. */}
              <ol className="col-years" aria-label="Achievements earned each year">
                {years.map((row) => (
                  <li key={row.year}>
                    <span className="col-year">{row.year}</span>
                    <span className="col-bar" data-share={share(row.earned, years)} />
                    <span className="col-count">
                      {plural(row.earned, "achievement")} · {row.points.toLocaleString()} points
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="sub">Nothing walked so far carries a date the client would state.</p>
          )}
        </section>
      </section>

      <section
        className="col-half"
        aria-label="Mounts"
        hidden={half !== "mounts"}
        id="collection-mounts"
      >
        <Reading census={census} domain={MOUNTS} progress={mounts} noun="mount" />
        <Tally progress={mounts} noun="mount" points={null} available={null} />

        <section aria-label="Mounts still to get">
          <h2>Still to get</h2>
          {absent.length ? (
            <>
              <p className="sub">
                {plural(absent.length, "mount")} the game has and the account has not, by name
                {absent.length > MOUNTS_SHOWN ? ` — the first ${MOUNTS_SHOWN} of them` : ""}.
              </p>
              <ul className="col-missing" aria-label="Mounts still to get">
                {absent.slice(0, MOUNTS_SHOWN).map((mount) => (
                  <li key={mount.id}>
                    <span className="col-name">{mount.name}</span>
                    {mount.source ? (
                      <span className="sub col-source">{mount.source}</span>
                    ) : (
                      <span className="sub col-source">
                        The game says nothing about where this one comes from.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="sub">
              {catalogue
                ? "Nothing left: every mount the game's table names is already in the census."
                : "The game's own table is what names a mount nobody owns, and Chronie has not read it."}
            </p>
          )}
        </section>
      </section>
    </>
  );
}

/**
 * What the walk claimed about itself, above the numbers taken from it.
 *
 * The sentence is provenance and is drawn whatever it says, unlike the timeline's gap notice: a
 * figure whose provenance appears only when it is bad is a figure nobody learns to check. What
 * is conditional is the hedge under it, and how loudly — see [`Caveat`].
 */
function Reading({
  census,
  domain,
  progress,
  noun,
}: {
  census: AccountCensusPayload | null;
  domain: string;
  progress: Progress;
  noun: string;
}): ReactNode {
  const reading = readingOf(census, domain);
  const hedge = caveat(progress);
  return (
    <div className="col-reading">
      <p className="sub" role="status" aria-label={`How the ${noun} census was read`}>
        {readingSentence(reading)}
      </p>
      {readingEvidence(reading).map((line) => (
        <p className="sub" key={line}>
          {line}
        </p>
      ))}
      {/* An alert only when the number is unsound rather than merely short — see `Caveat`. The
          encrypted rows are true of every install forever, and a red box that never changes is
          how a reader learns to stop reading red boxes. Both answer to the same name. */}
      {hedge ? (
        hedge.grave ? (
          <div className="notice" role="alert" aria-label={`What the ${noun} count is worth`}>
            <p>{hedge.text}</p>
          </div>
        ) : (
          <p className="sub" role="note" aria-label={`What the ${noun} count is worth`}>
            {hedge.text}
          </p>
        )
      ) : null}
    </div>
  );
}

/** The headline: how many, out of how many, and what they are worth. */
function Tally({
  progress,
  noun,
  points,
  available,
}: {
  progress: Progress;
  noun: string;
  points: number | null;
  available: number | null;
}): ReactNode {
  const left = remaining(progress);
  return (
    <dl className="col-tally" aria-label={`How many ${noun}s`}>
      <Figure label="Held">{progress.held.toLocaleString()}</Figure>
      <Figure label="The game has">
        {progress.total == null ? "—" : progress.total.toLocaleString()}
      </Figure>
      <Figure label="Still to get">{left == null ? "—" : left.toLocaleString()}</Figure>
      {points == null ? null : (
        <Figure label="Points">
          {points.toLocaleString()}
          {available == null ? "" : ` of ${available.toLocaleString()}`}
        </Figure>
      )}
    </dl>
  );
}

/**
 * One figure of the tally, under the word for it.
 *
 * The pair is a named group, which is the one thing `<dt>`/`<dd>` cannot do for itself: a
 * definition takes no name of its own, so nothing outside the grid could ask for "still to get"
 * without counting along the row. The same shape the character summary's fact grid uses.
 */
const Figure = ({ label, children }: { label: string; children: ReactNode }): ReactNode => (
  <div role="group" aria-label={label}>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/**
 * One branch of the game's tree, with what is left in it worth the most first.
 *
 * Folded shut, because there are fifteen of these and the biggest holds four hundred rows. A
 * `<details>` rather than a button and a piece of state: it is exactly what the element is for,
 * it is open to a screen reader by name, and the browser keeps it where the reader left it.
 */
function Category({ row }: { row: CategoryRow }): ReactNode {
  const left = row.total - row.held;
  return (
    <li>
      {/* Named, and the summary titled: a `<details>` takes its name from nothing a reader can
          rely on and a `<summary>` carries no role at all, so the branch has to say which one it
          is and the handle has to say what opening it would do. */}
      <details aria-label={row.name}>
        <summary title={`What is left in ${row.name}`}>
          <span className="col-name">{row.name}</span>
          <span className="sub">
            {row.held.toLocaleString()} of {row.total.toLocaleString()} ·{" "}
            {row.points.toLocaleString()} of {row.pointsTotal.toLocaleString()} points
          </span>
        </summary>
        {row.missing.length ? (
          <ul className="col-missing" aria-label={`${row.name} still to earn`}>
            {row.missing.slice(0, SHOWN).map((found) => (
              <li key={found.id}>
                <span className="col-points">{found.points}</span>
                <span className="col-name">{found.title}</span>
                <span className="sub col-source">
                  {found.under}
                  {found.description ? ` — ${found.description}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub">Nothing left in this one.</p>
        )}
        {left > SHOWN ? (
          <p className="sub">
            …and {(left - SHOWN).toLocaleString()} more, each worth the same or less.
          </p>
        ) : null}
      </details>
    </li>
  );
}

function summary(achievements: Progress, mounts: Progress): string {
  const parts = [tally(achievements, "achievement"), tally(mounts, "mount")];
  return parts.join(" · ");
}

function tally(progress: Progress, noun: string): string {
  if (progress.total == null) return plural(progress.held, noun);
  return `${progress.held.toLocaleString()} of ${progress.total.toLocaleString()} ${noun}s`;
}

/**
 * How long a year's bar is, as a tenth rather than a percentage.
 *
 * A `data-` attribute and not a `style` prop: the packaged app stamps a nonce onto `style-src`
 * and an inline attribute can never carry one, so nothing this app draws may be styled from a
 * prop. `collectionView.css` is where the eleven widths are.
 */
function share(earned: number, years: { earned: number }[]): string {
  const most = Math.max(...years.map((year) => year.earned), 1);
  return String(Math.round((earned / most) * 10));
}
