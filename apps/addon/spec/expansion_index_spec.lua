local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newExpansionIndex", function()
    local ns = loader.load()

    ---What an instance no tier claims is drawn in.
    local UNKNOWN_COLOR = { 0.6, 0.6, 0.6 }

    ---Tier order is expansion order, so the index into this list is the tier number.
    local ABBREVIATIONS = {
        "Classic", "TBC", "WotLK", "Cata", "MoP", "WoD",
        "Legion", "BfA", "SL", "DF", "TWW", "Midnight",
    }

    ---@param tiers table[]?
    ---@return ExpansionIndex expansions
    ---@return table recorded `{ selected = integer[], current = fun(): integer }`
    ---@return table journal the fake, so a test can drive the selection itself
    local function newIndex(tiers)
        -- The fake's shape is exactly ExpansionIndexDeps, which is the point of it.
        local journal, recorded = fake.newEncounterJournal(tiers)
        return ns.newExpansionIndex(journal), recorded, journal
    end

    ---One tier per known abbreviation, each holding a single raid named after its tier.
    ---@return table[]
    local function everyTier()
        local tiers = {}
        for tier = 1, #ABBREVIATIONS do
            tiers[tier] = { name = "Tier " .. tier, raids = { "Raid " .. tier } }
        end
        return tiers
    end

    ---@param display ExpansionIndex
    ---@param instance string
    ---@return number[] `{ r, g, b }`
    local function colorTriple(display, instance)
        local r, g, b = display.colorOf(instance)
        return { r, g, b }
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newExpansionIndex)
    end)

    describe("forInstance", function()
        it("describes the expansion a raid shipped in", function()
            local expansions = newIndex({
                { name = "Classic", raids = { "Molten Core" } },
                { name = "The Burning Crusade", raids = { "Karazhan" } },
                { name = "Wrath of the Lich King", raids = { "Ulduar" } },
            })

            assert.same({
                tier = 3,
                name = "Wrath of the Lich King",
                abbreviation = "WotLK",
                color = { 0.45, 0.78, 0.95 },
            }, expansions.forInstance("Ulduar"))
        end)

        it("finds a dungeon as readily as a raid", function()
            local expansions = newIndex({
                { name = "Classic", raids = { "Molten Core" }, dungeons = { "Deadmines" } },
            })

            assert.equal(1, expansions.forInstance("Deadmines").tier)
        end)

        it("reads a tier that lists only dungeons", function()
            local expansions = newIndex({ { name = "Classic", dungeons = { "Deadmines" } } })

            assert.equal("Classic", expansions.forInstance("Deadmines").abbreviation)
        end)

        it("knows nothing about an instance no tier lists", function()
            local expansions = newIndex(everyTier())

            assert.is_nil(expansions.forInstance("Karazhan"))
        end)

        it("knows nothing at all when the journal is empty", function()
            local expansions = newIndex({})

            assert.is_nil(expansions.forInstance("Ulduar"))
        end)

        -- Blizzard relists a handful of instances under a later tier when they are
        -- revisited; the expansion that shipped them is still the honest answer.
        it("keeps the earliest tier when two tiers list the same instance", function()
            local expansions = newIndex({
                { name = "Classic", raids = { "Naxxramas" } },
                { name = "The Burning Crusade", raids = { "Karazhan" } },
                { name = "Wrath of the Lich King", raids = { "Naxxramas" } },
            })

            assert.equal(1, expansions.forInstance("Naxxramas").tier)
            assert.equal("Classic", expansions.forInstance("Naxxramas").abbreviation)
        end)

        it("prefers the earliest tier even when the later listing is a dungeon", function()
            local expansions = newIndex({
                { name = "Classic", raids = { "Scholomance" } },
                { name = "Mists of Pandaria", dungeons = { "Scholomance" } },
            })

            assert.equal(1, expansions.forInstance("Scholomance").tier)
        end)
    end)

    describe("abbreviationFor", function()
        for tier, abbreviation in ipairs(ABBREVIATIONS) do
            it("tags tier " .. tier .. " as " .. abbreviation, function()
                local expansions = newIndex(everyTier())

                assert.equal(abbreviation, expansions.abbreviationFor("Raid " .. tier))
            end)
        end

        -- A tier newer than this build knows about: the client's own name for it is
        -- better than an invented tag or a blank cell.
        it("falls back to the localised tier name for a tier past the known list", function()
            local tiers = everyTier()
            tiers[#ABBREVIATIONS + 1] = { name = "The Last Titan", raids = { "Ny'alotha II" } }
            local expansions = newIndex(tiers)

            assert.equal("The Last Titan", expansions.abbreviationFor("Ny'alotha II"))
        end)

        it("falls back to the tier number when the client names no tier either", function()
            local tiers = everyTier()
            tiers[#ABBREVIATIONS + 1] = { raids = { "Ny'alotha II" } }
            local expansions = newIndex(tiers)

            assert.equal(tostring(#ABBREVIATIONS + 1), expansions.abbreviationFor("Ny'alotha II"))
        end)

        it("keeps the known tag when the client names no tier", function()
            local expansions = newIndex({ { raids = { "Molten Core" } } })

            assert.equal("Classic", expansions.abbreviationFor("Molten Core"))
        end)

        it("says nothing about an instance no tier lists", function()
            local expansions = newIndex(everyTier())

            assert.equal("", expansions.abbreviationFor("Karazhan"))
        end)
    end)

    describe("colorOf", function()
        ---@type { tier: integer, color: number[] }[]
        local cases = {
            { tier = 1, color = { 0.78, 0.72, 0.55 } },
            { tier = 3, color = { 0.45, 0.78, 0.95 } },
            { tier = 12, color = { 0.70, 0.45, 0.90 } },
        }

        for _, case in ipairs(cases) do
            it("colours tier " .. case.tier .. " with its own tag colour", function()
                local expansions = newIndex(everyTier())

                assert.same(case.color, colorTriple(expansions, "Raid " .. case.tier))
            end)
        end

        it("greys an instance no tier lists", function()
            local expansions = newIndex(everyTier())

            assert.same(UNKNOWN_COLOR, colorTriple(expansions, "Karazhan"))
        end)

        it("greys a tier past the known list", function()
            local tiers = everyTier()
            tiers[#ABBREVIATIONS + 1] = { name = "The Last Titan", raids = { "Ny'alotha II" } }
            local expansions = newIndex(tiers)

            assert.same(UNKNOWN_COLOR, colorTriple(expansions, "Ny'alotha II"))
        end)
    end)

    describe("tagFor", function()
        ---@type { tier: integer, tag: string }[]
        local cases = {
            { tier = 1, tag = "|cffc7b88cClassic|r" },
            { tier = 3, tag = "|cff73c7f2WotLK|r" },
            { tier = 11, tag = "|cff8c80d9TWW|r" },
        }

        for _, case in ipairs(cases) do
            it("colours the tag for tier " .. case.tier .. " inline", function()
                local expansions = newIndex(everyTier())

                assert.equal(case.tag, expansions.tagFor("Raid " .. case.tier))
            end)
        end

        it("greys the fallback tag of a tier past the known list", function()
            local tiers = everyTier()
            tiers[#ABBREVIATIONS + 1] = { name = "The Last Titan", raids = { "Ny'alotha II" } }
            local expansions = newIndex(tiers)

            assert.equal("|cff999999The Last Titan|r", expansions.tagFor("Ny'alotha II"))
        end)

        -- An empty string rather than a colour code, so the cell is genuinely blank.
        it("says nothing about an instance no tier lists", function()
            local expansions = newIndex(everyTier())

            assert.equal("", expansions.tagFor("Karazhan"))
        end)
    end)

    describe("walking the Encounter Journal", function()
        it("does not touch the journal until an instance is looked up", function()
            local _, recorded = newIndex(everyTier())

            assert.same({}, recorded.selected)
        end)

        it("selects every tier in turn, then puts the selection back", function()
            local expansions, recorded = newIndex(everyTier())

            expansions.abbreviationFor("Raid 1")

            local expected = {}
            for tier = 1, #ABBREVIATIONS do
                expected[tier] = tier
            end
            expected[#ABBREVIATIONS + 1] = 1
            assert.same(expected, recorded.selected)
        end)

        -- Walking the journal moves global UI state. A player who left the Adventure
        -- Guide on Legion must find it on Legion.
        it("restores the tier the player had selected", function()
            local expansions, recorded, journal = newIndex(everyTier())
            journal.selectTier(7)

            expansions.abbreviationFor("Raid 1")

            assert.equal(7, recorded.current())
        end)

        it("walks the journal once however many instances are looked up", function()
            local expansions, recorded = newIndex(everyTier())
            expansions.abbreviationFor("Raid 1")
            local afterFirst = #recorded.selected

            expansions.forInstance("Raid 2")
            expansions.colorOf("Raid 3")
            expansions.tagFor("Raid 4")

            assert.equal(afterFirst, #recorded.selected)
        end)

        -- A miss is an answer too, and re-walking the journal on every unknown instance
        -- would repaint the table at the cost of a full journal sweep per row.
        it("does not walk the journal again after a lookup that found nothing", function()
            local expansions, recorded = newIndex(everyTier())
            expansions.abbreviationFor("Karazhan")
            local afterFirst = #recorded.selected

            expansions.abbreviationFor("Karazhan")

            assert.equal(afterFirst, #recorded.selected)
        end)

        it("caches even an empty journal rather than retrying it", function()
            local expansions, recorded = newIndex({})

            expansions.abbreviationFor("Ulduar")
            local afterFirst = #recorded.selected
            expansions.abbreviationFor("Ulduar")

            assert.equal(afterFirst, #recorded.selected)
        end)
    end)
end)
