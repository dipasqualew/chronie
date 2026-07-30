local _, ns = ...

---The kinds of thing `ns.newCensus` knows how to take a census of.
---
---Every domain in here is the same three seams — what to walk, what one position says, and how
---to check the answer cheaply — over the client's own calls and nothing else. Adding the next
---one is a function in this file and a line in `ns.censusDomains`; nothing in `Census.lua`
---changes, and nothing downstream of it does either.
---
---**Two rules hold across all of them, and both are about not touching what the player owns.**
---
---Nothing here changes a filter, expands a header or selects a category. `HoldingsSweep` walks
---the currency and reputation *panes* and documents the holes that leaves — a collapsed group,
---and every legacy reputation, which the pane hides by default — because the calls that would
---open them up rearrange a pane the player arranged. The domains here reach the same facts
---without a pane: `C_MountJournal.GetMountIDs` and `GetAchievementInfo` answer about ids, and
---an id has no idea what the player has the interface set to.
---
---And nothing here writes down what the account does *not* hold. The catalogue of everything
---that exists lives in the game's own tables, which the desktop already reads — `Achievement` is
---13,732 rows in `achievements.rs`, `ItemAppearance` is 55,198 in `wardrobe.rs`. A census that
---also recorded every absence would be several times the size and would say nothing the desktop
---could not work out by subtraction.

---Mounts: everything the account can summon.
---
---`GetMountIDs` hands over every mount in the game and `GetMountInfoByID` says of each whether
---this account has it, so a mount's position is simply its id. Both are indifferent to the
---journal's filters — the filtered pair is `GetNumDisplayedMounts`/`GetDisplayedMountID`, which
---is what Blizzard's own `MountJournal_UpdateMountList` draws the list from and what this
---deliberately is not.
---
---**No counter, on purpose.** `C_MountJournal.GetNumMounts` exists and would be the obvious one,
---but Blizzard's own journal calls it and then counts collected mounts by walking the ids anyway,
---which leaves its meaning genuinely ambiguous — and a counter whose meaning is guessed would
---provoke a pass every login or, worse, suppress one that was needed. It costs nothing to do
---without: the whole walk is about 1,900 calls, a fraction of a second at the census budget, so
---mounts are simply walked whenever anything else provokes a pass.
---@param journal table? The client's `C_MountJournal`.
---@return CensusDomain?
function ns.mountCensus(journal)
    -- Reached through the namespace at call time rather than captured at the top of the file.
    -- `chronie.toc` loads these alphabetically and nothing may depend on that order: `ns.callable`
    -- is defined in `FactionStanding.lua`, which the client reads after this one, so a file-scope
    -- `local callable = ns.callable` here captures nil.
    local ids = ns.callable(journal, "GetMountIDs")
    local info = ns.callable(journal, "GetMountInfoByID")
    if not ids or not info then
        return nil
    end

    return {
        name = "mounts",
        scope = "account",
        list = ids,
        ---@param id integer
        ---@return integer?, table?
        read = function(id)
            local name, spellID, _, _, _, sourceType, isFavorite,
                isFactionSpecific, faction, shouldHideOnChar, isCollected = info(id)
            if not isCollected then
                return nil, nil
            end
            return id, {
                name = name,
                spell = spellID,
                source = sourceType,
                -- Both are the player's own arrangement rather than facts about the mount, and
                -- both are worth keeping for exactly that reason: "hidden on this character" is
                -- how somebody says a mount is not really theirs to ride, and a list that
                -- ignored it would disagree with the journal they are looking at.
                favourite = isFavorite or nil,
                hidden = shouldHideOnChar or nil,
                -- Nil rather than false for a mount either side can ride, which is most of them:
                -- a key per mount saying "no" is a saved file spent saying nothing.
                faction = isFactionSpecific and faction or nil,
            }
        end,
    }
end

---Achievements: what the account has earned, and which character earned it.
---
---This is the domain that pays for the whole mechanism, because the client answers a question
---here that nothing else can be asked. `GetAchievementInfo` reports `completed` for the
---**account** and `wasEarnedByMe` for the character in front of it, and hands over `earnedBy` —
---the name of the alt that actually did it — beside them. So one character, in one pass, reports
---the entire account's achievement history *and* attributes each of them. Nothing has to be
---unioned across the roster and nothing waits for an alt to be logged in.
---
---**The walk is by category, because there is no id list.** `GetCategoryList` names the trees,
---`GetCategoryNumAchievements` says how deep each is, and `GetAchievementInfo(category, index)`
---returns the whole row — id included. So the plan is drawn with about eighty calls and then a
---position is one call rather than two, which is the difference between 13,700 reads and 27,400.
---
---`GetNumCompletedAchievements(guildView)` is the counter, and its meaning is settled rather than
---assumed: Blizzard's own `Blizzard_AchievementUI` reads it as `numAchievements, numCompleted`,
---so the second return is the account's completed total in a single call. That one comparison is
---what lets a thirteen-thousand-call pass be something that happens when it is needed instead of
---something that happens every day.
---@param clients table? `{ categories, categoryCount, byIndex, completedCount }`
---@return CensusDomain?
function ns.achievementCensus(clients)
    clients = clients or {}
    local categories = clients.categories
    local categoryCount = clients.categoryCount
    local byIndex = clients.byIndex
    if type(categories) ~= "function" or type(categoryCount) ~= "function"
        or type(byIndex) ~= "function" then
        return nil
    end

    -- The plan the positions index into. Two flat arrays rather than a table per position: a
    -- position is visited once and thirteen thousand two-key tables is a megabyte of garbage to
    -- hand the collector for no benefit.
    local planCategory, planIndex = {}, {}

    return {
        name = "achievements",
        scope = "account",
        ---@return integer[]?
        list = function()
            local trees = categories()
            if type(trees) ~= "table" then
                return nil
            end
            planCategory, planIndex = {}, {}
            local positions = {}
            for _, category in ipairs(trees) do
                -- The count is asked for once per tree and the offsets are then arithmetic. This
                -- is the whole of what `list` is allowed to cost: about eighty calls, and then
                -- filling two arrays, which touches nothing outside this addon.
                for index = 1, categoryCount(category) or 0 do
                    local at = #positions + 1
                    planCategory[at] = category
                    planIndex[at] = index
                    positions[at] = at
                end
            end
            return positions
        end,
        ---@param position integer
        ---@return integer?, table?
        read = function(position)
            local category, index = planCategory[position], planIndex[position]
            if not category then
                return nil, nil
            end
            local id, name, points, completed, month, day, year,
                _, _, _, _, isGuild, wasEarnedByMe, earnedBy = byIndex(category, index)
            -- A guild's achievements are the guild's, not the account's. They would come and go
            -- with which guild the walking character happens to be in, which is not a fact about
            -- this account at all.
            if not id or isGuild or not completed then
                return nil, nil
            end
            return id, {
                name = name,
                points = points,
                -- The day it was earned, as the client gives it: three numbers, no clock. Kept as
                -- three rather than resolved to an epoch here, because turning a local calendar
                -- date into an instant is a decision about time zones and the desktop is where
                -- the rest of those are already made.
                month = month,
                day = day,
                year = year,
                -- The two halves of the account/character split, and the only reason this domain
                -- can speak for characters it has never been logged into. `mine` is nil rather
                -- than false on an alt's achievement so that the common case — the walker earned
                -- it — is the one that costs a key.
                mine = wasEarnedByMe or nil,
                by = (not wasEarnedByMe) and earnedBy or nil,
            }
        end,
        ---@return integer?
        count = function()
            local counter = clients.completedCount
            if type(counter) ~= "function" then
                return nil
            end
            -- False rather than nothing: the argument is the guild view, and the account's own
            -- total is what this census is of.
            local _, completed = counter(false)
            return type(completed) == "number" and completed or nil
        end,
    }
end

---Every domain this client build can answer for, in the order they are walked.
---
---A domain whose calls this build does not have reports nil and is simply left out, which is the
---same answer `ns.readHoldings` gives for a pane the client will not open: a census that cannot
---be taken is not a census of nothing.
---@param clients table `{ mount = C_MountJournal, achievement = { ... } }`
---@return CensusDomain[]
function ns.censusDomains(clients)
    clients = clients or {}
    -- Cheapest first. A pass is interrupted by whatever ends the session, so the domain that
    -- finishes in a fifth of a second should not be queued behind the one that takes a minute.
    --
    -- A list of makers rather than of domains, so that a build missing one domain's calls leaves
    -- no hole for `ipairs` to stop at — which would silently drop every domain after it as well.
    -- The same trap `dressUpActor` is walked around in `Main.lua`, come at from the other side.
    local makers = {
        function()
            return ns.mountCensus(clients.mount)
        end,
        function()
            return ns.achievementCensus(clients.achievement)
        end,
    }
    local built = {}
    for _, make in ipairs(makers) do
        built[#built + 1] = make()
    end
    return built
end
