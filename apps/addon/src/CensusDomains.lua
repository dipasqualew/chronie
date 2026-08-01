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
---without a pane: `C_MountJournal.GetMountIDs`, `GetAchievementInfo`,
---`C_CurrencyInfo.GetCurrencyInfo` and `C_Reputation.GetFactionDataByID` all answer about ids,
---and an id has no idea what the player has the interface set to. `ns.currencyCensus` and
---`ns.reputationCensus` are that difference at its plainest — the same currencies the sweep next
---door can only see when the player has the group open, and the legacy factions it cannot see at
---all.
---
---And nothing here writes down what the account does *not* hold. The catalogue of everything
---that exists lives in the game's own tables, which the desktop already reads — `Achievement` is
---13,732 rows in `achievements.rs`, `ItemAppearance` is 55,198 in `wardrobe.rs`. A census that
---also recorded every absence would be several times the size and would say nothing the desktop
---could not work out by subtraction.

---A count worth writing down, or nothing.
---
---Nought is the client's answer for "no cap", "nothing earned yet" and "no weekly" alike, and a
---census writes a key per id per character — so a nought written down is a saved file spent
---saying what its absence already said. Every reader of these defaults them back to nought.
---@param value any
---@return integer?
local function nonzero(value)
    if type(value) ~= "number" or value == 0 then
        return nil
    end
    return value
end

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

---Pets: every battle pet the account owns, counted by species.
---
---**The one collectible the game lets somebody own several of**, which is why this is the only
---domain whose entry carries a count. `GetOwnedPetIDs` hands over one GUID per *pet* and a
---collection is counted in *species* — three Mechanical Squirrels are one line of the pet journal
---and three positions of this walk — so the id an entry is filed under is the species and the
---pets of it are folded together as the walk meets them.
---
---`C_PetJournal.GetNumCollectedInfo(speciesID)` is where the count comes from rather than a tally
---of what the walk has seen, and the difference shows in exactly the case this whole design is
---built around: a pass a logout cuts short still says how many of a species the account has,
---instead of how many of them it got as far as. It is also the number `Main.lua` already asks for
---in the `NEW_PET_ADDED` handler, so the two halves of the record agree by construction.
---
---**The GUIDs are the account's own pets rather than the journal's list**, which is the same
---distinction `ns.mountCensus` makes: the filtered pair here is
---`GetNumPets`/`GetPetInfoByIndex` — what Blizzard's own `PetJournal_UpdatePetList` draws from,
---with `SetSearchFilter` beside it — and `GetOwnedPetIDs` takes no filter and answers about what
---is owned.
---
---`GetPetInfoTableByPetID` rather than the seventeen-return `GetPetInfoByPetID`, because it is the
---one of the pair the client's own `PetJournalInfo` documentation describes: named fields cannot
---be read off by one position the way a positional list silently can.
---
---**No counter, and the free one is a trap.** `#GetOwnedPetIDs()` costs nothing and counts *pets*,
---while `held` counts *species* — so on any account that owns two of anything the counter would
---sit permanently above what is written down and provoke a full pass at every login, forever. A
---counter that is counting a different set from the one stored is worse than none, which is the
---reason `ns.mountCensus` does without one too.
---@param journal table? The client's `C_PetJournal`.
---@return CensusDomain?
function ns.petCensus(journal)
    local owned = ns.callable(journal, "GetOwnedPetIDs")
    local info = ns.callable(journal, "GetPetInfoTableByPetID")
    local countOf = ns.callable(journal, "GetNumCollectedInfo")
    if not owned or not info or not countOf then
        return nil
    end

    -- One entry per species, kept for as long as the pass lasts and handed back again by every
    -- later pet of the same species. The census writes `entries[id] = held` on each read, so a
    -- species met three times is written three times — the same table each time, which is what
    -- lets the third pet's level land in the row the first pet created.
    local held = {}

    return {
        name = "pets",
        scope = "account",
        ---@return string[]?
        list = function()
            local guids = owned()
            if type(guids) ~= "table" then
                return nil
            end
            held = {}
            return guids
        end,
        ---@param guid string
        ---@return integer?, table?
        read = function(guid)
            local pet = info(guid)
            if type(pet) ~= "table" or type(pet.speciesID) ~= "number" then
                return nil, nil
            end
            local species = pet.speciesID
            local entry = held[species]
            if not entry then
                local counted = countOf(species)
                entry = {
                    name = pet.name,
                    -- The client's own count of the species, asked once per species rather than
                    -- once per pet.
                    count = type(counted) == "number" and counted or nil,
                }
                held[species] = entry
            end
            -- The best of them, which is the one somebody would actually summon. A species is the
            -- unit here, so a level and a nickname have to be *some* pet's — and the highest is
            -- the only choice that does not depend on what order the client happened to hand the
            -- GUIDs over in.
            local level = type(pet.petLevel) == "number" and pet.petLevel or nil
            if level and level > (entry.level or 0) then
                entry.level = level
                -- Nil for a pet nobody renamed, which is most of them: a key per species saying
                -- "no name" is a saved file spent saying nothing.
                entry.custom = pet.customName
            end
            -- The player's own arrangement rather than a fact about the species, kept for the
            -- reason a mount's favourite is — and true if any one of them is, because that is
            -- what the journal draws a star on.
            entry.favourite = entry.favourite or pet.isFavorite or nil
            return species, entry
        end,
    }
end

---Toys: what the account can pull out of the toy box.
---
---**Partial, and for a reason that could not be settled from the install.** `GetNumToys` is the
---unfiltered total and `GetNumFilteredToys` its filtered twin, but there is only one indexer —
---`GetToyFromIndex(itemIndex)` — and Blizzard's own `blizzard_toybox.lua` on 12.0.5.67823 pairs it
---with the *filtered* count in both places it uses it, `ToySpellButton_UpdateButton` and
---`ToyBox_FindPageForToyID`. So the list this walks is very probably the one the player's own
---filters left standing, and a walk of it can never claim to have seen every toy.
---
---That claim is the only thing at stake, because everything else here is filter-proof: the walk
---never sets a filter, `PlayerHasToy(itemID)` answers about an id whatever the toy box is showing,
---and a reading that never claims completeness can never delete anything. Being wrong the other
---way — calling it complete and pruning — would empty the record of every toy the player had
---filtered out of view. Toys are a grow-only collection, so what `partial` costs is nothing at
---all, and lifting it later is one line: **what would settle it** is a running client with a
---restrictive filter set in the toy box, comparing `C_ToyBox.GetNumToys()` and
---`C_ToyBox.GetNumFilteredToys()` against what `GetToyFromIndex` walks out.
---
---The bound is still the unfiltered total. It is the larger of the two, so nothing the player has
---left visible falls outside it, and a position past the end of the list costs one call that
---answers `-1` — which is what Blizzard's own button code checks for.
---
---**No counter.** `GetNumLearnedDisplayedToys` is the obvious one and is filter-dependent by its
---own name, which makes it exactly the kind of counter `docs/account-census.md` argues is worse
---than none: it would fall below `held` the moment somebody narrowed the pane. A partial domain is
---never settled by an audit in any case — it is walked once a session, which is what unions the
---player's various filterings together over time.
---@param clients table? `{ box = C_ToyBox, hasToy = PlayerHasToy }`
---@return CensusDomain?
function ns.toyCensus(clients)
    clients = clients or {}
    local box = clients.box
    local total = ns.callable(box, "GetNumToys")
    local fromIndex = ns.callable(box, "GetToyFromIndex")
    local info = ns.callable(box, "GetToyInfo")
    -- A bare global rather than a member of the namespace, which is genuinely what the client
    -- offers: `PlayerHasToy` was never moved into `C_ToyBox`.
    local hasToy = type(clients.hasToy) == "function" and clients.hasToy or nil
    if not total or not fromIndex or not info or not hasToy then
        return nil
    end

    return {
        name = "toys",
        scope = "account",
        partial = true,
        ---@return integer[]
        list = function()
            local positions = {}
            for index = 1, total() or 0 do
                positions[index] = index
            end
            return positions
        end,
        ---@param index integer
        ---@return integer?, table?
        read = function(index)
            local itemID = fromIndex(index)
            -- `-1` is the client's answer for a position past the end of the list, which is what
            -- Blizzard's own toy button checks for before drawing itself.
            if type(itemID) ~= "number" or itemID <= 0 or not hasToy(itemID) then
                return nil, nil
            end
            local _, name, _, isFavorite = info(itemID)
            return itemID, {
                name = name,
                favourite = isFavorite or nil,
            }
        end,
    }
end

---Heirlooms: what the account has bought once and every character after can wear.
---
---`GetHeirloomItemIDs` is the only enumerator in `C_Heirloom` that does not say "Displayed" in its
---name — the pane's pair is `GetNumDisplayedHeirlooms`/`GetHeirloomItemIDFromDisplayedIndex`,
---which is what Blizzard's own `HeirloomsMixin:SortHeirloomsIntoEquipmentBuckets` draws its list
---from, with a class filter, a spec filter and a search box in front of it.
---
---**Partial all the same, for the reason `ns.toyCensus` is.** Nothing in Blizzard's own interface
---calls `GetHeirloomItemIDs`, so nothing in the install says whether it answers past the pane's
---filters; the naming is the whole of the evidence, and the toy box next door is a live
---counter-example to naming as evidence — `GetToyFromIndex` says neither "filtered" nor
---"displayed" and is used against the filtered count. Heirlooms are a grow-only collection, so
---refusing to prune costs nothing, while pruning on a filtered list would take out every heirloom
---the player had narrowed out of view. **What would settle it** is a running client with a class
---filter set in the heirloom pane: `#C_Heirloom.GetHeirloomItemIDs()` against
---`C_Heirloom.GetNumHeirlooms()` and `C_Heirloom.GetNumDisplayedHeirlooms()`.
---
---`GetNumKnownHeirlooms` rides along as the counter even so. It settles nothing — a partial domain
---is never audited — but it is the client's own opinion of how many the account has, and beside
---`held` it is what says how much of the answer a walk managed to reach, which is exactly the pair
---`ns.appearanceCensus` keeps.
---@param heirloom table? The client's `C_Heirloom`.
---@return CensusDomain?
function ns.heirloomCensus(heirloom)
    local ids = ns.callable(heirloom, "GetHeirloomItemIDs")
    local info = ns.callable(heirloom, "GetHeirloomInfo")
    local has = ns.callable(heirloom, "PlayerHasHeirloom")
    if not ids or not info or not has then
        return nil
    end
    -- Not required for the domain to exist: an heirloom with no known ceiling is still an
    -- heirloom the account owns, and this is the only field of the row that costs a second call.
    local ceiling = ns.callable(heirloom, "GetHeirloomMaxUpgradeLevel")

    return {
        name = "heirlooms",
        scope = "account",
        partial = true,
        ---@return integer[]?
        list = function()
            local items = ids()
            return type(items) == "table" and items or nil
        end,
        ---@param itemID integer
        ---@return integer?, table?
        read = function(itemID)
            if type(itemID) ~= "number" or not has(itemID) then
                return nil, nil
            end
            local name, slot, _, _, upgradeLevel, source = info(itemID)
            if not name then
                return nil, nil
            end
            return itemID, {
                name = name,
                -- `INVTYPE_HEAD` and the rest, which is the one thing about an heirloom a machine
                -- with no install can group the list by.
                slot = slot,
                -- How far it has been taken and how far it goes, which is the heirloom's version
                -- of a currency's cap: "is this one finished with" is a question no amount of
                -- watching somebody buy an upgrade would answer for the ones bought years ago.
                upgrade = nonzero(upgradeLevel),
                maxUpgrade = ceiling and nonzero(ceiling(itemID)) or nil,
                source = source,
            }
        end,
        ---@return integer?
        count = function()
            local counter = ns.callable(heirloom, "GetNumKnownHeirlooms")
            local known = counter and counter() or nil
            return type(known) == "number" and known or nil
        end,
    }
end

---Titles: what this character may put before or after their name.
---
---**Character-scoped, and the plainest case of it in the file.** A title is earned by whoever
---earned it — two alts of one account share almost none of them — so the wallet's rule applies
---exactly: kept per `Name-Realm`, and a complete walk prunes that character's rows and nobody
---else's.
---
---There is no pane and no filter anywhere near this one. `GetNumTitles()` is the top of the title
---mask range rather than a count of anything held, `IsTitleKnown(i)` answers for a mask id, and
---most of the range is not a title this character has. It is the whole of what Blizzard's own
---`PaperDollTitlesPane_Update` walks, and this walks it the same way — including the
---`playerTitle` return, which is what that pane requires before it will draw a row: a mask the
---client knows but does not call a player title is not a title anybody can wear, and a list
---carrying one would disagree with the pane the player is looking at.
---
---**The name is stored trimmed, and which side it goes on is stored beside it.** The client hands
---these over already spaced for the player's name — `"Sergeant "` before it, `" the Explorer"`
---after — and `TitleUtil.GetNameFromTitleMaskID` trims for display, which is what a reader wants.
---Trimming alone would throw away the one thing the spacing said, so the side is kept as a flag
---rather than as a space nothing downstream would think to preserve.
---
---**No counter.** Nothing in the client counts known titles: `GetNumTitles` is the size of the
---range and would sit permanently above `held` by an order of magnitude, which would provoke a
---pass at every login and change nothing each time.
---@param clients table? `{ count = GetNumTitles, known = IsTitleKnown, name = GetTitleName }`
---@return CensusDomain?
function ns.titleCensus(clients)
    clients = clients or {}
    local count = clients.count
    local known = clients.known
    local nameOf = clients.name
    if type(count) ~= "function" or type(known) ~= "function" or type(nameOf) ~= "function" then
        return nil
    end

    return {
        name = "titles",
        scope = "character",
        ---@return integer[]
        list = function()
            local ids = {}
            for id = 1, count() or 0 do
                ids[id] = id
            end
            return ids
        end,
        ---@param id integer
        ---@return integer?, table?
        read = function(id)
            if not known(id) then
                return nil, nil
            end
            local titleString, playerTitle = nameOf(id)
            if type(titleString) ~= "string" or not playerTitle then
                return nil, nil
            end
            local name = titleString:gsub("^%s*(.-)%s*$", "%1")
            if name == "" then
                return nil, nil
            end
            return id, {
                name = name,
                -- Where the client put the space: after the name for "the Explorer", before it
                -- for "Sergeant". Written only for the ones that follow, which keeps the common
                -- case free of a key.
                suffix = titleString:match("^%s") ~= nil or nil,
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

---The highest currency id the walk asks about.
---
---`C_CurrencyInfo` has no enumerator. There is no `GetCurrencyIDs` and no counter, and the one
---call that hands over a list of ids — `GetPlayerCurrencyCategoryInfo` — is keyed by a category
---id that is itself only in the game's own tables. So the positions are a range, and a range needs
---an end.
---
---`CurrencyTypes` on build 12.0.5.67823 is 1,490 rows running from 42 to 3513, read out of the
---install with `Db2::parse` the way `currencies.rs` reads it for icons. Five thousand is that top
---id and half again, which is the headroom a patch's worth of new currencies has to fit into: an
---id above this is invisible to the walk, and a walk that cannot see it will still say it is
---complete. That is the one hole left here, it is bounded, and raising the number is free —
---5,000 reads is twenty-five slices, a fraction of a second, against the achievement walk's minute.
local LAST_CURRENCY_ID = 5000

---Currencies: what this character is holding of each, and how much more it may hold.
---
---**Character-scoped, and the first domain that is.** Every other domain here answers the same on
---any character, which is why they are kept once; a wallet is the opposite, and two alts with a
---wallet each must not read as one alt whose wallet keeps being replaced.
---
---This is the domain that removes a trade rather than making one. `ns.readHoldings` walks the
---currency *pane*, and a currency under a collapsed group is invisible to it — the call that would
---open the group up, `C_CurrencyInfo.ExpandCurrencyList`, rearranges something the player
---arranged, and doing that from a logout handler where nothing can be put back was the worse of
---two bad options. `GetCurrencyInfo(id)` takes an arbitrary id and answers about it completely, so
---there is no pane, no expansion, no filter, and nothing of the player's touched.
---
---It also carries what the pane row does not. `maxQuantity` and `maxWeeklyQuantity` beside
---`totalEarned` and `quantityEarnedThisWeek` are what make "am I capped" and "have I done my
---weekly" answerable at all, which no amount of watching a balance change ever could.
---
---**No counter.** Nothing in `C_CurrencyInfo` counts what is held — `GetCurrencyListSize` counts
---the rows the pane is drawing, which is the very number this domain exists not to trust. So this
---one is never distrusted into a pass of its own and is walked when something else provokes one,
---which is what `ns.newCensus` already does for mounts.
---@param currency table? The client's `C_CurrencyInfo`.
---@return CensusDomain?
function ns.currencyCensus(currency)
    local info = ns.callable(currency, "GetCurrencyInfo")
    if not info then
        return nil
    end

    return {
        name = "currencies",
        scope = "character",
        ---@return integer[]
        list = function()
            local ids = {}
            for id = 1, LAST_CURRENCY_ID do
                ids[id] = id
            end
            return ids
        end,
        ---@param id integer
        ---@return integer?, table?
        read = function(id)
            local row = info(id)
            -- `MayReturnNothing` in the client's own documentation, which is what an id that is
            -- not a currency comes back as — the great majority of the range. The header check is
            -- the one `ns.readHoldings` makes for the same reason: the pane's group titles come
            -- back through this same structure.
            if type(row) ~= "table" or row.isHeader or type(row.quantity) ~= "number" then
                return nil, nil
            end
            -- What the client means by "this character has had something to do with this
            -- currency". Every other id in the range is a currency that exists in a game this
            -- character has never played the content of, and writing five thousand of those down
            -- per character is a saved file spent saying nothing. The balance is checked beside
            -- it rather than instead of it, so a build whose `discovered` means something narrower
            -- than expected still cannot lose a currency somebody is holding.
            if not row.discovered and row.quantity <= 0 then
                return nil, nil
            end
            return id, {
                name = row.name,
                -- The balance as it stands, zero included, for the reason `ns.readHoldings` keeps
                -- one: a character that has spent everything it had must be able to say so.
                total = row.quantity,
                -- Every other count is written only when it is not nought. Nought is what the
                -- client says for "no cap" and for "nothing yet this week" alike, and a key per
                -- currency per character saying it is a file spent saying nothing — the reader
                -- defaults each of these to nought, which is the same answer.
                earned = nonzero(row.totalEarned),
                cap = nonzero(row.maxQuantity),
                week = nonzero(row.quantityEarnedThisWeek),
                weekCap = nonzero(row.maxWeeklyQuantity),
                -- The warband's one pot rather than this character's share of it, and the
                -- separate pair for a currency that stays each character's own but can be moved
                -- between them at a cost. Both are the client's own distinction — see
                -- `ns.readHoldings`, which reads the same two off the pane row.
                accountWide = row.isAccountWide or nil,
                transferable = row.isAccountTransferable or nil,
            }
        end,
    }
end

---The highest faction id the walk asks about.
---
---`C_Reputation` enumerates the reputation *pane* and nothing else. `GetNumFactions` counts the
---rows it is drawing, which is the very number this domain exists not to trust — every legacy
---reputation is missing from it, because the pane hides them unless the player has asked
---otherwise, and `SetLegacyReputationsShown` would fix that by rearranging a pane the player
---arranged. So the positions are a range, and a range needs an end.
---
---`Faction` on build 12.0.5.67823 is 860 rows running from 1 to 2793, which is the table
---`docs/game-tables.json` already registers and `reputations.rs` already reads. Four thousand is
---that top id and half again — the same headroom `LAST_CURRENCY_ID` leaves, for the same reason:
---an id above this is invisible to the walk and the walk would still call itself complete. It is
---bounded, and raising it is free, 4,000 reads being twenty slices.
local LAST_FACTION_ID = 4000

---Reputations: where this character stands with every faction the game has.
---
---**This is the domain that reaches the legacy reputations**, which is most of the game's
---factions and none of what `ns.readHoldings` can see. That walk reads the reputation pane, and
---the pane hides legacy factions by default; `GetFactionDataByID` takes an arbitrary id and
---answers for it whether the pane is drawing it, hiding it, or has it folded under a collapsed
---expansion header. Nothing of the player's is touched, which is the rule the whole file keeps.
---
---**Character-scoped**, like the wallet next door and for the same reason: a standing is one
---character's, and two alts at different renown must not read as one alt whose standing keeps
---being replaced. `accountWide` is the exception the client itself draws — a warband reputation
---is one standing every character reports, and counting it once per alt is the mistake the
---warband gold pot exists to avoid.
---
---**Filed under the id, and the id is the whole point.** A faction's name is localised, so a
---store keyed on one forks the moment somebody plays in another language, and the desktop had
---to enter the game's tables through `Faction`'s name column to find out anything else about a
---faction it had only been given a string for.
---
---The four-ladder reduction is `ns.readFactionStanding`'s, reused rather than reimplemented:
---renown, paragon, friendship and the classic reaction ladder disagree about everything, and
---that function is what makes two characters' standings comparable at all.
---
---**No counter.** `GetNumFactions` counts pane rows, so it is not a count of this at all — it is
---the number this domain refuses to believe. So reputations are never distrusted into a pass of
---their own and are walked when something else provokes one, exactly as currencies are.
---
---A position costs more here than anywhere else — up to four client calls, because a faction that
---answers at all is then asked whether it is a major one, a friendship and a paragon — and the
---budget in `Census.lua` is sized for exactly that: it is a frame budget rather than a batch size,
---small enough that a domain whose reads are several times an ordinary one's still cannot drop a
---frame. Two thirds of the range are not factions and cost one call and no more.
---@param clients table? As `ns.readFactionStanding` takes them: `{ reputation = C_Reputation,
---majorFaction = C_MajorFactionData, gossip = C_GossipInfo, reactionLabel = ... }`.
---@return CensusDomain?
function ns.reputationCensus(clients)
    clients = clients or {}
    if not ns.callable(clients.reputation, "GetFactionDataByID") then
        return nil
    end

    return {
        name = "reputations",
        scope = "character",
        ---@return integer[]
        list = function()
            local ids = {}
            for id = 1, LAST_FACTION_ID do
                ids[id] = id
            end
            return ids
        end,
        ---@param id integer
        ---@return integer?, table?
        read = function(id)
            local state = ns.readFactionStandingByID(clients, id)
            -- A standing the client answers for with neither a name for the level nor a rank is
            -- a standing in nothing but shape: there is no ladder to place it on, so nothing
            -- downstream could ever crown it or compare it, and it would draw as a nameless full
            -- bar. `ns.readHoldings` refuses it on the same terms, and most of the range is not a
            -- faction at all.
            if not state or not (state.standing or state.rank) then
                return nil, nil
            end
            return id, {
                name = state.name,
                standing = state.standing,
                current = state.current,
                max = state.max,
                rank = state.rank,
                system = state.system,
                accountWide = state.accountWide,
            }
        end,
    }
end

---The highest appearance category the walk asks about.
---
---`C_TransmogCollection` has no enumerator for its categories either — nothing hands over a list,
---and `GetCategoryInfo(category)` answers about one at a time. What the categories *are* is
---`Enum.TransmogCollectionType`, which on build 12.0.5.67823 runs 0 to 29: 0 is `None`, 1 to 11
---the armour slots down the body, and 12 to 29 everything held in a hand, wands through paired
---weapons. Read out of the client's own `TransmogSharedDocumentation` rather than off the wiki.
---
---Forty is that top value with a patch's worth of headroom, and the headroom is nearly free here
---in a way it is not for currencies: a category that does not exist costs one `GetCategoryInfo`
---call that answers nothing and is then skipped, so the eleven spare are eleven calls once per
---pass rather than eleven positions to walk.
local LAST_TRANSMOG_CATEGORY = 40

---Appearances: every look the account has collected, keyed by the client's own `visualID`.
---
---**The largest thing the census can light up, and the one that is only ever half an answer.**
---`wardrobe.rs` reads all 55,198 appearances of a shipping install out of `ItemAppearance` and
---`transmog.rs` reads the sets that name them; neither knows whether the reader owns any of it, so
---a look ten years in the wardrobe is drawn exactly like one nobody has ever seen.
---
---`GetCategoryAppearances(category [, transmogLocation])` is what closes that — the second
---argument is optional, which the client's own usage string says outright, so there is no
---transmog location to build and no slot of the player's to name. One call per category answers
---for every appearance in it with its `visualID` and its `isCollected`, which is about thirty
---calls against a walk of fifty-five thousand.
---
---**Partial by construction, and that is the whole design rather than a defect in it.** The
---client answers this question through the *class filter*, which is the logged-in character's
---class unless somebody has changed it: a mage is not shown plate. Issue #250 settled which way
---out to take — the account's wardrobe is the union of what its characters can each see, built up
---as they are played, rather than something one character forces by driving
---`C_TransmogCollection.SetClassFilter` over all thirteen classes and leaving the player's own
---wardrobe filtered to somebody else's class if the session ends mid-walk. So the domain is
---marked `partial`: it never claims to be whole, is never pruned, and is walked once a session,
---which is what lets a paladin's login add the plate a mage's could not see.
---
---**Which also settles what the player's filters can do to it, which is nothing.** Whether
---`GetCategoryAppearances` applies the collected, source-type and faction filters in the client or
---leaves them to Lua could not be settled from the install — Blizzard's own
---`WardrobeItemsCollectionMixin:FilterVisuals` on this build filters `isHideVisual` and no more,
---which points the other way from what the call's name suggests. It does not matter here. Every
---one of those filters can only ever make the returned list *smaller*, a smaller list is a smaller
---set of positive observations, and a reading that never claims completeness can never delete
---anything on the strength of one. Nothing here reads a filter, and — as everywhere else in this
---file — nothing here writes one.
---
---`GetCategoryCollectedCount(category)` is the counter, and it is the unfiltered one: the client
---keeps a `GetFilteredCategoryCollectedCount` beside it, which is what Blizzard's own progress bar
---under the wardrobe grid draws. Summed over the categories it is the client's own opinion of how
---much of this the account has, against which `held` is how much of it the roster has managed to
---show us — which is the one honest measure of how far the union has got.
---
---A hidden visual is not written down. Those are the "hide helm" pseudo-appearances rather than
---looks anybody collected, they answer to no row of `ItemAppearance` a reader would recognise, and
---Blizzard's own list drops them before drawing it.
---@param collection table? The client's `C_TransmogCollection`.
---@return CensusDomain?
function ns.appearanceCensus(collection)
    local byCategory = ns.callable(collection, "GetCategoryAppearances")
    local categoryInfo = ns.callable(collection, "GetCategoryInfo")
    local categoryTotal = ns.callable(collection, "GetCategoryTotal")
    if not byCategory or not categoryInfo or not categoryTotal then
        return nil
    end

    -- The plan the positions index into, in the two flat arrays `ns.achievementCensus` uses and
    -- for the same reason: fifty-five thousand two-key tables is a megabyte of garbage to make
    -- for a walk that visits each position once.
    local planCategory, planIndex = {}, {}
    -- One category's answer, fetched by the first position that needs it and dropped when the
    -- walk moves on. This is where `list` gets to stay a handful of calls: the thirty fetches are
    -- spread over the slices that consume them rather than made in the frame that draws the plan.
    local heldCategory, heldList

    return {
        name = "appearances",
        scope = "account",
        partial = true,
        ---@return integer[]
        list = function()
            planCategory, planIndex = {}, {}
            heldCategory, heldList = nil, nil
            local positions = {}
            for category = 1, LAST_TRANSMOG_CATEGORY do
                -- A category the build does not have has no name, which is the same nothing an
                -- id above the top of the enum answers with.
                if categoryInfo(category) then
                    -- The unfiltered total, which is what makes it a bound rather than a length:
                    -- the list a position actually reads is the class filter's, and the class
                    -- filter can only take rows away. A category answering with more than this
                    -- would be walked as far as this and no further, which is one more corner of
                    -- an answer this domain already says is a corner.
                    for index = 1, categoryTotal(category) or 0 do
                        local at = #positions + 1
                        planCategory[at] = category
                        planIndex[at] = index
                        positions[at] = at
                    end
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
            if heldCategory ~= category then
                heldCategory = category
                heldList = byCategory(category)
            end
            local visual = type(heldList) == "table" and heldList[index] or nil
            if type(visual) ~= "table" or type(visual.visualID) ~= "number" then
                return nil, nil
            end
            -- Only what is held, as everywhere else here — an uncollected look is one of the
            -- fifty-five thousand rows the desktop already reads out of the game's own tables.
            if not visual.isCollected or visual.isHideVisual then
                return nil, nil
            end
            return visual.visualID, {
                -- No name, and this is the one domain that cannot carry one: the client's
                -- appearance list is ids and flags, and a look is named after one of however many
                -- items give it, which is `wardrobe.rs`'s decision and not one an addon is in a
                -- position to make. So this is the domain a machine with no install can say least
                -- about — and the category is what it can still say, which is enough to count a
                -- reader's heads without opening the game's storage.
                category = category,
                -- The player's own arrangement rather than a fact about the look, kept for the
                -- reason a mount's favourite is: a list that ignored it would disagree with the
                -- wardrobe they are looking at.
                favourite = visual.isFavorite or nil,
            }
        end,
        ---@return integer?
        count = function()
            local counter = ns.callable(collection, "GetCategoryCollectedCount")
            if not counter then
                return nil
            end
            local total = 0
            for category = 1, LAST_TRANSMOG_CATEGORY do
                if categoryInfo(category) then
                    total = total + (counter(category) or 0)
                end
            end
            return total
        end,
    }
end

---Every domain this client build can answer for, in the order they are walked.
---
---A domain whose calls this build does not have reports nil and is simply left out, which is the
---same answer `ns.readHoldings` gives for a pane the client will not open: a census that cannot
---be taken is not a census of nothing.
---@param clients table `{ mount = C_MountJournal, pet = C_PetJournal,
---toy = { box = C_ToyBox, hasToy = PlayerHasToy }, heirloom = C_Heirloom,
---title = { count = GetNumTitles, ... }, currency = C_CurrencyInfo,
---standing = { reputation = C_Reputation, ... }, collection = C_TransmogCollection,
---achievement = { ... } }`
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
        -- The four short walks, all of them under two thousand positions and each of them done
        -- inside a few seconds of ordinary play — so they go in front of the five-thousand-id
        -- ranges and a long way in front of the achievement tree.
        function()
            return ns.petCensus(clients.pet)
        end,
        function()
            return ns.toyCensus(clients.toy)
        end,
        function()
            return ns.heirloomCensus(clients.heirloom)
        end,
        function()
            return ns.titleCensus(clients.title)
        end,
        function()
            return ns.currencyCensus(clients.currency)
        end,
        function()
            return ns.reputationCensus(clients.standing)
        end,
        function()
            return ns.appearanceCensus(clients.collection)
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
