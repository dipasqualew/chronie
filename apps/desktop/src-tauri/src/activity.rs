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
//! * `scenario` — the rest of `instanceType == "scenario"` once delves are taken out of it.
//!   Derivable today, but a Horrific Vision and a boost tutorial are not one activity, and
//!   nothing in a segment tells them apart.
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

/// The one difficulty every delve runs at, whatever tier its entrance was set to. Read off
/// `Difficulty.db2` on 12.0.5, where row 208 is "Delves" with `InstanceType` 5 — the same
/// scenario type the client reports for every other scenario, which is why the difficulty
/// rather than the type is what separates a delve from a Horrific Vision.
const DELVE_DIFFICULTY: i64 = 208;

/// How much of a level has to be earned before a segment is called levelling. Below this a
/// gain is just the incidental experience that comes from doing something else.
const LEVELLING_PERCENT_THRESHOLD: f64 = 0.05;

pub const KIND_MYTHIC_PLUS: &str = "mythic_plus";
pub const KIND_PROGRESS_RAID: &str = "progress_raid";
pub const KIND_LEGACY_RAID: &str = "legacy_raid";
pub const KIND_LEVELLING: &str = "levelling";
pub const KIND_PREY: &str = "prey";
pub const KIND_DELVE: &str = "delve";

/// Every kind this build knows how to name, for the desktop app's editor. A user is not
/// limited to these — a kind they type in is stored verbatim — but these are the ones the
/// inference can produce and the app can label.
pub const KNOWN_KINDS: &[&str] = &[
    KIND_MYTHIC_PLUS,
    KIND_PROGRESS_RAID,
    KIND_LEGACY_RAID,
    KIND_LEVELLING,
    KIND_PREY,
    KIND_DELVE,
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

/// How a completed prey hunt names itself in the quest log: `Prey: <name> (<difficulty>)`.
///
/// Localised, and only the English form is matched. That is a real limit rather than an
/// oversight: the client offers nothing else to match on. A 12.0.5 binary exposes exactly
/// `C_QuestLog.GetActivePreyQuest`, a `PreyHuntProgress` widget and an
/// `Enum.PreyHuntProgressState` of Cold/Warm/Final — enough for the addon to know *which*
/// quest is the hunt in progress, and nothing anywhere that names the hunt or its difficulty
/// apart from the title itself. Matching the title here rather than in the addon is what
/// makes a hunt recognisable in history recorded before anybody went looking for one, and
/// what lets a better rule be re-run over that history later.
const PREY_TITLE_PREFIX: &str = "Prey: ";

/// One hunt, as its quest title spelled it.
struct PreyHunt {
    title: String,
    /// Absent when the title carried no trailing parenthetical — the hunt still happened.
    difficulty: Option<String>,
}

/// Reads a quest title as a prey hunt, or decides it was not one.
///
/// The difficulty is the *last* parenthetical, so a prey whose own name contains brackets
/// keeps them. A title that is only the prefix names nothing and is not a hunt.
fn prey_hunt(title: &str) -> Option<PreyHunt> {
    let rest = title.trim().strip_prefix(PREY_TITLE_PREFIX)?.trim();
    if let Some(open) = rest.rfind('(') {
        if let Some(inside) = rest.strip_suffix(')') {
            let difficulty = inside[open + 1..].trim();
            let name = rest[..open].trim();
            if !name.is_empty() && !difficulty.is_empty() {
                return Some(PreyHunt {
                    title: name.to_string(),
                    difficulty: Some(difficulty.to_string()),
                });
            }
        }
    }
    if rest.is_empty() {
        return None;
    }
    Some(PreyHunt {
        title: rest.to_string(),
        difficulty: None,
    })
}

/// A prey hunt handed in during the segment, from the quests the addon already files.
///
/// A segment can hold several, and a kind may only be guessed once, so the activity names the
/// last hunt of the segment and counts the rest: the last one is what the player was doing
/// when the segment ended, and the count stops that reading as "this segment was one hunt".
///
/// Confidence separates the two ways a title can match. The full shape — a name and a
/// difficulty — is as sure as reading a keystone's own record. A bare `Prey: something` is
/// the prefix and a guess about what follows it, and says so.
fn prey(segment: &Segment) -> Option<Activity> {
    let hunts: Vec<PreyHunt> = segment
        .quests
        .iter()
        .filter_map(|quest| quest.name.as_deref())
        .filter_map(prey_hunt)
        .collect();

    let last = hunts.last()?;
    Some(Activity::new(
        KIND_PREY,
        if last.difficulty.is_some() { 0.9 } else { 0.6 },
        compact(json!({
            "title": last.title,
            "difficulty": last.difficulty,
            "huntsCompleted": hunts.len(),
        })),
    ))
}

/// A delve, from the difficulty the client filed the instance under.
///
/// The delve names itself: a delve is an instance of its own and the segment is already named
/// for it, which is what lets this recognise every delve in history, including the ones
/// recorded long before the addon knew what a delve was.
///
/// What the difficulty cannot say is the tier — every tier is difficulty 208 — so a segment
/// the addon watched carries a run of its own, and that is where the tier and the story come
/// from. Confidence follows the tier rather than the delve: which delve it was is certain
/// either way, and a tier nobody recorded is the one thing anybody would want back.
///
/// The story is a scenario id because there is no name to give. Each delve has three to six
/// of them, every one a `Scenario` row of its own whose steps all carry the delve's name, so
/// the id is the only thing that tells one telling from another.
fn delve(segment: &Segment) -> Option<Activity> {
    if segment.instance_type != "scenario" || segment.difficulty_id != Some(DELVE_DIFFICULTY) {
        return None;
    }
    let name = segment.instance.as_str();
    let Some(run) = segment.delve.as_ref() else {
        return Some(Activity::new(
            KIND_DELVE,
            0.5,
            json!({ "delve": name, "durationSeconds": segment.seconds }),
        ));
    };

    // The run's own clock when it has one, because a segment lasts as long as the player
    // stayed in the instance and a delve ends when it is finished, not when they walk out.
    let seconds = match (run.started_at, run.completed_at) {
        (Some(started), Some(completed)) if completed >= started => completed - started,
        _ => segment.seconds,
    };
    Some(Activity::new(
        KIND_DELVE,
        if run.tier.is_some() { 1.0 } else { 0.5 },
        compact(json!({
            "delve": name,
            "tier": run.tier,
            "storyId": run.scenario_id,
            "completed": run.completed,
            "durationSeconds": seconds,
        })),
    ))
}

/// Every guess this build can make about one segment.
///
/// More than one may apply at once and that is not a conflict: a levelling raid night is
/// honestly both. What cannot happen is two guesses of the same kind, because a kind is how
/// a user's suppression of a guess is matched back to it on the next sync.
pub fn infer(segment: &Segment) -> Vec<Activity> {
    [
        mythic_plus(segment),
        raid(segment),
        levelling(segment),
        prey(segment),
        delve(segment),
    ]
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
    fn reads_a_prey_hunt_off_the_quest_it_was_handed_in_as() {
        let activity = only(
            &segment(json!({
                "instance": "Eversong Woods",
                "quests": [{ "id": 91_000, "name": "Prey: Gorgetusk (Heroic)" }],
            })),
            KIND_PREY,
        );

        assert_eq!(activity.confidence, 0.9);
        assert_eq!(activity.metadata["title"], "Gorgetusk");
        assert_eq!(activity.metadata["difficulty"], "Heroic");
        assert_eq!(activity.metadata["huntsCompleted"], 1);
    }

    // The rule is a string match on a title, so the thing it must not do is fire on a quest
    // that merely has the word in it.
    #[test]
    fn leaves_a_quest_that_is_only_named_after_prey_alone() {
        assert!(!kinds(&segment(json!({
            "quests": [
                { "id": 1, "name": "Preying on the Weak" },
                { "id": 2, "name": "Easy Prey" },
                { "id": 3, "name": "Prey:" },
            ],
        })))
        .contains(&KIND_PREY.to_string()));
    }

    #[test]
    fn names_the_last_hunt_of_a_segment_and_counts_the_rest() {
        let activity = only(
            &segment(json!({
                "quests": [
                    { "id": 1, "name": "Prey: Gorgetusk (Normal)" },
                    { "id": 2, "name": "An Errand" },
                    { "id": 3, "name": "Prey: Duskwing Matriarch (Mythic)" },
                ],
            })),
            KIND_PREY,
        );

        assert_eq!(activity.metadata["title"], "Duskwing Matriarch");
        assert_eq!(activity.metadata["difficulty"], "Mythic");
        assert_eq!(activity.metadata["huntsCompleted"], 2);
    }

    // A hunt with no difficulty in its title is still a hunt, and the difficulty is better
    // absent than invented — the same rule every other metadata field here follows.
    #[test]
    fn records_a_hunt_whose_title_named_no_difficulty_but_says_it_is_unsure() {
        let activity = only(
            &segment(json!({ "quests": [{ "id": 1, "name": "Prey: Gorgetusk" }] })),
            KIND_PREY,
        );

        assert!(activity.confidence < 0.9);
        assert_eq!(activity.metadata["title"], "Gorgetusk");
        assert!(activity.metadata.get("difficulty").is_none());
    }

    #[test]
    fn keeps_brackets_that_belong_to_the_preys_own_name() {
        let activity = only(
            &segment(json!({
                "quests": [{ "id": 1, "name": "Prey: Gorgetusk (the Elder) (Heroic)" }],
            })),
            KIND_PREY,
        );

        assert_eq!(activity.metadata["title"], "Gorgetusk (the Elder)");
        assert_eq!(activity.metadata["difficulty"], "Heroic");
    }

    // The addon only files a quest's title when it saw the quest in the log first, so a
    // nameless quest is an ordinary thing to meet rather than a broken record.
    #[test]
    fn guesses_nothing_from_a_quest_whose_title_was_never_recorded() {
        assert!(!kinds(&segment(json!({ "quests": [{ "id": 1 }] }))).contains(&KIND_PREY.to_string()));
    }

    // Nothing in a segment recorded before the addon knew what a delve was says which tier it
    // was run at, but the difficulty and the instance's own name are enough to know it was
    // one and which one — so it is still guessed, and still says the tier is missing.
    #[test]
    fn recognises_a_delve_with_no_run_recorded_but_admits_it_lacks_the_tier() {
        let activity = only(
            &segment(json!({
                "instance": "Fungal Folly",
                "instanceType": "scenario",
                "difficultyId": DELVE_DIFFICULTY,
                "seconds": 900,
            })),
            KIND_DELVE,
        );

        assert!(activity.confidence < 1.0);
        assert_eq!(activity.metadata["delve"], "Fungal Folly");
        assert!(activity.metadata.get("tier").is_none());
        assert_eq!(activity.metadata["durationSeconds"], 900);
    }

    // The run's own clock rather than the segment's, because a segment lasts as long as the
    // player stayed in the instance and a delve ends when it is finished, not when they leave.
    #[test]
    fn reads_a_delves_tier_and_story_off_the_run_itself() {
        let activity = only(
            &segment(json!({
                "instance": "Kriegval's Rest",
                "instanceType": "scenario",
                "difficultyId": DELVE_DIFFICULTY,
                "seconds": 1800,
                "delve": {
                    "tier": 8,
                    "scenarioId": 2680,
                    "startedAt": 2_000_000_000i64,
                    "completedAt": 2_000_000_780i64,
                    "completed": true,
                },
            })),
            KIND_DELVE,
        );

        assert_eq!(activity.confidence, 1.0);
        assert_eq!(activity.metadata["delve"], "Kriegval's Rest");
        assert_eq!(activity.metadata["tier"], 8);
        assert_eq!(activity.metadata["storyId"], 2680);
        assert_eq!(activity.metadata["completed"], true);
        assert_eq!(activity.metadata["durationSeconds"], 780);
    }

    // The addon can watch a delve start before the client will say which tier it is: the run
    // is real, the tier is the one thing missing, and confidence follows the tier.
    #[test]
    fn records_a_delve_whose_tier_was_never_answered_but_says_it_is_unsure() {
        let activity = only(
            &segment(json!({
                "instance": "Fungal Folly",
                "instanceType": "scenario",
                "difficultyId": DELVE_DIFFICULTY,
                "seconds": 600,
                "delve": { "scenarioId": 2680, "completed": false },
            })),
            KIND_DELVE,
        );

        assert!(activity.confidence < 1.0);
        assert_eq!(activity.metadata["storyId"], 2680);
        assert_eq!(activity.metadata["completed"], false);
        assert!(activity.metadata.get("tier").is_none());
        assert_eq!(activity.metadata["durationSeconds"], 600);
    }

    // Every scenario reports instanceType "scenario", which is exactly why the difficulty is
    // what the rule reads: a Horrific Vision runs at its own difficulty and is not a delve.
    #[test]
    fn leaves_a_scenario_that_is_not_a_delve_alone() {
        assert!(!kinds(&segment(json!({
            "instance": "Horrific Vision of Orgrimmar",
            "instanceType": "scenario",
            "difficultyId": 12,
        })))
        .contains(&KIND_DELVE.to_string()));
    }

    // Nonsense the client would never report, and that is the point: the difficulty is read
    // together with the type, so neither half alone can call something a delve.
    #[test]
    fn leaves_a_party_dungeon_at_the_delve_difficulty_alone() {
        assert!(!kinds(&segment(json!({
            "instance": "Halls of Atonement",
            "instanceType": "party",
            "difficultyId": DELVE_DIFFICULTY,
        })))
        .contains(&KIND_DELVE.to_string()));
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
