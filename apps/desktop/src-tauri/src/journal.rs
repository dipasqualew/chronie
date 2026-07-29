//! The picture the game draws a dungeon, a raid or a delve with.
//!
//! Every segment this app files arrives from the addon under the name of the place it happened
//! in — "Deadmines", "Nerub-ar Palace", "Earthcrawl Mines" — and a name is all it arrives as,
//! because the client reports the place a player is standing in by its localised name and nothing
//! else. That is also the key the addon's own `ExpansionIndex` files an instance under, for the
//! same reason. So the errand here is a name to a picture, and the name is the join.
//!
//! Two tables, because neither one is the whole answer.
//!
//! - **`JournalInstance`** is the Encounter Journal's own list: 211 rows, 209 of which name a
//!   128×128 button icon drawn for that dungeon and no other. It is the picture the game puts
//!   beside a raid, and where it has an opinion it is the one worth having.
//! - **`LFGDungeons`** is what the group finder lists, which is 1,825 rows and a far wider net:
//!   every delve, every scenario, and the six hundred names the journal has no row for at all.
//!   Where both tables know a name they agree on the icon 581 times out of 619, so the journal
//!   goes first and this fills in behind it.
//!
//! Together they answer for 805 places. Everywhere else draws no picture, and most names are
//! everywhere else: an open-world zone is a name neither table has heard of.
//!
//! **Those are the only two tables in the game with an icon for any of the things a segment is
//! filed under.** An expansion, a zone, a faction and a boss are each named on rows that hold no
//! picture — `JournalTier`, `UiMap`, `Faction` and `JournalEncounter` have no icon column between
//! them — so those are drawn without one. `docs/game-files.md` records what was looked at.
//!
//! The column numbers below were read off a real install with `examples/dump_journal.rs`, which
//! is what to run again after a patch: a reordered table shows wrong values rather than failing.

use std::collections::HashMap;

use crate::casc::GameFiles;
use crate::db2::Db2;

/// `JournalInstance` — the Encounter Journal's dungeons and raids.
pub const JOURNAL_INSTANCE: u32 = 1_237_438;

/// `LFGDungeons` — everything the group finder can put a player in, delves included.
pub const LFG_DUNGEONS: u32 = 1_361_033;

/// Columns of `JournalInstance`, an ordinary table of fixed-size records whose id sits in a list
/// beside the rows rather than in a column of its own.
///
/// **Read off build 12.0.5.67823 with `examples/dump_journal.rs`**; `docs/game-files.md` records
/// what each was checked against. The table holds four FileDataIDs side by side and only one of
/// them is an icon — the others are a 512×512 background, a 256×128 button banner and a 512×512
/// lore illustration — so taking the wrong one of the four hands the window a picture far too
/// large for the space, which is the symptom to look for.
pub mod journal_column {
    /// What the instance is called, in the locale the install is running in.
    pub const NAME: usize = 0;
    /// The picture beside it, as a FileDataID to be decoded through [`crate::icons`]. Every one
    /// of the 209 the table names decodes at 128×128, which is what makes this the one of the
    /// four files an icon can be.
    pub const BUTTON_SMALL_FILE_DATA_ID: usize = 5;
}

/// Columns of `LFGDungeons`, the same shape of table: fixed-size records, ids in a list beside
/// them, strings in a block of their own.
///
/// **Read off build 12.0.5.67823 with `examples/dump_journal.rs`.**
pub mod lfg_column {
    /// What the group finder calls the place, in the locale the install is running in.
    pub const NAME: usize = 0;
    /// The picture beside it in the finder's list, as a FileDataID.
    pub const ICON_TEXTURE_FILE_ID: usize = 5;
}

/// The icon each of the places asked for is drawn with, as a FileDataID, keyed by the name it was
/// asked for under.
///
/// Only the names asked for, because a window is showing the handful of places one evening was
/// spent in — and because what costs here is opening the game's storage at all, which is why this
/// takes every name a caller wants at once.
///
/// A name neither table says anything about is left out rather than answered with zero, and most
/// names are: every open-world zone a segment was filed under is a name neither has heard of, as
/// is any instance from a build newer than this install. Each of those is a line that draws
/// without a picture, which is what the line did before this existed.
///
/// The journal is read first and the group finder only fills in what it left: where both know a
/// place they usually agree, and where they do not the journal's is the picture drawn for that
/// dungeon rather than the one the finder shows every entry of a kind.
///
/// Matching is case-insensitive on a trimmed name. The client and the tables agree on the case of
/// an instance today, and neither of them is this app's to depend on: a place name is a string the
/// client handed over, and it costs nothing to stop a stray space at the end of one blanking the
/// row.
pub fn icons_of(files: &dyn GameFiles, wanted: &[String]) -> Result<HashMap<String, u32>, String> {
    let keys: Vec<(String, &String)> = wanted
        .iter()
        .map(|name| (key_of(name), name))
        .filter(|(key, _)| !key.is_empty())
        .collect();
    let mut found = HashMap::new();
    if keys.is_empty() {
        return Ok(found);
    }

    for (table, name_column, icon_column) in [
        (
            JOURNAL_INSTANCE,
            journal_column::NAME,
            journal_column::BUTTON_SMALL_FILE_DATA_ID,
        ),
        (
            LFG_DUNGEONS,
            lfg_column::NAME,
            lfg_column::ICON_TEXTURE_FILE_ID,
        ),
    ] {
        let table = Db2::parse(files.read(table)?)?;
        for row in table.rows() {
            let icon = row.number(icon_column);
            if icon == 0 {
                continue;
            }
            let name = key_of(&row.text(name_column));
            for (key, asked) in &keys {
                // The first row to name a place wins: a handful of names are on two rows of one
                // table, and the group finder repeats a dungeon once per difficulty it offers.
                if *key == name && !found.contains_key(*asked) {
                    found.insert((*asked).clone(), icon);
                }
            }
        }
    }
    Ok(found)
}

/// One place name reduced to what two spellings of it have in common.
fn key_of(name: &str) -> String {
    name.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::journal_fixture_files;

    /// The fixtures' places and the icons they name. See `scripts/make-journal-fixtures.ts`.
    const DEADMINES: &str = "The Deadmines";
    const DEADMINES_ICON: u32 = 170001;
    const CITADEL: &str = "Sunken Citadel";
    const CITADEL_ICON: u32 = 170002;
    /// A delve, which only the group finder's table holds — as every real delve is.
    const DELVE: &str = "Grubwarden's Burrow";
    const DELVE_ICON: u32 = 170003;
    /// A place both tables hold, drawn differently in each. The journal's is the one to show.
    const DISPUTED: &str = "Tideglass Hollow";
    const DISPUTED_JOURNAL_ICON: u32 = 170004;
    /// An instance the journal lists and draws nothing for, which the real table has two of.
    const UNDRAWN: &str = "Zekvir's Lair";

    fn names(of: &[&str]) -> Vec<String> {
        of.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn answers_the_icon_each_instance_names() {
        let found = icons_of(&journal_fixture_files(), &names(&[DEADMINES, CITADEL])).unwrap();
        assert_eq!(found.get(DEADMINES), Some(&DEADMINES_ICON));
        assert_eq!(found.get(CITADEL), Some(&CITADEL_ICON));
    }

    /// Delves are not in the Encounter Journal at all — one lair aside, not one of them has a row
    /// — so reading only the journal would leave every delve a player runs blank.
    #[test]
    fn answers_for_a_delve_the_journal_has_no_row_for() {
        let found = icons_of(&journal_fixture_files(), &names(&[DELVE])).unwrap();
        assert_eq!(found.get(DELVE), Some(&DELVE_ICON));
    }

    /// The journal's picture is drawn for that dungeon and no other; the finder shows a good many
    /// entries the same generic one. So where they disagree the journal is the one to believe.
    #[test]
    fn prefers_the_journals_picture_over_the_group_finders() {
        let found = icons_of(&journal_fixture_files(), &names(&[DISPUTED])).unwrap();
        assert_eq!(found.get(DISPUTED), Some(&DISPUTED_JOURNAL_ICON));
    }

    /// Nearly every name this is asked about is an open-world zone, which neither table has a row
    /// for. That is the ordinary case rather than the exceptional one.
    #[test]
    fn leaves_out_a_place_neither_table_has_heard_of() {
        let found = icons_of(&journal_fixture_files(), &names(&[DEADMINES, "Durotar"])).unwrap();
        assert_eq!(found.len(), 1);
        assert!(!found.contains_key("Durotar"));
    }

    /// A row that names no icon is not a row with an icon of zero: nothing decodes FileDataID
    /// zero, and answering with it would have the window asking for a picture that cannot exist.
    #[test]
    fn leaves_out_a_place_that_names_no_icon() {
        let found = icons_of(&journal_fixture_files(), &names(&[UNDRAWN])).unwrap();
        assert!(found.is_empty());
    }

    /// The name comes back the way it was asked for, whatever case the table spells it in — the
    /// window keys what it draws by the string on the segment and has nothing else to look it up
    /// under.
    #[test]
    fn answers_under_the_name_it_was_asked_under() {
        let found = icons_of(&journal_fixture_files(), &names(&["  the deadmines "])).unwrap();
        assert_eq!(found.get("  the deadmines "), Some(&DEADMINES_ICON));
    }

    /// Nothing asked about reads nothing at all: opening the game's storage to answer an empty
    /// question is the one cost worth dodging outright.
    #[test]
    fn answers_nothing_when_nothing_was_asked_about() {
        assert!(icons_of(&journal_fixture_files(), &[]).unwrap().is_empty());
        assert!(icons_of(&journal_fixture_files(), &names(&["", "  "]))
            .unwrap()
            .is_empty());
    }
}
