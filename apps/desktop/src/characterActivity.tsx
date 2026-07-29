/**
 * What a character has been doing lately, and what it got them.
 *
 * The other half of the split. Everything in the summary beside it is a standing balance and is
 * true whenever you ask; everything here is dated, and is therefore the only part of the page a
 * time range means anything to. Two weeks by default — see `characterRange.ts`, which is where
 * that is argued.
 *
 * Three things, in the order a player would ask for them:
 *
 * 1. **What was done.** The activity roll, which is the same list an evening on the timeline
 *    unfolds into. It is deliberately not folded into counts: "a +14 and a heroic night" is what
 *    somebody would say if you asked how the fortnight went, and "6 Mythic+ runs" throws away
 *    the six levels and six dungeons that are the whole content of the sentence.
 * 2. **What it got them.** The same summary strip the session card carries, computed over the
 *    range rather than over an evening — appearances collected, gold, currencies, reputations,
 *    every one of them a thing that *happened* rather than a balance.
 * 3. **The segments**, last and folded away. A segment is the unit the addon records in and the
 *    unit this app files everything under, and it is not the unit anybody thinks in: a fortnight
 *    is forty of them, and forty rows above the two facts a reader came for is why they were
 *    moved down here. They are still one click away, and each still opens the same modal.
 *
 * A range that turns out to hold nothing says so and offers the widest one, which is the case
 * this section has to be good at rather than the edge case it looks like: a player opening
 * Chronie after a month away is looking at exactly that screen, and a blank one would read as a
 * history that had been lost.
 */

import "./characterActivity.css";

import { useState } from "react";
import type { ReactNode } from "react";

import { byDay } from "./characters";
import type { CharacterProfile } from "./characters";
import { RANGES, WIDEST_RANGE, rangeOf, within } from "./characterRange";
import { dayLabel, plural } from "./format";
import type { ItemBook } from "./items";
import type { PlaceIcons } from "./places";
import { activitiesIn, highlights } from "./sessions";
import { ActivityRoll, HighlightList, SegmentButton, shownHighlights } from "./ui";
import type { OpenSegment } from "./ui";

/** Only one character's activity is ever unfolded here, so its panels need one namespace. */
const SCOPE = "character-activity";

export interface CharacterActivityProps {
  entry: CharacterProfile;
  /** Which range is showing, held by the view so it survives a character being picked. */
  range: string;
  onRange: (key: string) => void;
  /** The moment every range is reckoned back from; decided once by the view. */
  now: number;
  /** What the game says about an item, for the gains that unfold into pieces of transmog. */
  items: ItemBook;
  /** The pictures the game draws a place with, for the segment rows below. */
  places?: PlaceIcons;
  /**
   * Opens a segment, walking the ones the range is showing.
   *
   * The range rather than the character's whole history, because that is what the reader is
   * looking at: stepping to "the next segment" out of a fortnight into something from March
   * would be stepping out of the question they asked.
   */
  onOpenSegment: OpenSegment;
}

export function CharacterActivity(
  { entry, range, onRange, now, items, places, onOpenSegment }: CharacterActivityProps,
): ReactNode {
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const chosen = rangeOf(range);
  const segments = within(entry.segments, chosen, now);
  const activities = activitiesIn(segments);
  const gains = highlights(segments);

  return <>
    <div className="act-head">
      <label htmlFor="character-range">Showing</label>
      <select
        id="character-range" value={chosen.key}
        onChange={(event) => {
          // A gain unfolded over one range says nothing about another, so changing the window
          // starts folded rather than leaving a panel of things that are no longer in it.
          setUnfolded(null);
          onRange(event.target.value);
        }}
      >
        {RANGES.map((one) => <option key={one.key} value={one.key}>{one.label}</option>)}
      </select>
      <span className="act-count muted" role="status" aria-label="What the range holds">
        {segments.length
          ? `${plural(activities.length, "activity", "activities")} · ${plural(segments.length, "segment")}`
          : ""}
      </span>
    </div>

    {segments.length === 0
      // A character is only on the roster because they have segments, and the widest range
      // holds every one of them — so an empty section always has something to report and
      // somewhere to send the reader, and never has to apologise for an empty history.
      ? <div className="empty">
        <p className="empty-title">Nothing in this range</p>
        <p>{`${entry.name} has ${plural(entry.segmentCount, "segment")} recorded altogether.`}</p>
        {chosen.key === WIDEST_RANGE
          ? null
          : <button type="button" onClick={() => onRange(WIDEST_RANGE)}>Show all time</button>}
      </div>
      : <>
        <section className="detail-section">
          <h3>What was done</h3>
          {activities.length
            ? <ActivityRoll
              activities={activities}
              onOpenSegment={(segmentId) => onOpenSegment(segmentId, segments)}
            />
            : <p className="muted">Nothing named in this range. Segments are still below.</p>}
        </section>

        {/* Named as well as headed, because it is a region a reader wants to arrive at rather
            than scroll to — and because the chips inside it are the same chips a segment row
            carries, so something has to say which set of them is the range's. */}
        <section className="detail-section" aria-label="What it got them">
          <h3>What it got them</h3>
          {shownHighlights(gains).length
            ? <HighlightList
              entries={gains} scope={SCOPE} expanded={unfolded} items={items}
              onUnfold={(kind) => setUnfolded((open) => (open === kind ? null : kind))}
              onOpenSegment={(segmentId) => onOpenSegment(segmentId, segments)}
            />
            : <p className="muted">Nothing gained or collected in this range.</p>}
        </section>

        {/* Open by nobody's default. `<details>` rather than a button of our own because it is
            exactly what the element is for, and because it keeps the whole list out of the
            accessibility tree until it is asked for rather than merely off screen. */}
        <details
          className="detail-section profile-segments" aria-label="Every segment in this range"
        >
          <summary>{plural(segments.length, "segment")}</summary>
          {byDay(segments).map((group) => (
            <section className="profile-day" key={group.day}>
              <h4>{dayLabel(group.day)}</h4>
              <ol className="segment-rows">
                {group.segments.map((segment) => (
                  <li key={segment.segmentId}>
                    <SegmentButton
                      segment={segment} items={items} places={places}
                      onOpen={() => onOpenSegment(segment.segmentId, segments)}
                    />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </details>
      </>}
  </>;
}
