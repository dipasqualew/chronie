//! What else in the game gives a reader the look a set is keeping from them.
//!
//! [`crate::openings`] answers the first and cheapest form of that question: is this very
//! appearance also sold by an item no class is locked out of. Where it is, the reader is not
//! locked out of the look at all and there is nothing further to say. Where it is not — the row
//! the openings panel draws in red — the honest answer stops being exact and becomes a list of
//! things that are *not that look* and might do instead. This is that list.
//!
//! Two measures make it, in that order, because they are two different kinds of claim:
//!
//! 1. **The same geometry, in another colour.** [`crate::shapes`] compares the mesh, the geosets
//!    and the sections rather than the pictures, so an equality between two signatures is an
//!    equality between two pieces of armour. Nothing is ranked and nothing is approximate. It
//!    answers head, shoulder and everything carried in a hand, and refuses the rest.
//! 2. **Something that looks like it.** [`crate::fingerprints`] compares the pictures, which is
//!    the only signal the slots refused above have, and answers with a distance under a cut the
//!    install measured for that slot. It is a **ranking somebody confirms rather than a verdict**,
//!    and the window draws the number.
//!
//! ## What is filtered out, and why it is not a nicety
//!
//! **Only looks no class is locked out of.** The whole question is being asked by somebody a
//! class lock is standing in front of, and offering them a second locked look is offering them
//! the same wall. That is [`crate::items::ANY_CLASS`] on the item the wardrobe names the row
//! after, which is already the cheapest unrestricted way in where there is one — see
//! [`crate::wardrobe::named`].
//!
//! **Only the same slot.** [`crate::shapes::siblings`] deliberately does not filter by display
//! type, the game filing one mesh as a sword, a shield and an off-hand; the filtering belongs
//! here, where somebody is looking at a chestpiece. This gets it for nothing by ranking against
//! the slot's own wardrobe rows rather than against the whole store.
//!
//! **The armour type is carried rather than filtered.** Of 6,901 unrestricted looks inside
//! single-class sets on a 12.0.5.67823 install, exactly one came through an item with no armour
//! type at all: the world drop that lifts a class lock is nearly always the same *kind* of
//! armour, so a cloth answer to a cloth question is right for a Priest and useless to a Druid.
//! Whether the game refuses that at the transmogrifier is not settled — the client carries
//! `ERR_TRANSMOGRIFY_INVALID_CLASS` and `ERR_TRANSMOGRIFY_INVALID_ITEM_TYPE` as two separate
//! refusals and nobody has read what the second rejects — so the kind travels with every row and
//! the window says it, rather than this deciding on the reader's behalf from a guess.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use crate::body::Body;
use crate::casc::GameFiles;
use crate::fingerprints::{self, Fingerprints};
use crate::items::ANY_CLASS;
use crate::shapes::{self, Shapes};
use crate::wardrobe::WardrobeAppearance;

/// How many lookalikes are worth offering.
///
/// A ranking has a tail and an equality does not, which is the whole difference between the two
/// halves of a payload here: the same-geometry list is however long the family is, because every
/// row of it is exactly the piece asked about, and this one is cut because the hundredth-nearest
/// picture in a slot of five thousand is noise with a number beside it.
const MOST: usize = 8;

/// One look offered in place of another.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alternative {
    pub appearance_id: u32,
    /// The item the row is named after — the cheapest unrestricted way in, by
    /// [`crate::wardrobe::named`], so that a look met here and met in the wardrobe list is the
    /// same words both times.
    pub item_id: u32,
    pub name: String,
    pub required_level: u32,
    pub quality: u32,
    pub icon_file_data_id: u32,
    /// What kind of thing it is — [`crate::items::ARMOR`] and a subclass, which is cloth,
    /// leather, mail or plate. Carried rather than filtered on; see the module note.
    pub class_id: u32,
    pub subclass_id: u32,
    /// How unalike the two pictures are, between 0 and 1, for a row that came from the
    /// fingerprint. Absent on a row that came from the geometry, which is an equality and has no
    /// distance to report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<f64>,
}

/// What this install can offer in place of one look.
///
/// The set-level tiers — the look itself on an unrestricted item, which is [`crate::openings`] —
/// are already on the reader's screen when this is asked for. What is here is the two that cost
/// a store.
#[tracing::instrument(name = "alternatives.of", skip_all, fields(look = appearance_id))]
pub fn of(
    shapes: &Shapes,
    prints: Option<&Fingerprints>,
    slot: &[WardrobeAppearance],
    appearance_id: u32,
) -> Value {
    // The slot's own rows, by look, already filtered to what anybody may wear. Everything below
    // ranks against this rather than against a whole store, which is what keeps a chestpiece
    // from being answered with a shield the game files under the same mesh.
    let open: Vec<&WardrobeAppearance> = slot
        .iter()
        .filter(|row| row.appearance_id != appearance_id)
        .filter(|row| row.allowable_class == ANY_CLASS)
        .collect();
    let named = |wanted: u32| open.iter().find(|row| row.appearance_id == wanted).copied();

    let same_mesh: Vec<u32> = shapes.siblings(appearance_id);
    let mut same_mesh: Vec<Alternative> = same_mesh
        .iter()
        .filter_map(|held| Some(alternative(named(*held)?, None)))
        .collect();
    // The cheapest way in first, which is the order the wardrobe list and the openings panel
    // both already name a look by. Nothing here is ranked by likeness — every row is the same
    // piece of armour — so what is left to order by is what it takes to have one.
    same_mesh.sort_by(|left, right| {
        left.required_level
            .cmp(&right.required_level)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then(left.appearance_id.cmp(&right.appearance_id))
    });

    let lookalikes: Vec<Alternative> = prints
        .map(|prints| {
            prints
                .nearest(appearance_id, usize::MAX)
                .into_iter()
                // A look the geometry already answered exactly is not worth saying twice, and
                // saying it second — under a percentage — would read as the weaker claim.
                .filter(|near| {
                    !same_mesh
                        .iter()
                        .any(|row| row.appearance_id == near.appearance_id)
                })
                .filter_map(|near| {
                    Some(alternative(named(near.appearance_id)?, Some(near.distance)))
                })
                .take(MOST)
                .collect()
        })
        .unwrap_or_default();

    json!({
        "appearanceId": appearance_id,
        // Whether the geometry can speak for this look at all. False is the ordinary answer for
        // a chestpiece and every other slot that is paint on a body, and it is what says an
        // empty `sameMesh` means "this measure does not apply" rather than "nothing matched".
        "geometryAnswers": shapes
            .of(appearance_id)
            .is_some_and(|row| row.shape.names_a_mesh()),
        "sameMesh": same_mesh,
        // False while the background sweep is still decoding the game's textures, which is
        // about half a minute on a real install and the reason the two halves arrive apart.
        "lookalikesReady": prints.is_some(),
        "lookalikes": lookalikes,
    })
}

fn alternative(row: &WardrobeAppearance, distance: Option<f64>) -> Alternative {
    Alternative {
        appearance_id: row.appearance_id,
        item_id: row.item_id,
        name: row.name.clone(),
        required_level: row.required_level,
        quality: row.quality,
        icon_file_data_id: row.icon_file_data_id,
        class_id: row.class_id,
        subclass_id: row.subclass_id,
        distance,
    }
}

/* ---------- what a person decided ---------- */

/// Somebody looked at a suggestion and agreed with it.
pub const CONFIRMED: &str = "yes";

/// And somebody looked at one and did not.
///
/// Worth storing rather than treated as the absence of the other, which is the whole reason the
/// table has a column and not merely a row: a rejection is the one correction a reader can make
/// to a measurement they cannot otherwise argue with, and without it the same wrong suggestion
/// climbs back to the top of the list every time the panel is opened.
pub const REJECTED: &str = "no";

/// One of those two, or a complaint about whatever else was passed.
///
/// The database says the same thing in a `CHECK`, and this says it in front of the database so
/// that a reader gets a sentence rather than a constraint violation. Both, rather than either,
/// because the two guard different things: this one guards the message and that one guards the
/// table against anything that ever reaches it another way.
pub fn verdict(word: &str) -> Result<&'static str, String> {
    match word {
        CONFIRMED => Ok(CONFIRMED),
        REJECTED => Ok(REJECTED),
        _ => Err(format!(
            "A verdict on a suggestion is `{CONFIRMED}` or `{REJECTED}`, not `{word}`."
        )),
    }
}

/// What somebody said about one suggestion.
///
/// Both halves are `ItemAppearance.id`, which is the one number in this feature that outlives a
/// patch: the meshes move, the pictures are repainted, both stores are thrown away and measured
/// again, and the look somebody confirmed is still the look they confirmed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Said {
    pub appearance_id: u32,
    pub alternative_id: u32,
    /// [`CONFIRMED`] or [`REJECTED`].
    pub verdict: String,
}

/* ---------- the stores, between clicks ---------- */

/// The two stores this install has measured, held for as long as the app is running.
///
/// Both are files on disk and both are read back by parsing several megabytes of JSON, which is
/// not something to do on every click. What is held is the parsed store and the build it was
/// measured on: a game that has moved under the app invalidates both, and the check is a string
/// comparison rather than anything that opens a file.
///
/// The two are asked for very differently, and that asymmetry is the whole of this type.
/// [`Held::shapes`] will measure the game if it has to, because that is half a second of walking
/// tables. [`Held::prints`] never will — it is half a minute of decoding textures, and the only
/// thing allowed to spend it is the background task [`Held::claim_sweep`] admits one of.
#[derive(Default)]
pub struct Held {
    shapes: Mutex<Option<(String, Arc<Shapes>)>>,
    prints: Mutex<Option<(String, Arc<Fingerprints>)>>,
    sweeping: AtomicBool,
}

impl Held {
    /// The geometry of this build, measured now if this machine has none for it.
    pub fn shapes(
        &self,
        files: &dyn GameFiles,
        body: &Body,
        build: &str,
        dir: &std::path::Path,
    ) -> Result<Arc<Shapes>, String> {
        if let Some(held) = self.remembered(&self.shapes, build) {
            return Ok(held);
        }
        let read = Arc::new(shapes::cached(files, body, build, dir)?);
        *self.shapes.lock().map_err(|_| "The shapes lock failed.")? =
            Some((build.to_string(), Arc::clone(&read)));
        Ok(read)
    }

    /// The fingerprints of this build **if this machine already has them**, and never otherwise.
    ///
    /// Nothing here measures anything. A reader who has just opened the transmog view on a fresh
    /// install gets `None`, the payload says the lookalikes are not ready, and the panel says so
    /// — which is the whole degradation story, and is better than a window that hangs for half a
    /// minute the first time somebody clicks a locked slot.
    pub fn prints(&self, build: &str, dir: &std::path::Path) -> Option<Arc<Fingerprints>> {
        if let Some(held) = self.remembered(&self.prints, build) {
            return Some(held);
        }
        let read = Arc::new(fingerprints::read_cache(dir).filter(|held| held.build() == build)?);
        *self.prints.lock().ok()? = Some((build.to_string(), Arc::clone(&read)));
        Some(read)
    }

    /// Puts a freshly swept store where the next reader will find it without parsing it again.
    pub fn keep_prints(&self, build: &str, read: Fingerprints) {
        if let Ok(mut held) = self.prints.lock() {
            *held = Some((build.to_string(), Arc::new(read)));
        }
    }

    /// Whether the caller is the one that gets to sweep the game's textures.
    ///
    /// True once and then false until [`Held::finished_sweeping`], so that a reader clicking
    /// through six locked slots in the first minute after an install starts one sweep rather
    /// than six of the same half-minute over the same sixty-eight thousand files.
    pub fn claim_sweep(&self) -> bool {
        !self.sweeping.swap(true, Ordering::SeqCst)
    }

    /// Gives the claim back, whether the sweep worked or not — a run that failed for want of a
    /// game folder should be tried again when the reader has pointed the app at one.
    pub fn finished_sweeping(&self) {
        self.sweeping.store(false, Ordering::SeqCst);
    }

    fn remembered<T>(&self, of: &Mutex<Option<(String, Arc<T>)>>, build: &str) -> Option<Arc<T>> {
        of.lock()
            .ok()?
            .as_ref()
            .filter(|(was, _)| was == build)
            .map(|(_, held)| Arc::clone(held))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::fixture_files;

    fn hers() -> Body {
        crate::body::of(&fixture_files(), crate::body::DEFAULT).unwrap()
    }

    /// The fixture's shape store, over every display type the game files.
    fn shapes() -> Shapes {
        let swept = shapes::sweep(&fixture_files(), &hers(), &shapes::EVERY_DISPLAY_TYPE).unwrap();
        Shapes::read(&crate::qualities::text(&shapes::stored("fixtures", &swept))).unwrap()
    }

    /// A wardrobe row, as [`crate::wardrobe::looks`] would hand one over.
    fn look(appearance_id: u32, name: &str, allowable_class: u32) -> WardrobeAppearance {
        WardrobeAppearance {
            appearance_id,
            item_id: 30_000 + appearance_id,
            name: name.to_string(),
            display_type: 0,
            inventory_type: 1,
            class_id: 4,
            subclass_id: 1,
            allowable_class,
            required_level: 0,
            quality: 3,
            display_info_id: 0,
            icon_file_data_id: 130_001,
            has_model: true,
            item_count: 1,
            lifts_restriction: false,
        }
    }

    /// The fixture's helm family: 80001 is the look asked about and the other three hang exactly
    /// the same mesh — see `shapes`'s own tests, which is where that equality is established.
    const HELM: u32 = 80001;
    const SAME_HELM: [u32; 3] = [80006, 80017, 80019];
    /// And a chestpiece, which hangs no mesh at all and is what the fingerprint is for.
    const CHESTPIECE: u32 = 80008;

    fn slot() -> Vec<WardrobeAppearance> {
        let mut rows = vec![look(HELM, "Stormforged Helm", ANY_CLASS)];
        for (at, held) in SAME_HELM.iter().enumerate() {
            rows.push(look(*held, &format!("Helm {at}"), ANY_CLASS));
        }
        rows
    }

    fn ids(payload: &Value, key: &str) -> Vec<u64> {
        payload[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["appearanceId"].as_u64().unwrap())
            .collect()
    }

    // What the module is for, on the measure that is exact: the other three appearances of one
    // helm come back as the same helm, with no distance on them because there is nothing
    // approximate about the claim.
    #[test]
    fn offers_every_other_colour_of_the_same_piece_of_armour() {
        let payload = of(&shapes(), None, &slot(), HELM);
        assert_eq!(ids(&payload, "sameMesh"), SAME_HELM.map(u64::from).to_vec());
        assert_eq!(payload["geometryAnswers"], true);
        assert_eq!(payload["sameMesh"][0].get("distance"), None);
    }

    // The filter that is the whole point of the panel. Somebody asking what else gives this look
    // is asking because a class lock is in front of them, and a second locked look is the same
    // wall — so a row the game shuts anybody out of is not an alternative.
    #[test]
    fn never_offers_a_look_somebody_is_locked_out_of() {
        let mut slot = slot();
        slot[1].allowable_class = 1; // the first of the three, locked to one class
        let payload = of(&shapes(), None, &slot, HELM);
        assert_eq!(ids(&payload, "sameMesh"), vec![80017, 80019]);
    }

    // The cheapest way in first, which is the order the wardrobe list and the openings panel
    // already name a look by — there being nothing to rank by likeness when every row is the
    // same piece of armour.
    #[test]
    fn puts_the_cheapest_way_in_first() {
        let mut slot = slot();
        slot[1].required_level = 60;
        slot[2].required_level = 45;
        slot[3].required_level = 45;
        slot[3].name = "A helm sorted before the other".into();
        let payload = of(&shapes(), None, &slot, HELM);
        assert_eq!(ids(&payload, "sameMesh"), vec![80019, 80017, 80006]);
    }

    // A look the reader cannot be shown at all is not an alternative: an appearance whose every
    // item this install holds no key to has no name, no level and no way to be gone and got. The
    // game writes such a row as a class mask of zero, which is silence rather than "for nobody"
    // — and either way it is not something to send somebody after.
    #[test]
    fn never_offers_a_look_this_install_can_say_nothing_about() {
        let mut slot = slot();
        slot[1] = look(SAME_HELM[0], "", 0);
        let payload = of(&shapes(), None, &slot, HELM);
        assert_eq!(ids(&payload, "sameMesh"), vec![80017, 80019]);
    }

    // The slots the geometry is blind to say so, rather than answering "nothing in the game
    // looks like this". A chestpiece is paint on a body every chestpiece shares, and an empty
    // list under a `false` is a different sentence from an empty list under a `true`.
    #[test]
    fn says_when_the_geometry_cannot_speak_for_a_look_at_all() {
        let payload = of(&shapes(), None, &slot(), CHESTPIECE);
        assert_eq!(payload["geometryAnswers"], false);
        assert_eq!(ids(&payload, "sameMesh"), Vec::<u64>::new());
    }

    /* ---------- the half that is a ranking ---------- */

    /// A fingerprint store written by hand, cut where the test says rather than where the
    /// install's own strangers fell — [`crate::fingerprints`] is where the cut is under test,
    /// and what is under test here is what the window is handed once one has been taken.
    ///
    /// Each look is a run of set cells, so two of them differ by exactly the number of cells
    /// their arguments differ by: a look of 4 against a look of 0 is 4 of 256 away.
    fn prints(near: f64, rows: &[(u32, u32)]) -> Fingerprints {
        let appearances: Vec<Value> = rows
            .iter()
            .map(|(appearance_id, cells)| {
                let mut words = [0u64; 4];
                for cell in 0..*cells as usize {
                    words[cell / 64] |= 1 << (cell % 64);
                }
                let hex: String = words.iter().map(|word| format!("{word:016x}")).collect();
                json!({ "id": appearance_id, "displayType": 0, "print": format!("s3:{hex}") })
            })
            .collect();
        Fingerprints::read(
            &json!({
                "build": "fixtures",
                "cuts": { "0": { "near": near, "median": 0.5, "pairs": 100 } },
                "appearances": appearances,
            })
            .to_string(),
        )
        .expect("a store this wrote is one it can read")
    }

    // The second measure, nearest first and with the number on it. Nothing here is exact and the
    // window says so; what this has to get right is the order and the fact that a distance
    // travels with every row.
    #[test]
    fn ranks_the_lookalikes_nearest_first_and_says_how_near() {
        let store = prints(
            0.25,
            &[(CHESTPIECE, 0), (90_001, 16), (90_002, 4), (90_003, 200)],
        );
        let slot = vec![
            look(90_001, "Further", ANY_CLASS),
            look(90_002, "Nearest", ANY_CLASS),
            look(90_003, "Past the cut", ANY_CLASS),
        ];
        let payload = of(&shapes(), Some(&store), &slot, CHESTPIECE);
        assert_eq!(payload["lookalikesReady"], true);
        assert_eq!(ids(&payload, "lookalikes"), vec![90_002, 90_001]);
        let nearest = payload["lookalikes"][0].clone();
        assert_eq!(nearest["distance"], 4.0 / 256.0);
        assert_eq!(nearest["name"], "Nearest");
        // The kind travels with the row, because a cloth answer to a cloth question is right for
        // a Priest and useless to a Druid — see the module note.
        assert_eq!(nearest["classId"], 4);
        assert_eq!(nearest["subclassId"], 1);
    }

    // A look the geometry has already answered exactly is not said twice. Saying it second,
    // under a percentage, would read as the weaker claim about the very thing that is certain.
    #[test]
    fn never_repeats_under_a_percentage_what_the_geometry_answered_exactly() {
        let store = prints(0.25, &[(HELM, 0), (80006, 4), (80017, 8), (90_001, 12)]);
        let mut slot = slot();
        slot.push(look(90_001, "Something else", ANY_CLASS));
        let payload = of(&shapes(), Some(&store), &slot, HELM);
        assert_eq!(ids(&payload, "sameMesh"), SAME_HELM.map(u64::from).to_vec());
        assert_eq!(ids(&payload, "lookalikes"), vec![90_001]);
    }

    // Until the background sweep has finished there is no ranking, and the payload says which of
    // the two it is rather than handing back an empty list that reads as "nothing matched".
    #[test]
    fn says_the_lookalikes_are_not_ready_rather_than_saying_there_are_none() {
        let payload = of(&shapes(), None, &slot(), CHESTPIECE);
        assert_eq!(payload["lookalikesReady"], false);
        assert_eq!(ids(&payload, "lookalikes"), Vec::<u64>::new());
    }

    // The same class filter the exact half has, because the reader asking is being kept out by a
    // class lock and a second locked look is the same wall.
    #[test]
    fn never_offers_a_lookalike_somebody_is_locked_out_of() {
        let store = prints(0.25, &[(CHESTPIECE, 0), (90_001, 4)]);
        let slot = vec![look(90_001, "Warrior only", 1)];
        let payload = of(&shapes(), Some(&store), &slot, CHESTPIECE);
        assert_eq!(ids(&payload, "lookalikes"), Vec::<u64>::new());
    }

    #[test]
    fn offers_no_more_lookalikes_than_a_reader_would_read() {
        let mut rows = vec![(CHESTPIECE, 0u32)];
        let mut slot = Vec::new();
        for at in 0..(MOST as u32 + 4) {
            rows.push((90_000 + at, 1 + at));
            slot.push(look(90_000 + at, &format!("Look {at}"), ANY_CLASS));
        }
        let payload = of(&shapes(), Some(&prints(0.9, &rows)), &slot, CHESTPIECE);
        assert_eq!(payload["lookalikes"].as_array().unwrap().len(), MOST);
    }

    /* ---------- what is held between clicks ---------- */

    // The bargain: measured once and remembered, and the second read is handed files that hold
    // nothing at all and still answers.
    #[test]
    fn measures_the_geometry_once_and_remembers_it() {
        let temp = tempfile::tempdir().unwrap();
        let held = Held::default();
        let first = held
            .shapes(&fixture_files(), &hers(), "12.0.5", temp.path())
            .unwrap();
        let no_game = crate::casc::DirFiles::new(std::path::Path::new("/nowhere"));
        let again = held
            .shapes(&no_game, &hers(), "12.0.5", temp.path())
            .unwrap();
        assert_eq!(first.len(), again.len());
        // And a build that has moved is measured again rather than believed.
        assert!(held.shapes(&no_game, &hers(), "12.1", temp.path()).is_err());
    }

    // The fingerprints are never measured on the way to a reader. A machine that has not swept
    // yet answers with nothing, which is what the payload turns into "not ready".
    #[test]
    fn never_measures_the_fingerprints_on_the_way_to_a_reader() {
        let temp = tempfile::tempdir().unwrap();
        let held = Held::default();
        assert!(held.prints("12.0.5", temp.path()).is_none());

        let swept = fingerprints::cached(&fixture_files(), &hers(), "12.0.5", temp.path()).unwrap();
        assert!(held.prints("12.0.5", temp.path()).is_some());
        // A store this build did not write is not this build's store.
        assert!(held.prints("12.1", temp.path()).is_none());

        held.keep_prints("12.1", swept);
        assert!(held.prints("12.1", temp.path()).is_some());
    }

    // One sweep at a time, however many locked slots somebody clicks through in the minute it
    // takes: sixty-eight thousand textures decoded six times over is six times the wait for the
    // same file.
    #[test]
    fn lets_one_sweep_of_the_textures_start_at_a_time() {
        let held = Held::default();
        assert!(held.claim_sweep());
        assert!(!held.claim_sweep());
        held.finished_sweeping();
        assert!(held.claim_sweep());
    }
}
