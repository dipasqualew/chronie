/**
 * The characters view: the roster down the left, one character's whole history on the right.
 *
 * The timeline asks "what happened", the ledger asks "which segment"; this one asks "who". A
 * history is nearly always several characters deep and every other view cuts across them — an
 * evening holds three of them, a table row belongs to one and says nothing about the rest of
 * that character's year. This is the one place a character is the subject.
 *
 * The roster stays beside its character rather than above them: picking somebody is a thing a
 * reader does repeatedly. Those segments are drawn with the same row the timeline unfolds into
 * and open the same detail modal every other view opens, so a segment reads identically
 * wherever it is met.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import { byDay, dayOf } from "./characters";
import type { CharacterGold, CharacterProfile } from "./characters";
import { ago, dayLabel, duration, gold, initials, plural, signedGold } from "./format";
import {
  HighlightList, SegmentButton, StandingBar, classProps, className, shownHighlights,
} from "./ui";
import type { OpenSegment } from "./ui";

/** Only one summary is ever unfolded here, so its panels need only one namespace. */
const SCOPE = "character";

export interface CharactersProps {
  profiles: CharacterProfile[];
  onOpenSegment: OpenSegment;
}

export function Characters({ profiles, onOpenSegment }: CharactersProps): ReactNode {
  // Held by name rather than by index: an activity edit repaints the whole view, and the
  // reader should come back to the character they were reading, wherever they have moved to
  // in the roster since.
  const [chosen, setChosen] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<string | null>(null);

  const showing = profiles.find((entry) => entry.name === chosen) ?? profiles[0];

  const pick = (name: string): void => {
    if (name === showing?.name) return;
    setChosen(name);
    // A summary unfolded on one character means nothing on the next, so picking somebody else
    // starts them folded rather than opening a panel nobody asked for.
    setUnfolded(null);
  };

  return (
    <div className="roster">
      <nav className="panel roster-panel" id="characters-list" aria-label="Character roster">
        {profiles.length
          ? <ul className="roster-list">
            {profiles.map((entry) => (
              <li key={entry.name}>
                <RosterEntry
                  entry={entry} chosen={entry.name === showing?.name}
                  onPick={() => pick(entry.name)}
                />
              </li>
            ))}
          </ul>
          : <p className="empty">No characters yet. Play for a bit and Chronie will fill this in.</p>}
      </nav>
      <section className="panel roster-detail" id="character-detail" aria-live="polite">
        {showing
          ? <Profile
            entry={showing} unfolded={unfolded}
            onUnfold={(kind) => setUnfolded((open) => (open === kind ? null : kind))}
            // A summary chip, one of the things it unfolded into, and a segment row all open
            // the modal, and all three walk this character's own segments.
            onOpenSegment={(segmentId) => onOpenSegment(segmentId, showing.segments)}
          />
          : <p className="empty">Nothing to show until a character has been played.</p>}
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
function RosterEntry(
  { entry, chosen, onPick }: { entry: CharacterProfile; chosen: boolean; onPick: () => void },
): ReactNode {
  const facts = [
    `${className(entry.classFile)}${entry.level == null ? "" : ` · level ${entry.level}`}`,
    `${duration(entry.seconds)} played`,
    plural(entry.segmentCount, "segment"),
    `last played ${ago(entry.lastSeen)}`,
  ];
  return (
    <button
      type="button" className="roster-entry" {...classProps(entry.classFile)}
      aria-pressed={chosen} aria-label={`${entry.name}, ${facts.join(", ")}`} onClick={onPick}
    >
      <span className="circle" aria-hidden="true">{initials(entry.name)}</span>
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

/** One row of the fact grid: dropped entirely rather than drawn as a dash when unknown. */
const Stat = ({ label, children }: { label: string; children: ReactNode }): ReactNode =>
  <div><dt>{label}</dt><dd>{children}</dd></div>;

interface ProfileProps {
  entry: CharacterProfile;
  unfolded: string | null;
  onUnfold: (kind: string) => void;
  onOpenSegment: (segmentId: number) => void;
}

/** Everything known about the chosen character, and everything they did. */
function Profile({ entry, unfolded, onUnfold, onOpenSegment }: ProfileProps): ReactNode {
  const where = entry.places.slice(0, 3).join(", ");
  return <>
    <header className="profile-head" {...classProps(entry.classFile)}>
      <span className="circle" aria-hidden="true">{initials(entry.name)}</span>
      <div>
        <h2>{entry.name}</h2>
        <p className="sub">
          {className(entry.classFile)}{entry.level == null ? "" : ` · level ${entry.level}`}
          {` · last played ${ago(entry.lastSeen)}`}
        </p>
      </div>
    </header>
    <dl className="profile-stats">
      <Stat label="Played">{duration(entry.seconds)}</Stat>
      <Stat label="Segments">{entry.segmentCount}</Stat>
      <Stat label="Days">{entry.dayCount}</Stat>
      <Stat label="First seen">{dayLabel(dayOf(entry.firstSeen))}</Stat>
      <Stat label="Looted"><span className="gold">{gold(entry.lootValue)}</span></Stat>
      {/* The balance and the movement, in that order and never conflated: what the character
          is carrying now is state the addon read off the client, where the net is the sum of
          what every recorded segment did to it and knows nothing of the gold that was there
          first. The balance is dropped rather than guessed on a character that has not
          reported one. */}
      {entry.gold ? <Stat label="Wallet"><span className="gold">{gold(entry.gold.total)}</span></Stat> : null}
      <Stat label="Net">
        <span className={entry.goldDiff < 0 ? "loss" : "gold"}>{signedGold(entry.goldDiff)}</span>
      </Stat>
    </dl>
    {entry.gold ? <AccountWorth held={entry.gold} /> : null}
    {where ? <p className="profile-where sub">Mostly in {where}</p> : null}
    <div className="profile-highlights">
      {shownHighlights(entry.highlights).length
        ? <HighlightList
          entries={entry.highlights} scope={SCOPE} expanded={unfolded}
          onUnfold={onUnfold} onOpenSegment={onOpenSegment}
        />
        : <p className="muted">Nothing gained or collected yet.</p>}
    </div>
    <Currencies entry={entry} />
    <Factions entry={entry} />
    <section className="detail-section profile-segments">
      <h3>{plural(entry.segmentCount, "segment")}</h3>
      {byDay(entry.segments).map((group) => (
        <section className="profile-day" key={group.day}>
          <h4>{dayLabel(group.day)}</h4>
          <ol className="segment-rows">
            {group.segments.map((segment) => (
              <li key={segment.segmentId}>
                <SegmentButton segment={segment} onOpen={() => onOpenSegment(segment.segmentId)} />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </section>
  </>;
}

/**
 * What the account is worth in gold, under the wallet it belongs to.
 *
 * Only drawn when it says something the wallet above does not — a lone character with an empty
 * warband bank is worth exactly what is in its pocket. The pot is named separately from the
 * wallets because it answers a different question: not what the roster is sitting on, but what
 * any one of them can reach from a bank.
 */
function AccountWorth({ held }: { held: CharacterGold }): ReactNode {
  if (held.accountTotal === held.total) return null;
  const pot = held.warband ? ` · ${gold(held.warband)} in the warband bank` : "";
  const eldest = held.oldest ? ` · eldest read ${ago(held.oldest)}` : "";
  return (
    <p className="profile-where sub">
      <span className="account-total">{gold(held.accountTotal)} across the account</span>{pot}{eldest}
    </p>
  );
}

/**
 * What the character is carrying, against what the account has altogether.
 *
 * The account total is only worth saying when somebody else holds some too: on a currency only
 * this character has ever picked up, it is the number already on the line.
 *
 * A warband currency needs saying for the opposite reason. Its two numbers always match, so
 * the comparison below has nothing to add — and the balance on the line is not this
 * character's holding at all but the account's one pot, read from here. Left unlabelled it
 * would read as a coincidence rather than as the same money the alt beside it is looking at.
 */
function Currencies({ entry }: { entry: CharacterProfile }): ReactNode {
  if (!entry.currencies.length) return null;
  return (
    <section className="detail-section">
      <h3>Currencies</h3>
      <ul>
        {entry.currencies.map((held) => {
          const elsewhere = held.accountWide
            ? " · shared across the warband"
            : held.accountTotal > held.total
              ? ` · ${held.accountTotal.toLocaleString()} across the account`
              : "";
          const read = held.at ? ` · read ${ago(held.at)}` : "";
          return (
            <li key={held.id}>
              🪙 {held.name} <strong>{held.total.toLocaleString()}</strong>
              {" "}<span className="muted">{elsewhere + read}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Where the character stands with everyone they have met, and where they lead the account. */
function Factions({ entry }: { entry: CharacterProfile }): ReactNode {
  if (!entry.factions.length) return null;
  return (
    <section className="detail-section">
      <h3>Reputation</h3>
      <ul>
        {entry.factions.map((standing) => (
          <li key={standing.faction}>
            🎖️ {standing.faction}
            {standing.leads ? <> <span className="chip">furthest on the account</span></> : null}
            <StandingBar standing={standing} faction={standing.faction} />
          </li>
        ))}
      </ul>
    </section>
  );
}
