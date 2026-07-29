/**
 * What a character *is*, as opposed to what they have been doing.
 *
 * The whole of the split this section is one half of: everything here is a standing balance —
 * hours played, a wallet, a currency, a reputation, a wardrobe — and every one of them is true
 * as of the last time the addon looked, whatever the character did to get there. The activity
 * section beside it is the other kind of fact entirely, and mixing the two is what the page used
 * to do: a reader looking for "how much Honor have I got" was scrolling past an evening's
 * achievements to find it.
 *
 * **Currencies and reputations are tables here rather than lists**, which is the one visible
 * change worth arguing. They were lines of prose — "🪙 Glass Token 17,550 · 30,000 across the
 * account · read 3 days ago" — and prose is the wrong shape for them: every one of those lines
 * says exactly the same four things about a different thing, and the eye reading eight of them
 * wants to compare the third number down the column rather than parse the sentence again. A
 * currency also arrives with a picture the game draws it with, which is how a player recognises
 * one, and a picture has nowhere to go in a sentence.
 */

import "./characterSummary.css";

import { useEffect, useReducer } from "react";
import type { ReactNode } from "react";

import { dayOf } from "./characters";
import type { CharacterFaction, CharacterGold, CharacterProfile } from "./characters";
import type { CurrencyIcons } from "./currencies";
import { ago, dayLabel, duration, gold, signedGold } from "./format";
import { setLabel, setSummary, wardrobeSummary } from "./inGameSets";
import { StandingBar } from "./ui";
import type { InGameSet } from "./types";

export interface CharacterSummaryProps {
  entry: CharacterProfile;
  /** What this character has saved in game, or null where Chronie has never read a wardrobe. */
  wardrobe: InGameSet[] | null;
  /** The pictures the game draws their currencies with. */
  currencyIcons: CurrencyIcons;
}

export function CharacterSummary({
  entry,
  wardrobe,
  currencyIcons,
}: CharacterSummaryProps): ReactNode {
  const where = entry.places.slice(0, 3).join(", ");
  return (
    <>
      <dl className="profile-stats">
        <Stat label="Played">{duration(entry.seconds)}</Stat>
        <Stat label="Segments">{entry.segmentCount}</Stat>
        <Stat label="Days">{entry.dayCount}</Stat>
        <Stat label="First seen">{dayLabel(dayOf(entry.firstSeen))}</Stat>
        <Stat label="Looted">
          <span className="gold">{gold(entry.lootValue)}</span>
        </Stat>
        {/* The balance and the movement, in that order and never conflated: what the character
          is carrying now is state the addon read off the client, where the net is the sum of
          what every recorded segment did to it and knows nothing of the gold that was there
          first. The balance is dropped rather than guessed on a character that has not
          reported one. */}
        {entry.gold ? (
          <Stat label="Wallet">
            <span className="gold">{gold(entry.gold.total)}</span>
          </Stat>
        ) : null}
        <Stat label="Net">
          <span className={entry.goldDiff < 0 ? "loss" : "gold"}>{signedGold(entry.goldDiff)}</span>
        </Stat>
      </dl>
      {entry.gold ? <AccountWorth held={entry.gold} /> : null}
      {where ? <p className="profile-where sub">Mostly in {where}</p> : null}
      <Currencies entry={entry} icons={currencyIcons} />
      <Factions entry={entry} />
      <Wardrobe sets={wardrobe} />
    </>
  );
}

/**
 * One row of the fact grid: dropped entirely rather than drawn as a dash when unknown.
 *
 * The pair is a named group, which is the one thing `<dt>`/`<dd>` cannot do for itself: a
 * definition takes no name of its own, so nothing outside the grid can ask for "the played
 * figure" without counting from one end of it.
 */
const Stat = ({ label, children }: { label: string; children: ReactNode }): ReactNode => (
  <div role="group" aria-label={label}>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

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
      <span className="account-total">{gold(held.accountTotal)} across the account</span>
      {pot}
      {eldest}
    </p>
  );
}

/**
 * What the character is carrying, against what the account has altogether.
 *
 * The account column is only worth filling in when somebody else holds some too: on a currency
 * only this character has ever picked up, it is the number already on the line.
 *
 * A warband currency needs saying for the opposite reason. Its two numbers always match, so the
 * comparison has nothing to add — and the balance on the row is not this character's holding at
 * all but the account's one pot, read from here. Left unlabelled it would read as a coincidence
 * rather than as the same money the alt beside it is looking at.
 *
 * The picture is the game's own, fetched by id and drawn beside the name rather than instead of
 * it. It is decoration in the strict sense — the row says everything without it — which is why
 * a currency the game draws nothing for is a row with a blank in that column rather than a row
 * that waits for something.
 */
function Currencies({
  entry,
  icons,
}: {
  entry: CharacterProfile;
  icons: CurrencyIcons;
}): ReactNode {
  // The book is a cache outside React, so a picture landing changes nothing React would notice.
  // This is what turns an arrival into a redraw, and it asks for the whole table at once rather
  // than a row at a time — the rows would each ask for themselves anyway.
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const wanted = entry.currencies.map((held) => held.id).join(",");
  useEffect(
    () => icons.learn(wanted ? wanted.split(",").map(Number) : [], redraw),
    [icons, wanted],
  );

  if (!entry.currencies.length) return null;
  return (
    <section className="detail-section">
      <h3>Currencies</h3>
      <table className="holdings" aria-label="Currencies">
        <thead>
          <tr>
            <th scope="col">Currency</th>
            <th scope="col" className="number">
              Held
            </th>
            <th scope="col" className="number">
              Account
            </th>
            <th scope="col">Read</th>
          </tr>
        </thead>
        <tbody>
          {entry.currencies.map((held) => {
            const picture = icons.icon(held.id);
            return (
              <tr key={held.id}>
                <th scope="row">
                  <span className="holding-icon" aria-hidden="true">
                    {picture ? <img src={picture} alt="" /> : null}
                  </span>
                  {held.name}
                  {held.accountWide ? (
                    <span className="chip">shared across the warband</span>
                  ) : null}
                </th>
                <td className="number">{held.total.toLocaleString()}</td>
                <td className="number muted">
                  {held.accountWide || held.accountTotal <= held.total
                    ? ""
                    : held.accountTotal.toLocaleString()}
                </td>
                <td className="muted">{held.at ? ago(held.at) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Where the character stands with everyone they have met, and where the account stands.
 *
 * The account's own furthest is a column rather than a badge, which is the change worth stating.
 * A reputation is grind a warband only really does once — the mount is bought on whoever earned
 * it and the tabard is account-wide — so the question a reader has in front of a faction is
 * rarely "how far am I" and nearly always "how far are *we*, and is it me". A chip reading
 * "furthest on the account" answered half of that on the characters who happened to be leading
 * and said nothing at all on the ones who were not.
 */
function Factions({ entry }: { entry: CharacterProfile }): ReactNode {
  if (!entry.factions.length) return null;
  return (
    <section className="detail-section">
      <h3>Reputation</h3>
      <table className="holdings" aria-label="Reputation">
        <thead>
          <tr>
            <th scope="col">Faction</th>
            <th scope="col">Standing</th>
            <th scope="col">Furthest on the account</th>
          </tr>
        </thead>
        <tbody>
          {entry.factions.map((standing) => (
            <tr key={standing.faction}>
              <th scope="row">{standing.faction}</th>
              <td>
                <StandingBar standing={standing} faction={standing.faction} />
              </td>
              <td className="muted">{leaderOf(standing)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Who on the account has got furthest with a faction, as one phrase.
 *
 * "This character" rather than their name where they are the one in front: the name is the
 * heading of the page the row is on, and repeating it in a column headed "furthest on the
 * account" would read as though somebody else happened to share it.
 */
function leaderOf(standing: CharacterFaction): string {
  if (standing.leads) return `This character${standing.standing ? ` · ${standing.standing}` : ""}`;
  const best = standing.best;
  if (!best) return "";
  return [best.character, best.standing].filter(Boolean).join(" · ");
}

/**
 * The transmog sets this character saved in the game itself.
 *
 * Named and counted here and opened nowhere: what a set is *made of* costs four walks of the
 * game's own tables and a graphics context to show. The portrait at the top of the page is
 * wearing one of them, which is as much of "what have they got" as this page owes anybody — the
 * transmog view is where a set is taken apart.
 *
 * Always drawn, even for a character that has saved none, because "none" is an answer somebody
 * came here for and a silently absent section is not. The one case that stays quiet is the
 * character Chronie has never read a wardrobe on, which is a question this app has not asked
 * rather than one the game answered.
 */
function Wardrobe({ sets }: { sets: InGameSet[] | null }): ReactNode {
  if (!sets) return null;
  return (
    <section className="detail-section profile-wardrobe">
      <h3>Transmog sets</h3>
      <p className="sub">{wardrobeSummary(sets)}</p>
      <ul className="profile-sets">
        {sets.map((set) => (
          <li key={set.id}>
            <span className="mog-name">{setLabel(set)}</span>
            <span className="muted"> · {setSummary(set)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
