/**
 * The characters view: the roster down the left, one character on the right.
 *
 * The timeline asks "what happened", the ledger asks "which segment"; this one asks "who". A
 * history is nearly always several characters deep and every other view cuts across them — an
 * evening holds three of them, a table row belongs to one and says nothing about the rest of
 * that character's year. This is the one place a character is the subject.
 *
 * The roster stays beside its character rather than above them: picking somebody is a thing a
 * reader does repeatedly.
 *
 * **The pane behind it is two pages rather than one**, and that is what this file mostly is. A
 * character carries two entirely different kinds of fact and they were interleaved: a wallet, a
 * reputation and a wardrobe are standing balances that are true whenever you ask, and an
 * evening's achievements are dated. Reading them down one column meant scrolling past a
 * fortnight of segments to find out how much Honor somebody had, and meant that the one control
 * the dated half wants — a time range — had nothing to sit over. So Summary is what they are,
 * Activity is what they have been doing, and each is drawn by a file of its own.
 *
 * What sits above both is the portrait, because it belongs to neither and to both: it is who
 * they are before it is anything else.
 */

import "./charactersView.css";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { CharacterActivity } from "./characterActivity";
import { DEFAULT_RANGE } from "./characterRange";
import { CharacterFigure } from "./characterFigure";
import { CharacterSummary } from "./characterSummary";
import type { CharacterProfile } from "./characters";
import type { CurrencyIcons } from "./currencies";
import type { FactionIcons } from "./reputations";
import { ago, duration, initials, plural } from "./format";
import { setsFor } from "./inGameSets";
import type { ItemBook } from "./items";
import type { PlaceIcons } from "./places";
import { classProps, className } from "./ui";
import type { OpenSegment } from "./ui";
import type {
  CharacterWornSetPayload,
  InGameSet,
  InGameSetAppearancesPayload,
  InGameSetsPayload,
  WornPiece,
} from "./types";

/** The two pages the pane holds, in the order a reader meets them. */
const PAGES = ["summary", "activity"] as const;
type Page = (typeof PAGES)[number];

const PAGE_LABELS: Record<Page, string> = {
  summary: "Summary",
  activity: "Activity",
};

export interface CharactersProps {
  profiles: CharacterProfile[];
  onOpenSegment: OpenSegment;
  /** What the game says about an item, for the gains that unfold into transmog. */
  items: ItemBook;
  /** The pictures the game draws each currency with. */
  currencyIcons: CurrencyIcons;
  factionIcons?: FactionIcons;
  /** The pictures the game draws a place with, for the segment rows on a character's page. */
  places?: PlaceIcons;
  /**
   * The transmog sets every character saved in the game, or null until they have been read.
   *
   * Passed down whole rather than per character, because that is the shape the backend answers
   * in and because the three-way distinction it carries — never read, read and empty, read and
   * full — is one this view says out loud. See `inGameSets.ts`.
   */
  inGameSets: InGameSetsPayload | null;
  /** What one of those sets turns out to be, for the portrait to dress the character in. */
  loadSetAppearances: (appearanceIds: number[]) => Promise<InGameSetAppearancesPayload>;
  /** And the character themselves wearing it, on their own body. */
  loadWorn: (character: string, pieces: WornPiece[]) => Promise<CharacterWornSetPayload>;
}

export function Characters({
  profiles,
  onOpenSegment,
  items,
  currencyIcons,
  factionIcons,
  places,
  inGameSets,
  loadSetAppearances,
  loadWorn,
}: CharactersProps): ReactNode {
  // Held by name rather than by index: an activity edit repaints the whole view, and the
  // reader should come back to the character they were reading, wherever they have moved to
  // in the roster since.
  const [chosen, setChosen] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("summary");
  // The range outlives the character, which is deliberate: a reader comparing two alts over the
  // last fortnight is asking one question about both, and re-choosing it per person would be
  // asking them to say it twice.
  const [range, setRange] = useState<string>(DEFAULT_RANGE);

  // Fixed for as long as the view is mounted, so every range on the page is reckoned from one
  // moment. A `Date.now()` read during the render would move under a reader between two draws
  // and quietly change which segments a fortnight holds.
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);

  const showing = profiles.find((entry) => entry.name === chosen) ?? profiles[0];

  const pick = (name: string): void => {
    if (name === showing?.name) return;
    setChosen(name);
  };

  return (
    <div className="roster">
      <nav className="panel roster-panel" id="characters-list" aria-label="Character roster">
        {profiles.length ? (
          <ul className="roster-list">
            {profiles.map((entry) => (
              <li key={entry.name}>
                <RosterEntry
                  entry={entry}
                  chosen={entry.name === showing?.name}
                  onPick={() => pick(entry.name)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No characters yet. Play for a bit and Chronie will fill this in.</p>
        )}
      </nav>
      <section
        className="panel roster-detail"
        id="character-detail"
        aria-live="polite"
        aria-label="The character"
      >
        {showing ? (
          <Profile
            entry={showing}
            page={page}
            onPage={setPage}
            range={range}
            onRange={setRange}
            now={now}
            items={items}
            currencyIcons={currencyIcons}
            factionIcons={factionIcons}
            places={places}
            wardrobe={setsFor(inGameSets, showing.name)}
            loadSetAppearances={loadSetAppearances}
            loadWorn={loadWorn}
            onOpenSegment={onOpenSegment}
          />
        ) : (
          <p className="empty">Nothing to show until a character has been played.</p>
        )}
      </section>
    </div>
  );
}

/**
 * One character in the roster: the class circle, who they are, and the numbers worth reading
 * without opening them.
 *
 * The circle is decorative here, unlike the one on a session card — the row spells the name
 * out beside it, and a focusable thing inside a button is a thing a keyboard cannot reach
 * past. The whole entry is the button instead, named with everything the eye gets.
 */
function RosterEntry({
  entry,
  chosen,
  onPick,
}: {
  entry: CharacterProfile;
  chosen: boolean;
  onPick: () => void;
}): ReactNode {
  const facts = [
    `${className(entry.classFile)}${entry.level == null ? "" : ` · level ${entry.level}`}`,
    `${duration(entry.seconds)} played`,
    plural(entry.segmentCount, "segment"),
    `last played ${ago(entry.lastSeen)}`,
  ];
  return (
    <button
      type="button"
      className="roster-entry"
      {...classProps(entry.classFile)}
      aria-pressed={chosen}
      aria-label={`${entry.name}, ${facts.join(", ")}`}
      onClick={onPick}
    >
      <span className="circle" aria-hidden="true">
        {initials(entry.name)}
      </span>
      <span className="roster-who">
        <span className="roster-name">{entry.name}</span>
        <span className="roster-class muted">{facts[0]}</span>
      </span>
      <span className="roster-numbers">
        <span className="roster-played">{duration(entry.seconds)}</span>
        <span className="muted">{plural(entry.segmentCount, "segment")}</span>
      </span>
    </button>
  );
}

interface ProfileProps {
  entry: CharacterProfile;
  page: Page;
  onPage: (page: Page) => void;
  range: string;
  onRange: (key: string) => void;
  now: number;
  items: ItemBook;
  currencyIcons: CurrencyIcons;
  factionIcons?: FactionIcons;
  /** The pictures the game draws a place with, for the segment rows on a character's page. */
  places?: PlaceIcons;
  /** What this character has saved in game, or null when Chronie has never read their wardrobe. */
  wardrobe: InGameSet[] | null;
  loadSetAppearances: (appearanceIds: number[]) => Promise<InGameSetAppearancesPayload>;
  loadWorn: (character: string, pieces: WornPiece[]) => Promise<CharacterWornSetPayload>;
  onOpenSegment: OpenSegment;
}

/**
 * The chosen character: who they are, and then whichever of the two pages is open.
 *
 * The pages are tabs rather than two panels down one column, and rather than a router. Both
 * halves are long, only one is being read, and neither is somewhere a reader should have to
 * arrive at by scrolling — the same argument the window's own view tabs make one level up.
 *
 * **The portrait stands beside the facts rather than above them** (#222). Across the top it was a
 * wide, shallow band — the one shape a standing person fits worst — and it pushed the tabs and
 * everything under them down the page by its whole height. Down the side it is as tall as the
 * pane allows, which is what a portrait wants, and it stays put while a reader moves between
 * Summary and Activity: the picture is who they are, and neither page stops that being true.
 */
function Profile({
  entry,
  page,
  onPage,
  range,
  onRange,
  now,
  items,
  currencyIcons,
  factionIcons,
  places,
  wardrobe,
  loadSetAppearances,
  loadWorn,
  onOpenSegment,
}: ProfileProps): ReactNode {
  return (
    <div className="profile">
      <div className="profile-facts">
        <header className="profile-head" {...classProps(entry.classFile)}>
          <span className="circle" aria-hidden="true">
            {initials(entry.name)}
          </span>
          <div>
            <h2>{entry.name}</h2>
            <p className="sub">
              {className(entry.classFile)}
              {entry.level == null ? "" : ` · level ${entry.level}`}
              {` · last played ${ago(entry.lastSeen)}`}
            </p>
          </div>
        </header>

        {/* Named for what it switches rather than for what it is: a screen reader arriving here is
          told these are the two halves of this character, which is the whole of the idea. */}
        <div
          className="profile-pages"
          role="tablist"
          aria-label="What to show about this character"
        >
          {PAGES.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`character-${name}-tab`}
              className={name === page ? "primary" : undefined}
              aria-selected={name === page}
              aria-controls={`character-${name}-page`}
              onClick={() => onPage(name)}
            >
              {PAGE_LABELS[name]}
            </button>
          ))}
        </div>

        <div
          className="profile-page"
          role="tabpanel"
          id={`character-${page}-page`}
          aria-labelledby={`character-${page}-tab`}
        >
          {page === "summary" ? (
            <CharacterSummary
              entry={entry}
              wardrobe={wardrobe}
              currencyIcons={currencyIcons}
              factionIcons={factionIcons}
            />
          ) : (
            <CharacterActivity
              entry={entry}
              range={range}
              onRange={onRange}
              now={now}
              items={items}
              places={places}
              onOpenSegment={onOpenSegment}
            />
          )}
        </div>
      </div>

      <CharacterFigure
        // Keyed by the character, so moving to somebody else starts a fresh portrait rather than
        // leaving the last one's body on screen while the next is being dressed.
        key={entry.name}
        character={entry.name}
        sets={wardrobe}
        loadAppearances={loadSetAppearances}
        loadWorn={loadWorn}
      />
    </div>
  );
}
