local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newSegmentTable", function()
    local ns = loader.load()

    ---@return SegmentTable
    local function newTable(options)
        options = options or {}
        local classColor, classIconCoords = fake.newClassLook()
        return ns.newSegmentTable({
            classDisplay = ns.newClassDisplay({ classColor = classColor, classIconCoords = classIconCoords }),
            formatMoney = ns.formatMoney,
            onSegmentSelected = options.onSegmentSelected,
        })
    end

    local WARRIOR_ICON = "|TInterface\\TargetingFrame\\UI-Classes-Circles:14:14:0:0:256:256:0:64:0:64|t"

    ---How a warrior's name reaches a cell: the class icon, then the name wrapped in
    ---the class colour, exactly as ClassDisplay.decorate builds it.
    ---@param name string
    ---@return string
    local function warrior(name)
        return WARRIOR_ICON .. " |cffc79c6e" .. name .. "|r"
    end

    ---@param overrides table?
    ---@return SegmentRecord
    local function record(overrides)
        local base = {
            id = "Thrall-Ragnaros|1|Ulduar",
            character = "Thrall-Ragnaros",
            classFile = "WARRIOR",
            day = "2026-07-25",
            instance = "Ulduar",
            difficulty = "25 Player",
            instanceType = "raid",
            difficultyId = 4,
            startedAt = 1,
            endedAt = 1801,
            seconds = 1800,
            lootValue = 15000,
            goldDiff = 12000,
            transmogs = { { id = 19019, at = 100 }, { id = 17182, at = 200 } },
            currencyTotal = 15,
            reputationTotal = 40,
            currencies = { { id = 1166, name = "Timewarped Badge", amount = 15 } },
            reputation = { { faction = "Argent Dawn", amount = 40 } },
            achievements = {},
        }
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        return base
    end

    ---@param spec DetailSpec
    ---@param heading string
    ---@return DetailSection?
    local function sectionFor(spec, heading)
        for _, section in ipairs(spec.sections) do
            if section.heading == heading then
                return section
            end
        end
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newSegmentTable)
    end)

    describe("the spec it builds", function()
        it("names the retention window in the title", function()
            local spec = newTable().spec({})

            assert.equal("Segments — last 7 days", spec.title)
        end)

        it("leads with a totals section", function()
            local spec = newTable().spec({ record() })

            assert.equal("Totals", spec.sections[1].heading)
        end)

        it("says so plainly when nothing has been recorded", function()
            local spec = newTable().spec({})

            assert.equal(1, #spec.sections)
            assert.same({}, spec.sections[1].rows)
            assert.equal("No segments recorded yet.", spec.sections[1].empty)
        end)

        it("copes with being handed nothing at all", function()
            local spec = newTable().spec()

            assert.equal(1, #spec.sections)
        end)
    end)

    describe("filtering", function()
        local records = {
            record({ character = "Thrall-Ragnaros", day = "2026-07-25", instance = "Ulduar" }),
            record({ id = "b", character = "Jaina-Draenor", day = "2026-07-24", instance = "Deadmines" }),
            record({ id = "c", character = "Thrall-Ragnaros", day = "2026-07-24", instance = "Westfall" }),
        }

        it("filters by character, day, or location without case sensitivity", function()
            local segments = newTable()

            assert.equal(2, #segments.filter(records, { character = "thrall" }))
            assert.equal(2, #segments.filter(records, { day = "07-24" }))
            assert.equal(1, #segments.filter(records, { location = "DEAD" }))
        end)

        it("combines all active filters", function()
            local filtered = newTable().filter(records, {
                character = "thrall",
                day = "2026-07-24",
                location = "west",
            })

            assert.equal(1, #filtered)
            assert.equal("c", filtered[1].id)
        end)

        it("keeps every record when filters are blank", function()
            assert.equal(3, #newTable().filter(records, { character = "  " }))
        end)
    end)

    describe("a day's rows", function()
        it("gives each day its own section, in the order the records arrive", function()
            local spec = newTable().spec({
                record({ day = "2026-07-25" }),
                record({ day = "2026-07-24", id = "b" }),
            })

            assert.equal(3, #spec.sections)
            assert.is_truthy(spec.sections[2].heading:find("2026-07-25", 1, true))
            assert.is_truthy(spec.sections[3].heading:find("2026-07-24", 1, true))
        end)

        it("sums the day's segments and loot into its heading", function()
            local spec = newTable().spec({
                record({ lootValue = 15000 }),
                record({ id = "b", lootValue = 5000 }),
            })

            assert.equal("2026-07-25 — 2 segments, 2g 0s 0c", spec.sections[2].heading)
        end)

        it("says '1 segment' rather than '1 segments'", function()
            local spec = newTable().spec({ record({ lootValue = 0, goldDiff = 0 }) })

            assert.equal("2026-07-25 — 1 segment, 0c", spec.sections[2].heading)
        end)

        it("renders a segment as one line of cells", function()
            local spec = newTable().spec({ record() })

            assert.same({
                warrior("Thrall-Ragnaros"),
                "Ulduar",
                "25 Player",
                "30:00",
                "1g 50s 0c",
                "1g 20s 0c",
                "2",
                "+15",
                "+40",
            }, spec.sections[2].rows[1].cells)
        end)

        it("shows a negative gold difference with its sign", function()
            local spec = newTable().spec({ record({ goldDiff = -5000 }) })

            assert.equal("-50s 0c", spec.sections[2].rows[1].cells[6])
        end)

        it("dashes the difficulty the client never named", function()
            local spec = newTable().spec({ record({ difficulty = "" }) })

            assert.equal("—", spec.sections[2].rows[1].cells[3])
        end)

        it("dashes an empty currency cell", function()
            local spec = newTable().spec({ record({ currencies = {} }) })

            assert.equal("—", spec.sections[2].rows[1].cells[8])
        end)

        it("opens the selected segment when its row is clicked", function()
            local selected
            local visit = record()
            local spec = newTable({
                onSegmentSelected = function(value)
                    selected = value
                end,
            }).spec({ visit })

            spec.sections[2].rows[1].onClick()

            assert.equal(visit, selected)
        end)
    end)

    describe("the totals section", function()
        it("sums one line per character", function()
            local spec = newTable().spec({
                record({ lootValue = 15000, goldDiff = 10000, seconds = 1800 }),
                record({ id = "b", lootValue = 5000, goldDiff = 4000, seconds = 600, transmogs = { { id = 1 } } }),
                record({ id = "c", character = "Jaina-Draenor", classFile = "MAGE", lootValue = 100 }),
            })

            local totals = sectionFor(spec, "Totals")
            assert.equal(2, #totals.rows)
            assert.same({
                warrior("Thrall-Ragnaros"),
                "2 segments",
                "",
                "40:00",
                "2g 0s 0c",
                "1g 40s 0c",
                "3",
                "+30",
                "+80",
            }, totals.rows[1].cells)
        end)

        -- The question a player opens this for is "which character is worth playing", so
        -- the character with the richest haul of the week sits at the top.
        it("puts the character who looted most first", function()
            local spec = newTable().spec({
                record({ character = "Thrall-Ragnaros", lootValue = 100 }),
                record({ id = "b", character = "Jaina-Draenor", classFile = "MAGE", lootValue = 900 }),
            })

            local totals = sectionFor(spec, "Totals")
            assert.is_truthy(totals.rows[1].cells[1]:find("Jaina-Draenor", 1, true))
            assert.is_truthy(totals.rows[2].cells[1]:find("Thrall-Ragnaros", 1, true))
        end)

        it("sums a faction across segments", function()
            local spec = newTable().spec({
                record({ reputation = { { faction = "Argent Dawn", amount = 40 } } }),
                record({ id = "b", reputation = { { faction = "Argent Dawn", amount = 60 } } }),
            })

            assert.equal("+100", sectionFor(spec, "Totals").rows[1].cells[9])
        end)

        it("sums a currency across segments", function()
            local spec = newTable().spec({
                record({ currencies = { { id = 1166, name = "Timewarped Badge", amount = 15 } } }),
                record({ id = "b", currencies = { { id = 1166, name = "Timewarped Badge", amount = 5 } } }),
            })

            assert.equal("+20", sectionFor(spec, "Totals").rows[1].cells[8])
        end)

        it("dashes a character who earned no reputation at all", function()
            local spec = newTable().spec({ record({ reputation = {} }) })

            assert.equal("—", sectionFor(spec, "Totals").rows[1].cells[9])
        end)
    end)

    describe("formatDuration", function()
        it("renders under an hour as minutes and seconds", function()
            assert.equal("0:07", newTable().formatDuration(7))
            assert.equal("12:05", newTable().formatDuration(725))
        end)

        it("renders an hour or more as hours and minutes", function()
            assert.equal("1h 05m", newTable().formatDuration(3900))
            assert.equal("2h 00m", newTable().formatDuration(7200))
        end)

        it("floors a nil or negative duration at zero", function()
            assert.equal("0:00", newTable().formatDuration(nil))
            assert.equal("0:00", newTable().formatDuration(-10))
        end)
    end)

    describe("formatReputation", function()
        it("dashes an empty list", function()
            assert.equal("—", newTable().formatReputation({}))
            assert.equal("—", newTable().formatReputation(nil))
        end)

        it("sums reputation into one signed value", function()
            local segments = newTable()

            assert.equal("+40", segments.formatReputation({ { faction = "Argent Dawn", amount = 40 } }))
            assert.equal("+3", segments.formatReputation({
                { faction = "A", amount = 1 },
                { faction = "B", amount = 2 },
            }))
        end)

        it("stays compact when many factions turn up", function()
            local text = newTable().formatReputation({
                { faction = "A", amount = 1 },
                { faction = "B", amount = 2 },
                { faction = "C", amount = 3 },
                { faction = "D", amount = 4 },
            })

            assert.equal("+10", text)
        end)
    end)

    describe("formatCurrencies", function()
        it("dashes an empty list", function()
            assert.equal("—", newTable().formatCurrencies({}))
            assert.equal("—", newTable().formatCurrencies(nil))
        end)

        it("sums currencies into one signed value", function()
            assert.equal("+7", newTable().formatCurrencies({ { id = 1, name = "Honor", amount = 7 } }))
        end)

        it("shows a currency spend with its sign", function()
            assert.equal("-3", newTable().formatCurrencies({ { id = 2, name = "Valor", amount = -3 } }))
        end)

        it("stays compact when many currencies turn up", function()
            local text = newTable().formatCurrencies({
                { id = 1, name = "A", amount = 1 },
                { id = 2, name = "B", amount = 2 },
                { id = 3, name = "C", amount = 3 },
            })

            assert.equal("+6", text)
        end)
    end)
end)
