//! Guessing what the player was actually doing during a segment.
//!
//! A segment says where someone stood and what happened to them; an activity says what that
//! *was* — a keystone run, a raid night, an evening of levelling. Every rule here is a guess
//! over data the addon already recorded, so it is pure: a segment in, a list of activities
//! out, no database and no clock. That is what lets the whole rule set be re-run over all of
//! history whenever the guessing improves, and what makes each rule testable on its own.
//!
//! Kinds worth adding once the plumbing here has proved itself, roughly in the order the
//! existing data already supports them:
//!
//! * `dungeon` — a party instance that was not a keystone, from `instanceType == "party"`
//!   plus its difficulty and encounter list. Needs nothing new.
//! * `delve` and `scenario` — `instanceType == "scenario"`; delves would want the tier,
//!   which the addon does not record yet.
//! * `raid_finder` — already separable from the difficulty name, but only worth splitting
//!   out of the raid kinds once there is a reason to treat it differently.
//! * `questing` — a run of completed quests in an outdoor zone. Derivable today from
//!   `quests` plus `instanceType == "none"`.
//! * `reputation_grind` — one faction dominating `reputation`. Derivable today.
//! * `collection_run` — a legacy instance whose yield is mounts, pets, toys or new
//!   appearances rather than progress. Derivable today, but overlaps `legacy_raid`, so it
//!   needs a story for two activities describing one segment before it is worth adding.
//! * `gold_farming` — a large `gold_diff` with little else. Derivable today.
//! * `housing` — housing XP and decor. Derivable today.
//! * `battleground` and `arena` — the addon does not yet distinguish PvP instance types.

use crate::saved_variables::Segment;
use serde_json::{json, Map, Value};

/// The difficulty the client reports for a Mythic Keystone dungeon. Used only as a fallback:
/// a segment recorded before the addon tracked keystones, or one whose start was missed, is
/// still recognisably a keystone run even without the run's own data.
const MYTHIC_KEYSTONE_DIFFICULTY: i64 = 8;

/// How much of a level has to be earned before a segment is called levelling. Below this a
/// gain is just the incidental experience that comes from doing something else.
const LEVELLING_PERCENT_THRESHOLD: f64 = 0.05;

pub const KIND_MYTHIC_PLUS: &str = "mythic_plus";
pub const KIND_PROGRESS_RAID: &str = "progress_raid";
pub const KIND_LEGACY_RAID: &str = "legacy_raid";
pub const KIND_LEVELLING: &str = "levelling";

/// Every kind this build knows how to name, for the desktop app's editor. A user is not
/// limited to these — a kind they type in is stored verbatim — but these are the ones the
/// inference can produce and the app can label.
pub const KNOWN_KINDS: &[&str] = &[
    KIND_MYTHIC_PLUS,
    KIND_PROGRESS_RAID,
    KIND_LEGACY_RAID,
    KIND_LEVELLING,
];

#[derive(Debug, Clone, PartialEq)]
pub struct Activity {
    pub kind: String,
    /// How sure the rule is, from 0 to 1. A rule that read the run's own data is certain; one
    /// that recognised the shape of a segment from its difficulty alone is not.
    pub confidence: f64,
    pub metadata: Value,
}

impl Activity {
    fn new(kind: &str, confidence: f64, metadata: Value) -> Self {
        Self {
            kind: kind.to_string(),
            confidence,
            metadata,
        }
    }
}

/// Drops the keys whose value is null, so an activity's metadata carries only what is
/// actually known. A field the addon never recorded is better absent than present-and-null:
/// the editor renders an absent field as empty, and a reader cannot mistake it for a real
/// zero.
fn compact(value: Value) -> Value {
    let Value::Object(map) = value else {
        return value;
    };
    Value::Object(
        map.into_iter()
            .filter(|(_, entry)| !entry.is_null())
            .collect::<Map<String, Value>>(),
    )
}

/// A keystone run, from the run's own record when the addon captured one, and from the
/// Mythic Keystone difficulty alone when it did not.
fn mythic_plus(segment: &Segment) -> Option<Activity> {
    let dungeon = segment.instance.as_str();
    let seconds = segment.seconds;
    let Some(keystone) = segment.keystone.as_ref() else {
        if segment.difficulty_id != Some(MYTHIC_KEYSTONE_DIFFICULTY) {
            return None;
        }
        // The difficulty says keystone but nothing recorded the key itself, so the level —
        // the one thing anybody wants to know — is missing. Say so rather than guess it.
        return Some(Activity::new(
            KIND_MYTHIC_PLUS,
            0.5,
            json!({ "dungeon": dungeon, "durationSeconds": seconds }),
        ));
    };

    Some(Activity::new(
        KIND_MYTHIC_PLUS,
        1.0,
        compact(json!({
            "dungeon": dungeon,
            "keystoneLevel": keystone.level,
            "completed": keystone.completed,
            "timed": keystone.on_time,
            "upgrades": keystone.upgrades,
            "affixes": keystone.affixes,
            "durationSeconds": keystone
                .duration_ms
                .map(|milliseconds| milliseconds / 1000)
                .unwrap_or(seconds),
        })),
    ))
}

/// A raid night, classified as current content or old content by the expansion that shipped
/// the raid against the newest expansion the recording client knew about.
///
/// Without those tiers the raid is still a raid, so it is reported rather than dropped — as
/// legacy, because far more raiding happens in old content than in the current tier, and at
/// a confidence that says the classification is the guess, not the raiding.
fn raid(segment: &Segment) -> Option<Activity> {
    if segment.instance_type != "raid" {
        return None;
    }
    let encounters = &segment.encounters;
    let kills = encounters.iter().filter(|event| event.success).count();
    let metadata = compact(json!({
        "raid": segment.instance,
        "difficulty": segment.difficulty,
        "bossesKilled": kills,
        "wipes": encounters.len() - kills,
        "expansionTier": segment.expansion_tier,
    }));

    let tier = segment.expansion_tier;
    let latest = segment.latest_expansion_tier;
    match (tier, latest) {
        (Some(tier), Some(latest)) if tier >= latest => {
            Some(Activity::new(KIND_PROGRESS_RAID, 0.9, metadata))
        }
        (Some(_), Some(_)) => Some(Activity::new(KIND_LEGACY_RAID, 0.9, metadata)),
        _ => Some(Activity::new(KIND_LEGACY_RAID, 0.4, metadata)),
    }
}

/// Time spent levelling, measured as a fraction of a level rather than in raw points, which
/// are incomparable between one level and the next.
///
/// A level-up is levelling whatever the fraction says: crossing a level is the whole point,
/// and a character that dinged one experience point into the segment still did it here.
fn levelling(segment: &Segment) -> Option<Activity> {
    let experience = segment.experience.as_ref();
    let percent = experience.map(|value| value.percent).unwrap_or_default();
    let levels = segment.level_ups.len();
    if levels == 0 && percent < LEVELLING_PERCENT_THRESHOLD {
        return None;
    }
    Some(Activity::new(
        KIND_LEVELLING,
        1.0,
        compact(json!({
            "experienceGained": experience.map(|value| value.gained).unwrap_or_default(),
            "percentOfLevel": (percent * 1000.0).round() / 10.0,
            "levelsGained": levels,
            "startLevel": experience.and_then(|value| value.start_level),
            "endLevel": experience.and_then(|value| value.end_level),
        })),
    ))
}

/// Every guess this build can make about one segment.
///
/// More than one may apply at once and that is not a conflict: a levelling raid night is
/// honestly both. What cannot happen is two guesses of the same kind, because a kind is how
/// a user's suppression of a guess is matched back to it on the next sync.
pub fn infer(segment: &Segment) -> Vec<Activity> {
    [mythic_plus(segment), raid(segment), levelling(segment)]
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A segment with only the fields every segment has. Each test adds exactly the fields
    /// its rule reads, so what drives the guess is visible in the test itself.
    fn segment(fields: Value) -> Segment {
        let mut base = json!({
            "id": "test",
            "character": "Test-Realm",
            "endedAt": 1,
            "instance": "Unknown",
            "instanceType": "none",
            "difficulty": "",
            "seconds": 0,
        });
        let Value::Object(extra) = fields else {
            panic!("segment fields must be an object");
        };
        let target = base.as_object_mut().expect("object base");
        for (key, value) in extra {
            target.insert(key, value);
        }
        serde_json::from_value::<crate::saved_variables::RawSegment>(base)
            .unwrap()
            .normalize()
            .unwrap()
    }

    fn kinds(segment: &Segment) -> Vec<String> {
        infer(segment)
            .into_iter()
            .map(|activity| activity.kind)
            .collect()
    }

    fn only(segment: &Segment, kind: &str) -> Activity {
        infer(segment)
            .into_iter()
            .find(|activity| activity.kind == kind)
            .unwrap_or_else(|| panic!("expected a {kind} activity in {:?}", kinds(segment)))
    }

    #[test]
    fn guesses_nothing_about_an_uneventful_stroll() {
        assert!(infer(&segment(json!({ "instance": "Elwynn Forest" }))).is_empty());
    }

    #[test]
    fn reads_a_keystone_run_off_the_run_itself() {
        let activity = only(
            &segment(json!({
                "instance": "Halls of Atonement",
                "instanceType": "party",
                "difficultyId": MYTHIC_KEYSTONE_DIFFICULTY,
                "keystone": {
                    "level": 14,
                    "affixes": [9, 6],
                    "completed": true,
                    "onTime": true,
                    "upgrades": 2,
                    "durationMs": 1_740_000,
                },
            })),
            KIND_MYTHIC_PLUS,
        );

        assert_eq!(activity.confidence, 1.0);
        assert_eq!(activity.metadata["keystoneLevel"], 14);
        assert_eq!(activity.metadata["timed"], true);
        assert_eq!(activity.metadata["upgrades"], 2);
        assert_eq!(activity.metadata["durationSeconds"], 1740);
        assert_eq!(activity.metadata["affixes"], json!([9, 6]));
    }

    #[test]
    fn recognises_a_keystone_dungeon_with_no_run_recorded_but_admits_it_lacks_the_level() {
        let activity = only(
            &segment(json!({
                "instance": "Halls of Atonement",
                "instanceType": "party",
                "difficultyId": MYTHIC_KEYSTONE_DIFFICULTY,
                "seconds": 1800,
            })),
            KIND_MYTHIC_PLUS,
        );

        assert!(activity.confidence < 1.0);
        assert!(activity.metadata.get("keystoneLevel").is_none());
        assert_eq!(activity.metadata["durationSeconds"], 1800);
    }

    #[test]
    fn leaves_an_ordinary_dungeon_alone() {
        assert!(!kinds(&segment(json!({
            "instance": "Halls of Atonement",
            "instanceType": "party",
            "difficultyId": 2,
        })))
        .contains(&KIND_MYTHIC_PLUS.to_string()));
    }

    #[test]
    fn separates_a_progress_raid_from_a_legacy_one_by_expansion_tier() {
        let current = segment(json!({
            "instance": "Nerub-ar Palace",
            "instanceType": "raid",
            "difficulty": "Mythic",
            "expansionTier": 11,
            "latestExpansionTier": 11,
        }));
        let old = segment(json!({
            "instance": "Ulduar",
            "instanceType": "raid",
            "difficulty": "25 Player",
            "expansionTier": 3,
            "latestExpansionTier": 11,
        }));

        assert_eq!(kinds(&current), vec![KIND_PROGRESS_RAID]);
        assert_eq!(kinds(&old), vec![KIND_LEGACY_RAID]);
    }

    #[test]
    fn counts_kills_and_wipes_separately() {
        let activity = only(
            &segment(json!({
                "instance": "Nerub-ar Palace",
                "instanceType": "raid",
                "difficulty": "Heroic",
                "expansionTier": 11,
                "latestExpansionTier": 11,
                "encounters": [
                    { "id": 1, "success": false },
                    { "id": 1, "success": false },
                    { "id": 1, "success": true },
                    { "id": 2, "success": true },
                ],
            })),
            KIND_PROGRESS_RAID,
        );

        assert_eq!(activity.metadata["bossesKilled"], 2);
        assert_eq!(activity.metadata["wipes"], 2);
        assert_eq!(activity.metadata["difficulty"], "Heroic");
    }

    #[test]
    fn calls_a_raid_of_unknown_vintage_legacy_but_says_it_is_unsure() {
        let activity = only(
            &segment(json!({ "instance": "Ulduar", "instanceType": "raid" })),
            KIND_LEGACY_RAID,
        );

        assert!(activity.confidence < 0.9);
    }

    #[test]
    fn calls_a_segment_levelling_once_it_is_worth_a_twentieth_of_a_level() {
        let below = segment(json!({
            "experience": { "gained": 400, "percent": 0.04, "startLevel": 41, "endLevel": 41 },
        }));
        let above = segment(json!({
            "experience": { "gained": 900, "percent": 0.09, "startLevel": 41, "endLevel": 41 },
        }));

        assert!(kinds(&below).is_empty());
        let activity = only(&above, KIND_LEVELLING);
        assert_eq!(activity.metadata["experienceGained"], 900);
        assert_eq!(activity.metadata["percentOfLevel"], 9.0);
        assert_eq!(activity.metadata["levelsGained"], 0);
    }

    #[test]
    fn calls_any_level_up_levelling_however_little_experience_it_took() {
        let activity = only(
            &segment(json!({
                "levelUps": [{ "level": 42 }],
                "experience": { "gained": 1, "percent": 0.0001, "startLevel": 41, "endLevel": 42 },
            })),
            KIND_LEVELLING,
        );

        assert_eq!(activity.metadata["levelsGained"], 1);
        assert_eq!(activity.metadata["endLevel"], 42);
    }

    #[test]
    fn describes_a_raid_night_that_was_also_a_levelling_night_as_both() {
        assert_eq!(
            kinds(&segment(json!({
                "instance": "Ulduar",
                "instanceType": "raid",
                "expansionTier": 3,
                "latestExpansionTier": 11,
                "experience": { "gained": 50_000, "percent": 1.4, "startLevel": 41, "endLevel": 42 },
            }))),
            vec![KIND_LEGACY_RAID, KIND_LEVELLING]
        );
    }

    #[test]
    fn never_guesses_the_same_kind_twice_for_one_segment() {
        let activities = infer(&segment(json!({
            "instance": "Nerub-ar Palace",
            "instanceType": "raid",
            "difficultyId": MYTHIC_KEYSTONE_DIFFICULTY,
            "expansionTier": 11,
            "latestExpansionTier": 11,
            "keystone": { "level": 10, "completed": true },
            "levelUps": [{ "level": 42 }],
        })));

        let mut seen: Vec<&str> = activities.iter().map(|entry| entry.kind.as_str()).collect();
        seen.sort_unstable();
        let count = seen.len();
        seen.dedup();
        assert_eq!(seen.len(), count, "a kind was guessed more than once");
    }
}
