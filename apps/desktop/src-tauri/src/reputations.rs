//! The picture a faction borrows from its own reputation achievement.
//!
//! A segment records what it earned with a faction as a name and an amount, and a character's
//! standings the same way — because that is what the client reports. `Faction` has no icon column
//! at all, so unlike a dungeon or a boss there is nothing to look up: the reputation lines drew as
//! plain text.
//!
//! There is a picture, though, and it is one the game already draws beside that faction: **the icon
//! of the achievement for reaching Exalted with it.** "Hero of the Frostwolf Clan" is drawn with a
//! Frostwolf banner, "Knight of Arathor" with the League of Arathor's crest. Those are per-faction
//! artwork sitting in a table this app already reads, and the way from one to the other is four
//! tables:
//!
//! ```text
//! Faction col1 (the name a segment carries)
//!   └▶ Faction's own id
//!        ◀── Criteria col2, where Criteria col1 is 46 ("reach reputation with faction")
//!               └▶ CriteriaTree col4, walked *up* by col1 to its root
//!                    ◀── Achievement col14
//!                         └▶ Achievement col12, the icon
//! ```
//!
//! **The catch is which achievement a faction lands on.** 216 factions are named by a type-46
//! criterion somewhere, but most of them only through the *aggregate* achievements — "25 Exalted
//! Reputations", "30 Exalted Reputations" — whose icon says nothing about any one faction. Letting
//! one of those through would put the same generic picture on every reputation line, which is worse
//! than none at all. So the rule is: **an achievement answers for a faction only if its criteria
//! name that faction and no other.** 138 factions have one, every one of their icons decodes, and
//! every one is 64×64.
//!
//! What this route does *not* reach is the modern renown factions — the Council of Dornogal, the
//! Valdrakken Accord, Dragonscale Expedition. None of them has an Exalted achievement, because
//! renown is not reputation with an Exalted tier. Those have real per-faction artwork of their own
//! in `interface/majorfactions/majorfactionsicons.blp`, behind a texture atlas this app cannot crop
//! yet; that is a separate piece of work. Until then a renown line draws as it always did.
//!
//! The column numbers below were read off a real install with `examples/dump_achievements.rs`, and
//! `docs/game-files.md` records what each was checked against.

use std::collections::{HashMap, HashSet};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::tables::achievement as achievement_column;
use crate::tables::criteria as criteria_column;
use crate::tables::criteria_tree as tree_column;
use crate::tables::faction as faction_column;
use crate::tables::{ACHIEVEMENT, CRITERIA, CRITERIA_TREE, FACTION};

/// The `Criteria` type meaning "reach a given reputation with a faction", whose asset is the
/// faction's own id.
///
/// What settles it is the assets: 529, 576, 609, 749 and 910 are Argent Dawn, Timbermaw Hold, the
/// Cenarion Circle, the Hydraxian Waterlords and the Brood of Nozdormu — five factions whose only
/// thing in common is that a player grinds reputation with them. 386 criteria are of this type, over
/// 223 distinct factions.
pub const REPUTATION_CRITERIA: u32 = 46;

/// How far up the criteria tree a walk will go before deciding the table is lying to it.
///
/// The real trees are three or four deep. A parent chain that looped would otherwise hang the read,
/// and a table reordered by a patch is exactly where a loop would come from — the same guard, for
/// the same reason, as `achievements.rs` puts on the category tree.
const DEEPEST_TREE: usize = 12;

/// The icon each of the factions asked about is drawn with, as a FileDataID, keyed by the name it
/// was asked for under.
///
/// The same bargain as [`crate::journal::icons_of`]: only the factions a window is showing, all of
/// them in one call because what costs is opening the game's storage, and a faction with no
/// achievement of its own left out rather than answered with zero. Most of a modern history is left
/// out — see the note at the top of this module — and each of those is a line that draws as it did
/// before this existed.
///
/// Two rules are worth knowing about, because each one is a *wrong* picture rather than a missing
/// one if it is skipped.
///
/// - **An achievement answers only if its criteria name one faction.** 73 of the achievements this
///   walk reaches are aggregates naming several, and their icon is a generic pile of tabards. 216
///   factions are reachable; only 138 are reachable alone.
/// - **A faction can have several achievements of its own, and the lowest id is the one to take.**
///   38 of the 138 do: a later hidden per-character copy, a "[DNT]" tier that never shipped, a
///   seasonal reissue. The lowest id is the original, and where two are both real they share an
///   icon anyway.
///
/// Matching is case-insensitive on a trimmed name, for the reason the places are: the name is a
/// string the client handed over. **Fourteen names are on more than one `Faction` row** — "Venture
/// Company" is on three, and there are rows literally called "reuse" and "unused" — so every row
/// bearing an asked-for name is followed, and whichever of them reaches an achievement answers.
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

    // Which faction ids were asked about, and under which spelling. Several ids can carry one name,
    // so this is a fan-in rather than a rename.
    let mut asked_for: HashMap<u32, &String> = HashMap::new();
    let table = Db2::parse(files.read(FACTION)?)?;
    for row in table.rows() {
        let name = key_of(&row.text(faction_column::NAME));
        if name.is_empty() {
            continue;
        }
        if let Some((_, asked)) = keys.iter().find(|(key, _)| *key == name) {
            asked_for.insert(row.id(), asked);
        }
    }
    if asked_for.is_empty() {
        return Ok(found);
    }

    // Every criterion that is about reaching reputation with a faction — all of them, not only the
    // ones asked about, because what disqualifies an achievement is the factions it names *besides*
    // the one in hand. There are 386, so this costs nothing.
    let mut about: HashMap<u32, u32> = HashMap::new();
    let table = Db2::parse(files.read(CRITERIA)?)?;
    for row in table.rows() {
        if row.number(criteria_column::TYPE) == REPUTATION_CRITERIA {
            about.insert(row.id(), row.number(criteria_column::ASSET));
        }
    }
    if about.is_empty() {
        return Ok(found);
    }

    // Every faction each tree *root* names, by walking up from the leaves rather than down from the
    // roots. Up is the cheap direction: a node names its one parent, so the whole thing is one pass
    // to collect the parents and then a short climb from each of the few thousand nodes that are
    // about a reputation — where walking down would need a list of children per node, over a table
    // of a hundred thousand rows.
    let table = Db2::parse(files.read(CRITERIA_TREE)?)?;
    let mut parents: HashMap<u32, u32> = HashMap::new();
    let mut leaves: Vec<(u32, u32)> = Vec::new();
    for row in table.rows() {
        let id = row.id();
        parents.insert(id, row.number(tree_column::PARENT));
        if let Some(faction) = about.get(&row.number(tree_column::CRITERIA_ID)) {
            leaves.push((id, *faction));
        }
    }
    let mut named_by: HashMap<u32, HashSet<u32>> = HashMap::new();
    for (leaf, faction) in leaves {
        named_by
            .entry(root_of(leaf, &parents))
            .or_default()
            .insert(faction);
    }

    // And the achievement each root belongs to. The lowest id wins where a faction has several,
    // which is what keeps a hidden copy or an unshipped tier from displacing the real one.
    let mut best: HashMap<u32, (u32, u32)> = HashMap::new();
    let table = Db2::parse(files.read(ACHIEVEMENT)?)?;
    for row in table.rows() {
        let root = row.number(achievement_column::CRITERIA_TREE);
        if root == 0 {
            continue;
        }
        // Exactly one faction, or this is an aggregate and its icon says nothing about any of them.
        let Some(faction) = named_by.get(&root).and_then(one_of) else {
            continue;
        };
        if !asked_for.contains_key(&faction) {
            continue;
        }
        let icon = row.number(achievement_column::ICON_FILE_ID);
        if icon == 0 {
            continue;
        }
        let id = row.id();
        if best.get(&faction).is_none_or(|(had, _)| id < *had) {
            best.insert(faction, (id, icon));
        }
    }

    // Back to the name the caller asked under. Where two faction rows share a name and both reach
    // an achievement, the lower achievement id answers — the same tie-break, one level up.
    let mut answered: HashMap<&String, (u32, u32)> = HashMap::new();
    for (faction, asked) in &asked_for {
        let Some((id, icon)) = best.get(faction) else {
            continue;
        };
        if answered.get(asked).is_none_or(|(had, _)| id < had) {
            answered.insert(asked, (*id, *icon));
        }
    }
    for (asked, (_, icon)) in answered {
        found.insert(asked.clone(), icon);
    }
    Ok(found)
}

/// One faction name reduced to what two spellings of it have in common.
fn key_of(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The only member of a set, or nothing when there is more than one.
///
/// Which is the whole of the "names this faction and no other" rule: a set of two is an aggregate
/// achievement and has no per-faction picture to give.
fn one_of(factions: &HashSet<u32>) -> Option<u32> {
    let mut members = factions.iter();
    match (members.next(), members.next()) {
        (Some(only), None) => Some(*only),
        _ => None,
    }
}

/// The top of the tree one node hangs under.
///
/// A node whose parent is not in the table is treated as a root, because that is what it is from
/// here: nothing above it can be reached, so nothing above it can be the achievement's. The visited
/// set is what stops a parent chain that loops, which is a shape only a mis-read table has.
fn root_of(from: u32, parents: &HashMap<u32, u32>) -> u32 {
    let mut node = from;
    let mut seen = HashSet::new();
    for _ in 0..DEEPEST_TREE {
        if !seen.insert(node) {
            break;
        }
        match parents.get(&node) {
            Some(0) | None => break,
            Some(parent) => node = *parent,
        }
    }
    node
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::achievement_fixture_files;

    /// The fixture's factions and the icons they should reach. See
    /// `scripts/make-achievement-fixtures.ts`.
    const OWN: &str = "Emberforge Covenant";
    const OWN_ICON: u32 = 250002;
    /// A faction with two achievements of its own; the lower id carries this icon.
    const TWO_OF_ITS_OWN: &str = "Tidewrought Wardens";
    const TWO_OF_ITS_OWN_ICON: u32 = 250004;
    const LATER_COPYS_ICON: u32 = 250001;
    /// A faction only the aggregate achievement names, so its picture would be everyone's.
    const AGGREGATE_ONLY: &str = "Glasswing Flight";
    /// A faction the criteria table says nothing about at all.
    const UNMENTIONED: &str = "Harborwatch";
    /// A name two faction rows carry, only the second of which reaches an achievement.
    const REPEATED: &str = "Venture Company";
    const REPEATED_ICON: u32 = 250003;
    /// A faction reached only through a criterion of the wrong type.
    const WRONG_TYPE: &str = "Ashfall Legion";

    fn names(of: &[&str]) -> Vec<String> {
        of.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn answers_with_the_icon_of_a_factions_own_exalted_achievement() {
        let found = icons_of(&achievement_fixture_files(), &names(&[OWN])).unwrap();
        assert_eq!(found.get(OWN), Some(&OWN_ICON));
    }

    /// The aggregate achievements — "25 Exalted Reputations" and its neighbours — reach most of the
    /// 216 factions this walk touches, and their icon is a generic pile of tabards. Letting one
    /// through would put the same picture on every reputation line in the app, which is worse than
    /// putting none on any.
    #[test]
    fn leaves_out_a_faction_only_an_aggregate_achievement_names() {
        let found = icons_of(&achievement_fixture_files(), &names(&[AGGREGATE_ONLY])).unwrap();
        assert!(found.is_empty(), "{found:?}");
    }

    /// 38 of the 138 have more than one, and the extras are hidden per-character copies and
    /// unshipped "[DNT]" tiers. The original is the low id.
    #[test]
    fn takes_the_first_of_several_achievements_a_faction_has_of_its_own() {
        let found = icons_of(&achievement_fixture_files(), &names(&[TWO_OF_ITS_OWN])).unwrap();
        assert_eq!(found.get(TWO_OF_ITS_OWN), Some(&TWO_OF_ITS_OWN_ICON));
        assert_ne!(found.get(TWO_OF_ITS_OWN), Some(&LATER_COPYS_ICON));
    }

    /// Fourteen names are on more than one `Faction` row, and there is no telling from the name
    /// which row the client meant. Following only the first would draw nothing for a faction whose
    /// picture is hanging off the second.
    #[test]
    fn follows_every_faction_row_a_name_is_on() {
        let found = icons_of(&achievement_fixture_files(), &names(&[REPEATED])).unwrap();
        assert_eq!(found.get(REPEATED), Some(&REPEATED_ICON));
    }

    /// `Criteria`'s asset column means whatever the type column beside it says it means, so a
    /// reader that took every row whose asset happened to be a faction id would borrow the icon of
    /// an achievement about something else entirely.
    #[test]
    fn reads_only_the_criteria_that_are_about_a_reputation() {
        let found = icons_of(&achievement_fixture_files(), &names(&[WRONG_TYPE])).unwrap();
        assert!(found.is_empty(), "{found:?}");
    }

    /// Which is most of a modern history: renown has no Exalted achievement, so the Council of
    /// Dornogal and its neighbours reach nothing here at all.
    #[test]
    fn leaves_out_a_faction_no_achievement_is_about() {
        let found = icons_of(&achievement_fixture_files(), &names(&[OWN, UNMENTIONED])).unwrap();
        assert_eq!(found.len(), 1);
        assert!(!found.contains_key(UNMENTIONED));
    }

    /// The name comes back the way it was asked for, whatever case the table spells it in: the
    /// window keys its reputation lines by the string the segment carries and has nothing else.
    #[test]
    fn answers_under_the_name_it_was_asked_under() {
        let asked = "  emberforge covenant ";
        let found = icons_of(&achievement_fixture_files(), &names(&[asked])).unwrap();
        assert_eq!(found.get(asked), Some(&OWN_ICON));
    }

    #[test]
    fn answers_nothing_when_nothing_was_asked_about() {
        assert!(icons_of(&achievement_fixture_files(), &[])
            .unwrap()
            .is_empty());
        assert!(icons_of(&achievement_fixture_files(), &names(&["", "  "]))
            .unwrap()
            .is_empty());
    }

    /// A tree whose parents loop is a shape only a table read wrongly has, and the reason to guard
    /// it is that the alternative is a hung window rather than a wrong picture.
    #[test]
    fn does_not_climb_forever_up_a_tree_that_loops() {
        let parents = HashMap::from([(1u32, 2u32), (2, 3), (3, 1)]);
        assert!([1, 2, 3].contains(&root_of(1, &parents)));
    }
}
