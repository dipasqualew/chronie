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

    ---The class art and colour the fakes publish for a mage, which is the one class
    ---these tests dress a character in.
    local MAGE_ICON = "|TInterface\\TargetingFrame\\UI-Classes-Circles:14:14:0:0:256:256:64:127:0:64|t"
    local MAGE_CODE = "|cff40c7eb"

    ---@param name string
    ---@return string the character cell text a mage's name is expected to render as
    local function asMage(name)
        return MAGE_ICON .. " " .. MAGE_CODE .. name .. "|r"
    end

    ---By default the journal is empty, so no activity has an expansion and the
    ---expansion cells stay blank; a test that cares passes `tiers`.
    ---@param options table? `{ now = integer?, tiers = table[]? }`
    ---@return table details, table clock
    local function newDetails(options)
        options = options or {}
        local clock = fake.newClock(options.now or NOW)
        local journal = fake.newEncounterJournal(options.tiers)
        local classColor, classIconCoords = fake.newClassLook()
        local details = ns.newLockoutDetails({
            now = clock.now,
            lockoutTable = ns.newLockoutTable({ now = clock.now, formatDate = fake.newFormatDate() }),
            classDisplay = ns.newClassDisplay({ classColor = classColor, classIconCoords = classIconCoords }),
            expansions = ns.newExpansionIndex(journal),
        })
        return details, clock
    end

    ---The journal a test passes when it wants Ulduar and Deadmines placed in an
    ---expansion. Karazhan is deliberately left off every tier, as the unknown case.
    local TIERS = {
        { name = "Classic", dungeons = { "Deadmines" } },
        { name = "The Burning Crusade" },
        { name = "Wrath of the Lich King", raids = { "Ulduar" } },
    }
    local WOTLK_TAG = "|cff73c7f2WotLK|r"
    local CLASSIC_TAG = "|cffc7b88cClassic|r"

    ---Rows as the store hands them out: the activity key, kind and cadence are derived
    ---from the activity name unless a test says otherwise, so a test only has to name the
    ---one thing it is about.
    ---@param overrides table?
    ---@return LockoutRow
    local function newRow(overrides)
        local row = {
            character = "Thrall-Ragnaros",
            activity = "Ulduar",
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
        row.key = row.key or ("instance\0" .. row.activity)
        row.kind = row.kind or (row.isRaid and "raid" or "dungeon")
        row.period = row.period or "weekly"
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

    ---Entries carry no class unless the test names one: most of these tests are about
    ---lockout state, and a character we never learned the class of is the common case.
    ---@param names (string|table)[] a bare name, or `{ character = ..., classFile = ... }`
    ---@return RosterEntry[]
    local function roster(names)
        local entries = {}
        for index, name in ipairs(names) do
            entries[index] = type(name) == "table" and name or { character = name }
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
        it("derives the activity identity from the row", function()
            local details = newDetails()

            assert.same({
                key = "instance\0Ulduar",
                activity = "Ulduar",
                kind = "raid",
                period = "weekly",
                difficultyId = 4,
                difficulty = "25 Player",
                isRaid = true,
            }, details.descriptorOf(newRow()))
        end)

        it("keys on the activity alone, so both difficulties share one identity", function()
            local details = newDetails()

            local tenPlayer = details.descriptorOf(newRow({ difficultyId = 3, difficulty = "10 Player" }))
            local twentyFive = details.descriptorOf(newRow({ difficultyId = 4, difficulty = "25 Player" }))

            assert.equal(tenPlayer.key, twentyFive.key)
        end)

        it("keys independently of the localised difficulty name", function()
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

    describe("activities", function()
        ---@param descriptors ActivityDescriptor[]
        ---@return string[] the name of each descriptor, in order
        local function identities(descriptors)
            local list = {}
            for index, descriptor in ipairs(descriptors) do
                list[index] = descriptor.activity
            end
            return list
        end

        it("returns nothing for an empty list of rows", function()
            local details = newDetails()

            assert.same({}, details.activities({}))
        end)

        it("collapses the same activity and difficulty seen on two characters", function()
            local details = newDetails()

            local descriptors = details.activities({
                newRow({ character = "Thrall-Ragnaros" }),
                newRow({ character = "Jaina-Draenor" }),
            })

            assert.same({ "Ulduar" }, identities(descriptors))
        end)

        it("collapses two difficulties of one activity into a single entry", function()
            local details = newDetails()

            local descriptors = details.activities({
                newRow({ difficultyId = 4, difficulty = "25 Player" }),
                newRow({ difficultyId = 3, difficulty = "10 Player" }),
            })

            assert.same({ "Ulduar" }, identities(descriptors))
        end)

        it("orders by activity name first", function()
            local details = newDetails()

            local descriptors = details.activities({
                newRow({ activity = "Ulduar" }),
                newRow({ activity = "Karazhan" }),
                newRow({ activity = "Naxxramas" }),
            })

            assert.same({ "Karazhan", "Naxxramas", "Ulduar" }, identities(descriptors))
        end)

        it("orders by activity when the same activity appears at several difficulties", function()
            local details = newDetails()

            local descriptors = details.activities({
                newRow({ activity = "Ulduar", difficultyId = 4 }),
                newRow({ activity = "Karazhan", difficultyId = 3 }),
                newRow({ activity = "Ulduar", difficultyId = 3 }),
            })

            assert.same({ "Karazhan", "Ulduar" }, identities(descriptors))
        end)

        it("carries the descriptor fields through", function()
            local details = newDetails()

            local descriptors = details.activities({ newRow({ isRaid = false }) })

            assert.equal("25 Player", descriptors[1].difficulty)
            assert.is_false(descriptors[1].isRaid)
        end)
    end)

    describe("forActivity", function()
        ---@param details table
        ---@param rows LockoutRow[]
        ---@param names string[]
        ---@return DetailSpec
        local function specFor(details, rows, names)
            return details.forActivity(details.descriptorOf(newRow()), roster(names), rows)
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

        it("shows a character with no lockout for this activity as available", function()
            local details = newDetails()

            local spec = specFor(details, {}, { "Jaina-Draenor" })

            assert.same({
                READY .. " Jaina-Draenor",
                "Available",
                NONE,
                NONE,
                NONE,
            }, spec.sections[1].rows[1].cells)
        end)

        it("shows a character locked at the sibling difficulty as locked, not available", function()
            local details = newDetails()

            -- The descriptor comes from a 25 Player row; Thrall is saved to 10 Player.
            -- One raid ID covers both, so he cannot go in either.
            local spec = specFor(details, {
                newRow({
                    character = "Thrall-Ragnaros",
                    difficultyId = 3,
                    difficulty = "10 Player",
                    encounters = bosses({ true, true }),
                }),
            }, { "Thrall-Ragnaros" })

            assert.same({
                NOT_READY .. " Thrall-Ragnaros",
                "Locked",
                "10 Player",
                "2/2",
                expiryText(NOW + HOUR),
            }, spec.sections[1].rows[1].cells)
        end)

        it("speaks for a character saved at both difficulties with the later reset", function()
            local details = newDetails()

            local spec = specFor(details, {
                newRow({
                    character = "Thrall-Ragnaros",
                    difficultyId = 3,
                    difficulty = "10 Player",
                    expiry = NOW + HOUR,
                    encounters = bosses({ true, false }),
                }),
                newRow({
                    character = "Thrall-Ragnaros",
                    difficultyId = 4,
                    difficulty = "25 Player",
                    expiry = NOW + HOUR * 2,
                    encounters = bosses({ true, true }),
                }),
            }, { "Thrall-Ragnaros" })

            assert.same({
                NOT_READY .. " Thrall-Ragnaros",
                "Locked",
                "25 Player",
                "2/2",
                expiryText(NOW + HOUR * 2),
            }, spec.sections[1].rows[1].cells)
        end)

        it("ignores a lockout belonging to a character outside the roster", function()
            local details = newDetails()

            local spec = specFor(details, { newRow({ character = "Ghost-Ragnaros" }) }, { "Jaina-Draenor" })

            assert.same({ READY .. " Jaina-Draenor" }, column(spec.sections[1].rows, 1))
        end)

        it("ignores a lockout for a different activity on the same character", function()
            local details = newDetails()

            local spec = specFor(details, {
                newRow({ character = "Thrall-Ragnaros", activity = "Karazhan" }),
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
                    cells = {
                        WAITING .. " Thrall-Ragnaros", "Partial", "25 Player", "3 of 3 left", expiryText(NOW + HOUR),
                    },
                    color = PARTIAL_COLOR,
                },
                {
                    name = "a half-cleared lockout",
                    row = { encounters = bosses({ true, false, false }) },
                    cells = {
                        WAITING .. " Thrall-Ragnaros", "Partial", "25 Player", "2 of 3 left", expiryText(NOW + HOUR),
                    },
                    color = PARTIAL_COLOR,
                },
                {
                    name = "a fully cleared lockout",
                    row = { encounters = bosses({ true, true, true }) },
                    cells = {
                        NOT_READY .. " Thrall-Ragnaros", "Locked", "25 Player", "3/3", expiryText(NOW + HOUR),
                    },
                    color = LOCKED_COLOR,
                },
                {
                    name = "a lockout the client reported no bosses for",
                    row = { encounters = {} },
                    cells = {
                        NOT_READY .. " Thrall-Ragnaros", "Locked", "25 Player", "no boss data", expiryText(NOW + HOUR),
                    },
                    color = LOCKED_COLOR,
                },
                {
                    name = "a lockout that has already reset",
                    row = { expiry = NOW - HOUR, encounters = bosses({ true, true }) },
                    cells = { READY .. " Thrall-Ragnaros", "Available", NONE, NONE, NONE },
                    color = AVAILABLE_COLOR,
                },
                {
                    name = "no lockout at all",
                    row = nil,
                    cells = { READY .. " Thrall-Ragnaros", "Available", NONE, NONE, NONE },
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

        it("titles the panel with the activity alone, since it covers every difficulty", function()
            local details = newDetails()

            assert.equal("Weekly — Ulduar", specFor(details, {}, {}).title)
        end)

        it("titles the panel the same whichever difficulty the descriptor came from", function()
            local details = newDetails()
            local descriptor = details.descriptorOf(newRow({ difficultyId = 3, difficulty = "10 Player" }))

            assert.equal("Weekly — Ulduar", details.forActivity(descriptor, {}, {}).title)
        end)

        -- The cadence leads the title because it is the one fact on the panel that belongs
        -- to the activity rather than to any character's save of it.
        it("leads the title with the cadence the activity resets on", function()
            local details = newDetails()
            local descriptor = details.descriptorOf(newRow({ period = "daily" }))

            assert.equal("Daily — Ulduar", details.forActivity(descriptor, {}, {}).title)
        end)

        it("says nothing about the cadence while it is still unknown", function()
            local details = newDetails()
            local descriptor = details.descriptorOf(newRow({ period = "unknown" }))

            assert.equal("Ulduar", details.forActivity(descriptor, {}, {}).title)
        end)

        it("prefixes the title with the expansion tag once the journal places it", function()
            local details = newDetails({ tiers = TIERS })

            assert.equal("Weekly — " .. WOTLK_TAG .. " Ulduar", specFor(details, {}, {}).title)
        end)

        it("leaves the title unprefixed for an activity the journal never lists", function()
            local details = newDetails({ tiers = TIERS })
            local descriptor = details.descriptorOf(newRow({ activity = "Karazhan" }))

            assert.equal("Weekly — Karazhan", details.forActivity(descriptor, {}, {}).title)
        end)

        -- The cell colour already carries the lockout state, so the class has to be
        -- said inline or not at all.
        it("colours a known class inline, leaving the cell to the lockout state", function()
            local details = newDetails()

            local spec = specFor(details, {}, { { character = "Jaina-Draenor", classFile = "MAGE" } })

            assert.equal(READY .. " " .. asMage("Jaina-Draenor"), spec.sections[1].rows[1].cells[1])
            assert.same(AVAILABLE_COLOR, spec.sections[1].rows[1].color)
        end)

        it("still marks a locked character's class, without touching the state colour", function()
            local details = newDetails()

            local spec = specFor(details, { newRow({ character = "Jaina-Draenor" }) }, {
                { character = "Jaina-Draenor", classFile = "MAGE" },
            })

            assert.equal(NOT_READY .. " " .. asMage("Jaina-Draenor"), spec.sections[1].rows[1].cells[1])
            assert.same(LOCKED_COLOR, spec.sections[1].rows[1].color)
        end)

        it("leaves a character whose class was never recorded undecorated", function()
            local details = newDetails()

            local spec = specFor(details, {}, { { character = "Jaina-Draenor" } })

            assert.equal(READY .. " Jaina-Draenor", spec.sections[1].rows[1].cells[1])
        end)

        it("still sorts on the plain name, not the markup wrapped around it", function()
            local details = newDetails()

            local spec = specFor(details, {}, {
                { character = "Zeppelin-Draenor", classFile = "MAGE" },
                { character = "Alleria-Draenor" },
            })

            assert.same({
                READY .. " Alleria-Draenor",
                READY .. " " .. asMage("Zeppelin-Draenor"),
            }, column(spec.sections[1].rows, 1))
        end)

        it("offers a single section of characters", function()
            local details = newDetails()

            local spec = specFor(details, {}, { "Thrall-Ragnaros" })

            assert.equal(1, #spec.sections)
            assert.equal("Characters", spec.sections[1].heading)
            assert.same({ "Character", "Status", "Difficulty", "Bosses", "Resets" }, columnTitles(spec.sections[1]))
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

        -- The class lives on the rows rather than being passed in, so the title has to
        -- go looking for it.
        it("dresses the title in the class carried by that character's rows", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ character = "Thrall-Ragnaros", classFile = "MAGE" }),
            })

            assert.equal(asMage("Thrall-Ragnaros"), spec.title)
        end)

        it("ignores the class of every other character's rows", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ character = "Jaina-Draenor", classFile = "MAGE" }),
            })

            assert.equal("Thrall-Ragnaros", spec.title)
        end)

        -- A character saved before class tokens were recorded still has rows; they
        -- just cannot say what it is.
        it("leaves the title bare when no row knows the character's class", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ character = "Thrall-Ragnaros" }),
            })

            assert.equal("Thrall-Ragnaros", spec.title)
        end)

        it("takes the class from a later row when the first one lacks it", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ character = "Thrall-Ragnaros", activity = "Ulduar" }),
                newRow({ character = "Thrall-Ragnaros", activity = "Karazhan", classFile = "MAGE" }),
            })

            assert.equal(asMage("Thrall-Ragnaros"), spec.title)
        end)

        it("splits raids and dungeons into their own sections", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ activity = "Ulduar", isRaid = true }),
                newRow({ activity = "Deadmines", isRaid = false }),
            })

            assert.same({ "Raids", "Dungeons" }, { spec.sections[1].heading, spec.sections[2].heading })
            assert.same({ NOT_READY .. " Ulduar" }, column(sectionNamed(spec, "Raids").rows, 1))
            assert.same({ NOT_READY .. " Deadmines" }, column(sectionNamed(spec, "Dungeons").rows, 1))
        end)

        -- The whole point of the feature: an activity an alt is saved to must show up
        -- on every other character too, marked as still runnable.
        it("shows an activity only an alt is locked to as available", function()
            local details = newDetails()

            local spec = details.forCharacter("Jaina-Draenor", {
                newRow({ character = "Thrall-Ragnaros", encounters = bosses({ true }) }),
            })

            -- The difficulty column describes this character's own save, and Jaina has
            -- none: the alt's 25 Player lockout says nothing about which size she can run.
            assert.same({
                READY .. " Ulduar",
                "",
                NONE,
                "Available",
                NONE,
                NONE,
            }, sectionNamed(spec, "Raids").rows[1].cells)
        end)

        it("tags each activity with its expansion", function()
            local details = newDetails({ tiers = TIERS })

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ activity = "Ulduar", isRaid = true }),
                newRow({ activity = "Deadmines", isRaid = false }),
            })

            assert.same({ WOTLK_TAG }, column(sectionNamed(spec, "Raids").rows, 2))
            assert.same({ CLASSIC_TAG }, column(sectionNamed(spec, "Dungeons").rows, 2))
        end)

        it("leaves the expansion blank for an activity the journal never lists", function()
            local details = newDetails({ tiers = TIERS })

            local spec = details.forCharacter("Thrall-Ragnaros", { newRow({ activity = "Karazhan" }) })

            assert.equal("", sectionNamed(spec, "Raids").rows[1].cells[2])
        end)

        it("orders available, then partial, then locked within a section", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ activity = "Locked Halls", encounters = bosses({ true }) }),
                newRow({ activity = "Partial Keep", encounters = bosses({ true, false }) }),
                newRow({ character = "Jaina-Draenor", activity = "Free Citadel" }),
            })

            assert.same({ "Available", "Partial", "Locked" }, column(sectionNamed(spec, "Raids").rows, 4))
        end)

        it("orders alphabetically within one state", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ character = "Jaina-Draenor", activity = "Ulduar" }),
                newRow({ character = "Jaina-Draenor", activity = "Karazhan" }),
                newRow({ character = "Jaina-Draenor", activity = "Naxxramas" }),
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
                    name = "shows nothing for an activity that has reset",
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

                    assert.equal(case.progress, cells[5])
                    assert.equal(case.reset and expiryText(row.expiry) or NONE, cells[6])
                end)
            end
        end)

        it("shows the difficulty in its own column", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ difficulty = "10 Player", difficultyId = 3 }),
            })

            assert.equal("10 Player", sectionNamed(spec, "Raids").rows[1].cells[3])
        end)

        it("colours each line by its state", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {
                newRow({ activity = "Locked Halls", encounters = bosses({ true }) }),
                newRow({ activity = "Partial Keep", encounters = bosses({ true, false }) }),
                newRow({ character = "Jaina-Draenor", activity = "Free Citadel" }),
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

        it("gives both sections the same six columns", function()
            local details = newDetails()

            local spec = details.forCharacter("Thrall-Ragnaros", {})

            assert.same(
                { "Activity", "Expansion", "Difficulty", "Status", "Bosses", "Resets" },
                columnTitles(spec.sections[1])
            )
            assert.same(spec.sections[1].columns, spec.sections[2].columns)
        end)
    end)
end)
