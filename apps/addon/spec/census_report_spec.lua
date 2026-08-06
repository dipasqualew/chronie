local loader = require("addon_loader")

describe("ns.newCensusReport", function()
    local ns = loader.load()

    local NOW = 1700000000
    local MINUTE = 60
    local DAY = 86400
    local BUILD = "12.0.5.67823"
    local WALKER = "Aster-Vale"

    ---A domain cut down to the two fields a line reads off it.
    ---
    ---Deliberately not `ns.censusDomains`: what is under test is the sentence, and a real
    ---domain would put the client's own calls between the spec and it. The report never asks a
    ---domain anything — `list`, `read` and `count` belong to the walk — so a name, a scope and
    ---the partial flag is the whole of what one is from in here.
    ---@param options table? `{ name, scope, partial }`
    ---@return table
    local function newDomain(options)
        options = options or {}
        return {
            name = options.name or "things",
            scope = options.scope or "account",
            partial = options.partial,
        }
    end

    ---A reading in the shape `Census.lua` writes one, with the defaults a domain nothing has
    ---ever walked carries: no revision, no start, and no claim.
    ---@param fields table?
    ---@return table
    local function newState(fields)
        local state = { entries = {}, held = 0, complete = false, revision = 0 }
        for key, value in pairs(fields or {}) do
            state[key] = value
        end
        return state
    end

    ---@param options table? `{ domains, states, running, progress, now, character }`
    ---@return table report, table asked every `(name, character)` the report looked up, in order
    local function newReport(options)
        options = options or {}
        local states = options.states or {}
        local asked = {}
        local report = ns.newCensusReport({
            domains = options.domains or {},
            state = function(name, character)
                asked[#asked + 1] = { name = name, character = character }
                return states[name]
            end,
            running = function()
                return options.running == true
            end,
            progress = function()
                return options.progress
            end,
            now = function()
                return options.now or NOW
            end,
            character = function()
                return options.character or WALKER
            end,
        })
        return report, asked
    end

    ---The one domain's line out of a report of one domain, head and hint stripped off.
    ---@param options table?
    ---@return string
    local function oneLine(options)
        local report = newReport(options)
        return report.lines()[2]
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCensusReport)
    end)

    -- Four standings rather than a flag, because `complete` alone cannot tell the three ways
    -- of not being complete apart — and they are not the same news to somebody reading the
    -- command to find out whether their census is worth trusting.
    describe("how a reading describes itself", function()
        -- The two that matter most, and the pair `complete` cannot separate: a domain nobody
        -- has ever walked and a domain a logout cut short both have the flag down, and only
        -- one of them is a reason to go looking for a bug.
        it("tells a domain nobody has walked from one a logout cut short", function()
            local never = oneLine({
                domains = { newDomain() },
                states = { things = newState() },
            })
            local short = oneLine({
                domains = { newDomain() },
                states = { things = newState({ startedAt = NOW - MINUTE, revision = 2 }) },
            })

            assert.is_truthy(never:find("things — never walked", 1, true))
            assert.is_truthy(short:find("things — cut short", 1, true))
        end)

        it("says a finished pass is whole", function()
            local line = oneLine({
                domains = { newDomain() },
                states = {
                    things = newState({
                        complete = true,
                        revision = 1,
                        startedAt = NOW - MINUTE,
                        completedAt = NOW,
                    }),
                },
            })

            assert.is_truthy(line:find("things — whole", 1, true))
        end)

        -- Never a failure, however many passes it has had: the account's wardrobe is the union
        -- of what its characters can each see through their own class filter, so this reads as
        -- part of an answer forever and saying "cut short" would send a reader hunting a bug
        -- that is not there.
        it("says a partial domain that ran to the end is part of an answer", function()
            local line = oneLine({
                domains = { newDomain({ partial = true }) },
                states = {
                    things = newState({
                        revision = 3,
                        startedAt = NOW - MINUTE,
                        completedAt = NOW,
                    }),
                },
            })

            assert.is_truthy(line:find("things — part of an answer", 1, true))
        end)

        -- Only reachable if the report's list and the census's disagree, which they cannot
        -- where Main.lua builds both out of the same table. It is here because this command is
        -- run when something is already wrong, and a nil indexed a moment later would take the
        -- whole of it down.
        it("says so rather than raising for a domain the census never had", function()
            local line = oneLine({ domains = { newDomain() }, states = {} })

            assert.equal("things — nothing recorded", line)
        end)
    end)

    describe("what a line holds against what", function()
        -- The pairing the command exists for. These are the two numbers the audit compares to
        -- decide whether a reading is still true, and putting them side by side is what turns
        -- "does the achievement counter include guild achievements" from a question needing a
        -- debugger into one somebody answers by looking (issue #257).
        it("puts what is written down beside what the client counts", function()
            local line = oneLine({
                domains = { newDomain({ name = "achievements" }) },
                states = {
                    achievements = newState({
                        complete = true,
                        revision = 1,
                        completedAt = NOW,
                        held = 2431,
                        counted = 2436,
                    }),
                },
            })

            assert.is_truthy(line:find("2431 held, 2436 counted", 1, true))
        end)

        -- The mount case. `C_MountJournal` offers no counter whose meaning is settled, so the
        -- absence is a fact about the domain rather than about this reading — and a line saying
        -- "no counter" would repeat the same non-news at every login for the rest of time.
        it("leaves the counter out for a domain whose client offers none", function()
            local line = oneLine({
                domains = { newDomain({ name = "mounts" }) },
                states = {
                    mounts = newState({ complete = true, revision = 1, completedAt = NOW, held = 412 }),
                },
            })

            assert.is_truthy(line:find("412 held", 1, true))
            assert.is_nil(line:find("counted", 1, true))
        end)

        -- The build is what says a census was taken of a different game than the one running,
        -- and the character is what says which alt spoke for the account. Both are written by
        -- a pass rather than by the file, so neither is there before the first one.
        it("names the build it was taken on and the character that walked it", function()
            local line = oneLine({
                domains = { newDomain() },
                states = {
                    things = newState({
                        complete = true,
                        revision = 1,
                        completedAt = NOW,
                        build = BUILD,
                        by = WALKER,
                    }),
                },
            })

            assert.is_truthy(line:find("build " .. BUILD, 1, true))
            assert.is_truthy(line:find("by " .. WALKER, 1, true))
        end)

        it("says nothing about either when the reading carries neither", function()
            local line = oneLine({
                domains = { newDomain() },
                states = { things = newState() },
            })

            assert.is_nil(line:find("build", 1, true))
            assert.is_nil(line:find(" by ", 1, true))
        end)
    end)

    describe("how old a reading is", function()
        it("dates a whole reading from the moment its pass finished", function()
            local line = oneLine({
                domains = { newDomain() },
                states = {
                    things = newState({
                        complete = true,
                        revision = 1,
                        -- A start far enough back that reading it instead of the finish would
                        -- be a different sentence rather than a rounding difference.
                        startedAt = NOW - 3 * DAY,
                        completedAt = NOW - (5 * MINUTE + 30),
                    }),
                },
            })

            assert.is_truthy(line:find("5m ago", 1, true))
        end)

        -- A pass that never finished has no completion to be dated from, and when it began is
        -- the only thing the file knows about it — which is exactly what a reader wanting to
        -- know how stale a cut-short reading is is asking.
        it("falls back to when the pass began where none ever finished", function()
            local line = oneLine({
                domains = { newDomain() },
                states = { things = newState({ revision = 1, startedAt = NOW - 3 * DAY }) },
            })

            assert.is_truthy(line:find("3d ago", 1, true))
        end)

        it("says a pass that has only just finished happened now", function()
            local line = oneLine({
                domains = { newDomain() },
                states = { things = newState({ complete = true, revision = 1, completedAt = NOW }) },
            })

            assert.is_truthy(line:find("now", 1, true))
        end)

        it("says never for a domain no pass has ever been begun over", function()
            local line = oneLine({
                domains = { newDomain() },
                states = { things = newState() },
            })

            assert.is_truthy(line:find("never walked, 0 held, never", 1, true))
        end)
    end)

    -- A standing is one character's, so a line about one has to say whose — and has to ask for
    -- the state under that character rather than account-wide, or it would draw the wrong alt's
    -- reading or, worse, none at all.
    it("labels a character domain with whoever is logged in, and asks under them", function()
        local report, asked = newReport({
            domains = { newDomain({ name = "reputations", scope = "character" }) },
            states = { reputations = newState({ complete = true, revision = 1, completedAt = NOW }) },
            character = "Bramble-Vale",
        })

        local line = report.lines()[2]

        assert.is_truthy(line:find("reputations (Bramble-Vale) — whole", 1, true))
        for _, ask in ipairs(asked) do
            assert.equal("Bramble-Vale", ask.character)
        end
    end)

    it("asks account-wide for a domain every character answers the same", function()
        local report, asked = newReport({
            domains = { newDomain({ name = "mounts" }) },
            states = { mounts = newState() },
        })

        report.lines()

        for _, ask in ipairs(asked) do
            assert.is_nil(ask.character)
        end
    end)

    describe("the head line", function()
        it("counts how many domains are whole out of how many there are", function()
            local report = newReport({
                domains = {
                    newDomain({ name = "mounts" }),
                    newDomain({ name = "appearances", partial = true }),
                    newDomain({ name = "achievements" }),
                },
                states = {
                    mounts = newState({ complete = true, revision = 1, completedAt = NOW }),
                    appearances = newState({ revision = 4, completedAt = NOW }),
                    achievements = newState(),
                },
            })

            local lines = report.lines()

            assert.is_truthy(lines[1]:find("census — 1 of 3 domains whole", 1, true))
            -- One line each under it, and a hint under those.
            assert.equal(5, #lines)
        end)

        -- Said first because it changes what every line beneath it means: a domain being walked
        -- right now has had its completeness demoted for the duration, and a reader who did not
        -- know that would read a walk in progress as a walk that failed.
        it("says out loud when a pass is walking right now", function()
            local report = newReport({
                domains = { newDomain() },
                states = { things = newState({ revision = 1, startedAt = NOW }) },
                running = true,
            })

            assert.is_truthy(report.lines()[1]:find("walking now", 1, true))
        end)
    end)

    describe("the way out", function()
        it("offers the refresh when nothing is walking", function()
            local report = newReport({
                domains = { newDomain() },
                states = { things = newState() },
            })

            local lines = report.lines()

            assert.equal("/chronie census refresh walks every one of them again.", lines[#lines])
        end)

        -- `census.run` refuses to begin a second pass while one is in flight, and refuses in
        -- silence — so offering the refresh mid-walk would be pointing a reader at something
        -- that does nothing at all when they take it up.
        it("withholds it while a pass is already walking", function()
            local report = newReport({
                domains = { newDomain() },
                states = { things = newState({ revision = 1, startedAt = NOW }) },
                running = true,
            })

            local lines = report.lines()

            assert.equal(2, #lines)
            assert.is_nil(lines[2]:find("refresh", 1, true))
        end)
    end)
    -- The other half of breaking the census's silence, and the half somebody will actually see.
    -- `/chronie census` is where the two numbers an audit compares are read side by side; this
    -- is the walk while it is happening, in a window a player already opens to find out what
    -- Chronie has been doing.
    describe("the block the segments window draws", function()
        ---@param options table?
        ---@return table
        local function section(options)
            return newReport(options).section()
        end

        it("draws a row for every domain, in the order they are walked", function()
            local drawn = section({
                domains = {
                    newDomain({ name = "currencies", scope = "character" }),
                    newDomain({ name = "reputations", scope = "character" }),
                    newDomain({ name = "achievements" }),
                },
                states = {
                    currencies = newState({ complete = true, revision = 1, held = 14 }),
                    reputations = newState({ complete = true, revision = 1, held = 240 }),
                    achievements = newState(),
                },
            })

            local names = {}
            for _, row in ipairs(drawn.rows) do
                names[#names + 1] = row.cells[1]
            end
            assert.same({ "currencies", "reputations", "achievements" }, names)
        end)

        it("says what a reading claims, what it holds, and what the client counts", function()
            local drawn = section({
                domains = { newDomain({ name = "achievements" }) },
                states = { achievements = newState({
                    complete = true, revision = 2, held = 2841, counted = 2841,
                    build = BUILD, by = WALKER, completedAt = NOW - 2 * DAY,
                }) },
            })

            local cells = drawn.rows[1].cells
            assert.equal("achievements", cells[1])
            assert.equal("whole", cells[2])
            -- Blank on every row but the one being walked, which is what says which domain the
            -- client is actually busy with.
            assert.equal("", cells[3])
            assert.equal("2841", cells[4])
            assert.equal("2841", cells[5])
            assert.equal("2d ago", cells[6])
        end)

        -- Its absence is a fact about the domain rather than about this reading — see
        -- `ns.mountCensus`, which does without a counter on purpose — and a nought in that cell
        -- would read as the client saying the account has none.
        it("leaves the counted cell empty where the client offers no counter", function()
            local drawn = section({
                domains = { newDomain({ name = "mounts" }) },
                states = { mounts = newState({ complete = true, revision = 1, held = 412 }) },
            })

            assert.equal("", drawn.rows[1].cells[5])
        end)

        it("draws a bar on the domain being walked and on no other", function()
            local drawn = section({
                domains = { newDomain({ name = "currencies", scope = "character" }),
                    newDomain({ name = "reputations", scope = "character" }) },
                states = {
                    currencies = newState({ held = 3 }),
                    reputations = newState({ held = 0 }),
                },
                progress = { domain = "reputations", done = 1000, total = 4000, at = 2, of = 2 },
            })

            assert.equal("", drawn.rows[1].cells[3])
            assert.equal("|||······· 25%", drawn.rows[2].cells[3])
        end)

        -- The bar on the row below only ever describes the domain in hand, and somebody
        -- watching a pass wants to know how many are queued behind it.
        it("says which domain of how many is being walked", function()
            local drawn = section({
                domains = { newDomain({ name = "appearances", partial = true }) },
                states = { appearances = newState({ held = 900 }) },
                progress = { domain = "appearances", done = 20000, total = 55000, at = 8, of = 9 },
            })

            assert.equal("Collections — walking appearances, 8 of 9", drawn.heading)
        end)

        it("is a plain heading while nothing is walking", function()
            local drawn = section({
                domains = { newDomain() },
                states = { things = newState({ complete = true, revision = 1 }) },
            })

            assert.equal("Collections", drawn.heading)
        end)

        -- A character's wallet is that character's, so the row has to be read against whoever is
        -- logged in rather than against the account — the same lookup the chat lines make.
        it("asks a character-scoped domain about whoever is playing", function()
            local report, asked = newReport({
                domains = { newDomain({ name = "currencies", scope = "character" }),
                    newDomain({ name = "mounts" }) },
                states = { currencies = newState(), mounts = newState() },
                character = "Brin-Vale",
            })

            report.section()

            assert.same({
                { name = "currencies", character = "Brin-Vale" },
                { name = "mounts", character = nil },
            }, asked)
        end)

        -- A build that answers for no domain at all draws an empty block rather than a heading
        -- over nothing, which is what every other section in that window does.
        it("says so when this build answers for none of them", function()
            local drawn = section({})

            assert.same({}, drawn.rows)
            assert.equal("This client build answers for none of them.", drawn.empty)
        end)
    end)
end)
