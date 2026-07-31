//! Who can really wear a set, read off the items behind it rather than off its class mask.
//!
//! `TransmogSet.ClassMask` is the mask the game files a set under, and the window drew it as
//! one kind of fact — "Cloth", "Paladin", "Any class" — when it is two. Held up against what
//! the *items* allow, on build 12.0.5.67823 and with `dump_wearers`:
//!
//! - **A mask naming one armour type is almost never a restriction.** 1,051 sets carry one, and
//!   the items behind 1,032 of them — 98% — shut nobody out beyond the people who cannot wear
//!   that armour anyway. The mask is describing who wears cloth, not locking anything.
//! - **A mask naming one class usually is.** 2,621 sets carry one, and for 2,019 of them the
//!   lock stands: the look is on that class's item and on nothing else in the game.
//!
//! So this asks the items. Two facts about each of them decide it, and both come out of the
//! two tables [`crate::wardrobe`] already reads for the same looks:
//!
//! - **Who may wear the item** — `ItemSparse.AllowableClass`, which is [`ANY_CLASS`] for
//!   nearly everything in the game. A look one item locks to Paladins and another sells to
//!   everybody is not locked at all, and **the other item does not have to be in the set**,
//!   which is why this walks every item that reaches the appearance rather than the set's rows.
//! - **What kind of armour it is** — `Item.ClassID` and `SubclassID`. This is the restriction
//!   that does not lift: the game will not transmogrify plate into cloth, so a plate look is
//!   for the three classes that wear plate however open the item is. It is what a lifted lock
//!   leaves behind — of the 593 single-class sets something sells around, 586 land on an
//!   armour type and 7 on nobody at all. Lifting a class lock gets a reader from "Paladin" to
//!   "any plate wearer" and almost never to "anyone".
//!
//! What comes out is a mask per set: the classes that can wear **every** look in it. Nothing
//! here decides wording — that a mask of three plate classes reads as "any plate wearer" is
//! `transmog.ts`'s business, the same way `items.rs` leaves "Leather" to the window.
//!
//! ## And *how much* of it, which the mask cannot say
//!
//! A mask is a verdict on a whole body's worth of clothes, so it says the same thing about a set
//! seven of whose eight slots something sells to everybody and a set nothing of which does. The
//! difference between those two is the interesting one: the first is a look a reader can almost
//! have, with a single named obstacle. So each set also comes back with **how many of its slots
//! have a way in, and which ones do not** — the counts behind `open:` in the search box, and the
//! whole of what the shelf of nearly-wearable sets is built from. See `shelf.ts`.
//!
//! **Slots rather than looks, which is the same grain [`wearers_of_set`] already reckons in.** A
//! set is not one outfit: `Brutal Gladiator's Satin Armor` files a Priest's legs, a Mage's legs
//! and a pair open to every cloth class all under legs, and a reader wanting the set's legs is
//! not stopped by the two they cannot have. A slot is blocked when *nothing* filed under it has a
//! way in, and that is the slot worth naming.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::items::{ANY_CLASS, ARMOR};
use crate::tables::item_appearance as appearance_column;
use crate::tables::ITEM_APPEARANCE;
use crate::wardrobe::ItemFacts;

/// Every class the game has, as the bit each occupies in a class mask.
///
/// Thirteen of them, Warrior first — the order `ItemSparse.AllowableClass` and
/// `TransmogSet.ClassMask` are both written in, and the order `transmog.ts` names them in.
pub const EVERY_CLASS: u32 = (1 << 13) - 1;

/// Who wears each kind of armour, as the game's own masks say it.
///
/// The four are `Item.SubclassID` 1 to 4 under [`ARMOR`], and the masks are the ones the sets
/// themselves are filed under: 0x0190 is Priest, Mage and Warlock, 0x0023 is Warrior, Paladin
/// and Death Knight. That the two agree is the point — a set masked "Cloth" and a cloth item
/// exclude exactly the same people, which is what makes the mask on such a set redundant
/// rather than informative.
const ARMOUR_WEARERS: [(u32, u32); 4] = [
    (1, 0x0190), // cloth
    (2, 0x0e08), // leather
    (3, 0x1044), // mail
    (4, 0x0023), // plate
];

/// The places on the body where being plate or cloth is a restriction at all.
///
/// Head, shoulder, chest, waist, legs, feet, wrist, hands, and the robe the game numbers apart
/// from the chest. What is *not* here is the reason this list exists rather than a test on the
/// subclass alone: a cloak, a shirt and a tabard are all filed under cloth and every class in
/// the game wears them, so reading their subclass as a restriction would make a plate set with
/// a cloak in it a set for Priests.
const ARMOUR_SLOTS: [u32; 9] = [1, 3, 5, 6, 7, 8, 9, 10, 20];

/// Who can wear one item, out of what the game says it is.
///
/// `None` for an item this install cannot describe. The game encrypts the items of content it
/// has not shipped, and such an item arrives with an empty `ItemSparse` row — a class mask of
/// zero, which is not a statement that nobody may wear it but that nothing was said.
fn wearers_of_item(about: &ItemFacts) -> Option<u32> {
    if about.allowable_class == 0 {
        return None;
    }
    let allowed = if about.allowable_class == ANY_CLASS {
        EVERY_CLASS
    } else {
        about.allowable_class & EVERY_CLASS
    };
    Some(allowed & armour_wearers(about))
}

/// And which classes the armour it is made of leaves in, which is all of them for most things.
fn armour_wearers(about: &ItemFacts) -> u32 {
    if about.class_id != ARMOR || !ARMOUR_SLOTS.contains(&about.inventory_type) {
        return EVERY_CLASS;
    }
    ARMOUR_WEARERS
        .iter()
        .find(|(subclass, _)| *subclass == about.subclass_id)
        .map_or(EVERY_CLASS, |(_, wearers)| *wearers)
}

/// Who can wear one look, out of every item in the game that gives it.
///
/// The union, because an item is a *way in*: a look sold to everybody by a world drop is open
/// however locked the set's own copy of it is. `None` where this install can describe none of
/// the items, which is a look nothing can be said about rather than one nobody can wear.
fn wearers_of_look(reached: &[u32], facts: &HashMap<u32, ItemFacts>) -> Option<u32> {
    let mut wearers: Option<u32> = None;
    for item_id in reached {
        let Some(who) = facts.get(item_id).and_then(wearers_of_item) else {
            continue;
        };
        wearers = Some(wearers.unwrap_or(0) | who);
    }
    wearers
}

/// Whether some item in the game gives this look to anybody at all.
///
/// The class lock lifting, and nothing else: an unrestricted plate helm still leaves a Priest
/// unable to wear the look, and that is the armour rather than a lock — see [`armour_wearers`].
/// This is the same test `openings.rs` sorts one set's looks by and the same one
/// `wardrobe::lifts_restriction` reports per row; here it is asked of every set at once, which
/// is what lets the window say a set is one slot short without opening it.
fn opens_a_look(reached: &[u32], facts: &HashMap<u32, ItemFacts>) -> bool {
    reached.iter().any(|item_id| {
        facts
            .get(item_id)
            .is_some_and(|about| about.allowable_class == ANY_CLASS)
    })
}

/// One look of a set, as everything the two answers below are worked out of.
struct Look {
    /// Where on the body it goes, as `ItemAppearance.DisplayType` numbers the places.
    slot: u32,
    /// Who can wear it, out of every item the game reaches it by — see [`wearers_of_look`].
    wearers: u32,
    /// And whether one of those items lets anybody have it — see [`opens_a_look`].
    open: bool,
}

/// Who can wear one whole set: a union down each slot, and an intersection across them.
///
/// **Both halves are what a shipping install forces.** Across slots it has to be an
/// intersection, because a set is a body's worth of clothes and one Paladin-locked piece makes
/// the set a Paladin's whatever the other four allow. Down one slot it has to be a union,
/// because a set is not one outfit: `Brutal Gladiator's Satin Armor` holds a Priest's legs, a
/// Mage's legs and a pair open to every cloth class, all filed under legs, and nobody has to
/// wear all three. Intersecting those said the set was nobody's — it is the Priest's.
///
/// `None` where this install can describe no look of the set at all.
fn wearers_of_set(looks: &[u32], per_look: &HashMap<u32, Look>) -> Option<u32> {
    let mut per_slot: HashMap<u32, u32> = HashMap::new();
    for look in looks {
        let Some(about) = per_look.get(look) else {
            continue;
        };
        *per_slot.entry(about.slot).or_default() |= about.wearers;
    }
    per_slot.values().copied().reduce(|had, slot| had & slot)
}

/// How much of a set anybody can have: the slots with a way in, and the slots without one.
///
/// A slot is open when *something* filed under it is on an unrestricted item, for the reason the
/// union above is a union — a set is a wardrobe rather than an outfit, and a reader is not kept
/// from its legs by a pair of legs beside the pair they can have.
///
/// A slot this install can read nothing of is in neither answer. The game encrypts the items of
/// content it has not shipped, and a slot counted as blocked on that account would put a set on
/// the near-miss shelf because Chronie is blind rather than because the game locked anything.
fn openness_of_set(looks: &[u32], per_look: &HashMap<u32, Look>) -> (usize, Vec<u32>) {
    let mut per_slot: HashMap<u32, bool> = HashMap::new();
    for look in looks {
        let Some(about) = per_look.get(look) else {
            continue;
        };
        let open = per_slot.entry(about.slot).or_default();
        *open |= about.open;
    }
    let mut blocked: Vec<u32> = per_slot
        .iter()
        .filter(|(_, open)| !**open)
        .map(|(slot, _)| *slot)
        .collect();
    blocked.sort_unstable();
    (per_slot.len() - blocked.len(), blocked)
}

/// Who can wear every set the game holds, keyed by the set.
///
/// **A set this install can say nothing about is left out rather than reported as open.** Its
/// looks may all sit in sections the game keeps encrypted, and "nobody knows" is not "anybody
/// may": the window falls back to the mask the game itself filed the set under, which is
/// exactly what it drew before any of this existed.
///
/// A set that comes back as *nobody* is left in, because that is an answer rather than a
/// failure. Two of the 4,707 sets a 12.0.5.67823 install can describe come back that way, and
/// both are `[DNT]` bundles Blizzard fills with every class's tier at once: no class can wear
/// the whole of one, and nothing about that is this module guessing.
#[tracing::instrument(name = "wearers.sets", skip_all)]
pub fn sets(files: &dyn GameFiles) -> Result<Value, String> {
    // Which looks each set is made of. One walk of `TransmogSetItem` and one of
    // `ItemModifiedAppearance`, and the only thing this needs from either.
    let held = crate::transmog::set_appearances(files)?;
    let wanted: HashSet<u32> = held.values().flatten().copied().collect();
    if wanted.is_empty() {
        return Ok(payload(Vec::new()));
    }

    // Which place on the body each of them fills, which is what says two looks are alternatives
    // rather than both needed. The whole table is parsed — it is eight milliseconds.
    let table = Db2::parse(files.read(ITEM_APPEARANCE)?)?;
    let slots: HashMap<u32, u32> = table
        .rows()
        .filter(|row| wanted.contains(&row.id()))
        .map(|row| (row.id(), row.number(appearance_column::DISPLAY_TYPE)))
        .collect();

    // Then the same chain the wardrobe walks, entered from the appearances the sets name: every
    // item of the game that reaches one of them — inside a set or not — and what the two item
    // tables say about each.
    let reached =
        crate::wardrobe::reaching(files, &|appearance_id| wanted.contains(&appearance_id))?;
    let facts = crate::wardrobe::describe(files, &reached)?;

    let mut per_look: HashMap<u32, Look> = HashMap::new();
    for (appearance_id, items) in &reached {
        // A look whose slot this install cannot read is one nothing can be said about: it
        // would be an alternative to everything or to nothing, and neither is an answer.
        let (Some(slot), Some(wearers)) =
            (slots.get(appearance_id), wearers_of_look(items, &facts))
        else {
            continue;
        };
        per_look.insert(
            *appearance_id,
            Look {
                slot: *slot,
                wearers,
                open: opens_a_look(items, &facts),
            },
        );
    }

    let mut found: Vec<Value> = Vec::new();
    for (set_id, looks) in &held {
        if let Some(wearers) = wearers_of_set(looks, &per_look) {
            let (open_slots, blocked_slots) = openness_of_set(looks, &per_look);
            found.push(json!({
                "setId": set_id,
                "classMask": wearers,
                "openSlots": open_slots,
                "blockedSlots": blocked_slots,
            }));
        }
    }
    Ok(payload(found))
}

fn payload(found: Vec<Value>) -> Value {
    json!({ "readCount": found.len(), "wearers": found })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// Who the fixture's sets can be worn by, as the window would receive it.
    fn read() -> HashMap<u32, u32> {
        let payload = sets(&fixture_files()).unwrap();
        payload["wearers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["setId"].as_u64().unwrap() as u32,
                    row["classMask"].as_u64().unwrap() as u32,
                )
            })
            .collect()
    }

    /// And how much of each of them anybody can have: the open slots, and the shut ones.
    fn openness() -> HashMap<u32, (u64, Vec<u64>)> {
        let payload = sets(&fixture_files()).unwrap();
        payload["wearers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["setId"].as_u64().unwrap() as u32,
                    (
                        row["openSlots"].as_u64().unwrap(),
                        row["blockedSlots"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|slot| slot.as_u64().unwrap())
                            .collect(),
                    ),
                )
            })
            .collect()
    }

    const CLOTH: u32 = 0x0190;
    const PLATE: u32 = 0x0023;
    const DRUID: u32 = 0b100_0000_0000;

    // The whole point of the module, on the set that shows it: 204 is filed under the mail
    // mask and is a rack of weapons, and nothing anybody holds is plate or cloth. The mask
    // says three classes; the items say everybody.
    #[test]
    fn answers_with_everyone_for_a_set_no_item_of_restricts() {
        assert_eq!(read().get(&204), Some(&EVERY_CLASS));
    }

    // And the other half of it: the armour type is a restriction the items keep even when
    // nobody is locked out by class. Set 201 is cloth, and cloth is the three cloth classes
    // whatever the mask on the set says.
    #[test]
    fn keeps_the_armour_type_of_a_set_no_class_is_locked_out_of() {
        assert_eq!(read().get(&201), Some(&CLOTH));
    }

    // A lock stands where nothing in the game sells the look around it: set 202's sandals are
    // the Druid's own and no other item gives that look, so the set is a Druid's — which is
    // four classes fewer than the leather mask the game files it under.
    #[test]
    fn says_one_class_where_a_lock_is_the_only_way_to_a_look() {
        assert_eq!(read().get(&202), Some(&DRUID));
    }

    // The reason this walks every item in the game rather than the set's own rows. Set 203's
    // legs are Paladin-only inside the set, and one item belonging to no set at all gives the
    // same look to anybody — so the lock lifts, and what is left is the plate.
    #[test]
    fn lifts_a_lock_an_item_outside_the_set_sells_the_look_around() {
        assert_eq!(read().get(&203), Some(&PLATE));
    }

    // A lock lifted from inside the set is the case the detail view already knew about, and
    // it reads the same way: set 207's Warrior pieces are sold to everybody by two more items
    // of the same set.
    #[test]
    fn lifts_a_lock_the_sets_own_items_sell_around() {
        assert_eq!(read().get(&207), Some(&PLATE));
    }

    // A set whose every item sits in a section this install holds no key to is a set nothing
    // can be said about, and nothing is what it says: the window falls back to the game's own
    // mask rather than being told that anybody may wear it.
    #[test]
    fn leaves_out_a_set_this_install_can_describe_no_item_of() {
        assert_eq!(read().get(&205), None);
    }

    // The shelf's whole question, on the fixture's one near-miss set: 202's gloves are open to
    // anybody and its sandals are the Druid's own, so it is a set one slot short — and the slot
    // is named, because which slot did it is the difference between an answer and a shrug.
    // Feet are display type 6.
    #[test]
    fn names_the_one_slot_that_keeps_a_set_from_everybody() {
        assert_eq!(openness().get(&202), Some(&(1, vec![6])));
    }

    // And the set that is a slot short of nothing. 203's legs are the Paladin's own, but an item
    // outside the set sells the look to anybody — so every one of its four slots has a way in and
    // there is nothing for a shelf of near misses to draw.
    #[test]
    fn counts_a_slot_an_item_outside_the_set_opens_as_open() {
        assert_eq!(openness().get(&203), Some(&(4, vec![])));
    }

    // A slot this install can read nothing of is neither open nor shut. Set 205's every item is
    // encrypted, so it is absent altogether — and a set half of which was encrypted would be
    // counted on what could be read rather than put on the shelf for Chronie's own blindness.
    #[test]
    fn leaves_a_slot_it_can_read_no_item_of_out_of_both_counts() {
        assert_eq!(openness().get(&205), None);
    }

    #[test]
    fn says_so_when_a_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = sets(&DirFiles::new(temp.path())).unwrap_err();
        assert!(error.contains(".db2"), "{error}");
    }
}
