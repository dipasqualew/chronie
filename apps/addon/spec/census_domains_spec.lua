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
        ---Everything a build would need to answer for both domains.
        ---@return table
        local function everything()
            return {
                mount = {
                    GetMountIDs = function()
                        return {}
                    end,
                    GetMountInfoByID = print,
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

        it("names both domains on a build that can answer for both", function()
            assert.same({ "mounts", "achievements" }, namesOf(ns.censusDomains(everything())))
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

            assert.same({ "achievements" }, namesOf(ns.censusDomains(clients)))
        end)

        it("keeps the domains ahead of one this build cannot answer for", function()
            local clients = everything()
            clients.achievement = nil

            assert.same({ "mounts" }, namesOf(ns.censusDomains(clients)))
        end)
    end)
end)
