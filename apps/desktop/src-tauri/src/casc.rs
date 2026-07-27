//! Reading files out of the game's own storage.
//!
//! The client keeps everything in CASC: a handful of `data.NNN` blobs under `Data/`, indexed
//! by `.idx` files that map a truncated encoding key to a position. Getting from "the file
//! the game calls 1376213" to bytes takes four hops — `.build.info` names the live build
//! config, the build config names the encoding and root files, root maps a FileDataID to a
//! content key, and encoding maps that content key to the encoding key the `.idx` is keyed
//! on. Every payload is then BLTE-encoded on top.
//!
//! Nothing here writes to the game folder, and nothing outside [`GameFiles`] needs to know
//! any of it: the tests read the same FileDataIDs out of a directory of fixture files.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use flate2::read::ZlibDecoder;
use tact_parser::wow_root::{LocaleFlags, WowRoot};

/// A source of game files, addressed the way the client addresses them.
///
/// The real implementation walks the install's CASC storage; the fixture one reads a
/// directory. Everything above this trait is indifferent to which it got.
pub trait GameFiles {
    /// Reads the file the client knows as `fdid`, decoded and ready to parse.
    fn read(&self, fdid: u32) -> Result<Vec<u8>, String>;
}

/// A borrowed source is a source, which is what lets [`Counted`] wrap the `&dyn GameFiles` the
/// commands pass around without taking it away from whoever else is holding it.
impl<F: GameFiles + ?Sized> GameFiles for &F {
    fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
        (**self).read(fdid)
    }
}

/// Game files as a directory of `<fdid>.<ext>`, which is how the tests supply them.
///
/// The client addresses everything it owns by number and says nothing about what kind of
/// file it is, so the extension here is naming for a human reading the fixture directory
/// rather than something a caller knows. A read tries each of them.
pub struct DirFiles {
    dir: PathBuf,
}

/// The kinds of file the fixtures hold: the game's tables, the textures they point at, the
/// models and skin profiles behind the appearances that have geometry, and the one skeleton —
/// which is where a character keeps the attachments the rest of them hang off.
const FIXTURE_EXTENSIONS: [&str; 5] = ["db2", "blp", "m2", "skin", "skel"];

impl DirFiles {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
}

impl GameFiles for DirFiles {
    fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
        let mut error = String::new();
        for extension in FIXTURE_EXTENSIONS {
            let path = self.dir.join(format!("{fdid}.{extension}"));
            match std::fs::read(&path) {
                Ok(bytes) => return Ok(bytes),
                // Only one of the names can be the one that was meant, and nothing here
                // knows which, so the first is what a failure is reported against.
                Err(problem) if error.is_empty() => {
                    error = format!("{}: {problem}", path.display());
                }
                Err(_) => {}
            }
        }
        Err(error)
    }
}

/// Game files that remember what was asked of them.
///
/// A decorator rather than a mode on [`DirFiles`], so it wraps a real install as readily as a
/// directory of fixtures — which is what lets one budget be checked against both.
///
/// **What it counts is the point of it.** Every read here is a BLTE payload inflated on a real
/// install, and the largest of them is 85ms on its own; a read that happens twice for one click
/// is 85ms spent twice. So the list is kept in order and whole, repeats included, and
/// [`crate::budget`] is what reads it.
pub struct Counted<F> {
    files: F,
    asked: std::cell::RefCell<Vec<u32>>,
}

impl<F: GameFiles> Counted<F> {
    pub fn new(files: F) -> Self {
        Self { files, asked: std::cell::RefCell::new(Vec::new()) }
    }

    /// Every file asked for, in the order it was asked for, with repeats kept.
    pub fn asked(&self) -> Vec<u32> {
        self.asked.borrow().clone()
    }
}

impl<F: GameFiles> GameFiles for Counted<F> {
    fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
        self.asked.borrow_mut().push(fdid);
        self.files.read(fdid)
    }
}

/// The invented tables and textures the tests read in place of a game install.
///
/// They are real WDC5 and BLP2 files with made-up content, written by the scripts under
/// `scripts/` — one directory per area of the game — and the path is resolved from the crate
/// rather than from the working directory so a test run from anywhere finds them.
#[cfg(test)]
pub fn fixtures(area: &str) -> DirFiles {
    DirFiles::new(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join(area),
    )
}

/// The fixtures for the transmog chain, written by `scripts/make-transmog-fixtures.ts`.
#[cfg(test)]
pub fn fixture_files() -> DirFiles {
    fixtures("transmog")
}

/// The fixtures for the achievement tables, written by
/// `scripts/make-achievement-fixtures.ts`.
#[cfg(test)]
pub fn achievement_fixture_files() -> DirFiles {
    fixtures("achievements")
}

/* ---------- the real thing ---------- */

/// The 30-byte record CASC writes in front of every BLTE payload inside a `data.NNN`.
const ENTRY_HEADER: usize = 30;

/// Where a file sits inside the `data.NNN` blobs.
#[derive(Clone, Copy)]
struct Location {
    archive: u16,
    offset: u64,
    size: u32,
}

/// The game's CASC storage, opened read-only.
pub struct CascFiles {
    data_dir: PathBuf,
    /// Keyed by the 9-byte encoding-key prefix, which is all the `.idx` files keep.
    locations: HashMap<[u8; 9], Location>,
    encoding: Encoding,
    root: WowRoot,
}

impl CascFiles {
    /// Opens the storage under a World of Warcraft install.
    ///
    /// `install` is the folder holding `Data/` — the parent of `_retail_`, not `_retail_`
    /// itself, which is the path the rest of the app carries around.
    #[tracing::instrument(name = "casc.open", skip_all)]
    pub fn open(install: &Path) -> Result<Self, String> {
        let data_dir = install.join("Data");
        if !data_dir.is_dir() {
            return Err(format!(
                "No Data folder under {}; that is where the game keeps its files.",
                install.display()
            ));
        }

        let build_key = live_build_key(install)?;
        let config = read_config(&data_dir, &build_key)?;
        let encoding_ekey = config
            .get("encoding")
            .and_then(|value| value.split_whitespace().nth(1))
            .ok_or("The build config names no encoding file.")?;
        let root_ckey = config
            .get("root")
            .and_then(|value| value.split_whitespace().next())
            .ok_or("The build config names no root file.")?;
        let root_ckey = parse_key(root_ckey)?;

        let locations = load_indices(&data_dir)?;
        let mut storage = Self {
            data_dir,
            locations,
            encoding: Encoding::empty(),
            root: WowRoot {
                fid_md5: Default::default(),
                name_hash_fid: Default::default(),
            },
        };

        storage.encoding = {
            let held = tracing::info_span!("casc.encoding", bytes = tracing::field::Empty).entered();
            let bytes = storage.fetch(&parse_key(encoding_ekey)?)?;
            held.record("bytes", bytes.len());
            Encoding::parse(bytes)?
        };
        let root_ekey = storage
            .encoding
            .encoding_key(&root_ckey)
            .ok_or("The root file is not listed in encoding.")?;
        storage.root = {
            let held = tracing::info_span!("casc.root", bytes = tracing::field::Empty).entered();
            let root_bytes = storage.fetch(&root_ekey)?;
            held.record("bytes", root_bytes.len());
            WowRoot::parse(&mut Cursor::new(&root_bytes), LocaleFlags::any_locale())
                .map_err(|error| format!("The root file would not parse: {error}"))?
        };
        Ok(storage)
    }

    /// Pulls one BLTE payload out of the `data.NNN` blobs by encoding key.
    #[tracing::instrument(name = "casc.fetch", skip_all)]
    fn fetch(&self, ekey: &[u8; 16]) -> Result<Vec<u8>, String> {
        let mut prefix = [0u8; 9];
        prefix.copy_from_slice(&ekey[0..9]);
        let location = self
            .locations
            .get(&prefix)
            .ok_or("That file is not installed.")?;
        let path = self
            .data_dir
            .join("data")
            .join(format!("data.{:03}", location.archive));
        let file = File::open(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let mut raw = vec![0u8; location.size as usize];
        read_exact_at(&file, &mut raw, location.offset)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if raw.len() <= ENTRY_HEADER {
            return Err("Truncated archive entry.".into());
        }
        blte_decode(&raw[ENTRY_HEADER..])
    }
}

impl GameFiles for CascFiles {
    #[tracing::instrument(name = "casc.read", skip_all, fields(fdid = fdid))]
    fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
        let variants = self
            .root
            .fid_md5
            .get(&fdid)
            .ok_or_else(|| format!("The build has no file {fdid}."))?;
        // Root lists every locale and platform variant of the build, but an install only
        // holds the ones it downloaded, so the first one that is actually present wins.
        let mut last = String::from("no variant is installed");
        for ckey in variants.values() {
            let Some(ekey) = self.encoding.encoding_key(ckey) else {
                continue;
            };
            match self.fetch(&ekey) {
                Ok(bytes) => return Ok(bytes),
                Err(error) => last = error,
            }
        }
        Err(format!("Could not read file {fdid}: {last}"))
    }
}

/* ---------- build info and config ---------- */

/// Reads the build key of the branch the launcher last activated.
///
/// `.build.info` is a pipe-separated table with a typed header; several branches can share
/// one install, and only the active row describes the build on disk.
fn live_build_key(install: &Path) -> Result<String, String> {
    let path = install.join(".build.info");
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let mut lines = text.lines();
    let header: Vec<&str> = lines
        .next()
        .ok_or("`.build.info` is empty.")?
        .split('|')
        .collect();
    let column = |name: &str| header.iter().position(|field| field.starts_with(name));
    let build_key = column("Build Key").ok_or("`.build.info` has no Build Key column.")?;
    let active = column("Active");

    for line in lines {
        let row: Vec<&str> = line.split('|').collect();
        let is_active = active.map_or(true, |at| row.get(at) == Some(&"1"));
        if is_active {
            if let Some(key) = row.get(build_key).filter(|key| key.len() == 32) {
                return Ok((*key).to_string());
            }
        }
    }
    Err("`.build.info` names no active build.".into())
}

/// Reads a config file, which CASC files away under the first two byte-pairs of its hash.
fn read_config(data_dir: &Path, key: &str) -> Result<HashMap<String, String>, String> {
    let path = data_dir
        .join("config")
        .join(&key[0..2])
        .join(&key[2..4])
        .join(key);
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(text
        .lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect())
}

fn parse_key(hex: &str) -> Result<[u8; 16], String> {
    if hex.len() != 32 {
        return Err(format!("`{hex}` is not a 16-byte key."));
    }
    let mut key = [0u8; 16];
    for (i, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("`{hex}` is not hexadecimal."))?;
    }
    Ok(key)
}

/* ---------- the local indices ---------- */

/// Reads every `.idx` bucket under `Data/data` into one prefix-keyed table.
///
/// Each bucket is a header, a small table CASC uses for its own bookkeeping, then a run of
/// fixed-size entries: a 9-byte key prefix, a 40-bit big-endian word packing the archive
/// number above the offset, and a little-endian size.
#[tracing::instrument(name = "casc.indices", skip_all)]
fn load_indices(data_dir: &Path) -> Result<HashMap<[u8; 9], Location>, String> {
    let dir = data_dir.join("data");
    let entries = std::fs::read_dir(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let mut locations = HashMap::new();
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "idx"))
        .collect();
    // Buckets are versioned by filename, so the highest name for each bucket is the live one.
    files.sort();
    let mut newest: HashMap<String, PathBuf> = HashMap::new();
    for path in files {
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if stem.len() >= 2 {
            newest.insert(stem[0..2].to_string(), path);
        }
    }
    for path in newest.values() {
        read_index(path, &mut locations)?;
    }
    if locations.is_empty() {
        return Err(format!("No index entries under {}.", dir.display()));
    }
    Ok(locations)
}

fn read_index(path: &Path, into: &mut HashMap<[u8; 9], Location>) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if data.len() < 16 {
        return Err(format!("{} is too short to be an index.", path.display()));
    }
    let header_size = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    let size_bytes = data[12] as usize;
    let offset_bytes = data[13] as usize;
    let key_bytes = data[14] as usize;
    if key_bytes != 9 || offset_bytes != 5 || size_bytes != 4 {
        return Err(format!(
            "{} uses an index layout this build does not know ({key_bytes}/{offset_bytes}/{size_bytes}).",
            path.display()
        ));
    }

    // The entry run starts on the 16-byte boundary after the header, past its own size and
    // checksum pair.
    let mut at = 8 + header_size;
    at += (16 - at % 16) % 16;
    if data.len() < at + 8 {
        return Err(format!("{} ends before its entries.", path.display()));
    }
    let entries_size = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    at += 8;

    let entry_size = key_bytes + offset_bytes + size_bytes;
    let count = entries_size / entry_size;
    for index in 0..count {
        let start = at + index * entry_size;
        let Some(entry) = data.get(start..start + entry_size) else {
            break;
        };
        let mut prefix = [0u8; 9];
        prefix.copy_from_slice(&entry[0..9]);
        let packed = u64::from(entry[9]) << 32
            | u64::from(u32::from_be_bytes(entry[10..14].try_into().unwrap()));
        let size = u32::from_le_bytes(entry[14..18].try_into().unwrap());
        into.insert(
            prefix,
            Location {
                archive: (packed >> 30) as u16,
                offset: packed & 0x3FFF_FFFF,
                size,
            },
        );
    }
    Ok(())
}

#[cfg(unix)]
fn read_exact_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buffer, offset)
}

#[cfg(windows)]
fn read_exact_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut read = 0;
    while read < buffer.len() {
        match file.seek_read(&mut buffer[read..], offset + read as u64)? {
            0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "archive ended early",
                ))
            }
            n => read += n,
        }
    }
    Ok(())
}

/* ---------- BLTE ---------- */

/// Decodes a BLTE payload.
///
/// A payload is a table of chunks, each tagged with how it was stored. Blizzard encrypts
/// the chunks belonging to content it has not released yet, and the key for those is not
/// public — those chunks come back as zeroes, which is what every other tool does and what
/// the DB2 reader is written to expect, because the records inside them live in their own
/// sections that it can then recognise and skip.
#[tracing::instrument(name = "casc.blte", skip_all, fields(bytes = data.len()))]
pub fn blte_decode(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 8 || &data[0..4] != b"BLTE" {
        return Err("Not a BLTE payload.".into());
    }
    let header_size = u32::from_be_bytes(data[4..8].try_into().unwrap()) as usize;
    if header_size == 0 {
        // A single implicit chunk, stored whole.
        return decode_chunk(&data[8..], None);
    }
    if data.len() < 12 {
        return Err("Truncated BLTE header.".into());
    }
    let chunk_count = (u32::from_be_bytes(data[8..12].try_into().unwrap()) & 0x00FF_FFFF) as usize;

    let mut out = Vec::new();
    let mut table = 12;
    let mut at = header_size;
    for _ in 0..chunk_count {
        let entry = data
            .get(table..table + 24)
            .ok_or("Truncated BLTE chunk table.")?;
        let compressed = u32::from_be_bytes(entry[0..4].try_into().unwrap()) as usize;
        let decompressed = u32::from_be_bytes(entry[4..8].try_into().unwrap()) as usize;
        table += 24;
        let chunk = data
            .get(at..at + compressed)
            .ok_or("Truncated BLTE chunk data.")?;
        at += compressed;
        out.extend_from_slice(&decode_chunk(chunk, Some(decompressed))?);
    }
    Ok(out)
}

fn decode_chunk(chunk: &[u8], decompressed: Option<usize>) -> Result<Vec<u8>, String> {
    let (mode, body) = chunk.split_first().ok_or("Empty BLTE chunk.")?;
    match mode {
        b'N' => Ok(body.to_vec()),
        b'Z' => {
            let mut out = Vec::new();
            ZlibDecoder::new(body)
                .read_to_end(&mut out)
                .map_err(|error| format!("A BLTE chunk would not inflate: {error}"))?;
            Ok(out)
        }
        b'F' => blte_decode(body),
        // Encrypted, and only Blizzard has the key. Zeroes keep every following chunk at
        // the offset the file says it is at, which is what lets the rest still be read.
        b'E' => Ok(vec![0u8; decompressed.unwrap_or(0)]),
        other => Err(format!(
            "A BLTE chunk uses storage mode `{}`, which is not known.",
            *other as char
        )),
    }
}

/* ---------- encoding ---------- */

/// The encoding file, kept whole and searched a page at a time.
///
/// It is the biggest thing in the install — around 200MB — and all we ever want from it is
/// three lookups. Its layout is a header, an ESpec block, the content-key page table, the
/// content-key pages, and then encoding-key tables we never touch. Each page-table entry
/// leads with the first content key on its page and the table is sorted, so one binary
/// search and one 4KB page beats walking every one of its millions of entries.
struct Encoding {
    data: Vec<u8>,
    table: usize,
    pages: usize,
    page_size: usize,
    page_count: usize,
}

impl Encoding {
    fn empty() -> Self {
        Self {
            data: Vec::new(),
            table: 0,
            pages: 0,
            page_size: 0,
            page_count: 0,
        }
    }

    fn parse(data: Vec<u8>) -> Result<Self, String> {
        if data.len() < 22 || &data[0..2] != b"EN" {
            return Err("Not an encoding file.".into());
        }
        let page_size = usize::from(u16::from_be_bytes(data[5..7].try_into().unwrap())) * 1024;
        let page_count = u32::from_be_bytes(data[9..13].try_into().unwrap()) as usize;
        let espec = u32::from_be_bytes(data[18..22].try_into().unwrap()) as usize;
        let table = 22 + espec;
        let pages = table + page_count * 32;
        if page_size == 0 || data.len() < pages + page_count * page_size {
            return Err("The encoding file is shorter than its own header claims.".into());
        }
        Ok(Self {
            data,
            table,
            pages,
            page_size,
            page_count,
        })
    }

    fn first_content_key(&self, page: usize) -> &[u8] {
        let at = self.table + page * 32;
        &self.data[at..at + 16]
    }

    /// Finds the encoding key a content key was stored under.
    fn encoding_key(&self, ckey: &[u8]) -> Option<[u8; 16]> {
        if self.page_count == 0 {
            return None;
        }
        // The last page whose first key still sorts at or below the one we want.
        let mut low = 0usize;
        let mut high = self.page_count;
        while low + 1 < high {
            let mid = low.midpoint(high);
            if self.first_content_key(mid) <= ckey {
                low = mid;
            } else {
                high = mid;
            }
        }

        let page = self.data.get(self.pages + low * self.page_size..)?;
        let page = page.get(..self.page_size)?;
        let mut at = 0usize;
        // Entries are a key count, a 40-bit size, the content key, then that many encoding
        // keys; a zero count is the padding that ends the page.
        while at + 22 <= page.len() {
            let key_count = page[at] as usize;
            if key_count == 0 {
                break;
            }
            if &page[at + 6..at + 22] == ckey {
                return page.get(at + 22..at + 38)?.try_into().ok();
            }
            at += 22 + 16 * key_count;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    /// Builds a BLTE payload out of already-encoded chunks, each with the size it decodes to.
    ///
    /// This is the multi-chunk form: a chunk table of sizes and a checksum nothing verifies,
    /// then the chunks themselves. The count carries the flags byte the game writes above it,
    /// which a reader has to mask off.
    fn blte(chunks: &[(Vec<u8>, u32)]) -> Vec<u8> {
        let header_size = 12 + 24 * chunks.len();
        let mut out = b"BLTE".to_vec();
        out.extend_from_slice(&(header_size as u32).to_be_bytes());
        out.extend_from_slice(&(0x0F00_0000 | chunks.len() as u32).to_be_bytes());
        for (body, decompressed) in chunks {
            out.extend_from_slice(&(body.len() as u32).to_be_bytes());
            out.extend_from_slice(&decompressed.to_be_bytes());
            out.extend_from_slice(&[0u8; 16]);
        }
        for (body, _) in chunks {
            out.extend_from_slice(body);
        }
        out
    }

    fn stored(data: &[u8]) -> Vec<u8> {
        let mut chunk = vec![b'N'];
        chunk.extend_from_slice(data);
        chunk
    }

    fn deflated(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        let mut chunk = vec![b'Z'];
        chunk.extend_from_slice(&encoder.finish().unwrap());
        chunk
    }

    #[test]
    fn decodes_a_chunk_that_was_stored_whole() {
        let payload = blte(&[(stored(b"WDC5 and then some"), 18)]);
        assert_eq!(blte_decode(&payload).unwrap(), b"WDC5 and then some");
    }

    // A file small enough not to be worth a chunk table is written as one implicit chunk,
    // which the header marks by claiming no header at all.
    #[test]
    fn decodes_a_payload_that_declares_no_chunk_table() {
        let mut payload = b"BLTE".to_vec();
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&stored(b"one chunk, no table"));
        assert_eq!(blte_decode(&payload).unwrap(), b"one chunk, no table");
    }

    #[test]
    fn inflates_a_chunk_that_was_compressed() {
        let body = b"tideglass tideglass tideglass tideglass".repeat(4);
        let chunk = deflated(&body);
        assert!(chunk.len() < body.len(), "the fixture is not actually compressed");
        assert_eq!(blte_decode(&blte(&[(chunk, body.len() as u32)])).unwrap(), body);
    }

    // Chunks are concatenated in the order the table lists them, whatever each was stored as.
    #[test]
    fn joins_every_chunk_of_a_multi_chunk_payload() {
        let payload = blte(&[
            (stored(b"first "), 6),
            (deflated(b"second "), 7),
            (stored(b"third"), 5),
        ]);
        assert_eq!(blte_decode(&payload).unwrap(), b"first second third");
    }

    // Blizzard encrypts what it has not shipped, and nobody outside it holds the key. Zeroes
    // of the right length keep every following chunk where the file says it is, which is what
    // lets the readable half of a table still be read.
    #[test]
    fn fills_an_encrypted_chunk_with_zeroes_to_its_declared_size() {
        let payload = blte(&[
            (stored(b"readable"), 8),
            (vec![b'E', 0x11, 0x22, 0x33], 16),
            (stored(b"!"), 1),
        ]);
        let out = blte_decode(&payload).unwrap();
        assert_eq!(out.len(), 25);
        assert_eq!(&out[0..8], b"readable");
        assert!(out[8..24].iter().all(|byte| *byte == 0));
        assert_eq!(&out[24..], b"!");
    }

    #[test]
    fn refuses_a_storage_mode_it_does_not_know() {
        let error = blte_decode(&blte(&[(vec![b'Q', 1, 2, 3], 3)])).unwrap_err();
        assert!(error.contains('Q'), "{error}");
    }

    #[test]
    fn refuses_a_payload_that_ends_early() {
        let whole = blte(&[(stored(b"first "), 6), (stored(b"second"), 6)]);
        let cases: [(&str, Vec<u8>); 5] = [
            ("not a payload at all", b"WDC5".to_vec()),
            ("nothing but the magic", b"BLTE".to_vec()),
            ("an implicit chunk with no body", b"BLTE\0\0\0\0".to_vec()),
            ("a chunk table cut in half", whole[..whole.len() - 40].to_vec()),
            ("chunk data cut short", whole[..whole.len() - 4].to_vec()),
        ];
        for (what, payload) in cases {
            assert!(blte_decode(&payload).is_err(), "{what} decoded anyway");
        }
    }

    #[test]
    fn reads_a_fixture_table_by_the_id_the_game_uses() {
        let bytes = fixture_files().read(1376213).unwrap();
        assert_eq!(&bytes[0..4], b"WDC5");
    }

    #[test]
    fn says_which_file_was_missing() {
        let temp = tempfile::tempdir().unwrap();
        let error = DirFiles::new(temp.path()).read(1376213).unwrap_err();
        assert!(error.contains("1376213.db2"), "{error}");
    }
}
