/**
 * One segment, in full, with a way through to the ones either side of it.
 *
 * The timeline, the roster and the details table each hand this the list a segment sits in —
 * a play session, a character's history, the current sort and filter — so "next" always means
 * the next one in whatever the reader was already looking at.
 *
 * The segment itself — the picture, the head, and the dozen lists under it — is drawn by
 * `SegmentHead` and `SegmentBody`, which are the whole of what the two frames a reader meets one
 * in have in common. This file holds the frame the roster and the table open: a modal over
 * whatever the reader was reading. The timeline opens the other one, docked beside the spine —
 * see `segmentPanel.tsx`.
 */

import "./segmentModal.css";

import { useCallback, useRef } from "react";
import type { KeyboardEvent, ReactNode, Ref, RefObject } from "react";

import { achievementIds, achievementLine } from "./achievements";
import type { AchievementBook } from "./achievements";
import { useBook } from "./book";
import { lightDismiss, useModalDialog } from "./dialog";
import { CaptureGallery } from "./captureGallery";
import type { CaptureActions } from "./captureGallery";
import type { CaptureAlbum } from "./captures";
import { equipsetDetail, equipsetSlotLine, equipsetTitle } from "./equipsets";
import type { AppearanceModalState } from "./appearanceModal";
import { GameItem } from "./item";
import { itemName } from "./items";
import type { ItemBook } from "./items";
import type { BossPortraits } from "./bosses";
import type { FactionIcons } from "./reputations";
import type { PlaceHeroes } from "./places";
import { highlights } from "./sessions";
import { ago, clock, dayLabel, duration, gold, isLoss, plural, signed, signedGold } from "./format";
import { eventsOf } from "./types";
import type {
  AccountCurrency,
  AccountFaction,
  AccountHoldings,
  AchievementEvent,
  Segment,
} from "./types";
import {
  ActivityChip,
  ClassDot,
  FactionIcon,
  HighlightList,
  StandingBar,
  StepButton,
  className,
  locationType,
  shownHighlights,
} from "./ui";

/** No place on screen is nothing to look a picture up for, and the same empty list every time. */
const NOTHING_NAMED: string[] = [];

/** Everything a frame is showing, or nothing at all when it is closed. */
export interface SegmentViewState {
  /** The list to walk, which is whichever list the segment was opened from. */
  order: Segment[];
  index: number;
}

const Wowhead = ({
  kind,
  id,
  children,
}: {
  kind: string;
  id: number;
  children: ReactNode;
}): ReactNode => (
  <a
    href={`https://www.wowhead.com/${kind}=${encodeURIComponent(id)}`}
    target="_blank"
    rel="noopener noreferrer"
  >
    {children}
  </a>
);

const At = ({ event }: { event: { at?: number | null } }): ReactNode =>
  event.at ? <span className="muted">{clock(event.at)}</span> : null;

/**
 * What to call an item on a control that has to say something before anything has been read.
 *
 * The same order `itemLine` draws a row in, because this is the same claim said out loud: the
 * button opens a picture of whatever the row beside it ended up showing, and a label that
 * disagreed with the row would be naming something else.
 */
const shownAs = (event: { id: number; name?: string | null }, items: ItemBook): string =>
  itemName(event.id, event.name, items.detail(event.id));

/**
 * A section of the modal, or nothing when the segment has no events of that kind.
 *
 * Named as well as headed, which makes each one a landmark of its own: the modal is a dozen
 * lists of different things and "the achievements" is how somebody asks for one of them —
 * whether they are jumping between regions with a screen reader or scoping a test to it.
 */
function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="detail-section" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/**
 * The achievements, drawn from what the game says about them rather than only from what the
 * segment recorded.
 *
 * This is the one section whose contents are not in the segment. A row starts as the name the
 * addon caught — which is what the app showed before the game's tables were being read at all
 * — and fills in as the lookup comes back: what had to be done, what it granted, where it
 * sits, what it was worth, and the picture the game shows beside it.
 */
function Earned({ event, book }: { event: AchievementEvent; book: AchievementBook }): ReactNode {
  const line = achievementLine(event, book.detail(event.id));
  const icon = book.icon(event.id);
  const facts = [line.category, line.worth, line.side && `${line.side} only`, line.first].filter(
    Boolean,
  );
  // The icon is decorative: the row names the achievement beside it, and a picture that
  // announced itself as well would have a screen reader read every row twice. The frame is
  // drawn whether or not there is anything in it yet, so the column never goes ragged.
  return (
    <li className="earned-item">
      <span className="earned-icon">{icon ? <img src={icon} alt="" /> : null}</span>
      <div>
        <p className="earned-name">
          🏆{" "}
          <Wowhead kind="achievement" id={event.id}>
            {line.title}
          </Wowhead>{" "}
          <At event={event} />
        </p>
        {line.description ? <p className="earned-what">{line.description}</p> : null}
        {line.reward ? <p className="earned-reward">{line.reward}</p> : null}
        <p className="earned-facts">
          {facts.map((fact) => (
            <span className="chip" key={fact}>
              {fact}
            </span>
          ))}
        </p>
      </div>
    </li>
  );
}

/**
 * The portrait the Adventure Guide draws a boss with, beside the fight it was.
 *
 * The one place in the app where a picture is the ordinary case rather than the exception: the
 * game has a portrait for all but one of the fights its journal gives an id to, so the frame is
 * held whether or not the picture has landed yet — the same bargain the achievement icon beside it
 * makes, and for the same reason. A list of eight bosses that indented itself as each picture
 * arrived would be worse than one that waited.
 *
 * Where there is no book at all — a window with no game install behind it — there is no frame
 * either, and the line reads exactly as it did before any of this existed.
 *
 * The picture says nothing: the row names the boss beside it, so the `<img>` is marked decorative
 * and no reader hears the fight twice.
 */
function BossPortrait({
  encounter,
  bosses,
}: {
  encounter: number;
  bosses?: BossPortraits;
}): ReactNode {
  // The book is a cache outside React, so a portrait landing changes nothing React would notice.
  // `useBook` is what turns an arrival into a redraw — see `book.ts`. Each row asks for its own
  // fight, and the book sends one request for whatever asked in that turn.
  useBook(bosses, [encounter]);

  if (!bosses) return null;
  const picture = bosses.icon(encounter);
  return <span className="boss-portrait">{picture ? <img src={picture} alt="" /> : null}</span>;
}

/**
 * The picture of the place, as the header the modal opens with.
 *
 * A band rather than the 20-pixel icon that used to sit beside the heading, because the picture
 * is the one thing on this screen that says where the reader is at a glance — the difference
 * between Naxxramas and Nerub-ar Palace is a colour and a shape long before it is a word. The
 * band crops rather than stretches whatever arrives, which a picture that filled the modal's
 * width by squashing its own art would not.
 *
 * Every place gets one, and which picture it is the backend's to decide: the banner the game
 * paints a dungeon with, or, for the open-world zone that most segments happened in, the map the
 * game draws of that place — assembled out of the fragments it stores a map in, town by town, as
 * somebody who has been everywhere would see it. Only a place with neither falls through to a
 * stand-in. See `heroes::heroes_of`.
 *
 * Named after the place it is of, the same way the icon beside a segment row is: the band is a
 * picture and nothing else, so "Picture of Naxxramas" is the whole of what there is to say about
 * it — and it is what lets a reader who cannot see it know the header is there, and a test ask for
 * it. Named that way rather than "Banner", because whether it is a painted banner or the zone's own
 * map is a fact about which tables the game happens to hold art in, and nobody reading it needs to
 * be told. The `<img>` inside says nothing, because the band has already said it.
 *
 * Nothing at all is drawn before the picture lands or where there is no game install behind the
 * window — an empty band would be a hole in the modal rather than a header.
 */
function PlaceHero({ place, heroes }: { place: string; heroes?: PlaceHeroes }): ReactNode {
  // The book is a cache outside React, so a picture landing changes nothing React would notice.
  // `useBook` is what turns an arrival into a redraw — see `book.ts`. Asked for by the modal
  // rather than by the window, because it is one picture per segment somebody opens.
  useBook(heroes, place ? [place] : NOTHING_NAMED);

  const picture = place ? heroes?.icon(place) : undefined;
  if (!picture) return null;
  return (
    <div className="detail-hero" role="img" aria-label={`Picture of ${place}`}>
      <img src={picture} alt="" />
    </div>
  );
}

/**
 * What happened to the character's equipment sets, slot by slot.
 *
 * This is the one section whose rows are lists of their own: a change is a set and the slots
 * it moved, and the slots are the part somebody opens the modal for. The summary line above
 * them says what the chip said; the rows underneath say which items, which is what the chip
 * could not.
 *
 * A slot with nothing on one side is drawn as an em dash rather than left blank, so a slot
 * that was cleared and a slot that was filled read as the two different things they are.
 */
function Equipsets({ segment, items }: { segment: Segment; items: ItemBook }): ReactNode {
  const changes = eventsOf(segment, "equipsetChanges");
  if (!changes.length) return null;
  return (
    <Section title="Equipment sets">
      <ul className="equipsets" aria-label="Equipment sets that changed">
        {changes.map((change, index) => (
          <li className="equipset" key={`${change.setId}-${index}`}>
            <p className="equipset-name">
              🎽 {equipsetTitle(change)} <span className="muted">{equipsetDetail(change)}</span>{" "}
              <At event={change} />
            </p>
            {(change.items || []).length === 0 ? null : (
              // Named after the set it belongs to, because a segment can change several and a
              // list of slots means nothing without saying whose slots they are.
              <ul className="equipset-slots" aria-label={`Slots in ${equipsetTitle(change)}`}>
                {(change.items || []).map((item) => {
                  const line = equipsetSlotLine(item);
                  return (
                    <li key={item.slot}>
                      <span className="equipset-slot">{line.slot}</span>
                      {/* The picture and the name, and the item level after them — the facts
                          are left off, because two items sit side by side in a slot and the
                          armour class is the same on both of them anyway. */}
                      <span className="equipset-was">
                        {line.previousItemId == null ? (
                          <span className="muted">—</span>
                        ) : (
                          <GameItem
                            id={line.previousItemId}
                            name={item.previousItemName}
                            book={items}
                            facts={false}
                          >
                            {line.previousLevel ? (
                              <span className="muted">{line.previousLevel}</span>
                            ) : null}
                          </GameItem>
                        )}
                      </span>
                      <span className="equipset-now">
                        {line.itemId == null ? (
                          <span className="muted">—</span>
                        ) : (
                          <GameItem
                            id={line.itemId}
                            name={item.itemName}
                            book={items}
                            facts={false}
                          >
                            {line.level ? <span className="muted">{line.level}</span> : null}
                          </GameItem>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * What some other character has already done with the faction, when one has done more.
 *
 * The question this answers is whether grinding the faction on this character is worth
 * anything, so it only speaks when the answer is "somebody else has already got further". The
 * account best is computed across every character including this one, so a best belonging to
 * the segment's own character means nobody is ahead and there is nothing to say.
 *
 * The age travels with it because none of this is live: it is what that character was holding
 * when it was last played, and a standing read months ago is a weaker claim than a name alone
 * would suggest.
 */
function AccountStanding({
  faction,
  character,
}: {
  faction: AccountFaction | undefined;
  character: string;
}): ReactNode {
  const best = faction?.best;
  if (!best || best.character === character || !best.standing) return null;
  const when = best.at ? ` · read ${ago(best.at)}` : "";
  return (
    <p className="rep-account muted">
      {best.character} is further along: {best.standing}
      {when}
    </p>
  );
}

/**
 * The reputation gains, each with the standing it left behind.
 *
 * A section of its own rather than a one-line formatter, because the bar is a block under the
 * gain rather than something that fits on the end of it.
 */
function Reputation({
  segment,
  holdings,
  factions,
}: {
  segment: Segment;
  holdings?: AccountHoldings;
  /** The pictures the game gives a faction. Absent leaves every line with the medal it had. */
  factions?: FactionIcons;
}): ReactNode {
  const gains = eventsOf(segment, "reputation");
  if (!gains.length) return null;
  const byFaction = new Map((holdings?.factions || []).map((entry) => [entry.faction, entry]));
  return (
    <Section title="Reputation">
      <ul>
        {gains.map((gain) => (
          <li key={gain.faction}>
            <FactionIcon faction={gain.faction} factions={factions} fallback="🎖️" /> {gain.faction}{" "}
            <span className="muted">{signed(gain.amount)}</span> <At event={gain} />
            <StandingBar standing={gain} faction={gain.faction} />
            <AccountStanding faction={byFaction.get(gain.faction)} character={segment.character} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * What this segment did to the wallet, and what the wallet holds now.
 *
 * The two are different kinds of number and the wording has to keep them apart. The movement
 * belongs to the segment and is settled forever; the balance is the addon's latest reading and
 * belongs to the character rather than to this hour of its life. A segment from March shown
 * beside an unqualified balance would read as though the balance were March's, so the balance
 * says "now" and carries the age of the reading behind it.
 *
 * What the loot was worth used to sit on the first line and no longer does. It is a vendor
 * price for things mostly sold or disenchanted rather than kept, it does not add up to the
 * movement beside it, and a third number that agrees with neither of the other two is worse
 * than no number at all. The ledger on the details view still carries it.
 */
function Gold({ segment, holdings }: { segment: Segment; holdings?: AccountHoldings }): ReactNode {
  const account = holdings?.gold;
  const held = account?.characters.find((holder) => holder.character === segment.character);
  if (!segment.goldDiff && !held) return null;
  const who = segment.character.split("-")[0] || segment.character;
  return (
    <Section title="Gold">
      <ul>
        <li>
          💰{" "}
          <span className={isLoss(segment.goldDiff) ? "loss" : "gold"}>
            {signedGold(segment.goldDiff)}
          </span>{" "}
          <span className="muted">over the segment</span>
        </li>
        {held ? (
          <li>
            👛 {who} is carrying <strong>{gold(held.total)}</strong>
            {held.at ? <span className="muted"> · read {ago(held.at)}</span> : null}
          </li>
        ) : null}
        {/* Only when it is a different number from the wallet above: one character with an
            empty warband bank is worth what is in its pocket, and saying it twice adds
            nothing. */}
        {account && account.total !== held?.total ? (
          <li>
            🏦 <span className="account-total">{gold(account.total)} across the account</span>
            {account.warband ? (
              <span className="muted"> · {gold(account.warband)} in the warband bank</span>
            ) : null}
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/**
 * What the whole account holds of a currency this segment earned.
 *
 * Only when somebody else holds some too: on an account of one, or a currency only this
 * character has ever picked up, the account total is the number already on the line and saying
 * it twice adds nothing.
 *
 * The eldest reading in the sum is the one named, because it is the weakest claim in it — a
 * total built partly from numbers a month old should not read as though it were all current.
 *
 * A warband currency is not a sum and must not be worded as one. "6,000 across 4 characters"
 * says four people hold some between them; the truth is that there is one pot of 6,000 and
 * all four are looking at it, which is the difference between having earned it four times and
 * having earned it once. There is no eldest reading to name either — the one the total came
 * from is the freshest, and it is the whole claim rather than a term in it.
 */
function AccountTotal({ held }: { held: AccountCurrency | undefined }): ReactNode {
  if (!held) return null;
  if (held.accountWide) {
    const read = held.oldest ? `, read ${ago(held.oldest)}` : "";
    return (
      <>
        {" "}
        <span className="account-total">
          · {held.total.toLocaleString()} shared across the warband{read}
        </span>
      </>
    );
  }
  if (held.characters.length < 2) return null;
  const eldest = held.oldest ? `, eldest read ${ago(held.oldest)}` : "";
  return (
    <>
      {" "}
      <span className="account-total">
        · {held.total.toLocaleString()} across {plural(held.characters.length, "character")}
        {eldest}
      </span>
    </>
  );
}

function Currencies({
  segment,
  holdings,
}: {
  segment: Segment;
  holdings?: AccountHoldings;
}): ReactNode {
  const gains = eventsOf(segment, "currencies");
  if (!gains.length) return null;
  return (
    <Section title="Currency">
      <ul>
        {gains.map((gain) => (
          // What the segment earned, then what the character was left holding, then what the
          // account holds altogether. The second is the number that decides whether the first
          // is enough to buy anything; the third is the one no single character can answer.
          // Both are absent rather than zero when nobody has said.
          <li key={gain.id}>
            🪙 {gain.name}{" "}
            <span className="muted">
              {signed(gain.amount)}
              {gain.total == null ? "" : ` (${gain.total.toLocaleString()})`}
            </span>
            <AccountTotal
              held={(holdings?.currencies || []).find((entry) => entry.id === gain.id)}
            />{" "}
            <At event={gain} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The plain lists: a heading, and one line per event.
 *
 * The table columns abbreviate; these do not, because this is where somebody comes when the
 * abbreviation was not enough.
 */
function Lists({
  segment,
  book,
  items,
  bosses,
  onShowAppearance,
}: {
  segment: Segment;
  book: AchievementBook;
  items: ItemBook;
  /** The portraits the game draws a boss with. Absent leaves the encounter rows as they were. */
  bosses?: BossPortraits;
  /** Absent where nothing can draw one, which is what leaves the transmog rows as they were. */
  onShowAppearance?: (showing: AppearanceModalState) => void;
}): ReactNode {
  const encounters = eventsOf(segment, "encounters");
  const achievements = eventsOf(segment, "achievements");
  const levelUps = eventsOf(segment, "levelUps");
  const mounts = eventsOf(segment, "mounts");
  const pets = eventsOf(segment, "pets");
  const toys = eventsOf(segment, "toys");
  const transmogs = eventsOf(segment, "transmogs");
  const quests = eventsOf(segment, "quests");
  const housingItems = eventsOf(segment, "housingItems");
  const housingLevelUps = eventsOf(segment, "housingLevelUps");
  return (
    <>
      {encounters.length ? (
        <Section title="Encounters">
          <ul className="fought">
            {encounters.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                <BossPortrait encounter={event.id} bosses={bosses} />
                {/* The sentence in one span rather than loose beside the portrait: the row is a
                    flex line, and a bare run of words in one would be broken into an item per
                    word with a gap opened up between each of them. */}
                <span>
                  {event.name || `Encounter ${event.id}`}{" "}
                  <span className={event.success ? "ok" : "loss"}>
                    {event.success ? "killed" : "wipe"}
                  </span>
                  {event.groupSize ? (
                    <>
                      {" "}
                      <span className="muted">{plural(event.groupSize, "player")}</span>
                    </>
                  ) : null}{" "}
                  <At event={event} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {achievements.length ? (
        <Section title="Achievements">
          <ul className="earned">
            {achievements.map((event, index) => (
              <Earned key={`${event.id}-${index}`} event={event} book={book} />
            ))}
          </ul>
        </Section>
      ) : null}
      {levelUps.length ? (
        <Section title="Level ups">
          <ul>
            {levelUps.map((event, index) => (
              <li key={index}>
                ⬆️ Level {event.level} <At event={event} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {mounts.length ? (
        <Section title="Mounts">
          <ul>
            {mounts.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                🐎 {event.name || `Mount ${event.id}`} <At event={event} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {pets.length ? (
        <Section title="Pets">
          <ul>
            {pets.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                🐾 {event.name || `Pet ${event.id}`} <At event={event} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {toys.length ? (
        <Section title="Toys">
          <ul>
            {toys.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                🧸 {event.name || `Toy ${event.id}`} <At event={event} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {transmogs.length ? (
        <Section title="Transmog">
          <ul className="items">
            {transmogs.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                <GameItem id={event.id} name={event.name} book={items}>
                  {event.newAppearance === true ? (
                    <span className="appearance-new">new appearance</span>
                  ) : event.newAppearance === false ? (
                    <span className="appearance-variant">variant of one owned</span>
                  ) : (
                    <span className="muted">unknown</span>
                  )}
                  <At event={event} />
                  {/* The way through to a picture of it, and the only thing on this row that costs
                  anything: three of the game's tables stand between an item id and a model, and
                  none of them is opened until this is pressed. A button rather than the row
                  itself, because the row is already a link out to Wowhead. */}
                  {onShowAppearance ? (
                    <button
                      type="button"
                      className="ghost appearance-show"
                      title={`Show ${shownAs(event, items)} drawn`}
                      aria-label={`Show ${shownAs(event, items)} drawn`}
                      onClick={() =>
                        onShowAppearance({
                          itemId: event.id,
                          name: shownAs(event, items),
                        })
                      }
                    >
                      Show
                    </button>
                  ) : null}
                </GameItem>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Equipsets segment={segment} items={items} />
      {quests.length ? (
        <Section title="Quests">
          <ul>
            {quests.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                📜{" "}
                <Wowhead kind="quest" id={event.id}>
                  {event.name || `Quest ${event.id}`}
                </Wowhead>
                {event.accountFirst ? (
                  <>
                    {" "}
                    <span className="muted">account first</span>
                  </>
                ) : null}{" "}
                <At event={event} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {housingItems.length ? (
        <Section title="Housing">
          <ul>
            {housingItems.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                🪑 {event.name || `Decor ${event.id}`}{" "}
                <span className="muted">
                  {event.warbandFirst ? "warband first" : "already known"}
                </span>{" "}
                <At event={event} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {housingLevelUps.length ? (
        <Section title="Housing levels">
          <ul>
            {housingLevelUps.map((event, index) => (
              <li key={index}>
                🏡 Housing level {event.level} <At event={event} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

function Keystone({ segment }: { segment: Segment }): ReactNode {
  const run = segment.keystone;
  if (!run) return null;
  const outcome = !run.completed ? (
    <span className="loss">abandoned</span>
  ) : run.onTime === false ? (
    <span className="loss">depleted</span>
  ) : (
    <span className="ok">timed</span>
  );
  return (
    <Section title="Keystone">
      <p>
        🔑 <strong>+{run.level}</strong> {outcome}
        {run.upgrades ? ` · +${run.upgrades} upgrade${run.upgrades === 1 ? "" : "s"}` : ""}
        {run.durationMs ? (
          <>
            {" "}
            <span className="muted">{duration(run.durationMs / 1000)}</span>
          </>
        ) : null}
      </p>
    </Section>
  );
}

function Experience({ segment }: { segment: Segment }): ReactNode {
  const gained = segment.experience;
  if (!gained) return null;
  return (
    <Section title="Experience">
      <p>
        {signed(gained.gained)} XP · {Math.round(gained.percent * 10) / 10}% of a level
        {gained.endLevel == null ? null : (
          <>
            {" "}
            <span className="muted">now level {gained.endLevel}</span>
          </>
        )}
      </p>
    </Section>
  );
}

export interface SegmentViewProps {
  /** What the frame is showing, or null when it is closed. */
  showing: SegmentViewState | null;
  onStep: (by: number) => void;
  onClose: () => void;
  onEditActivities: (segmentId: number) => void;
  /**
   * What the game says about the achievements a segment names. Passed in so the frame is
   * drivable without a backend, and asked only for the segment on screen.
   */
  achievements: AchievementBook;
  /**
   * What the game says about the items a segment names, shared with every other view that
   * draws one. Each row asks for its own item, so nothing here has to collect ids first.
   */
  items: ItemBook;
  /**
   * The wide banner the game draws a place across, which is the header a segment opens on and
   * nothing else. Absent where nothing can draw one — a window with no game install behind it —
   * which leaves the segment opening on its heading, the way it did before there were pictures.
   */
  heroes?: PlaceHeroes;
  /**
   * The pictures a faction borrows from its own Exalted achievement, shared with the roster —
   * where the same standings are listed again, and where a reader meets the same factions.
   */
  factions?: FactionIcons;
  /**
   * The portraits the game draws a boss with. An opened segment is the only place a fight is
   * named, so this is not shared with anything — but it is a book for the same reason the others
   * are: a raid night is the same eight bosses over and over, and a reader stepping through its
   * segments meets each of them on every one.
   */
  bosses?: BossPortraits;
  /**
   * What every character on the account was last seen holding, so a gain can be read against
   * the account rather than only against the character that earned it. Absent on a history
   * collected before any character reported, which reads as nothing to add.
   */
  holdings?: AccountHoldings;
  /** The thumbnails the window has already been handed, shared with every other grid. */
  album: CaptureAlbum;
  captures: CaptureActions;
  /**
   * Opens a picture of one transmog source the segment names.
   *
   * Absent where nothing can draw one — a window with no game install behind it — which leaves
   * the transmog rows exactly as they were: a name, an icon and whether the look was new.
   */
  onShowAppearance?: (showing: AppearanceModalState) => void;
}

/** No segment on screen is nothing to look up, and the same empty list every time it happens. */
const NOTHING_WANTED: number[] = [];

/**
 * Stepping to the next segment, with the reading put back to the top where it belongs.
 *
 * A frame's own business rather than the window's: `onStep` moves the index, and this is the
 * part that says a reader who was eleven sections down the last segment is at the top of this
 * one. Shared because both frames have a body that scrolls and neither would be right without
 * it.
 */
export function useSegmentStep(onStep: (by: number) => void): {
  body: RefObject<HTMLDivElement | null>;
  step: (by: number) => void;
} {
  const body = useRef<HTMLDivElement>(null);
  const step = useCallback(
    (by: number) => {
      onStep(by);
      body.current?.scrollTo({ top: 0 });
    },
    [onStep],
  );
  return { body, step };
}

/**
 * The arrow keys walking the list, wherever inside the frame the focus has ended up.
 *
 * What a reader reaches for once they realise a segment is one of several, and nothing inside a
 * frame wants them: the body scrolls, it does not select. Handed to the frame rather than to
 * anything in it, because a key event is only heard by an ancestor of whatever has the focus.
 */
export const walkOnArrows =
  (step: (by: number) => void) =>
  (event: KeyboardEvent<Element>): void => {
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  };

/**
 * The head of an opened segment: the picture of the place, its name, where in the list it is,
 * and the way to either side of it.
 *
 * This and `SegmentBody` are the whole of what the two frames share, and they are two components
 * rather than one for the same reason the modal is a flex column: a wrapper around the pair would
 * be a box each frame then had to teach to behave like its own, and the header inside it has
 * already been through one argument about what may shrink.
 *
 * The title's id is the frame's to give, because both frames are in the document at once and an
 * id belongs to one element. Each names itself after the heading it holds.
 */
export function SegmentHead({
  showing,
  segment,
  heroes,
  titleId,
  onStep,
  onClose,
}: {
  showing: SegmentViewState | null;
  segment: Segment | undefined;
  heroes?: PlaceHeroes;
  titleId: string;
  onStep: (by: number) => void;
  onClose: () => void;
}): ReactNode {
  return (
    <>
      {segment ? <PlaceHero place={segment.instance} heroes={heroes} /> : null}
      <div className="detail-head">
        <div className="detail-named">
          <h2 className="detail-title" id={titleId}>
            {segment?.instance ?? ""}
          </h2>
          {/* Where in the list the reader is, announced as it changes — stepping to the next
              segment is exactly the moment "2 of 2" is worth hearing. */}
          <span className="detail-position" role="status" aria-label="Which segment">
            {showing ? `${showing.index + 1} of ${showing.order.length}` : ""}
          </span>
        </div>
        <div className="detail-nav">
          {/* Both ends say they are spent without giving up the focus they are holding, which is
              what keeps the arrow keys working once the reader has walked to one of them.
              See `StepButton`. */}
          <StepButton
            label="Previous segment"
            spent={!showing || showing.index === 0}
            onStep={() => onStep(-1)}
          >
            ‹
          </StepButton>
          <StepButton
            label="Next segment"
            spent={!showing || showing.index >= showing.order.length - 1}
            onStep={() => onStep(1)}
          >
            ›
          </StepButton>
          <button type="button" aria-label="Close segment" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Everything the segment holds, in the one box on the screen that scrolls.
 *
 * The frame around it is capped — at a share of the window in the modal, at the height of the
 * window in the panel — so this is what gives way, and the `ref` is how the frame puts it back
 * to the top when the reader steps to another segment.
 */
export function SegmentBody({
  segment,
  book,
  items,
  bosses,
  factions,
  holdings,
  album,
  captures,
  onEditActivities,
  onShowAppearance,
  ref,
}: {
  segment: Segment | undefined;
  book: AchievementBook;
  items: ItemBook;
  bosses?: BossPortraits;
  factions?: FactionIcons;
  holdings?: AccountHoldings;
  album: CaptureAlbum;
  captures: CaptureActions;
  onEditActivities: (segmentId: number) => void;
  onShowAppearance?: (showing: AppearanceModalState) => void;
  ref?: Ref<HTMLDivElement>;
}): ReactNode {
  // The lookup runs after the segment is on screen, because reading the game's own files takes
  // about a second and everything else about the segment is already in hand. Each half of it —
  // the words, then the pictures — redraws when it lands.
  //
  // The book is not state: it is a cache outside React, shared with every other segment the reader
  // opens, so a lookup landing has nothing to change that React would notice. `useBook` is the
  // subscription that tells it, and it is what makes closing the segment inside that second the
  // end of the matter rather than a redraw of something that has gone. See `book.ts`.
  //
  // Asking again costs nothing: the book keeps what it has already been told and what it has
  // already asked about, so a repeat is filtered down to nothing before it reaches a backend.
  useBook(book, segment ? achievementIds(segment) : NOTHING_WANTED);

  const facts = segment
    ? [
        `${dayLabel(segment.day)} · ${clock(segment.startedAt)} – ${clock(segment.endedAt)}`,
        duration(segment.seconds),
      ]
    : [];

  const summary = segment ? highlights([segment]) : [];
  const activities = segment?.activities || [];

  return (
    <div className="detail-body" ref={ref}>
      {segment ? (
        <>
          <p className="detail-who">
            <ClassDot classFile={segment.classFile} />
            <strong>{segment.character}</strong>{" "}
            <span className="muted">
              {className(segment.classFile)}
              {segment.level == null ? "" : ` · level ${segment.level}`}
            </span>
          </p>
          <p className="detail-facts">
            {facts.join(" · ")} · <span className="badge">{locationType(segment)}</span>
            {segment.difficulty ? ` · ${segment.difficulty}` : ""}
          </p>
          <div className="detail-activities">
            {activities.length ? (
              activities.map((activity, index) => (
                <ActivityChip key={activity.id ?? index} activity={activity} />
              ))
            ) : (
              <span className="muted">No activity recorded</span>
            )}
            <button type="button" onClick={() => onEditActivities(segment.segmentId)}>
              Edit activities
            </button>
          </div>
          <Keystone segment={segment} />
          <Experience segment={segment} />
          <div className="detail-highlights">
            {shownHighlights(summary, { milestones: false }).length ? (
              <HighlightList entries={summary} milestones={false} interactive={false} />
            ) : (
              <p className="muted">Nothing was gained or collected in this segment.</p>
            )}
          </div>
          {/* Above the lists, because a photograph of the evening is what somebody opens a
              segment for when there is one, and the lists are what they read afterwards. */}
          {(segment.captures || []).length ? (
            <Section title="Screenshots">
              <CaptureGallery segments={[segment]} album={album} actions={captures} />
            </Section>
          ) : null}
          <Lists
            segment={segment}
            book={book}
            items={items}
            bosses={bosses}
            onShowAppearance={onShowAppearance}
          />
          <Gold segment={segment} holdings={holdings} />
          <Currencies segment={segment} holdings={holdings} />
          <Reputation segment={segment} holdings={holdings} factions={factions} />
        </>
      ) : null}
    </div>
  );
}

export function SegmentModal({
  showing,
  onStep,
  onClose,
  onEditActivities,
  achievements: book,
  items,
  heroes,
  bosses,
  factions,
  holdings,
  album,
  captures,
  onShowAppearance,
}: SegmentViewProps): ReactNode {
  const segment = showing?.order[showing.index];
  const { body, step } = useSegmentStep(onStep);

  // `showModal` and `close` are the dialog's own state and React has no prop for them, so the
  // element is driven from an effect — opened when there is a segment to show, and closed when
  // there is not. See `dialog.ts`. The reverse direction is `onClose` below: Escape closes a
  // dialog without asking anybody.
  const dialog = useModalDialog(segment !== undefined);

  return (
    <dialog
      id="segment-detail"
      aria-labelledby="segment-detail-title"
      ref={dialog}
      onClose={onClose}
      onKeyDown={walkOnArrows(step)}
      // Clicking away closes it, which is what a reader who opened it by clicking expects and
      // what `showModal` does not give: the backdrop swallows the click and nothing happens.
      // `lightDismiss` is what tells a click on the backdrop from one on the modal's own
      // padding — see `dialog.ts`. Nothing is being edited here, so there is nothing to lose.
      onClick={(event) => {
        if (lightDismiss(event)) onClose();
      }}
    >
      <SegmentHead
        showing={showing}
        segment={segment}
        heroes={heroes}
        titleId="segment-detail-title"
        onStep={step}
        onClose={onClose}
      />
      <SegmentBody
        ref={body}
        segment={segment}
        book={book}
        items={items}
        bosses={bosses}
        factions={factions}
        holdings={holdings}
        album={album}
        captures={captures}
        onEditActivities={onEditActivities}
        onShowAppearance={onShowAppearance}
      />
    </dialog>
  );
}
