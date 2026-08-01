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

    describe("ns.petCensus", function()
        ---A stand-in for `C_PetJournal`, answering about the account's own pets.
        ---
        ---`GetNumCollectedInfo` writes down every species it is asked about, because the reason
        ---the count comes from the client rather than from a tally of the walk only shows in how
        ---often it is asked: a domain that asked once per pet would come back with the same
        ---number and would have made a call per pet to do it.
        ---
        ---`GetPetInfoTableByPetID` hands over a table of named fields rather than the
        ---seventeen-return positional twin, which is the pair the client's own `PetJournalInfo`
        ---documentation describes and the one a fake cannot silently agree with by one position.
        ---@param options table `{ guids, pets, counts }` — guids in the order the client hands
        ---them over, pets keyed by GUID, counts keyed by species id.
        ---@return table journal, table asked
        local function newPetJournal(options)
            local asked = {}
            return {
                GetOwnedPetIDs = function()
                    return options.guids or {}
                end,
                GetPetInfoTableByPetID = function(guid)
                    return (options.pets or {})[guid]
                end,
                GetNumCollectedInfo = function(speciesID)
                    asked[#asked + 1] = speciesID
                    return (options.counts or {})[speciesID]
                end,
            }, asked
        end

        -- The same answer every other domain here gives for a client that cannot be asked: a
        -- census that cannot be taken is not a census of nothing, so the domain declines to
        -- exist rather than existing and reporting an account that owns no pets.
        for _, case in ipairs({
            { what = "a client with no pet journal at all", missing = nil },
            { what = "a journal that will not enumerate", missing = "GetOwnedPetIDs" },
            { what = "a journal that will not describe", missing = "GetPetInfoTableByPetID" },
            { what = "a journal that will not count a species", missing = "GetNumCollectedInfo" },
        }) do
            it("is not a domain on " .. case.what, function()
                local journal = nil
                if case.missing then
                    journal = newPetJournal({})
                    journal[case.missing] = nil
                end

                assert.is_nil(ns.petCensus(journal))
            end)
        end

        -- `GetOwnedPetIDs` takes no filter and answers about what is owned. The filtered pair is
        -- `GetNumPets`/`GetPetInfoByIndex`, which is what Blizzard's own pet journal draws its
        -- list from with a search box in front of it — the same distinction the mounts make.
        it("walks the account's own pets rather than the list the journal is drawing", function()
            local journal = newPetJournal({ guids = { "BattlePet-0-1", "BattlePet-0-2" } })
            local domain = ns.petCensus(journal)

            assert.equal("pets", domain.name)
            assert.equal("account", domain.scope)
            assert.same({ "BattlePet-0-1", "BattlePet-0-2" }, domain.list())
        end)

        -- A GUID is one pet and a collection is counted in species: three Mechanical Squirrels
        -- are one line of the pet journal, so the id an entry is filed under has to be the
        -- species or the record would carry three rows the journal draws as one.
        it("files a pet under its species rather than under its own guid", function()
            local journal = newPetJournal({
                guids = { "BattlePet-0-1" },
                pets = { ["BattlePet-0-1"] = { speciesID = 39, name = "Mechanical Squirrel" } },
                counts = { [39] = 1 },
            })
            local domain = ns.petCensus(journal)
            domain.list()

            local id, held = domain.read("BattlePet-0-1")

            assert.equal(39, id)
            assert.equal("Mechanical Squirrel", held.name)
            assert.equal(1, held.count)
        end)

        -- The count is the client's answer rather than a tally of the walk, and the difference
        -- shows in exactly the case the whole design is built around: a pass a logout cuts short
        -- still says how many of a species the account has, instead of how many it reached.
        it("folds a species' pets into one entry the client itself counts", function()
            local journal, asked = newPetJournal({
                guids = { "BattlePet-0-1", "BattlePet-0-2", "BattlePet-0-3" },
                pets = {
                    ["BattlePet-0-1"] = { speciesID = 39, name = "Mechanical Squirrel", petLevel = 1 },
                    ["BattlePet-0-2"] = { speciesID = 39, name = "Mechanical Squirrel", petLevel = 1 },
                    ["BattlePet-0-3"] = { speciesID = 39, name = "Mechanical Squirrel", petLevel = 1 },
                },
                counts = { [39] = 3 },
            })
            local domain = ns.petCensus(journal)

            local entries = {}
            for _, guid in ipairs(domain.list()) do
                local id, held = domain.read(guid)
                entries[id] = held
            end

            assert.equal(3, entries[39].count)
            -- Once per species, not once per pet.
            assert.same({ 39 }, asked)
        end)

        -- A species is the unit here, so a level has to be *some* pet's — and the highest is the
        -- only choice that does not depend on what order the client handed the GUIDs over in.
        for _, case in ipairs({
            { what = "worst first", guids = { "BattlePet-0-1", "BattlePet-0-2" } },
            { what = "best first", guids = { "BattlePet-0-2", "BattlePet-0-1" } },
        }) do
            it("keeps the best pet of a species, " .. case.what, function()
                local journal = newPetJournal({
                    guids = case.guids,
                    pets = {
                        ["BattlePet-0-1"] = { speciesID = 39, name = "Mechanical Squirrel", petLevel = 3 },
                        ["BattlePet-0-2"] = {
                            speciesID = 39, name = "Mechanical Squirrel",
                            petLevel = 25, customName = "Nutkin",
                        },
                    },
                    counts = { [39] = 2 },
                })
                local domain = ns.petCensus(journal)

                local held
                for _, guid in ipairs(domain.list()) do
                    _, held = domain.read(guid)
                end

                assert.equal(25, held.level)
                assert.equal("Nutkin", held.custom)
            end)
        end

        -- The player's own arrangement rather than a fact about the species, and true if any one
        -- of them is starred, because that is what the journal draws a star on.
        it("stars a species any one of whose pets the player has starred", function()
            local journal = newPetJournal({
                guids = { "BattlePet-0-1", "BattlePet-0-2" },
                pets = {
                    ["BattlePet-0-1"] = { speciesID = 39, name = "Mechanical Squirrel", petLevel = 25 },
                    ["BattlePet-0-2"] = {
                        speciesID = 39, name = "Mechanical Squirrel",
                        petLevel = 3, isFavorite = true,
                    },
                },
                counts = { [39] = 2 },
            })
            local domain = ns.petCensus(journal)

            local held
            for _, guid in ipairs(domain.list()) do
                _, held = domain.read(guid)
            end

            assert.is_true(held.favourite)
        end)

        -- Absent rather than false, the same economy the mounts keep: a key per species saying
        -- "not starred", "not renamed" is a saved file spent saying what its absence already said.
        it("leaves the star and the nickname out where the player has made neither", function()
            local journal = newPetJournal({
                guids = { "BattlePet-0-1" },
                pets = {
                    ["BattlePet-0-1"] = {
                        speciesID = 39, name = "Mechanical Squirrel",
                        petLevel = 25, isFavorite = false,
                    },
                },
                counts = { [39] = 1 },
            })
            local domain = ns.petCensus(journal)
            domain.list()

            local _, held = domain.read("BattlePet-0-1")

            assert.equal(25, held.level)
            assert.is_nil(held.favourite)
            assert.is_nil(held.custom)
        end)

        it("says nothing about a guid the client will not describe", function()
            local domain = ns.petCensus(newPetJournal({ guids = { "BattlePet-0-1" } }))
            domain.list()

            local id, held = domain.read("BattlePet-0-1")

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- The entries are kept only for as long as a pass lasts. A species whose best pet was
        -- traded away between two passes must come back as what the account holds now, rather
        -- than going on reporting the level of a pet nobody owns any more.
        it("starts a species afresh on every pass", function()
            -- The account as the fake will report it, and the account after the level-25 pet
            -- has been traded away — the fake reads this table on every call, so a second pass
            -- meets what a second pass would really meet.
            local account = {
                guids = { "BattlePet-0-1", "BattlePet-0-2" },
                pets = {
                    ["BattlePet-0-1"] = { speciesID = 39, name = "Mechanical Squirrel", petLevel = 3 },
                    ["BattlePet-0-2"] = { speciesID = 39, name = "Mechanical Squirrel", petLevel = 25 },
                },
                counts = { [39] = 2 },
            }
            local domain = ns.petCensus(newPetJournal(account))
            for _, guid in ipairs(domain.list()) do
                domain.read(guid)
            end

            account.guids = { "BattlePet-0-1" }
            account.pets["BattlePet-0-2"] = nil
            account.counts[39] = 1
            domain.list()
            local _, held = domain.read("BattlePet-0-1")

            assert.equal(3, held.level)
            assert.equal(1, held.count)
        end)
    end)

    describe("ns.toyCensus", function()
        ---A stand-in for the toy box and the bare `PlayerHasToy` global beside it.
        ---
        ---`GetToyInfo` returns five values and this domain reads two of them, so the icon between
        ---the name and the star is written out rather than skipped: a fake that dropped it would
        ---agree with a domain that read the wrong positions.
        ---
        ---`PlayerHasToy` is a bare function rather than a member of `C_ToyBox`, which is
        ---genuinely what the client offers — it was never moved into the namespace.
        ---@param options table `{ total, indexed, toys, has }` — indexed keyed by position,
        ---toys keyed by item id, has the set of item ids the account owns.
        ---@return table clients
        local function newToyBox(options)
            return {
                box = {
                    GetNumToys = function()
                        return options.total or 0
                    end,
                    GetToyFromIndex = function(index)
                        return (options.indexed or {})[index]
                    end,
                    GetToyInfo = function(itemID)
                        local toy = (options.toys or {})[itemID]
                        if not toy then
                            return nil
                        end
                        return itemID, toy.name, "interface/icon", toy.favourite, toy.fanfare
                    end,
                },
                hasToy = function(itemID)
                    return (options.has or {})[itemID] or false
                end,
            }
        end

        -- The same answer every other domain here gives for a client that cannot be asked, and
        -- the bundle has two halves that can each be missing on their own.
        for _, case in ipairs({
            { what = "a client with no toy calls at all", bare = true },
            { what = "a bundle with no toy box in it", bundle = { hasToy = print } },
            { what = "a box that will not say how many there are", missing = "GetNumToys" },
            { what = "a box that will not answer for a position", missing = "GetToyFromIndex" },
            { what = "a box that will not describe a toy", missing = "GetToyInfo" },
            { what = "a build with no PlayerHasToy beside the box", withoutHas = true },
        }) do
            it("is not a domain on " .. case.what, function()
                local clients = case.bundle
                if not case.bare and not clients then
                    clients = newToyBox({})
                    if case.missing then
                        clients.box[case.missing] = nil
                    else
                        clients.hasToy = nil
                    end
                end

                assert.is_nil(ns.toyCensus(clients))
            end)
        end

        -- The claim this domain refuses to make. There is only one indexer and Blizzard's own
        -- toy box pairs it with the *filtered* count, so the list this walks is very probably
        -- the one the player's filters left standing — and a reading that never claims to be
        -- whole can never prune away a toy somebody had narrowed out of view.
        it("says out loud that a walk of it is only ever part of an answer", function()
            local domain = ns.toyCensus(newToyBox({}))

            assert.equal("toys", domain.name)
            assert.equal("account", domain.scope)
            assert.is_true(domain.partial)
        end)

        -- The bound is the *unfiltered* total, which is the larger of the client's two: nothing
        -- the player has left visible can fall outside it.
        it("walks a position for every toy the unfiltered total claims", function()
            local domain = ns.toyCensus(newToyBox({ total = 3 }))

            assert.same({ 1, 2, 3 }, domain.list())
        end)

        -- `-1` is the client's own answer for a position past the end of the list, which is what
        -- Blizzard's toy button checks for before drawing itself.
        for _, case in ipairs({
            { what = "past the end of the list", answer = -1 },
            { what = "the client answers nothing for", answer = nil },
        }) do
            it("says nothing about a position " .. case.what, function()
                local domain = ns.toyCensus(newToyBox({ total = 1, indexed = { [1] = case.answer } }))

                local id, held = domain.read(1)

                assert.is_nil(id)
                assert.is_nil(held)
            end)
        end

        -- `PlayerHasToy` answers about an id whatever the toy box is showing, so the index
        -- naming a toy is not the same as the account owning it.
        it("says nothing about a toy the index named but the account does not have", function()
            local domain = ns.toyCensus(newToyBox({
                total = 1,
                indexed = { [1] = 163722 },
                toys = { [163722] = { name = "Anima Drainer" } },
                has = {},
            }))

            local id, held = domain.read(1)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        it("describes a toy the account can pull out of the box", function()
            local domain = ns.toyCensus(newToyBox({
                total = 1,
                indexed = { [1] = 54452 },
                toys = { [54452] = { name = "Ethereal Portal", favourite = true } },
                has = { [54452] = true },
            }))

            local id, held = domain.read(1)

            assert.equal(54452, id)
            assert.same({ name = "Ethereal Portal", favourite = true }, held)
        end)

        it("leaves the star out of a toy the player has not starred", function()
            local domain = ns.toyCensus(newToyBox({
                total = 1,
                indexed = { [1] = 54452 },
                toys = { [54452] = { name = "Ethereal Portal", favourite = false } },
                has = { [54452] = true },
            }))

            local _, held = domain.read(1)

            assert.equal("Ethereal Portal", held.name)
            assert.is_nil(held.favourite)
        end)
    end)

    describe("ns.heirloomCensus", function()
        ---A stand-in for `C_Heirloom`.
        ---
        ---`GetHeirloomInfo` returns ten values and this domain reads four of them, so the four
        ---between the slot and the source and the three trailing levels are all written out
        ---rather than skipped: a fake that stopped at the source would agree with a domain that
        ---read the wrong positions.
        ---@param options table `{ ids, rows, has, known }` — rows keyed by item id.
        ---@return table heirloom
        local function newHeirlooms(options)
            local heirloom = {
                GetHeirloomItemIDs = function()
                    return options.ids
                end,
                GetHeirloomInfo = function(itemID)
                    local row = (options.rows or {})[itemID]
                    if not row then
                        return nil
                    end
                    return row.name, row.slot, false, "interface/icon", row.upgrade,
                        row.source, false, 60, 1, 60
                end,
                PlayerHasHeirloom = function(itemID)
                    return (options.has or {})[itemID] or false
                end,
                GetHeirloomMaxUpgradeLevel = function(itemID)
                    return ((options.rows or {})[itemID] or {}).maxUpgrade
                end,
            }
            if options.known then
                heirloom.GetNumKnownHeirlooms = function()
                    return options.known
                end
            end
            return heirloom
        end

        for _, case in ipairs({
            { what = "a client with no heirloom API at all", missing = nil },
            { what = "a build that will not enumerate", missing = "GetHeirloomItemIDs" },
            { what = "a build that will not describe one", missing = "GetHeirloomInfo" },
            { what = "a build that will not say what the account has", missing = "PlayerHasHeirloom" },
        }) do
            it("is not a domain on " .. case.what, function()
                local heirloom = nil
                if case.missing then
                    heirloom = newHeirlooms({ ids = {} })
                    heirloom[case.missing] = nil
                end

                assert.is_nil(ns.heirloomCensus(heirloom))
            end)
        end

        -- Nothing in Blizzard's own interface calls `GetHeirloomItemIDs`, so nothing in the
        -- install says whether it answers past the pane's class and spec filters — and the toy
        -- box next door is a live counter-example to reading a name as evidence. Refusing to
        -- prune costs nothing on a grow-only collection; pruning a filtered list would not.
        it("says out loud that a walk of it is only ever part of an answer", function()
            local domain = ns.heirloomCensus(newHeirlooms({ ids = {} }))

            assert.equal("heirlooms", domain.name)
            assert.equal("account", domain.scope)
            assert.is_true(domain.partial)
        end)

        -- The one enumerator in `C_Heirloom` that does not say "Displayed" in its name. The
        -- pane's pair is `GetNumDisplayedHeirlooms`/`GetHeirloomItemIDFromDisplayedIndex`, with
        -- a class filter, a spec filter and a search box in front of it.
        it("walks the client's own id list rather than the pane's", function()
            local domain = ns.heirloomCensus(newHeirlooms({ ids = { 122668, 122667 } }))

            assert.same({ 122668, 122667 }, domain.list())
        end)

        it("walks nothing at all on a build that will not enumerate", function()
            assert.is_nil(ns.heirloomCensus(newHeirlooms({})).list())
        end)

        it("says nothing about an heirloom the account has never bought", function()
            local domain = ns.heirloomCensus(newHeirlooms({
                ids = { 122668 },
                rows = { [122668] = { name = "Bloodied Arcanite Reaper", slot = "INVTYPE_2HWEAPON" } },
                has = {},
            }))

            local id, held = domain.read(122668)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- "Is this one finished with" is a question no amount of watching somebody buy an
        -- upgrade would answer for the heirlooms bought years ago, which is why how far it has
        -- been taken and how far it goes are both written down.
        it("describes one the account has bought, and how far it has been taken", function()
            local domain = ns.heirloomCensus(newHeirlooms({
                ids = { 122668 },
                rows = {
                    [122668] = {
                        name = "Bloodied Arcanite Reaper", slot = "INVTYPE_2HWEAPON",
                        upgrade = 4, maxUpgrade = 6, source = 3,
                    },
                },
                has = { [122668] = true },
            }))

            local id, held = domain.read(122668)

            assert.equal(122668, id)
            assert.same({
                name = "Bloodied Arcanite Reaper",
                slot = "INVTYPE_2HWEAPON",
                upgrade = 4,
                maxUpgrade = 6,
                source = 3,
            }, held)
        end)

        -- The same economy every count in this file keeps. Nought is what the client says for
        -- "never upgraded" and for "no ceiling known" alike, and every reader defaults these
        -- back to nought — so a key saying it is a saved file spent saying nothing.
        it("leaves out an upgrade level the client only reported as nought", function()
            local domain = ns.heirloomCensus(newHeirlooms({
                ids = { 122668 },
                rows = {
                    [122668] = {
                        name = "Bloodied Arcanite Reaper", slot = "INVTYPE_2HWEAPON",
                        upgrade = 0, maxUpgrade = 0, source = 3,
                    },
                },
                has = { [122668] = true },
            }))

            local _, held = domain.read(122668)

            assert.equal("Bloodied Arcanite Reaper", held.name)
            assert.is_nil(held.upgrade)
            assert.is_nil(held.maxUpgrade)
        end)

        -- An heirloom with no known ceiling is still an heirloom the account owns, and this is
        -- the only field of the row that costs a second call — so it is not required for the
        -- domain to exist.
        it("still describes heirlooms on a build with no ceiling call", function()
            local heirloom = newHeirlooms({
                ids = { 122668 },
                rows = {
                    [122668] = {
                        name = "Bloodied Arcanite Reaper", slot = "INVTYPE_2HWEAPON",
                        upgrade = 4, maxUpgrade = 6, source = 3,
                    },
                },
                has = { [122668] = true },
            })
            heirloom.GetHeirloomMaxUpgradeLevel = nil
            local domain = ns.heirloomCensus(heirloom)

            local id, held = domain.read(122668)

            assert.equal(122668, id)
            assert.equal(4, held.upgrade)
            assert.is_nil(held.maxUpgrade)
        end)

        -- It settles nothing — a partial domain is never audited into a pass of its own — but
        -- beside `held` it is what says how much of the answer a walk managed to reach, which
        -- is exactly the pair `ns.appearanceCensus` keeps.
        it("counts what the client says the account knows", function()
            local domain = ns.heirloomCensus(newHeirlooms({ ids = {}, known = 118 }))

            assert.equal(118, domain.count())
        end)

        it("offers no count at all on a build without the call", function()
            assert.is_nil(ns.heirloomCensus(newHeirlooms({ ids = {} })).count())
        end)
    end)

    describe("ns.titleCensus", function()
        ---A stand-in for the three bare globals a title is reached through.
        ---
        ---`known` and `titles` are kept apart on purpose. A mask the client knows but will not
        ---call a `playerTitle` is the case Blizzard's own paper doll pane refuses to draw, and a
        ---fake whose two halves always agreed could never express it.
        ---@param options table `{ count, known, titles }` — known the set of mask ids this
        ---character has earned, titles keyed by mask id as `{ text, player }`.
        ---@return table clients
        local function newTitles(options)
            return {
                count = function()
                    return options.count or 0
                end,
                known = function(id)
                    return (options.known or {})[id] or false
                end,
                name = function(id)
                    local title = (options.titles or {})[id]
                    if not title then
                        return nil
                    end
                    return title.text, title.player
                end,
            }
        end

        for _, case in ipairs({
            { what = "a client with no title calls at all", clients = nil },
            { what = "a client with no calls in the bundle", clients = {} },
            { what = "a build that will not say how big the range is", missing = "count" },
            { what = "a build that will not say what is known", missing = "known" },
            { what = "a build that will not name a mask", missing = "name" },
        }) do
            it("is not a domain on " .. case.what, function()
                local clients = case.clients
                if case.missing then
                    clients = newTitles({})
                    clients[case.missing] = nil
                end

                assert.is_nil(ns.titleCensus(clients))
            end)
        end

        -- A title is earned by whoever earned it — two alts of one account share almost none of
        -- them — so the wallet's rule applies exactly, and `GetNumTitles` is the top of the mask
        -- range rather than a count of anything held.
        it("walks the mask range as this character's own", function()
            local domain = ns.titleCensus(newTitles({ count = 3 }))

            assert.equal("titles", domain.name)
            assert.equal("character", domain.scope)
            assert.same({ 1, 2, 3 }, domain.list())
        end)

        it("says nothing about a mask this character has not earned", function()
            local domain = ns.titleCensus(newTitles({
                count = 1,
                known = {},
                titles = { [1] = { text = "the Explorer", player = true } },
            }))

            local id, held = domain.read(1)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- The `playerTitle` return is what Blizzard's own `PaperDollTitlesPane_Update` requires
        -- before it will draw a row: a mask the client knows but does not call a player title is
        -- not a title anybody can wear, and a list carrying one would disagree with the pane.
        it("says nothing about a mask the client will not call a player title", function()
            local domain = ns.titleCensus(newTitles({
                count = 1,
                known = { [1] = true },
                titles = { [1] = { text = "the Explorer", player = false } },
            }))

            local id, held = domain.read(1)

            assert.is_nil(id)
            assert.is_nil(held)
        end)

        -- The client hands these over already spaced for the player's name, and trimming alone
        -- would throw away the one thing the spacing said — so the side is kept as a flag rather
        -- than as a space nothing downstream would think to preserve.
        for _, case in ipairs({
            {
                what = "after the name", text = " the Explorer",
                name = "the Explorer", suffix = true,
            },
            { what = "before it", text = "Sergeant ", name = "Sergeant", suffix = nil },
        }) do
            it("stores a title trimmed, and says the client spaced it to go " .. case.what,
                function()
                    local domain = ns.titleCensus(newTitles({
                        count = 1,
                        known = { [1] = true },
                        titles = { [1] = { text = case.text, player = true } },
                    }))

                    local id, held = domain.read(1)

                    assert.equal(1, id)
                    assert.equal(case.name, held.name)
                    assert.equal(case.suffix, held.suffix)
                end)
        end

        -- What is left of a title that was nothing but the spacing is nothing at all, and a row
        -- with no name is a row nothing downstream could ever draw.
        for _, case in ipairs({
            { what = "empty", text = "" },
            { what = "nothing but space", text = "   " },
        }) do
            it("says nothing about a title string that is " .. case.what, function()
                local domain = ns.titleCensus(newTitles({
                    count = 1,
                    known = { [1] = true },
                    titles = { [1] = { text = case.text, player = true } },
                }))

                local id, held = domain.read(1)

                assert.is_nil(id)
                assert.is_nil(held)
            end)
        end

        -- Nothing in the client counts known titles. `GetNumTitles` is the size of the range and
        -- would sit permanently above `held` by an order of magnitude, which would provoke a
        -- pass at every login and change nothing each time.
        it("offers no counter, because nothing in the client counts what is known", function()
            assert.is_nil(ns.titleCensus(newTitles({})).count)
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

    describe("ns.appearanceCensus", function()
        ---A stand-in for `C_TransmogCollection`, answering about a category at a time.
        ---
        ---Two lengths on purpose. `GetCategoryTotal` is the client's *unfiltered* total, which
        ---is what the plan is drawn against; `GetCategoryAppearances` answers with what the
        ---class filter shows, which can only be shorter — so a category may hold rows the walk
        ---is planned for and never sees, which is the whole shape of this domain.
        ---@param categories table Keyed by category, each `{ total = n?, rows = { ... } }`.
        ---@return table collection
        local function newCollection(categories)
            local asked = {}
            return {
                asked = asked,
                GetCategoryInfo = function(category)
                    if not categories[category] then
                        return nil
                    end
                    return "Category " .. category, category > 11
                end,
                GetCategoryTotal = function(category)
                    local held = categories[category]
                    if not held then
                        return 0
                    end
                    return held.total or #held.rows
                end,
                GetCategoryAppearances = function(category)
                    asked[#asked + 1] = category
                    return (categories[category] or {}).rows
                end,
                GetCategoryCollectedCount = function(category)
                    return (categories[category] or {}).collected
                end,
            }
        end

        for _, case in ipairs({
            { what = "a client with no transmog collection at all", collection = nil },
            {
                what = "a build that will not answer about a category's appearances",
                collection = { GetCategoryInfo = print, GetCategoryTotal = print },
            },
            {
                what = "a build that cannot say which categories it has",
                collection = { GetCategoryAppearances = print, GetCategoryTotal = print },
            },
            {
                what = "a build that cannot say how deep a category is",
                collection = { GetCategoryAppearances = print, GetCategoryInfo = print },
            },
        }) do
            it("is not a domain on " .. case.what, function()
                assert.is_nil(ns.appearanceCensus(case.collection))
            end)
        end

        -- The claim this whole domain turns on. A walk of it is the logged-in character's share
        -- of the account's wardrobe and never the whole of it, so it must never be read as one:
        -- `partial` is what stops the collector pruning away another class's looks.
        it("says out loud that a walk of it is only ever part of an answer", function()
            local domain = ns.appearanceCensus(newCollection({}))

            assert.equal("appearances", domain.name)
            assert.equal("account", domain.scope)
            assert.is_true(domain.partial)
        end)

        it("plans a position for every appearance in every category the build has", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { rows = { {}, {}, {} } },
                [11] = { rows = { {}, {} } },
            }))

            assert.equal(5, #domain.list())
        end)

        it("plans nothing for a category this build does not have", function()
            local collection = newCollection({ [1] = { rows = { {} } } })

            assert.equal(1, #ns.appearanceCensus(collection).list())
        end)

        it("reads a position back out as the category and offset it stands for", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { rows = { { visualID = 1101, isCollected = true } } },
                [11] = { rows = { { visualID = 1201, isCollected = true } } },
            }))
            domain.list()

            local first, head = domain.read(1)
            local second, feet = domain.read(2)

            assert.equal(1101, first)
            assert.equal(1, head.category)
            assert.equal(1201, second)
            assert.equal(11, feet.category)
        end)

        -- What keeps `list` a handful of calls. The thirty category fetches are the expensive
        -- half of this walk, and they belong on the slices that consume them rather than in the
        -- one frame that draws the plan — so a category is asked about once, when the walk
        -- first reaches it, however many positions it then holds.
        it("asks the client about a category once, however many looks are in it", function()
            local collection = newCollection({
                [1] = { rows = { { visualID = 1 }, { visualID = 2 }, { visualID = 3 } } },
                [11] = { rows = { { visualID = 4 } } },
            })
            local domain = ns.appearanceCensus(collection)

            for _, position in ipairs(domain.list()) do
                domain.read(position)
            end

            assert.same({ 1, 11 }, collection.asked)
        end)

        it("says nothing about a look the account has not collected", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { rows = { { visualID = 1101, isCollected = false } } },
            }))
            domain.list()

            assert.is_nil(domain.read(1))
        end)

        -- The "hide helm" pseudo-looks. The client calls them collected and they answer to no
        -- appearance anybody owns, which is why Blizzard's own list drops them before drawing.
        it("says nothing about a hidden visual", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { rows = { { visualID = 1101, isCollected = true, isHideVisual = true } } },
            }))
            domain.list()

            assert.is_nil(domain.read(1))
        end)

        it("carries the player's own arrangement of a look through", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { rows = { { visualID = 1101, isCollected = true, isFavorite = true } } },
            }))
            domain.list()

            local id, look = domain.read(1)

            assert.equal(1101, id)
            assert.is_true(look.favourite)
        end)

        it("leaves the arrangement out where the player has not made one", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { rows = { { visualID = 1101, isCollected = true } } },
            }))
            domain.list()

            local _, look = domain.read(1)

            assert.is_nil(look.favourite)
        end)

        -- The class filter, in the one shape a test can see it: the plan is drawn against the
        -- unfiltered total and the answer is shorter than the plan, so the positions past the
        -- end of what this character was shown read nothing and take nothing away.
        it("reads nothing where the character was shown less than the category holds", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { total = 3, rows = { { visualID = 1101, isCollected = true } } },
            }))
            local positions = domain.list()

            assert.equal(3, #positions)
            assert.equal(1101, (domain.read(1)))
            assert.is_nil(domain.read(2))
            assert.is_nil(domain.read(3))
        end)

        it("says nothing about a position no plan was ever drawn for", function()
            local domain = ns.appearanceCensus(newCollection({ [1] = { rows = { {} } } }))

            assert.is_nil(domain.read(7))
        end)

        -- The unfiltered counter, which is the client's own opinion of how much of this the
        -- account has — against which `held` is how much of it the roster has managed to show.
        it("counts what the client says is collected across every category", function()
            local domain = ns.appearanceCensus(newCollection({
                [1] = { rows = {}, collected = 40 },
                [11] = { rows = {}, collected = 2 },
            }))

            assert.equal(42, domain.count())
        end)

        it("offers no count at all on a build without the call", function()
            local collection = newCollection({ [1] = { rows = {} } })
            collection.GetCategoryCollectedCount = nil

            assert.is_nil(ns.appearanceCensus(collection).count())
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
                pet = {
                    GetOwnedPetIDs = print,
                    GetPetInfoTableByPetID = print,
                    GetNumCollectedInfo = print,
                },
                toy = {
                    box = {
                        GetNumToys = print,
                        GetToyFromIndex = print,
                        GetToyInfo = print,
                    },
                    hasToy = print,
                },
                heirloom = {
                    GetHeirloomItemIDs = print,
                    GetHeirloomInfo = print,
                    PlayerHasHeirloom = print,
                },
                title = {
                    count = print,
                    known = print,
                    name = print,
                },
                currency = {
                    GetCurrencyInfo = print,
                },
                standing = {
                    reputation = { GetFactionDataByID = print },
                },
                collection = {
                    GetCategoryAppearances = print,
                    GetCategoryInfo = print,
                    GetCategoryTotal = print,
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
            assert.same({
                -- The four short walks first, none of them two thousand positions, then the
                -- five-thousand-id ranges, and the thirteen-thousand-call tree last.
                "mounts", "pets", "toys", "heirlooms", "titles",
                "currencies", "reputations", "appearances", "achievements",
            }, namesOf(ns.censusDomains(everything())))
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

            assert.same({
                "pets", "toys", "heirlooms", "titles",
                "currencies", "reputations", "appearances", "achievements",
            }, namesOf(ns.censusDomains(clients)))
        end)

        it("keeps the domains ahead of one this build cannot answer for", function()
            local clients = everything()
            clients.achievement = nil

            assert.same({
                "mounts", "pets", "toys", "heirlooms", "titles",
                "currencies", "reputations", "appearances",
            }, namesOf(ns.censusDomains(clients)))
        end)

        -- And the case that would actually catch it, now there is a domain with one on each
        -- side: a build with no `C_CurrencyInfo` leaves the reputations and achievements behind
        -- the gap and the mounts in front of it, rather than a list that stops where the
        -- currencies would be.
        it("keeps the domains on both sides of one this build cannot answer for", function()
            local clients = everything()
            clients.currency = nil

            assert.same({
                "mounts", "pets", "toys", "heirlooms", "titles",
                "reputations", "appearances", "achievements",
            }, namesOf(ns.censusDomains(clients)))
        end)

        -- And the same for one of the four short walks, which sit between the mounts and the
        -- ranges: a build with no toy box must leave the pets in front of the gap and the
        -- heirlooms behind it, rather than a list that stops where the toys would be.
        it("keeps the domains on both sides of a build with no toy box", function()
            local clients = everything()
            clients.toy = nil

            assert.same({
                "mounts", "pets", "heirlooms", "titles",
                "currencies", "reputations", "appearances", "achievements",
            }, namesOf(ns.censusDomains(clients)))
        end)

        -- The newest domain is reached through a bundle of namespaces rather than one, so a
        -- build without it is spelled by withholding the bundle — and the walk in front of it
        -- and the walk behind it both have to survive that.
        it("keeps the domains on both sides of a build with no reputation calls", function()
            local clients = everything()
            clients.standing = nil

            assert.same({
                "mounts", "pets", "toys", "heirlooms", "titles",
                "currencies", "appearances", "achievements",
            }, namesOf(ns.censusDomains(clients)))
        end)
    end)
end)
