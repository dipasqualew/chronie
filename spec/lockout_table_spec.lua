local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newLockoutTable", function()
    local ns = loader.load()

    local NOW = 1700000000
    local MINUTE, HOUR, DAY = 60, 3600, 86400

    ---@param now integer?
    ---@return table lockoutTable, table formatDateCalls, table clock
    local function newTable(now)
        local clock = fake.newClock(now or NOW)
        local formatDate, calls = fake.newFormatDate()
        local lockoutTable = ns.newLockoutTable({ now = clock.now, formatDate = formatDate })
        return lockoutTable, calls, clock
    end

    ---@param character string
    ---@param instance string
    ---@param difficulty string?
    ---@return LockoutRow
    local function row(character, instance, difficulty)
        return {
            character = character,
            instance = instance,
            difficulty = difficulty or "25 Player",
            difficultyId = 4,
            maxPlayers = 25,
            isRaid = true,
            expiry = NOW + 3600,
        }
    end

    ---@param rows LockoutRow[]
    ---@param field string
    ---@return string[]
    local function pluck(rows, field)
        local values = {}
        for index, entry in ipairs(rows) do
            values[index] = entry[field]
        end
        return values
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newLockoutTable)
    end)

    describe("sort", function()
        it("orders by character ascending", function()
            local lockoutTable = newTable()
            local rows = { row("Thrall", "A"), row("Jaina", "A"), row("Sylvanas", "A") }

            local sorted = lockoutTable.sort(rows, "character", true)

            assert.same({ "Jaina", "Sylvanas", "Thrall" }, pluck(sorted, "character"))
        end)

        it("orders by character descending", function()
            local lockoutTable = newTable()
            local rows = { row("Thrall", "A"), row("Jaina", "A"), row("Sylvanas", "A") }

            local sorted = lockoutTable.sort(rows, "character", false)

            assert.same({ "Thrall", "Sylvanas", "Jaina" }, pluck(sorted, "character"))
        end)

        it("orders by instance ascending", function()
            local lockoutTable = newTable()
            local rows = { row("A", "Ulduar"), row("A", "Karazhan"), row("A", "Naxxramas") }

            local sorted = lockoutTable.sort(rows, "instance", true)

            assert.same({ "Karazhan", "Naxxramas", "Ulduar" }, pluck(sorted, "instance"))
        end)

        it("orders by instance descending", function()
            local lockoutTable = newTable()
            local rows = { row("A", "Ulduar"), row("A", "Karazhan"), row("A", "Naxxramas") }

            local sorted = lockoutTable.sort(rows, "instance", false)

            assert.same({ "Ulduar", "Naxxramas", "Karazhan" }, pluck(sorted, "instance"))
        end)

        it("breaks a character tie on instance", function()
            local lockoutTable = newTable()
            local rows = { row("Thrall", "Ulduar"), row("Thrall", "Karazhan") }

            local sorted = lockoutTable.sort(rows, "character", true)

            assert.same({ "Karazhan", "Ulduar" }, pluck(sorted, "instance"))
        end)

        it("breaks a character and instance tie on difficulty", function()
            local lockoutTable = newTable()
            local rows = {
                row("Thrall", "Ulduar", "25 Player"),
                row("Thrall", "Ulduar", "10 Player"),
            }

            local sorted = lockoutTable.sort(rows, "character", true)

            assert.same({ "10 Player", "25 Player" }, pluck(sorted, "difficulty"))
        end)

        it("breaks an instance tie on character", function()
            local lockoutTable = newTable()
            local rows = { row("Thrall", "Ulduar"), row("Jaina", "Ulduar") }

            local sorted = lockoutTable.sort(rows, "instance", true)

            assert.same({ "Jaina", "Thrall" }, pluck(sorted, "character"))
        end)

        it("reverses the secondary field too when descending", function()
            local lockoutTable = newTable()
            local rows = { row("Thrall", "Karazhan"), row("Thrall", "Ulduar") }

            local sorted = lockoutTable.sort(rows, "character", false)

            assert.same({ "Ulduar", "Karazhan" }, pluck(sorted, "instance"))
        end)

        it("produces the same order however the input was shuffled", function()
            local lockoutTable = newTable()
            local a, b, c = row("Jaina", "Ulduar"), row("Thrall", "Karazhan"), row("Thrall", "Ulduar")

            local first = lockoutTable.sort({ a, b, c }, "character", true)
            local second = lockoutTable.sort({ c, a, b }, "character", true)
            local third = lockoutTable.sort({ b, c, a }, "character", true)

            assert.same(first, second)
            assert.same(second, third)
        end)

        it("gives a total order to rows equal on every sort field", function()
            local lockoutTable = newTable()
            local early = row("Thrall", "Ulduar")
            local late = row("Thrall", "Ulduar")
            early.expiry, late.expiry = NOW + 10, NOW + 20

            local sorted = lockoutTable.sort({ late, early }, "character", true)

            assert.same({ NOW + 10, NOW + 20 }, pluck(sorted, "expiry"))
        end)

        it("does not mutate the caller's list", function()
            local lockoutTable = newTable()
            local a, b, c = row("Thrall", "A"), row("Jaina", "A"), row("Sylvanas", "A")
            local rows = { a, b, c }

            lockoutTable.sort(rows, "character", true)

            assert.same({ "Thrall", "Jaina", "Sylvanas" }, pluck(rows, "character"))
            assert.equal(a, rows[1])
            assert.equal(b, rows[2])
            assert.equal(c, rows[3])
        end)

        it("returns a new list rather than the one it was given", function()
            local lockoutTable = newTable()
            local rows = { row("Thrall", "A") }

            assert.not_equal(rows, lockoutTable.sort(rows, "character", true))
        end)

        it("returns the same row tables, not copies", function()
            local lockoutTable = newTable()
            local only = row("Thrall", "A")

            assert.equal(only, lockoutTable.sort({ only }, "character", true)[1])
        end)

        it("handles an empty list", function()
            local lockoutTable = newTable()

            assert.same({}, lockoutTable.sort({}, "character", true))
        end)

        it("falls back to the character order for an unknown sort key", function()
            local lockoutTable = newTable()
            local rows = { row("Thrall", "A"), row("Jaina", "B") }

            local sorted = lockoutTable.sort(rows, "nonsense", true)

            assert.same({ "Jaina", "Thrall" }, pluck(sorted, "character"))
        end)
    end)

    describe("isExpired", function()
        it("is false while the lockout is still in the future", function()
            local lockoutTable = newTable(NOW)

            assert.is_false(lockoutTable.isExpired({ expiry = NOW + 1 }))
        end)

        it("is true once the lockout is in the past", function()
            local lockoutTable = newTable(NOW)

            assert.is_true(lockoutTable.isExpired({ expiry = NOW - 1 }))
        end)

        it("is true at the exact moment of expiry", function()
            local lockoutTable = newTable(NOW)

            assert.is_true(lockoutTable.isExpired({ expiry = NOW }))
        end)

        it("flips as the clock passes the expiry", function()
            local lockoutTable, _, clock = newTable(NOW)
            local entry = { expiry = NOW + 10 }
            assert.is_false(lockoutTable.isExpired(entry))

            clock.advance(10)

            assert.is_true(lockoutTable.isExpired(entry))
        end)
    end)

    describe("formatExpiry", function()
        ---@param remaining integer seconds until the lockout resets
        ---@return string
        local function format(remaining)
            local lockoutTable = newTable(NOW)
            return lockoutTable.formatExpiry({ expiry = NOW + remaining })
        end

        it("asks formatDate for the absolute stamp of the expiry", function()
            local lockoutTable, calls = newTable(NOW)

            lockoutTable.formatExpiry({ expiry = NOW + HOUR })

            assert.equal(1, #calls)
            assert.equal("%d %b %H:%M", calls[1].format)
            assert.equal(NOW + HOUR, calls[1].timestamp)
        end)

        it("shows days and hours when more than a day remains", function()
            assert.equal("<%d %b %H:%M@" .. (NOW + 3 * DAY + 4 * HOUR) .. "> (3d 4h)",
                format(3 * DAY + 4 * HOUR))
        end)

        it("keeps a zero hour component in the days form", function()
            assert.is_truthy(format(2 * DAY):find("(2d 0h)", 1, true))
        end)

        it("ignores leftover minutes once days are shown", function()
            assert.is_truthy(format(DAY + HOUR + 59 * MINUTE):find("(1d 1h)", 1, true))
        end)

        it("shows hours and minutes when less than a day remains", function()
            assert.is_truthy(format(5 * HOUR + 30 * MINUTE):find("(5h 30m)", 1, true))
        end)

        it("shows hours and minutes just under a day", function()
            assert.is_truthy(format(DAY - 1):find("(23h 59m)", 1, true))
        end)

        it("shows minutes only when less than an hour remains", function()
            assert.is_truthy(format(45 * MINUTE):find("(45m)", 1, true))
        end)

        it("shows zero minutes for a lockout about to lapse", function()
            assert.is_truthy(format(30):find("(0m)", 1, true))
        end)

        it("marks a lockout expired once the moment has passed", function()
            assert.is_truthy(format(-1):find("(expired)", 1, true))
        end)

        it("marks a lockout expired at the exact moment of expiry", function()
            assert.is_truthy(format(0):find("(expired)", 1, true))
        end)

        it("still shows the absolute stamp when expired", function()
            local lockoutTable, calls = newTable(NOW)

            local text = lockoutTable.formatExpiry({ expiry = NOW - DAY })

            assert.equal("<%d %b %H:%M@" .. (NOW - DAY) .. "> (expired)", text)
            assert.equal(NOW - DAY, calls[1].timestamp)
        end)
    end)

    describe("encounterSummary", function()
        local NO_DATA = "No boss data — log in on this character to record it"

        ---@param encounters table[]?
        ---@return string
        local function summarise(encounters)
            local lockoutTable = newTable()
            local entry = row("Thrall", "Molten Core")
            entry.encounters = encounters
            return lockoutTable.encounterSummary(entry)
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

        it("counts every boss as defeated when the raid is cleared", function()
            assert.equal("3/3 bosses defeated", summarise(bosses({ true, true, true })))
        end)

        it("counts none when the raid is untouched", function()
            assert.equal("0/8 bosses defeated", summarise(bosses({
                false, false, false, false, false, false, false, false,
            })))
        end)

        it("counts a partial clear", function()
            assert.equal("3/8 bosses defeated", summarise(bosses({
                true, false, true, false, true, false, false, false,
            })))
        end)

        it("counts a single killed boss", function()
            assert.equal("1/1 bosses defeated", summarise(bosses({ true })))
        end)

        it("counts a single surviving boss", function()
            assert.equal("0/1 bosses defeated", summarise(bosses({ false })))
        end)

        it("does not care where in the list the kills fall", function()
            assert.equal(
                summarise(bosses({ true, true, false, false })),
                summarise(bosses({ false, true, false, true }))
            )
        end)

        -- Rows saved before boss tracking shipped have no list at all; rows for an
        -- instance the client reported no encounters for have an empty one. Neither
        -- can be shown as "0/0", which would read as an untouched raid.
        it("reports missing data when the row has no encounter list", function()
            assert.equal(NO_DATA, summarise(nil))
        end)

        it("reports missing data when the encounter list is empty", function()
            assert.equal(NO_DATA, summarise({}))
        end)
    end)
end)
