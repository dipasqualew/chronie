local _, ns = ...

---The shape of every list-valued field a segment carries, in one place. Both the tally
---(when it builds a summary) and the log (when it files a record) copy these lists out of
---live state into fresh tables, and every event type used to mean editing the copy logic
---in both. Declaring the keys once, here, means a new event type is a single line rather
---than two parallel hand-written copies that can silently drift apart.
---
---Each entry lists exactly the keys that survive a copy. Keys absent from an event are
---left absent in the copy — never invented — so an optional flag like `accountFirst` only
---appears when the source actually carried it. Listing the keys explicitly (rather than a
---blind shallow copy) also stops internal bookkeeping fields from leaking into a record.
---
---A named key holding a spec of its own — `items = { ... }` — is a list of tables nested
---inside the event, copied by the same rules one level down. Only equipment set changes
---need it today, and they genuinely do: what changed about a set is a list of slots, and
---flattening it into the parent would lose which slot went with which item.
ns.segmentEventSpecs = {
    transmogs       = { "id", "at", "sourceID", "appearanceID", "newAppearance" },
    currencies      = { "id", "name", "amount", "total" },
    reputation      = { "faction", "amount", "standing", "current", "max", "rank", "system" },
    achievements    = { "id", "name", "at", "accountFirst" },
    levelUps        = { "level", "at" },
    mounts          = { "id", "name", "at", "guid" },
    pets            = { "id", "name", "at", "guid" },
    toys            = { "id", "name", "at", "guid" },
    quests          = { "id", "at", "name", "characterFirst", "accountFirst" },
    housingItems    = { "id", "name", "at", "warbandFirst" },
    housingLevelUps = { "level", "at" },
    encounters      = { "id", "name", "at", "difficultyId", "groupSize", "success" },
    equipsetChanges = {
        "setId", "name", "kind", "at",
        items = { "slot", "itemId", "itemLevel", "itemName" },
    },
}

---The single-valued tables a segment carries: at most one per segment, so they are copied
---whole rather than as a list. Same rule as an event list — only the named keys survive,
---and a key the source never set stays absent instead of arriving as a fabricated zero.
ns.segmentDetailSpecs = {
    keystone   = {
        "level", "mapId", "affixes", "startedAt", "completedAt",
        "completed", "durationMs", "onTime", "upgrades",
    },
    experience = { "gained", "percent", "startLevel", "endLevel" },
}

---Copies one detail table, keeping only the named keys. Returns nil for a nil source, so
---an absent detail stays absent in the record rather than becoming an empty table that a
---reader downstream would have to tell apart from a real one.
---@param keys string[] The keys to carry across, from ns.segmentDetailSpecs.
---@param detail table? The source table; nil is passed straight through.
---@return table?
function ns.copyDetail(keys, detail)
    if detail == nil then
        return nil
    end
    local copy = {}
    for _, key in ipairs(keys) do
        local value = detail[key]
        if type(value) == "table" then
            -- Only ever a flat list of numbers today (keystone affixes), so a shallow
            -- element copy is enough to stop the record aliasing the live tally.
            local list = {}
            for index, entry in ipairs(value) do
                list[index] = entry
            end
            copy[key] = list
        elseif value ~= nil then
            copy[key] = value
        end
    end
    return copy
end

---Deep-copies a list of event tables, keeping only the named keys and only where the
---source actually set them. The copy shares no table with the source, so a later mutation
---of the live tally can never reach back into a summary or a filed record.
---
---A spec's named keys — the `items = { ... }` form — describe a list of tables nested in
---each event, and recur through this same function. A nested list the source never set
---stays absent rather than arriving as an empty list, on the same rule as every other key.
---@param keys table The keys to carry across, from ns.segmentEventSpecs.
---@param events table[]? The source list; nil is treated as empty.
---@return table[]
function ns.copyEventList(keys, events)
    local copy = {}
    for index, event in ipairs(events or {}) do
        local out = {}
        for _, key in ipairs(keys) do
            if event[key] ~= nil then
                out[key] = event[key]
            end
        end
        for key, nested in pairs(keys) do
            if type(key) == "string" and event[key] ~= nil then
                out[key] = ns.copyEventList(nested, event[key])
            end
        end
        copy[index] = out
    end
    return copy
end
