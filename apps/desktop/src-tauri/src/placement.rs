//! Where something happened, when the client refused to say — and which of the points that
//! answered it are still worth keeping afterwards.
//!
//! The position track exists for one thing. Inside an instance `C_Map.GetPlayerMapPosition`
//! returns nothing, so a screenshot taken at a boss kill carries the map it was on and no point
//! on it. The combat log does carry one, every few seconds, and this is the rule that decides
//! which of those points is allowed to speak for the screenshot.
//!
//! It is a rule about time and about maps, and nothing here has ever seen a database. A caller
//! hands over the moment it wants placed and the handful of points near it; what comes back is
//! either a position somebody actually occupied or nothing at all. There is no third answer —
//! placing a screenshot in the wrong room is worse than admitting the track cannot say, which is
//! the same refusal `0006_captures.sql` already makes when it declines to write a `0,0`.

/// How far in time a point may be from a moment and still be allowed to speak for it.
///
/// Fifteen seconds, which is three of the track's own five-second samples and about as far as a
/// player can run on foot before the answer stops being the same room. The sampling is what makes
/// the placement worth doing: inside that window the nearest point is very nearly where the
/// player was, and beyond it the honest answer is that nobody knows.
///
/// The gap it guards is not the sampling interval. Points come off damage and cast lines, so a
/// player standing still between pulls logs nothing at all, and the nearest point to a screenshot
/// taken in the raid entrance can be minutes away. That one is meant to come back unplaced.
pub const REACH_MS: i64 = 15_000;

/// How much of the track is kept around a remembered moment once the rest is compacted away.
///
/// Two minutes either side, which is far wider than [`REACH_MS`] on purpose. What survives a
/// sweep is the input a *later* rule would have — one that interpolates, or reaches further, or
/// asks where the player went next — and keeping only the rows this rule happened to use would
/// leave that rule with nothing to be written against.
pub const KEEP_MS: i64 = 120_000;

/// One row of the track, exactly as `log_positions` holds it.
///
/// The two nullable pairs are not defensive typing. A point whose map is unknown, or one recorded
/// before any `MAP_CHANGE` gave the bounds to normalise it with, is a real row in that table and
/// is a row that cannot place anything — so the rule says so here rather than leaving a caller to
/// remember it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub at_ms: i64,
    pub ui_map_id: Option<i64>,
    pub map_x: Option<f64>,
    pub map_y: Option<f64>,
}

/// An event that knows when it happened and which map it happened on, and wants the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Moment {
    pub at_ms: i64,
    /// The map the event itself stated. Required, and the reason a capture with no map at all is
    /// not a candidate for placement: normalised coordinates without the map they are normalised
    /// across are a pair of numbers that mean nothing.
    pub ui_map_id: i64,
}

/// Where a moment was, and how far the point that said so had to reach.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub map_x: f64,
    pub map_y: f64,
    /// How many milliseconds separate the moment from the point that placed it. Not stored
    /// anywhere; it is what makes a test able to say *which* point won rather than only that one
    /// did.
    pub gap_ms: i64,
}

/// The point that may speak for this moment, if any of them may.
///
/// Nearest in time and nothing cleverer. Interpolating between the points either side would put
/// the player on the straight line between two places they were, which is a position they may
/// never have occupied — a raid boss is walked around, not through. The nearest point is always
/// somewhere the player really stood.
///
/// A tie goes to the earlier point. A screenshot records something that has just happened, so
/// where the player was standing a moment before the shutter is the better answer of the two; and
/// a rule that picks deterministically is worth more here than the half-second it costs.
///
/// `points` may be in any order and may contain anything — the map check, the missing-coordinate
/// check and the reach are all applied here, so a caller that narrows the query loosely still
/// gets the same answer as one that narrows it tightly.
pub fn place(moment: Moment, points: &[Point]) -> Option<Placed> {
    points
        .iter()
        .filter(|point| point.ui_map_id == Some(moment.ui_map_id))
        .filter_map(|point| Some((point, point.map_x?, point.map_y?)))
        .map(|(point, x, y)| ((moment.at_ms - point.at_ms).abs(), point.at_ms, x, y))
        .filter(|(gap, ..)| *gap <= REACH_MS)
        .min_by_key(|(gap, at_ms, ..)| (*gap, *at_ms))
        .map(|(gap_ms, _, map_x, map_y)| Placed {
            map_x,
            map_y,
            gap_ms,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOON: i64 = 1_700_000_000_000;
    const AMIRDRASSIL: i64 = 2232;

    fn point(offset_ms: i64, x: f64, y: f64) -> Point {
        Point {
            at_ms: NOON + offset_ms,
            ui_map_id: Some(AMIRDRASSIL),
            map_x: Some(x),
            map_y: Some(y),
        }
    }

    fn moment() -> Moment {
        Moment {
            at_ms: NOON,
            ui_map_id: AMIRDRASSIL,
        }
    }

    /// The ordinary case, and the whole point of the feature: a screenshot inside an instance,
    /// with the track sampling either side of it.
    #[test]
    fn takes_the_point_nearest_in_time() {
        let track = [
            point(-9_000, 0.1, 0.1),
            point(-2_000, 0.4, 0.6),
            point(3_000, 0.5, 0.7),
        ];

        let placed = place(moment(), &track).expect("a point within reach");

        assert_eq!((placed.map_x, placed.map_y), (0.4, 0.6));
        assert_eq!(placed.gap_ms, 2_000);
    }

    /// The nearer point can be the one after. A screenshot at a pull is followed by the fight
    /// that logs everything, and preceded by a minute of standing still that logs nothing.
    #[test]
    fn takes_a_point_from_after_the_moment_when_it_is_the_nearer() {
        let track = [point(-11_000, 0.1, 0.1), point(4_000, 0.8, 0.2)];

        let placed = place(moment(), &track).expect("a point within reach");

        assert_eq!((placed.map_x, placed.map_y), (0.8, 0.2));
    }

    /// Equally far either side. The answer has to be the same every run, and the earlier point is
    /// where the player was standing when the thing worth photographing happened.
    #[test]
    fn breaks_a_tie_towards_the_earlier_point() {
        let track = [point(5_000, 0.9, 0.9), point(-5_000, 0.2, 0.3)];

        let placed = place(moment(), &track).expect("a point within reach");

        assert_eq!((placed.map_x, placed.map_y), (0.2, 0.3));
    }

    /// The refusal the schema already makes for itself. A screenshot with nothing near it in the
    /// track stays unplaced rather than being given the last position of the evening.
    #[test]
    fn refuses_a_point_further_away_than_the_reach() {
        let track = [point(-REACH_MS - 1, 0.4, 0.6), point(60_000, 0.5, 0.7)];

        assert_eq!(place(moment(), &track), None);
    }

    /// Exactly at the edge is within it. The constant is the furthest a point may be, not the
    /// first distance at which it is refused.
    #[test]
    fn allows_a_point_exactly_at_the_reach() {
        let track = [point(REACH_MS, 0.4, 0.6)];

        assert_eq!(
            place(moment(), &track).map(|placed| placed.gap_ms),
            Some(REACH_MS)
        );
    }

    /// A point recorded on another map is a point in another building. Its coordinates are
    /// fractions across a different rectangle, and using them would place the screenshot
    /// somewhere real and wrong — the failure this whole rule exists to avoid.
    #[test]
    fn refuses_a_point_recorded_on_another_map() {
        let elsewhere = Point {
            ui_map_id: Some(2549),
            ..point(-1_000, 0.4, 0.6)
        };

        assert_eq!(place(moment(), &[elsewhere]), None);
    }

    /// A closer point on the wrong map does not beat a further one on the right map. The map is
    /// a gate rather than a preference.
    #[test]
    fn prefers_the_right_map_over_the_nearer_point() {
        let track = [
            Point {
                ui_map_id: Some(2549),
                ..point(-500, 0.9, 0.9)
            },
            point(-8_000, 0.4, 0.6),
        ];

        let placed = place(moment(), &track).expect("a point on the right map");

        assert_eq!((placed.map_x, placed.map_y), (0.4, 0.6));
    }

    /// A point read before any `MAP_CHANGE` was seen has world yards and no fraction. It is a
    /// real row in the track and it cannot place anything.
    #[test]
    fn refuses_a_point_that_was_never_normalised() {
        let stranded = Point {
            map_x: None,
            map_y: None,
            ..point(-1_000, 0.0, 0.0)
        };

        assert_eq!(place(moment(), &[stranded]), None);
    }

    /// A point whose map the line did not state cannot be checked against the moment's map, and
    /// an unchecked point is not a match.
    #[test]
    fn refuses_a_point_whose_map_the_log_did_not_state() {
        let unnamed = Point {
            ui_map_id: None,
            ..point(-1_000, 0.4, 0.6)
        };

        assert_eq!(place(moment(), &[unnamed]), None);
    }

    /// An install with advanced logging off, or one that has never read a log, has an empty
    /// track. Nothing to place from is not an error.
    #[test]
    fn places_nothing_from_an_empty_track() {
        assert_eq!(place(moment(), &[]), None);
    }

    /// The window kept around a moment is wider than the window a point may speak across, which
    /// is what leaves a later rule something to be written against.
    #[test]
    fn keeps_more_of_the_track_than_it_reads() {
        assert!(KEEP_MS > REACH_MS);
    }
}
