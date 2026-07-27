local _, ns = ...

---One line of a tooltip that opens over a row of the results panel.
---@class AccountTooltipLine
---@field left string
---@field right string? Absent for a spacer or a note, which take the whole width.
---@field role string "total", "you", "other", "note" or "blank" — what the panel colours it by.

---What the panel draws when the pointer rests on a row.
---@class AccountTooltipContent
---@field title string What the row names: a faction, a currency.
---@field lines AccountTooltipLine[]

---What the panel says when it is pointed at, which is the account's answer to the row's own
---question. The panel itself only ever reports the segment just played — the gain, not the
---balance, and this character, not the roster — because those are the two largest numbers it
---could put on a small frame and neither is news. Hovering is where the rest of it lives:
---the same figure widened out to every character the account has, which is a question worth
---asking about a currency and a faction and worth nothing at all until it is asked.
---
---Pure, and paired with `ResultsWindow` the way every frame here is paired with a module:
---the panel knows how to draw a tooltip and nothing about what belongs in one.

---Groups a count's digits in threes, because a reputation bar reads in five figures and an
---unbroken run of them is unreadable at this font size.
---
---Shared with the panel rather than kept there because the bar caption and the tooltip over
---it are two readings of the same number: `6,000 / 12,000` under the faction and
---`6,000 / 12,000` beside a character's name have to be the same string, or the tooltip reads
---as a different measurement rather than a wider view of the same one.
---@param value number?
---@return string
function ns.groupDigits(value)
    local rounded = math.floor(math.abs(value or 0) + 0.5)
    local digits = tostring(rounded):reverse():gsub("(%d%d%d)", "%1,"):gsub(",$", "")
    return ((value or 0) < 0 and "-" or "") .. digits:reverse()
end
local group = ns.groupDigits

---A standing as it reads on the right of a line: the level's name, then how far into it.
---
---Deliberately the bar's caption, character for character. A faction the client would name
---but not place has only the name; one it would place but not name has only the numbers; one
---it could say nothing at all about is the honest "unknown" rather than an empty column that
---would read as a missing line.
---@param row table One roster row: a stored holding, or the live reading for the character
---being played.
---@return string
local function progress(row)
    local text = row.standing or ""
    if (row.max or 0) > 0 then
        text = (text ~= "" and text .. "  " or "")
            .. group(row.current or 0) .. " / " .. group(row.max)
    end
    return text ~= "" and text or "unknown"
end

---The name a character goes by in a roster: its own, with the realm dropped.
---
---Dropped only while it stays unambiguous. Two alts of the same name on two realms are
---ordinary on a warband, and shortening both to "Alt" would put two rows in the list that
---cannot be told apart — so the moment a short name is claimed twice, every row goes back to
---the full "Name-Realm" rather than only the pair that collided, because a list where some
---rows carry a realm and others do not reads as a list of different kinds of thing.
---@param rows table[]
local function nameRows(rows)
    local taken = {}
    local collided = false
    for _, row in ipairs(rows) do
        local short = row.character:match("^([^-]+)") or row.character
        collided = collided or taken[short] == true
        taken[short] = true
        row.name = short
    end
    if collided then
        for _, row in ipairs(rows) do
            row.name = row.character
        end
    end
end

---How stale a row is, as it reads after the name. Empty for anything read in the last minute,
---which is the ordinary case for the character being played — and for a clock the caller did
---not supply, because "how long ago" is unanswerable without one.
---@param row table
---@param now integer?
---@return string
local function age(row, now)
    if not now or not row.at or row.at <= 0 then
        return ""
    end
    local since = ns.formatAge(now - row.at)
    return since == "now" and "" or (" · " .. since)
end

---The roster line for one character: who, how stale, and what they have.
---@param row table
---@param value string What goes in the right column.
---@param now integer?
---@return AccountTooltipLine
local function rosterLine(row, value, now)
    return {
        left = row.name .. age(row, now) .. (row.you and " (you)" or ""),
        right = value,
        role = row.you and "you" or "other",
    }
end

---Every character the store has a row for, with the one being played folded in from the live
---reading rather than from its own stored holding.
---
---That fold is the point. A holding is written at logout, so the stored row for the character
---in front of the client is as old as its last session — about the very currency or faction
---the panel is reporting a change to this minute. The client's own answer is a moment old, so
---it wins, and the row it replaces would be the same character counted twice if it were left
---in beside it.
---@param holdings table[]? The rollup's per-character rows.
---@param playing string? "Name-Realm" of whoever is playing.
---@param live table? Fields to overwrite that character's row with; nil to leave it stored.
---@param at integer? When `live` was read.
---@return table[] rows, table? mine
local function roster(holdings, playing, live, at)
    local rows, mine = {}, nil

    for _, held in ipairs(holdings or {}) do
        local row = {}
        for key, value in pairs(held) do
            row[key] = value
        end
        if playing and held.character == playing then
            mine = row
        end
        rows[#rows + 1] = row
    end

    if playing and live then
        if not mine then
            mine = { character = playing }
            rows[#rows + 1] = mine
        end
        for key, value in pairs(live) do
            mine[key] = value
        end
        mine.at = at
    end
    if mine then
        mine.you = true
    end

    return rows, mine
end

---Where every character on the account stands with one faction, as a tooltip.
---
---The question this answers is the one the panel's single "best" line only half answers: the
---line appears when somebody else is further along and says who, but says nothing at all when
---nobody is — so an empty space has to be read as "you are in front", which is
---indistinguishable from the panel not knowing. Hovering asks it outright, and gets the whole
---roster and which of them is furthest.
---
---The crown is worked out here rather than taken from `rollup.best`, which is computed over
---stored rows only: a character that overtook the account's best during this very session
---must not still be told somebody else is ahead.
---
---`rank` is what ranks them, never the standing's name, and only against the same ladder: see
---`ns.factionStanding`, which is where that rule comes from and why `system` travels with
---every rank. Rows off the ladder — a client build that could not reach the friendship API, a
---faction it would name but not place — keep their place in the list and are simply never
---crowned, sorted to the end where they read as "known, but not comparable".
---@param options table `{ faction, gain, rollup, character, now }` — the faction hovered, the
---gain the panel is drawing for it, the store's rollup for it, who is being played, and the
---clock that says how stale a stored row is.
---@return AccountTooltipContent? nil when nothing at all is known, so nothing is drawn.
function ns.standingTooltip(options)
    options = options or {}
    local faction = options.faction
    if type(faction) ~= "string" or faction == "" then
        return nil
    end

    local gain = options.gain or {}
    local live = (gain.standing or (gain.max or 0) > 0) and {
        standing = gain.standing,
        current = gain.current,
        max = gain.max,
        rank = gain.rank,
        system = gain.system,
    } or nil
    local rows, mine = roster(options.rollup and options.rollup.characters,
        options.character, live, options.now)

    if #rows == 0 then
        return nil
    end

    local ladder = (options.rollup and options.rollup.best and options.rollup.best.system)
        or gain.system
        or (mine and mine.system)
    ---@param row table
    ---@return boolean
    local function ranked(row)
        return row.rank ~= nil and row.system == ladder
    end

    table.sort(rows, function(left, right)
        if ranked(left) ~= ranked(right) then
            return ranked(left)
        end
        if ranked(left) and left.rank ~= right.rank then
            return left.rank > right.rank
        end
        if ranked(left) and (left.current or 0) ~= (right.current or 0) then
            return (left.current or 0) > (right.current or 0)
        end
        -- Ties break on name so that which row leads never depends on the order a Lua table
        -- happened to be walked in, the same rule the store breaks its own ties by.
        return left.character < right.character
    end)
    nameRows(rows)

    local lines = {}
    local leader = ranked(rows[1]) and rows[1] or nil
    if leader then
        lines[#lines + 1] = {
            left = "Best",
            right = progress(leader) .. " · " .. (leader.you and "you" or leader.name),
            role = "total",
        }
        if #rows > 1 then
            lines[#lines + 1] = { left = " ", role = "blank" }
        end
    end

    for _, row in ipairs(rows) do
        lines[#lines + 1] = rosterLine(row, progress(row), options.now)
    end

    if #rows == 1 and rows[1].you then
        -- Said outright rather than left to inference: an empty roster and a roster of one
        -- look the same on screen, and only one of them means "nobody else has met them".
        lines[#lines + 1] = { left = "No other character has been seen here.", role = "note" }
    end

    return { title = faction, lines = lines }
end

---What the whole account holds of one currency, as a tooltip.
---
---The panel deliberately reports only what the segment earned, because a balance is not news
---and the largest number on a small frame should not be the one that never changes. But
---"+250" is unanswerable on its own — whether it is worth walking back for depends entirely
---on what is already banked, and on whether this character's own row is the only one that
---counts. So the balance lives here, where it is asked for rather than always on screen.
---
---The total is recomputed rather than taken from `rollup.total`, for the same reason the
---crown is above: the rollup was summed over stored holdings, and the character being played
---has spent or earned since the one it wrote down. Adding the stored row to the live one
---counts that character twice.
---
---A warband-wide currency is not summed at all. The client answers every character with the
---account's one shared balance, so the per-character rows are a single number reported over
---and over — adding them multiplies the pot by the size of the roster, and listing them draws
---the same figure once per alt. The freshest reading is the whole answer, and the roster is
---left off entirely because there is nothing in it to tell apart.
---@param options table `{ name, gain, rollup, character, now }` — the currency hovered, the
---gain the panel is drawing for it, the store's rollup for it, who is being played, and the
---clock that says how stale a stored row is.
---@return AccountTooltipContent? nil when no character has ever reported holding any.
function ns.currencyTooltip(options)
    options = options or {}
    local gain = options.gain or {}
    local rollup = options.rollup
    local title = options.name or (rollup and rollup.name) or gain.name
    if type(title) ~= "string" or title == "" then
        return nil
    end

    local live = gain.total and { total = gain.total } or nil
    local rows, mine = roster(rollup and rollup.characters, options.character, live, options.now)

    if #rows == 0 then
        return nil
    end
    nameRows(rows)

    if rollup and rollup.accountWide then
        local freshest = mine
        for _, row in ipairs(rows) do
            if not freshest or (row.at or 0) > (freshest.at or 0)
                or ((row.at or 0) == (freshest.at or 0) and row.character < freshest.character) then
                freshest = row
            end
        end
        return {
            title = title,
            lines = {
                {
                    left = "Warband" .. age(freshest, options.now),
                    right = group(freshest.total),
                    role = "total",
                },
                { left = "One pot the whole account shares.", role = "note" },
            },
        }
    end

    local total = 0
    for _, row in ipairs(rows) do
        total = total + (row.total or 0)
    end

    table.sort(rows, function(left, right)
        if (left.total or 0) ~= (right.total or 0) then
            return (left.total or 0) > (right.total or 0)
        end
        return left.character < right.character
    end)

    local lines = { { left = "Account", right = group(total), role = "total" } }
    if #rows > 1 then
        lines[#lines + 1] = { left = " ", role = "blank" }
    end
    for _, row in ipairs(rows) do
        lines[#lines + 1] = rosterLine(row, group(row.total), options.now)
    end
    if #rows == 1 and rows[1].you then
        lines[#lines + 1] = { left = "No other character has been seen holding any.", role = "note" }
    end

    return { title = title, lines = lines }
end
