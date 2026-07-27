local _, ns = ...

---What somebody typed, made safe to write down.
---
---This is the first genuinely user-authored string in the pipeline, and the pipeline it
---enters was built for strings the game handed us. Between the box and SavedVariables it
---has to survive being written into a Lua file, parsed by a hand-written Rust reader, put
---in a SQLite row and drawn into a React tree — and one bad byte does not spoil one note,
---it spoils the whole file the note is in.
---
---So three rules, each for a different reader:
---
---* **A cap, honoured on a character boundary.** There is no natural bound on what
---  somebody will paste. Cutting at a byte count is the obvious way to impose one and the
---  wrong one: half of a multi-byte character is invalid UTF-8, and invalid UTF-8 fails the
---  entire sync rather than this row. The cut therefore walks back off a continuation byte.
---* **No control characters.** A newline out of a paste ends the string as far as anything
---  reading a line at a time is concerned. Whitespace of every kind becomes a single space.
---* **No `|` survives.** This is the deliberate decision the escape sequences deserve, and
---  it is made here rather than at each of the four places the text is read. `|` opens
---  every escape the client has: `|cffff0000` a colour, `|T...|t` a texture, `|Hitem:...|h`
---  a link. An unterminated one mangles the rest of whatever line it is drawn into, which
---  makes it worth removing on its own; but the reason to remove all of them is that
---  "stored note text never contains a pipe" is an invariant every reader downstream gets
---  for free, and "the readers each handle escapes correctly" is four chances to be wrong.
---
---  A hyperlink keeps the part a person can read — `[Thunderfury]` out of the whole
---  mechanism — because that is what somebody pasting an item into a note meant by it. The
---  link itself is lost. Making links first-class is a feature with a schema behind it
---  (which item, which player, resolved where), not a matter of letting the escape through.

---As many bytes as a note may occupy. Generous for a sentence about what just happened,
---small enough that a lifetime of entries stays a file the client can write at logout.
ns.ENTRY_TEXT_MAX_BYTES = 512

---A byte in the middle of a UTF-8 character: 10xxxxxx, and never the first byte of one.
---@param byte integer?
---@return boolean
local function isContinuation(byte)
    return byte ~= nil and byte >= 0x80 and byte < 0xC0
end

---Cleans one piece of typed text, or answers nil when nothing survives.
---
---Returning nil for the empty string is what lets every caller treat "they submitted
---nothing" and "they submitted spaces and a colour code" as the same thing, which is what
---they are: a note nobody wrote.
---@param raw string?
---@return string? text
function ns.entryText(raw)
    if type(raw) ~= "string" then
        return nil
    end

    -- Links first: a link arrives wrapped in the colour code of its item's quality, and
    -- taking the colour off first would leave the |h fragments to be swept up as debris.
    local text = raw:gsub("|H.-|h(.-)|h", "%1")
    text = text:gsub("|c%x%x%x%x%x%x%x%x", "")
    text = text:gsub("|T.-|t", "")
    text = text:gsub("|A.-|a", "")
    -- Whatever is left of the mechanism: |r, |n, and a pipe somebody typed themselves.
    text = text:gsub("|", "")

    text = text:gsub("%c", " ")
    text = text:gsub("%s+", " ")
    text = text:gsub("^%s+", "")
    text = text:gsub("%s+$", "")

    if #text > ns.ENTRY_TEXT_MAX_BYTES then
        local cut = ns.ENTRY_TEXT_MAX_BYTES
        -- Walk back while the byte the cut would orphan is a continuation of the character
        -- before it. Bounded by the cap, and by the string being valid to begin with.
        while cut > 0 and isContinuation(text:byte(cut + 1)) do
            cut = cut - 1
        end
        text = text:sub(1, cut)
        text = text:gsub("%s+$", "")
    end

    if text == "" then
        return nil
    end
    return text
end
