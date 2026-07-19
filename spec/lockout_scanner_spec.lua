local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newLockoutScanner", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---@param entries table[]? saved instances as the client would report them
    ---@param now integer? the fixed instant the scan happens at
    ---@return table scanner, table calls indexes the scanner asked about
    local function newScanner(entries, now)
        local getNumSavedInstances, getSavedInstanceInfo, calls = fake.newSavedInstances(entries)
        local scanner = ns.newLockoutScanner({
            getNumSavedInstances = getNumSavedInstances,
            getSavedInstanceInfo = getSavedInstanceInfo,
            now = fake.newClock(now or NOW).now,
        })
        return scanner, calls
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newLockoutScanner)
    end)

    describe("the reset -> expiry conversion", function()
        -- This is the invariant the whole feature rests on: the client reports
        -- SECONDS REMAINING, which is meaningless once stored, so the scanner must
        -- anchor it to the moment of the scan.
        it("converts seconds-remaining into an absolute expiry", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 3600, difficultyId = 4, isRaid = true, maxPlayers = 25 },
            }, NOW)

            local lockouts = scanner.scan()

            assert.equal(1, #lockouts)
            assert.equal(NOW + 3600, lockouts[1].expiry)
        end)

        it("anchors every entry of one scan to the same instant", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 100, difficultyId = 4 },
                { name = "Naxxramas", reset = 200, difficultyId = 4 },
            }, NOW)

            local lockouts = scanner.scan()

            assert.equal(NOW + 100, lockouts[1].expiry)
            assert.equal(NOW + 200, lockouts[2].expiry)
        end)

        it("moves the expiry forward when the same reset is scanned later", function()
            local clock = fake.newClock(NOW)
            local getNum, getInfo = fake.newSavedInstances({
                { name = "Ulduar", reset = 3600, difficultyId = 4 },
            })
            local scanner = ns.newLockoutScanner({
                getNumSavedInstances = getNum,
                getSavedInstanceInfo = getInfo,
                now = clock.now,
            })

            local first = scanner.scan()
            clock.advance(60)
            local second = scanner.scan()

            assert.equal(NOW + 3600, first[1].expiry)
            assert.equal(NOW + 60 + 3600, second[1].expiry)
        end)

        it("never treats reset as a timestamp", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 3600, difficultyId = 4 },
            }, NOW)

            local lockouts = scanner.scan()

            assert.not_equal(3600, lockouts[1].expiry)
        end)
    end)

    describe("skipping entries with nothing to record", function()
        it("skips an entry whose reset is 0", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 0, difficultyId = 4 },
            })

            assert.same({}, scanner.scan())
        end)

        it("skips an entry whose reset is nil", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = nil, difficultyId = 4 },
            })

            assert.same({}, scanner.scan())
        end)

        it("skips an entry with no name", function()
            local scanner = newScanner({
                { name = nil, reset = 3600, difficultyId = 4 },
            })

            assert.same({}, scanner.scan())
        end)

        it("keeps the surviving entries contiguous when one is skipped", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 0, difficultyId = 4 },
                { name = "Naxxramas", reset = 600, difficultyId = 4 },
                { name = "Onyxia", reset = 0, difficultyId = 3 },
                { name = "Karazhan", reset = 900, difficultyId = 3 },
            }, NOW)

            local lockouts = scanner.scan()

            assert.equal(2, #lockouts)
            assert.equal("Naxxramas", lockouts[1].instance)
            assert.equal("Karazhan", lockouts[2].instance)
        end)
    end)

    describe("normalising the client's values", function()
        it("copies through the fields it was given", function()
            local scanner = newScanner({
                {
                    name = "Ulduar",
                    reset = 3600,
                    difficultyId = 4,
                    isRaid = true,
                    maxPlayers = 25,
                    difficultyName = "25 Player (Heroic)",
                },
            }, NOW)

            assert.same({
                instance = "Ulduar",
                difficultyId = 4,
                difficulty = "25 Player (Heroic)",
                maxPlayers = 25,
                isRaid = true,
                expiry = NOW + 3600,
            }, scanner.scan()[1])
        end)

        it("degrades a missing difficultyName to an empty string", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 3600, difficultyId = 4, difficultyName = nil },
            })

            assert.equal("", scanner.scan()[1].difficulty)
        end)

        it("degrades a missing maxPlayers to zero", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 3600, difficultyId = 4, maxPlayers = nil },
            })

            assert.equal(0, scanner.scan()[1].maxPlayers)
        end)

        it("degrades a missing difficultyId to zero", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 3600, difficultyId = nil },
            })

            assert.equal(0, scanner.scan()[1].difficultyId)
        end)

        it("does not error when every optional field is absent", function()
            local scanner = newScanner({ { name = "Ulduar", reset = 3600 } })

            local lockouts
            assert.has_no.errors(function()
                lockouts = scanner.scan()
            end)
            assert.equal("Ulduar", lockouts[1].instance)
        end)

        it("normalises a truthy isRaid to boolean true", function()
            local scanner = newScanner({
                { name = "Ulduar", reset = 3600, isRaid = 1 },
            })

            assert.equal(true, scanner.scan()[1].isRaid)
        end)

        it("normalises a nil isRaid to boolean false", function()
            local scanner = newScanner({
                { name = "Deadmines", reset = 3600, isRaid = nil },
            })

            assert.equal(false, scanner.scan()[1].isRaid)
        end)

        it("normalises a false isRaid to boolean false", function()
            local scanner = newScanner({
                { name = "Deadmines", reset = 3600, isRaid = false },
            })

            assert.equal(false, scanner.scan()[1].isRaid)
        end)
    end)

    describe("the saved-instance list", function()
        it("returns an empty list when the client has no lockouts", function()
            local scanner = newScanner({})

            assert.same({}, scanner.scan())
        end)

        it("asks the client for nothing when the list is empty", function()
            local scanner, calls = newScanner({})

            scanner.scan()

            assert.same({}, calls)
        end)

        it("walks every index once, in order", function()
            local scanner, calls = newScanner({
                { name = "A", reset = 1 },
                { name = "B", reset = 2 },
                { name = "C", reset = 3 },
            })

            scanner.scan()

            assert.same({ 1, 2, 3 }, calls)
        end)

        it("returns a fresh list on each scan", function()
            local scanner = newScanner({ { name = "Ulduar", reset = 3600 } })

            assert.not_equal(scanner.scan(), scanner.scan())
        end)
    end)
end)
