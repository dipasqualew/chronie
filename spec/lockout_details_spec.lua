local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newLockoutDetails", function()
    local ns = loader.load()

    local NOW = 1700000000
    local HOUR = 3600

    local READY = "|TInterface\\RaidFrame\\ReadyCheck-Ready:12|t"
    local WAITING = "|TInterface\\RaidFrame\\ReadyCheck-Waiting:12|t"
    local NOT_READY = "|TInterface\\RaidFrame\\ReadyCheck-NotReady:12|t"

    local AVAILABLE_COLOR = { 0.35, 1, 0.35 }
    local PARTIAL_COLOR = { 1, 0.82, 0 }
    local LOCKED_COLOR = { 1, 0.4, 0.4 }

    local NONE = "—"

    ---@param options table? `{ now = integer? }`
    ---@return table details, table clock
    local function newDetails(options)
        options = options or {}
        local clock = fake.newClock(options.now or NOW)
        local details = ns.newLockoutDetails({
            now = clock.now,
            lockoutTable = ns.newLockoutTable({ now = clock.now, formatDate = fake.newFormatDate() }),
        })
        return details, clock
    end

    ---@param overrides table?
    ---@return LockoutRow
    local function newRow(overrides)
        local row = {
            character = "Thrall-Ragnaros",
            instance = "Ulduar",
            difficultyId = 4,
            difficulty = "25 Player",
            maxPlayers = 25,
            isRaid = true,
            expiry = NOW + HOUR,
            encounters = {},
        }
        for key, value in pairs(overrides or {}) do
            row[key] = value
        end
        return row
    end

    ---@param killedFlags boolean[]
    ---@return table[]
    local function bosses(killedFlags)
        local encounters = {}
        for index, killed in ipairs(killedFlags) do
            encounters[index] = { name = "Boss " .. index, killed = killed }
        end
        return encounters
    end

    ---@param names string[]
    ---@return RosterEntry[]
    local function roster(names)
        local entries = {}
        for index, name in ipairs(names) do
            entries[index] = { character = name }
        end
        return entries
    end

    ---@param expiry integer
    ---@return string what the injected formatDate + lockoutTable produce for that expiry
    local function expiryText(expiry)
        local lockoutTable = ns.newLockoutTable({
            now = fake.newClock(NOW).now,
            formatDate = fake.newFormatDate(),
        })
        return lockoutTable.formatExpiry({ expiry = expiry })
    end

    ---@param section DetailSection
    ---@return string[]
    local function columnTitles(section)
        local titles = {}
        for index, entry in ipairs(section.columns) do
            titles[index] = entry.title
        end
        return titles
    end

    ---@param rows DetailRow[]
    ---@param columnIndex integer
    ---@return string[]
    local function column(rows, columnIndex)
        local values = {}
        for index, row in ipairs(rows) do
            values[index] = row.cells[columnIndex]
        end
        return values
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newLockoutDetails)
    end)

    describe("statusOf", function()
        it("reports a character with no lockout at all as available", function()
            local details = newDetails()

            assert.same({ state = "available", killed = 0, total = 0 }, details.statusOf(nil))
        end)

        describe("a lockout whose reset has come and gone", function()
            ---@type { name: string, expiry: integer }[]
            local lapsed = {
                { name = "expired an hour ago", expiry = NOW - HOUR },
                { name = "expired one second ago", expiry = NOW - 1 },
                -- The reset lands exactly on `now`: the lockout is gone, not still held.
                { name = "expiring at this very second", expiry = NOW },
            }

            for _, case in ipairs(lapsed) do
                it("is available when " .. case.name, function()
                    local details = newDetails()

                    local status = details.statusOf(newRow({
                        expiry = case.expiry,
                        encounters = bosses({ true, true }),
                    }))

                    assert.same({ state = "available", killed = 0, total = 0 }, status)
                end)
            end
        end)

        it("becomes available as the clock passes the expiry", function()
            local details, clock = newDetails()
            local row = newRow({ expiry = NOW + 10, encounters = bosses({ true }) })
            assert.equal("locked", details.statusOf(row).state)

            clock.advance(10)

            assert.equal("available", details.statusOf(row).state)
        end)

        describe("a live lockout", function()
            ---@type { name: string, killedFlags: boolean[], state: string, killed: integer, total: integer }[]
            local cases = {
                {
                    name = "with no encounters recorded",
                    killedFlags = {},
                    state = "locked",
                    killed = 0,
                    total = 0,
                },
                {
                    name = "with every boss killed",
                    killedFlags = { true, true, true },
                    state = "locked",
                    killed = 3,
                    total = 3,
                },
                {
                    name = "with a single boss killed",
                    killedFlags = { true },
                    state = "locked",
                    killed = 1,
                    total = 1,
                },
                {
                    name = "with some bosses killed",
                    killedFlags = { true, false, true, false },
                    state = "partial",
                    killed = 2,
                    total = 4,
                },
                {
                    name = "with no bosses killed yet",
                    killedFlags = { false, false },
                    state = "partial",
                    killed = 0,
                    total = 2,
                },
            }

            for _, case in ipairs(cases) do
                it("is " .. case.state .. " " .. case.name, function()
                    local details = newDetails()

                    local status = details.statusOf(newRow({ encounters = bosses(case.killedFlags) }))

                    assert.same({ state = case.state, killed = case.killed, total = case.total }, status)
                end)
            end
        end)

        -- Rows written before boss tracking shipped have no encounter list at all.
        it("treats a legacy row with no encounter field as locked with nothing known", function()
            local details = newDetails()
            local row = newRow()
            row.encounters = nil

            assert.same({ state = "locked", killed = 0, total = 0 }, details.statusOf(row))
        end)

        it("counts a truthy non-boolean kill flag as a kill", function()
            local details = newDetails()

            local status = details.statusOf(newRow({ encounters = { { name = "Lucifron", killed = 1 } } }))

            assert.same({ state = "locked", killed = 1, total = 1 }, status)
        end)
    end)

    describe("descriptorOf", function()
        it("derives the instance identity from the row", function()
            local details = newDetails()

            assert.same({
                key = "Ulduar\0" .. 4,
                instance = "Ulduar",
                difficultyId = 4,
                difficulty = "25 Player",
                isRaid = true,
            }, details.descriptorOf(newRow()))
        end)

        it("keys on difficultyId rather than the localised difficulty name", function()
            local details = newDetails()

            local english = details.descriptorOf(newRow({ difficulty = "25 Player" }))
            local german = details.descriptorOf(newRow({ difficulty = "25 Spieler" }))

            assert.equal(english.key, german.key)
        end)

        it("uses an empty difficulty when the client reported none", function()
            local details = newDetails()
            local row = newRow()
            row.difficulty = nil

            assert.equal("", details.descriptorOf(row).difficulty)
        end)

        it("normalises a truthy non-boolean isRaid to true", function()
            local details = newDetails()

            assert.is_true(details.descriptorOf(newRow({ isRaid = 1 })).isRaid)
        end)

        it("normalises a missing isRaid to false", function()
            local details = newDetails()
            local row = newRow()
            row.isRaid = nil

            assert.is_false(details.descriptorOf(row).isRaid)
        end)
    end)

    describe("instances", function()
        ---@param descriptors InstanceDescriptor[]
        ---@return string[] `"Instance/difficultyId"` for each descriptor, in order
        local function identities(descriptors)
            local list = {}
            for index, descriptor in ipairs(descriptors) do
                list[index] = descriptor.instance .. "/" .. tostring(descriptor.difficultyId)
            end
            return list
        end

        it("returns nothing for an empty list of rows", function()
            local details = newDetails()

            assert.same({}, details.instances({}))
        end)

        it("collapses the same instance and difficulty seen on two characters", function()
            local details = newDetails()

            local descriptors = details.instances({
                newRow({ character = "Thrall-Ragnaros" }),
                newRow({ character = "Jaina-Draenor" }),
            })

            assert.same({ "Ulduar/4" }, identities(descriptors))
        end)

        it("keeps the same instance at two difficulties apart", function()
            local details = newDetails()

            local descriptors = details.instances({
                newRow({ difficultyId = 4, difficulty = "25 Player" }),
                newRow({ difficultyId = 3, difficulty = "10 Player" }),
            })

            assert.same({ "Ulduar/3", "Ulduar/4" }, identities(descriptors))
        end)

        it("orders by instance name first", function()
            local details = newDetails()

            local descriptors = details.instances({
                newRow({ instance = "Ulduar" }),
                newRow({ instance = "Karazhan" }),
                newRow({ instance = "Naxxramas" }),
            })

            assert.same({ "Karazhan/4", "Naxxramas/4", "Ulduar/4" }, identities(descriptors))
        end)

        it("orders by difficultyId within one instance", function()
            local details = newDetails()

            local descriptors = details.instances({
                newRow({ instance = "Ulduar", difficultyId = 4 }),
                newRow({ instance = "Karazhan", difficultyId = 3 }),
                newRow({ instance = "Ulduar", difficultyId = 3 }),
            })

            assert.same({ "Karazhan/3", "Ulduar/3", "Ulduar/4" }, identities(descriptors))
        end)

        it("carries the descriptor fields through", function()
            local details = newDetails()

            local descriptors = details.instances({ newRow({ isRaid = false }) })

            assert.equal("25 Player", descriptors[1].difficulty)
            assert.is_false(descriptors[1].isRaid)
        end)
    end)

    describe("forInstance", function()
        ---@param details table
        ---@param rows LockoutRow[]
        ---@param names string[]
        ---@return DetailSpec
        local function specFor(details, rows, names)
            return details.forInstance(details.descriptorOf(newRow()), roster(names), rows)
        end

        it("lists every roster character exactly once", function()
            local details = newDetails()

            local spec = specFor(details, { newRow({ character = "Thrall-Ragnaros" }) }, {
                "Thrall-Ragnaros",
                "Jaina-Draenor",
                "Sylvanas-Draenor",
            })

            assert.equal(3, #spec.sections[1].rows)
        end)

        it("shows a character with no lockout for this instance as available", function()
            local details = newDetails()

            local spec = specFor(details, {}, { "Jaina-Draenor" })

            assert.same({
                READY .. " Jaina-Draenor",
                "Available",
                NONE,
                NONE,
            }, spec.sections[1].rows[1].cells)
        end)

        it("ignores a lockout belonging to a character outside the roster", function()
            local details = newDetails()

            local spec = specFor(details, { newRow({ character = "Ghost-Ragnaros" }) }, { "Jaina-Draenor" })

            assert.same({ READY .. " Jaina-Draenor" }, column(spec.sections[1].rows, 1))
        end)

        it("ignores a lockout for a different instance on the same character", function()
            local details = newDetails()

            local spec = specFor(details, {
                newRow({ character = "Thrall-Ragnaros", instance = "Karazhan" }),
            }, { "Thrall-Ragnaros" })

            assert.equal("Available", spec.sections[1].rows[1].cells[2])
        end)

        it("orders available, then partial, then locked", function()
            local details = newDetails()

            local spec = specFor(details, {
                newRow({ character = "Locked-Realm", encounters = bosses({ true, true }) }),
                newRow({ character = "Partial-Realm", encounters = bosses({ true, false }) }),
            }, { "Locked-Realm", "Partial-Realm", "Available-Realm" })

            assert.same({ "Available", "Partial", "Locked" }, column(spec.sections[1].rows, 2))
        end)

        it("orders alphabetically within one state", function()
            local details = newDetails()

            local spec = specFor(details, {}, { "Thrall-Ragnaros", "Jaina-Draenor", "Sylvanas-Draenor" })

            assert.same({
                READY .. " Jaina-Draenor",
                READY .. " Sylvanas-Draenor",
                READY .. " Thrall-Ragnaros",
            }, column(spec.sections[1].rows, 1))
        end)

        describe("the cells of one character", function()
            ---@type { name: string, row: table?, cells: string[], color: number[] }[]
            local cases = {
                {
                    name = "an untouched lockout",
                    row = { encounters = bosses({ false, false, false }) },
                    cells = { WAITING .. " Thrall-Ragnaros", "Partial", "3 of 3 left", expiryText(NOW + HOUR) },
                    color = PARTIAL_COLOR,
                },
                {
                    name = "a half-cleared lockout",
                    row = { encounters = bosses({ true, false, false }) },
                    cells = { WAITING .. " Thrall-Ragnaros", "Partial", "2 of 3 left", expiryText(NOW + HOUR) },
                    color = PARTIAL_COLOR,
                },
                {
                    name = "a fully cleared lockout",
                    row = { encounters = bosses({ true, true, true }) },
                    cells = { NOT_READY .. " Thrall-Ragnaros", "Locked", "3/3", expiryText(NOW + HOUR) },
                    color = LOCKED_COLOR,
                },
                {
                    name = "a lockout the client reported no bosses for",
                    row = { encounters = {} },
                    cells = { NOT_READY .. " Thrall-Ragnaros", "Locked", "no boss data", expiryText(NOW + HOUR) },
                    color = LOCKED_COLOR,
                },
                {
                    name = "a lockout that has already reset",
                    row = { expiry = NOW - HOUR, encounters = bosses({ true, true }) },
                    cells = { READY .. " Thrall-Ragnaros", "Available", NONE, NONE },
                    color = AVAILABLE_COLOR,
                },
                {
                    name = "no lockout at all",
                    row = nil,
                    cells = { READY .. " Thrall-Ragnaros", "Available", NONE, NONE },
                    color = AVAILABLE_COLOR,
                },
            }

            for _, case in ipairs(cases) do
                it("renders " .. case.name, function()
                    local details = newDetails()
                    local rows = case.row and { newRow(case.row) } or {}

                    local spec = specFor(details, rows, { "Thrall-Ragnaros" })

                    assert.same(case.cells, spec.sections[1].rows[1].cells)
                    assert.same(case.color, spec.sections[1].rows[1].color)
                end)
            end
        end)

        it("titles the panel with the instance and its difficulty", function()
            local details = newDetails()

            assert.equal("Ulduar — 25 Player", specFor(details, {}, {}).title)
        end)

        it("omits the dash when the descriptor carries no difficulty", function()
            local details = newDetails()
            local descriptor = details.descriptorOf(newRow())
            descriptor.difficulty = ""

            assert.equal("Ulduar", details.forInstance(descriptor, {}, {}).title)
        end)

        it("offers a single section of characters", function()
            local details = newDetails()

            local spec = specFor(details, {}, { "Thrall-Ragnaros" })

            assert.equal(1, #spec.sections)
            assert.equal("Characters", spec.sections[1].heading)
            assert.same({ "Character", "Status", "Bosses", "Resets" }, columnTitles(spec.sections[1]))
        end)

        it("falls back to an empty message when no characters are known", function()
            local details = newDetails()

            local spec = specFor(details, { newRow() }, {})

            assert.same({}, spec.sections[1].rows)
            assert.equal("No characters recorded yet.", spec.sections[1].empty)
        end)
    end)

    describe("forCharacter", function()
        ---@param spec DetailSpec
        ---@param heading string
        ---@return DetailSection
        local function sectionNamed(spec, heading)
            for _, section in ipairs(spec.sections) do
                if section.heading == heading then
                    return section
                end
            end
            error("no section headed " .. heading)
        end

        it("titles the panel with the character", function()
            local details = newDetails()

            assert.equal("Thrall-Ragnaros", details.forCharacter("Thrall-Ragnaros", {}).title)
        end)

        it("splits raids and dungeons into their own sections", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ instance = "Ulduar", isRaid = true }),
                newRow({ instance = "Deadmines", isRaid = false }),
            })

            assert.same({ "Raids", "Dungeons" }, { spec.sections[1].heading, spec.sections[2].heading })
            assert.same({ NOT_READY .. " Ulduar" }, column(sectionNamed(spec, "Raids").rows, 1))
            assert.same({ NOT_READY .. " Deadmines" }, column(sectionNamed(spec, "Dungeons").rows, 1))
        end)

        -- The whole point of the feature: an instance an alt is saved to must show up
        -- on every other character too, marked as still runnable.
        it("shows an instance only an alt is locked to as available", function()
            local details = newDetails()

            local spec = details.forCharacter("Jaina-Draenor", {
                newRow({ character = "Thrall-Ragnaros", encounters = bosses({ true }) }),
            })

            assert.same({
                READY .. " Ulduar",
                "25 Player",
                "Available",
                NONE,
                NONE,
            }, sectionNamed(spec, "Raids").rows[1].cells)
        end)

        it("orders available, then partial, then locked within a section", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ instance = "Locked Halls", encounters = bosses({ true }) }),
                newRow({ instance = "Partial Keep", encounters = bosses({ true, false }) }),
                newRow({ character = "Jaina-Draenor", instance = "Free Citadel" }),
            })

            assert.same({ "Available", "Partial", "Locked" }, column(sectionNamed(spec, "Raids").rows, 3))
        end)

        it("orders alphabetically within one state", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ character = "Jaina-Draenor", instance = "Ulduar" }),
                newRow({ character = "Jaina-Draenor", instance = "Karazhan" }),
                newRow({ character = "Jaina-Draenor", instance = "Naxxramas" }),
            })

            assert.same({
                READY .. " Karazhan",
                READY .. " Naxxramas",
                READY .. " Ulduar",
            }, column(sectionNamed(spec, "Raids").rows, 1))
        end)

        describe("the progress cell", function()
            ---@type { name: string, row: table, progress: string, reset: boolean }[]
            local cases = {
                {
                    name = "counts what is left of a partial clear",
                    row = { encounters = bosses({ true, false, false, false }) },
                    progress = "3 of 4 left",
                    reset = true,
                },
                {
                    name = "counts kills out of the total once fully locked",
                    row = { encounters = bosses({ true, true }) },
                    progress = "2/2",
                    reset = true,
                },
                {
                    name = "admits when the client reported no bosses",
                    row = { encounters = {} },
                    progress = "no boss data",
                    reset = true,
                },
                {
                    name = "shows nothing for an instance that has reset",
                    row = { expiry = NOW - 1, encounters = bosses({ true, true }) },
                    progress = NONE,
                    reset = false,
                },
            }

            for _, case in ipairs(cases) do
                it(case.name, function()
                    local details = newDetails()
                    local row = newRow(case.row)

                    local spec = details.forCharacter("Thrall-Ragnaros", { row })
                    local cells = sectionNamed(spec, "Raids").rows[1].cells

                    assert.equal(case.progress, cells[4])
                    assert.equal(case.reset and expiryText(row.expiry) or NONE, cells[5])
                end)
            end
        end)

        it("shows the difficulty in its own column", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ difficulty = "10 Player", difficultyId = 3 }),
            })

            assert.equal("10 Player", sectionNamed(spec, "Raids").rows[1].cells[2])
        end)

        it("colours each line by its state", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ instance = "Locked Halls", encounters = bosses({ true }) }),
                newRow({ instance = "Partial Keep", encounters = bosses({ true, false }) }),
                newRow({ character = "Jaina-Draenor", instance = "Free Citadel" }),
            })

            local colors = {}
            for index, row in ipairs(sectionNamed(spec, "Raids").rows) do
                colors[index] = row.color
            end
            assert.same({ AVAILABLE_COLOR, PARTIAL_COLOR, LOCKED_COLOR }, colors)
        end)

        it("carries an empty message on both sections when nothing is known", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {})

            assert.same({}, spec.sections[1].rows)
            assert.same({}, spec.sections[2].rows)
            assert.equal("No raids recorded yet.", spec.sections[1].empty)
            assert.equal("No dungeons recorded yet.", spec.sections[2].empty)
        end)

        it("still carries the dungeon empty message when only raids are known", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", { newRow({ isRaid = true }) })

            assert.equal(1, #sectionNamed(spec, "Raids").rows)
            assert.same({}, sectionNamed(spec, "Dungeons").rows)
            assert.equal("No dungeons recorded yet.", sectionNamed(spec, "Dungeons").empty)
        end)

        it("gives both sections the same five columns", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {})

            assert.same({ "Instance", "Difficulty", "Status", "Bosses", "Resets" }, columnTitles(spec.sections[1]))
            assert.same(spec.sections[1].columns, spec.sections[2].columns)
        end)
    end)
end)
