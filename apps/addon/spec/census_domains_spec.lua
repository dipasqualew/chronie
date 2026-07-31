local loader = require("addon_loader")

describe("the census domains", function()
    local ns = loader.load()

    describe("ns.mountCensus", function()
        ---A stand-in for `C_MountJournal`, answering the way the real one does.
        ---
        ---`GetMountInfoByID` returns eleven values and this domain reads six of them, so the
        ---three the client puts between the spell and the source — the icon, whether the mount
        ---is active, whether it is usable here — are written out rather than skipped: a fake
        ---that dropped them would agree with a domain that read the wrong positions.
        ---@param mounts table Keyed by mount id.
        ---@return table journal
        local function newJournal(mounts)
            local ids = {}
            for id in pairs(mounts) do
                ids[#ids + 1] = id
            end
            table.sort(ids)
            return {
                GetMountIDs = function()
                    return ids
                end,
                GetMountInfoByID = function(id)
                    local mount = mounts[id]
                    if not mount then
                        return nil
                    end
                    return mount.name, mount.spell, "interface/icon", false, true,
                        mount.source, mount.favourite, mount.factionSpecific, mount.faction,
                        mount.hidden, mount.collected
                end,
            }
        end

        -- The same answer `ns.readHoldings` gives for a pane the client will not open: a census
        -- that cannot be taken is not a census of nothing, so the domain declines to exist
        -- rather than existing and reporting an empty account.
        for _, case in ipairs({
            { what = "a client with no mount journal at all", journal = nil },
            { what = "a journal that will not enumerate", journal = { GetMountInfoByID = print } },
            { what = "a journal that will not describe", journal = { GetMountIDs = print } },
        }) do
            it("is not a domain on " .. case.what, function()
                assert.is_nil(ns.mountCensus(case.journal))
            end)
        end

        it("walks the journal's own ids rather than whatever the player has filtered to",
            function()
                local domain = ns.mountCensus(newJournal({ [6] = {}, [9] = {} }))

                assert.equal("mounts", domain.name)
                assert.equal("account", domain.scope)
                assert.same({ 6, 9 }, domain.list())
            end)

        it("says nothing about a mount the account has not collected", function()
            local domain = ns.mountCensus(newJournal({
                [6] = { name = "Swift Zhevra", spell = 37719, collected = false },
            }))

            local id, held = domain.read(6)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        it("describes a mount the account can summon", function()
            local domain = ns.mountCensus(newJournal({
                [6] = {
                    name = "Swift Zhevra", spell = 37719, source = 4,
                    favourite = true, hidden = true, collected = true,
                },
            }))

            local id, held = domain.read(6)

            assert.equal(6, id)
            assert.same({
                name = "Swift Zhevra",
                spell = 37719,
                source = 4,
                favourite = true,
                hidden = true,
            }, held)
        end)

        -- A key per mount saying "no" is a saved file spent saying nothing, and there are
        -- nineteen hundred mounts to say it about.
        it("leaves the player's own arrangement out when they have not made one", function()
            local domain = ns.mountCensus(newJournal({
                [6] = { name = "Swift Zhevra", collected = true, favourite = false, hidden = false },
            }))

            local _, held = domain.read(6)

            assert.is_nil(held.favourite)
            assert.is_nil(held.hidden)
        end)

        -- The faction number is only a fact about a mount that one side alone can ride. Every
        -- other mount reports it as whatever the client happens to have in the slot, which is
        -- not an answer to any question.
        it("records a side only for a mount only one side can ride", function()
            local journal = newJournal({
                [6] = { name = "Horde Ram", collected = true, factionSpecific = true, faction = 0 },
                [9] = { name = "Kua'fon", collected = true, factionSpecific = false, faction = 1 },
            })
            local domain = ns.mountCensus(journal)

            local _, sided = domain.read(6)
            local _, either = domain.read(9)

            assert.equal(0, sided.faction)
            assert.is_nil(either.faction)
        end)

        -- Blizzard's own journal calls `GetNumMounts` and then counts collected mounts by
        -- walking the ids anyway, which leaves its meaning genuinely ambiguous — and a counter
        -- whose meaning is guessed would either provoke a pass every login or suppress one that
        -- was needed. The whole walk is cheap, so mounts go without.
        it("offers no counter, because the client has none whose meaning is settled", function()
            assert.is_nil(ns.mountCensus(newJournal({})).count)
        end)
    end)

    describe("ns.currencyCensus", function()
        ---A stand-in for `C_CurrencyInfo`, answering the way the real one does.
        ---
        ---The important half of this fake is what it does for an id it has no row for: nothing at
        ---all. `GetCurrencyInfo` is marked `MayReturnNothing` in the client's own documentation
        ---and that is what the great majority of a five-thousand-id range comes back as, so a
        ---fake that handed over an empty table instead would agree with a domain that never
        ---checked.
        ---@param rows table Keyed by currency id, each the `CurrencyInfo` structure the client returns.
        ---@return table currency
        local function newCurrencies(rows)
            return {
                GetCurrencyInfo = function(id)
                    return rows[id]
                end,
            }
        end

        -- The same answer every other domain here gives for a client that cannot be asked: a
        -- census that cannot be taken is not a census of nothing, so the domain declines to
        -- exist rather than existing and reporting an empty wallet.
        for _, case in ipairs({
            { what = "a client with no currency API at all", currency = nil },
            { what = "a currency API that will not describe an id", currency = { GetCurrencyListSize = print } },
        }) do
            it("is not a domain on " .. case.what, function()
                assert.is_nil(ns.currencyCensus(case.currency))
            end)
        end

        -- `C_CurrencyInfo` has no enumerator — no id list, no counter, and the one call that
        -- hands over ids is keyed by a category id that only lives in the game's own tables. So
        -- the positions are a range, and the range is the whole point: it reaches the currencies
        -- a collapsed group hides from the pane that `ns.readHoldings` walks.
        it("walks a range of ids rather than the rows the pane happens to be drawing", function()
            local domain = ns.currencyCensus(newCurrencies({}))

            local ids = domain.list()

            assert.equal("currencies", domain.name)
            -- The first domain that is not the account's. Two alts with a wallet each must not
            -- read as one alt whose wallet keeps being replaced.
            assert.equal("character", domain.scope)
            assert.equal(5000, #ids)
            assert.equal(1, ids[1])
            assert.equal(5000, ids[#ids])
        end)

        it("says nothing about an id the client answers nothing for", function()
            local domain = ns.currencyCensus(newCurrencies({}))

            local id, held = domain.read(3008)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- The pane's group titles come back through this same structure, which is the check
        -- `ns.readHoldings` makes next door for the same reason.
        it("says nothing about a header rather than a currency", function()
            local domain = ns.currencyCensus(newCurrencies({
                [89] = { name = "Dungeon and Raid", isHeader = true, quantity = 0 },
            }))

            local id, held = domain.read(89)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- Every id in the range that is a currency of content this character has never played is
        -- one of five thousand absences, and writing them down per character is a saved file
        -- spent saying nothing the desktop could not work out by subtraction.
        it("says nothing about a currency this character has never come across", function()
            local domain = ns.currencyCensus(newCurrencies({
                [2245] = { name = "Flightstones", quantity = 0, discovered = false },
            }))

            local id, held = domain.read(2245)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- The balance is checked beside `discovered` rather than instead of it, so a build whose
        -- `discovered` means something narrower than expected still cannot lose a currency
        -- somebody is holding.
        it("writes down one it has never been told about but is holding anyway", function()
            local domain = ns.currencyCensus(newCurrencies({
                [2245] = { name = "Flightstones", quantity = 400, discovered = false },
            }))

            local id, held = domain.read(2245)

            assert.equal(2245, id)
            assert.equal(400, held.total)
        end)

        -- The one count that is written whatever it is. A character that has spent everything it
        -- had must be able to say so, or a balance goes on reporting what it was last seen with.
        it("writes down a currency it has discovered and spent to nothing", function()
            local domain = ns.currencyCensus(newCurrencies({
                [1602] = { name = "Conquest", quantity = 0, discovered = true, totalEarned = 1350 },
            }))

            local id, held = domain.read(1602)

            assert.equal(1602, id)
            assert.equal(0, held.total)
            assert.equal(1350, held.earned)
        end)

        -- What the pane row could never say, and what the whole domain exists for: the cap beside
        -- the total earned is "am I capped", and the weekly cap beside the week's count is "have
        -- I done my weekly", neither of which any amount of watching a balance change can answer.
        it("carries the caps and the week's counts that say how much more may be had", function()
            local domain = ns.currencyCensus(newCurrencies({
                [1602] = {
                    name = "Conquest", quantity = 1650, discovered = true,
                    totalEarned = 5400, maxQuantity = 5500,
                    quantityEarnedThisWeek = 750, maxWeeklyQuantity = 1350,
                    isAccountWide = true, isAccountTransferable = true,
                },
            }))

            local id, held = domain.read(1602)

            assert.equal(1602, id)
            assert.same({
                name = "Conquest",
                total = 1650,
                earned = 5400,
                cap = 5500,
                week = 750,
                weekCap = 1350,
                accountWide = true,
                transferable = true,
            }, held)
        end)

        -- Nought is the client's answer for "no cap", "nothing earned yet" and "no weekly" alike,
        -- and this census writes a key per id per character — so a nought written down is a saved
        -- file spent saying what its absence already said. Every reader defaults them to nought.
        it("leaves out a count the client only reported as nought", function()
            local domain = ns.currencyCensus(newCurrencies({
                [1166] = {
                    name = "Timewarped Badge", quantity = 220, discovered = true,
                    totalEarned = 0, maxQuantity = 0,
                    quantityEarnedThisWeek = 0, maxWeeklyQuantity = 0,
                },
            }))

            local _, held = domain.read(1166)

            assert.equal(220, held.total)
            assert.is_nil(held.earned)
            assert.is_nil(held.cap)
            assert.is_nil(held.week)
            assert.is_nil(held.weekCap)
        end)

        -- And the same economy for the two flags. Most currencies are neither the warband's one
        -- pot nor movable between characters, so the common case is the one that costs no key.
        it("leaves the warband out of a currency that is only this character's", function()
            local domain = ns.currencyCensus(newCurrencies({
                [1166] = {
                    name = "Timewarped Badge", quantity = 220, discovered = true,
                    isAccountWide = false, isAccountTransferable = false,
                },
            }))

            local _, held = domain.read(1166)

            assert.is_nil(held.accountWide)
            assert.is_nil(held.transferable)
        end)

        -- `GetCurrencyListSize` counts the rows the pane is drawing, which is the very number
        -- this domain exists not to trust. So there is nothing to distrust this walk into a pass
        -- of its own, and it is walked whenever something else provokes one.
        it("offers no counter, because the only one the client has counts the pane", function()
            assert.is_nil(ns.currencyCensus(newCurrencies({})).count)
        end)
    end)

    describe("ns.reputationCensus", function()
        ---A stand-in for the four namespaces a standing is assembled out of.
        ---
        ---The important half of this fake is the gap it keeps open between the two ways in.
        ---`GetFactionDataByID` answers for every row the test lists; `GetNumFactions` and
        ---`GetFactionDataByIndex` answer only for `options.pane`, which is the subset the
        ---player's reputation pane happens to be drawing. That gap is issue #254 — every
        ---legacy faction sits in it, because the pane hides them unless the player has said
        ---otherwise — and a fake whose two halves agreed would agree with a domain that had
        ---quietly gone on walking the pane.
        ---@param options table `{ rows, pane, renown, friendship, paragon, labels, without }`
        ---rows is keyed by faction id, each in `GetFactionDataByID`'s shape; pane is the list
        ---of ids the pane is drawing, in pane order.
        ---@return table clients
        local function newFactions(options)
            local rows = options.rows or {}
            local pane = options.pane or {}
            local missing = {}
            for _, name in ipairs(options.without or {}) do
                missing[name] = true
            end

            local reputation = {
                GetFactionDataByID = function(factionID)
                    return rows[factionID]
                end,
                GetNumFactions = function()
                    return #pane
                end,
                GetFactionDataByIndex = function(index)
                    return rows[pane[index]]
                end,
                IsMajorFaction = function(factionID)
                    return (options.renown or {})[factionID] ~= nil
                end,
                IsFactionParagon = function(factionID)
                    return (options.paragon or {})[factionID] ~= nil
                end,
                GetFactionParagonInfo = function(factionID)
                    local paragon = (options.paragon or {})[factionID] or {}
                    return paragon.value, paragon.threshold
                end,
            }
            for name in pairs(missing) do
                reputation[name] = nil
            end

            return {
                reputation = reputation,
                majorFaction = {
                    GetMajorFactionData = function(factionID)
                        return (options.renown or {})[factionID]
                    end,
                },
                gossip = {
                    GetFriendshipReputation = function(factionID)
                        return (options.friendship or {})[factionID]
                    end,
                },
                reactionLabel = function(reaction)
                    return (options.labels or {})[reaction]
                end,
            }
        end

        -- Argent Dawn, 529, is a legacy reputation: the pane will not draw it unless the
        -- player has gone and asked for legacy reputations, and `SetLegacyReputationsShown`
        -- would fix that by rearranging a pane the player arranged. So it is exactly the
        -- faction the pane walk next door cannot see.
        local ARGENT_DAWN = {
            factionID = 529,
            name = "Argent Dawn",
            reaction = 6,
            currentStanding = 12000,
            currentReactionThreshold = 9000,
            nextReactionThreshold = 21000,
        }
        local DREAM_WARDENS = { factionID = 2574, name = "Dream Wardens", reaction = 8 }

        -- The same answer every other domain here gives for a client that cannot be asked: a
        -- census that cannot be taken is not a census of nothing, so the domain declines to
        -- exist rather than existing and reporting a character who stands with nobody.
        for _, case in ipairs({
            { what = "a client with no reputation API at all", clients = nil },
            { what = "a client with no namespaces whatsoever", clients = {} },
        }) do
            it("is not a domain on " .. case.what, function()
                assert.is_nil(ns.reputationCensus(case.clients))
            end)
        end

        it("is not a domain on a build that cannot be asked about an id", function()
            local clients = newFactions({ rows = {}, without = { "GetFactionDataByID" } })

            assert.is_nil(ns.reputationCensus(clients))
        end)

        -- `GetNumFactions` counts pane rows, which is the very number this domain exists not
        -- to trust, and there is no other enumerator. So the positions are a range — the same
        -- shape `ns.currencyCensus` walks, and for the same reason.
        it("walks a range of ids rather than the rows the pane happens to be drawing", function()
            local domain = ns.reputationCensus(newFactions({ rows = {} }))

            local ids = domain.list()

            assert.equal("reputations", domain.name)
            -- A standing is one character's. Two alts at different renown must not read as
            -- one alt whose standing keeps being replaced.
            assert.equal("character", domain.scope)
            assert.equal(4000, #ids)
            assert.equal(1, ids[1])
            assert.equal(4000, ids[#ids])
        end)

        -- Issue #254 in one test. The pane is drawing one faction and knows nothing of the
        -- other; asked by id, the client answers for both.
        it("reaches a standing the reputation pane never lists", function()
            local domain = ns.reputationCensus(newFactions({
                rows = { [529] = ARGENT_DAWN, [2574] = DREAM_WARDENS },
                pane = { 2574 },
                renown = {
                    [2574] = { renownLevel = 12, renownReputationEarned = 500,
                        renownLevelThreshold = 2500 },
                },
                labels = { [6] = "Honored" },
            }))

            local id, held = domain.read(529)

            assert.equal(529, id)
            assert.same({
                name = "Argent Dawn",
                standing = "Honored",
                current = 3000,
                max = 12000,
                rank = 6,
                system = "reaction",
            }, held)
        end)

        -- Most of a four-thousand-id range is not a faction at all, and the client's own
        -- documentation marks the call nilable. Nothing is the answer rather than a Lua error
        -- out of a walk that has three thousand more ids to get through.
        it("says nothing about an id that is not a faction", function()
            local domain = ns.reputationCensus(newFactions({ rows = { [529] = ARGENT_DAWN } }))

            local id, held = domain.read(3999)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- A standing with neither a name for the level nor a rank is a standing in nothing but
        -- shape: nothing downstream could crown it or compare it, and it would draw as a
        -- nameless full bar. `ns.readHoldings` refuses one on exactly the same terms.
        it("says nothing about a faction the client will not place", function()
            local domain = ns.reputationCensus(newFactions({
                rows = {
                    [1177] = {
                        factionID = 1177,
                        name = "Nameless Rank",
                        currentStanding = 500,
                        currentReactionThreshold = 0,
                        nextReactionThreshold = 3000,
                    },
                },
            }))

            local id, held = domain.read(1177)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- The reduction is `ns.readFactionStanding`'s, reused rather than reimplemented: the
        -- four systems disagree about everything, and that function is what makes two
        -- characters' standings comparable at all. A renown faction reached by id must not
        -- come back as the Friendly its reaction ladder also reports.
        it("reduces the four ladders the way every other reader of a standing does", function()
            local domain = ns.reputationCensus(newFactions({
                rows = { [2574] = DREAM_WARDENS },
                renown = {
                    [2574] = { renownLevel = 12, renownReputationEarned = 500,
                        renownLevelThreshold = 2500 },
                },
                labels = { [8] = "Friendly" },
            }))

            local id, held = domain.read(2574)

            assert.equal(2574, id)
            assert.equal("Renown 12", held.standing)
            assert.equal("renown", held.system)
            assert.equal(12, held.rank)
        end)

        -- A warband reputation is one standing every character on the account reports, so a
        -- census that wrote it per character without saying so would have every alt looking
        -- like it had done the grind. The flag is what the desktop counts it once by.
        it("carries the warband's own standings through as the warband's", function()
            local domain = ns.reputationCensus(newFactions({
                rows = {
                    [2590] = {
                        factionID = 2590,
                        name = "Council of Dornogal",
                        reaction = 6,
                        isAccountWide = true,
                        currentStanding = 12000,
                        currentReactionThreshold = 9000,
                        nextReactionThreshold = 21000,
                    },
                },
                labels = { [6] = "Honored" },
            }))

            local _, held = domain.read(2590)

            assert.is_true(held.accountWide)
        end)

        -- Absent rather than false, the same economy every other domain here keeps: most
        -- factions are the character's own, and a key per faction per character saying "no"
        -- is a saved file spent saying what its absence already said.
        it("leaves the warband out of a standing that is only this character's", function()
            local domain = ns.reputationCensus(newFactions({
                rows = { [529] = ARGENT_DAWN },
                labels = { [6] = "Honored" },
            }))

            local _, held = domain.read(529)

            assert.is_nil(held.accountWide)
        end)

        -- `GetNumFactions` counts the rows the pane is drawing, so it is not a count of this
        -- at all — it is the number the domain refuses to believe. So there is nothing to
        -- distrust this walk into a pass of its own, and it is walked whenever something else
        -- provokes one, exactly as the currencies are.
        it("offers no counter, because the only one the client has counts the pane", function()
            assert.is_nil(ns.reputationCensus(newFactions({ rows = {} })).count)
        end)
    end)

    describe("ns.achievementCensus", function()
        ---A stand-in for the four bare globals the achievement tree is reached through.
        ---
        ---`byIndex` records the `(category, index)` pair it was asked about, because the whole of
        ---what `list` produces is a plan those pairs are read back out of: a position that maps
        ---to the wrong pair would still walk the right *number* of achievements and would file
        ---every one of them under the wrong id.
        ---@param options table `{ categories, counts, rows, completedCount }`
        ---@return table clients, table asked
        local function newTree(options)
            local asked = {}
            local rows = options.rows or {}
            local clients = {
                categories = function()
                    return options.categories
                end,
                categoryCount = function(category)
                    return (options.counts or {})[category]
                end,
                byIndex = function(category, index)
                    asked[#asked + 1] = { category = category, index = index }
                    local row = rows[category] and rows[category][index]
                    if not row then
                        return nil
                    end
                    return row.id, row.name, row.points, row.completed, row.month, row.day,
                        row.year, "description", 0, "interface/icon", "a reward",
                        row.guild, row.mine, row.by
                end,
            }
            if options.completedCount then
                clients.completedCount = options.completedCount
            end
            return clients, asked
        end

        for _, case in ipairs({
            { what = "nothing at all", clients = nil },
            { what = "no way to name the trees", missing = "categories" },
            { what = "no way to measure one", missing = "categoryCount" },
            { what = "no way to read a row", missing = "byIndex" },
        }) do
            it("is not a domain on a client offering " .. case.what, function()
                local clients = case.clients
                if case.missing then
                    clients = newTree({ categories = { 92 } })
                    clients[case.missing] = nil
                end

                assert.is_nil(ns.achievementCensus(clients))
            end)
        end

        -- There is no id list to walk, so the plan is drawn from the trees and their depths and
        -- a position is an index into it. About eighty calls buys thirteen thousand positions
        -- that each cost one call rather than two.
        it("plans a position for every achievement in every tree", function()
            local clients = newTree({ categories = { 92, 96 }, counts = { [92] = 2, [96] = 3 } })
            local domain = ns.achievementCensus(clients)

            local positions = domain.list()

            assert.equal("achievements", domain.name)
            assert.equal("account", domain.scope)
            assert.same({ 1, 2, 3, 4, 5 }, positions)
        end)

        it("reads each position back out as the tree and offset it stands for", function()
            local clients, asked = newTree({
                categories = { 92, 96 },
                counts = { [92] = 2, [96] = 3 },
            })
            local domain = ns.achievementCensus(clients)
            domain.list()

            domain.read(1)
            domain.read(3)
            domain.read(5)

            assert.same({
                { category = 92, index = 1 },
                { category = 96, index = 1 },
                { category = 96, index = 3 },
            }, asked)
        end)

        ---One tree of one row, already planned, so a test says only what the row says.
        ---@param row table
        ---@return table domain
        local function domainOf(row)
            local clients = newTree({
                categories = { 92 },
                counts = { [92] = 1 },
                rows = { [92] = { row } },
            })
            local domain = ns.achievementCensus(clients)
            domain.list()
            return domain
        end

        -- A guild's achievements are the guild's. They would come and go with whichever guild
        -- the walking character happens to be in, which is not a fact about this account at all.
        it("says nothing about a guild's achievement", function()
            local domain = domainOf({ id = 5788, name = "Guild Level 25", completed = true,
                guild = true, mine = true })

            local id, held = domain.read(1)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        it("says nothing about an achievement nobody on the account has finished", function()
            local domain = domainOf({ id = 4842, name = "Herald of the Titans", completed = false })

            local id, held = domain.read(1)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- The half of the split that costs a key is the common one, so the ordinary case — the
        -- character doing the walking earned it — is `mine` and nothing else.
        it("credits the walking character with what they earned themselves", function()
            local domain = domainOf({
                id = 4842, name = "Herald of the Titans", points = 25,
                month = 8, day = 4, year = 9, completed = true, mine = true, by = "Aster",
            })

            local id, held = domain.read(1)

            assert.equal(4842, id)
            assert.same({
                name = "Herald of the Titans",
                points = 25,
                month = 8,
                day = 4,
                year = 9,
                mine = true,
            }, held)
        end)

        -- And the half that pays for the whole mechanism: one character, in one pass, reports
        -- an achievement earned years ago by an alt that has not been logged into since.
        it("names the alt that earned one the walking character did not", function()
            local domain = domainOf({
                id = 4842, name = "Herald of the Titans", points = 25,
                completed = true, mine = false, by = "Brin",
            })

            local _, held = domain.read(1)

            assert.equal("Brin", held.by)
            assert.is_nil(held.mine)
        end)

        it("says nothing about a position no plan was ever drawn for", function()
            local domain = ns.achievementCensus(newTree({ categories = { 92 } }))

            local id, held = domain.read(1)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- Read out of Blizzard's own Blizzard_AchievementUI, which takes it as
        -- `numAchievements, numCompleted = GetNumCompletedAchievements(IN_GUILD_VIEW)`. The
        -- second return is the account's total, and the argument is the guild view, which this
        -- census is emphatically not of.
        it("counts the account's completed total off the client's own second return", function()
            local guildViews = {}
            local domain = ns.achievementCensus(newTree({
                categories = { 92 },
                completedCount = function(guildView)
                    guildViews[#guildViews + 1] = guildView
                    return 13732, 4211
                end,
            }))

            assert.equal(4211, domain.count())
            assert.same({ false }, guildViews)
        end)

        it("offers no count at all on a build without the call", function()
            local domain = ns.achievementCensus(newTree({ categories = { 92 } }))

            assert.is_nil(domain.count())
        end)
    end)

    describe("ns.censusDomains", function()
        ---Everything a build would need to answer for every domain.
        ---@return table
        local function everything()
            return {
                mount = {
                    GetMountIDs = function()
                        return {}
                    end,
                    GetMountInfoByID = print,
                },
                currency = {
                    GetCurrencyInfo = print,
                },
                standing = {
                    reputation = { GetFactionDataByID = print },
                },
                achievement = {
                    categories = print,
                    categoryCount = print,
                    byIndex = print,
                },
            }
        end

        ---@param domains table[]
        ---@return string[]
        local function namesOf(domains)
            local names = {}
            for _, domain in ipairs(domains) do
                names[#names + 1] = domain.name
            end
            return names
        end

        -- Cheapest first, and the order is the assertion. A pass is interrupted by whatever ends
        -- the session, so the two domains that finish in a fraction of a second must not be
        -- queued behind the thirteen-thousand-call one that takes a minute.
        it("names every domain a build can answer for, cheapest walk first", function()
            assert.same(
                { "mounts", "currencies", "reputations", "achievements" },
                namesOf(ns.censusDomains(everything()))
            )
        end)

        it("is no domains at all on a build that can answer for none", function()
            assert.same({}, ns.censusDomains({}))
            assert.same({}, ns.censusDomains(nil))
        end)

        -- The trap this is shaped around. A list built by assigning each maker's answer to its
        -- own slot would leave a hole where the missing domain was, and `ipairs` stops at a
        -- hole — silently dropping every domain behind it as well as the one that was absent.
        it("keeps the domains behind one this build cannot answer for", function()
            local clients = everything()
            clients.mount = nil

            assert.same({ "currencies", "reputations", "achievements" },
                namesOf(ns.censusDomains(clients)))
        end)

        it("keeps the domains ahead of one this build cannot answer for", function()
            local clients = everything()
            clients.achievement = nil

            assert.same({ "mounts", "currencies", "reputations" }, namesOf(ns.censusDomains(clients)))
        end)

        -- And the case that would actually catch it, now there is a domain with one on each
        -- side: a build with no `C_CurrencyInfo` leaves the reputations and achievements behind
        -- the gap and the mounts in front of it, rather than a list that stops where the
        -- currencies would be.
        it("keeps the domains on both sides of one this build cannot answer for", function()
            local clients = everything()
            clients.currency = nil

            assert.same({ "mounts", "reputations", "achievements" },
                namesOf(ns.censusDomains(clients)))
        end)

        -- The newest domain is reached through a bundle of namespaces rather than one, so a
        -- build without it is spelled by withholding the bundle — and the walk in front of it
        -- and the walk behind it both have to survive that.
        it("keeps the domains on both sides of a build with no reputation calls", function()
            local clients = everything()
            clients.standing = nil

            assert.same({ "mounts", "currencies", "achievements" },
                namesOf(ns.censusDomains(clients)))
        end)
    end)
end)
