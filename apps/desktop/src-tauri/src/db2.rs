//! Reading the client's own database tables.
//!
//! Every table the game ships is a DB2 file in the WDC5 format: a header, a description of
//! how each column was squeezed down, and then the rows, split into sections. Blizzard packs
//! hard — a column is stored plainly only when nothing cheaper fits, and otherwise lands in
//! a bit field, a shared palette of distinct values, or a sparse map of the rows that differ
//! from a default. This module undoes all of that and hands back plain integers and strings.
//!
//! It is deliberately schema-free. Which column means what belongs to the caller, because
//! that is the part that changes between game patches; the shape of the file does not.

use std::collections::HashMap;

/// How a column was stored. The numbering is the file's, not ours.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Storage {
    /// Written out in full, in the row.
    Plain,
    /// A bit field in the row, read as written.
    Bitpacked,
    /// Absent from the row; only the rows that differ from a default are listed.
    Common,
    /// A bit field in the row, holding an index into a palette of values.
    Indexed,
    /// The same, but each index names a run of values rather than one.
    IndexedArray,
    /// A bit field in the row, holding a signed value.
    BitpackedSigned,
}

impl Storage {
    fn from(value: u32) -> Result<Self, String> {
        Ok(match value {
            0 => Storage::Plain,
            1 => Storage::Bitpacked,
            2 => Storage::Common,
            3 => Storage::Indexed,
            4 => Storage::IndexedArray,
            5 => Storage::BitpackedSigned,
            other => return Err(format!("Column storage type {other} is not known.")),
        })
    }

    fn uses_palette(self) -> bool {
        matches!(self, Storage::Indexed | Storage::IndexedArray)
    }
}

struct Column {
    offset_bits: u32,
    size_bits: u32,
    storage: Storage,
    /// The value a row takes when a sparse column does not list it.
    default: u32,
    /// How many values one palette index names, for a column stored as runs.
    array_count: u32,
    /// The palette, for the two storages that use one.
    palette: Vec<u32>,
    /// The sparse map of row id to value, for a column stored that way.
    common: HashMap<u32, u32>,
}

/// One section of a table's rows.
struct Section {
    /// True when Blizzard encrypted the section, which it does for unreleased content.
    encrypted: bool,
    rows: usize,
    /// Where this section's rows start in the file.
    records_at: usize,
    /// Where this section's strings start in the file.
    strings_at: usize,
    strings_size: usize,
    /// String offsets are counted across every section, so each one starts at a running total.
    strings_base: usize,
    /// Row ids, when the table keeps them beside the rows rather than inside them.
    id_list: Vec<u32>,
    /// The foreign key each record belongs to, for a table that keeps one outside the row.
    /// Indexed by the record's position in this section; zero where the table keeps none.
    foreign_ids: Vec<u32>,
}

/// A parsed DB2 table.
pub struct Db2 {
    data: Vec<u8>,
    record_size: usize,
    /// Which column holds the row id, when it is stored inside the row.
    id_column: usize,
    columns: Vec<Column>,
    sections: Vec<Section>,
    /// Rows that are another row under a second id, as `(new id, row copied)`.
    copies: Vec<(u32, u32)>,
    /// Total rows across every section, encrypted ones included, as the header counts them.
    total_rows: usize,
}

/// One row, addressed by column.
pub struct Row<'a> {
    table: &'a Db2,
    section: usize,
    index: usize,
    /// Set when the row is being read as a copy of itself under a different id.
    id_as: Option<u32>,
}

/// The parts of a section header the parser needs before it can place the sections.
struct RawSection {
    encrypted: bool,
    rows: usize,
    strings_size: usize,
    id_list_size: usize,
    relationship_size: usize,
    offset_map_count: usize,
    copy_count: usize,
}

impl Db2 {
    /// Parses a DB2 file.
    pub fn parse(data: Vec<u8>) -> Result<Self, String> {
        if data.len() < 204 || &data[0..4] != b"WDC5" {
            return Err("Not a WDC5 table; this build of the game is not supported.".into());
        }
        let word = |at: usize| -> Result<u32, String> {
            data.get(at..at + 4)
                .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
                .ok_or_else(|| "The table ends inside its own header.".to_string())
        };

        // A 4-byte format version and a 128-byte build string sit between the magic and the
        // header proper — they are what WDC5 added over WDC4.
        let head = 136;
        let total_rows = word(head)? as usize;
        let column_count = word(head + 4)? as usize;
        let record_size = word(head + 8)? as usize;
        let id_column =
            u16::from_le_bytes(data[head + 38..head + 40].try_into().unwrap()) as usize;
        let total_column_count = word(head + 40)? as usize;
        let storage_info_size = word(head + 52)? as usize;
        let common_size = word(head + 56)? as usize;
        let palette_size = word(head + 60)? as usize;
        let section_count = word(head + 64)? as usize;

        if storage_info_size != total_column_count * 24 {
            return Err("The column descriptions are not the size the header claims.".into());
        }

        let mut at = head + 68;

        // Section headers come first, but they describe regions that can only be placed once
        // the column descriptions have been read, so hold on to them.
        let mut raw_sections = Vec::with_capacity(section_count);
        for _ in 0..section_count {
            let header = data
                .get(at..at + 40)
                .ok_or("The table ends inside its section headers.")?;
            raw_sections.push(RawSection {
                encrypted: u64::from_le_bytes(header[0..8].try_into().unwrap()) != 0,
                rows: u32::from_le_bytes(header[12..16].try_into().unwrap()) as usize,
                strings_size: u32::from_le_bytes(header[16..20].try_into().unwrap()) as usize,
                id_list_size: u32::from_le_bytes(header[24..28].try_into().unwrap()) as usize,
                relationship_size: u32::from_le_bytes(header[28..32].try_into().unwrap()) as usize,
                offset_map_count: u32::from_le_bytes(header[32..36].try_into().unwrap()) as usize,
                copy_count: u32::from_le_bytes(header[36..40].try_into().unwrap()) as usize,
            });
            at += 40;
        }

        // A per-column note of where it would sit in an uncompressed row, which the storage
        // descriptions below supersede entirely.
        at += column_count * 4;

        let mut columns = Vec::with_capacity(total_column_count);
        // How many bytes of palette or sparse map each column owns. Both live in single
        // runs further down the file, in column order, so the sizes are needed before the
        // runs can be split up.
        let mut extra_sizes = Vec::with_capacity(total_column_count);
        for _ in 0..total_column_count {
            let info = data
                .get(at..at + 24)
                .ok_or("The table ends inside its column descriptions.")?;
            columns.push(Column {
                offset_bits: u32::from(u16::from_le_bytes(info[0..2].try_into().unwrap())),
                size_bits: u32::from(u16::from_le_bytes(info[2..4].try_into().unwrap())),
                storage: Storage::from(u32::from_le_bytes(info[8..12].try_into().unwrap()))?,
                default: u32::from_le_bytes(info[12..16].try_into().unwrap()),
                array_count: u32::from_le_bytes(info[20..24].try_into().unwrap()),
                palette: Vec::new(),
                common: HashMap::new(),
            });
            extra_sizes.push(u32::from_le_bytes(info[4..8].try_into().unwrap()) as usize);
            at += 24;
        }

        // The palettes, then the sparse maps, each a single run in column order.
        let mut extra_at = at;
        for (column, size) in columns.iter_mut().zip(&extra_sizes) {
            if !column.storage.uses_palette() {
                continue;
            }
            let bytes = data
                .get(extra_at..extra_at + size)
                .ok_or("The table ends inside its palettes.")?;
            column.palette = bytes
                .chunks_exact(4)
                .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
                .collect();
            extra_at += size;
        }
        if extra_at != at + palette_size {
            return Err("The palettes are not the size the header claims.".into());
        }
        for (column, size) in columns.iter_mut().zip(&extra_sizes) {
            if column.storage != Storage::Common {
                continue;
            }
            let bytes = data
                .get(extra_at..extra_at + size)
                .ok_or("The table ends inside its sparse columns.")?;
            for pair in bytes.chunks_exact(8) {
                column.common.insert(
                    u32::from_le_bytes(pair[0..4].try_into().unwrap()),
                    u32::from_le_bytes(pair[4..8].try_into().unwrap()),
                );
            }
            extra_at += size;
        }
        if extra_at != at + palette_size + common_size {
            return Err("The sparse columns are not the size the header claims.".into());
        }
        at = extra_at;

        // WDC4 added a run of per-section counts here that nothing downstream reads.
        for _ in 0..section_count.saturating_sub(1) {
            let count = word(at)? as usize;
            at += 4 + count * 4;
        }

        let mut sections = Vec::with_capacity(section_count);
        let mut copies = Vec::new();
        let mut strings_base = 0usize;
        for raw in &raw_sections {
            let records_at = at;
            let strings_at = records_at + record_size * raw.rows;
            at = strings_at + raw.strings_size;

            let id_list = data
                .get(at..at + raw.id_list_size)
                .ok_or("The table ends inside its row ids.")?
                .chunks_exact(4)
                .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
                .collect();
            at += raw.id_list_size;

            for pair in data
                .get(at..at + raw.copy_count * 8)
                .ok_or("The table ends inside its copied rows.")?
                .chunks_exact(8)
            {
                let new_id = u32::from_le_bytes(pair[0..4].try_into().unwrap());
                let copied = u32::from_le_bytes(pair[4..8].try_into().unwrap());
                if new_id != copied {
                    copies.push((new_id, copied));
                }
            }
            at += raw.copy_count * 8;
            at += raw.offset_map_count * 6;
            let foreign_ids = read_relationship_map(&data, at, raw.relationship_size, raw.rows)?;
            at += raw.relationship_size;
            at += raw.offset_map_count * 4;

            sections.push(Section {
                encrypted: raw.encrypted,
                rows: raw.rows,
                records_at,
                strings_at,
                strings_size: raw.strings_size,
                strings_base,
                id_list,
                foreign_ids,
            });
            strings_base += raw.strings_size;
        }
        if at > data.len() {
            return Err("The table's sections run past the end of the file.".into());
        }

        Ok(Self {
            data,
            record_size,
            id_column,
            columns,
            sections,
            copies,
            total_rows,
        })
    }

    /// Every row that can actually be read, skipping sections that came through encrypted.
    ///
    /// Copied rows come last. A table can say "row 40 is row 12 again under a new id"
    /// instead of storing it twice, and a caller counting or listing rows wants both.
    pub fn rows(&self) -> impl Iterator<Item = Row<'_>> {
        let direct: Vec<Row<'_>> = self
            .sections
            .iter()
            .enumerate()
            .filter(|(_, section)| !self.is_unreadable(section))
            .flat_map(|(section, header)| {
                (0..header.rows).map(move |index| Row {
                    table: self,
                    section,
                    index,
                    id_as: None,
                })
            })
            .collect();

        let by_id: std::collections::HashMap<u32, (usize, usize)> = direct
            .iter()
            .map(|row| (row.id(), (row.section, row.index)))
            .collect();
        let copied: Vec<Row<'_>> = self
            .copies
            .iter()
            .filter_map(|(new_id, copied)| {
                let (section, index) = *by_id.get(copied)?;
                Some(Row {
                    table: self,
                    section,
                    index,
                    id_as: Some(*new_id),
                })
            })
            .collect();

        direct.into_iter().chain(copied)
    }

    /// How many rows the header counts, including any this install cannot decrypt.
    pub fn declared_rows(&self) -> usize {
        self.total_rows
    }

    /// Whether a section Blizzard encrypted really did arrive as zeroes.
    ///
    /// An install that happens to hold the key decodes the section normally, and then it is
    /// ordinary data worth reading; only the all-zero ones have to be skipped.
    fn is_unreadable(&self, section: &Section) -> bool {
        if !section.encrypted {
            return false;
        }
        let end = section.records_at + self.record_size * section.rows;
        self.data
            .get(section.records_at..end)
            .is_none_or(|rows| rows.iter().all(|byte| *byte == 0))
    }
}

/// Reads the block tying each record to a foreign key that is not a column of the row.
///
/// Most foreign keys are duplicated into the row and can just be read as a column, but a
/// table can instead keep one only here — `ItemDisplayInfoMaterialRes` says which item
/// display a texture belongs to this way and nowhere else, so a reader that skipped this
/// block would have its rows and no way to tell whose they are.
///
/// The block is a count, the lowest and highest key it mentions, and then pairs of the key
/// and the record it belongs to. That record number counts within the section rather than
/// across the table, and is not a row id.
///
/// An encrypted section still reserves the block at full size but writes it as zeroes, so a
/// count of zero is ordinary and means only that this section has no readable relationships.
fn read_relationship_map(
    data: &[u8],
    at: usize,
    size: usize,
    rows: usize,
) -> Result<Vec<u32>, String> {
    let mut foreign_ids = vec![0u32; rows];
    if size < 12 {
        return Ok(foreign_ids);
    }
    let word = |offset: usize| -> Result<u32, String> {
        data.get(offset..offset + 4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
            .ok_or_else(|| "The table ends inside its relationship map.".to_string())
    };

    let count = word(at)? as usize;
    if count == 0 {
        return Ok(foreign_ids);
    }
    if 12 + count * 8 > size {
        return Err("The relationship map claims more entries than it has room for.".into());
    }
    for entry in 0..count {
        let pair = at + 12 + entry * 8;
        let foreign = word(pair)?;
        let record = word(pair + 4)? as usize;
        // A record number past the section's rows is not something to fail the whole table
        // over; the row it would name simply keeps its zero.
        if let Some(slot) = foreign_ids.get_mut(record) {
            *slot = foreign;
        }
    }
    Ok(foreign_ids)
}

impl Row<'_> {
    /// The row's id, from wherever this table keeps it.
    pub fn id(&self) -> u32 {
        self.id_as.unwrap_or_else(|| self.stored_id())
    }

    /// The id the row is stored under, which is what its own data is keyed by even when it
    /// is being read as a copy under another id.
    ///
    /// This reads the id column directly rather than through [`Row::number`], because a
    /// sparse column is looked up *by* the stored id and going the long way round would
    /// have the two calling each other.
    fn stored_id(&self) -> u32 {
        if let Some(id) = self.table.sections[self.section].id_list.get(self.index) {
            return *id;
        }
        let Some(info) = self.table.columns.get(self.table.id_column) else {
            return 0;
        };
        match info.storage {
            Storage::Plain => self.plain(info),
            Storage::BitpackedSigned => sign_extend(self.bits(info), info.size_bits) as u32,
            Storage::Indexed | Storage::IndexedArray => {
                let index = self.bits(info) as usize;
                info.palette.get(index).copied().unwrap_or(0)
            }
            // A table never keeps its ids in a sparse column, so anything else is a plain
            // bit field.
            _ => self.bits(info) as u32,
        }
    }

    /// Reads a column as a number, with anything narrower widened.
    pub fn number(&self, column: usize) -> u32 {
        let Some(info) = self.table.columns.get(column) else {
            return 0;
        };
        match info.storage {
            Storage::Plain => self.plain(info),
            Storage::Common => *info.common.get(&self.stored_id()).unwrap_or(&info.default),
            Storage::Bitpacked => self.bits(info) as u32,
            Storage::BitpackedSigned => sign_extend(self.bits(info), info.size_bits) as u32,
            Storage::Indexed => {
                let index = self.bits(info) as usize;
                info.palette.get(index).copied().unwrap_or(0)
            }
            Storage::IndexedArray => {
                let index = self.bits(info) as usize * info.array_count.max(1) as usize;
                info.palette.get(index).copied().unwrap_or(0)
            }
        }
    }

    /// The foreign key this row belongs to, for a table that keeps one outside the row.
    ///
    /// Zero when the table keeps no such key, and also when the row is in a section that
    /// arrived encrypted — neither is distinguishable from a genuine zero, and neither is
    /// worth an error, because a caller joining on this simply finds nothing.
    pub fn foreign_id(&self) -> u32 {
        self.table.sections[self.section]
            .foreign_ids
            .get(self.index)
            .copied()
            .unwrap_or(0)
    }

    /// Reads one element of a column holding a fixed-size array.
    ///
    /// [`Row::number`] reads such a column as its first element, which is the right answer
    /// often enough that it is the default, but `ItemDisplayInfo` keeps a set's geoset
    /// groups and its two model slots this way and the later elements are the point.
    ///
    /// The file does not record how many elements a plainly stored array has — only its
    /// total width — so the caller gives the width of one element. That is the `<32>` in
    /// the community's column definitions, and keeping it with the caller is the same
    /// bargain the rest of this module makes about which column means what.
    pub fn element(&self, column: usize, index: usize, element_bits: u32) -> u32 {
        let Some(info) = self.table.columns.get(column) else {
            return 0;
        };
        match info.storage {
            // A palette column of runs already knows its own element count, so it needs no
            // help placing one: the index names the run, and this picks out of it.
            Storage::IndexedArray => {
                let run = self.bits(info) as usize * info.array_count.max(1) as usize;
                if index >= info.array_count.max(1) as usize {
                    return 0;
                }
                info.palette.get(run + index).copied().unwrap_or(0)
            }
            Storage::Plain => {
                if element_bits == 0 {
                    return 0;
                }
                let start = info.offset_bits + index as u32 * element_bits;
                // Reading past the column's own width would quietly return the next
                // column's bytes, which is worse than admitting there is no such element.
                if start + element_bits > info.offset_bits + info.size_bits {
                    return 0;
                }
                self.plain_at(start, element_bits)
            }
            // Every other storage holds one value per row, so only the first element exists.
            _ => {
                if index == 0 {
                    self.number(column)
                } else {
                    0
                }
            }
        }
    }

    /// Reads a column that holds a string.
    ///
    /// The row stores a distance rather than a position: the offset counts forward from
    /// where the column itself sits, in a space that runs across every section's rows and
    /// then every section's strings. Undoing that is the fiddly part.
    pub fn text(&self, column: usize) -> String {
        let table = self.table;
        let Some(info) = table.columns.get(column) else {
            return String::new();
        };
        if info.storage != Storage::Plain {
            return String::new();
        }
        let offset = self.plain(info);
        if offset == 0 {
            return String::new();
        }

        let rows_before: usize = table.sections[..self.section]
            .iter()
            .map(|earlier| table.record_size * earlier.rows)
            .sum();
        let column_at = rows_before + self.index * table.record_size + (info.offset_bits / 8) as usize;
        // Positions are counted from the end of the whole table's rows, which is what lets
        // an offset written into an early row still land inside the strings.
        let index = column_at as isize - (table.total_rows * table.record_size) as isize
            + offset as isize;
        if index < 0 {
            return String::new();
        }

        let index = index as usize;
        for section in &table.sections {
            if index < section.strings_base + section.strings_size {
                let at = section.strings_at + (index - section.strings_base);
                return read_c_string(&table.data, at);
            }
        }
        String::new()
    }

    fn row_start(&self) -> usize {
        self.table.sections[self.section].records_at + self.index * self.table.record_size
    }

    fn plain(&self, info: &Column) -> u32 {
        self.plain_at(info.offset_bits, info.size_bits)
    }

    fn plain_at(&self, offset_bits: u32, size_bits: u32) -> u32 {
        let at = self.row_start() + (offset_bits / 8) as usize;
        let width = (size_bits as usize / 8).clamp(1, 4);
        let Some(bytes) = self.table.data.get(at..at + width) else {
            return 0;
        };
        let mut value = [0u8; 4];
        value[..width].copy_from_slice(bytes);
        u32::from_le_bytes(value)
    }

    fn bits(&self, info: &Column) -> u64 {
        let at = self.row_start() + (info.offset_bits / 8) as usize;
        let available = self.table.data.len().saturating_sub(at).min(8);
        if available == 0 {
            return 0;
        }
        let mut value = [0u8; 8];
        value[..available].copy_from_slice(&self.table.data[at..at + available]);
        let raw = u64::from_le_bytes(value) >> (info.offset_bits % 8);
        if info.size_bits >= 64 {
            raw
        } else {
            raw & ((1u64 << info.size_bits) - 1)
        }
    }
}

fn sign_extend(value: u64, bits: u32) -> i64 {
    if bits == 0 || bits >= 64 {
        return value as i64;
    }
    let shift = 64 - bits;
    ((value << shift) as i64) >> shift
}

fn read_c_string(data: &[u8], at: usize) -> String {
    let Some(rest) = data.get(at..) else {
        return String::new();
    };
    let end = rest.iter().position(|byte| *byte == 0).unwrap_or(rest.len());
    String::from_utf8_lossy(&rest[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, GameFiles};

    /// The invented tables under `apps/desktop/fixtures/transmog`, which have the shape of the
    /// game's own — same columns, same storage per column, same bit offsets.
    const TRANSMOG_SET: u32 = 1376213;
    const TRANSMOG_SET_ITEM: u32 = 1376212;
    const TRANSMOG_SET_GROUP: u32 = 1576116;
    const ITEM_MODIFIED_APPEARANCE: u32 = 982457;
    const ITEM_APPEARANCE: u32 = 982462;
    const ITEM_DISPLAY_INFO: u32 = 1266429;
    const ITEM_DISPLAY_INFO_MATERIAL_RES: u32 = 1280614;

    /// Columns of `ItemDisplayInfo`, which is the table of fixed-size arrays.
    mod display {
        /// Plainly stored arrays, elements laid end to end inside one column.
        pub const MODEL_RESOURCES_ID: usize = 10;
        pub const GEOSET_GROUP: usize = 12;
        /// A palette of whole runs rather than of single values.
        pub const MODEL_TYPE: usize = 13;
        /// Not an array at all, which is the case that has to keep working.
        pub const FLAGS: usize = 0;
    }

    /// Columns of `ItemDisplayInfoMaterialRes`. Which appearance a row belongs to is not
    /// among them — that is the whole point of the table.
    mod material {
        pub const COMPONENT_SECTION: usize = 0;
        pub const MATERIAL_RESOURCES_ID: usize = 1;
    }

    /// Columns of `TransmogSet`, and the storage each one is written in.
    mod set {
        /// A string, held as a plain offset.
        pub const NAME: usize = 0;
        /// Signed bit fields, none of them a whole number of bytes wide.
        pub const ID: usize = 1;
        pub const CLASS_MASK: usize = 2;
        pub const GROUP_ID: usize = 5;
        pub const PARENT_ID: usize = 7;
        pub const EXPANSION_ID: usize = 9;
        /// Sparse columns: only the rows that differ from a default are listed.
        pub const TRACKING_QUEST_ID: usize = 3;
        pub const COMPLETE_WORLD_STATE_ID: usize = 8;
        pub const CONDITION_ID: usize = 12;
        /// Bit fields holding an index into a palette of distinct values.
        pub const FLAGS: usize = 4;
        pub const PATCH_INTRODUCED: usize = 10;
        pub const UI_ORDER: usize = 11;
    }

    /// Columns of `TransmogSetItem`, which are unsigned bit fields and one palette.
    mod item {
        pub const SET_ID: usize = 0;
        pub const APPEARANCE_ID: usize = 1;
        pub const FLAGS: usize = 2;
    }

    const GROUP_NAME: usize = 0;

    fn table(fdid: u32) -> Db2 {
        Db2::parse(fixture_files().read(fdid).unwrap()).unwrap()
    }

    fn ids(table: &Db2) -> Vec<u32> {
        table.rows().map(|row| row.id()).collect()
    }

    fn names(table: &Db2, column: usize) -> Vec<String> {
        table.rows().map(|row| row.text(column)).collect()
    }

    // One row read through every storage the format has for a column. The values are the ones
    // `scripts/make-transmog-fixtures.ts` wrote, so a decoder that reads a bit field one place
    // over, or takes a palette index for a value, cannot agree with all of them at once.
    #[test]
    fn decodes_a_row_out_of_every_storage_a_column_can_use() {
        let table = table(TRANSMOG_SET);
        let rows: Vec<Row<'_>> = table.rows().collect();
        let row = rows
            .iter()
            .find(|row| row.id() == 204)
            .expect("the fixture holds set 204");

        assert_eq!(row.text(set::NAME), "Emberforge Scales");
        assert_eq!(row.number(set::ID), 204);
        assert_eq!(row.number(set::CLASS_MASK), 0x1044);
        assert_eq!(row.number(set::GROUP_ID), 2);
        assert_eq!(row.number(set::PARENT_ID), 203);
        assert_eq!(row.number(set::EXPANSION_ID), 4);
        assert_eq!(row.number(set::FLAGS), 2);
        assert_eq!(row.number(set::PATCH_INTRODUCED), 100_300);
        assert_eq!(row.number(set::UI_ORDER), 10);
        // The one row a sparse column does list, against two that fall back to a default.
        assert_eq!(row.number(set::TRACKING_QUEST_ID), 8801);
        assert_eq!(row.number(set::COMPLETE_WORLD_STATE_ID), 1);
        assert_eq!(row.number(set::CONDITION_ID), 0);
    }

    #[test]
    fn reads_a_sparse_column_as_its_default_wherever_it_is_not_listed() {
        let table = table(TRANSMOG_SET);
        let listed: Vec<(u32, u32, u32)> = table
            .rows()
            .map(|row| {
                (
                    row.id(),
                    row.number(set::TRACKING_QUEST_ID),
                    row.number(set::CONDITION_ID),
                )
            })
            .collect();
        assert_eq!(
            listed,
            vec![
                (201, 0, 0),
                (202, 0, 0),
                (203, 0, 0),
                (204, 8801, 0),
                (205, 0, 0),
                (206, 0, 44),
            ]
        );
    }

    // Strings are stored as a distance from the column to the text, counted in a space that
    // runs across every section, so getting one right is most of the parser's arithmetic.
    #[test]
    fn resolves_a_string_column_to_its_text() {
        assert_eq!(
            names(&table(TRANSMOG_SET), set::NAME),
            vec![
                "Tideglass Regalia",
                "Tideglass Hide",
                "Emberforge Plate",
                "Emberforge Scales",
                "Duskwoven Shroud",
                "Lantern-Keeper's Coat",
            ]
        );
        assert_eq!(
            names(&table(TRANSMOG_SET_GROUP), GROUP_NAME),
            // The fourth is the copied row, which carries the first row's name.
            vec![
                "Tideglass Wardrobe",
                "Emberforge Armory",
                "Duskwoven Attire",
                "Tideglass Wardrobe",
            ]
        );
    }

    #[test]
    fn takes_ids_from_an_id_list_or_from_the_row_itself() {
        // `TransmogSet` keeps its ids in a column of the row.
        assert_eq!(ids(&table(TRANSMOG_SET)), vec![201, 202, 203, 204, 205, 206]);
        // `TransmogSetGroup` keeps them in a list beside the rows, and 7 is the copy.
        assert_eq!(ids(&table(TRANSMOG_SET_GROUP)), vec![1, 2, 3, 7]);
    }

    // A table can say "row 14 is row 1 again under a new id" rather than store it twice, and a
    // caller counting appearances per set has to see both.
    #[test]
    fn reads_a_copied_row_under_its_new_id_with_the_data_it_copied() {
        let table = table(TRANSMOG_SET_ITEM);
        let rows: Vec<Row<'_>> = table.rows().collect();
        assert_eq!(rows.len(), 14);

        let original = rows.iter().find(|row| row.id() == 1).unwrap();
        let copy = rows
            .iter()
            .find(|row| row.id() == 14)
            .expect("the fixture copies row 1 to id 14");
        for column in [item::SET_ID, item::APPEARANCE_ID, item::FLAGS] {
            assert_eq!(copy.number(column), original.number(column));
        }
        assert_eq!(copy.number(item::SET_ID), 201);
        // The appearance id is the first hop of the chain the detail view walks, so the copy
        // has to carry it intact rather than merely carry something.
        assert_eq!(copy.number(item::APPEARANCE_ID), 71001);

        // The palette column still reads as a value rather than as its index.
        let flagged = rows.iter().find(|row| row.id() == 3).unwrap();
        assert_eq!(flagged.number(item::FLAGS), 1);
        assert_eq!(original.number(item::FLAGS), 0);
    }

    // Blizzard encrypts the sections belonging to content it has not shipped; they arrive as
    // zeroes, and a row read out of one would be a set with no name and no id.
    #[test]
    fn skips_a_section_that_arrived_encrypted_but_still_counts_it() {
        let sets = table(TRANSMOG_SET);
        assert_eq!(sets.rows().count(), 6);
        assert_eq!(sets.declared_rows(), 8);
        assert!(!names(&sets, set::NAME).iter().any(|name| name.contains("Unreleased")));
        assert!(!ids(&sets).contains(&900));

        let items = table(TRANSMOG_SET_ITEM);
        assert!(!items.rows().any(|row| row.number(item::SET_ID) == 900));
    }

    #[test]
    fn refuses_a_file_that_is_not_a_wdc5_table() {
        let mut bytes = fixture_files().read(TRANSMOG_SET).unwrap();
        bytes[0..4].copy_from_slice(b"WDC4");
        let error = Db2::parse(bytes).err().expect("a WDC4 table is refused");
        assert!(error.contains("WDC5"), "{error}");

        assert!(Db2::parse(Vec::new()).is_err());
        assert!(Db2::parse(b"WDC5".to_vec()).is_err());
    }

    // Every prefix of a real table, so a file cut off anywhere is a message rather than a
    // panic — including the rows a header that survived the cut still promises.
    // Reading an array column as one number gets its first element, which is what every
    // caller that does not know better will do, so it has to stay true.
    #[test]
    fn reads_an_array_column_as_its_first_element() {
        let table = table(ITEM_DISPLAY_INFO);
        let first: Vec<u32> = table
            .rows()
            .map(|row| row.number(display::MODEL_RESOURCES_ID))
            .collect();
        // The last row is the one that keeps a model only in its second slot, and reading
        // the column as one number is exactly how that gets missed.
        assert_eq!(first, vec![41001, 41002, 0, 0, 0, 0, 41004, 0, 0]);
    }

    // The elements past the first are the reason this exists: a shoulder set keeps a model
    // in both slots and a chestpiece drives five geoset groups, none of which is readable
    // from the first element alone.
    #[test]
    fn reads_every_element_of_a_plainly_stored_array() {
        let table = table(ITEM_DISPLAY_INFO);
        let models: Vec<Vec<u32>> = table
            .rows()
            .map(|row| {
                (0..2)
                    .map(|at| row.element(display::MODEL_RESOURCES_ID, at, 32))
                    .collect()
            })
            .collect();
        assert_eq!(
            models,
            vec![
                vec![41001, 0],
                vec![41002, 41003],
                vec![0, 0],
                vec![0, 0],
                vec![0, 0],
                vec![0, 0],
                vec![41004, 0],
                vec![0, 0],
                vec![0, 41005],
            ]
        );

        let geosets: Vec<Vec<u32>> = table
            .rows()
            .map(|row| {
                (0..6)
                    .map(|at| row.element(display::GEOSET_GROUP, at, 32))
                    .collect()
            })
            .collect();
        assert_eq!(
            geosets,
            vec![
                vec![27, 21, 0, 0, 0, 0],
                vec![26, 0, 0, 0, 0, 0],
                vec![8, 10, 13, 22, 28, 0],
                vec![5, 20, 0, 0, 0, 0],
                vec![4, 23, 0, 0, 0, 0],
                vec![11, 9, 13, 0, 0, 0],
                vec![0, 0, 0, 0, 0, 0],
                vec![0, 0, 0, 0, 0, 0],
                vec![26, 0, 0, 0, 0, 0],
            ]
        );
    }

    // A palette column of runs keeps only the run number in the row, so its elements come
    // out of the palette rather than out of the record.
    #[test]
    fn reads_every_element_of_a_palette_of_runs() {
        let table = table(ITEM_DISPLAY_INFO);
        let types: Vec<Vec<u32>> = table
            .rows()
            .map(|row| {
                (0..2)
                    .map(|at| row.element(display::MODEL_TYPE, at, 32))
                    .collect()
            })
            .collect();
        assert_eq!(
            types,
            vec![
                vec![1, 0],
                vec![2, 3],
                vec![0, 0],
                vec![0, 0],
                vec![0, 0],
                vec![0, 0],
                vec![1, 0],
                vec![0, 0],
                vec![2, 3],
            ]
        );
    }

    #[test]
    fn reads_a_column_that_is_not_an_array_as_its_only_element() {
        let table = table(ITEM_DISPLAY_INFO);
        let flags: Vec<u32> = table
            .rows()
            .map(|row| row.element(display::FLAGS, 0, 32))
            .collect();
        assert_eq!(flags, vec![1, 0, 16, 0, 0, 0, 0, 0, 0]);
        // Asking past the end says so rather than running into the next column.
        for row in table.rows() {
            assert_eq!(row.element(display::FLAGS, 1, 32), 0);
            assert_eq!(row.element(display::MODEL_RESOURCES_ID, 2, 32), 0);
            assert_eq!(row.element(display::MODEL_TYPE, 2, 32), 0);
        }
    }

    // `ItemDisplayInfoMaterialRes` says which body section a texture covers but not whose
    // texture it is; that lives in a block beside the rows and nowhere else.
    #[test]
    fn ties_a_row_to_the_foreign_key_kept_outside_it() {
        let table = table(ITEM_DISPLAY_INFO_MATERIAL_RES);
        let joined: Vec<(u32, u32, u32)> = table
            .rows()
            .map(|row| {
                (
                    row.foreign_id(),
                    row.number(material::COMPONENT_SECTION),
                    row.number(material::MATERIAL_RESOURCES_ID),
                )
            })
            .collect();
        assert_eq!(
            joined,
            vec![
                (900003, 3, 52001),
                (900003, 0, 52002),
                (900003, 4, 52003),
                (900002, 5, 52004),
                (900002, 6, 52005),
                (900001, 7, 52006),
                (900003, 2, 52007),
            ]
        );

        // Which is what lets a caller ask the question it actually has: what covers this
        // appearance, and where does each piece of it go.
        let mut sections: Vec<u32> = table
            .rows()
            .filter(|row| row.foreign_id() == 900003)
            .map(|row| row.number(material::COMPONENT_SECTION))
            .collect();
        sections.sort_unstable();
        assert_eq!(sections, vec![0, 2, 3, 4]);
    }

    // A table that keeps no such block is not broken, it simply has no foreign key.
    #[test]
    fn says_nothing_for_a_table_that_keeps_no_relationship_map() {
        for row in table(TRANSMOG_SET).rows() {
            assert_eq!(row.foreign_id(), 0);
        }
    }

    // The encrypted section reserves the block at full size but arrives as zeroes, so its
    // rows are skipped like any other encrypted row rather than joining against nothing.
    #[test]
    fn leaves_out_the_relationships_of_a_section_it_cannot_decrypt() {
        let table = table(ITEM_DISPLAY_INFO_MATERIAL_RES);
        assert_eq!(table.declared_rows(), 8);
        assert_eq!(table.rows().count(), 7);
        assert!(table.rows().all(|row| row.foreign_id() != 900900));
    }

    #[test]
    fn refuses_a_truncated_table_without_panicking() {
        for fdid in [
            TRANSMOG_SET,
            TRANSMOG_SET_ITEM,
            TRANSMOG_SET_GROUP,
            ITEM_MODIFIED_APPEARANCE,
            ITEM_APPEARANCE,
            ITEM_DISPLAY_INFO,
            ITEM_DISPLAY_INFO_MATERIAL_RES,
        ] {
            let whole = fixture_files().read(fdid).unwrap();
            for length in 0..whole.len() {
                let Ok(table) = Db2::parse(whole[..length].to_vec()) else {
                    continue;
                };
                for row in table.rows() {
                    row.id();
                    row.foreign_id();
                    for column in 0..16 {
                        row.number(column);
                        row.text(column);
                        for at in 0..8 {
                            row.element(column, at, 32);
                        }
                    }
                }
            }
            assert!(Db2::parse(whole[..whole.len() / 2].to_vec()).is_err());
        }
    }
}
