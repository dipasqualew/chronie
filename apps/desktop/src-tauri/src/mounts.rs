//! Every mount the game has, which is the half the census cannot walk.
//!
//! `apps/addon/src/Census.lua` asks the client what the account *holds* and writes the answer
//! into `account_mounts`, name and all. What no addon can produce is the other side of that
//! subtraction: the mounts nobody owns have no id in anybody's journal to be walked, and their
//! names are written down in exactly one place, which is the game's own `Mount` table.
//!
//! So this is a catalogue rather than a lookup. Every other reader in this tree takes the
//! handful of ids a window is showing — see [`crate::currencies`] — because the rows beside
//! them are beside the point. Here the rows beside them *are* the point, and 1,616 of them is
//! small enough that the whole table crosses at once.
//!
//! Two things it deliberately does not do.
//!
//! **It draws no picture.** `Mount` carries no icon column; the one the journal draws belongs
//! to the spell that summons the mount, through `SourceSpellID` into `SpellMisc`, which is some
//! four hundred thousand rows. A mount is named and described here instead, and the sentence
//! the game itself uses to say where one comes from is worth more to somebody who has not got
//! it than a 64-pixel square would be.
//!
//! **It filters nothing.** The table holds more mounts than the journal offers, and which flag
//! marks the difference could not be settled from an install — no bit of `Flags` separates them
//! cleanly, and a guessed one would quietly drop real mounts out of the catalogue or keep
//! internal rows in it. Everything downstream is told how many rows there were and says so.

use serde::Serialize;

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::escapes::without_escapes;
use crate::tables::mount as column;
use crate::tables::MOUNT;

/// One mount, in the words the game names it with.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    pub id: u32,
    pub name: String,
    /// Where it comes from, as one line — "Vendor: Unger Statforth. Zone: Wetlands. Cost: 1".
    /// Empty for the handful the table says nothing about, which is an answer rather than a
    /// gap: those are the ones the game itself offers no way of getting.
    pub source: String,
}

/// Every mount, and how many the install would not say.
///
/// The count travels with the rows because a total that quietly left some out is the one number
/// on this screen nobody could check: "you have 210 of 1,616" has to be able to add that 18 rows
/// of the table came through encrypted, or the subtraction is a lie by omission.
#[derive(Debug)]
pub struct Catalogue {
    pub found: Vec<Mount>,
    /// Rows the table declared that this install cannot read.
    pub withheld: usize,
}

/// Every mount the table holds, in the order it holds them.
///
/// A row with no name at all is left out. That is not tidiness — a mount with no name cannot be
/// matched against anything the census wrote and cannot be drawn, so counting it would only
/// inflate the number of mounts an account is told it is missing.
pub fn catalogue(files: &dyn GameFiles) -> Result<Catalogue, String> {
    let table = Db2::parse(files.read(MOUNT)?)?;
    let declared = table.declared_rows();
    let found: Vec<Mount> = table
        .rows()
        .filter_map(|row| {
            let name = row.text(column::NAME);
            (!name.is_empty()).then(|| Mount {
                id: row.id(),
                name,
                source: plain(&row.text(column::SOURCE_TEXT)),
            })
        })
        .collect();
    Ok(Catalogue {
        withheld: declared.saturating_sub(found.len()),
        found,
    })
}

/// A source line as a person reads it rather than as the client draws it.
///
/// The game writes this column in its own escape grammar — `|cFFFFD200Vendor: |rUnger
/// Statforth|n|cFFFFD200Zone: |rWetlands` — where `|n` is the line break between the parts and
/// the colours are the labels being made yellow. Taking the escapes out leaves the labels and
/// their values run together, so the breaks become sentence ends: the whole thing is one line
/// in a list of several hundred, and a line that still had `|c` in it would be drawn literally.
fn plain(raw: &str) -> String {
    // `|n` and `|r` are dealt with here rather than in [`crate::escapes`], and the difference is
    // whose text it is. That stripper drops the pipe of these two and keeps the letter, because
    // a note somebody typed in the game has to reach the database in the same shape
    // `ns.entryText` leaves it in the addon, and the addon does exactly that. A table Blizzard
    // wrote is under no such obligation, and leaving the letters would end every label in a
    // stray "r". On 12.0.5.67823 this column holds no other kind of escape than these and the
    // four the stripper knows, and no doubled pipe at all.
    let broken = raw.replace("|n", "\n").replace("|r", "");
    let text = without_escapes(&broken);
    text.lines()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.trim_end_matches(['.', ' ']))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(". ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::mount_fixture_files;

    /// The fixture's mounts. See `scripts/make-mount-fixtures.ts`.
    const BROWN_HORSE: u32 = 6;
    const TIDEGLASS_DRAKE: u32 = 1601;
    /// One the table names and says nothing else about.
    const UNSOURCED: u32 = 1602;
    /// One whose row the game encrypts, so it arrives with nothing in it at all.
    const WITHHELD: u32 = 1900;

    fn catalogue_of() -> Vec<Mount> {
        catalogue(&mount_fixture_files()).unwrap().found
    }

    fn one(id: u32) -> Mount {
        catalogue_of()
            .into_iter()
            .find(|mount| mount.id == id)
            .unwrap_or_else(|| panic!("the fixture holds mount {id}"))
    }

    // The whole of what a mount is, out of one row, because that is all there is to it.
    #[test]
    fn reads_a_mount_down_to_the_sentence_the_game_says_it_comes_from() {
        assert_eq!(
            one(BROWN_HORSE),
            Mount {
                id: BROWN_HORSE,
                name: "Brown Horse".into(),
                source: "Vendor: Unger Statforth. Zone: Wetlands. Cost: 1".into(),
            }
        );
    }

    // The reason the source column is read through `plain` at all: the game writes it in the
    // grammar it draws tooltips with, and a window that took the string whole would print the
    // colour codes on screen.
    #[test]
    fn leaves_no_escape_of_the_clients_in_a_source_line() {
        let sources: Vec<String> = catalogue_of()
            .into_iter()
            .map(|mount| mount.source)
            .collect();
        assert!(
            sources.iter().all(|line| !line.contains('|')),
            "{sources:?}"
        );
        assert_eq!(
            one(TIDEGLASS_DRAKE).source,
            "Drop: The Tidewarden. Zone: Tideglass Deeps"
        );
    }

    // Eleven rows of the real table have nothing in this column, and they are the mounts the
    // game offers no way of getting. Empty is that answer, not a missing one.
    #[test]
    fn leaves_the_source_empty_for_a_mount_the_table_says_nothing_about() {
        assert_eq!(one(UNSOURCED).name, "Unbroken Skystrider");
        assert_eq!(one(UNSOURCED).source, "");
    }

    // A row the game keeps encrypted arrives as zeroes, which is a mount with no name — and a
    // nameless mount counted into the catalogue would be one more thing an account is told it
    // has not got, under no name it could ever go looking for.
    #[test]
    fn leaves_out_a_mount_this_install_cannot_read() {
        let catalogue = catalogue(&mount_fixture_files()).unwrap();
        let ids: Vec<u32> = catalogue.found.iter().map(|mount| mount.id).collect();
        assert!(!ids.contains(&WITHHELD), "{ids:?}");
        assert_eq!(ids, vec![BROWN_HORSE, TIDEGLASS_DRAKE, UNSOURCED]);
        // Counted rather than merely dropped: a catalogue of 1,616 that declared 1,634 has to
        // be able to say so, or every subtraction made from it is short by an unstated amount.
        assert_eq!(catalogue.withheld, 1);
    }

    #[test]
    fn says_so_when_the_table_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = catalogue(&crate::casc::DirFiles::new(temp.path())).unwrap_err();
        assert!(error.contains("921760.db2"), "{error}");
    }
}
