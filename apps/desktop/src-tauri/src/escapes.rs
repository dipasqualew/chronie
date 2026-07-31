//! The client's own escape sequences, taken back out of a piece of text.
//!
//! A pipe opens every escape World of Warcraft has — a colour, a texture, an atlas, a
//! hyperlink — and text written in that grammar reaches this app from two unrelated
//! directions. A note somebody typed in the game arrives through the addon, and the game's own
//! tables are written in it too: `Mount.SourceText_lang` says where a mount comes from in the
//! same colour codes the tooltip draws it with.
//!
//! Neither of those has anything to do with the other, which is why the grammar lives here
//! rather than in whichever of them happened to need it first. [`crate::captures`] is where a
//! note is made safe to store and [`crate::mounts`] is where a source line is made readable;
//! both are readings of what this leaves behind.

/// The same text with every one of the client's escape sequences taken out of it.
///
/// A hyperlink keeps the part a person can read — `[Thunderfury]` out of the whole mechanism
/// — because that is what somebody pasting an item into a note meant by it. Everything else
/// goes, including a pipe somebody typed themselves, and including the opening half of a
/// sequence whose closing half never arrived.
pub fn without_escapes(raw: &str) -> String {
    let mut kept = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pipe) = rest.find('|') {
        kept.push_str(&rest[..pipe]);
        rest = &rest[pipe..];
        let after = &rest[1..];
        // Every sequence below is ASCII, so slicing on these byte offsets can only land on a
        // character boundary.
        rest = match after.as_bytes().first() {
            // `|Hitem:19019|h[Thunderfury]|h` — the link, then the words, then the end of it.
            Some(b'H') => match after[1..].find("|h").and_then(|opens| {
                let words = &after[1 + opens + 2..];
                words.find("|h").map(|closes| (words, closes))
            }) {
                Some((words, closes)) => {
                    kept.push_str(&words[..closes]);
                    &words[closes + 2..]
                }
                None => after,
            },
            // `|cffff0000`, a colour, and only when the eight digits it needs are there.
            Some(b'c') if is_hex(&after[1..], 8) => &after[9..],
            Some(b'T') => skip_to(after, "|t"),
            Some(b'A') => skip_to(after, "|a"),
            // `|r`, `|n`, and a pipe somebody typed: the pipe goes, what follows it stays.
            _ => after,
        };
    }
    kept.push_str(rest);
    kept
}

/// Everything up to and including the closing half of a sequence, or the opening half alone
/// when it never closes — in which case only its pipe has been dropped and the rest is text.
fn skip_to<'a>(after: &'a str, closer: &str) -> &'a str {
    match after.find(closer) {
        Some(at) => &after[at + closer.len()..],
        None => after,
    }
}

fn is_hex(text: &str, digits: usize) -> bool {
    text.len() >= digits && text.as_bytes()[..digits].iter().all(u8::is_ascii_hexdigit)
}
