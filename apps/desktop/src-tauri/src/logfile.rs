//! Reading the combat log the client writes, and keeping only the handful of facts in it that
//! Chronie cannot learn any other way.
//!
//! A raid night runs to hundreds of megabytes and almost all of it is damage. What is worth
//! carrying out of that is small: where the player was, which is the only position feed that
//! works inside an instance; the bounds that turn those world yards into the normalised
//! coordinates everything else already uses; the exact moment each boss fight and keystone run
//! began and ended; and what everyone was wearing when it started. Everything else is read,
//! recognised, and dropped.
//!
//! **The file is being written while this reads it.** So nothing here reads a whole file into
//! memory, nothing assumes the tail is a complete record, and every read hands back a cursor
//! saying where it stopped. The next read starts there — unless the file it is resuming into
//! is not the file it left, which is checked rather than assumed: logs rotate, and a cursor
//! pointed into a different file parses garbage very convincingly.
//!
//! **Advanced parameters are not always there.** They are what carry the positions, they are
//! only on some line types, and only when advanced logging was on when the line was written —
//! which can change halfway through a file, because a file can span two sessions. A log
//! without them is not an error; it is a log that answers fewer questions.
//!
//! Everything in here is pure over `&str` and `&Path`, so the fixtures in
//! `fixtures/combatlog/` are enough to drive all of it. No game install, no real log.

use chrono::{FixedOffset, Local, LocalResult, NaiveDate, Offset, TimeZone};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

/// How close together two kept positions are allowed to be.
///
/// A position every few seconds is a track; every event is a firehose. Five seconds is roughly
/// a global cooldown and a half — fine enough to say which side of a room somebody was on,
/// coarse enough that a twenty-minute fight contributes a couple of hundred rows rather than a
/// couple of hundred thousand.
pub const SAMPLE_SECONDS: i64 = 5;

/// How much of a file's start is hashed to recognise it again.
///
/// Enough to cover the `COMBAT_LOG_VERSION` line and the first minutes of a session, which is
/// what makes two logs of the same night distinguishable; small enough that checking costs one
/// read of one page.
pub const HEAD_BYTES: u64 = 4096;

/// The flag bits that say whose side of the log a unit is on, and the value meaning "the
/// player running this client". Every other affiliation — party, raid, outsider — is somebody
/// else, whose track is not ours to keep.
const AFFILIATION_MASK: u64 = 0xF;
const AFFILIATION_MINE: u64 = 0x1;

/* ---------- timestamps ---------- */

/// A timestamp exactly as a line stated it, with nothing filled in.
///
/// The year and the zone are separate `Option`s because the client has historically supplied
/// neither: month and day, local time, no offset. Recent clients state both. Which of the two
/// shapes a file is in is not something to remember and assume — it is read off the line, and
/// what the line did not say is left absent here for [`Clock`] to answer for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub month: u32,
    pub day: u32,
    pub year: Option<i32>,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millis: u32,
    /// Seconds east of UTC, when the line carried an offset.
    pub offset: Option<i32>,
}

/// Splits a log line into the timestamp it starts with and the payload after it.
///
/// The separator is historically two spaces, but a line is not worth losing over whitespace,
/// so this asks what the first two tokens look like instead: something with a `/` in it, then
/// something with a `:` in it. A line that does not start that way is not a record.
pub fn split_line(line: &str) -> Option<(Stamp, &str)> {
    let line = line.trim_end_matches(['\r', '\n']);
    let mut rest = line.trim_start();
    let date = take_token(&mut rest)?;
    let time = take_token(&mut rest)?;
    let payload = rest.trim_start();
    if payload.is_empty() {
        return None;
    }
    Some((parse_stamp(date, time)?, payload))
}

fn take_token<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let end = rest.find(char::is_whitespace)?;
    let (token, tail) = rest.split_at(end);
    *rest = tail.trim_start();
    Some(token)
}

/// `M/D/YYYY` and `H:M:S.mmm[±offset]`, and the same pair without the year and the offset.
fn parse_stamp(date: &str, time: &str) -> Option<Stamp> {
    let mut parts = date.split('/');
    let month = parts.next()?.parse().ok()?;
    let day = parts.next()?.parse().ok()?;
    let year = match parts.next() {
        Some(text) => Some(parse_year(text)?),
        None => None,
    };
    if parts.next().is_some() {
        return None;
    }

    // The offset is glued to the end of the seconds — `20:15:30.123-5` — so it is cut off
    // before the time is read rather than after.
    let (clock, offset) = split_offset(time);
    let mut parts = clock.split(':');
    let hour = parts.next()?.parse().ok()?;
    let minute = parts.next()?.parse().ok()?;
    let tail = parts.next()?;
    let (seconds, fraction) = tail.split_once('.').unwrap_or((tail, "0"));
    if parts.next().is_some() {
        return None;
    }
    let stamp = Stamp {
        month,
        day,
        year,
        hour,
        minute,
        second: seconds.parse().ok()?,
        millis: parse_fraction(fraction)?,
        offset,
    };
    (stamp.month <= 12
        && stamp.day <= 31
        && stamp.hour < 24
        && stamp.minute < 60
        && stamp.second < 60)
        .then_some(stamp)
}

/// Two digits are a year this century, four are a year. Anything else is not a year at all.
fn parse_year(text: &str) -> Option<i32> {
    let value: i32 = text.parse().ok()?;
    match text.len() {
        2 => Some(2000 + value),
        4 => Some(value),
        _ => None,
    }
}

/// A fraction of a second as written, however many digits it was written with, in
/// milliseconds. `.1` is a tenth rather than a millisecond, which is the difference between
/// reading the number and reading the string.
fn parse_fraction(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let digits: String = text.chars().chain("000".chars()).take(3).collect();
    digits.parse().ok()
}

/// How many digits of fraction the client writes. It writes milliseconds, and it writes all
/// three of them, which is the only thing that tells a fraction from the offset stuck to it.
const FRACTION_DIGITS: usize = 3;

/// Cuts a trailing UTC offset off a time, if it has one.
///
/// There is nothing between the fraction and the offset, and a real 12.0.7 client writes a
/// positive offset with **no sign at all** — `16:24:38.4081` is 38.408 seconds an hour east of
/// UTC, not a fraction with a fourth digit. So the two are told apart by width rather than by
/// looking for a `+` or a `-`: three digits are the milliseconds and everything after them is
/// the offset, whether or not it announces itself.
///
/// A time that stops after its three digits stated no offset, which is the old shape and is
/// what [`Clock`] answers for.
fn split_offset(time: &str) -> (&str, Option<i32>) {
    let Some(point) = time.find('.') else {
        return (time, None);
    };
    let width = time[point + 1..]
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count()
        .min(FRACTION_DIGITS);
    let (clock, tail) = time.split_at(point + 1 + width);
    (clock, parse_offset(tail))
}

/// Seconds east of UTC, from an offset written any of the ways a client writes one.
///
/// `-5`, `-05` and `-0500` are the same offset three ways, and `1` is the fourth: two digits
/// or fewer are hours, more are hours and minutes, and a missing sign means east.
fn parse_offset(text: &str) -> Option<i32> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let (hours, minutes) = if digits.len() <= 2 {
        (digits.parse::<i32>().ok()?, 0)
    } else {
        let split = digits.len() - 2;
        (
            digits[..split].parse::<i32>().ok()?,
            digits[split..].parse::<i32>().ok()?,
        )
    };
    let magnitude = hours * 3600 + minutes * 60;
    Some(if negative { -magnitude } else { magnitude })
}

/// Which zone a stamp that states none was written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    /// This machine's own, which is what a client writing no offset meant — it wrote the wall
    /// clock of the computer the game was running on, and for a log being read on that same
    /// computer that is this.
    Local,
    /// A fixed number of seconds east of UTC. What the tests use, so that a fixture means the
    /// same instant on every machine that runs them.
    East(i32),
}

/// Turns the stamps of one file into instants.
///
/// Stateful on purpose, and this is the whole reason the old format is painful: a stamp
/// reading `01/01` says nothing about which year it is, and the only thing that does is the
/// stamp before it having read `12/31`. So the year is carried, and rolled forward exactly
/// once, when December is followed by January.
pub struct Clock {
    year: i32,
    zone: Zone,
    previous_month: Option<u32>,
}

impl Clock {
    /// `year` is what a stamp carrying none is read with — the year the file's name or its
    /// modification time says, which is the best available and is only ever wrong for a log
    /// nobody has touched in over a year.
    pub fn new(year: i32, zone: Zone) -> Self {
        Self {
            year,
            zone,
            previous_month: None,
        }
    }

    /// The instant a stamp names, in epoch milliseconds.
    pub fn resolve(&mut self, stamp: &Stamp) -> Option<i64> {
        let year = match stamp.year {
            Some(stated) => {
                self.year = stated;
                stated
            }
            None => {
                if self.previous_month == Some(12) && stamp.month == 1 {
                    self.year += 1;
                }
                self.year
            }
        };
        self.previous_month = Some(stamp.month);
        let naive = NaiveDate::from_ymd_opt(year, stamp.month, stamp.day)?.and_hms_milli_opt(
            stamp.hour,
            stamp.minute,
            stamp.second,
            stamp.millis,
        )?;
        let zone = stamp.offset.map(Zone::East).unwrap_or(self.zone);
        match zone {
            Zone::East(seconds) => FixedOffset::east_opt(seconds)?
                .from_local_datetime(&naive)
                .earliest()
                .map(|moment| moment.timestamp_millis()),
            Zone::Local => match Local.from_local_datetime(&naive) {
                LocalResult::Single(moment) => Some(moment.timestamp_millis()),
                // The hour that happens twice when the clocks go back. Both readings are
                // defensible and neither is knowable from the line; taking the earlier one
                // makes the answer at least the same every time the file is read.
                LocalResult::Ambiguous(earlier, _) => Some(earlier.timestamp_millis()),
                // The hour that never happened when the clocks went forward. No local time in
                // it exists, but the log wrote one anyway, so it is read with the offset in
                // force around it rather than thrown away.
                LocalResult::None => {
                    let offset = Local.offset_from_utc_datetime(&naive).fix();
                    Some((naive - offset).and_utc().timestamp_millis())
                }
            },
        }
    }
}

/* ---------- fields ---------- */

/// Splits a payload on its top-level commas.
///
/// Commas are also inside quoted names — `"Wrathion, the Black Emperor"` — and inside the
/// parenthesised and bracketed groups that `COMBATANT_INFO` is mostly made of, and neither is
/// a field boundary. Depth and quoting are tracked so that both survive intact and can be
/// taken apart by whoever actually wants them.
pub fn fields(payload: &str) -> Vec<&str> {
    let bytes = payload.as_bytes();
    let mut found = Vec::new();
    let mut start = 0;
    let mut depth = 0_i32;
    let mut quoted = false;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'"' => quoted = !quoted,
            b'(' | b'[' if !quoted => depth += 1,
            b')' | b']' if !quoted => depth -= 1,
            b',' if !quoted && depth == 0 => {
                found.push(&payload[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    found.push(&payload[start..]);
    found
}

/// A field with its quotes taken off, if it had any.
pub fn unquoted(field: &str) -> &str {
    field
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(field)
}

/// A field as a number, or `None` for the `nil` the client writes wherever a value did not
/// apply. Deliberately not zero: "the client did not say" and "zero" are different facts, and
/// a fabricated zero coordinate is the top-left corner of the map.
pub fn number(field: &str) -> Option<f64> {
    let field = field.trim();
    if field.is_empty() || field == "nil" {
        return None;
    }
    field.parse().ok()
}

pub fn integer(field: &str) -> Option<i64> {
    let field = field.trim();
    if field.is_empty() || field == "nil" {
        return None;
    }
    field.parse().ok()
}

/// Unit flags, which the client writes as hex.
fn flags(field: &str) -> Option<u64> {
    let field = field.trim();
    match field
        .strip_prefix("0x")
        .or_else(|| field.strip_prefix("0X"))
    {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => field.parse().ok(),
    }
}

/// The inside of a `(...)` or `[...]` group, or `None` if the field is not one.
fn group(field: &str) -> Option<&str> {
    let field = field.trim();
    let inner = field
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
        .or_else(|| {
            field
                .strip_prefix('[')
                .and_then(|rest| rest.strip_suffix(']'))
        })?;
    Some(inner)
}

/// A group's own top-level entries, or nothing at all for the empty group the client writes as
/// `()` or `[]`.
fn entries(inner: &str) -> Vec<&str> {
    if inner.trim().is_empty() {
        return Vec::new();
    }
    fields(inner)
}

/// Whether a field is a unit GUID rather than a number.
///
/// This is what tells an advanced parameter block from the ordinary suffix that sits in the
/// same place when advanced logging was off. Every GUID the client writes has dashes in it,
/// except the all-zero one it uses for "nobody", and no number does.
fn is_guid(field: &str) -> bool {
    field == "0000000000000000" || (field.contains('-') && !field.starts_with('-'))
}

/* ---------- the facts worth keeping ---------- */

/// A `MAP_CHANGE`: which map the player is on, and the world coordinates of its corners.
///
/// Without this the positions below are in yards on an unnamed grid. With it they are the
/// same normalised 0..1 point the rest of the pipeline already speaks in, and no hand-kept
/// table of map bounds has to exist.
#[derive(Debug, Clone, PartialEq)]
pub struct MapBounds {
    pub ui_map_id: i64,
    pub name: String,
    /// North and south edges, in world yards. `x0` is the larger.
    pub x0: f64,
    pub x1: f64,
    /// West and east edges. `y0` is the larger.
    pub y0: f64,
    pub y1: f64,
    pub at: i64,
}

impl MapBounds {
    /// A world point as a fraction across this map, or `None` when the bounds cannot say.
    ///
    /// The game's world axes are not the map's: world X runs north, world Y runs west, and a
    /// map's own origin is its north-west corner. So the horizontal fraction comes out of the
    /// world's Y and the vertical out of its X, both counting down from the larger edge.
    ///
    /// Checked against a real log rather than believed. Terokkar Forest states
    /// `-1000, -4600, 7083.33, 1683.33`, which is 3600 yards on the X axis and 5400 on the Y —
    /// and Terokkar's map is the wider-than-tall one, so the width has to be the Y span. The
    /// points recorded in the Bone Wastes come out at roughly `0.47, 0.67`, which is where
    /// Auchindoun is; swapping the two axes would put them out in the east of the zone
    /// instead, and that is the failure this arrangement was most at risk of.
    ///
    /// Deliberately not clamped. A point outside 0..1 means these bounds are not the bounds
    /// this position was recorded under, and rounding that into a corner of the map would
    /// hide the one thing worth noticing about it.
    pub fn normalize(&self, world_x: f64, world_y: f64) -> Option<(f64, f64)> {
        let across = self.y0 - self.y1;
        let down = self.x0 - self.x1;
        if across == 0.0 || down == 0.0 {
            return None;
        }
        Some(((self.y0 - world_y) / across, (self.x0 - world_x) / down))
    }
}

/// Where the player was, once every few seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Position {
    /// Epoch milliseconds. The log states milliseconds and the fights either side of a
    /// position are decided to the second, so the precision is kept rather than rounded away.
    pub at: i64,
    pub actor_guid: String,
    pub actor_name: String,
    pub ui_map_id: Option<i64>,
    pub world_x: f64,
    pub world_y: f64,
    /// The same point as a fraction across the map, when a `MAP_CHANGE` for that map has been
    /// seen. Kept beside the world coordinates rather than instead of them, so that a wrong
    /// conversion is a thing that can be redone rather than a thing that has lost its input.
    pub map_x: Option<f64>,
    pub map_y: Option<f64>,
    pub facing: Option<f64>,
}

/// What a fight was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fought {
    /// A boss, between `ENCOUNTER_START` and `ENCOUNTER_END`.
    Encounter,
    /// A keystone run, between `CHALLENGE_MODE_START` and `CHALLENGE_MODE_END`.
    Keystone,
}

/// One fight, from whichever end of it this read happened to see.
///
/// Both boundaries are optional, because a read can begin or end in the middle of one. A
/// record with only an end is not a broken record; it is the second half of one whose first
/// half was written down thirty seconds ago.
#[derive(Debug, Clone, PartialEq)]
pub struct Fight {
    pub kind: Fought,
    pub encounter_id: Option<i64>,
    pub name: String,
    pub difficulty_id: Option<i64>,
    pub group_size: Option<i64>,
    pub instance_id: Option<i64>,
    pub keystone_level: Option<i64>,
    pub affixes: Vec<i64>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub success: Option<bool>,
    pub duration_ms: Option<i64>,
    /// Who was there and what they had on, as of the start.
    pub combatants: Vec<Combatant>,
}

impl Fight {
    fn opened(kind: Fought, at: i64) -> Self {
        Self {
            kind,
            encounter_id: None,
            name: String::new(),
            difficulty_id: None,
            group_size: None,
            instance_id: None,
            keystone_level: None,
            affixes: Vec::new(),
            started_at: Some(at),
            ended_at: None,
            success: None,
            duration_ms: None,
            combatants: Vec::new(),
        }
    }
}

/// One combatant's gear and talents at the moment a fight started.
#[derive(Debug, Clone, PartialEq)]
pub struct Combatant {
    pub guid: String,
    pub faction: Option<i64>,
    pub spec_id: Option<i64>,
    /// The talent group verbatim, as numbers or as groups of numbers depending on what the
    /// client of the day wrote. Not interpreted: what a talent id means is the game's
    /// business and changes every expansion, while the numbers themselves do not.
    pub talents: Value,
    /// One entry per equipped item: its id, the item level it was at, and its bonus ids.
    pub equipment: Value,
}

/// Everything one read of one file found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub maps: Vec<MapBounds>,
    pub positions: Vec<Position>,
    pub fights: Vec<Fight>,
    /// How many lines were read, whether or not anything was kept from them.
    pub lines: u64,
    /// What the newest `COMBAT_LOG_VERSION` in this read claimed about advanced logging.
    /// `None` when the read saw no such line, which is the ordinary case for every read after
    /// the first.
    pub advanced_declared: Option<bool>,
    /// Whether a line in this read actually carried advanced parameters. The claim above is
    /// what the client said; this is what it did.
    pub advanced_seen: bool,
    pub first_at: Option<i64>,
    pub last_at: Option<i64>,
}

/* ---------- reading a file that is still being written ---------- */

/// Where a read stopped, and enough about the file to notice if it is later replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    /// Bytes consumed, always ending on a line boundary.
    pub offset: u64,
    /// The file's size when the read finished.
    pub size: u64,
    /// A digest of the file's first bytes, and how many of them went into it.
    pub head: String,
    pub head_bytes: u64,
}

/// Why a read went back to the beginning of a file it had already read part of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restarted {
    /// The file is smaller than the offset held for it. Somebody truncated it.
    Truncated,
    /// The file is the same size or bigger but does not start the way it did. This is the one
    /// that matters: a rotated log can be longer than the one it replaced, and resuming into
    /// it would parse the middle of a record as if it were the start of one.
    Replaced,
}

/// The last position a read kept, which is what the next read measures its interval from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sampled {
    pub at: i64,
    pub ui_map_id: Option<i64>,
}

/// A read in progress, and the state it needs from the read before it.
#[derive(Debug, Clone, Default)]
pub struct Resume {
    pub cursor: Option<Cursor>,
    /// The map the player was last known to be on, so that positions read after a resume
    /// normalise against bounds stated before it.
    pub map: Option<MapBounds>,
    /// The last position kept, so that the sampling interval survives a resume rather than
    /// restarting at every poll and studding the track with clusters.
    pub sampled: Option<Sampled>,
}

/// What one read produced.
#[derive(Debug, Clone)]
pub struct Reading {
    pub cursor: Cursor,
    pub restarted: Option<Restarted>,
    pub facts: Facts,
    /// New bytes this read got through, which is what a caller working to a budget across
    /// several files spends out of it.
    pub consumed: u64,
    /// Whether the read stopped on its byte budget rather than at the end of the file, which
    /// is the caller's cue that there is more waiting and no reason to hurry.
    pub more: bool,
}

/// How a file is read: the year and zone its stamps are missing, and how much of it one read
/// is allowed to get through.
#[derive(Debug, Clone, Copy)]
pub struct Reader {
    pub year: i32,
    pub zone: Zone,
    /// New bytes one call may consume. A first pass over a season of logs is gigabytes, and
    /// doing it in one go is a sync that appears to have hung; doing it a chunk at a time on
    /// a beat that comes round every thirty seconds is the same work, finished, without a
    /// window that stops answering.
    pub budget: u64,
    pub sample_seconds: i64,
}

impl Reader {
    pub fn new(year: i32, zone: Zone) -> Self {
        Self {
            year,
            zone,
            budget: u64::MAX,
            sample_seconds: SAMPLE_SECONDS,
        }
    }

    /// Reads what is new in `path`.
    pub fn read(&self, path: &Path, resume: &Resume) -> Result<Reading, String> {
        let mut file = File::open(path)
            .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
        let size = file
            .metadata()
            .map_err(|error| format!("Could not measure {}: {error}", path.display()))?
            .len();

        let restarted = match &resume.cursor {
            None => None,
            Some(cursor) if size < cursor.offset || size < cursor.head_bytes => {
                Some(Restarted::Truncated)
            }
            Some(cursor) => {
                let head = digest_head(&mut file, cursor.head_bytes)?;
                (head != cursor.head).then_some(Restarted::Replaced)
            }
        };
        let start = match (&resume.cursor, restarted) {
            (Some(cursor), None) => cursor.offset,
            _ => 0,
        };
        // A restart throws away the state that only made sense against the old file. Bounds
        // stated in a log that no longer exists are not bounds for the one that replaced it.
        let carried = if restarted.is_some() {
            Resume::default()
        } else {
            resume.clone()
        };

        let (facts, consumed, more) = self.consume(&mut file, start)?;
        let facts = self.finish(facts, &carried);
        // Measured again, because the file is being written to while this reads it and the
        // size taken above is already old. A cursor recording a size smaller than its own
        // offset would have the next read declare the file truncated and start it over — on
        // a file whose only crime was growing between two lines of this function.
        let size = file
            .metadata()
            .map_err(|error| format!("Could not measure {}: {error}", path.display()))?
            .len()
            .max(start + consumed);
        Ok(Reading {
            cursor: Cursor {
                offset: start + consumed,
                size,
                head: digest_head(&mut file, HEAD_BYTES.min(size))?,
                head_bytes: HEAD_BYTES.min(size),
            },
            restarted,
            facts,
            consumed,
            more,
        })
    }

    /// Walks the file from `start`, stopping at the budget or at the last complete line.
    fn consume(&self, file: &mut File, start: u64) -> Result<(Vec<Line>, u64, bool), String> {
        file.seek(SeekFrom::Start(start))
            .map_err(|error| format!("Could not seek a combat log: {error}"))?;
        let mut reader = BufReader::new(file);
        let mut lines = Vec::new();
        let mut consumed = 0_u64;
        let mut raw = Vec::new();
        loop {
            if consumed >= self.budget {
                return Ok((lines, consumed, true));
            }
            raw.clear();
            let read = reader
                .read_until(b'\n', &mut raw)
                .map_err(|error| format!("Could not read a combat log: {error}"))?;
            if read == 0 {
                return Ok((lines, consumed, false));
            }
            // A tail with no newline on it is a record the client has not finished writing.
            // Leaving it unconsumed is the whole of the answer: the next read starts where
            // this one did and finds the line complete.
            if !raw.ends_with(b"\n") {
                return Ok((lines, consumed, false));
            }
            consumed += read as u64;
            // Lossy on purpose. One line with a byte in it that no encoding explains is not
            // worth abandoning the rest of a raid night over.
            lines.push(Line(String::from_utf8_lossy(&raw).into_owned()));
        }
    }

    /// Turns the lines of one read into the facts worth keeping.
    fn finish(&self, lines: Vec<Line>, resume: &Resume) -> Facts {
        let mut clock = Clock::new(self.year, self.zone);
        let mut facts = Facts::default();
        let mut map = resume.map.clone();
        let mut sampled: Option<Sampled> = resume.sampled;
        // Two slots rather than one, because the two kinds of fight nest: a keystone run is
        // half an hour long and has four bosses inside it. One slot would have the first
        // `ENCOUNTER_START` close the run it is part of, and the run's own end would then
        // arrive with nothing to attach itself to.
        let mut boss: Option<Fight> = None;
        let mut run: Option<Fight> = None;

        for Line(text) in &lines {
            let Some((stamp, payload)) = split_line(text) else {
                continue;
            };
            let Some(at) = clock.resolve(&stamp) else {
                continue;
            };
            facts.lines += 1;
            facts.first_at.get_or_insert(at);
            facts.last_at = Some(at);
            let parts = fields(payload);
            match parts[0] {
                "COMBAT_LOG_VERSION" => {
                    facts.advanced_declared = declared_advanced(&parts);
                }
                "MAP_CHANGE" => {
                    if let Some(bounds) = read_map(&parts, at) {
                        facts.maps.push(bounds.clone());
                        map = Some(bounds);
                    }
                }
                "ENCOUNTER_START" => {
                    close(&mut facts, boss.take());
                    boss = Some(start_encounter(&parts, at));
                }
                "ENCOUNTER_END" => {
                    let fight = end_encounter(boss.take(), &parts, at);
                    close(&mut facts, Some(fight));
                }
                "CHALLENGE_MODE_START" => {
                    close(&mut facts, run.take());
                    run = Some(start_keystone(&parts, at));
                }
                "CHALLENGE_MODE_END" => {
                    let fight = end_keystone(run.take(), &parts, at);
                    close(&mut facts, Some(fight));
                }
                "COMBATANT_INFO" => {
                    if let Some(combatant) = read_combatant(&parts) {
                        // Whichever fight has just started. A snapshot with neither open is
                        // one whose start was read on the previous pass; opening a fight with
                        // no beginning keeps it, and the end still to come names it.
                        if boss.is_none() && run.is_none() {
                            boss = Some(Fight {
                                started_at: None,
                                ..Fight::opened(Fought::Encounter, at)
                            });
                        }
                        boss.as_mut()
                            .or(run.as_mut())
                            .expect("one of the two was just opened")
                            .combatants
                            .push(combatant);
                    }
                }
                event => {
                    if !carries_advanced(event, &parts) {
                        continue;
                    }
                    // Said of the line rather than of what was kept from it. A raid where
                    // somebody else's positions are logged and the player's are not is still
                    // a log with advanced logging on, and reporting otherwise would send a
                    // reader to tick a box that is already ticked.
                    facts.advanced_seen = true;
                    let Some(found) = read_position(event, &parts, at) else {
                        continue;
                    };
                    // Either far enough from the last point in time, or on a different map —
                    // a zone change is worth a point however recently the last one was taken,
                    // because it is the moment a track would otherwise appear to teleport.
                    let due = sampled.is_none_or(|last| {
                        at - last.at >= self.sample_seconds * 1000
                            || last.ui_map_id != found.ui_map_id
                    });
                    if !due {
                        continue;
                    }
                    sampled = Some(Sampled {
                        at,
                        ui_map_id: found.ui_map_id,
                    });
                    facts.positions.push(placed(found, map.as_ref()));
                }
            }
        }
        // The boss first: a read that ends inside a keystone run ends inside whatever pull was
        // happening at the time, and the inner of the two is the one that would have closed
        // first had the file gone on.
        close(&mut facts, boss);
        close(&mut facts, run);
        facts
    }
}

/// One raw line, kept apart from the parsing so that reading the file and understanding it are
/// two steps rather than one.
struct Line(String);

fn close(facts: &mut Facts, fight: Option<Fight>) {
    if let Some(fight) = fight {
        facts.fights.push(fight);
    }
}

/// `COMBAT_LOG_VERSION,20,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,10.2.0,PROJECT_ID,1` — read by
/// name rather than by position, because the pairs after the version have gained members
/// before and the one worth having is the flag.
fn declared_advanced(parts: &[&str]) -> Option<bool> {
    parts
        .iter()
        .position(|field| *field == "ADVANCED_LOG_ENABLED")
        .and_then(|index| parts.get(index + 1))
        .and_then(|field| integer(field))
        .map(|value| value != 0)
}

fn read_map(parts: &[&str], at: i64) -> Option<MapBounds> {
    Some(MapBounds {
        ui_map_id: integer(parts.get(1)?)?,
        name: unquoted(parts.get(2)?).to_string(),
        x0: number(parts.get(3)?)?,
        x1: number(parts.get(4)?)?,
        y0: number(parts.get(5)?)?,
        y1: number(parts.get(6)?)?,
        at,
    })
}

/// `ENCOUNTER_START,encounterID,encounterName,difficultyID,groupSize,instanceID`
fn start_encounter(parts: &[&str], at: i64) -> Fight {
    Fight {
        encounter_id: parts.get(1).and_then(|field| integer(field)),
        name: parts
            .get(2)
            .map(|field| unquoted(field).to_string())
            .unwrap_or_default(),
        difficulty_id: parts.get(3).and_then(|field| integer(field)),
        group_size: parts.get(4).and_then(|field| integer(field)),
        instance_id: parts.get(5).and_then(|field| integer(field)),
        ..Fight::opened(Fought::Encounter, at)
    }
}

/// `ENCOUNTER_END,encounterID,encounterName,difficultyID,groupSize,success[,fightTimeMs]` —
/// the fight time is absent on older clients, which is why it is read as an option rather
/// than derived from the boundaries and presented as if the client had said it.
fn end_encounter(open: Option<Fight>, parts: &[&str], at: i64) -> Fight {
    let mut fight = open.unwrap_or(Fight {
        started_at: None,
        ..Fight::opened(Fought::Encounter, at)
    });
    fight.kind = Fought::Encounter;
    fight.ended_at = Some(at);
    fight.encounter_id = parts
        .get(1)
        .and_then(|field| integer(field))
        .or(fight.encounter_id);
    if let Some(name) = parts.get(2).map(|field| unquoted(field)) {
        if !name.is_empty() {
            fight.name = name.to_string();
        }
    }
    fight.difficulty_id = parts
        .get(3)
        .and_then(|field| integer(field))
        .or(fight.difficulty_id);
    fight.group_size = parts
        .get(4)
        .and_then(|field| integer(field))
        .or(fight.group_size);
    fight.success = parts
        .get(5)
        .and_then(|field| integer(field))
        .map(|value| value != 0);
    fight.duration_ms = parts.get(6).and_then(|field| integer(field));
    fight
}

/// `CHALLENGE_MODE_START,zoneName,instanceID,challengeModeID,keystoneLevel,[affixes]`
fn start_keystone(parts: &[&str], at: i64) -> Fight {
    Fight {
        name: parts
            .get(1)
            .map(|field| unquoted(field).to_string())
            .unwrap_or_default(),
        instance_id: parts.get(2).and_then(|field| integer(field)),
        encounter_id: parts.get(3).and_then(|field| integer(field)),
        keystone_level: parts.get(4).and_then(|field| integer(field)),
        affixes: parts
            .get(5)
            .and_then(|field| group(field))
            .map(|inner| {
                entries(inner)
                    .iter()
                    .filter_map(|entry| integer(entry))
                    .collect()
            })
            .unwrap_or_default(),
        ..Fight::opened(Fought::Keystone, at)
    }
}

/// `CHALLENGE_MODE_END,instanceID,success,keystoneLevel,totalTimeMs[,upgradeLevels]`
fn end_keystone(open: Option<Fight>, parts: &[&str], at: i64) -> Fight {
    let mut fight = open.unwrap_or(Fight {
        started_at: None,
        ..Fight::opened(Fought::Keystone, at)
    });
    fight.kind = Fought::Keystone;
    fight.ended_at = Some(at);
    fight.instance_id = parts
        .get(1)
        .and_then(|field| integer(field))
        .or(fight.instance_id);
    fight.success = parts
        .get(2)
        .and_then(|field| integer(field))
        .map(|value| value != 0);
    fight.keystone_level = parts
        .get(3)
        .and_then(|field| integer(field))
        .or(fight.keystone_level);
    fight.duration_ms = parts.get(4).and_then(|field| integer(field));
    fight
}

/// `COMBATANT_INFO,guid,faction,<a great many stats>,specID,(talents),...,[equipment],...`
///
/// Read by shape rather than by column, because the stats between the faction and the spec
/// have been added to in every expansion and counting them here would be signing up to change
/// this function each time. What does not move is the arrangement: the groups come after the
/// scalars, so the spec is the last plain number before the first group and the talents are
/// the first group.
///
/// Equipment is found by the one thing that is only true of it — its entries are groups whose
/// own entries are groups, because an item carries lists of enchants, bonus ids and gems
/// inside it. A talent entry is three bare numbers however many of them there are, so this
/// does not depend on equipment being the longer list, which it usually but not always is.
fn read_combatant(parts: &[&str]) -> Option<Combatant> {
    let guid = parts.get(1)?.trim().to_string();
    if guid.is_empty() {
        return None;
    }
    let first_group = parts.iter().position(|field| group(field).is_some());
    let spec_id = first_group
        .filter(|index| *index >= 2)
        .and_then(|index| parts.get(index - 1))
        .and_then(|field| integer(field));
    let talents = first_group
        .and_then(|index| parts.get(index))
        .and_then(|field| group(field))
        .map(numbers)
        .unwrap_or(Value::Array(Vec::new()));
    let equipment = parts
        .iter()
        .copied()
        .filter_map(group)
        .map(entries)
        .max_by_key(|found| found.iter().filter(|entry| holds_a_group(entry)).count())
        .filter(|found| found.iter().any(|entry| holds_a_group(entry)))
        .map(|found| worn(&found))
        .unwrap_or(Value::Array(Vec::new()));
    Some(Combatant {
        guid,
        faction: parts.get(2).and_then(|field| integer(field)),
        spec_id,
        talents,
        equipment,
    })
}

/// Whether a group has a group inside it, which is what an equipped item looks like and what
/// nothing else in a `COMBATANT_INFO` line does.
fn holds_a_group(entry: &str) -> bool {
    group(entry).is_some_and(|inner| entries(inner).iter().any(|part| group(part).is_some()))
}

/// A group's entries as JSON: numbers where they are numbers, and lists where the entries are
/// themselves groups, which is how talents have been written since they became a tree.
fn numbers(inner: &str) -> Value {
    Value::Array(
        entries(inner)
            .iter()
            .map(|entry| match group(entry) {
                Some(nested) => numbers(nested),
                None => integer(entry).map(Value::from).unwrap_or(Value::Null),
            })
            .collect(),
    )
}

/// `(itemID,itemLevel,(enchants),(bonusIDs),(gems))` per equipped item.
///
/// The id and the level are what a reader of history wants — what was worn, and what it was
/// worth. The bonus ids come along because they are what actually decide an item's level and
/// its look, and dropping them would make the row unable to answer a question it holds the
/// input for. The enchants and gems are read past.
fn worn(found: &[&str]) -> Value {
    Value::Array(
        found
            .iter()
            .filter_map(|entry| {
                let parts = entries(group(entry)?);
                let item_id = integer(parts.first()?)?;
                Some(json!({
                    "itemId": item_id,
                    "itemLevel": parts.get(1).and_then(|field| integer(field)),
                    "bonusIds": parts
                        .get(3)
                        .and_then(|field| group(field))
                        .map(|inner| {
                            entries(inner).iter().filter_map(|entry| integer(entry)).collect()
                        })
                        .unwrap_or_else(Vec::<i64>::new),
                }))
            })
            .collect(),
    )
}

/* ---------- positions ---------- */

/// A position as the line stated it, before any map has been applied to it.
struct Found {
    at: i64,
    guid: String,
    name: String,
    ui_map_id: Option<i64>,
    world_x: f64,
    world_y: f64,
    facing: Option<f64>,
}

fn placed(found: Found, map: Option<&MapBounds>) -> Position {
    // Only the map the point was recorded on can place it. A `MAP_CHANGE` for somewhere else
    // is not stale bounds to fall back on; it is the wrong ruler, and using it would produce
    // a number that looks exactly like an answer.
    let normalized = map
        .filter(|bounds| Some(bounds.ui_map_id) == found.ui_map_id)
        .and_then(|bounds| bounds.normalize(found.world_x, found.world_y));
    Position {
        at: found.at,
        actor_guid: found.guid,
        actor_name: found.name,
        ui_map_id: found.ui_map_id,
        world_x: found.world_x,
        world_y: found.world_y,
        map_x: normalized.map(|(x, _)| x),
        map_y: normalized.map(|(_, y)| y),
        facing: found.facing,
    }
}

/// Where the advanced parameter block starts, for the events that carry one.
///
/// Every combat event begins with the same eight fields naming its source and its target.
/// A `SPELL_` or `RANGE_` event then names the spell in three more. The advanced block, when
/// there is one, sits immediately after that and before the event's own suffix — which is why
/// this is a count rather than a search.
fn advanced_at(event: &str) -> Option<usize> {
    match event {
        "SWING_DAMAGE" | "SWING_DAMAGE_LANDED" => Some(9),
        "SPELL_DAMAGE"
        | "SPELL_PERIODIC_DAMAGE"
        | "SPELL_BUILDING_DAMAGE"
        | "RANGE_DAMAGE"
        | "DAMAGE_SPLIT"
        | "DAMAGE_SHIELD"
        | "SPELL_HEAL"
        | "SPELL_PERIODIC_HEAL"
        | "SPELL_CAST_SUCCESS"
        | "SPELL_ENERGIZE"
        | "SPELL_SUMMON"
        | "SPELL_RESURRECT" => Some(12),
        _ => None,
    }
}

/// The fewest fields an advanced block has ever been. A 10.2 client wrote seventeen; a 12.0.7
/// one writes nineteen, having gained two somewhere between the armour and the power. This is
/// not what the position is found by — see [`position_at`] — it is only what makes a line long
/// enough to be worth looking at, and so it is the smaller of the two.
const ADVANCED_MINIMUM: usize = 17;

/// Where `positionX, positionY, uiMapID, facing` sit inside an advanced block.
///
/// Counting to them is the thing that quietly stops being true. The block's first fields are
/// the same as they have always been, but the ones between the armour and the position have
/// been added to at least once — a 10.2 client put the position twelve fields into the block
/// and a 12.0.7 one puts it fourteen — and a parser holding a number reads the map id as a
/// coordinate the day that changes, which looks like a player standing in a corner rather than
/// like a bug.
///
/// So this looks for the shape instead, which has not moved: two coordinates written with a
/// decimal point, then a map id, then a facing. Nothing earlier in the block is written with a
/// decimal point — health, power, attack power and armour are all whole numbers — so the first
/// place that shape appears is the position.
fn position_at(parts: &[&str], start: usize) -> Option<usize> {
    // From two past the start: the block opens with a GUID and its owner's, and neither can be
    // mistaken for a coordinate, but skipping them costs nothing and says why they are there.
    (start + 2..parts.len().saturating_sub(3)).find(|index| {
        decimal(parts[*index])
            && decimal(parts[index + 1])
            && stated_or_nil(parts[index + 2])
            && decimal(parts[index + 3])
    })
}

/// A number the client wrote with a decimal point, which is how it writes every coordinate and
/// no other field of an advanced block.
fn decimal(field: &str) -> bool {
    field.contains('.') && number(field).is_some()
}

/// A whole number, or the `nil` a client writes where it had none — which is what a map id is
/// on a line recorded somewhere the client could not name.
fn stated_or_nil(field: &str) -> bool {
    integer(field).is_some() || field.trim() == "nil"
}

/// Whether this line was written with advanced logging on.
///
/// The same field position holds the advanced block's first field when logging was advanced
/// and an ordinary number — an amount, a school — when it was not, so length alone does not
/// settle it. What does is that the block opens with a unit GUID and the suffix never begins
/// with one.
fn carries_advanced(event: &str, parts: &[&str]) -> bool {
    advanced_at(event).is_some_and(|start| {
        parts.len() >= start + ADVANCED_MINIMUM && is_guid(parts[start].trim())
    })
}

/// The player's own position, if this line carries one.
///
/// The advanced block describes one unit and names it, and which unit that is differs between
/// event types — the caster on some, the thing being hit on others. So this does not assume:
/// it reads the name out of the block and finds which end of the line it belongs to, then asks
/// that end's flags whether the unit is the player running the client. Everything else in the
/// raid is somebody else's track and is not kept.
fn read_position(event: &str, parts: &[&str], at: i64) -> Option<Found> {
    if !carries_advanced(event, parts) {
        return None;
    }
    let start = advanced_at(event)?;
    let subject = parts[start].trim();
    // The unit is named twice on the line — once as the source or the target, once inside the
    // advanced block — and the flags only sit beside the first of those.
    let (name, unit_flags) = if parts.get(1).map(|field| field.trim()) == Some(subject) {
        (unquoted(parts.get(2)?), flags(parts.get(3)?)?)
    } else if parts.get(5).map(|field| field.trim()) == Some(subject) {
        (unquoted(parts.get(6)?), flags(parts.get(7)?)?)
    } else {
        return None;
    };
    if unit_flags & AFFILIATION_MASK != AFFILIATION_MINE || !subject.starts_with("Player-") {
        return None;
    }
    let position = position_at(parts, start)?;
    Some(Found {
        at,
        guid: subject.to_string(),
        name: name.to_string(),
        world_x: number(parts[position])?,
        world_y: number(parts[position + 1])?,
        ui_map_id: integer(parts[position + 2]),
        facing: number(parts[position + 3]),
    })
}

/* ---------- the last moment a file proves the client was alive ---------- */

/// How much of a file's end is read to find the last line that carries a timestamp.
///
/// A combat log line is a few hundred bytes and the longest — `COMBATANT_INFO` for a
/// twenty-player raid — is a few thousand. Sixty-four kilobytes is far more than one line and
/// far less than one read anybody would notice, and it is read from the end rather than from
/// wherever ingestion happened to stop, because the question here is not what happened but
/// only *when the writing stopped*.
pub const TAIL_BYTES: u64 = 64 * 1024;

/// The instant of the last complete, stamped line in `path`, in epoch milliseconds.
///
/// This is the strongest available evidence that the client was alive at a given moment, and
/// it costs one seek and one read however large the file is. `None` means the file could not
/// be read, or holds no line this parser recognises as a record — an empty log that a session
/// only just started, most often.
///
/// The stamps of older clients carry no year, so one is supplied the way ingestion supplies
/// it: from the file's name or its modification time. [`Clock`]'s rollover cannot help here —
/// it works by watching December turn into January on the way past, and nothing walks past a
/// tail — so a yearless log read across a New Year boundary is out by a year. Every current
/// client states the year on the line, which is what makes that acceptable rather than a trap.
pub fn tail_at(path: &Path, year: i32, zone: Zone) -> Option<i64> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let start = size.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    let text = String::from_utf8_lossy(&tail);

    // Backwards, and the first stamped line wins. Both ends of this window are allowed to be
    // half a line — the front because the seek lands mid-record, the back because the client
    // may be part-way through writing one — and neither needs handling by position.
    // `split_line` takes a line only when it opens with a date and a time, so the severed
    // front of a record is refused; and a record severed at the *end* still opens with the
    // stamp that is the only thing being asked for.
    let mut clock = Clock::new(year, zone);
    text.lines()
        .rev()
        .find_map(|line| split_line(line).map(|(stamp, _)| stamp))
        .and_then(|stamp| clock.resolve(&stamp))
}

/* ---------- recognising a file again ---------- */

/// A digest of the first `bytes` of a file.
///
/// How many bytes went into it is part of the answer, kept on the cursor beside the digest,
/// because a log that was 300 bytes long when it was first read is 40 megabytes long an hour
/// later — and comparing a digest of the whole small file against a digest of the first page
/// of the big one would call every growing log a replaced one.
fn digest_head(file: &mut File, bytes: u64) -> Result<String, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Could not rewind a combat log: {error}"))?;
    let mut head = vec![0_u8; bytes as usize];
    file.read_exact(&mut head)
        .map_err(|error| format!("Could not read the start of a combat log: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&head);
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    /// The synthetic logs, read off disk rather than embedded, because the thing under test
    /// takes a path and reads a file that is being written to underneath it. Compiling the
    /// bytes into the binary would test a different function.
    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join("combatlog")
            .join(name)
    }

    /// A copy of a fixture somewhere it can be grown, truncated and replaced.
    fn scratch(name: &str, temp: &Path) -> PathBuf {
        let path = temp.join("WoWCombatLog.txt");
        fs::copy(fixture(name), &path).unwrap();
        path
    }

    /// An instant, written the way the fixtures write them, in epoch milliseconds.
    fn moment(date: (i32, u32, u32), time: (u32, u32, u32), offset_hours: i32) -> i64 {
        FixedOffset::east_opt(offset_hours * 3600)
            .unwrap()
            .with_ymd_and_hms(date.0, date.1, date.2, time.0, time.1, time.2)
            .unwrap()
            .timestamp_millis()
    }

    /// The reader the fixtures are read with: a fixed zone, so that a stamp carrying no offset
    /// means the same instant on a machine in Reykjavik and one in Auckland.
    fn reader(year: i32) -> Reader {
        Reader::new(year, Zone::East(0))
    }

    fn read(name: &str, year: i32) -> Facts {
        reader(year)
            .read(&fixture(name), &Resume::default())
            .unwrap()
            .facts
    }

    /* ---------- the shape of a line ---------- */

    #[test]
    fn reads_a_modern_stamp_with_its_year_and_its_offset() {
        let (stamp, payload) = split_line("11/14/2023 20:15:30.123-5  ENCOUNTER_END,2820").unwrap();

        assert_eq!(
            stamp,
            Stamp {
                month: 11,
                day: 14,
                year: Some(2023),
                hour: 20,
                minute: 15,
                second: 30,
                millis: 123,
                offset: Some(-5 * 3600),
            }
        );
        assert_eq!(payload, "ENCOUNTER_END,2820");
    }

    /// The old shape: no year, no zone, and nothing on the line that admits either is missing.
    #[test]
    fn reads_the_old_stamp_that_states_neither_year_nor_zone() {
        let (stamp, payload) = split_line("12/31 23:58:00.000  ENCOUNTER_START,2329").unwrap();

        assert_eq!(stamp.year, None);
        assert_eq!(stamp.offset, None);
        assert_eq!((stamp.month, stamp.day, stamp.hour), (12, 31, 23));
        assert_eq!(payload, "ENCOUNTER_START,2329");
    }

    #[test]
    fn reads_an_offset_written_any_of_the_ways_a_client_writes_one() {
        let cases = [
            ("20:15:30.123-5", Some(-5 * 3600)),
            ("20:15:30.123-05", Some(-5 * 3600)),
            ("20:15:30.123-0500", Some(-5 * 3600)),
            ("20:15:30.123+0530", Some(5 * 3600 + 1800)),
            ("20:15:30.123+2", Some(2 * 3600)),
            // What a 12.0.7 client actually writes: no sign at all when the offset is east.
            ("16:24:38.4081", Some(3600)),
            ("16:24:38.4080", Some(0)),
            ("16:24:38.40810", Some(10 * 3600)),
            ("16:24:38.4080530", Some(5 * 3600 + 1800)),
            ("20:15:30.123", None),
        ];
        for (time, expected) in cases {
            let (stamp, _) = split_line(&format!("11/14/2023 {time}  UNIT_DIED,x")).unwrap();
            assert_eq!(stamp.offset, expected, "reading {time}");
        }
    }

    /// A fraction is a fraction of a second, not a count of milliseconds — `.1` is a tenth.
    #[test]
    fn reads_a_fraction_of_a_second_by_its_place_and_not_its_digits() {
        assert_eq!(parse_fraction("1"), Some(100));
        assert_eq!(parse_fraction("12"), Some(120));
        assert_eq!(parse_fraction("123"), Some(123));
        assert_eq!(parse_fraction("1234"), Some(123));
        assert_eq!(parse_fraction(""), None);
        assert_eq!(parse_fraction("abc"), None);
    }

    #[test]
    fn steps_over_anything_that_is_not_a_record() {
        for line in [
            "",
            "   ",
            "this line has no timestamp at all and must be stepped over",
            "03/07/2024 12:00:50.000+2",
            "11/14/2023 20:15:30.123-5  ",
            "99/99/2023 99:99:99.999  ENCOUNTER_END,1",
            "11/14/2023 20:15  ENCOUNTER_END,1",
        ] {
            assert!(split_line(line).is_none(), "took {line:?} for a record");
        }
    }

    /* ---------- the clock ---------- */

    #[test]
    fn keeps_the_year_a_stamp_states() {
        let mut clock = Clock::new(1999, Zone::East(0));
        let (stamp, _) = split_line("11/14/2023 20:15:30.000+0  UNIT_DIED,x").unwrap();

        assert_eq!(
            clock.resolve(&stamp),
            Some(moment((2023, 11, 14), (20, 15, 30), 0))
        );
    }

    /// The year boundary, which the old format cannot state and only the line before it can
    /// imply. Nothing else in the file says that 01/01 is a different year from 12/31.
    #[test]
    fn rolls_the_year_over_when_december_is_followed_by_january() {
        let mut clock = Clock::new(2019, Zone::East(0));
        let stamps: Vec<Stamp> = [
            "12/31 23:58:00.000  x,1",
            "01/01 00:01:10.000  x,1",
            "01/01 00:05:00.000  x,1",
        ]
        .iter()
        .map(|line| split_line(line).unwrap().0)
        .collect();

        let resolved: Vec<i64> = stamps
            .iter()
            .map(|stamp| clock.resolve(stamp).unwrap())
            .collect();

        assert_eq!(resolved[0], moment((2019, 12, 31), (23, 58, 0), 0));
        assert_eq!(resolved[1], moment((2020, 1, 1), (0, 1, 10), 0));
        // And exactly once: a second January line is still January of the same year.
        assert_eq!(resolved[2], moment((2020, 1, 1), (0, 5, 0), 0));
    }

    /// A line's own offset outranks the zone the reader was given, because the line knows and
    /// the reader is guessing.
    #[test]
    fn prefers_the_offset_on_the_line_to_the_one_it_was_given() {
        let mut clock = Clock::new(2023, Zone::East(3 * 3600));
        let (stamp, _) = split_line("11/14/2023 20:15:30.000-5  x,1").unwrap();

        assert_eq!(
            clock.resolve(&stamp),
            Some(moment((2023, 11, 14), (20, 15, 30), -5))
        );
    }

    /* ---------- fields ---------- */

    #[test]
    fn keeps_a_comma_inside_a_name_out_of_the_split() {
        let found = fields(r#"ENCOUNTER_END,2329,"Wrathion, the Black Emperor",15,20,1"#);

        assert_eq!(found.len(), 6);
        assert_eq!(unquoted(found[2]), "Wrathion, the Black Emperor");
    }

    #[test]
    fn keeps_a_comma_inside_a_group_out_of_the_split() {
        let found = fields("COMBATANT_INFO,Player-1-2,0,(1,2,3),[(4,5,(6,7))],9");

        assert_eq!(
            found,
            [
                "COMBATANT_INFO",
                "Player-1-2",
                "0",
                "(1,2,3)",
                "[(4,5,(6,7))]",
                "9"
            ]
        );
    }

    #[test]
    fn reads_nil_as_absent_rather_than_as_zero() {
        assert_eq!(number("nil"), None);
        assert_eq!(integer("nil"), None);
        assert_eq!(number("0.00"), Some(0.0));
        assert_eq!(number("-1.5e2"), Some(-150.0));
        assert_eq!(integer(""), None);
    }

    #[test]
    fn tells_a_unit_guid_from_a_number() {
        assert!(is_guid("Player-3676-0A1B2C3D"));
        assert!(is_guid("Creature-0-3886-2549-24099-208478-000012ABCD"));
        assert!(is_guid("0000000000000000"));
        assert!(!is_guid("18234"));
        assert!(!is_guid("-4990"));
        assert!(!is_guid("nil"));
    }

    /* ---------- map bounds ---------- */

    /// The conversion the whole position track depends on. The map's horizontal axis is the
    /// world's Y and its vertical is the world's X, both counting down from the larger edge.
    #[test]
    fn turns_world_yards_into_a_fraction_across_the_map() {
        let bounds = MapBounds {
            ui_map_id: 2232,
            name: "Amirdrassil".into(),
            x0: 4400.0,
            x1: 3600.0,
            y0: -2000.0,
            y1: -3000.0,
            at: 0,
        };

        assert_eq!(bounds.normalize(4400.0, -2000.0), Some((0.0, 0.0)));
        assert_eq!(bounds.normalize(3600.0, -3000.0), Some((1.0, 1.0)));
        assert_eq!(bounds.normalize(4200.0, -2500.0), Some((0.5, 0.25)));
    }

    /// Bounds a client would not state place nothing. A zero-width map would divide by zero
    /// and answer with an infinity that reads exactly like a coordinate.
    #[test]
    fn refuses_to_place_a_point_on_a_map_with_no_width() {
        let flat = MapBounds {
            ui_map_id: 1,
            name: String::new(),
            x0: 100.0,
            x1: 100.0,
            y0: 50.0,
            y1: -50.0,
            at: 0,
        };

        assert_eq!(flat.normalize(100.0, 0.0), None);
    }

    /* ---------- the one log a client actually wrote ---------- */

    /// Every other fixture in the folder was written by hand from a documented layout, which
    /// is exactly the kind of source that is right until an expansion moves something. These
    /// tests are the ones that answer to a file a 12.0.7 client produced.
    ///
    /// The stamp is the first thing it settles, and it settles it against what was assumed:
    /// the fraction is milliseconds, three digits, and what looks like a fourth is a UTC
    /// offset written with no sign on it. Every line of the file ends in that `1`, which no
    /// fourth digit of a fraction would.
    #[test]
    fn reads_the_stamp_a_real_client_writes() {
        let (stamp, payload) = split_line(
            "7/27/2026 16:24:33.3011  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.0.7,PROJECT_ID,1",
        )
        .unwrap();

        assert_eq!(
            stamp,
            Stamp {
                month: 7,
                day: 27,
                year: Some(2026),
                hour: 16,
                minute: 24,
                second: 33,
                millis: 301,
                offset: Some(3600),
            }
        );
        assert!(payload.starts_with("COMBAT_LOG_VERSION,22,"));
    }

    /// And the instant that comes out of it, which is the whole point of reading the offset:
    /// a log written at 16:24 in London is 15:24 UTC, and a reader that took the `1` for a
    /// fraction would have placed it an hour late on any machine but the one that wrote it.
    #[test]
    fn places_a_real_log_at_the_instant_it_was_written() {
        let facts = read("real-client.txt", 2026);

        assert_eq!(
            facts.first_at,
            Some(moment((2026, 7, 27), (16, 24, 33), 1) + 301)
        );
        assert_eq!(
            facts.last_at,
            Some(moment((2026, 7, 27), (16, 24, 54), 1) + 82)
        );
        assert_eq!(facts.lines, 35);
        assert_eq!(facts.advanced_declared, Some(true));
        assert!(facts.advanced_seen);
    }

    /// The advanced block found by shape rather than by a count. A 12.0.7 client writes two
    /// fields more than the layout these fixtures were written from, so the position is
    /// fourteen fields into the block and not twelve — and the events that carry one are the
    /// same events as before, `SWING_` nine fields in and `SPELL_` twelve.
    #[test]
    fn finds_the_position_in_a_block_two_fields_longer_than_the_old_one() {
        let facts = read("real-client.txt", 2026);

        let track: Vec<(i64, f64, f64)> = facts
            .positions
            .iter()
            .map(|point| (point.at, point.world_x, point.world_y))
            .collect();
        assert_eq!(
            track,
            [
                (
                    moment((2026, 7, 27), (16, 24, 38), 1) + 408,
                    -3420.47,
                    4526.44
                ),
                (
                    moment((2026, 7, 27), (16, 24, 45), 1) + 207,
                    -3383.77,
                    4498.26
                ),
                (
                    moment((2026, 7, 27), (16, 24, 51), 1) + 78,
                    -3382.32,
                    4518.92
                ),
            ]
        );
        assert_eq!(facts.positions[0].facing, Some(0.5276));
        assert_eq!(facts.positions[0].actor_name, "Vaeliss-Ravencrest-EU");
        // The lines whose advanced block describes what was being hit rather than who was
        // hitting it. Both of the pulls in the file have one, and neither is the player.
        assert!(facts
            .positions
            .iter()
            .all(|point| point.actor_guid == "Player-1305-0A5B6C7D"));
    }

    /// The conversion, against a place that can be checked. These positions were recorded
    /// among the Auchenai in the Bone Wastes, which is the middle of Terokkar Forest and a
    /// little south of it — and that is where they land. Swap the axes and the same points
    /// come out at `0.67, 0.47`, out in the east of the zone, which is the failure this was
    /// most at risk of and the one nothing in the file alone would have caught.
    #[test]
    fn puts_a_real_position_where_it_really_was() {
        let facts = read("real-client.txt", 2026);

        assert_eq!(
            facts.maps.len(),
            2,
            "the client states its map more than once"
        );
        let bounds = &facts.maps[0];
        assert_eq!(bounds.ui_map_id, 108);
        assert_eq!(bounds.name, "Terokkar Forest");
        // Wider than it is tall, which is Terokkar's map and is what says the width is the
        // world's Y span rather than its X.
        assert_eq!(bounds.x0 - bounds.x1, 3600.0);
        assert!(bounds.y0 - bounds.y1 > bounds.x0 - bounds.x1);

        let placed: Vec<(f64, f64)> = facts
            .positions
            .iter()
            .map(|point| (round(point.map_x.unwrap()), round(point.map_y.unwrap())))
            .collect();
        assert_eq!(placed, [(0.473, 0.672), (0.479, 0.662), (0.475, 0.662)]);
        assert!(facts
            .positions
            .iter()
            .all(|point| point.ui_map_id == Some(108)));
    }

    /// Real bounds are not round, so a real point does not normalise to anything a test can
    /// state exactly. Three decimals is a tenth of a percent of the way across a zone, which
    /// is finer than any question asked of these coordinates.
    fn round(value: f64) -> f64 {
        (value * 1000.0).round() / 1000.0
    }

    /* ---------- a raid night ---------- */

    #[test]
    fn reads_a_position_track_out_of_a_raid_night() {
        let facts = read("raid-night.txt", 2023);

        let track: Vec<(i64, f64, f64)> = facts
            .positions
            .iter()
            .map(|point| (point.at, point.map_x.unwrap(), point.map_y.unwrap()))
            .collect();
        assert_eq!(
            track,
            [
                (moment((2023, 11, 14), (20, 15, 32), -5), 0.0, 0.0),
                (moment((2023, 11, 14), (20, 15, 38), -5), 0.5, 0.25),
                (moment((2023, 11, 14), (20, 16, 2), -5), 0.2, 0.5),
                (moment((2023, 11, 14), (20, 16, 9), -5), 1.0, 1.0),
                (moment((2023, 11, 14), (20, 20, 5), -5), 0.75, 0.375),
                (moment((2023, 11, 14), (20, 20, 10), -5), 0.6, 0.4),
            ]
        );
        assert!(facts
            .positions
            .iter()
            .all(|point| point.ui_map_id == Some(2232)));
        assert!(facts.advanced_seen);
        assert_eq!(facts.advanced_declared, Some(true));
    }

    /// The world coordinates are kept beside the normalised ones, so that a conversion found
    /// to be wrong later is a conversion that can be redone.
    #[test]
    fn keeps_the_world_position_beside_the_normalised_one() {
        let facts = read("raid-night.txt", 2023);

        let first = &facts.positions[1];
        assert_eq!((first.world_x, first.world_y), (4200.0, -2500.0));
        assert_eq!(first.facing, Some(4.71));
    }

    /// A raid is twenty people all logging positions into one file. Nineteen of those tracks
    /// belong to somebody else and none of them is where the player was standing.
    #[test]
    fn keeps_only_the_track_of_the_player_running_the_client() {
        let facts = read("raid-night.txt", 2023);

        assert!(
            facts
                .positions
                .iter()
                .all(|point| point.actor_guid == "Player-3676-0A1B2C3D"),
            "somebody else's positions were kept: {:?}",
            facts.positions
        );
        assert_eq!(facts.positions[0].actor_name, "Alyndra-Ravencrest");
    }

    /// The player's own pet is affiliated to them and is not them. Its position is roughly
    /// where they are and precisely not where they are.
    #[test]
    fn does_not_take_the_players_pet_for_the_player() {
        let facts = read("raid-night.txt", 2023);

        assert!(
            !facts
                .positions
                .iter()
                .any(|point| point.actor_guid.starts_with("Pet-")),
            "a pet's position entered the track"
        );
    }

    #[test]
    fn reads_the_wipe_and_the_kill_as_two_fights() {
        let facts = read("raid-night.txt", 2023);

        assert_eq!(facts.fights.len(), 2);
        let wipe = &facts.fights[0];
        assert_eq!(wipe.kind, Fought::Encounter);
        assert_eq!(wipe.encounter_id, Some(2820));
        assert_eq!(wipe.name, "Gnarlroot");
        assert_eq!(wipe.difficulty_id, Some(16));
        assert_eq!(wipe.group_size, Some(20));
        assert_eq!(wipe.instance_id, Some(2549));
        assert_eq!(
            wipe.started_at,
            Some(moment((2023, 11, 14), (20, 16, 0), -5))
        );
        assert_eq!(
            wipe.ended_at,
            Some(moment((2023, 11, 14), (20, 16, 30), -5))
        );
        assert_eq!(wipe.success, Some(false));
        assert_eq!(wipe.duration_ms, Some(1_800_000));

        let kill = &facts.fights[1];
        assert_eq!(kill.success, Some(true));
        assert_eq!(kill.duration_ms, Some(240_000));
        assert_eq!(
            kill.started_at,
            Some(moment((2023, 11, 14), (20, 20, 0), -5))
        );
    }

    #[test]
    fn keeps_what_everyone_was_wearing_when_the_fight_started() {
        let facts = read("raid-night.txt", 2023);

        let pull = &facts.fights[0];
        assert_eq!(pull.combatants.len(), 3);
        let player = &pull.combatants[0];
        assert_eq!(player.guid, "Player-3676-0A1B2C3D");
        assert_eq!(player.faction, Some(0));
        assert_eq!(player.spec_id, Some(64));
        assert_eq!(
            player.equipment,
            json!([
                { "itemId": 207198, "itemLevel": 486, "bonusIds": [6652, 7981] },
                { "itemId": 207199, "itemLevel": 489, "bonusIds": [8836, 8840] },
            ])
        );
        assert_eq!(
            player.talents,
            json!([[80001, 80002, 1], [80003, 80004, 2], [80005, 80006, 1]])
        );
        // The second pull is a smaller group, and its snapshots belong to it rather than to
        // the fight before it.
        assert_eq!(facts.fights[1].combatants.len(), 2);
        assert_eq!(
            facts.fights[1].combatants[1].spec_id,
            Some(73),
            "the second combatant of the second pull"
        );
    }

    /// Talents are a list of lists on a modern client and a flat list on an older one, and
    /// the equipment has to be found either way — it is never the longer of the two here.
    #[test]
    fn finds_the_equipment_whichever_shape_the_talents_are_in() {
        let facts = read("awkward-fields.txt", 2024);

        let player = &facts.fights[0].combatants[0];
        assert_eq!(player.talents, json!([80001, 80002, 80003]));
        assert_eq!(
            player.equipment,
            json!([{ "itemId": 207198, "itemLevel": 486, "bonusIds": [6652, 7981] }])
        );
    }

    /* ---------- a keystone run ---------- */

    #[test]
    fn reads_a_keystone_run_with_its_level_and_its_affixes() {
        let facts = read("mythic-plus.txt", 2023);

        let run = facts
            .fights
            .iter()
            .find(|fight| fight.kind == Fought::Keystone)
            .expect("the keystone run");
        assert_eq!(run.name, "Dawn of the Infinite: Galakrond's Fall");
        assert_eq!(run.instance_id, Some(2579));
        assert_eq!(run.encounter_id, Some(2521));
        assert_eq!(run.keystone_level, Some(20));
        assert_eq!(run.affixes, [10, 9, 152]);
        assert_eq!(run.success, Some(true));
        assert_eq!(run.duration_ms, Some(1_834_567));
        assert_eq!(run.started_at, Some(moment((2023, 12, 2), (19, 0, 2), -5)));
        assert_eq!(
            run.ended_at,
            Some(moment((2023, 12, 2), (19, 30, 34), -5) + 567)
        );
        assert_eq!(run.combatants.len(), 2);
    }

    /// A dungeon boss inside a keystone run is its own fight and does not swallow the run.
    #[test]
    fn keeps_a_boss_inside_a_run_apart_from_the_run() {
        let facts = read("mythic-plus.txt", 2023);

        let kinds: Vec<Fought> = facts.fights.iter().map(|fight| fight.kind).collect();
        assert_eq!(kinds, [Fought::Encounter, Fought::Keystone]);
        assert_eq!(facts.fights[0].name, "Chronikar");
        assert_eq!(facts.fights[0].difficulty_id, Some(8));
    }

    /// A point recorded on a map whose bounds have not been stated yet is still a point. What
    /// it is not is a fraction of anything, and inventing one from the previous map's ruler
    /// would put the player somewhere they have never been.
    #[test]
    fn keeps_a_position_it_cannot_place_rather_than_placing_it_wrongly() {
        let facts = read("mythic-plus.txt", 2023);

        let stranded = facts
            .positions
            .iter()
            .find(|point| point.at == moment((2023, 12, 2), (19, 5, 2), -5))
            .expect("the first point on the second map");
        assert_eq!(stranded.ui_map_id, Some(2098));
        assert_eq!((stranded.world_x, stranded.world_y), (480.0, -120.0));
        assert_eq!(stranded.map_x, None);
        assert_eq!(stranded.map_y, None);

        let placed = facts.positions.last().unwrap();
        assert_eq!(placed.ui_map_id, Some(2098));
        assert_eq!((placed.map_x, placed.map_y), (Some(0.25), Some(0.25)));
    }

    /// Walking through a door is worth a point however recently the last one was taken. Two
    /// seconds is under the sampling interval, and a track that skipped it would show the
    /// player crossing a zone boundary they were never recorded crossing.
    #[test]
    fn always_takes_a_point_when_the_map_changes_under_the_player() {
        let facts = read("mythic-plus.txt", 2023);

        let moments: Vec<i64> = facts.positions.iter().map(|point| point.at).collect();
        assert_eq!(
            moments,
            [
                moment((2023, 12, 2), (19, 0, 5), -5),
                moment((2023, 12, 2), (19, 0, 12), -5),
                moment((2023, 12, 2), (19, 5, 0), -5),
                // Two seconds after the one above, and kept, because the map id changed.
                moment((2023, 12, 2), (19, 5, 2), -5),
                moment((2023, 12, 2), (19, 5, 10), -5),
            ]
        );
    }

    /* ---------- logs that answer fewer questions ---------- */

    #[test]
    fn parses_a_log_written_without_advanced_logging_for_what_it_does_carry() {
        let facts = read("advanced-off.txt", 2023);

        assert_eq!(facts.advanced_declared, Some(false));
        assert!(!facts.advanced_seen);
        assert!(facts.positions.is_empty());
        assert!(facts.maps.is_empty());
        // And the boundaries, which do not need advanced logging, are all there.
        assert_eq!(facts.fights.len(), 1);
        assert_eq!(facts.fights[0].name, "Igira the Cruel");
        assert_eq!(facts.fights[0].success, Some(false));
        assert_eq!(facts.lines, 11);
    }

    /// One file, two sessions, two answers. The second `COMBAT_LOG_VERSION` is the current
    /// one, and the positions only exist on its side of the boundary.
    #[test]
    fn reads_one_file_that_changed_its_mind_about_advanced_logging() {
        let facts = read("mixed-sections.txt", 2024);

        assert_eq!(facts.advanced_declared, Some(true));
        assert!(facts.advanced_seen);
        assert_eq!(facts.positions.len(), 2);
        assert!(facts
            .positions
            .iter()
            .all(|point| point.at >= moment((2024, 1, 9), (19, 55, 0), -5)));
        assert_eq!(facts.positions[0].map_x, Some(0.25));
        assert_eq!(facts.positions[0].map_y, Some(0.25));
        // The fight from the session with no positions in it is still a fight.
        assert_eq!(facts.fights.len(), 1);
        assert_eq!(facts.fights[0].name, "The Lost Dwarves");
    }

    #[test]
    fn reads_a_log_whose_stamps_cross_midnight_and_then_the_new_year() {
        let facts = read("legacy-stamps.txt", 2019);

        let boundaries: Vec<(Option<i64>, Option<i64>)> = facts
            .fights
            .iter()
            .map(|fight| (fight.started_at, fight.ended_at))
            .collect();
        assert_eq!(
            boundaries,
            [
                (
                    Some(moment((2019, 12, 31), (23, 58, 30), 0)),
                    Some(moment((2020, 1, 1), (0, 1, 10), 0)),
                ),
                (
                    Some(moment((2020, 1, 1), (0, 5, 0), 0)),
                    Some(moment((2020, 1, 1), (0, 12, 0), 0)),
                ),
                (
                    Some(moment((2020, 1, 1), (0, 20, 0), 0)),
                    Some(moment((2020, 1, 1), (0, 31, 40), 0)),
                ),
            ]
        );
        assert_eq!(facts.first_at, Some(moment((2019, 12, 31), (23, 58, 0), 0)));
        assert_eq!(facts.last_at, Some(moment((2020, 1, 1), (0, 31, 40), 0)));
    }

    /// Everything a line can be wrong about, in one file, none of it fatal.
    #[test]
    fn reads_past_every_way_a_line_can_be_awkward() {
        let facts = read("awkward-fields.txt", 2024);

        // Only the two lines that carried a usable coordinate.
        let points: Vec<(f64, f64, Option<f64>, Option<f64>)> = facts
            .positions
            .iter()
            .map(|point| (point.world_x, point.world_y, point.map_x, point.map_y))
            .collect();
        assert_eq!(
            points,
            [
                (0.0, -50.0, Some(0.5), Some(0.5)),
                (50.0, -150.0, Some(1.0), Some(0.25)),
            ]
        );
        assert_eq!(facts.positions[0].actor_name, "Ünthüríel-Área52");
        // The map whose bounds the client would not state is not a map anything is placed on.
        assert_eq!(facts.maps.len(), 1);
        assert_eq!(facts.maps[0].ui_map_id, 2112);
        // An `ENCOUNTER_END` from a client that did not state a fight time.
        assert_eq!(facts.fights[0].success, Some(true));
        assert_eq!(facts.fights[0].duration_ms, None);
        assert_eq!(facts.fights[0].name, "Gnarlroot's Understudy, the Second");
    }

    /* ---------- the last moment a file proves the client was alive ---------- */

    #[test]
    fn takes_the_instant_of_the_last_line_of_a_log() {
        assert_eq!(
            tail_at(&fixture("raid-night.txt"), 2023, Zone::East(0)),
            Some(moment((2023, 11, 14), (20, 24, 0), -5)),
        );
    }

    /// The client can be part-way through writing a record when it is asked, and that record
    /// is the newest thing in the file. Its stamp is at the front of it and is complete
    /// whatever happened to the rest, so it counts.
    #[test]
    fn takes_the_instant_of_a_record_the_client_had_not_finished_writing() {
        assert_eq!(
            tail_at(&fixture("partial-tail.txt"), 2024, Zone::East(0)),
            Some(moment((2024, 5, 1), (22, 10, 5), 0)),
        );
    }

    /// A log whose stamps carry no year is read with the one supplied — which is the year the
    /// file's name or its date claims, i.e. the year the session *started*. A session that ran
    /// past midnight on New Year's Eve therefore reads a year early. [`Clock`] fixes that
    /// while walking a file forwards and cannot help here, and every current client states the
    /// year on the line; this pins the cost of that rather than leaving it to be discovered.
    #[test]
    fn reads_a_yearless_tail_with_the_year_it_was_handed() {
        assert_eq!(
            tail_at(&fixture("legacy-stamps.txt"), 2019, Zone::East(0)),
            Some(moment((2019, 1, 1), (0, 31, 40), 0)),
        );
    }

    #[test]
    fn says_nothing_about_a_file_with_no_record_in_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("WoWCombatLog.txt");
        fs::write(&path, "not a log line at all\n").unwrap();

        assert_eq!(tail_at(&path, 2026, Zone::East(0)), None);
    }

    #[test]
    fn says_nothing_about_a_file_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();

        assert_eq!(
            tail_at(&temp.path().join("nothing.txt"), 2026, Zone::East(0)),
            None
        );
    }

    /// The read is a fixed window off the end, so the answer has to be the same whether the
    /// last line is the whole file or the last of a great many.
    #[test]
    fn reads_the_end_of_a_file_longer_than_the_window() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("WoWCombatLog.txt");
        let mut text = String::new();
        while text.len() < (TAIL_BYTES as usize) * 2 {
            text.push_str("11/14/2023 20:15:30.000+0  SPELL_DAMAGE,filler,filler,filler\n");
        }
        text.push_str("11/14/2023 21:00:00.000+0  ENCOUNTER_END,2820\n");
        fs::write(&path, &text).unwrap();

        assert_eq!(
            tail_at(&path, 2023, Zone::East(0)),
            Some(moment((2023, 11, 14), (21, 0, 0), 0)),
        );
    }

    /* ---------- reading a file that is still growing ---------- */

    #[test]
    fn reads_nothing_the_second_time_over_an_unchanged_file() {
        let first = reader(2023)
            .read(&fixture("raid-night.txt"), &Resume::default())
            .unwrap();

        let again = reader(2023)
            .read(
                &fixture("raid-night.txt"),
                &Resume {
                    cursor: Some(first.cursor.clone()),
                    ..Resume::default()
                },
            )
            .unwrap();

        assert_eq!(again.cursor, first.cursor);
        assert_eq!(again.restarted, None);
        assert_eq!(again.facts, Facts::default());
    }

    /// The trap the file being live sets: the last line is half written. Parsing it would read
    /// `ENCOUNTER_START,2820,"Gna` as a record about a boss called `"Gna`.
    #[test]
    fn leaves_the_half_written_line_at_the_end_of_a_live_file_alone() {
        let temp = tempfile::tempdir().unwrap();
        let path = scratch("partial-tail.txt", temp.path());

        let first = reader(2024).read(&path, &Resume::default()).unwrap();

        assert_eq!(first.facts.lines, 2, "the incomplete line was parsed");
        assert!(first.facts.fights.is_empty());
        assert!(
            first.cursor.offset < first.cursor.size,
            "the cursor swallowed a line the client had not finished"
        );

        // The client finishes the line and writes some more.
        fs::copy(fixture("partial-tail-complete.txt"), &path).unwrap();
        let second = reader(2024)
            .read(
                &path,
                &Resume {
                    cursor: Some(first.cursor),
                    ..Resume::default()
                },
            )
            .unwrap();

        assert_eq!(second.restarted, None);
        assert_eq!(second.facts.fights.len(), 1);
        assert_eq!(second.facts.fights[0].name, "Gnarlroot");
        assert_eq!(second.facts.fights[0].success, Some(true));
        assert_eq!(second.cursor.offset, second.cursor.size);
    }

    /// Bounds stated before a resume still place the points read after it. Otherwise a track
    /// would lose its map every thirty seconds, because `MAP_CHANGE` is written once an hour
    /// and the poll runs twice a minute.
    #[test]
    fn places_a_position_against_bounds_stated_before_the_resume() {
        let temp = tempfile::tempdir().unwrap();
        let path = scratch("partial-tail.txt", temp.path());
        let first = reader(2024).read(&path, &Resume::default()).unwrap();
        assert_eq!(first.facts.maps.len(), 1);

        fs::copy(fixture("partial-tail-complete.txt"), &path).unwrap();
        let second = reader(2024)
            .read(
                &path,
                &Resume {
                    cursor: Some(first.cursor),
                    map: first.facts.maps.last().cloned(),
                    sampled: None,
                },
            )
            .unwrap();

        assert!(
            second.facts.maps.is_empty(),
            "no map change was read this time"
        );
        let point = &second.facts.positions[0];
        assert_eq!((point.map_x, point.map_y), (Some(0.5), Some(0.5)));
    }

    #[test]
    fn notices_a_log_that_has_been_truncated_under_its_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let path = scratch("rotated-after.txt", temp.path());
        let first = reader(2024).read(&path, &Resume::default()).unwrap();
        assert_eq!(first.facts.fights.len(), 2);

        // The same file, cut down to its first two lines.
        let whole = fs::read_to_string(&path).unwrap();
        let head: String = whole
            .lines()
            .take(2)
            .map(|line| format!("{line}\n"))
            .collect();
        fs::write(&path, &head).unwrap();

        let second = reader(2024)
            .read(
                &path,
                &Resume {
                    cursor: Some(first.cursor),
                    ..Resume::default()
                },
            )
            .unwrap();

        assert_eq!(second.restarted, Some(Restarted::Truncated));
        assert_eq!(second.cursor.offset, head.len() as u64);
        assert_eq!(second.facts.lines, 2);
    }

    /// The sneaky one. The replacement is longer than the file it replaced, so nothing about
    /// the size says anything is wrong, and a cursor that trusted the size would resume into
    /// the middle of a line of a log it has never seen.
    #[test]
    fn notices_a_log_that_has_been_replaced_by_a_longer_one() {
        let temp = tempfile::tempdir().unwrap();
        let path = scratch("rotated-before.txt", temp.path());
        let first = reader(2024).read(&path, &Resume::default()).unwrap();
        assert_eq!(first.facts.fights.len(), 1);
        assert_eq!(first.facts.fights[0].name, "Gnarlroot");

        fs::copy(fixture("rotated-after.txt"), &path).unwrap();
        let after = fs::metadata(&path).unwrap().len();
        assert!(
            after > first.cursor.size,
            "the fixture is meant to be the longer one"
        );

        let second = reader(2024)
            .read(
                &path,
                &Resume {
                    cursor: Some(first.cursor),
                    ..Resume::default()
                },
            )
            .unwrap();

        assert_eq!(second.restarted, Some(Restarted::Replaced));
        assert_eq!(second.cursor.offset, after);
        assert_eq!(second.facts.fights.len(), 2);
        assert!(second
            .facts
            .fights
            .iter()
            .all(|fight| fight.name == "Fyrakk the Blazing"));
    }

    /// A log that was short when it was first read and long by the time it is read again is
    /// the same log. Hashing what is there and remembering how much was hashed is what keeps
    /// that from looking like a replacement.
    #[test]
    fn does_not_call_a_growing_log_a_replaced_one() {
        let temp = tempfile::tempdir().unwrap();
        let path = scratch("rotated-before.txt", temp.path());
        let first = reader(2024).read(&path, &Resume::default()).unwrap();
        assert!(
            first.cursor.head_bytes < HEAD_BYTES,
            "the fixture is meant to be smaller than one head"
        );

        let mut grown = fs::read_to_string(&path).unwrap();
        grown.push_str(&fs::read_to_string(fixture("rotated-after.txt")).unwrap());
        fs::write(&path, &grown).unwrap();

        let second = reader(2024)
            .read(
                &path,
                &Resume {
                    cursor: Some(first.cursor.clone()),
                    ..Resume::default()
                },
            )
            .unwrap();

        assert_eq!(second.restarted, None);
        assert_eq!(second.cursor.offset, grown.len() as u64);
        // Only what was appended, read once.
        assert_eq!(second.facts.fights.len(), 2);
    }

    /// A first pass over a season of logs is gigabytes. Doing it a chunk at a time on a beat
    /// that comes round every thirty seconds gets to the same place without a window that
    /// stops answering, and nothing is skipped or read twice on the way.
    #[test]
    fn stops_on_its_budget_and_carries_on_from_there() {
        let path = fixture("raid-night.txt");
        let whole = reader(2023).read(&path, &Resume::default()).unwrap();
        let mut reader = reader(2023);
        reader.budget = 1500;

        let mut resume = Resume::default();
        let mut positions = Vec::new();
        let mut fights = Vec::new();
        let mut passes = 0;
        loop {
            let reading = reader.read(&path, &resume).unwrap();
            positions.extend(reading.facts.positions.iter().cloned());
            fights.extend(reading.facts.fights.iter().cloned());
            passes += 1;
            let done = !reading.more;
            resume = Resume {
                cursor: Some(reading.cursor),
                map: reading.facts.maps.last().cloned().or(resume.map),
                sampled: reading
                    .facts
                    .positions
                    .last()
                    .map(|point| Sampled {
                        at: point.at,
                        ui_map_id: point.ui_map_id,
                    })
                    .or(resume.sampled),
            };
            if done {
                break;
            }
            assert!(passes < 50, "the budget never got to the end of the file");
        }

        assert!(passes > 1, "the budget was too large to split the file");
        assert_eq!(positions, whole.facts.positions);
        // Each fight is split across two passes at some budget, so the halves are compared
        // rather than the count: what matters is that no boundary was lost or doubled.
        assert_eq!(
            fights
                .iter()
                .filter(|fight| fight.ended_at.is_some())
                .count(),
            whole.facts.fights.len()
        );
    }

    /// Reading is not the same as being asked to; a path that is not there is an error rather
    /// than an empty answer, because the caller chose it and should hear that it was wrong.
    #[test]
    fn refuses_a_log_that_is_not_there() {
        let error = reader(2024)
            .read(Path::new("/no/such/WoWCombatLog.txt"), &Resume::default())
            .unwrap_err();

        assert!(
            error.contains("WoWCombatLog.txt"),
            "unhelpful error: {error}"
        );
    }

    /// Every fixture in the folder, read end to end. A file that stops the parser is a
    /// regression whatever it was checked in to demonstrate, and this is what notices one
    /// nobody wrote a named test for.
    #[test]
    fn reads_every_fixture_in_the_folder_without_failing() {
        let folder = fixture("raid-night.txt").parent().unwrap().to_path_buf();
        let mut read = 0;
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|kind| kind != "txt") {
                continue;
            }
            let reading = reader(2024)
                .read(&path, &Resume::default())
                .unwrap_or_else(|error| panic!("{} did not parse: {error}", path.display()));
            assert!(
                reading.facts.lines > 0,
                "{} produced no records at all",
                path.display()
            );
            // The invariant the next read's truncation check rests on. A cursor whose size is
            // behind its own offset says the file shrank, and the only file that would be
            // true of is one nobody wrote.
            assert!(
                reading.cursor.offset <= reading.cursor.size,
                "{} left a cursor pointing past the end of its own file",
                path.display()
            );
            read += 1;
        }
        assert!(
            read >= 8,
            "only {read} fixtures were found in {}",
            folder.display()
        );
    }
}
