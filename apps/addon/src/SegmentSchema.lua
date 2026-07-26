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
ns.segmentEventSpecs = {
    transmogs       = { "id", "at", "sourceID", "appearanceID", "newAppearance" },
    currencies      = { "id", "name", "amount" },
    reputation      = { "faction", "amount" },
    achievements    = { "id", "name", "at", "accountFirst" },
    levelUps        = { "level", "at" },
    mounts          = { "id", "name", "at", "guid" },
    pets            = { "id", "name", "at", "guid" },
    toys            = { "id", "name", "at", "guid" },
    quests          = { "id", "at", "name", "characterFirst", "accountFirst" },
    housingItems    = { "id", "name", "at", "warbandFirst" },
    housingLevelUps = { "level", "at" },
}

---Deep-copies a list of event tables, keeping only the named keys and only where the
---source actually set them. The copy shares no table with the source, so a later mutation
---of the live tally can never reach back into a summary or a filed record.
---@param keys string[] The keys to carry across, from ns.segmentEventSpecs.
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
        copy[index] = out
    end
    return copy
end
