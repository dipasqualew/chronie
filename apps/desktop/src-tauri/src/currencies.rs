//! The picture the game draws a currency with.
//!
//! Everything else this app knows about a currency came out of the addon: the client tells it the
//! id, the name and the balance, and `character_currencies` stores all three. What the addon
//! cannot send is the icon — an addon has a texture *path* for one and this app draws from
//! FileDataIDs — so the one hop that is left is the game's own `CurrencyTypes`, which names an
//! icon per currency and is the only table in the game with an opinion about it.
//!
//! It is one column of one table, and that is the whole module. What makes it worth its own file
//! rather than a corner of [`crate::icons`] is that the column is a guess until an install says
//! otherwise: `examples/dump_currencies.rs` is what asks one, and `docs/game-files.md` records
//! what it answered.

use std::collections::HashMap;

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::tables::currency_types as column;
use crate::tables::CURRENCY_TYPES;

/// The icon each of the currencies asked for is drawn with, as a FileDataID.
///
/// Only the ids asked for, because a window is showing the handful of currencies one character
/// holds and the table has several thousand rows in it — and because what costs here is opening
/// the game's storage at all, which is why this takes every id a caller wants at once.
///
/// An id the table says nothing about is left out rather than answered with zero. The reasons are
/// the ordinary ones: a currency the addon recorded on a build newer than this install, one a
/// later patch removed, and one whose row the game encrypts. Each of those is a line that draws
/// without a picture, which is what the line did before this existed.
pub fn icons_of(files: &dyn GameFiles, wanted: &[u32]) -> Result<HashMap<u32, u32>, String> {
    let table = Db2::parse(files.read(CURRENCY_TYPES)?)?;
    let mut found = HashMap::new();
    for row in table.rows() {
        if !wanted.contains(&row.id()) {
            continue;
        }
        let icon = row.number(column::ICON_FILE_DATA_ID);
        if icon != 0 {
            found.insert(row.id(), icon);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::currency_fixture_files;

    /// The fixtures' currencies, and the icons each names. See `scripts/make-currency-fixtures.ts`.
    const HONOR: u32 = 1792;
    const VALORSTONES: u32 = 3008;
    const NAMELESS: u32 = 4001;
    const HONOR_ICON: u32 = 160001;
    const VALORSTONES_ICON: u32 = 160002;

    #[test]
    fn answers_the_icon_each_currency_names() {
        let found = icons_of(&currency_fixture_files(), &[HONOR, VALORSTONES]).unwrap();
        assert_eq!(found.get(&HONOR), Some(&HONOR_ICON));
        assert_eq!(found.get(&VALORSTONES), Some(&VALORSTONES_ICON));
    }

    #[test]
    fn leaves_out_a_currency_the_table_does_not_hold() {
        let found = icons_of(&currency_fixture_files(), &[HONOR, 999_999]).unwrap();
        assert_eq!(found.len(), 1);
        assert!(!found.contains_key(&999_999));
    }

    /// A row that names no icon is not a row with an icon of zero: nothing decodes FileDataID
    /// zero, and answering with it would have the window asking for a picture that cannot exist.
    #[test]
    fn leaves_out_a_currency_that_names_no_icon() {
        let found = icons_of(&currency_fixture_files(), &[NAMELESS]).unwrap();
        assert!(found.is_empty());
    }

    /// Asking about nothing reads the table and finds nothing in it, rather than failing.
    #[test]
    fn answers_nothing_when_nothing_was_asked_about() {
        assert!(icons_of(&currency_fixture_files(), &[]).unwrap().is_empty());
    }
}
