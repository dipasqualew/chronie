local loader = require("addon_loader")
local fake = require("fake_wow")

describe("addon integration", function()
    ---Boot the addon exactly as the client does: every .toc file, in order,
    ---then hand ns.main a fake outside world.
    ---@param options table? `{ playerName = string?, addonName = string? }`
    local function boot(options)
        options = options or {}
        local ns = loader.load(options.addonName)
        local env, recorded = fake.newEnv(options)
        local app = ns.main(env)
        recorded.frame = recorded.frames[1]
        return app, recorded
    end

    describe("loading", function()
        it("populates the namespace with every constructor", function()
            local ns = loader.load()

            assert.is_function(ns.newGreeter)
            assert.is_function(ns.newLogger)
            assert.is_function(ns.newEventDispatcher)
            assert.is_function(ns.newLockoutScanner)
            assert.is_function(ns.newLockoutStore)
            assert.is_function(ns.newLockoutTable)
            assert.is_function(ns.newSlashRouter)
            assert.is_function(ns.newLockoutWindow)
            assert.is_function(ns.main)
        end)

        it("does not auto-start outside the game", function()
            local ns = loader.load()

            assert.is_nil(ns.app)
        end)
    end)

    describe("PLAYER_LOGIN", function()
        it("greets the player once the login event fires", function()
            local _, recorded = boot({ playerName = "Thrall" })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.equal(1, #recorded.lines)
            assert.is_truthy(recorded.lines[1]:find("Hello World, Thrall!", 1, true))
        end)

        it("prefixes the greeting with the addon name", function()
            local _, recorded = boot({ playerName = "Thrall", addonName = "wdp-wow" })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.equal("|cff33ff99wdp-wow|r: Hello World, Thrall!", recorded.lines[1])
        end)

        it("asks the environment for the player unit", function()
            local _, recorded = boot({ playerName = "Thrall" })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.same({ "player" }, recorded.unitsAsked)
        end)

        it("registers PLAYER_LOGIN on a single frame", function()
            local _, recorded = boot({ playerName = "Thrall" })

            assert.equal(1, #recorded.frames)
            assert.same({ "Frame" }, recorded.frameTypes)
            assert.equal(1, recorded.frame.registered.PLAYER_LOGIN)
        end)

        it("prints nothing before the event fires", function()
            local _, recorded = boot({ playerName = "Thrall" })

            assert.same({}, recorded.lines)
        end)

        it("greets a stranger when the unit name is unknown", function()
            local _, recorded = boot({ playerName = nil })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.equal("|cff33ff99wdp-wow|r: Hello World, stranger!", recorded.lines[1])
        end)

        it("ignores unrelated events", function()
            local _, recorded = boot({ playerName = "Thrall" })

            recorded.frame:fire("PLAYER_LOGOUT")

            assert.same({}, recorded.lines)
        end)

        it("exposes the wired modules to the caller", function()
            local app = boot({ playerName = "Thrall" })

            assert.is_function(app.logger.info)
            assert.is_function(app.window.toggle)
            assert.is_function(app.window.refresh)
            assert.is_function(app.store.save)
            assert.is_function(app.store.all)
            assert.is_function(app.scanner.scan)
            assert.is_function(app.router.dispatch)
        end)

        it("asks the client for raid info as soon as the player logs in", function()
            local _, recorded = boot({ playerName = "Thrall" })
            assert.equal(0, recorded.raidInfoRequests())

            recorded.frame:fire("PLAYER_LOGIN")

            assert.equal(1, recorded.raidInfoRequests())
        end)
    end)

    describe("lockout capture", function()
        local NOW = 1700000000

        ---@param rows LockoutRow[]
        ---@return table<string, boolean> a set of "character|instance"
        local function identities(rows)
            local set = {}
            for _, row in ipairs(rows) do
                set[row.character .. "|" .. row.instance] = true
            end
            return set
        end

        it("persists a scan into the db under Name-Realm when the client reports in", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                savedInstances = {
                    { name = "Ulduar", reset = 3600, difficultyId = 4, isRaid = true, maxPlayers = 25 },
                },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.is_table(recorded.db.characters["Thrall-Ragnaros"])
            local rows = app.store.all()
            assert.equal(1, #rows)
            assert.equal("Thrall-Ragnaros", rows[1].character)
            assert.equal("Ulduar", rows[1].instance)
        end)

        it("stores the expiry as an absolute time, not the raw seconds-remaining", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.equal(NOW + 3600, app.store.all()[1].expiry)
        end)

        it("writes nothing before the client reports in", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                savedInstances = { { name = "Ulduar", reset = 3600 } },
            })

            assert.same({}, app.store.all())
            assert.is_nil(recorded.db.characters["Thrall-Ragnaros"])
        end)

        it("re-scans on every report, replacing that character's rows", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")
            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.equal(1, #app.store.all())
        end)

        it("keeps two characters' lockouts side by side in one db", function()
            -- The whole point of the feature: an alt's lockouts stay visible while
            -- you are logged in on someone else.
            local db = {}
            local _, firstRecorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                db = db,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })
            firstRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            local secondApp, secondRecorded = boot({
                playerName = "Jaina",
                realmName = "Draenor",
                now = NOW,
                db = db,
                savedInstances = { { name = "Karazhan", reset = 7200, difficultyId = 3 } },
            })
            secondRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.same({
                ["Thrall-Ragnaros|Ulduar"] = true,
                ["Jaina-Draenor|Karazhan"] = true,
            }, identities(secondApp.store.all()))
        end)

        it("leaves the other character's rows alone when one re-scans", function()
            local db = {}
            local _, firstRecorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                db = db,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })
            firstRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            local secondApp, secondRecorded = boot({
                playerName = "Jaina",
                realmName = "Draenor",
                now = NOW,
                db = db,
                savedInstances = {},
            })
            secondRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            local rows = secondApp.store.all()
            assert.equal(1, #rows)
            assert.equal("Thrall-Ragnaros", rows[1].character)
        end)

        it("records the same character on two realms separately", function()
            local db = {}
            local _, firstRecorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                db = db,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })
            firstRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            local secondApp, secondRecorded = boot({
                playerName = "Thrall",
                realmName = "Draenor",
                now = NOW,
                db = db,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })
            secondRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.same({
                ["Thrall-Ragnaros|Ulduar"] = true,
                ["Thrall-Draenor|Ulduar"] = true,
            }, identities(secondApp.store.all()))
        end)

        it("falls back to a placeholder identity when the client has no names yet", function()
            local app, recorded = boot({
                playerName = nil,
                realmName = nil,
                now = NOW,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.equal("?-?", app.store.all()[1].character)
        end)

        it("persists the boss list captured by the scan", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                savedInstances = {
                    {
                        name = "Molten Core",
                        reset = 3600,
                        difficultyId = 4,
                        isRaid = true,
                        bosses = {
                            { name = "Lucifron", killed = 1 },
                            { name = "Magmadar", killed = nil },
                            { name = "Ragnaros", killed = nil },
                        },
                    },
                },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            local stored = recorded.db.characters["Thrall-Ragnaros"]["Molten Core\0" .. 4]
            assert.same({
                { name = "Lucifron", killed = true },
                { name = "Magmadar", killed = false },
                { name = "Ragnaros", killed = false },
            }, stored.encounters)
            assert.same(stored.encounters, app.store.all()[1].encounters)
        end)

        it("shows an alt's boss list while logged in on someone else", function()
            -- The reason boss data is captured at scan time at all: encounter info is
            -- unreadable for anyone but the logged-in character, so it has to be stored.
            local db = {}
            local _, thrallRecorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                db = db,
                savedInstances = {
                    {
                        name = "Molten Core",
                        reset = 3600,
                        difficultyId = 4,
                        bosses = {
                            { name = "Lucifron", killed = true },
                            { name = "Ragnaros", killed = false },
                        },
                    },
                },
            })
            thrallRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            -- Jaina's client reports only her own lockouts, and knows nothing of Thrall's.
            local jainaApp, jainaRecorded = boot({
                playerName = "Jaina",
                realmName = "Draenor",
                now = NOW,
                db = db,
                savedInstances = { { name = "Karazhan", reset = 7200, difficultyId = 3 } },
            })
            jainaRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            local byCharacter = {}
            for _, row in ipairs(jainaApp.store.all()) do
                byCharacter[row.character] = row
            end

            assert.same({
                { name = "Lucifron", killed = true },
                { name = "Ragnaros", killed = false },
            }, byCharacter["Thrall-Ragnaros"].encounters)
            assert.equal("Molten Core", byCharacter["Thrall-Ragnaros"].instance)
            -- Jaina's own lockout genuinely has no bosses to report.
            assert.same({}, byCharacter["Jaina-Draenor"].encounters)
        end)

        it("summarises a stored boss list for a character that is not logged in", function()
            local db = {}
            local _, thrallRecorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                db = db,
                savedInstances = {
                    {
                        name = "Molten Core",
                        reset = 3600,
                        difficultyId = 4,
                        bosses = {
                            { name = "Lucifron", killed = true },
                            { name = "Magmadar", killed = true },
                            { name = "Ragnaros", killed = false },
                        },
                    },
                },
            })
            thrallRecorded.frame:fire("UPDATE_INSTANCE_INFO")

            local ns = loader.load()
            local lockoutTable = ns.newLockoutTable({
                now = fake.newClock(NOW).now,
                formatDate = fake.newFormatDate(),
            })
            local jainaApp = boot({ playerName = "Jaina", realmName = "Draenor", now = NOW, db = db })

            assert.equal("2/3 bosses defeated", lockoutTable.encounterSummary(jainaApp.store.all()[1]))
        end)

        it("asks the client to refresh after a boss kill and on entering the world", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.frame:fire("BOSS_KILL")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal(2, recorded.raidInfoRequests())
        end)

        it("registers the events it needs to keep lockouts current", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.equal(1, recorded.frame.registered.UPDATE_INSTANCE_INFO)
            assert.equal(1, recorded.frame.registered.BOSS_KILL)
            assert.equal(1, recorded.frame.registered.PLAYER_ENTERING_WORLD)
        end)
    end)

    describe("the slash command", function()
        it("registers a handler under /wdp", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.equal(1, #recorded.slashRegistrations)
            assert.same({ "/wdp" }, recorded.slashRegistrations[1].tokens)
            assert.is_function(recorded.slashRegistrations[1].handler)
        end)

        it("prints usage for a subcommand it does not know", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("nonsense")

            assert.equal(1, #recorded.lines)
            assert.is_truthy(recorded.lines[1]:find("usage: /wdp locks", 1, true))
        end)

        it("prints usage when /wdp is typed bare", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("")

            assert.is_truthy(recorded.lines[1]:find("usage: /wdp locks", 1, true))
        end)

        it("has locks wired up out of the box, so it never reaches onUnknown", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            -- The real handler is window.toggle, which reaches for the frame API the
            -- fakes deliberately do not implement; what matters is that it was routed.
            pcall(recorded.slashRegistrations[1].handler, "locks")

            assert.same({}, recorded.lines)
        end)

        it("does not print usage for the locks subcommand", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })
            -- The window is a thin shell over the frame API; stub its toggle so the
            -- routing is observable without building any frames.
            local toggled = 0
            app.router.add("locks", function()
                toggled = toggled + 1
            end)

            recorded.slashRegistrations[1].handler("locks")

            assert.equal(1, toggled)
            assert.same({}, recorded.lines)
        end)
    end)

    describe("the lockout window", function()
        it("builds no frames until it is toggled", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            -- Only the event dispatcher's frame exists; the window is lazy.
            assert.equal(1, #recorded.frames)
            assert.same({ "Frame" }, recorded.frameTypes)
        end)

        it("constructs standalone from fake deps without touching the frame API", function()
            local ns = loader.load()
            local createFrame, frames = fake.newCreateFrame()

            local window = ns.newLockoutWindow({
                createFrame = createFrame,
                uiParent = {},
                specialFrames = {},
                getRows = function()
                    return {}
                end,
                lockoutTable = ns.newLockoutTable({
                    now = fake.newClock(0).now,
                    formatDate = fake.newFormatDate(),
                }),
                onRefreshRequested = function() end,
                tooltip = fake.newTooltip(),
            })

            assert.is_function(window.toggle)
            assert.is_function(window.refresh)
            assert.equal(0, #frames)
        end)

        it("does nothing on refresh while it has never been opened", function()
            local ns = loader.load()
            local createFrame, frames = fake.newCreateFrame()
            local rowsAsked = 0
            local window = ns.newLockoutWindow({
                createFrame = createFrame,
                uiParent = {},
                specialFrames = {},
                getRows = function()
                    rowsAsked = rowsAsked + 1
                    return {}
                end,
                lockoutTable = ns.newLockoutTable({
                    now = fake.newClock(0).now,
                    formatDate = fake.newFormatDate(),
                }),
                onRefreshRequested = function() end,
                tooltip = fake.newTooltip(),
            })

            assert.has_no.errors(window.refresh)
            assert.equal(0, #frames)
            assert.equal(0, rowsAsked)
        end)

        it("stays lazy when lockouts are captured but the window was never opened", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4 } },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.equal(1, #recorded.frames)
        end)

        it("touches the tooltip only once the player opens the window", function()
            -- Boss data flowing in must not make the window reach for GameTooltip;
            -- nothing is on screen to hover yet.
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                savedInstances = {
                    {
                        name = "Molten Core",
                        reset = 3600,
                        difficultyId = 4,
                        bosses = { { name = "Lucifron", killed = true } },
                    },
                },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.equal(0, #recorded.tooltip.lines)
            assert.equal(0, recorded.tooltip.shown)
            assert.equal(0, recorded.tooltip.hidden)
            assert.is_nil(recorded.tooltip.owner)
        end)
    end)

    describe("the .toc manifest", function()
        local ROOT = (debug.getinfo(1, "S").source:match("@(.*/)") or "./") .. "../"

        ---@return string[] every .lua file under src/, as `src/Name.lua`
        local function srcFiles()
            local files = {}
            local pipe = assert(io.popen("ls " .. ROOT .. "src"))
            for name in pipe:lines() do
                if name:match("%.lua$") then
                    files[#files + 1] = "src/" .. name
                end
            end
            pipe:close()
            return files
        end

        it("lists every src file plus Main.lua", function()
            local listed = {}
            for _, path in ipairs(loader.tocFiles()) do
                listed[path] = true
            end

            for _, path in ipairs(srcFiles()) do
                assert.is_true(listed[path] == true, path .. " is missing from wdp-wow.toc")
            end
            assert.is_true(listed["Main.lua"] == true, "Main.lua is missing from wdp-wow.toc")
        end)

        it("lists no file that does not exist on disk", function()
            for _, path in ipairs(loader.tocFiles()) do
                local handle = io.open(ROOT .. path, "r")
                assert.is_truthy(handle, path .. " is listed in wdp-wow.toc but does not exist")
                handle:close()
            end
        end)

        it("loads Main.lua last, so the modules exist when it wires them", function()
            local files = loader.tocFiles()

            assert.equal("Main.lua", files[#files])
        end)
    end)
end)
