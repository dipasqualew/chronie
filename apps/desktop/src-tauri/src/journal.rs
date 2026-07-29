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
//! An expansion and a zone are still drawn without a picture — `JournalTier` and `UiMap` have no
//! icon column between them — so those rows read as they always did. `docs/game-files.md` records
//! what was looked at.
//!
//! ## And the bosses inside them
//!
//! A segment also carries the fights that ended in it, and those are a different question with a
//! different key: an encounter arrives as the `DungeonEncounterID` the client handed
//! `ENCOUNTER_END`, which is a number rather than a name. Two more tables turn it into the
//! portrait the Adventure Guide draws beside that boss. See [`portraits_of`].
//!
//! The column numbers below were read off a real install with `examples/dump_journal.rs`, which
//! is what to run again after a patch: a reordered table shows wrong values rather than failing.

use std::collections::HashMap;

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::tables::journal_encounter as encounter_column;
use crate::tables::journal_encounter_creature as creature_column;
use crate::tables::journal_instance as journal_column;
use crate::tables::lfg_dungeons as lfg_column;
use crate::tables::{
    JOURNAL_ENCOUNTER, JOURNAL_ENCOUNTER_CREATURE, JOURNAL_INSTANCE, LFG_DUNGEONS,
};

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

/// The portrait the Adventure Guide draws each of the fights asked about with, as a FileDataID,
/// keyed by the `DungeonEncounterID` it was asked for under.
///
/// The same bargain as [`icons_of`] and for the same reasons: only the fights a window is showing,
/// all of them in one call because what costs is opening the game's storage, and a fight the game
/// has no portrait for left out rather than answered with zero.
///
/// Unlike the places, the key needs no massaging. A segment's encounters carry the id the client
/// handed `ENCOUNTER_END`, which is a `DungeonEncounterID`, and that is a column of
/// `JournalEncounter` — so this is a join on numbers the game itself assigned rather than on a
/// localised string, and it lands on **1,071 of the 1,072** fights the journal knows an id for.
///
/// Two turns of the chain are worth knowing about, because each one is a wrong answer rather than
/// a missing one if it is skipped.
///
/// - **A fight can be several creatures, and they are not stored in the order the guide shows
///   them.** The Ascendant Council is five rows and the fifth of them is the one the guide leads
///   with; 11 of the 20 multi-portrait fights list their rows out of `OrderIndex` order. So the
///   lowest order index wins rather than the first row, which is what makes Theralion and Valiona
///   come back as Theralion and the Omnotron Defense System come back as Magmatron.
/// - **One `DungeonEncounterID` can be on several `JournalEncounter` rows** — 12 of the 1,072 are,
///   a fight the guide describes once per difficulty tier — so every row naming a wanted id is
///   followed, and whichever of them reaches a portrait answers.
pub fn portraits_of(
    files: &dyn GameFiles,
    encounters: &[u32],
) -> Result<HashMap<u32, u32>, String> {
    let mut found = HashMap::new();
    if encounters.iter().all(|id| *id == 0) {
        return Ok(found);
    }

    // Which journal rows belong to a fight somebody asked about, and which fight each one is. The
    // map runs journal id → dungeon id because that is the direction the portraits are read in,
    // and it is many-to-one: the same fight is described once per difficulty tier.
    let mut asked_for: HashMap<u32, u32> = HashMap::new();
    let table = Db2::parse(files.read(JOURNAL_ENCOUNTER)?)?;
    for row in table.rows() {
        let dungeon = row.number(encounter_column::DUNGEON_ENCOUNTER_ID);
        if dungeon != 0 && encounters.contains(&dungeon) {
            asked_for.insert(row.id(), dungeon);
        }
    }
    if asked_for.is_empty() {
        return Ok(found);
    }

    // The best portrait per fight, "best" being the creature the guide leads with. Kept beside the
    // file so a later row with a lower order index can displace an earlier one.
    let mut best: HashMap<u32, u32> = HashMap::new();
    let table = Db2::parse(files.read(JOURNAL_ENCOUNTER_CREATURE)?)?;
    for row in table.rows() {
        let portrait = row.number(creature_column::PORTRAIT_FILE_DATA_ID);
        if portrait == 0 {
            continue;
        }
        let Some(dungeon) = asked_for
            .get(&row.number(creature_column::JOURNAL_ENCOUNTER_ID))
            .copied()
        else {
            continue;
        };
        // The guide's own order, which the rows are not stored in — the whole reason this column
        // is read rather than the first row of a fight being taken.
        let order = row.number(creature_column::ORDER_INDEX);
        if best.get(&dungeon).is_none_or(|had| order < *had) {
            best.insert(dungeon, order);
            found.insert(dungeon, portrait);
        }
    }
    Ok(found)
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

    /* ---------- the bosses ---------- */

    /// The fixture's fights, by the `DungeonEncounterID` a segment would carry, and the portraits
    /// they resolve to. See `scripts/make-journal-fixtures.ts`.
    const SLUDGEFANG: u32 = 3101;
    const SLUDGEFANG_PORTRAIT: u32 = 170011;
    const GRASK: u32 = 3102;
    const GRASK_PORTRAIT: u32 = 170012;
    /// A council fight: three creatures, and the one the guide leads with is stored second.
    const COUNCIL: u32 = 3103;
    const COUNCIL_LEAD_PORTRAIT: u32 = 170014;
    const COUNCIL_FIRST_STORED_PORTRAIT: u32 = 170013;
    /// A fight the journal describes and hangs no creature off at all.
    const NO_CREATURE: u32 = 3104;
    /// A fight whose one creature names no portrait.
    const UNDRAWN_CREATURE: u32 = 3105;
    /// A fight whose one creature is in a section the game encrypts.
    const WITHHELD_CREATURE: u32 = 3106;
    /// A fight described on two journal rows, only the second of which reaches a creature.
    const TWO_TIERS: u32 = 3107;
    /// A fight whose portrait is a file this install has no bytes for.
    const ABSENT_FILE: u32 = 3109;
    const ABSENT_FILE_PORTRAIT: u32 = 170018;

    #[test]
    fn answers_the_portrait_each_fight_hangs_off() {
        let found = portraits_of(&journal_fixture_files(), &[SLUDGEFANG, GRASK]).unwrap();
        assert_eq!(found.get(&SLUDGEFANG), Some(&SLUDGEFANG_PORTRAIT));
        assert_eq!(found.get(&GRASK), Some(&GRASK_PORTRAIT));
    }

    /// A council fight is several creatures on one encounter, and the table does not store them in
    /// the order the guide shows them — 11 of the real table's 20 such fights are out of order. So
    /// taking the first row met would put the wrong member of the council on the line: Valiona for
    /// Theralion and Valiona, Terrastra for the Ascendant Council.
    #[test]
    fn answers_with_the_creature_the_guide_leads_with_rather_than_the_first_stored() {
        let found = portraits_of(&journal_fixture_files(), &[COUNCIL]).unwrap();
        assert_eq!(found.get(&COUNCIL), Some(&COUNCIL_LEAD_PORTRAIT));
        assert_ne!(found.get(&COUNCIL), Some(&COUNCIL_FIRST_STORED_PORTRAIT));
    }

    /// One `DungeonEncounterID` can be described on several journal rows — a fight the guide lists
    /// once per difficulty tier, which twelve of the real ones are — and there is no saying which
    /// of them carries the creatures. A reader that stopped at the first row it matched would draw
    /// nothing for the fight.
    #[test]
    fn follows_every_journal_row_one_fight_is_described_on() {
        let found = portraits_of(&journal_fixture_files(), &[TWO_TIERS]).unwrap();
        assert_eq!(found.get(&TWO_TIERS), Some(&SLUDGEFANG_PORTRAIT));
    }

    /// The three ways a fight the journal knows about reaches no picture. Each is a line that draws
    /// its name and nothing else, which is what the line did before this existed — and none of them
    /// is worth failing the other fights of a raid night over.
    #[test]
    fn leaves_out_a_fight_the_game_draws_no_portrait_for() {
        let asked = [NO_CREATURE, UNDRAWN_CREATURE, WITHHELD_CREATURE];
        let found = portraits_of(&journal_fixture_files(), &asked).unwrap();
        assert!(found.is_empty(), "{found:?}");
    }

    /// A fight from a build newer than this install, which is every boss killed on a client the
    /// reader's tables predate.
    #[test]
    fn leaves_out_a_fight_the_journal_has_never_heard_of() {
        let found = portraits_of(&journal_fixture_files(), &[SLUDGEFANG, 9999]).unwrap();
        assert_eq!(found.len(), 1);
        assert!(!found.contains_key(&9999));
    }

    /// Whether the file behind the id is one this install holds is not this module's question —
    /// [`crate::icons`] is where a texture the game withheld or never shipped turns into a row
    /// that draws no picture. Answering the id and letting that happen is what keeps the two
    /// reasons a portrait is missing from having to be told apart here.
    #[test]
    fn answers_the_portrait_it_found_even_where_no_file_stands_behind_it() {
        let found = portraits_of(&journal_fixture_files(), &[ABSENT_FILE]).unwrap();
        assert_eq!(found.get(&ABSENT_FILE), Some(&ABSENT_FILE_PORTRAIT));
    }

    /// Nothing asked about reads nothing at all, and zero is what an encounter recorded before the
    /// client had an id for it comes across as — neither is worth opening the game's storage for.
    #[test]
    fn answers_nothing_when_no_fight_was_asked_about() {
        assert!(portraits_of(&journal_fixture_files(), &[])
            .unwrap()
            .is_empty());
        assert!(portraits_of(&journal_fixture_files(), &[0, 0])
            .unwrap()
            .is_empty());
    }
}
