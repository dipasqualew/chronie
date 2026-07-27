local loader = require("addon_loader")

describe("ns.newCombatLogging", function()
    local ns = loader.load()

    local ADVANCED = "advancedCombatLogging"

    ---A stand-in for the client's two switches, driven entirely through the seams the
    ---module is given: no monkey patching, and every refusal a real client performs is
    ---something the test asks for rather than something it simulates from outside.
    ---
    ---`options.requested` is what the desktop app's setting says; `options.settings = false`
    ---models an installed copy whose Settings.lua never loaded at all. `options.logging` is
    ---whether the client is already writing a log before anything asks it to.
    ---`options.protected` maps a CVar to "raise", for a client that errors on the write, or
    ---to any other truthy value for one that silently drops it.
    ---@param options table? `{ requested, settings, logging, cvars, protected }`
    ---@return CombatLogging combatLogging, table client `{ logging, cvars, setCVarCalls }`
    local function newCombatLogging(options)
        options = options or {}
        local protected = options.protected or {}
        local client = {
            logging = options.logging == true,
            cvars = options.cvars or {},
            setCVarCalls = {},
        }

        local settings = options.settings
        if settings == nil then
            settings = { combatLogging = options.requested == true }
        end

        local combatLogging = ns.newCombatLogging({
            settings = settings or nil,
            loggingCombat = function(enable)
                if enable ~= nil then
                    client.logging = enable and true or false
                end
                return client.logging
            end,
            getCVar = function(name)
                return client.cvars[name]
            end,
            setCVar = function(name, value)
                client.setCVarCalls[#client.setCVarCalls + 1] = { name = name, value = value }
                if protected[name] == "raise" then
                    error("attempted to set a protected cvar: " .. name, 0)
                end
                if protected[name] then
                    return
                end
                client.cvars[name] = value
            end,
        })
        return combatLogging, client
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newCombatLogging)
    end)

    describe("applying the setting", function()
        it("starts logging and asks for advanced logging when the setting is on", function()
            local combatLogging, client = newCombatLogging({ requested = true })

            combatLogging.apply()

            assert.is_true(client.logging)
            assert.same({ { name = ADVANCED, value = "1" } }, client.setCVarCalls)
        end)

        it("reports the client doing everything that was asked of it", function()
            local combatLogging = newCombatLogging({ requested = true })

            assert.same({ requested = true, logging = true, advanced = true }, combatLogging.apply())
        end)

        it("touches neither switch when the setting is off", function()
            local combatLogging, client = newCombatLogging({ requested = false })

            local state = combatLogging.apply()

            assert.is_false(client.logging)
            assert.same({}, client.setCVarCalls)
            assert.is_false(state.requested)
        end)

        it("touches neither switch when the copy has no settings at all", function()
            local combatLogging, client = newCombatLogging({ settings = false })

            local state = combatLogging.apply()

            assert.is_false(client.logging)
            assert.same({}, client.setCVarCalls)
            assert.is_false(state.requested)
        end)

        -- The deliberate asymmetry: the setting says whether Chronie starts logging, not
        -- whether the player may. Somebody who switched it on for their own reasons this
        -- session must not find a Chronie setting they never touched had stopped it.
        it("leaves logging the player started themselves running", function()
            local combatLogging, client = newCombatLogging({ requested = false, logging = true })

            local state = combatLogging.apply()

            assert.is_true(client.logging)
            assert.same({}, client.setCVarCalls)
            assert.is_false(state.requested)
            assert.is_true(state.logging)
        end)
    end)

    -- The point of the module. A protected CVar refuses an addon in two different ways
    -- depending on the client build, and neither may be reported as a write that took.
    describe("a client that refuses the advanced CVar", function()
        for _, case in ipairs({
            { label = "silently drops the write", protection = true },
            { label = "raises on the write", protection = "raise" },
        }) do
            describe("one that " .. case.label, function()
                ---@return CombatLogging, table
                local function refusing()
                    return newCombatLogging({
                        requested = true,
                        protected = { [ADVANCED] = case.protection },
                    })
                end

                it("survives the refusal", function()
                    local combatLogging = refusing()

                    assert.has_no.errors(combatLogging.apply)
                end)

                it("still starts logging", function()
                    local combatLogging, client = refusing()

                    local state = combatLogging.apply()

                    assert.is_true(client.logging)
                    assert.is_true(state.logging)
                end)

                it("says advanced logging is off rather than that the write took", function()
                    local combatLogging = refusing()

                    assert.is_false(combatLogging.apply().advanced)
                end)

                it("attempted the write all the same", function()
                    local combatLogging, client = refusing()

                    combatLogging.apply()

                    assert.same({ { name = ADVANCED, value = "1" } }, client.setCVarCalls)
                end)
            end)
        end
    end)

    -- Whatever the client answers is the answer, because a client build is free to say
    -- it in more than one way and none of them may read as off by accident.
    describe("reading the advanced CVar back", function()
        for _, case in ipairs({
            { label = "the string 1", value = "1", advanced = true },
            { label = "the number 1", value = 1, advanced = true },
            { label = "true", value = true, advanced = true },
            { label = "the string 0", value = "0", advanced = false },
            { label = "nothing at all", value = nil, advanced = false },
        }) do
            it("counts a client answering " .. case.label .. " as advanced " ..
                (case.advanced and "on" or "off"), function()
                local combatLogging = newCombatLogging({ cvars = { [ADVANCED] = case.value } })

                assert.equal(case.advanced, combatLogging.state().advanced)
            end)
        end

        it("reports advanced logging a player ticked before anything was written", function()
            local combatLogging, client = newCombatLogging({
                requested = false,
                cvars = { [ADVANCED] = "1" },
            })

            assert.is_true(combatLogging.state().advanced)
            assert.same({}, client.setCVarCalls)
        end)
    end)

    describe("reporting the state on demand", function()
        it("says what the client says", function()
            local combatLogging = newCombatLogging({
                requested = true,
                logging = true,
                cvars = { [ADVANCED] = "1" },
            })

            assert.same({ requested = true, logging = true, advanced = true }, combatLogging.state())
        end)

        it("changes neither switch to find out", function()
            local combatLogging, client = newCombatLogging({ requested = true })

            combatLogging.state()

            assert.is_false(client.logging)
            assert.same({}, client.setCVarCalls)
        end)

        it("reports logging the setting never asked for", function()
            local combatLogging = newCombatLogging({ requested = false, logging = true })

            local state = combatLogging.state()

            assert.is_false(state.requested)
            assert.is_true(state.logging)
        end)
    end)

    describe("describing a state to the player", function()
        ---@param state table
        ---@return string
        local function described(state)
            return newCombatLogging().describe(state)
        end

        it("tells a player who has not asked for it where to turn it on", function()
            local message = described({ requested = false, logging = false, advanced = false })

            assert.is_truthy(message:find("off", 1, true))
            assert.is_truthy(message:find("Setup", 1, true))
        end)

        it("owns up to logging Chronie did not ask for", function()
            local message = described({ requested = false, logging = true, advanced = false })

            assert.is_truthy(message:find("on", 1, true))
            assert.is_truthy(message:find("did not ask for it", 1, true))
        end)

        it("says so when the client did not start logging after being asked", function()
            local message = described({ requested = true, logging = false, advanced = false })

            assert.is_truthy(message:find("not logging", 1, true))
        end)

        -- Naming the box is the whole value of the message: the player can only fix this
        -- one themselves, and only if they are told which switch and which panel.
        it("names the box the player has to tick when advanced logging is off", function()
            local message = described({ requested = true, logging = true, advanced = false })

            assert.is_truthy(message:find("Advanced Combat Logging", 1, true))
            assert.is_truthy(message:find("Network", 1, true))
            assert.is_truthy(message:find("no positions", 1, true))
        end)

        it("says both switches are on when they are", function()
            local message = described({ requested = true, logging = true, advanced = true })

            assert.equal("combat logging is on, with advanced combat logging.", message)
        end)
    end)
end)
