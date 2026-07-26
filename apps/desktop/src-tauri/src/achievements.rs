//! What the game says about an achievement the addon only recorded the number of.
//!
//! A segment arrives from the addon carrying an achievement id and, when the client happened
//! to have it loaded, a name. Everything else the game shows a player — the sentence
//! describing what to do, what earning it grants, the tree it is filed in, what it is worth,
//! the picture beside it — lives in two of the client's own tables. `Achievement` is the
//! achievements themselves and `Achievement_Category` is the tree; [`read`] joins the two
//! and answers for the handful of ids a window is actually showing.
//!
//! The column numbers below were read off a real install and are written down, with what
//! each was checked against, in `docs/game-files.md`. A game patch can reorder them, which
//! would show wrong values rather than fail — so anything derived from them is checked
//! against something a wrong column could not produce, and `examples/dump_achievements.rs`
//! is the tool for doing that against an install again.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;

/// What the game calls each table.
const ACHIEVEMENT: u32 = 1_260_179;
const ACHIEVEMENT_CATEGORY: u32 = 1_324_299;

/// Columns of `Achievement`, in the order the file stores them.
mod column {
    pub const DESCRIPTION: usize = 0;
    pub const TITLE: usize = 1;
    pub const REWARD: usize = 2;
    pub const FACTION: usize = 5;
    pub const CATEGORY: usize = 7;
    /// Not the number of points on its own — see [`super::points_of`].
    pub const POINTS: usize = 9;
    pub const ICON_FILE_ID: usize = 12;
}

/// Columns of `Achievement_Category`. A category names its parent and nothing else, which is
/// what makes the tree something to walk rather than something to read.
mod category_column {
    pub const NAME: usize = 0;
    pub const PARENT: usize = 2;
}

/// Which bits of the points column are the points.
///
/// The rest of it is not. Measured on build 12.0.5.67, every one of the 13,732 rows an
/// install could read carries `0x3C00` above the low byte, and the low byte is one of the
/// ten values the game awards — 0, 5, 10, 15, 20, 25, 30, 40, 50, 100. Feats of strength and
/// the legacy tree come out at nothing, which is what they are worth, and the achievements
/// whose worth is common knowledge come out right. Taking the byte rather than subtracting
/// the constant is what keeps a build that changed it from reporting an enormous number.
const POINTS: u32 = 0xFF;

/// How far up the category tree a walk will go before deciding the table is lying to it.
///
/// The real tree is two deep. A parent chain that loops would otherwise hang the read, and a
/// table that has been reordered by a patch is exactly where a loop would come from.
const DEEPEST_CATEGORY: usize = 8;

/// The game's own numbering for who an achievement is for. Anything else belongs to both.
pub const HORDE: i32 = 0;
pub const ALLIANCE: i32 = 1;

/// One achievement, in the words and pictures the game shows it with.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Achievement {
    pub id: u32,
    pub title: String,
    /// What has to be done to earn it, as one sentence.
    pub description: String,
    /// What earning it grants, when it grants anything: a title, a mount, a tabard. Empty for
    /// most of them, which is why it is a string rather than an absence.
    pub reward: String,
    /// The tree it is filed under, outermost first — `["Dungeons & Raids", "Lich King
    /// Dungeon"]`. Empty when the category is one this install cannot read, and one deep
    /// rather than two when the walk up runs into a category it cannot read.
    pub category: Vec<String>,
    pub category_id: u32,
    /// What it is worth. Zero is an answer: feats of strength and the legacy tree are worth
    /// nothing at all, and roughly half the table is one of those.
    pub points: u32,
    /// The picture beside it, as a FileDataID to be decoded through `icons`.
    pub icon_file_data_id: u32,
    /// Which side it belongs to: [`HORDE`], [`ALLIANCE`], or `-1` for both, which nearly
    /// every achievement is.
    pub faction: i32,
}

/// The points an achievement is worth, out of the column the game packs them into.
fn points_of(stored: u32) -> u32 {
    stored & POINTS
}

/// Looks up the achievements a window is showing, and nothing else.
///
/// The ids come from segments the addon recorded, so most of a 13,000-row table is beside
/// the point; what costs is opening the game's storage at all, which is why this takes every
/// id a caller wants at once rather than one at a time.
///
/// `None` against an id is an answer rather than a failure. The game encrypts the content it
/// has not shipped, so an achievement earned on a build newer than this install — or one the
/// addon recorded and a later patch removed — is a row that is simply not there, and a
/// segment still has to draw the rest of its list.
pub fn read(
    files: &dyn GameFiles,
    wanted: &[u32],
) -> Result<Vec<(u32, Option<Achievement>)>, String> {
    if wanted.is_empty() {
        return Ok(Vec::new());
    }

    let table = Db2::parse(files.read(ACHIEVEMENT)?)?;
    let rows: HashMap<u32, Achievement> = table
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| {
            let id = row.id();
            (
                id,
                Achievement {
                    id,
                    title: row.text(column::TITLE),
                    description: row.text(column::DESCRIPTION),
                    reward: row.text(column::REWARD),
                    category: Vec::new(),
                    category_id: row.number(column::CATEGORY),
                    points: points_of(row.number(column::POINTS)),
                    icon_file_data_id: row.number(column::ICON_FILE_ID),
                    faction: row.number(column::FACTION) as i32,
                },
            )
        })
        .collect();

    // The tree is only worth reading for the achievements that were found, and it is a
    // separate file — so an install that answered for none of them is not opened again.
    let tree = if rows.is_empty() {
        Tree::default()
    } else {
        Tree::read(files)?
    };

    Ok(wanted
        .iter()
        .map(|id| {
            let found = rows.get(id).cloned().map(|achievement| Achievement {
                category: tree.path(achievement.category_id),
                ..achievement
            });
            (*id, found)
        })
        .collect())
}

/// The category tree, as the names and the parent of each category.
#[derive(Default)]
struct Tree {
    names: HashMap<u32, String>,
    parents: HashMap<u32, u32>,
}

impl Tree {
    fn read(files: &dyn GameFiles) -> Result<Self, String> {
        let table = Db2::parse(files.read(ACHIEVEMENT_CATEGORY)?)?;
        let mut tree = Self::default();
        for row in table.rows() {
            tree.names.insert(row.id(), row.text(category_column::NAME));
            tree.parents
                .insert(row.id(), row.number(category_column::PARENT));
        }
        Ok(tree)
    }

    /// The names from the outermost category down to this one.
    ///
    /// A root names `-1` as its parent, which is where the walk stops. It also stops at a
    /// category this install cannot read, because the row that would name the parent came
    /// through encrypted — so a path can be shorter than the tree is deep, and empty when
    /// the achievement's own category is one of those.
    fn path(&self, category_id: u32) -> Vec<String> {
        let mut path = Vec::new();
        let mut at = category_id;
        for _ in 0..DEEPEST_CATEGORY {
            let Some(name) = self.names.get(&at) else {
                break;
            };
            path.push(name.clone());
            match self.parents.get(&at) {
                Some(parent) if *parent != at => at = *parent,
                _ => break,
            }
        }
        path.reverse();
        path
    }
}

/// The achievements looked up so far, kept for as long as the app runs.
///
/// What the game says about an achievement cannot change under a running app — it is read
/// out of the installed client — and a reader walking their history meets the same
/// achievements over and over, once per segment that mentions them. Remembering them is
/// mostly about not opening the game's storage again, which costs a couple of hundred
/// megabytes of transient memory each time.
///
/// An id the tables answered nothing for is remembered as such, for the same reason: the
/// answer is a fact about the install rather than about the moment.
#[derive(Default)]
pub struct AchievementBook {
    known: Mutex<HashMap<u32, Option<Achievement>>>,
}

impl AchievementBook {
    /// Which of the ids asked for have not been looked up yet, without repeats.
    pub fn missing(&self, wanted: &[u32]) -> Vec<u32> {
        let known = self.known.lock().expect("the achievement book is not poisoned");
        let mut missing: Vec<u32> = Vec::new();
        for id in wanted {
            if *id != 0 && !known.contains_key(id) && !missing.contains(id) {
                missing.push(*id);
            }
        }
        missing
    }

    pub fn store(&self, found: Vec<(u32, Option<Achievement>)>) {
        let mut known = self.known.lock().expect("the achievement book is not poisoned");
        known.extend(found);
    }

    /// The answer to a request: the achievements among those asked for that this install can
    /// describe, keyed by the id the segment named them by.
    ///
    /// The ones it cannot are left out rather than sent as null, because a segment that
    /// mentions an achievement the game says nothing about draws it exactly as it would
    /// before the lookup had come back — the addon's own name, and no more.
    pub fn answer(&self, wanted: &[u32]) -> Value {
        let known = self.known.lock().expect("the achievement book is not poisoned");
        let mut achievements = serde_json::Map::new();
        for id in wanted {
            if let Some(Some(found)) = known.get(id) {
                achievements.insert(id.to_string(), json!(found));
            }
        }
        json!({ "achievements": Value::Object(achievements) })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{achievement_fixture_files, DirFiles};

    /// The invented achievements, by the id a segment would name them under.
    const LIGHTHOUSE: u32 = 101;
    const UNSEEN: u32 = 102;
    const EMBERFORGE: u32 = 103;
    const ALLIANCE_SKIRMISH: u32 = 104;
    const HORDE_SKIRMISH: u32 = 105;
    /// Filed under a category whose parent is one the game encrypts.
    const ODDMENTS: u32 = 106;
    /// Worth nothing, the way a feat of strength is.
    const LONG_ROAD: u32 = 107;
    /// Filed under a category no row of the tree names.
    const NOWHERE: u32 = 108;
    /// An achievement the game keeps encrypted, so nothing can be said about it.
    const WITHHELD: u32 = 900;
    /// An id no row of the table carries at all.
    const ABSENT: u32 = 4242;

    /// Game files that remember what was asked of them. Which of the game's tables a read
    /// opens is part of the behaviour: both are parsed once for a batch, and neither for a
    /// batch there is nothing to say about.
    struct Noted {
        files: DirFiles,
        asked: RefCell<Vec<u32>>,
    }

    impl Noted {
        fn new() -> Self {
            Self {
                files: achievement_fixture_files(),
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl GameFiles for Noted {
        fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
            self.asked.borrow_mut().push(fdid);
            self.files.read(fdid)
        }
    }

    fn read_all(wanted: &[u32]) -> Vec<(u32, Option<Achievement>)> {
        read(&achievement_fixture_files(), wanted).unwrap()
    }

    fn one(id: u32) -> Achievement {
        read_all(&[id])
            .into_iter()
            .next()
            .and_then(|(_, found)| found)
            .unwrap_or_else(|| panic!("the fixture holds achievement {id}"))
    }

    // Everything the window shows about an achievement comes out of one row of one table, so
    // the whole thing is written out here rather than a field at a time.
    #[test]
    fn reads_an_achievement_down_to_the_words_the_game_shows_it_with() {
        assert_eq!(
            one(UNSEEN),
            Achievement {
                id: 102,
                title: "Deeper into the Light".into(),
                description: "Reach the lighthouse without being seen.".into(),
                reward: "Reward: Title & the lamplighter's coat".into(),
                category: vec!["Chronicles".into(), "Tideglass Deeps".into()],
                category_id: 10,
                points: 25,
                icon_file_data_id: 250002,
                faction: -1,
            }
        );
    }

    // Most achievements grant nothing, and the game says so by leaving the string out
    // entirely rather than by writing anything.
    #[test]
    fn leaves_the_reward_empty_for_an_achievement_that_grants_nothing() {
        assert_eq!(one(LIGHTHOUSE).reward, "");
        assert_eq!(one(LIGHTHOUSE).title, "Into the Light");
    }

    // The tree is what turns a category number into somewhere a reader recognises, and the
    // walk up it has three endings: a root, a parent this install cannot read, and a category
    // that is not in the table at all.
    #[test]
    fn files_an_achievement_under_the_tree_the_game_keeps_it_in() {
        let paths: Vec<(u32, Vec<String>)> = read_all(&[LIGHTHOUSE, EMBERFORGE, ODDMENTS, NOWHERE])
            .into_iter()
            .map(|(id, found)| (id, found.map(|found| found.category).unwrap_or_default()))
            .collect();
        assert_eq!(
            paths,
            vec![
                (LIGHTHOUSE, vec!["Chronicles".to_string(), "Tideglass Deeps".to_string()]),
                (EMBERFORGE, vec!["Chronicles".to_string(), "Emberforge Halls".to_string()]),
                // Its category's parent is encrypted, so the trail stops one short of a root
                // rather than being followed to a name that is not there.
                (ODDMENTS, vec!["Lost Ledgers".to_string()]),
                // Filed under a category the tree does not name at all.
                (NOWHERE, Vec::new()),
            ]
        );
        // The number is answered with as well as the names, because a category the tree says
        // nothing about is still something the row said.
        assert_eq!(one(NOWHERE).category_id, 777);
    }

    // The game does not store the number of points; it stores that number inside a larger
    // one, on every row. A reader that took the column at face value would report every
    // achievement as being worth fifteen thousand.
    #[test]
    fn reads_the_points_out_of_the_value_the_game_packs_them_into() {
        let worth: Vec<(u32, u32)> = read_all(&[LIGHTHOUSE, UNSEEN, ODDMENTS, LONG_ROAD])
            .into_iter()
            .filter_map(|(id, found)| found.map(|found| (id, found.points)))
            .collect();
        assert_eq!(
            worth,
            // The last is worth nothing, which is what a feat of strength is worth and what
            // half the real table comes to.
            vec![(LIGHTHOUSE, 10), (UNSEEN, 25), (ODDMENTS, 5), (LONG_ROAD, 0)]
        );
        // The fixture stores what the game stores, so a reader that took the column whole
        // would answer with 0x3C0A here rather than with 10.
        assert!(
            read_all(&[LIGHTHOUSE])[0].1.as_ref().unwrap().points < 0x3C00,
            "the packing was carried through into the answer"
        );
    }

    // Nearly every achievement belongs to both sides, which is why the game keeps this column
    // sparsely: a reader that missed the sparse storage would report every one of them as
    // belonging to whichever side is numbered zero.
    #[test]
    fn says_which_side_an_achievement_belongs_to_when_it_belongs_to_one() {
        let sides: Vec<(u32, i32)> = read_all(&[ALLIANCE_SKIRMISH, HORDE_SKIRMISH, LIGHTHOUSE])
            .into_iter()
            .filter_map(|(id, found)| found.map(|found| (id, found.faction)))
            .collect();
        assert_eq!(
            sides,
            vec![
                (ALLIANCE_SKIRMISH, ALLIANCE),
                (HORDE_SKIRMISH, HORDE),
                (LIGHTHOUSE, -1),
            ]
        );
    }

    // Two ways an id can go unanswered, and neither is a reason to fail the batch: the rest
    // of a session's achievements still have to be described.
    #[test]
    fn answers_with_nothing_for_an_achievement_this_install_cannot_describe() {
        let found = read_all(&[LIGHTHOUSE, WITHHELD, ABSENT]);
        let named: Vec<(u32, bool)> = found
            .iter()
            .map(|(id, found)| (*id, found.is_some()))
            .collect();
        assert_eq!(named, vec![(LIGHTHOUSE, true), (WITHHELD, false), (ABSENT, false)]);
    }

    // Both tables are parsed once however many achievements a batch asks about, and the
    // answer keeps the order it was asked in.
    #[test]
    fn opens_each_table_once_for_a_whole_batch() {
        let files = Noted::new();
        let found = read(&files, &[EMBERFORGE, LIGHTHOUSE, ODDMENTS]).unwrap();
        assert_eq!(
            found.iter().map(|(id, _)| *id).collect::<Vec<u32>>(),
            vec![EMBERFORGE, LIGHTHOUSE, ODDMENTS]
        );
        assert_eq!(files.asked.into_inner(), vec![ACHIEVEMENT, ACHIEVEMENT_CATEGORY]);
    }

    // The tree is a second file, and a batch nothing could be found for has nothing to file.
    #[test]
    fn does_not_read_the_tree_for_a_batch_it_can_describe_nothing_of() {
        let files = Noted::new();
        assert_eq!(read(&files, &[WITHHELD, ABSENT]).unwrap().len(), 2);
        assert_eq!(files.asked.into_inner(), vec![ACHIEVEMENT]);
    }

    #[test]
    fn reads_nothing_at_all_when_nothing_was_asked_for() {
        let files = Noted::new();
        assert_eq!(read(&files, &[]).unwrap(), Vec::new());
        assert_eq!(files.asked.into_inner(), Vec::<u32>::new());
    }

    #[test]
    fn says_so_when_a_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = read(&DirFiles::new(temp.path()), &[LIGHTHOUSE]).unwrap_err();
        assert!(error.contains("1260179.db2"), "{error}");
    }

    /* ---------- the book ---------- */

    // A session mentions the same achievement once per segment it was earned in, and a reader
    // walking their history meets the same ones over and over — so what the book saves is
    // opening the game's storage, which is the expensive half by a wide margin.
    #[test]
    fn looks_an_achievement_up_the_first_time_it_is_named_and_not_again() {
        let files = Noted::new();
        let book = AchievementBook::default();

        let first = book.missing(&[LIGHTHOUSE, UNSEEN]);
        assert_eq!(first, vec![LIGHTHOUSE, UNSEEN]);
        book.store(read(&files, &first).unwrap());

        // A second segment naming one of the same achievements, plus one of its own.
        let second = book.missing(&[LIGHTHOUSE, EMBERFORGE]);
        assert_eq!(second, vec![EMBERFORGE]);
        book.store(read(&files, &second).unwrap());

        assert_eq!(
            files.asked.into_inner(),
            vec![ACHIEVEMENT, ACHIEVEMENT_CATEGORY, ACHIEVEMENT, ACHIEVEMENT_CATEGORY]
        );
        let answer = book.answer(&[LIGHTHOUSE, UNSEEN, EMBERFORGE]);
        assert_eq!(answer["achievements"].as_object().unwrap().len(), 3);
    }

    // Whether an install can describe an achievement is a fact about the install, so asking
    // again would cost a storage open to arrive back at the same nothing.
    #[test]
    fn does_not_go_looking_again_for_an_achievement_it_already_failed_to_find() {
        let book = AchievementBook::default();
        book.store(read(&achievement_fixture_files(), &book.missing(&[WITHHELD, ABSENT])).unwrap());

        assert_eq!(book.missing(&[WITHHELD, ABSENT]), Vec::<u32>::new());
        assert_eq!(book.answer(&[WITHHELD, ABSENT])["achievements"], json!({}));
    }

    // A window asks with the list its segments carry, which repeats an achievement earned on
    // two characters and can hold the zero an event with no id at all comes across as.
    #[test]
    fn asks_after_one_achievement_however_many_segments_name_it() {
        let book = AchievementBook::default();
        assert_eq!(
            book.missing(&[LIGHTHOUSE, LIGHTHOUSE, 0, UNSEEN, LIGHTHOUSE]),
            vec![LIGHTHOUSE, UNSEEN]
        );
    }

    // The window keys what it draws by the id the segment carries, so the answer is keyed the
    // same way rather than positionally — half of a request can be missing.
    #[test]
    fn keys_what_it_answers_with_by_the_id_the_segment_named() {
        let book = AchievementBook::default();
        book.store(read(&achievement_fixture_files(), &[LIGHTHOUSE, WITHHELD]).unwrap());
        let answer = book.answer(&[LIGHTHOUSE, WITHHELD]);
        assert_eq!(answer["achievements"]["101"]["title"], json!("Into the Light"));
        assert_eq!(answer["achievements"]["101"]["points"], json!(10));
        assert_eq!(
            answer["achievements"]["101"]["category"],
            json!(["Chronicles", "Tideglass Deeps"])
        );
        assert_eq!(answer["achievements"]["101"]["iconFileDataId"], json!(250001));
        assert_eq!(answer["achievements"][WITHHELD.to_string()], Value::Null);
    }
}
