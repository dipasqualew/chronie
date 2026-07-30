//! The picture a segment's modal opens on, out of whichever of three places has one.
//!
//! A segment arrives filed under the name of the place it happened in and nothing else, and the
//! modal opens on a band of art across the top of it — the one thing on that screen that says
//! where the reader is before a word of it has been read. Every place gets one. What differs is
//! where it comes from, and the order is what this module is:
//!
//! 1. **The banner the game draws the place across**, out of the group finder's table or the
//!    Encounter Journal's. It is art somebody painted of that dungeon, which is the best picture of
//!    a place there can be — and it exists for 805 places. See [`crate::journal::banners_of`].
//! 2. **The map the place is drawn with**, assembled out of the fragments the client assembles it
//!    out of — terrain first and then every town, road and label that only appears on a map once
//!    somebody has walked there. That answers for the open world, which is nearly everywhere else a
//!    segment happens: every zone, city and continent the game has. See [`crate::maps`].
//! 3. **The stand-in**, for a place that has neither — the banner the finder shows when it will not
//!    say which dungeon it is sending a player to. It is what keeps the modal one modal rather than
//!    two: a header for a raid and a bare line of text for the zone outside it would read as two
//!    different windows, and the reader would learn nothing from the difference.
//!
//! The order is worth stating the other way round as well. The map is *not* preferred over the
//! banner even though it is always the place's own art, because a banner is a painting of the room
//! a player stood in and a map is a diagram of it; and the stand-in is now what almost nothing
//! falls through to, where before this it was what most places got.

use std::collections::HashMap;

use crate::casc::GameFiles;
use crate::tables::UNKNOWN_PLACE_BANNER;
use crate::{journal, maps};

/// The picture one place is drawn with, and where it came from.
///
/// The two are handed on differently rather than differently shaped: a file goes through the same
/// texture cache every icon in the app goes through, keyed by the id the game named it under,
/// while an assembled map has no id to be cached under and is already a picture.
pub enum Hero {
    /// A texture the game itself names for the place, as a FileDataID.
    Named(u32),
    /// A picture put together here, encoded ready for a `data:` URL.
    Drawn(maps::Drawing),
}

/// The header each of the places asked about opens with, keyed by the name it was asked for under.
///
/// Every name comes back with something, and a name that is not a name — a segment the addon filed
/// with no place at all — comes back with nothing: there is no header to draw above an empty
/// title, and asking for one would have a window decoding a picture for it.
///
/// Each step is only asked about the places the step before it left, so an evening of raiding costs
/// the two journal tables and nothing else, and reading the seven map tables is what a zone costs.
pub fn heroes_of(
    files: &dyn GameFiles,
    wanted: &[String],
) -> Result<HashMap<String, Hero>, String> {
    let mut found: HashMap<String, Hero> = journal::banners_of(files, wanted)?
        .into_iter()
        .map(|(place, file)| (place, Hero::Named(file)))
        .collect();

    let left = still_wanted(wanted, &found);
    for (place, drawn) in maps::drawings_of(files, &left)? {
        found.insert(place, Hero::Drawn(drawn));
    }

    for place in still_wanted(wanted, &found) {
        found.insert(place, Hero::Named(UNKNOWN_PLACE_BANNER));
    }
    Ok(found)
}

/// The places asked about that nothing has answered for yet, without repeats, and never the blank.
fn still_wanted(wanted: &[String], found: &HashMap<String, Hero>) -> Vec<String> {
    let mut left: Vec<String> = Vec::new();
    for place in wanted {
        if !place.trim().is_empty() && !found.contains_key(place) && !left.contains(place) {
            left.push(place.clone());
        }
    }
    left
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{journal_fixture_files, map_fixture_files, DirFiles};

    /// Both fixture directories at once, which is what this errand needs and neither area's own
    /// tests do.
    ///
    /// The journal's tables and the map's are written by two different scripts into two different
    /// directories, because each is the fixture for one area of the game and there is no place a
    /// shared one would belong. This module is the one thing that reads across the boundary: the
    /// whole question here is which of the two answers for a place, so a source of files holding
    /// only one of them cannot ask it. The journal comes first and the maps fill in behind, which
    /// is arbitrary — the two directories name no file in common.
    struct BothAreas {
        journal: DirFiles,
        maps: DirFiles,
    }

    impl BothAreas {
        fn new() -> Self {
            Self {
                journal: journal_fixture_files(),
                maps: map_fixture_files(),
            }
        }
    }

    impl GameFiles for BothAreas {
        fn read(&self, fdid: u32) -> Result<std::sync::Arc<Vec<u8>>, String> {
            match self.journal.read(fdid) {
                Ok(bytes) => Ok(bytes),
                Err(missing) => self.maps.read(fdid).map_err(|_| missing),
            }
        }
    }

    /// A place the group finder paints a banner for and the map fixtures also hold a map of, which
    /// is what lets the order of the three be proved rather than assumed.
    const BOTH: &str = "Tideglass Hollow";
    const BOTH_BANNER: u32 = 180036;
    /// A place only the map tables have heard of, as every open-world zone is.
    const MAPPED: &str = "Emberfall Marches";
    /// A place both areas hold and neither can draw: the journal lists it and names no banner, and
    /// its map art is drawn in a style no layer row describes.
    const NEITHER: &str = "Zekvir's Lair";
    /// A place the finder draws a banner for whose map is torn — one of its two fragments is a file
    /// this install does not hold.
    const TORN_MAP: &str = "Grubwarden's Burrow";
    const TORN_MAP_BANNER: u32 = 180035;

    fn names(of: &[&str]) -> Vec<String> {
        of.iter().map(|name| (*name).to_string()).collect()
    }

    fn heroes(of: &[&str]) -> HashMap<String, Hero> {
        heroes_of(&BothAreas::new(), &names(of)).unwrap()
    }

    /// Which file a place is drawn with, and `None` where it was drawn with a picture put together
    /// here — [`Hero`] carries no equality of its own, and an assembled map is a hundred kilobytes
    /// of bytes rather than something to compare against a literal.
    fn named(found: &HashMap<String, Hero>, place: &str) -> Option<u32> {
        match found.get(place) {
            Some(Hero::Named(file)) => Some(*file),
            _ => None,
        }
    }

    fn is_drawn(found: &HashMap<String, Hero>, place: &str) -> bool {
        matches!(found.get(place), Some(Hero::Drawn(_)))
    }

    /* ---------- the order the three are asked in ---------- */

    /// A banner is a painting somebody made of that room and a map is a diagram of it, so where
    /// both exist the banner is the header — and both do, for this place, in both fixture sets. An
    /// order that put the map first would replace hand-drawn art with a floor plan for the several
    /// hundred dungeons the game has painted, which is the whole reason the map came second.
    #[test]
    fn draws_a_place_with_a_banner_with_the_banner_rather_than_its_map() {
        let found = heroes(&[BOTH]);
        assert_eq!(named(&found, BOTH), Some(BOTH_BANNER));
        assert!(!is_drawn(&found, BOTH));
    }

    /// And the map answers for everywhere the two journal tables have never heard of, which is
    /// nearly every place a segment is filed under: 805 places have a banner and the open world is
    /// not among them. Before the map existed this was the case that got the stand-in, so a reader
    /// spent an evening in a zone and saw the same invented header as everyone else.
    #[test]
    fn draws_a_place_with_no_banner_with_the_map_the_game_makes_of_it() {
        let found = heroes(&[MAPPED]);
        assert!(is_drawn(&found, MAPPED), "{:?}", named(&found, MAPPED));
    }

    /// The stand-in is what almost nothing falls through to now, and it still has to be there: this
    /// place is listed in the journal with no banner named and its map art is drawn in a style no
    /// layer describes, so both of the first two steps pass it over. A plain unknown name — a place
    /// from a build newer than these tables — arrives at the same place by a shorter route.
    #[test]
    fn draws_a_place_with_neither_a_banner_nor_a_map_with_the_stand_in() {
        let found = heroes(&[NEITHER, "Durotar"]);
        assert_eq!(named(&found, NEITHER), Some(UNKNOWN_PLACE_BANNER));
        assert_eq!(named(&found, "Durotar"), Some(UNKNOWN_PLACE_BANNER));
    }

    /// A map this install holds only part of is not drawn at all — see [`maps::draw`] — so a place
    /// in that state has to reach the step after it. Nothing in these fixtures is both bannerless
    /// and torn: this delve's map is torn and the group finder paints it a banner all the same, so
    /// what is proved here is that the tear does not cost it the banner it already had. That a torn
    /// map yields nothing for the step after to work with is asserted in `maps.rs`, against
    /// `drawings_of` itself.
    #[test]
    fn draws_a_place_whose_map_is_torn_with_the_banner_it_still_has() {
        let found = heroes(&[TORN_MAP]);
        assert_eq!(named(&found, TORN_MAP), Some(TORN_MAP_BANNER));
    }

    /* ---------- what every answer has in common ---------- */

    /// Every name asked about comes back with something. The modal opens on a band of art whatever
    /// place it is about, and a header for a raid beside a bare line of text for the zone outside
    /// it would read as two different windows rather than as one knowing less about one of them.
    #[test]
    fn answers_for_every_place_it_was_asked_about() {
        let asked = [BOTH, MAPPED, NEITHER, TORN_MAP, "Durotar"];
        let found = heroes(&asked);
        for place in asked {
            assert!(found.contains_key(place), "nothing for {place}");
        }
    }

    /// A header for every name is not a header for no name. A segment the addon filed with no place
    /// at all has an empty title, and there is nothing to draw above one — answering anyway would
    /// have the window decoding a picture in order to put it over a blank.
    #[test]
    fn answers_nothing_at_all_when_no_place_was_named() {
        assert!(heroes_of(&BothAreas::new(), &[]).unwrap().is_empty());
        assert!(heroes(&["", "  "]).is_empty());
    }
}
