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
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use flate2::read::ZlibDecoder;

/// A source of game files, addressed the way the client addresses them.
///
/// The real implementation walks the install's CASC storage; the fixture one reads a
/// directory. Everything above this trait is indifferent to which it got.
pub trait GameFiles {
    /// Reads the file the client knows as `fdid`, decoded and ready to parse.
    fn read(&self, fdid: u32) -> Result<Vec<u8>, String>;
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

/// The fixtures for the item tables, written by `scripts/make-item-fixtures.ts`.
#[cfg(test)]
pub fn item_fixture_files() -> DirFiles {
    fixtures("items")
}

/* ---------- the real thing ---------- */

/// The 30-byte record CASC writes in front of every BLTE payload inside a `data.NNN`.
const ENTRY_HEADER: usize = 30;

/// Where a file sits inside the `data.NNN` blobs.
///
/// The offset is a `u32` rather than the `u64` the packed index word is read out of, because
/// the word only carries 30 bits of it — with a million and a half of these resident, the
/// four bytes the wider type would round the whole struct up by are worth not spending.
#[derive(Clone, Copy)]
struct Location {
    archive: u16,
    offset: u32,
    size: u32,
}

/// The game's CASC storage, opened read-only.
///
/// Opening one is expensive — half a second and a few hundred megabytes on a real install —
/// so the app holds one rather than opening one per command. What that costs is the three
/// fields below, and [`weight`](CascFiles::weight) is what says so out loud.
pub struct CascFiles {
    data_dir: PathBuf,
    /// The build this was opened on, so a caller holding one can tell when the game has been
    /// patched underneath it.
    build_key: String,
    /// Keyed by the 9-byte encoding-key prefix, which is all the `.idx` files keep.
    locations: HashMap<[u8; 9], Location>,
    encoding: Encoding,
    root: Root,
}

/// What an open handle is holding, in bytes, part by part.
///
/// Reported rather than inferred: the point of asking is to decide whether the app can keep
/// a handle between clicks, and that is a question about megabytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Weight {
    pub locations: usize,
    pub encoding: usize,
    pub root: usize,
}

impl Weight {
    pub fn total(&self) -> usize {
        self.locations + self.encoding + self.root
    }
}

/// What a hash table of `capacity` entries actually allocated.
///
/// A table's cost is its buckets, not the entries in them, and `HashMap::capacity` reports
/// the latter — how many more can go in before it grows. Standard hash maps are hashbrown
/// underneath, which rounds a wanted capacity up to a power-of-two bucket count with an
/// eighth left spare, and lays out one slot plus one control byte per bucket. Rebuilding that
/// arithmetic here rather than reporting `capacity` directly, because the difference on the
/// index is 43MB against 50MB and the point of the number is to be right about megabytes.
fn table_bytes<T>(capacity: usize) -> usize {
    let buckets = (capacity.saturating_mul(8) / 7).next_power_of_two();
    buckets * (std::mem::size_of::<T>() + 1)
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
            build_key,
            locations,
            encoding: Encoding::empty(),
            root: Root::empty(),
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
            Root::parse(&root_bytes)?
        };
        Ok(storage)
    }

    /// The build key this was opened on.
    ///
    /// A handle is a snapshot: root and encoding describe the build that was live when it was
    /// read, and after a patch they describe a build the launcher has moved off. Anything
    /// holding one across that has to notice, and this and [`live_build_key`] are how.
    pub fn build_key(&self) -> &str {
        &self.build_key
    }

    /// Whether the install still says it is on the build this was opened from.
    pub fn is_current(&self, install: &Path) -> bool {
        live_build_key(install).is_ok_and(|key| key == self.build_key)
    }

    /// What this handle is holding, part by part.
    pub fn weight(&self) -> Weight {
        Weight {
            locations: table_bytes::<([u8; 9], Location)>(self.locations.capacity()),
            encoding: self.encoding.weight(),
            root: self.root.weight(),
        }
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
        read_exact_at(&file, &mut raw, u64::from(location.offset))
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
        let variants = self.root.variants(fdid);
        if variants.is_empty() {
            return Err(format!("The build has no file {fdid}."));
        }
        // Root lists every locale and platform variant of the build, but an install only
        // holds the ones it downloaded, so the first one that is actually present wins.
        let mut last = String::from("no variant is installed");
        for (_, ckey) in variants {
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

/* ---------- root ---------- */

/// `TSFM`, which every root file since 8.2 leads with. Classic Era's has no magic at all and
/// is recognised by its absence.
const ROOT_MAGIC: &[u8; 4] = b"TSFM";

/// The header length that says the file also carries a version and a total file count.
/// Anything else and the field read as a length was the count, which is the pre-10.1.7 shape.
const VERSIONED_HEADER: u32 = 0x18;

/// Content flag `0x1000_0000`: this block's records carry no name hashes.
const NO_NAME_HASH: u32 = 0x1000_0000;

/// The root file, reduced to the one question this app asks of it.
///
/// Root is a map from FileDataID to the content key of the file's bytes, written as a run of
/// blocks — one per combination of locale and content flags — each holding delta-coded file
/// ids, then their content keys, then optionally a Jenkins hash of each one's path.
///
/// Parsed here rather than by `tact_parser::wow_root`, which builds a
/// `BTreeMap<u32, BTreeMap<flags, md5>>` — an inner map allocated per file id, which on this
/// install is 1.88 million of them and 794MB. The same data as a flat pair per variant is
/// 61MB, and the path hashes, which this app never asks for because it addresses everything
/// by number, are skipped rather than collected.
struct Root {
    /// `(FileDataID, content key)`, ordered by FileDataID.
    ///
    /// One entry per variant the build has, because root lists a file once per locale and
    /// platform it differs on and only the ones this install downloaded can actually be
    /// fetched. Within a file id they stay in the order root listed them.
    entries: Vec<(u32, [u8; 16])>,
}

impl Root {
    fn empty() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    fn weight(&self) -> usize {
        self.entries.capacity() * std::mem::size_of::<(u32, [u8; 16])>()
    }

    /// Every content key the build has for one FileDataID, in root's own order.
    fn variants(&self, fdid: u32) -> &[(u32, [u8; 16])] {
        let from = self.entries.partition_point(|(id, _)| *id < fdid);
        let count = self.entries[from..].partition_point(|(id, _)| *id == fdid);
        &self.entries[from..from + count]
    }

    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut reader = Reader::new(bytes);
        let mut entries: Vec<(u32, [u8; 16])> = Vec::new();
        let old_format = !bytes.starts_with(ROOT_MAGIC);
        let mut version = 0u32;
        // Pre-8.2 files have no header and no counts, and every one of their blocks carries
        // name hashes; the flag that would say otherwise is a later invention.
        let mut allow_unnamed = true;
        if !old_format {
            reader.skip(ROOT_MAGIC.len())?;
            let header_size = reader.u32()?;
            let total = if header_size == VERSIONED_HEADER {
                version = reader.u32()?;
                reader.u32()?
            } else {
                header_size
            };
            let named = reader.u32()?;
            if header_size == VERSIONED_HEADER {
                reader.skip(4)?;
            }
            allow_unnamed = total != named;
            reader.reserve(&mut entries, total as usize);
        }

        while !reader.done() {
            let count = reader.u32()? as usize;
            // 10.1.7 moved the locale in front of the content flags and split the latter
            // across three fields; before that it was one word each, the other way round.
            let (content, locale) = if version == 2 {
                let locale = reader.u32()?;
                let low = reader.u32()?;
                let mid = reader.u32()?;
                let high = reader.u8()?;
                (low | mid | (u32::from(high) << 17), locale)
            } else {
                (reader.u32()?, reader.u32()?)
            };
            if count == 0 {
                continue;
            }

            let named = old_format || !(allow_unnamed && content & NO_NAME_HASH != 0);
            let hash_bytes = if named { 8 } else { 0 };
            // Every locale is wanted — which of a file's variants is readable is settled by
            // what the install actually downloaded, not by a flag — so the only block worth
            // stepping over is one belonging to no locale at all.
            if locale == 0 {
                reader.skip(count * (4 + 16 + hash_bytes))?;
                continue;
            }

            // File ids are stored as deltas, and each delta is one *less* than the step, so
            // a run of consecutive ids is a run of zeroes.
            let mut ids = Vec::with_capacity(count);
            let mut fdid = 0u32;
            for index in 0..count {
                let delta = reader.i32()?;
                fdid = if index == 0 {
                    u32::try_from(delta).map_err(|_| "A root block starts below file id 0.")?
                } else {
                    delta
                        .checked_add(1)
                        .and_then(|step| fdid.checked_add_signed(step))
                        .ok_or("A root block steps past the end of the file ids.")?
                };
                ids.push(fdid);
            }

            entries.reserve(count);
            if old_format {
                // The oldest shape interleaves the key and the hash record by record.
                for fdid in ids {
                    entries.push((fdid, reader.key()?));
                    reader.skip(8)?;
                }
            } else {
                for fdid in ids {
                    entries.push((fdid, reader.key()?));
                }
                reader.skip(count * hash_bytes)?;
            }
        }

        // Stable, so that within one file id the variants stay in the order root wrote them —
        // which is the order `read` tries them in, and so is part of which bytes come back
        // when an install happens to hold more than one of them.
        entries.sort_by_key(|(fdid, _)| *fdid);
        entries.shrink_to_fit();
        Ok(Self { entries })
    }
}

/// A cursor over a byte slice that reports running off the end rather than panicking.
struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }

    fn done(&self) -> bool {
        self.at >= self.data.len()
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(count)
            .ok_or("The root file claims a record longer than itself.")?;
        let slice = self
            .data
            .get(self.at..end)
            .ok_or("The root file ends in the middle of a record.")?;
        self.at = end;
        Ok(slice)
    }

    fn skip(&mut self, count: usize) -> Result<(), String> {
        self.take(count).map(|_| ())
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn key(&mut self) -> Result<[u8; 16], String> {
        Ok(self.take(16)?.try_into().unwrap())
    }

    /// Sizes a collection from a count the file declared, capped by what the bytes left could
    /// possibly hold — a header is not a promise, and a corrupt one should not ask for a
    /// gigabyte.
    fn reserve<T>(&self, into: &mut Vec<T>, claimed: usize) {
        let possible = (self.data.len() - self.at) / 20;
        into.reserve(claimed.min(possible));
    }
}

/* ---------- holding one open ---------- */

/// Something expensive to open, kept between the callers that want it.
///
/// Generic over what is held so that the rule — when is what we have still the thing that
/// was asked for — can be tested without a 123GB game install standing behind it. The app
/// holds a [`CascFiles`]; see [`OpenStorage`].
pub struct Cached<T> {
    held: Mutex<Option<(PathBuf, Arc<T>)>>,
}

impl<T> Default for Cached<T> {
    fn default() -> Self {
        Self {
            held: Mutex::new(None),
        }
    }
}

impl<T> Cached<T> {
    /// What is held for `key`, opening it if nothing is or if what is no longer describes
    /// what is on disk.
    ///
    /// The lock is held across `open`, so two callers arriving together do not each pay for
    /// one — which for the game's storage would be half a second and half a gigabyte spent
    /// twice to end up with the same answer. The second waits exactly as long as it would
    /// have waited doing the work itself.
    pub fn get(
        &self,
        key: &Path,
        current: impl Fn(&T, &Path) -> bool,
        open: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<Arc<T>, String> {
        // A poisoned lock means a panic while something was being opened. What is behind it
        // is either nothing or a value that was fully built before the panic, so taking it
        // back is safe — and wedging every later read of the game's files because one of them
        // panicked once would not be.
        let mut held = self.held.lock().unwrap_or_else(|held| held.into_inner());
        if let Some((at, value)) = held.as_ref() {
            if at == key && current(value, key) {
                return Ok(Arc::clone(value));
            }
        }
        // Dropped before the new one is built, so the two are never resident at once.
        *held = None;
        let value = Arc::new(open(key)?);
        *held = Some((key.to_path_buf(), Arc::clone(&value)));
        Ok(value)
    }

    /// Lets go of whatever is held, if anything.
    pub fn release(&self) {
        *self.held.lock().unwrap_or_else(|held| held.into_inner()) = None;
    }
}

/// The game's storage, opened once and kept for as long as the game stays on that build.
///
/// Opening one is 260–330ms and a few hundred megabytes on a real install, and a single
/// click asks for the game's files twice — so opening per command, which is what this
/// replaces, was most of what a reader waited for.
///
/// What it costs to keep is [`CascFiles::weight`]: 215MB on build 12.0.5.67823, which the
/// `weigh_casc` example prints. That is the whole reason the index, the encoding file and the
/// root are stored the way they are; held in the shapes they were first written in, this was
/// 1.4GB and holding one would not have been an option.
pub type OpenStorage = Cached<CascFiles>;

impl Cached<CascFiles> {
    /// The storage under `install`, which is the folder holding `Data/`.
    ///
    /// Reopened when the launcher has moved the install onto another build, because a handle
    /// is a snapshot of one: root and encoding name the files that build had, and a game
    /// patched while the app sat in the tray would otherwise keep answering about the old one.
    pub fn files(&self, install: &Path) -> Result<Arc<CascFiles>, String> {
        self.get(install, CascFiles::is_current, CascFiles::open)
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
    // Read every bucket before inserting any of it, so the table is allocated once at the
    // size it ends up. Growing into a million and a half entries means holding the old table
    // and the new one at each doubling, and the allocator keeps what that leaves behind: on
    // this install it was the difference between 52MB and 143MB resident.
    let mut buckets = Vec::with_capacity(newest.len());
    for path in newest.values() {
        let data = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
        buckets.push((path.clone(), data));
    }
    let mut total = 0usize;
    for (path, data) in &buckets {
        total += index_entry_count(path, data)?;
    }
    locations.reserve(total);
    for (path, data) in &buckets {
        read_index(path, data, &mut locations)?;
    }
    drop(buckets);

    if locations.is_empty() {
        return Err(format!("No index entries under {}.", dir.display()));
    }
    Ok(locations)
}

/// How many entries a bucket holds, read from its header alone.
fn index_entry_count(path: &Path, data: &[u8]) -> Result<usize, String> {
    let (at, entry_size) = index_layout(path, data)?;
    let entries_size = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    Ok(entries_size / entry_size)
}

/// Where a bucket's entry run starts and how wide one entry is.
fn index_layout(path: &Path, data: &[u8]) -> Result<(usize, usize), String> {
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
    Ok((at, key_bytes + offset_bytes + size_bytes))
}

fn read_index(
    path: &Path,
    data: &[u8],
    into: &mut HashMap<[u8; 9], Location>,
) -> Result<(), String> {
    let (mut at, entry_size) = index_layout(path, data)?;
    let entries_size = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    at += 8;

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
                offset: (packed & 0x3FFF_FFFF) as u32,
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
        let mut out = Vec::new();
        decode_chunk(&data[8..], None, &mut out)?;
        return Ok(out);
    }
    if data.len() < 12 {
        return Err("Truncated BLTE header.".into());
    }
    let chunk_count = (u32::from_be_bytes(data[8..12].try_into().unwrap()) & 0x00FF_FFFF) as usize;

    // The chunk table says up front how large the payload decodes to, so the buffer is
    // allocated at that size once instead of being doubled its way there. On the small
    // tables that costs nothing either way; on the encoding file, which is 186MB in one
    // payload, the difference is holding it once rather than holding it and the half-grown
    // copy it was being moved out of at the same time.
    let mut total = 0usize;
    for index in 0..chunk_count {
        let entry = data
            .get(12 + index * 24..12 + index * 24 + 24)
            .ok_or("Truncated BLTE chunk table.")?;
        total = total
            .checked_add(u32::from_be_bytes(entry[4..8].try_into().unwrap()) as usize)
            .ok_or("A BLTE chunk table claims more bytes than can be addressed.")?;
    }

    let mut out = Vec::with_capacity(total);
    let mut table = 12;
    let mut at = header_size;
    for _ in 0..chunk_count {
        let entry = &data[table..table + 24];
        let compressed = u32::from_be_bytes(entry[0..4].try_into().unwrap()) as usize;
        let decompressed = u32::from_be_bytes(entry[4..8].try_into().unwrap()) as usize;
        table += 24;
        let chunk = data
            .get(at..at + compressed)
            .ok_or("Truncated BLTE chunk data.")?;
        at += compressed;
        decode_chunk(chunk, Some(decompressed), &mut out)?;
    }
    Ok(out)
}

/// Decodes one chunk onto the end of `out`.
///
/// Onto the end rather than into a `Vec` of its own: a payload is a run of chunks that are
/// concatenated anyway, and the intermediate copy is the whole file again for the one file
/// where that is worth caring about.
fn decode_chunk(chunk: &[u8], decompressed: Option<usize>, out: &mut Vec<u8>) -> Result<(), String> {
    let (mode, body) = chunk.split_first().ok_or("Empty BLTE chunk.")?;
    match mode {
        b'N' => out.extend_from_slice(body),
        b'Z' => {
            ZlibDecoder::new(body)
                .read_to_end(out)
                .map_err(|error| format!("A BLTE chunk would not inflate: {error}"))?;
        }
        b'F' => out.extend_from_slice(&blte_decode(body)?),
        // Encrypted, and only Blizzard has the key. Zeroes keep every following chunk at
        // the offset the file says it is at, which is what lets the rest still be read.
        b'E' => out.resize(out.len() + decompressed.unwrap_or(0), 0),
        other => {
            return Err(format!(
                "A BLTE chunk uses storage mode `{}`, which is not known.",
                *other as char
            ))
        }
    }
    Ok(())
}

/* ---------- encoding ---------- */

/// The encoding file, cut down to its content-key half and searched a page at a time.
///
/// It is the biggest thing in the install — 186MB on build 12.0.5.67823 — and all we ever
/// want from it is one lookup per file read. Its layout is a header, an ESpec block, the
/// content-key page table, the content-key pages, and then a second page table and pages
/// keyed the other way round, by encoding key. Nothing here asks the question those answer,
/// and on that build they and the ESpec block in front are 86MB of the 186 — so what is kept
/// is the span from the content-key page table to the end of the content-key pages, and the
/// decoded file is dropped.
///
/// Each page-table entry leads with the first content key on its page and the table is
/// sorted, so one binary search and one 4KB page beats walking every one of its millions of
/// entries.
struct Encoding {
    /// The content-key page table followed by the content-key pages, and nothing else.
    data: Vec<u8>,
    pages: usize,
    page_size: usize,
    page_count: usize,
}

impl Encoding {
    fn empty() -> Self {
        Self {
            data: Vec::new(),
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
        let end = pages + page_count * page_size;
        if page_size == 0 || data.len() < end {
            return Err("The encoding file is shorter than its own header claims.".into());
        }
        // Cut down in place rather than copied out: at this moment the decoded file and the
        // 175MB it was inflated from are both still alive, and a third buffer to copy the
        // kept span into would be the high-water mark of the whole open.
        let mut data = data;
        data.truncate(end);
        data.drain(..table);
        data.shrink_to_fit();
        Ok(Self {
            data,
            pages: page_count * 32,
            page_size,
            page_count,
        })
    }

    /// How many bytes this is holding, for `weigh_casc` and for the test that guards it.
    fn weight(&self) -> usize {
        self.data.capacity()
    }

    fn first_content_key(&self, page: usize) -> &[u8] {
        let at = page * 32;
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

    /* ---------- root ---------- */

    /// A content key that reads back as the number it was built from, so a test can say which
    /// one it expects without carrying sixteen bytes around.
    fn ckey(tag: u8) -> [u8; 16] {
        [tag; 16]
    }

    /// One root block: the records, the flags they sit under, and whether it carries the
    /// path hashes that a reader has to step over to reach the next block.
    struct Block {
        locale: u32,
        content: u32,
        named: bool,
        /// `(FileDataID, content key)`, which the writer turns back into deltas.
        files: Vec<(u32, [u8; 16])>,
    }

    impl Block {
        fn of(files: &[(u32, u8)]) -> Self {
            Self {
                locale: 0x2, // enUS
                content: 0,
                named: true,
                files: files.iter().map(|(id, tag)| (*id, ckey(*tag))).collect(),
            }
        }

        fn locale(mut self, locale: u32) -> Self {
            self.locale = locale;
            self
        }

        fn unnamed(mut self) -> Self {
            self.named = false;
            self.content |= NO_NAME_HASH;
            self
        }

        fn write(&self, version: u32, out: &mut Vec<u8>) {
            out.extend_from_slice(&(self.files.len() as u32).to_le_bytes());
            if version == 2 {
                out.extend_from_slice(&self.locale.to_le_bytes());
                out.extend_from_slice(&self.content.to_le_bytes());
                out.extend_from_slice(&0u32.to_le_bytes());
                out.push(0);
            } else {
                out.extend_from_slice(&self.content.to_le_bytes());
                out.extend_from_slice(&self.locale.to_le_bytes());
            }
            let mut previous: Option<u32> = None;
            for (fdid, _) in &self.files {
                let delta = match previous {
                    None => *fdid as i32,
                    Some(last) => (*fdid - last) as i32 - 1,
                };
                out.extend_from_slice(&delta.to_le_bytes());
                previous = Some(*fdid);
            }
            for (_, key) in &self.files {
                out.extend_from_slice(key);
            }
            if self.named {
                for (fdid, _) in &self.files {
                    out.extend_from_slice(&u64::from(*fdid).to_le_bytes());
                }
            }
        }
    }

    /// A root file in the shape every build since 10.1.7 writes.
    fn root_of(blocks: &[Block]) -> Vec<u8> {
        let total: usize = blocks.iter().map(|block| block.files.len()).sum();
        let named: usize = blocks
            .iter()
            .filter(|block| block.named)
            .map(|block| block.files.len())
            .sum();
        let mut out = ROOT_MAGIC.to_vec();
        out.extend_from_slice(&VERSIONED_HEADER.to_le_bytes());
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(named as u32).to_le_bytes());
        out.extend_from_slice(&[0u8; 4]);
        for block in blocks {
            block.write(2, &mut out);
        }
        out
    }

    fn only_key(root: &Root, fdid: u32) -> [u8; 16] {
        let variants = root.variants(fdid);
        assert_eq!(variants.len(), 1, "file {fdid} has {} variants", variants.len());
        variants[0].1
    }

    #[test]
    fn finds_a_content_key_by_the_file_id_root_lists_it_under() {
        let root = Root::parse(&root_of(&[Block::of(&[(70, 1), (71, 2), (900, 3)])])).unwrap();
        assert_eq!(only_key(&root, 70), ckey(1));
        assert_eq!(only_key(&root, 71), ckey(2));
        assert_eq!(only_key(&root, 900), ckey(3));
    }

    // File ids are deltas above the last one, and the delta is one *less* than the step, so a
    // run of consecutive ids is a run of zeroes and an off-by-one here shifts every key.
    #[test]
    fn says_nothing_about_a_file_the_build_does_not_have() {
        let root = Root::parse(&root_of(&[Block::of(&[(70, 1), (900, 2)])])).unwrap();
        assert!(root.variants(71).is_empty());
        assert!(root.variants(0).is_empty());
        assert!(root.variants(u32::MAX).is_empty());
    }

    // One file id can appear in several blocks — the same texture under two locales, a model
    // in a low-violence variant — and only the ones the install actually downloaded can be
    // fetched, so `read` needs all of them to try in turn.
    #[test]
    fn keeps_every_variant_a_file_id_has() {
        let root = Root::parse(&root_of(&[
            Block::of(&[(70, 1), (71, 2)]),
            Block::of(&[(70, 3)]).locale(0x20),
        ]))
        .unwrap();
        let variants: Vec<[u8; 16]> = root.variants(70).iter().map(|(_, key)| *key).collect();
        assert_eq!(variants, vec![ckey(1), ckey(3)]);
        assert_eq!(only_key(&root, 71), ckey(2));
    }

    // A block belonging to no locale at all is stepped over, and the step has to land exactly
    // on the next block or every key after it is read out of the wrong bytes.
    #[test]
    fn steps_over_a_block_that_belongs_to_no_locale() {
        let root = Root::parse(&root_of(&[
            Block::of(&[(70, 1)]),
            Block::of(&[(500, 9), (501, 9)]).locale(0),
            Block::of(&[(900, 2)]),
        ]))
        .unwrap();
        assert_eq!(only_key(&root, 70), ckey(1));
        assert_eq!(only_key(&root, 900), ckey(2));
        assert!(root.variants(500).is_empty(), "a block for no locale was read anyway");
    }

    // Whether a block carries path hashes is a flag, and what it changes is how many bytes
    // the next block starts after. A block without them following one with them is the case
    // that catches getting either length wrong.
    #[test]
    fn reads_blocks_whether_or_not_they_carry_path_hashes() {
        let root = Root::parse(&root_of(&[
            Block::of(&[(70, 1), (71, 2)]),
            Block::of(&[(900, 3)]).unnamed(),
            Block::of(&[(1000, 4)]),
        ]))
        .unwrap();
        assert_eq!(only_key(&root, 70), ckey(1));
        assert_eq!(only_key(&root, 71), ckey(2));
        assert_eq!(only_key(&root, 900), ckey(3));
        assert_eq!(only_key(&root, 1000), ckey(4));
    }

    // An empty block still carries its flags, and skipping it is not the same as skipping its
    // (absent) records.
    #[test]
    fn reads_past_a_block_holding_no_records() {
        let root = Root::parse(&root_of(&[
            Block::of(&[]),
            Block::of(&[(70, 1)]),
        ]))
        .unwrap();
        assert_eq!(only_key(&root, 70), ckey(1));
    }

    // Before 10.1.7 the header carried no version and no total, and a block wrote its content
    // flags in front of its locale rather than behind — which is the same eight bytes read the
    // other way round, so a build that gets this wrong reads plausible nonsense.
    #[test]
    fn reads_the_header_and_block_order_from_before_10_1_7() {
        let blocks = [Block::of(&[(70, 1), (900, 2)])];
        let mut out = ROOT_MAGIC.to_vec();
        out.extend_from_slice(&2u32.to_le_bytes()); // total, read as the header size
        out.extend_from_slice(&2u32.to_le_bytes()); // named
        for block in &blocks {
            block.write(0, &mut out);
        }
        let root = Root::parse(&out).unwrap();
        assert_eq!(only_key(&root, 70), ckey(1));
        assert_eq!(only_key(&root, 900), ckey(2));
    }

    // Classic Era's root has no magic and no header at all, and interleaves each key with its
    // path hash rather than writing the keys and then the hashes.
    #[test]
    fn reads_the_pre_8_2_layout_that_has_no_header() {
        let files = [(70u32, 1u8), (900, 2)];
        let mut out = Vec::new();
        out.extend_from_slice(&(files.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // content
        out.extend_from_slice(&0x2u32.to_le_bytes()); // locale
        let mut previous: Option<u32> = None;
        for (fdid, _) in files {
            let delta = match previous {
                None => fdid as i32,
                Some(last) => (fdid - last) as i32 - 1,
            };
            out.extend_from_slice(&delta.to_le_bytes());
            previous = Some(fdid);
        }
        for (fdid, tag) in files {
            out.extend_from_slice(&ckey(tag));
            out.extend_from_slice(&u64::from(fdid).to_le_bytes());
        }
        let root = Root::parse(&out).unwrap();
        assert_eq!(only_key(&root, 70), ckey(1));
        assert_eq!(only_key(&root, 900), ckey(2));
    }

    #[test]
    fn refuses_a_root_file_that_ends_mid_record() {
        let whole = root_of(&[Block::of(&[(70, 1), (71, 2)])]);
        for cut in [whole.len() - 1, whole.len() - 20, whole.len() - 40, 14, 4] {
            assert!(
                Root::parse(&whole[..cut]).is_err(),
                "a root file cut to {cut} bytes parsed anyway"
            );
        }
    }

    /* ---------- holding one open ---------- */

    /// An open that counts how many times it was asked to do the work, and answers with that
    /// count — so a test can tell "opened again" from "handed back" by the value alone.
    fn counted(opens: &std::cell::Cell<u32>) -> impl FnOnce(&Path) -> Result<u32, String> + '_ {
        move |_| {
            opens.set(opens.get() + 1);
            Ok(opens.get())
        }
    }

    fn still_current(_: &u32, _: &Path) -> bool {
        true
    }

    fn gone_stale(_: &u32, _: &Path) -> bool {
        false
    }

    #[test]
    fn opens_once_and_hands_that_back_to_everyone_after() {
        let opens = std::cell::Cell::new(0);
        let cached: Cached<u32> = Cached::default();
        let here = Path::new("/games/wow");
        assert_eq!(*cached.get(here, still_current, counted(&opens)).unwrap(), 1);
        assert_eq!(*cached.get(here, still_current, counted(&opens)).unwrap(), 1);
        assert_eq!(*cached.get(here, still_current, counted(&opens)).unwrap(), 1);
        assert_eq!(opens.get(), 1);
    }

    // The game gets patched while the app sits in the tray, and what is held then describes a
    // build the launcher has moved off.
    #[test]
    fn opens_again_once_what_is_held_no_longer_describes_the_install() {
        let opens = std::cell::Cell::new(0);
        let cached: Cached<u32> = Cached::default();
        let here = Path::new("/games/wow");
        assert_eq!(*cached.get(here, still_current, counted(&opens)).unwrap(), 1);
        assert_eq!(*cached.get(here, gone_stale, counted(&opens)).unwrap(), 2);
        assert_eq!(opens.get(), 2);
    }

    #[test]
    fn opens_again_when_asked_about_a_different_install() {
        let opens = std::cell::Cell::new(0);
        let cached: Cached<u32> = Cached::default();
        assert_eq!(
            *cached
                .get(Path::new("/games/wow"), still_current, counted(&opens))
                .unwrap(),
            1
        );
        assert_eq!(
            *cached
                .get(Path::new("/other/wow"), still_current, counted(&opens))
                .unwrap(),
            2
        );
    }

    #[test]
    fn opens_again_after_being_released() {
        let opens = std::cell::Cell::new(0);
        let cached: Cached<u32> = Cached::default();
        let here = Path::new("/games/wow");
        assert_eq!(*cached.get(here, still_current, counted(&opens)).unwrap(), 1);
        cached.release();
        assert_eq!(*cached.get(here, still_current, counted(&opens)).unwrap(), 2);
    }

    // A game folder that is not one yet — the app starts before the setting is right — must
    // not leave anything behind that a later, working read would be handed instead.
    #[test]
    fn holds_nothing_after_an_open_that_failed() {
        let cached: Cached<u32> = Cached::default();
        let here = Path::new("/games/wow");
        assert!(cached.get(here, still_current, |_| Err("no Data folder".into())).is_err());
        let opens = std::cell::Cell::new(0);
        assert_eq!(*cached.get(here, still_current, counted(&opens)).unwrap(), 1);
    }

    /* ---------- encoding ---------- */

    /// An encoding file: a header, an ESpec block, the content-key page table and its pages,
    /// and then the encoding-key half that nothing reads — which is the part being dropped,
    /// so a test that leaves it out would not be testing anything.
    fn encoding_of(entries: &[([u8; 16], [u8; 16])], espec: usize, trailing: usize) -> Vec<u8> {
        const PAGE_SIZE: usize = 1024;
        // One page per entry, which keeps the arithmetic in the test obvious and still makes
        // the reader binary-search a table of more than one.
        let mut pages = Vec::new();
        let mut table = Vec::new();
        for (ckey, ekey) in entries {
            table.extend_from_slice(ckey);
            table.extend_from_slice(&[0u8; 16]); // the page's own checksum, unread
            let mut page = Vec::with_capacity(PAGE_SIZE);
            page.push(1); // one encoding key for this content key
            page.extend_from_slice(&[0u8; 5]); // the file's size, unread
            page.extend_from_slice(ckey);
            page.extend_from_slice(ekey);
            page.resize(PAGE_SIZE, 0);
            pages.extend_from_slice(&page);
        }

        let mut out = b"EN".to_vec();
        out.extend_from_slice(&[1, 16, 16]);
        out.extend_from_slice(&((PAGE_SIZE / 1024) as u16).to_be_bytes());
        out.extend_from_slice(&((PAGE_SIZE / 1024) as u16).to_be_bytes());
        out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out.push(0);
        out.extend_from_slice(&(espec as u32).to_be_bytes());
        out.resize(22 + espec, b'z');
        out.extend_from_slice(&table);
        out.extend_from_slice(&pages);
        out.resize(out.len() + trailing, 0xEE);
        out
    }

    #[test]
    fn finds_the_encoding_key_a_content_key_was_stored_under() {
        let entries: Vec<([u8; 16], [u8; 16])> =
            (1u8..=8).map(|tag| ([tag; 16], [tag + 100; 16])).collect();
        let encoding = Encoding::parse(encoding_of(&entries, 64, 4096)).unwrap();
        for (ckey, ekey) in &entries {
            assert_eq!(encoding.encoding_key(ckey), Some(*ekey));
        }
        assert_eq!(encoding.encoding_key(&[9u8; 16]), None);
        assert_eq!(encoding.encoding_key(&[0u8; 16]), None);
    }

    // The ESpec block in front and the encoding-key tables behind are 45% of the real file and
    // nothing ever reads either, so what is held is the span between them and nothing else.
    #[test]
    fn holds_only_the_content_key_half_of_the_encoding_file() {
        let entries: Vec<([u8; 16], [u8; 16])> =
            (1u8..=8).map(|tag| ([tag; 16], [tag + 100; 16])).collect();
        let whole = encoding_of(&entries, 4096, 40_960);
        let encoding = Encoding::parse(whole.clone()).unwrap();
        // The table is 32 bytes a page and the pages are 1KB each; everything else goes.
        assert_eq!(encoding.weight(), entries.len() * (32 + 1024));
        assert!(
            encoding.weight() < whole.len() / 2,
            "kept {} of {} bytes",
            encoding.weight(),
            whole.len()
        );
    }

    #[test]
    fn refuses_an_encoding_file_shorter_than_its_header_claims() {
        let entries = [([1u8; 16], [101u8; 16])];
        let whole = encoding_of(&entries, 64, 0);
        assert!(Encoding::parse(whole[..whole.len() - 1].to_vec()).is_err());
        assert!(Encoding::parse(b"not an encoding file".to_vec()).is_err());
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
