local _, ns = ...

---Which of Blizzard's own transmog sets a collected appearance belongs to, and how far into
---that set the account has got.
---
---This is the `TransmogSet` of `docs/transmog-sets.md` — the tier and vendor sets that are
---rows in a DB2 table and the same for everybody — and not the player's own custom sets,
---which `CustomSetSnapshot` files. A dropped shoulder is interesting on its own; a dropped
---shoulder that is the fifth of eight is a different piece of news, and the panel cannot say
---so without asking the client which set the source sits in.
---
---And which set the *look* sits in, which is not the same question. A set lists the exact
---item-modified-appearance rows it is made of, while a look is worn by every item that sells
---it — so the world drop wearing a tier shoulder's look is in no set the client will name over
---it, and that is the drop most worth saying something about. See `forSource`.
---
---Read live rather than filed with the event. What the tally records is what dropped, which
---does not change; how much of the set the account holds changes every time another piece of
---it is collected, including on another character an hour later. A count written into the
---segment would be a reading from the moment of the drop pretending to be current, so the
---question is asked again on every repaint. Three indexed lookups into data the client already
---has in memory for a piece a set names — which is what Blizzard's own wardrobe does per set
---per refresh — and two more plus one per other item wearing the look for a piece no set does.
---@class TransmogSetMembership
---@field setID integer The set the appearance sits in.
---@field name string? What the set is called, when the client will say.
---@field label string? The set's own qualifier — "Heroic", "Mythic" — when it has one.
---@field collected integer How many pieces of it the account holds.
---@field total integer How many pieces there are.
---@field sources integer[] Every piece's source id, in the client's own order, which is what
---the dressing room is handed to wear the set rather than the one piece that dropped.
---@field sharedLook boolean? True where the set does not name this very source and names
---another one wearing the same look. Absent rather than false in the ordinary case, so a row
---that carries the field is a row with something extra to say about itself.

---@class TransmogSets
---@field forSource fun(sourceID: integer?): TransmogSetMembership? Nil for an appearance that
---belongs to no set at all, which is most of them.

---@class TransmogSetsDeps
---@field setsContaining fun(sourceID: integer): integer[]? The client's
---`C_TransmogSets.GetSetsContainingSourceID`.
---@field setInfo fun(setID: integer): table? The client's `C_TransmogSets.GetSetInfo`, which
---may answer nothing at all for a set id it will not describe. Asked of each candidate in turn
---rather than only of the one that wins, because whether the client will name a set is what
---decides which of them wins in the first place.
---@field setPieces fun(setID: integer): { sourceID: integer, collected: boolean }[]? One entry
---per piece of the set, already reduced to the two things asked of it. Assembled by the caller
---rather than here because which of the client's several source lists that is, and how each
---one reports being collected, is a client question — see `Main.lua`.
---@field sharedSources fun(sourceID: integer): integer[]? Every source in the game wearing the
---same look as this one, the source itself included, in the client's own order. The client's
---`GetAllAppearanceSources` over the visual the source belongs to — see `Main.lua`.

---The first set containing this very source that the client will actually *name*.
---
---Rather than simply the first set it returns. A source can sit in several — the same shoulder
---is in a base set and in each of its variants — and the panel has room for one line about one
---of them, so the client's own order decides between the real candidates: it is deterministic,
---and picking "whichever is furthest along" instead would move the line under the player as
---they collected, which is worse than being arbitrary.
---
---The name is what separates a set from the table's own scaffolding. `TransmogSet` on 12.0.5
---carries 5143 rows, and 46 of them have no name in any locale: they are grouping rows the
---wardrobe never draws, and they sort *before* the real sets on every source that touches one.
---Taking the first id outright drew "Set 2 — 1/18" over Magister's Regalia, and drew a
---meaningless marker on 635 further sources whose only set is one of those rows. A set the
---player cannot be shown in the collections journal is not a set worth telling them about.
---@param deps TransmogSetsDeps
---@param sourceID integer
---@return integer? setID, table? info
local function namedSetContaining(deps, sourceID)
    for _, candidate in ipairs(deps.setsContaining(sourceID) or {}) do
        local described = deps.setInfo(candidate)
        if described and described.name and described.name ~= "" then
            return candidate, described
        end
    end
    return nil
end

---@param deps TransmogSetsDeps
---@return TransmogSets
function ns.newTransmogSets(deps)
    return {
        ---@param sourceID integer?
        ---@return TransmogSetMembership?
        forSource = function(sourceID)
            if not sourceID then
                return nil
            end
            local setID, info = namedSetContaining(deps, sourceID)
            -- And then the same question asked about every other item in the game wearing
            -- this look, because a set names *sources* and a look is worn by several of them.
            -- `GetSetsContainingSourceID` matches the exact item-modified-appearance row the
            -- set lists, so the tier shoulder that dropped answers and the world drop wearing
            -- the tier shoulder's look answers nothing — while the wardrobe files both under
            -- one appearance and credits the set for either. Chronie's desktop half reads the
            -- same relation out of the game's files from the other end, where it is what lets
            -- an item outside a set open one of the set's looks (`openings.rs`), and 87% of
            -- the items that do that belong to no set at all. Without this the panel is quiet
            -- about a drop precisely when the news is most interesting: this look is a tier
            -- set's, and the player just got it off something else.
            --
            -- Only where the source's own sets came to nothing, which is what keeps the cost
            -- where it belongs. A piece the set itself names is answered in the one lookup it
            -- always took; a piece belonging to no set at all — most of them — pays one extra
            -- client call for the list of sources, and one `GetSetsContainingSourceID` per
            -- other item wearing the look, which for nearly every appearance in the game is a
            -- handful.
            local sharedLook = false
            if not setID then
                for _, other in ipairs(deps.sharedSources(sourceID) or {}) do
                    -- The source itself is in that list and has already answered. Asking it
                    -- again is a lookup per row per repaint for an answer known to be nothing.
                    if other ~= sourceID then
                        setID, info = namedSetContaining(deps, other)
                        if setID then
                            sharedLook = true
                            break
                        end
                    end
                end
            end
            if not setID then
                return nil
            end
            local pieces = deps.setPieces(setID)
            if not pieces or #pieces == 0 then
                return nil
            end
            local collected = 0
            local sources = {}
            for _, piece in ipairs(pieces) do
                if piece.collected then
                    collected = collected + 1
                end
                if piece.sourceID then
                    sources[#sources + 1] = piece.sourceID
                end
            end
            return {
                setID = setID,
                name = info.name,
                label = info.label,
                collected = collected,
                total = #pieces,
                sources = sources,
                -- Absent rather than false for the ordinary reading, so that the field is
                -- only ever there to say something.
                sharedLook = sharedLook or nil,
            }
        end,
    }
end

---What a click on a transmog row is asking for.
---
---Four actions on one row, told apart by the button and by shift, and the whole of that
---decision lives here rather than in the panel: the panel's job is to notice a click and the
---question of what a click *means* is one a test can ask directly. Shift is the widening
---modifier throughout — the unshifted pair act on the piece that dropped, the shifted pair on
---the set it belongs to — which is the same relationship the client uses everywhere else it
---offers a narrow and a wide reading of the same row.
---
---Shift with no set falls back to the unshifted action rather than doing nothing. A player
---holding shift over a row that has no set has asked for something that does not exist, and
---the piece they clicked is the nearest true answer; a click that silently did nothing would
---read as the panel being broken.
---@param button string? Which mouse button, as the client reports it.
---@param shift boolean? Whether shift was down at the time.
---@param inSet boolean? Whether the row's appearance belongs to a set at all.
---@return string action One of "previewItem", "openItem", "previewSet", "openSet".
function ns.transmogClickAction(button, shift, inSet)
    local right = button == "RightButton"
    if shift and inSet then
        return right and "openSet" or "previewSet"
    end
    return right and "openItem" or "previewItem"
end

---What the panel says when the pointer rests on a row that belongs to a set.
---
---Pure and built here for the same reason `AccountTooltip` is: the panel knows how to draw a
---tooltip and nothing about what belongs in one. The two modifier lines are the only place
---the shifted actions are ever spelled out — a modifier nobody is told about is a feature
---nobody has — and they sit under a blank so they read as instructions rather than as more
---facts about the set.
---@param membership TransmogSetMembership?
---@return AccountTooltipContent?
function ns.transmogSetTooltip(membership)
    if not membership then
        return nil
    end
    local lines = {}
    if membership.label then
        lines[#lines + 1] = { left = membership.label, role = "note" }
    end
    -- Above the fraction, because it is what the fraction has to be read in the light of. The
    -- set is being named over an item the set does not list, and a player who knows the set —
    -- and knows this is not one of its pieces — is otherwise being told something that looks
    -- plainly wrong. One line turns that into the news it actually is.
    if membership.sharedLook then
        lines[#lines + 1] = { left = "The set wears this look on another item", role = "note" }
    end
    lines[#lines + 1] = {
        left = "Collected",
        right = membership.collected .. " / " .. membership.total,
        role = membership.collected >= membership.total and "total" or "you",
    }
    lines[#lines + 1] = { left = "", role = "blank" }
    lines[#lines + 1] = { left = "Shift-click to try on the whole set", role = "note" }
    lines[#lines + 1] = { left = "Shift-right-click to open it in Collections", role = "note" }
    return {
        title = membership.name or ("Set " .. membership.setID),
        lines = lines,
    }
end
