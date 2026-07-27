local _, ns = ...

---One thing the player thought was worth remembering. Today that is a screenshot; the
---same record with the picture left out and some text added is a note, which is why this
---is not called a screenshot log and does not live in `db.captures`. Flat and JSON-shaped
---like a segment record, because the desktop app's reader takes it verbatim.
---
---Entries sit in a top-level store rather than inside the segment they were taken in.
---`db.segments` is pruned to a rolling week, and a photograph that vanished after seven
---days because the segment around it aged out is a bug nobody wants to explain. The entry
---carries the segment's identity as a link instead, built through `ns.segmentId` so it is
---always exactly the string the log files that segment under.
---@class EntryRecord
---@field id string Unique across accounts, not merely within one. Entries are meant to be
---shareable, and two players whose ids collide is not something a later release can fix.
---@field schema integer Shape version, so a reader can tell an old row from a new one.
---@field at integer Epoch second. What ordering and retention are done on.
---@field stamp string The same moment in local time, formatted "MMDDYY_HHMMSS". Both
---clocks are stored deliberately: the client names its screenshot files
---`WoWScrnShot_MMDDYY_HHMMSS` in local time, so this is the half that pairs an entry with
---its image, and the epoch is the half that survives a daylight-saving change.
---@field character string "Name-Realm" of who was playing.
---@field author string The account that made it — see ns.newAccountIdentity.
---@field segment string? Link to the segment that was open, absent when none was.
---@field uiMapID integer? The map the character was on, when the client named one.
---@field x number? Normalised position across that map, 0..1.
---@field y number?
---@field hasImage boolean? True when a screenshot was fired for this entry, absent when
---nothing was. The addon cannot see the filesystem, so this is a statement about what was
---asked for, never about what landed on disk.
---@field note string? What the player said about it, when they said anything. Absent
---rather than empty on the overwhelming majority of entries, which carry no note at all.
---The only user-authored string in the record: see ns.entryText for what it is allowed to
---contain and why the rules are as strict as they are.
---@field trigger string? The rule that fired this capture by itself, absent when a person
---pressed the key. Its presence is what tells the two apart downstream.
---@field achievement integer? The achievement this entry is filed against, when that is
---what it was taken for. A field of its own per subject kind rather than a kind/id pair:
---there will only ever be a handful of kinds, and downstream this resolves to a real
---foreign key with the referential integrity a polymorphic column cannot have.

---What the caller wants recorded.
---@class EntryOptions
---@field hasImage boolean? Whether a screenshot is being taken alongside this entry.
---@field trigger string? The rule that asked for it, for an automatic capture.
---@field achievement integer? The achievement it is filed against, if any.

---The permanent store of entries. Nothing here prunes: that is the whole reason entries
---are not kept inside the segments they belong to.
---@class EntryLog
---@field record fun(options: EntryOptions?): EntryRecord? The entry written, or nil when it
---was refused — see the cooldown below.
---@field annotate fun(entry: EntryRecord, text: string): EntryRecord Attaches a note to an
---entry already written.
---@field discard fun(entry: EntryRecord): boolean Unwrites an entry that turned out to hold
---nothing. True when the row was there to remove.

---@class EntryLogDeps
---@field db table SavedVariables table; mutated in place so the client persists it.
---@field now fun(): integer
---@field formatDate fun(format: string, timestamp: integer): string Usually the global `date`.
---@field character fun(): string "Name-Realm" of the character making the entry.
---@field author fun(): string? The account making it.
---@field mapState fun(): MapPosition? Where the character is standing, if the client says.
---@field openSegment fun(): table? The tracker's open segment descriptor, or nil.
---@field cooldownSeconds integer? Seconds between two entries carrying an image. Default 1.

---How the desktop app will read the shape of a row it did not write.
local SCHEMA = 1

---The client's screenshot filenames resolve to the second and no finer, so two images a
---second apart are already the closest pair that can still be told from one another.
local DEFAULT_COOLDOWN = 1

---Local time in exactly the shape the client names a screenshot file.
local STAMP_FORMAT = "%m%d%y_%H%M%S"

---@param deps EntryLogDeps
---@return EntryLog
function ns.newEntryLog(deps)
    local db = deps.db
    local now = deps.now
    local cooldown = deps.cooldownSeconds or DEFAULT_COOLDOWN

    db.entries = db.entries or {}

    ---When an entry carrying an image was last written. Session-local, because the only
    ---way two entries land in one second across a reload is a clock that went backwards.
    ---@type integer?
    local lastImageAt

    ---A counter rather than a timestamp, because it is what makes the id unique no matter
    ---what the clock does. Persisted alongside the entries so it keeps climbing across
    ---sessions even if every entry it once numbered has since been deleted.
    ---@param author string
    ---@param at integer
    ---@return string
    local function nextId(author, at)
        db.entryCounter = (db.entryCounter or 0) + 1
        return table.concat({ author, tostring(at), tostring(db.entryCounter) }, "|")
    end

    return {
        ---Writes one entry, stamped with everything Chronie knew at this moment.
        ---
        ---Refuses, returning nil, in two cases. An entry with an image taken within the
        ---cooldown of the last one would produce two markers the desktop side could not
        ---tell apart, since it has only the filename's second to go on — better to drop
        ---the second press than to file a marker that resolves to the wrong picture. And
        ---an entry cannot be authored before the client will say who the player is, which
        ---in practice means before the world has finished loading.
        ---@param options EntryOptions?
        ---@return EntryRecord?
        record = function(options)
            options = options or {}
            local at = now()
            local hasImage = options.hasImage and true or false

            -- Only a clock that has moved forward, and not far enough. A clock that jumped
            -- backwards — a resync mid-session — must not lock the binding out for however
            -- long it went back by; the ids stay unique through it either way.
            if hasImage and lastImageAt and at >= lastImageAt and at - lastImageAt < cooldown then
                return nil
            end

            local author = deps.author()
            if not author then
                return nil
            end

            local entry = {
                id = nextId(author, at),
                schema = SCHEMA,
                at = at,
                stamp = deps.formatDate(STAMP_FORMAT, at),
                character = deps.character(),
                author = author,
            }

            local segment = deps.openSegment and deps.openSegment() or nil
            if segment then
                entry.segment = ns.segmentId(segment.character, segment.startedAt, segment.instance)
            end

            local position = deps.mapState and deps.mapState() or nil
            if position and position.uiMapID then
                entry.uiMapID = position.uiMapID
                -- The map is recorded on its own where the client refuses the point,
                -- which is most of instanced content. Never a fabricated 0, 0.
                if position.x and position.y then
                    entry.x = position.x
                    entry.y = position.y
                end
            end

            if hasImage then
                entry.hasImage = true
                lastImageAt = at
            end

            -- Absent rather than false or zero when nothing fired this by itself: a reader
            -- downstream tells a pressed capture from an automatic one by whether there is
            -- a trigger at all, and the subject only means anything beside one.
            if options.trigger then
                entry.trigger = options.trigger
                entry.achievement = options.achievement
            end

            db.entries[#db.entries + 1] = entry
            return entry
        end,

        ---Attaches a note to an entry this log already wrote.
        ---
        ---A note arrives after the record it belongs to, always: the picture is taken the
        ---instant the key goes down and the sentence about it is typed seconds later. The
        ---row is mutated in place rather than rewritten, which is all it takes — the table
        ---handed back by `record` is the one sitting in `db.entries`, and the client writes
        ---whatever it holds at logout.
        ---
        ---The text is expected to have been through `ns.entryText` already. Doing it here
        ---as well would put the cap and the escape rules in two places at once, and the
        ---place it belongs is the one that can tell the player their note was empty.
        ---@param entry EntryRecord
        ---@param text string
        ---@return EntryRecord
        annotate = function(entry, text)
            entry.note = text
            return entry
        end,

        ---Takes back an entry this log wrote.
        ---
        ---There is exactly one thing this is for. A memory — an entry with no picture — is
        ---its text and nothing else, so one written by somebody who then said nothing is a
        ---record of nothing, and the right amount of it to keep is none. A photograph is the
        ---opposite: worth keeping whether or not anybody found the words, which is why this
        ---is a deliberate call by whoever knows which of the two it was, rather than a rule
        ---the log applies to every noteless entry it holds.
        ---
        ---Searched from the end, because the entry being taken back was written moments ago
        ---and is almost always the last row in the table.
        ---
        ---`db.entryCounter` is deliberately not wound back. It exists to make ids unique
        ---rather than to count what survives, and an id that has once been handed out must
        ---never be handed out again — a shared memory pack somebody else is holding may
        ---already name it.
        ---@param entry EntryRecord
        ---@return boolean
        discard = function(entry)
            for index = #db.entries, 1, -1 do
                if db.entries[index] == entry then
                    table.remove(db.entries, index)
                    return true
                end
            end
            return false
        end,
    }
end
