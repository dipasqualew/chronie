//! How anybody gets a class-locked set's looks, one look at a time.
//!
//! [`crate::wearers`] answers "can I wear this set at all" as a mask per set, and that is the
//! chip on the card. This is the sentence under it: *which* of the set's looks something else
//! in the game sells to everybody, and what that something is. The two read the same tables at
//! different grains — a mask is one number for a whole wardrobe, and a reader standing in front
//! of `Lightsworn Plate` wants the eight rows.
//!
//! Measured on a 12.0.5.67823 install, that is a question with an answer worth drawing. Of the
//! 2,276 sets the game locks to exactly one class, 431 have every look on an unrestricted item
//! and 1,073 have none; the 772 in between are the ones nothing on the card could ever say
//! anything useful about, because seven slots open and one shut is a set a reader can almost
//! wear. The eighth row is the whole answer.
//!
//! **The item that answers is usually in no set at all.** 6,013 of the 6,901 open looks are
//! loose drops — a world drop, a quest reward, a vendor's tabard — which is why this walks every
//! item of the game that reaches the appearance rather than the set's own rows. What the set's
//! own rows can see is already drawn, as the "Any class too" chip on a row.
//!
//! Three answers per look, and the difference between them is the module:
//!
//! - **Opened** — an item no class is locked out of gives the look. Which item is
//!   [`crate::wardrobe::named`]'s choice, unchanged: whatever anybody can wear, as cheaply as
//!   possible, oldest id breaking the tie. That is the rule the wardrobe list already names its
//!   rows by, so a look met here and met again there is the same words both times.
//! - **Blocked** — this install can read the items behind the look and every one of them locks
//!   somebody out. There is no way in, and that is the row worth drawing in red.
//! - **Neither** — this install can read no item of the look at all, the game encrypting the
//!   content it has not shipped. Absent from both lists and counted instead, because "nothing is
//!   known" is not "nothing is there".

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::items::ANY_CLASS;
use crate::tables::{item_modified_appearance as modified_appearance_column, transmog_set_item};
use crate::tables::{ITEM_MODIFIED_APPEARANCE, TRANSMOG_SET_ITEM};
use crate::wardrobe::{describe, named, ItemFacts};

/// The way in to one of a set's looks that no class is locked out of.
///
/// An item rather than a set, because 87% of these belong to no set — see the module note. What
/// the row is *for* is being recognised and looked up, so it carries what a row of an opened set
/// carries: the name, the level it takes, and the colour the game writes it in.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    /// The look, which is what joins this to the row the window has already drawn.
    pub appearance_id: u32,
    pub item_id: u32,
    /// What the game calls it, or empty where the table holds no name — the same silence a row
    /// of an opened set falls back from.
    pub name: String,
    pub required_level: u32,
    pub quality: u32,
}

/// Which items of the game reach each of a set's looks, out of one walk of one table.
///
/// `ItemModifiedAppearance` is asked two questions and parsed once. A set names *modified*
/// appearances and this is the only table saying which look each of those is; the looks then
/// have to be followed back out to every item in the game that reaches them, which is the same
/// table read the other way round. [`crate::wardrobe::reaching`] does the second half alone, and
/// a caller starting from a set's own rows would have to parse the whole table twice to use it.
fn reaching(files: &dyn GameFiles, held: &HashSet<u32>) -> Result<HashMap<u32, Vec<u32>>, String> {
    let modified = Db2::parse(files.read(ITEM_MODIFIED_APPEARANCE)?)?;
    let mut items_of: HashMap<u32, Vec<u32>> = modified
        .rows()
        .filter(|row| held.contains(&row.id()))
        .map(|row| {
            (
                row.number(modified_appearance_column::APPEARANCE_ID),
                Vec::new(),
            )
        })
        .collect();
    for row in modified.rows() {
        let item_id = row.number(modified_appearance_column::ITEM_ID);
        let Some(reached) =
            items_of.get_mut(&row.number(modified_appearance_column::APPEARANCE_ID))
        else {
            continue;
        };
        // The game stores one item's row twice where it sold the same look at two difficulties,
        // and the cheapest way in is the same item either way.
        if item_id != 0 && !reached.contains(&item_id) {
            reached.push(item_id);
        }
    }
    Ok(items_of)
}

/// How anybody gets each of one set's looks.
///
/// The set is addressed by id and nothing else crosses over, which is the bargain
/// [`crate::transmog::set_items`] already makes: the window has the set's own rows and this
/// answers the half of the question those cannot, which is what lies outside the set.
#[tracing::instrument(name = "openings.of_set", skip_all, fields(set = set_id))]
pub fn of_set(files: &dyn GameFiles, set_id: u32) -> Result<Value, String> {
    let items = Db2::parse(files.read(TRANSMOG_SET_ITEM)?)?;
    let held: HashSet<u32> = items
        .rows()
        .filter(|row| row.number(transmog_set_item::SET_ID) == set_id)
        .map(|row| row.number(transmog_set_item::MODIFIED_APPEARANCE_ID))
        .collect();
    drop(items);
    // Nothing further needs reading for a set the game holds no rows for, and the tables below
    // are the expensive ones — `ItemSparse` alone is sixty-three megabytes on a shipping install.
    if held.is_empty() {
        return Ok(payload(set_id, Vec::new(), Vec::new(), 0));
    }

    let items_of = reaching(files, &held)?;
    let facts = describe(files, &items_of)?;

    let mut openings: Vec<Opening> = Vec::new();
    let mut blocked: Vec<u32> = Vec::new();
    let mut withheld = 0usize;
    for (appearance_id, reached) in &items_of {
        let open: Vec<u32> = reached
            .iter()
            .copied()
            .filter(|item_id| said(item_id, &facts) == Some(ANY_CLASS))
            .collect();
        if !open.is_empty() {
            openings.push(opening(*appearance_id, named(&open, &facts), &facts));
        } else if reached
            .iter()
            .any(|item_id| said(item_id, &facts).is_some())
        {
            blocked.push(*appearance_id);
        } else {
            // Every item reaching the look sits in a section this install holds no key to, so
            // nothing whatever is known — which is not the same statement as "shut".
            withheld += 1;
        }
    }

    // By the look, because the window joins on it and a payload coming out of a hash map in a
    // different order every run is one nothing can be asserted about.
    openings.sort_by_key(|row| row.appearance_id);
    blocked.sort_unstable();
    Ok(payload(set_id, openings, blocked, withheld))
}

/// Who the game says may wear an item, or nothing where it says nothing at all.
///
/// A class mask of zero is that silence rather than a statement that nobody may wear it — the
/// game ships the items of unreleased content as a row with an id and no columns — so a look
/// reached only by those is one nothing is known about rather than one nothing sells around.
fn said(item_id: &u32, facts: &HashMap<u32, ItemFacts>) -> Option<u32> {
    facts
        .get(item_id)
        .map(|about| about.allowable_class)
        .filter(|mask| *mask != 0)
}

fn opening(appearance_id: u32, item_id: u32, facts: &HashMap<u32, ItemFacts>) -> Opening {
    let about = facts.get(&item_id).cloned().unwrap_or_default();
    Opening {
        appearance_id,
        item_id,
        name: about.name,
        required_level: about.required_level,
        quality: about.quality,
    }
}

/// The rows as the window reads them, with what could not be read counted beside them.
fn payload(set_id: u32, openings: Vec<Opening>, blocked: Vec<u32>, withheld: usize) -> Value {
    json!({
        "setId": set_id,
        "readCount": openings.len(),
        "blocked": blocked,
        "withheldCount": withheld,
        "openings": openings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    fn read(set_id: u32) -> Value {
        of_set(&fixture_files(), set_id).unwrap()
    }

    /// The whole point of the module, on the set that shows it: set 203's legs are the
    /// Paladin's own, and one item belonging to no set at all sells the same look to anybody.
    /// That item is the answer, and nothing the set's own rows hold could have found it.
    #[test]
    fn names_the_item_outside_the_set_that_sells_a_locked_look_to_anybody() {
        let payload = read(203);
        let legs = payload["openings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["appearanceId"] == 80009)
            .expect("the fixture holds it")
            .clone();
        assert_eq!(
            legs,
            json!({
                "appearanceId": 80009,
                "itemId": 30025,
                "name": "Greaves of the Wanderer",
                "requiredLevel": 0,
                "quality": 3,
            })
        );
    }

    /// And the other half of the answer: a look nothing in the game sells around. Set 202's
    /// sandals are the Druid's own and no other item gives that look, so the set is a wall for
    /// everybody else — which is the one row a reader has to see.
    #[test]
    fn says_which_looks_nothing_in_the_game_sells_around() {
        assert_eq!(read(202)["blocked"], json!([80004]));
    }

    /// The cheapest way in rather than whichever item came first. Set 207's head is sold three
    /// ways — the set's own Warrior helm, an unrestricted one at level 60 and an unrestricted
    /// one at 45 — and a reader asking how to get the look wants the 45.
    #[test]
    fn picks_the_cheapest_of_several_ways_in() {
        let payload = read(207);
        let head = payload["openings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["appearanceId"] == 80017)
            .expect("the fixture holds it")
            .clone();
        assert_eq!(head["name"], "Helm of the Tempest");
        assert_eq!(head["requiredLevel"], 45);
    }

    /// A look this install can read no item of is in neither list. The game encrypts the items
    /// of content it has not shipped, and a row saying such a look is shut would be this app
    /// inventing a wall out of its own blindness.
    #[test]
    fn counts_a_look_it_can_read_no_item_of_rather_than_calling_it_shut() {
        let payload = read(205);
        assert_eq!(payload["withheldCount"], 1);
        assert_eq!(payload["blocked"], json!([]));
        assert_eq!(payload["openings"], json!([]));
    }

    /// A set the game holds no rows for is answered without opening the expensive tables at
    /// all — `ItemSparse` is sixty-three megabytes, and there is nothing in it to look for.
    #[test]
    fn reads_nothing_beyond_the_first_table_for_a_set_the_game_has_no_rows_for() {
        let payload = read(9999);
        assert_eq!(payload["setId"], 9999);
        assert_eq!(payload["readCount"], 0);
        assert_eq!(payload["openings"], json!([]));
        assert_eq!(payload["blocked"], json!([]));
    }

    #[test]
    fn says_so_when_a_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = of_set(&DirFiles::new(temp.path()), 203).unwrap_err();
        assert!(error.contains(".db2"), "{error}");
    }
}
