local loader = require("addon_loader")
local fake = require("fake_wow")

describe("addon integration", function()
    ---Boot the addon exactly as the client does: every .toc file, in order,
    ---then hand ns.main a fake outside world.
    ---
    ---`options.settings` is what the desktop app wrote into this installed copy, applied
    ---the way the installer does it — over the defaults src/Settings.lua carries, before
    ---anything reads them. Each boot loads its own namespace, so one test's settings can
    ---never reach another's.
    ---@param options table? `{ playerName = string?, addonName = string?, settings = table? }`
    local function boot(options)
        options = options or {}
        local ns = loader.load(options.addonName)
        for key, value in pairs(options.settings or {}) do
            ns.settings[key] = value
        end
        local env, recorded = fake.newEnv(options)
        local app = ns.main(env)
        recorded.frame = recorded.frames[1]
        -- Kept so a test can change a client switch by hand after login, the way the
        -- player typing /combatlog does, rather than only observing what the addon did.
        recorded.env = env
        return app, recorded
    end

    describe("loading", function()
        it("populates the namespace with every constructor", function()
            local ns = loader.load()

            assert.is_function(ns.newLogger)
            assert.is_function(ns.newEventDispatcher)
            assert.is_function(ns.newLockoutScanner)
            assert.is_function(ns.newLockoutStore)
            assert.is_function(ns.newLockoutTable)
            assert.is_function(ns.newClassDisplay)
            assert.is_function(ns.newExpansionIndex)
            assert.is_function(ns.newSlashRouter)
            assert.is_function(ns.newLockoutWindow)
            assert.is_function(ns.newCurrencyItems)
            assert.is_function(ns.newCurrencyWindow)
            assert.is_function(ns.newCombatLogging)
            assert.is_function(ns.main)
        end)

        it("does not auto-start outside the game", function()
            local ns = loader.load()

            assert.is_nil(ns.app)
        end)

        -- What a copy nobody has configured ends up with: the desktop app overwrites this
        -- file at install time, so the bundle's own values are the defaults and every one
        -- of them costs the player something they have not asked for.
        it("carries settings with combat logging off until something says otherwise", function()
            local ns = loader.load()

            assert.is_false(ns.settings.combatLogging)
        end)
    end)

    describe("PLAYER_LOGIN", function()
        it("stays silent when the login event fires", function()
            local _, recorded = boot({ playerName = "Thrall" })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.same({}, recorded.lines)
        end)

        -- The player unit is read to build the "Name-Realm" key the roster is written under.
        it("asks the environment for the player unit to identify the character", function()
            local _, recorded = boot({ playerName = "Thrall" })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.same({ "player" }, recorded.unitsAsked)
        end)

        it("asks the environment for the player's class and level", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.same({ "player" }, recorded.classAsked)
            assert.same({ "player" }, recorded.levelAsked)
        end)

        it("registers PLAYER_LOGIN on a single frame", function()
            local _, recorded = boot({ playerName = "Thrall" })

            assert.equal(2, #recorded.frames)
            assert.same({ "Frame", "Button" }, recorded.frameTypes)
            assert.equal(1, recorded.frame.registered.PLAYER_LOGIN)
        end)

        it("prints nothing before the event fires", function()
            local _, recorded = boot({ playerName = "Thrall" })

            assert.same({}, recorded.lines)
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

    describe("the roster", function()
        local NOW = 1700000000

        it("writes the logged-in character into db.roster under Name-Realm", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                class = "Warrior",
                classFile = "WARRIOR",
                level = 60,
                now = NOW,
            })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.same({
                class = "Warrior",
                classFile = "WARRIOR",
                level = 60,
                lastSeen = NOW,
            }, recorded.db.roster["Thrall-Ragnaros"])
        end)

        it("writes nothing into the roster before the player logs in", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.is_nil(next(recorded.db.roster))
        end)

        -- Requirement of the drill-down views: a character with nothing saved must
        -- still be listable, so it can be shown as available for its alts' instances.
        it("lists a character that logged in with no saved instances at all", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                savedInstances = {},
            })

            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.same({}, app.store.all())
            assert.equal(1, #app.store.characters())
            assert.equal("Thrall-Ragnaros", app.store.characters()[1].character)
        end)

        it("keeps two characters in the roster of one shared db", function()
            local db = {}
            local _, firstRecorded = boot({ playerName = "Thrall", realmName = "Ragnaros", db = db })
            firstRecorded.frame:fire("PLAYER_LOGIN")

            local secondApp, secondRecorded = boot({ playerName = "Jaina", realmName = "Draenor", db = db })
            secondRecorded.frame:fire("PLAYER_LOGIN")

            local names = {}
            for index, entry in ipairs(secondApp.store.characters()) do
                names[index] = entry.character
            end
            assert.same({ "Jaina-Draenor", "Thrall-Ragnaros" }, names)
        end)

        it("uses the same placeholder identity the scan does when names are unknown", function()
            local app, recorded = boot({ playerName = nil, realmName = nil })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.equal("?-?", app.store.characters()[1].character)
        end)
    end)

    describe("lockout capture", function()
        local NOW = 1700000000

        ---@param rows LockoutRow[]
        ---@return table<string, boolean> a set of "character|activity"
        local function identities(rows)
            local set = {}
            for _, row in ipairs(rows) do
                set[row.character .. "|" .. row.activity] = true
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
            assert.equal("Ulduar", rows[1].activity)
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

        it("captures world bosses alongside the instance saves of the same scan", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                savedInstances = { { name = "Ulduar", reset = 3600, difficultyId = 4, isRaid = true } },
                savedWorldBosses = { { name = "Doomwalker", worldBossID = 17711, reset = 4 * 86400 } },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            assert.same({
                ["Thrall-Ragnaros|Ulduar"] = true,
                ["Thrall-Ragnaros|Doomwalker"] = true,
            }, identities(app.store.all()))
        end)

        it("files a world boss as its own kind of activity, resetting weekly", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = NOW,
                savedInstances = {},
                savedWorldBosses = { { name = "Doomwalker", worldBossID = 17711, reset = 4 * 86400 } },
            })

            recorded.frame:fire("UPDATE_INSTANCE_INFO")

            local row = app.store.all()[1]
            assert.equal("world_boss", row.kind)
            assert.equal("weekly", row.period)
            assert.equal(NOW + 4 * 86400, row.expiry)
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

            local stored = recorded.db.characters["Thrall-Ragnaros"]["instance\0Molten Core\0" .. 4]
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
            assert.equal("Molten Core", byCharacter["Thrall-Ragnaros"].activity)
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
            assert.equal(1, recorded.frame.registered.ZONE_CHANGED_NEW_AREA)
        end)
    end)

    describe("the slash command", function()
        it("registers a handler under /chronie", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.equal(1, #recorded.slashRegistrations)
            assert.same({ "/chronie" }, recorded.slashRegistrations[1].tokens)
            assert.is_function(recorded.slashRegistrations[1].handler)
        end)

        it("prints usage for a subcommand it does not know", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("nonsense")

            assert.equal(1, #recorded.lines)
            assert.is_truthy(recorded.lines[1]:find("usage: /chronie locks", 1, true))
        end)

        it("prints usage when /chronie is typed bare", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("")

            assert.is_truthy(recorded.lines[1]:find("usage: /chronie locks", 1, true))
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

            -- Only the event dispatcher and the always-visible minimap button exist.
            assert.equal(2, #recorded.frames)
            assert.same({ "Frame", "Button" }, recorded.frameTypes)
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

            assert.equal(2, #recorded.frames)
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

    describe("the lockout window's row rendering", function()
        local NOW = 1700000000

        local MAGE_ICON = "|TInterface\\TargetingFrame\\UI-Classes-Circles:14:14:0:0:256:256:64:127:0:64|t"
        local MAGE_COLOR = { 0.25, 0.78, 0.92 }
        local WOTLK_COLOR = { 0.45, 0.78, 0.95 }
        local ACTIVE_COLOR = { 1, 1, 1 }
        local EXPIRED_COLOR = { 0.45, 0.45, 0.45 }

        local TIERS = {
            { name = "Classic" },
            { name = "The Burning Crusade" },
            { name = "Wrath of the Lich King", raids = { "Ulduar" } },
        }

        ---Boot a mage with one Ulduar lockout and open the window.
        ---@param options table?
        ---@return table app, table recorded
        local function opened(options)
            options = options or {}
            options.playerName = options.playerName or "Jaina"
            options.realmName = options.realmName or "Draenor"
            options.now = options.now or NOW
            options.savedInstances = options.savedInstances or {
                { name = "Ulduar", reset = 3600, difficultyId = 4, isRaid = true, difficultyName = "25 Player" },
            }
            local app, recorded = boot(options)
            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("UPDATE_INSTANCE_INFO")
            app.window.toggle()
            return app, recorded
        end

        ---The font strings of each rendered row, found via the scroll child that owns
        ---them rather than by counting frames, so header widgets cannot be mistaken
        ---for cells.
        ---@param recorded table
        ---@return table[][] one list of font strings per row
        local function rowCellsOf(recorded)
            local scrollChild
            for _, frame in ipairs(recorded.frames) do
                if frame.parent and frame.parent.frameName == "ChronieLockoutScroll" then
                    scrollChild = frame
                    break
                end
            end

            local rows = {}
            for _, frame in ipairs(recorded.frames) do
                if frame.parent == scrollChild and frame.frameType == "Frame" then
                    rows[#rows + 1] = frame.fontStrings
                end
            end
            return rows
        end

        it("prefixes the character cell with its class icon", function()
            local _, recorded = opened({ class = "Mage", classFile = "MAGE" })

            assert.equal(MAGE_ICON .. " Jaina-Draenor", rowCellsOf(recorded)[1][1].text)
        end)

        it("leaves the character cell bare when the class was never recorded", function()
            -- unitClass returns nothing, so the roster never learns a class token.
            local _, recorded = opened()

            assert.equal("Jaina-Draenor", rowCellsOf(recorded)[1][1].text)
        end)

        it("colours the character cell by class", function()
            local _, recorded = opened({ class = "Mage", classFile = "MAGE" })

            assert.same(MAGE_COLOR, rowCellsOf(recorded)[1][1].color)
        end)

        it("names the expansion the journal places the instance in", function()
            local _, recorded = opened({ tiers = TIERS })

            local cells = rowCellsOf(recorded)[1]
            assert.equal("WotLK", cells[2].text)
            assert.same(WOTLK_COLOR, cells[2].color)
        end)

        it("leaves the expansion cell blank for an instance the journal never lists", function()
            local _, recorded = opened({
                tiers = TIERS,
                savedInstances = { { name = "Karazhan", reset = 3600, difficultyId = 4, isRaid = true } },
            })

            assert.equal("", rowCellsOf(recorded)[1][2].text)
        end)

        it("leaves the remaining cells in the ordinary active colour", function()
            local _, recorded = opened({ class = "Mage", classFile = "MAGE", tiers = TIERS })

            local cells = rowCellsOf(recorded)[1]
            for index = 3, 5 do
                assert.same(ACTIVE_COLOR, cells[index].color)
            end
        end)

        -- An expired row is background: neither the class nor the expansion may keep
        -- shouting once the lockout stops mattering.
        it("drops every cell to grey once the lockout has expired", function()
            local app, recorded = opened({ class = "Mage", classFile = "MAGE", tiers = TIERS })

            recorded.clock.advance(7200)
            app.window.refresh()

            for _, cell in ipairs(rowCellsOf(recorded)[1]) do
                assert.same(EXPIRED_COLOR, cell.color)
            end
        end)
    end)

    describe("drilling down from the lockout window", function()
        local NOW = 1700000000

        ---Boot, capture one lockout, and open the window so its rows exist.
        ---@param options table?
        ---@return table app, table recorded
        local function opened(options)
            options = options or {}
            options.playerName = options.playerName or "Thrall"
            options.realmName = options.realmName or "Ragnaros"
            options.now = options.now or NOW
            options.savedInstances = options.savedInstances or {
                { name = "Ulduar", reset = 3600, difficultyId = 4, isRaid = true, difficultyName = "25 Player" },
            }
            local app, recorded = boot(options)
            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("UPDATE_INSTANCE_INFO")
            app.window.toggle()
            return app, recorded
        end

        ---The invisible hit areas laid over a single row's cells, in the order the
        ---window creates them: the instance cell first, then the character cell.
        ---@param recorded table
        ---@return table activityCell, table characterCell
        local function rowCells(recorded)
            local holders = {}
            for _, frame in ipairs(recorded.frames) do
                if frame.parent and frame.parent.frameName == nil and frame.frameType == "Button" then
                    holders[#holders + 1] = frame
                end
            end
            -- The header's sort buttons are parented to the named window frame, so only
            -- the two cell buttons of the single row survive that filter.
            assert.equal(2, #holders)
            return holders[1], holders[2]
        end

        ---@param recorded table
        ---@param name string
        ---@return string[] the texts that frame's font strings carry
        local function textsOf(recorded, name)
            for _, frame in ipairs(recorded.frames) do
                if frame.frameName == name then
                    local texts = {}
                    for index, fontString in ipairs(frame.fontStrings) do
                        texts[index] = fontString.text
                    end
                    return texts
                end
            end
            return {}
        end

        ---@param texts string[]
        ---@param wanted string
        ---@return boolean
        local function contains(texts, wanted)
            for _, text in ipairs(texts) do
                if text == wanted then
                    return true
                end
            end
            return false
        end

        it("opens neither detail window until a cell is clicked", function()
            local app = opened()

            assert.is_false(app.activityWindow.isShown())
            assert.is_false(app.characterWindow.isShown())
        end)

        it("opens the activity detail window when the activity cell is clicked", function()
            local app, recorded = opened()
            local activityCell = rowCells(recorded)

            activityCell:run("OnClick")

            assert.is_true(app.activityWindow.isShown())
            assert.is_false(app.characterWindow.isShown())
        end)

        it("titles the activity detail window with the activity, which covers every difficulty", function()
            local app, recorded = opened()
            local activityCell = rowCells(recorded)

            activityCell:run("OnClick")

            assert.is_true(app.activityWindow.isShown())
            assert.is_true(contains(
                textsOf(recorded, "ChronieActivityDetailWindow"),
                "Weekly — Ulduar"
            ))
        end)

        it("opens the character detail window when the character cell is clicked", function()
            local app, recorded = opened()
            local _, characterCell = rowCells(recorded)

            characterCell:run("OnClick")

            assert.is_true(app.characterWindow.isShown())
            assert.is_false(app.activityWindow.isShown())
        end)

        it("titles the character detail window with the clicked character", function()
            local app, recorded = opened()
            local _, characterCell = rowCells(recorded)

            characterCell:run("OnClick")

            assert.is_true(app.characterWindow.isShown())
            assert.is_true(contains(
                textsOf(recorded, "ChronieCharacterDetailWindow"),
                "Thrall-Ragnaros"
            ))
        end)

        it("gives the two detail windows separate frames and Escape-close entries", function()
            local _, recorded = opened()
            local activityCell, characterCell = rowCells(recorded)

            activityCell:run("OnClick")
            characterCell:run("OnClick")

            assert.same({
                "ChronieLockoutWindow",
                "ChronieActivityDetailWindow",
                "ChronieCharacterDetailWindow",
            }, recorded.specialFrames)
        end)
    end)

    describe("the lockout window's callbacks in isolation", function()
        ---Builds a window with fake deps only, so the click handlers can be driven
        ---without booting the whole addon.
        ---@return table window, table frames, table selections `{ activities, characters }`
        local function newWindow()
            local ns = loader.load()
            local createFrame, frames = fake.newCreateFrame()
            local selections = { activities = {}, characters = {} }

            local function newClassDisplay()
                local classColor, classIconCoords = fake.newClassLook()
                return ns.newClassDisplay({ classColor = classColor, classIconCoords = classIconCoords })
            end

            local window = ns.newLockoutWindow({
                createFrame = createFrame,
                uiParent = {},
                specialFrames = {},
                getRows = function()
                    return {
                        {
                            character = "Thrall-Ragnaros",
                            key = "instance\0Ulduar",
                            activity = "Ulduar",
                            kind = "raid",
                            period = "weekly",
                            difficulty = "25 Player",
                            difficultyId = 4,
                            isRaid = true,
                            expiry = 3600,
                            encounters = {},
                        },
                    }
                end,
                lockoutTable = ns.newLockoutTable({
                    now = fake.newClock(0).now,
                    formatDate = fake.newFormatDate(),
                }),
                onRefreshRequested = function() end,
                tooltip = fake.newTooltip(),
                classDisplay = newClassDisplay(),
                -- An empty journal: these tests are about click routing, and no
                -- activity having an expansion keeps the cells out of the way.
                expansions = ns.newExpansionIndex(fake.newEncounterJournal()),
                onActivitySelected = function(row)
                    selections.activities[#selections.activities + 1] = row
                end,
                onCharacterSelected = function(character)
                    selections.characters[#selections.characters + 1] = character
                end,
            })
            return window, frames, selections
        end

        ---@param frames table[]
        ---@return table activityCell, table characterCell
        local function rowCells(frames)
            local cells = {}
            for _, frame in ipairs(frames) do
                if frame.frameType == "Button" and frame.parent and frame.parent.frameName == nil then
                    cells[#cells + 1] = frame
                end
            end
            assert.equal(2, #cells)
            return cells[1], cells[2]
        end

        it("hands the clicked row to onActivitySelected", function()
            local window, frames, selections = newWindow()
            window.toggle()
            local activityCell = rowCells(frames)

            activityCell:run("OnClick")

            assert.equal(1, #selections.activities)
            assert.equal("Ulduar", selections.activities[1].activity)
            assert.equal(4, selections.activities[1].difficultyId)
        end)

        it("hands only the character name to onCharacterSelected", function()
            local window, frames, selections = newWindow()
            window.toggle()
            local _, characterCell = rowCells(frames)

            characterCell:run("OnClick")

            assert.same({ "Thrall-Ragnaros" }, selections.characters)
        end)

        it("selects nothing until a cell is actually clicked", function()
            local window, _, selections = newWindow()

            window.toggle()

            assert.same({}, selections.activities)
            assert.same({}, selections.characters)
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
                assert.is_true(listed[path] == true, path .. " is missing from chronie.toc")
            end
            assert.is_true(listed["Main.lua"] == true, "Main.lua is missing from chronie.toc")
        end)

        it("lists no file that does not exist on disk", function()
            for _, path in ipairs(loader.tocFiles()) do
                local handle = io.open(ROOT .. path, "r")
                assert.is_truthy(handle, path .. " is listed in chronie.toc but does not exist")
                handle:close()
            end
        end)

        it("loads Main.lua last, so the modules exist when it wires them", function()
            local lua = {}
            for _, path in ipairs(loader.tocFiles()) do
                if path:match("%.lua$") then
                    lua[#lua + 1] = path
                end
            end

            assert.equal("Main.lua", lua[#lua])
        end)
    end)

    -- Chronie binds no keys, and that is an assertion rather than an omission. The
    -- Bindings.xml this block used to be about declared header="CHRONIE" on both of its two
    -- bindings, and the client reads a header the first time it sees it and complains every
    -- time after: "Binding header CHRONIE was attempted to be loaded more than once", in
    -- red, at every single login (issue #69). Nothing took the file's place, because
    -- nothing needed to — the addon photographs by listening for SCREENSHOT_SUCCEEDED,
    -- which the client fires for the screenshot key every player already has bound, so a
    -- key of Chronie's own would be a second way to do the one thing.
    describe("the keybindings it does not ship", function()
        -- loader.read raises for a file that is not there, so the failure is the assertion.
        it("has no Bindings.xml, which is the one name the client would load by itself", function()
            local read, contents = pcall(loader.read, "Bindings.xml")

            assert.is_false(read,
                "Bindings.xml is back in the addon folder: " .. tostring(contents))
        end)

        -- What the Key Bindings panel builds its rows out of. A BINDING_ global left
        -- standing would put a Chronie section in that panel with nothing behind it.
        it("declares no BINDING_ global for the Key Bindings panel to draw", function()
            loader.load()

            for name in pairs(_G) do
                if type(name) == "string" then
                    assert.is_nil(name:match("^BINDING_"),
                        tostring(name) .. " is declared, so the addon still names a binding")
                end
            end
        end)
    end)

    describe("taking a screenshot", function()
        ---Boot, log in and enter the world, which is every precondition a capture has:
        ---an account minted, a segment open and the client willing to name a map.
        ---@param options table?
        ---@return table app, table recorded
        local function bootInWorld(options)
            options = options or {}
            options.playerName = options.playerName or "Thrall"
            options.realmName = options.realmName or "Ragnaros"
            local app, recorded = boot(options)
            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            return app, recorded
        end

        it("exposes the capture the addon presses for itself", function()
            local app = bootInWorld()

            assert.is_function(app.capture)
            -- And the thing that tells its own shots from the player's, which is what makes
            -- the SCREENSHOT_SUCCEEDED handler below safe to subscribe at all.
            assert.is_function(app.screenshotWatch.claim)
        end)

        it("writes an entry and takes the picture", function()
            local app, recorded = bootInWorld()

            local entry = app.capture()

            assert.equal(1, recorded.screenshots())
            assert.same({ entry }, recorded.db.entries)
        end)

        it("stamps the entry with who was playing and which account they are", function()
            local app, recorded = bootInWorld({ playerName = "Jaina", realmName = "Draenor" })

            local entry = app.capture()

            assert.equal("Jaina-Draenor", entry.character)
            assert.equal(recorded.db.account.id, entry.author)
        end)

        it("records where the character was standing", function()
            local app, recorded = bootInWorld()
            recorded.setMap({ uiMapID = 84, x = 0.25, y = 0.75 })

            local entry = app.capture()

            assert.equal(84, entry.uiMapID)
            assert.equal(0.25, entry.x)
            assert.equal(0.75, entry.y)
        end)

        it("records the map alone where the client gives no position", function()
            local app, recorded = bootInWorld()
            recorded.setMap({ uiMapID = 2296 })

            local entry = app.capture()

            assert.equal(2296, entry.uiMapID)
            assert.is_nil(entry.x)
            assert.is_nil(entry.y)
        end)

        -- The link is the whole point of the record: a capture inherits its location,
        -- class, level and difficulty from the segment rather than restating them.
        it("links the entry to the segment that was open", function()
            local app, recorded = bootInWorld({ instanceName = "Ulduar", instanceType = "raid" })

            local entry = app.capture()
            recorded.frame:fire("PLAYER_LOGOUT")

            assert.equal(recorded.db.segments[1].id, entry.segment)
        end)

        -- Standing still and taking a photograph moves no counter, so without the tally
        -- being told, the tracker would drop the segment and the link would dangle.
        it("makes the segment worth filing, even when nothing else happened in it", function()
            local app, recorded = bootInWorld()

            app.capture()
            recorded.frame:fire("PLAYER_LOGOUT")

            assert.equal(1, #recorded.db.segments)
        end)

        it("files nothing for a segment where no capture was taken either", function()
            local _, recorded = bootInWorld()

            recorded.frame:fire("PLAYER_LOGOUT")

            assert.same({}, recorded.db.segments)
        end)

        -- Screenshot filenames resolve to the second, so a second marker in that second
        -- could only ever resolve to the wrong picture. Note that no picture is taken:
        -- an image with no marker reads downstream as somebody else's photograph.
        it("refuses a second press inside the same second, shutter and all", function()
            local app, recorded = bootInWorld()
            app.capture()

            assert.is_nil(app.capture())
            assert.equal(1, recorded.screenshots())
            assert.equal(1, #recorded.db.entries)
        end)

        it("allows the next press a second later", function()
            local app, recorded = bootInWorld()
            app.capture()

            recorded.clock.advance(1)

            assert.is_table(app.capture())
            assert.equal(2, recorded.screenshots())
        end)

        it("takes no picture before the world has loaded and the account has a name", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros", playerGUID = false })

            assert.is_nil(app.capture())
            assert.equal(0, recorded.screenshots())
            assert.same({}, recorded.db.entries)
        end)

        -- Every character on the account authors as the account, which is what makes an
        -- entry shareable later without saying which alt happened to be logged in.
        it("keeps one author across two characters sharing the file", function()
            local db = {}
            local first = bootInWorld({ db = db, playerName = "Thrall", realmName = "Ragnaros" })
            local mine = first.capture()

            local second = bootInWorld({ db = db, playerName = "Jaina", realmName = "Draenor" })
            local theirs = second.capture()

            assert.equal(mine.author, theirs.author)
            assert.not_equal(mine.id, theirs.id)
        end)

        it("survives the entries outliving the segment they were taken in", function()
            local app, recorded = bootInWorld()
            app.capture()
            recorded.frame:fire("PLAYER_LOGOUT")

            -- Eight days on, the segment has been pruned out of the rolling window and
            -- the photograph has not: that is why entries are a store of their own.
            recorded.clock.advance(8 * 24 * 60 * 60)
            app.segmentLog.prune()

            assert.same({}, recorded.db.segments)
            assert.equal(1, #recorded.db.entries)
        end)

        -- The reason Chronie has no capture key of its own. The client fires
        -- SCREENSHOT_SUCCEEDED for every screenshot it writes, the player's own key
        -- included, and the event says nothing about who asked for it — so an unclaimed one
        -- is somebody photographing something themselves, which is exactly the thing worth
        -- remembering. Fired through the real dispatcher, because "the addon subscribed to
        -- this event at all" is half of what these prove.
        describe("that the player took with the client's own key", function()
            ---The toast the prompt puts up, and the edit box inside it. Both are ordinary
            ---frames the addon built, so a test drives them the way a mouse and a keyboard
            ---would rather than reaching into the prompt behind them.
            ---@param recorded table
            ---@return table? toast, table? box
            local function noteToast(recorded)
                local toast
                for _, frame in ipairs(recorded.frames) do
                    if frame.frameName == "ChronieEntryToast" then
                        toast = frame
                    end
                end
                if not toast then
                    return nil
                end
                for _, frame in ipairs(recorded.frames) do
                    if frame.parent == toast and frame.frameType == "EditBox" then
                        return toast, frame
                    end
                end
                return toast
            end

            -- No trigger on the row is the whole statement: downstream tells a rule that
            -- fired by itself from a person who decided by whether there is one at all.
            it("files one entry, with a picture and nothing claiming to have asked for it", function()
                local _, recorded = bootInWorld()

                recorded.frame:fire("SCREENSHOT_SUCCEEDED")

                assert.equal(1, #recorded.db.entries)
                assert.is_true(recorded.db.entries[1].hasImage)
                assert.is_nil(recorded.db.entries[1].trigger)
                assert.is_nil(recorded.db.entries[1].achievement)
            end)

            -- The picture already exists; the client has just finished writing it. Reaching
            -- for the shutter here would take a second photograph of the moment after the
            -- one the player meant, and leave a marker pointing at the wrong file.
            it("takes no picture of the picture", function()
                local _, recorded = bootInWorld()

                recorded.frame:fire("SCREENSHOT_SUCCEEDED")

                assert.equal(0, recorded.screenshots())
            end)

            it("links it to the segment that was open", function()
                local _, recorded = bootInWorld({ instanceName = "Ulduar", instanceType = "raid" })

                recorded.frame:fire("SCREENSHOT_SUCCEEDED")
                recorded.frame:fire("PLAYER_LOGOUT")

                assert.equal(recorded.db.segments[1].id, recorded.db.entries[1].segment)
            end)

            -- Standing still and photographing something moves no other counter, so the
            -- tracker would drop the segment and the link above would dangle.
            it("makes that segment worth filing on its own", function()
                local _, recorded = bootInWorld()

                recorded.frame:fire("SCREENSHOT_SUCCEEDED")
                recorded.frame:fire("PLAYER_LOGOUT")

                assert.equal(1, #recorded.db.segments)
            end)

            it("offers a note on it, and files what is typed into that offer against it", function()
                local _, recorded = bootInWorld()

                recorded.frame:fire("SCREENSHOT_SUCCEEDED")

                local toast, box = noteToast(recorded)
                assert.is_true(toast:IsShown())
                -- A click on the toast, then a sentence, then Enter: the only route into
                -- the box, and the only thing in the addon that takes keyboard focus.
                toast:run("OnMouseUp")
                box:SetText("the sun coming up over Nagrand")
                box:run("OnEnterPressed")

                assert.equal("the sun coming up over Nagrand", recorded.db.entries[1].note)
            end)

            -- A cinematic or a loading screen is where the automatic triggers refuse to
            -- fire, and rightly: nobody wants a photograph of a black rectangle they did
            -- not ask for. Somebody pressing the key during one means it, and a deliberate
            -- act is never second-guessed.
            it("is recorded even with a loading screen between the player and the world", function()
                local _, recorded = bootInWorld()

                recorded.frame:fire("LOADING_SCREEN_ENABLED")
                recorded.frame:fire("SCREENSHOT_SUCCEEDED")

                assert.equal(1, #recorded.db.entries)
            end)

            -- The entry log's own refusal, reached through this door as well: screenshot
            -- filenames resolve to the second, so two markers in one second could only ever
            -- resolve to the same picture.
            it("files one entry for a burst of them inside the same second", function()
                local _, recorded = bootInWorld()

                for _ = 1, 5 do
                    recorded.frame:fire("SCREENSHOT_SUCCEEDED")
                end

                assert.equal(1, #recorded.db.entries)
            end)

            -- A shot the client abandoned resolves Chronie's claim on it, so the press
            -- cannot go on standing and swallow the next photograph the player takes.
            it("owns the next success after a shot of Chronie's own failed", function()
                local app, recorded = bootInWorld()
                app.capture()

                recorded.frame:fire("SCREENSHOT_FAILED")
                recorded.clock.advance(1)
                recorded.frame:fire("SCREENSHOT_SUCCEEDED")

                assert.equal(2, #recorded.db.entries)
                assert.is_nil(recorded.db.entries[2].trigger)
                assert.equal(1, recorded.screenshots())
            end)

            it("records nothing at all for a failure of its own", function()
                local app, recorded = bootInWorld()
                app.capture()

                recorded.frame:fire("SCREENSHOT_FAILED")

                assert.equal(1, #recorded.db.entries)
            end)
        end)
    end)

    -- The same record a photograph makes with the picture left out, written by the same log and
    -- offered by the same prompt: a memory is a capture without the shutter. These drive it
    -- through the whole addon, because the thing worth proving is that the second path really
    -- is the first one minus the shutter rather than a parallel one that has drifted.
    describe("marking a memory", function()
        ---Boot, log in and enter the world: an account minted, a segment open and a map named.
        ---@param options table?
        ---@return table app, table recorded
        local function bootInWorld(options)
            options = options or {}
            options.playerName = options.playerName or "Thrall"
            options.realmName = options.realmName or "Ragnaros"
            local app, recorded = boot(options)
            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            return app, recorded
        end

        ---The toast the prompt puts up, and the edit box inside it. Both are ordinary frames
        ---the addon built, so a test drives them the way a mouse and a keyboard would.
        ---@param recorded table
        ---@return table? toast, table? box
        local function noteToast(recorded)
            local toast
            for _, frame in ipairs(recorded.frames) do
                if frame.frameName == "ChronieEntryToast" then
                    toast = frame
                end
            end
            if not toast then
                return nil
            end
            for _, frame in ipairs(recorded.frames) do
                if frame.parent == toast and frame.frameType == "EditBox" then
                    return toast, frame
                end
            end
            return toast
        end

        it("exposes the memory the addon marks for itself", function()
            local app = bootInWorld()

            assert.is_function(app.remember)
        end)

        describe("with the sentence already typed", function()
            it("files one entry carrying the note and no picture", function()
                local app, recorded = bootInWorld()

                local entry = app.remember("Killed Ragnaros at last")

                assert.equal(1, #recorded.db.entries)
                assert.equal(entry, recorded.db.entries[1])
                assert.equal("Killed Ragnaros at last", entry.note)
                assert.is_nil(entry.hasImage)
            end)

            it("stamps it with who was playing and which account they are", function()
                local app, recorded = bootInWorld({ playerName = "Jaina", realmName = "Draenor" })

                local entry = app.remember("the sun coming up over Nagrand")

                assert.equal("Jaina-Draenor", entry.character)
                assert.equal(recorded.db.account.id, entry.author)
            end)

            it("records where the character was standing", function()
                local app, recorded = bootInWorld()
                recorded.setMap({ uiMapID = 84, x = 0.25, y = 0.75 })

                local entry = app.remember("right here")

                assert.equal(84, entry.uiMapID)
                assert.equal(0.25, entry.x)
                assert.equal(0.75, entry.y)
            end)

            -- Most of instanced content: the client names the map perfectly happily and then
            -- declines to say where on it you are standing. Never a fabricated 0, 0.
            it("records the map alone where the client gives no point", function()
                local app, recorded = bootInWorld({ instanceName = "Ulduar", instanceType = "raid" })
                recorded.setMap({ uiMapID = 2296 })

                local entry = app.remember("Yogg down")

                assert.equal(2296, entry.uiMapID)
                assert.is_nil(entry.x)
                assert.is_nil(entry.y)
            end)

            it("links it to the segment that was open", function()
                local app, recorded = bootInWorld({ instanceName = "Ulduar", instanceType = "raid" })

                local entry = app.remember("Yogg down")
                recorded.frame:fire("PLAYER_LOGOUT")

                assert.equal(recorded.db.segments[1].id, entry.segment)
            end)

            -- An evening spent standing somewhere writing notes moves no other counter, so
            -- without the tally being told the tracker would drop the segment and take the
            -- link above down with it.
            it("makes that segment worth filing on its own", function()
                local app, recorded = bootInWorld()

                app.remember("something worth remembering")
                recorded.frame:fire("PLAYER_LOGOUT")

                assert.equal(1, #recorded.db.segments)
            end)

            -- There is no picture here and there was never meant to be one. A shutter fired
            -- for a memory would leave an image on disk that no marker claims, which reads
            -- downstream as a photograph somebody else took.
            it("reaches for no shutter at all", function()
                local app, recorded = bootInWorld()

                app.remember("no picture, thank you")

                assert.equal(0, recorded.screenshots())
            end)

            -- The memory is complete the moment it is written. A toast asking for the sentence
            -- that has just been typed is a box in the way of somebody already doing something
            -- else, and it has nothing to ask for.
            it("puts up no toast", function()
                local app, recorded = bootInWorld()

                app.remember("Killed Ragnaros at last")

                local toast = noteToast(recorded)
                assert.is_true(toast == nil or not toast:IsShown())
            end)

            -- Two sentences in one second is two memories: the entry log's cooldown protects
            -- two screenshot filenames from being confused, and there are no files here.
            it("takes a second memory inside the same second", function()
                local app, recorded = bootInWorld()

                app.remember("the first thing")
                app.remember("the second thing")

                assert.equal(2, #recorded.db.entries)
                assert.equal("the second thing", recorded.db.entries[2].note)
            end)

            -- The one user-authored string in the record, and the reason ns.entryText exists:
            -- what reaches SavedVariables has to be safe for a Lua file, a hand-written Rust
            -- reader, a SQLite row and a React tree.
            it("cleans the pipes out of what reaches SavedVariables", function()
                local app, recorded = bootInWorld()

                app.remember("got |cffa335ee|Hitem:19019::::::::60:::::|h[Thunderfury]|h|r")

                local note = recorded.db.entries[1].note
                assert.is_truthy(note:find("[Thunderfury]", 1, true))
                assert.is_nil(note:find("|", 1, true))
            end)

            it("folds a pasted sentence onto one line", function()
                local app, recorded = bootInWorld()

                app.remember("  two\nlines\tapart  ")

                assert.equal("two lines apart", recorded.db.entries[1].note)
            end)

            -- Sanitising is not escaping. The markup is the player's and it is stored
            -- verbatim; escaping belongs to the one place downstream that builds HTML.
            it("leaves markup a player typed exactly as they typed it", function()
                local app, recorded = bootInWorld()

                app.remember("<b>first</b> Yogg kill")

                assert.equal("<b>first</b> Yogg kill", recorded.db.entries[1].note)
            end)

            -- Nothing survived the cleaning, so this is the same as having typed nothing: the
            -- box is offered instead of a row full of a colour code being filed.
            it("offers the box for a sentence that was nothing but escapes", function()
                local app, recorded = bootInWorld()

                app.remember("|TInterface\\Icons\\foo:16|t")

                local toast = noteToast(recorded)
                assert.is_true(toast:IsShown())
                assert.is_nil(recorded.db.entries[1].note)
            end)

            it("writes nothing before the world has loaded and the account has a name", function()
                local app, recorded = boot({
                    playerName = "Thrall",
                    realmName = "Ragnaros",
                    playerGUID = false,
                })

                assert.is_nil(app.remember("too early for this"))
                assert.same({}, recorded.db.entries)
            end)
        end)

        describe("with nothing typed yet", function()
            it("files the moment now and asks for the sentence", function()
                local app, recorded = bootInWorld()

                local entry = app.remember()

                assert.equal(1, #recorded.db.entries)
                assert.equal(entry, recorded.db.entries[1])
                assert.is_nil(entry.note)
                assert.is_nil(entry.hasImage)
                assert.equal(0, recorded.screenshots())
            end)

            -- The one thing in the addon that opens focused, and only because asking for a
            -- memory by name is the deliberate act the no-autofocus rule makes room for.
            it("opens the box focused, without waiting to be clicked", function()
                local app, recorded = bootInWorld()

                app.remember()

                local toast, box = noteToast(recorded)
                assert.is_true(toast:IsShown())
                assert.is_true(box:IsShown())
                assert.is_true(box:HasFocus())
            end)

            -- The moment belongs to where the player was standing when they decided to write
            -- it down, not to wherever they happen to be twenty seconds later.
            it("stamps the moment when it was asked for rather than when it was finished", function()
                local app, recorded = bootInWorld()
                local at = recorded.clock.now()

                local entry = app.remember()
                recorded.clock.advance(15)
                recorded.setMap({ uiMapID = 2296 })
                local toast, box = noteToast(recorded)
                toast:run("OnMouseUp")
                box:SetText("about where I was standing")
                box:run("OnEnterPressed")

                assert.equal(at, entry.at)
                assert.equal(84, entry.uiMapID)
            end)

            it("keeps the row and attaches what was typed into the box", function()
                local app, recorded = bootInWorld()
                app.remember()

                local _, box = noteToast(recorded)
                box:SetText("the sun coming up over Nagrand")
                box:run("OnEnterPressed")

                assert.equal(1, #recorded.db.entries)
                assert.equal("the sun coming up over Nagrand", recorded.db.entries[1].note)
            end)

            it("cleans what was typed into the box on the way to the file", function()
                local app, recorded = bootInWorld()
                app.remember()

                local _, box = noteToast(recorded)
                box:SetText("two\nlines |cffff0000apart|r")
                box:run("OnEnterPressed")

                assert.equal("two lines apartr", recorded.db.entries[1].note)
            end)

            -- The box opens focused, and an offer somebody is typing into has no deadline at
            -- all: taking the box away mid-sentence is worse than a toast that outstays its
            -- welcome. So this one cannot lapse while the box holds focus.
            it("keeps the offer open while the box still has focus", function()
                local app, recorded = bootInWorld()
                app.remember()
                local toast = noteToast(recorded)

                recorded.clock.advance(600)
                toast:run("OnUpdate")

                assert.is_true(toast:IsShown())
                assert.equal(1, #recorded.db.entries)
            end)

            -- A memory is its text and nothing else, so one nobody wrote anything about is a
            -- record of nothing, and the right amount of that to keep in the file is none.
            -- Clicking away from the box starts the clock again, and this is what runs out.
            it("takes the row back out again when the offer lapses", function()
                local app, recorded = bootInWorld()
                app.remember()
                local toast, box = noteToast(recorded)

                box:run("OnEditFocusLost")
                recorded.clock.advance(20)
                toast:run("OnUpdate")

                assert.same({}, recorded.db.entries)
                assert.is_false(toast:IsShown())
            end)

            -- The one path the expiry clock cannot reach. An engaged prompt has no deadline at
            -- all, so a memory whose box still holds focus is a note-less row that nothing will
            -- ever come back for — and logout is the moment the file is written. Without the
            -- dismissal on the way out it would be written holding a memory of nothing.
            it("takes the row back out again when the player logs out mid-sentence", function()
                local app, recorded = bootInWorld()
                app.remember()
                local toast = noteToast(recorded)

                recorded.frame:fire("PLAYER_LOGOUT")

                assert.same({}, recorded.db.entries)
                assert.is_false(toast:IsShown())
            end)

            -- The other half of that, and the reason the dismissal cannot simply discard
            -- whatever is pending: a photograph is a record with or without a sentence about it.
            it("keeps a photographed entry when the player logs out mid-sentence", function()
                local app, recorded = bootInWorld()
                app.capture()

                recorded.frame:fire("PLAYER_LOGOUT")

                assert.equal(1, #recorded.db.entries)
                assert.is_true(recorded.db.entries[1].hasImage)
                assert.is_nil(recorded.db.entries[1].note)
            end)

            it("takes the row back out again when the box is escaped away empty", function()
                local app, recorded = bootInWorld()
                app.remember()
                local _, box = noteToast(recorded)

                box:run("OnEscapePressed")

                assert.same({}, recorded.db.entries)
            end)

            it("takes the row back out again when an empty box is submitted", function()
                local app, recorded = bootInWorld()
                app.remember()
                local _, box = noteToast(recorded)

                box:SetText("   ")
                box:run("OnEnterPressed")

                assert.same({}, recorded.db.entries)
            end)

            -- Everything the memory kept alive goes with it: a segment filed only because
            -- somebody started writing a note and thought better of it is a segment nothing
            -- happened in, but the tally has already been told, so it stays. The row is what
            -- must not survive.
            it("leaves no entry behind for a segment it kept alive", function()
                local app, recorded = bootInWorld()
                app.remember()
                local toast, box = noteToast(recorded)
                box:run("OnEditFocusLost")
                recorded.clock.advance(20)
                toast:run("OnUpdate")

                recorded.frame:fire("PLAYER_LOGOUT")

                assert.same({}, recorded.db.entries)
                assert.equal(1, #recorded.db.segments)
            end)

            -- A photograph is the opposite of a memory here: the picture is the record and the
            -- sentence about it was only ever an offer, so an offer nobody took leaves the
            -- entry exactly where it is.
            it("leaves a photograph's entry alone when its own offer lapses", function()
                local app, recorded = bootInWorld()
                app.capture()
                local toast = noteToast(recorded)

                recorded.clock.advance(20)
                toast:run("OnUpdate")

                assert.equal(1, #recorded.db.entries)
                assert.is_true(recorded.db.entries[1].hasImage)
            end)

            -- Somebody is mid-sentence about a photograph and asks for a memory. There is no
            -- box to put it in and no text to keep it alive, so it goes back out again rather
            -- than sitting in the file forever as a memory of nothing.
            it("writes nothing while somebody is mid-sentence on an earlier entry", function()
                local app, recorded = bootInWorld()
                app.capture()
                local toast, box = noteToast(recorded)
                toast:run("OnMouseUp")

                assert.is_nil(app.remember())

                assert.equal(1, #recorded.db.entries)
                assert.is_true(recorded.db.entries[1].hasImage)
                -- And the sentence being written still lands on the picture it is about.
                box:SetText("the shot I was writing about")
                box:run("OnEnterPressed")
                assert.equal("the shot I was writing about", recorded.db.entries[1].note)
            end)
        end)

        describe("the /chronie note command", function()
            it("marks a memory out of the rest of the line", function()
                local app, recorded = bootInWorld()

                recorded.slashRegistrations[1].handler("note Killed Ragnaros at last")

                assert.equal(1, #recorded.db.entries)
                assert.equal("Killed Ragnaros at last", recorded.db.entries[1].note)
                assert.is_nil(recorded.db.entries[1].hasImage)
                assert.equal(0, recorded.screenshots())
                -- The memory itself is the acknowledgement; there is nothing to say back.
                assert.same({}, recorded.lines)
                assert.is_nil(app.entryPrompt.pending())
            end)

            it("offers the box when the line stops at the subcommand", function()
                local _, recorded = bootInWorld()

                recorded.slashRegistrations[1].handler("note")

                local toast, box = noteToast(recorded)
                assert.is_true(toast:IsShown())
                assert.is_true(box:HasFocus())
                assert.same({}, recorded.lines)
            end)

            it("is named in the usage line", function()
                local _, recorded = bootInWorld()

                recorded.slashRegistrations[1].handler("nonsense")

                assert.is_truthy(recorded.lines[1]:find("note [text]", 1, true))
            end)

            -- The only thing worth a word is having written nothing at all, which before the
            -- world has loaded is what happens: there is no account to author the entry.
            it("says nothing was written down when the entry could not be filed", function()
                local _, recorded = boot({
                    playerName = "Thrall",
                    realmName = "Ragnaros",
                    playerGUID = false,
                })

                recorded.slashRegistrations[1].handler("note")

                assert.equal(1, #recorded.lines)
                assert.is_truthy(recorded.lines[1]:find("nothing was written down", 1, true))
                assert.same({}, recorded.db.entries)
            end)
        end)
    end)

    describe("capturing without being asked", function()
        ---Boot into the world with a given allowlist, the way an installed copy the
        ---desktop app configured arrives.
        ---@param triggers string[]?
        ---@return table app, table recorded
        local function bootWithTriggers(triggers)
            local options = { playerName = "Thrall", realmName = "Ragnaros" }
            if triggers then
                options.settings = { captureTriggers = triggers }
            end
            local app, recorded = boot(options)
            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            return app, recorded
        end

        -- The acceptance criterion, end to end through the real dispatch: the client says
        -- an achievement was earned for the first time, and a photograph of it exists.
        it("photographs an account-first achievement and files it against that achievement", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
            local entry = recorded.db.entries[1]
            assert.equal("accountFirstAchievement", entry.trigger)
            assert.equal(12345, entry.achievement)
            assert.is_true(entry.hasImage)
        end)

        -- The addon ships conservative, and an installed copy nobody has configured must
        -- behave the same way rather than photographing everything or nothing.
        it("ships with the account-first rule and nothing else", function()
            local ns = loader.load()

            assert.same({ "accountFirstAchievement" }, ns.settings.captureTriggers)
        end)

        it("leaves an achievement the account already had alone", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, true)

            assert.equal(0, recorded.screenshots())
            assert.same({}, recorded.db.entries)
        end)

        it("takes no picture at all when the allowlist is empty", function()
            local _, recorded = bootWithTriggers({})

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)

            assert.equal(0, recorded.screenshots())
        end)

        -- Thirty achievements over a minute is one memory, not thirty pictures of the same
        -- corridor. Two seconds apart and settled one at a time, so each opens and closes a
        -- window of its own: what refuses the other twenty-nine here is the rate limit, and
        -- the burst below is what covers the ones that arrive together.
        it("takes one picture of a raid clear rather than thirty", function()
            local _, recorded = bootWithTriggers()

            for id = 1, 30 do
                recorded.frame:fire("ACHIEVEMENT_EARNED", id, false)
                recorded.settle()
                recorded.clock.advance(2)
            end

            assert.equal(1, recorded.screenshots())
            assert.equal(1, #recorded.db.entries)
        end)

        -- The acceptance criterion for the burst, and the case the rate limit above cannot
        -- speak for: a boss kill earning the boss, the wing and the meta all in the same
        -- instant is one photograph, and it would be one even with no rate limit at all.
        it("takes one picture of a moment that fires four triggers at once", function()
            local _, recorded = bootWithTriggers({ "achievement", "mount", "toy" })

            recorded.frame:fire("ACHIEVEMENT_EARNED", 1, true)
            recorded.frame:fire("ACHIEVEMENT_EARNED", 2, true)
            recorded.frame:fire("NEW_MOUNT_ADDED", 1234)
            recorded.frame:fire("NEW_TOY_ADDED", 999)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
            assert.equal(1, #recorded.db.entries)
        end)

        -- Nothing is photographed in the frame the event arrived in. The client has not
        -- drawn the alert yet and whatever was just killed is still falling over.
        it("waits for the moment to finish before pressing the shutter", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)

            assert.equal(0, recorded.screenshots())
            assert.same({}, recorded.db.entries)

            recorded.settle()
            assert.equal(1, recorded.screenshots())
        end)

        -- Which of the burst the picture is filed against, where the player allowed both
        -- rules: the account first is the memory even when a plain one opened the window.
        it("files a burst against the most specific achievement in it", function()
            local _, recorded = bootWithTriggers({ "accountFirstAchievement", "achievement" })

            recorded.frame:fire("ACHIEVEMENT_EARNED", 111, true)
            recorded.frame:fire("ACHIEVEMENT_EARNED", 222, false)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
            assert.equal("accountFirstAchievement", recorded.db.entries[1].trigger)
            assert.equal(222, recorded.db.entries[1].achievement)
        end)

        it("photographs the next account first once the rate limit has passed", function()
            local _, recorded = bootWithTriggers()
            recorded.frame:fire("ACHIEVEMENT_EARNED", 1, false)
            recorded.settle()

            recorded.clock.advance(60)
            recorded.frame:fire("ACHIEVEMENT_EARNED", 2, false)
            recorded.settle()

            assert.equal(2, recorded.screenshots())
            assert.equal(2, recorded.db.entries[2].achievement)
        end)

        -- Events fire during a loading screen and the picture that comes back is a black
        -- rectangle. Nothing is queued for later: the moment has gone.
        it("takes no picture while a loading screen is up", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("LOADING_SCREEN_ENABLED")
            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()

            assert.equal(0, recorded.screenshots())
        end)

        -- The half second the burst waits is long enough for the world to go away in, and a
        -- keystone that ends on time completes the run and then teleports the party out. The
        -- picture behind that loading screen is a black rectangle, so there is no picture.
        it("takes no picture when a loading screen starts while the window is open", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.frame:fire("LOADING_SCREEN_ENABLED")
            recorded.settle()

            assert.equal(0, recorded.screenshots())
            assert.same({}, recorded.db.entries)
        end)

        -- Nothing is queued for later, so the moment is gone; but the rate limit was never
        -- started either, and the next real one must not be refused on its behalf.
        it("photographs the next moment after a window a loading screen swallowed", function()
            local _, recorded = bootWithTriggers()
            recorded.frame:fire("ACHIEVEMENT_EARNED", 1, false)
            recorded.frame:fire("LOADING_SCREEN_ENABLED")
            recorded.settle()

            recorded.frame:fire("LOADING_SCREEN_DISABLED")
            recorded.frame:fire("ACHIEVEMENT_EARNED", 2, false)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
            assert.equal(2, recorded.db.entries[1].achievement)
        end)

        it("takes one again once the loading screen has lifted", function()
            local _, recorded = bootWithTriggers()
            recorded.frame:fire("LOADING_SCREEN_ENABLED")

            recorded.frame:fire("LOADING_SCREEN_DISABLED")
            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
        end)

        -- A load screen the client never said it had lifted would silence automatic
        -- capture for the rest of the session, so entering the world clears it too.
        it("clears a loading screen that entering the world ended", function()
            local _, recorded = bootWithTriggers()
            recorded.frame:fire("LOADING_SCREEN_ENABLED")

            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
        end)

        it("takes no picture during a cinematic", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("CINEMATIC_START")
            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()

            assert.equal(0, recorded.screenshots())

            recorded.frame:fire("CINEMATIC_STOP")
            recorded.frame:fire("ACHIEVEMENT_EARNED", 12346, false)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
        end)

        -- Filed the way a pressed capture is, because it is one: the segment link is what
        -- gives the photograph its location, class and difficulty.
        it("links an automatic capture to the segment it happened in", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()
            recorded.frame:fire("PLAYER_LOGOUT")

            assert.equal(recorded.db.segments[1].id, recorded.db.entries[1].segment)
        end)

        -- The regression ns.newScreenshotWatch exists to prevent, and the one thing that
        -- could have gone wrong the moment the addon started listening for the event: the
        -- client fires SCREENSHOT_SUCCEEDED for Chronie's own shot too, so a handler that
        -- believed every success was the player's would file a second entry for every
        -- automatic capture — same second, same segment, one of them claiming a trigger and
        -- one of them claiming a person decided.
        --
        -- The second between the two is what makes this an assertion about the watch. The
        -- client writes the file asynchronously and the event comes back whenever it comes
        -- back, so a boundary in between is ordinary; and inside the same second the entry
        -- log's own image cooldown would refuse the duplicate anyway, which would let this
        -- pass with no watch at all.
        it("files one entry for its own shot, not a second when the client reports it", function()
            local _, recorded = bootWithTriggers()

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()
            recorded.clock.advance(1)
            recorded.frame:fire("SCREENSHOT_SUCCEEDED")

            assert.equal(1, #recorded.db.entries)
            assert.equal("accountFirstAchievement", recorded.db.entries[1].trigger)
        end)

        -- The same, for the capture a person asked for through app.capture: nothing about
        -- the claim depends on which of the two pressed the shutter.
        it("files one entry for a capture it was asked for, however the client reports it", function()
            local app, recorded = bootWithTriggers()

            app.capture()
            recorded.clock.advance(1)
            recorded.frame:fire("SCREENSHOT_SUCCEEDED")

            assert.equal(1, #recorded.db.entries)
        end)

        -- A pressed capture is somebody deciding, and it says so by carrying no trigger.
        it("leaves a pressed capture unmarked", function()
            local app, recorded = bootWithTriggers()

            app.capture()

            assert.is_nil(recorded.db.entries[1].trigger)
            assert.is_nil(recorded.db.entries[1].achievement)
        end)

        -- The rate limit is about Chronie's own noise. Somebody holding the keybinding
        -- down is doing something deliberate and is not what it is protecting against.
        it("does not let the rate limit refuse a pressed capture", function()
            local app, recorded = bootWithTriggers()
            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)
            recorded.settle()

            recorded.clock.advance(1)

            assert.is_table(app.capture())
            assert.equal(2, recorded.screenshots())
        end)

        for _, case in ipairs({
            { trigger = "levelUp", fire = { "PLAYER_LEVEL_UP", 70 } },
            { trigger = "mount", fire = { "NEW_MOUNT_ADDED", 1234 } },
            { trigger = "toy", fire = { "NEW_TOY_ADDED", 999 } },
        }) do
            it("photographs a " .. case.trigger .. " for somebody who asked for one", function()
                local _, recorded = bootWithTriggers({ case.trigger })

                recorded.frame:fire(unpack(case.fire))
                recorded.settle()

                assert.equal(1, recorded.screenshots())
                assert.equal(case.trigger, recorded.db.entries[1].trigger)
                -- Only the achievement has a subject; the rest hang off the segment.
                assert.is_nil(recorded.db.entries[1].achievement)
            end)

            it("leaves a " .. case.trigger .. " alone by default", function()
                local _, recorded = bootWithTriggers()

                recorded.frame:fire(unpack(case.fire))
                recorded.settle()

                assert.equal(0, recorded.screenshots())
            end)
        end

        it("photographs a keystone that beat the timer", function()
            local _, recorded = bootWithTriggers({ "keystoneOnTime" })
            recorded.setKeystoneCompletion({
                level = 20, mapId = 375, durationMs = 1000, onTime = true, upgrades = 1,
            })

            recorded.frame:fire("CHALLENGE_MODE_COMPLETED")
            recorded.settle()

            assert.equal(1, recorded.screenshots())
            assert.equal("keystoneOnTime", recorded.db.entries[1].trigger)
        end)

        it("leaves a keystone that missed the timer alone", function()
            local _, recorded = bootWithTriggers({ "keystoneOnTime" })
            recorded.setKeystoneCompletion({
                level = 20, mapId = 375, durationMs = 1000, onTime = false, upgrades = 0,
            })

            recorded.frame:fire("CHALLENGE_MODE_COMPLETED")
            recorded.settle()

            assert.equal(0, recorded.screenshots())
        end)

        ---The same boot, with a wardrobe: a source event has nothing to photograph unless
        ---the client can say what item it was and whether the look was new.
        ---@param triggers string[]
        ---@param sources table<integer, table>
        local function bootWithWardrobe(triggers, sources)
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                settings = { captureTriggers = triggers },
                transmogSources = sources,
            })
            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            return app, recorded
        end

        it("photographs an appearance new to the collection", function()
            local _, recorded = bootWithWardrobe({ "newAppearance" }, {
                [11] = { item = 19019, visualID = 800, newAppearance = true },
            })

            recorded.frame:fire("TRANSMOG_COLLECTION_SOURCE_ADDED", 11)
            recorded.settle()

            assert.equal(1, recorded.screenshots())
            assert.equal("newAppearance", recorded.db.entries[1].trigger)
        end)

        -- Emptying a bag at a vendor collects a dozen sources for looks already owned, and
        -- a photograph of each of those is the noise the specific rule exists to avoid.
        it("leaves another item wearing an appearance already owned alone", function()
            local _, recorded = bootWithWardrobe({ "newAppearance" }, {
                [12] = { item = 19020, visualID = 800, newAppearance = false },
            })

            recorded.frame:fire("TRANSMOG_COLLECTION_SOURCE_ADDED", 12)
            recorded.settle()

            assert.equal(0, recorded.screenshots())
        end)

        it("leaves a transmog source alone by default", function()
            local _, recorded = bootWithWardrobe({ "accountFirstAchievement" }, {
                [11] = { item = 19019, visualID = 800, newAppearance = true },
            })

            recorded.frame:fire("TRANSMOG_COLLECTION_SOURCE_ADDED", 11)
            recorded.settle()

            assert.equal(0, recorded.screenshots())
        end)

        -- The same rule the achievement follows: the picture rides inside the handler that
        -- already folds the source into the tally, rather than in a second subscription.
        it("counts the transmog it photographed as well", function()
            local app, recorded = bootWithWardrobe({ "newAppearance" }, {
                [11] = { item = 19019, visualID = 800, newAppearance = true },
            })

            recorded.frame:fire("TRANSMOG_COLLECTION_SOURCE_ADDED", 11)

            assert.equal(1, #app.tally.summary().transmogs)
        end)

        -- Not a second subscription to ACHIEVEMENT_EARNED: the capture rides inside the
        -- handler that already folds the achievement into the tally, so the two can never
        -- disagree about what happened.
        it("counts the achievement it photographed as well", function()
            local app, recorded = bootWithTriggers()

            recorded.frame:fire("ACHIEVEMENT_EARNED", 12345, false)

            local achievements = app.tally.summary().achievements
            assert.equal(1, #achievements)
            assert.equal(12345, achievements[1].id)
        end)
    end)

    describe("the current segment panel", function()
        ---@param itemID integer
        ---@return string a self-loot chat line's item link
        local function link(itemID)
            return "|cffa335ee|Hitem:" .. itemID .. "::::::::::::|h[Item " .. itemID .. "]|h|r"
        end

        it("stays lazy until a zone is entered or the slash is used", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            -- Only the event dispatcher's frame exists; the segment panel is lazy.
            assert.equal(2, #recorded.frames)
        end)

        -- Every zone is a segment now, so the panel comes up in the open world too — the
        -- current breakdown is always on show, not only inside instances.
        it("shows the panel on entering the open world", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros", instanceType = nil })

            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.is_true(app.tally.isActive())
            assert.is_true(app.resultsWindow.isShown())
        end)

        it("shows the panel with a fresh tally on entering an instance", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                money = 500,
            })

            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.is_true(app.tally.isActive())
            assert.is_true(app.resultsWindow.isShown())
            assert.equal(0, app.tally.summary().lootValue)
        end)

        it("keeps the panel up when moving from an instance out to the world", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            -- A fresh world segment is open, so the tally is active and the panel stays on.
            assert.is_true(app.tally.isActive())
            assert.is_true(app.resultsWindow.isShown())
        end)

        it("folds a wallet change into the gold looted while inside", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                money = 0,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setMoney(1000)
            recorded.frame:fire("PLAYER_MONEY")

            assert.equal(1000, app.tally.summary().goldLooted)
        end)

        it("adds a looted item's vendor value from the loot chat event", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                itemPrices = { [4242] = 60 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("CHAT_MSG_LOOT", "You receive loot: " .. link(4242) .. "x2.")

            assert.equal(120, app.tally.summary().itemValue)
        end)

        ---What the panel itself is showing as the loot value. The value font string is
        ---created straight after its label, so it is the one following "Loot value".
        ---@param recorded table
        ---@return string?
        local function panelLootValue(recorded)
            for _, frame in ipairs(recorded.frames) do
                if frame.frameName == "ChronieResultsWindow" then
                    for index, fontString in ipairs(frame.fontStrings) do
                        if fontString.text == "Loot value" then
                            local value = frame.fontStrings[index + 1]
                            return value and value.text
                        end
                    end
                end
            end
        end

        -- A quest reward, a container's contents and anything else the server pushes
        -- straight into a bag are worded "You receive item:", which the addon used to
        -- offer no template for and so never counted at all.
        it("counts an item pushed straight into a bag in the panel", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                itemPrices = { [4242] = 60 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("CHAT_MSG_LOOT", "You receive item: " .. link(4242) .. ".")

            assert.equal(60, app.tally.summary().itemValue)
            assert.equal("60c", panelLootValue(recorded))
        end)

        it("counts a bonus roll's loot in the panel", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                itemPrices = { [4242] = 60 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("CHAT_MSG_LOOT", "You receive bonus loot: " .. link(4242) .. "x2.")

            assert.equal(120, app.tally.summary().itemValue)
            assert.equal("1s 20c", panelLootValue(recorded))
        end)

        -- The singular template also matches a stacked line and would swallow the "x3",
        -- so a stack counts in full only while each _MULTIPLE variant is offered first.
        it("counts a stacked pushed-loot line as the whole stack", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                itemPrices = { [4242] = 60 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("CHAT_MSG_LOOT", "You receive item: " .. link(4242) .. "x3.")

            assert.equal(180, app.tally.summary().itemValue)
        end)

        -- A first-time drop is not cached when its loot line arrives, so the tally parks
        -- it unpriced; GET_ITEM_INFO_RECEIVED is the server answering that price query.
        it("folds a first-time drop's value in when the client answers with its price", function()
            local prices = {}
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                itemPrices = prices,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.frame:fire("CHAT_MSG_LOOT", "You receive loot: " .. link(4242) .. "x2.")
            assert.equal(0, app.tally.summary().itemValue)
            assert.equal("0c", panelLootValue(recorded))

            prices[4242] = 60
            recorded.frame:fire("GET_ITEM_INFO_RECEIVED", 4242)

            assert.equal(120, app.tally.summary().itemValue)
            assert.equal("1s 20c", panelLootValue(recorded))
        end)

        it("ignores a price answer for an item this segment never looted", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                itemPrices = { [4242] = 60, [9999] = 500 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.frame:fire("CHAT_MSG_LOOT", "You receive loot: " .. link(4242) .. ".")

            recorded.frame:fire("GET_ITEM_INFO_RECEIVED", 9999)

            assert.equal(60, app.tally.summary().itemValue)
        end)

        it("accumulates reputation from the faction-change event", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire(
                "CHAT_MSG_COMBAT_FACTION_CHANGE",
                "Your Argent Dawn reputation has increased by 40."
            )

            assert.same(
                { { faction = "Argent Dawn", amount = 40 } },
                app.tally.summary().reputation
            )
        end)

        it("carries the standing the client reports for the faction that gained", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                factions = {
                    ["Argent Dawn"] = { standing = "Honored", current = 3000, max = 12000 },
                },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire(
                "CHAT_MSG_COMBAT_FACTION_CHANGE",
                "Your Argent Dawn reputation has increased by 40."
            )

            assert.same({
                {
                    faction = "Argent Dawn",
                    amount = 40,
                    standing = "Honored",
                    current = 3000,
                    max = 12000,
                },
            }, app.tally.summary().reputation)
        end)

        it("records a newly collected transmog item from its source event", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                transmogSources = { [11] = { item = 19019 } },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("TRANSMOG_COLLECTION_SOURCE_ADDED", 11)

            assert.same({ { id = 19019, sourceID = 11, at = 1000 } }, app.tally.summary().transmogs)
        end)

        it("records an equipment set created after the first look at them", function()
            local sets = {}
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                equipmentSets = sets,
                equippedItems = { [1] = { id = 100, level = 639, name = "Tideglass Crown" } },
            })
            -- Opening the segment is also the ledger's first look, which is what makes the
            -- set below new rather than one of the ones the character already had.
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            sets[3] = { name = "Raid", items = { [1] = 100 } }
            recorded.frame:fire("EQUIPMENT_SETS_CHANGED")

            assert.same({
                {
                    setId = 3, name = "Raid", kind = "created", at = 1000,
                    items = {
                        { slot = 1, itemId = 100, itemLevel = 639, itemName = "Tideglass Crown" },
                    },
                },
            }, app.tally.summary().equipsetChanges)
        end)

        it("records a set deleted while the addon was not watching, at the next login", function()
            local sets = { [3] = { name = "Raid", items = { [1] = 100 } } }
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                equipmentSets = sets,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            sets[3] = nil
            recorded.frame:fire("ZONE_CHANGED_NEW_AREA")

            local changes = app.tally.summary().equipsetChanges
            assert.equal(1, #changes)
            assert.equal("deleted", changes[1].kind)
            assert.equal("Raid", changes[1].name)
        end)

        -- Sets belong to a character but the saved file belongs to the account, so two alts
        -- must not be able to read each other's last look and invent changes out of it.
        it("keeps each character's last look apart in the saved file", function()
            local sets = { [3] = { name = "Raid", items = { [1] = 100 } } }
            local db = {}
            local _, thrall = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                equipmentSets = sets,
                db = db,
            })
            thrall.frame:fire("PLAYER_ENTERING_WORLD")

            local jaina, jainaRecorded = boot({
                playerName = "Jaina",
                realmName = "Ragnaros",
                instanceType = "party",
                equipmentSets = sets,
                db = db,
            })
            jainaRecorded.frame:fire("PLAYER_ENTERING_WORLD")

            -- Jaina has never been looked at, so her first look seeds rather than reporting
            -- Thrall's set as one she just created.
            assert.same({}, jaina.tally.summary().equipsetChanges)
            assert.is_not_nil(db.equipsets["Thrall-Ragnaros"])
            assert.is_not_nil(db.equipsets["Jaina-Ragnaros"])
        end)

        it("records newly collected mounts, pets and toys from their collection events", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                mounts = { [123] = "Alabaster Hyena" },
                pets = { ["BattlePet-0-1"] = { id = 456, name = "Darkmoon Rabbit" } },
                toys = { [789] = "Katy's Stampwhistle" },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("NEW_MOUNT_ADDED", 123)
            recorded.frame:fire("NEW_PET_ADDED", "BattlePet-0-1")
            recorded.frame:fire("NEW_TOY_ADDED", 789)

            local summary = app.tally.summary()
            assert.same({ { id = 123, name = "Alabaster Hyena", at = 1000 } }, summary.mounts)
            assert.same({
                { id = 456, name = "Darkmoon Rabbit", at = 1000, guid = "BattlePet-0-1" },
            }, summary.pets)
            assert.same({ { id = 789, name = "Katy's Stampwhistle", at = 1000 } }, summary.toys)
        end)

        it("records a pet as a species first when the account now holds just one", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "none",
                pets = { ["BattlePet-0-1"] = { id = 456, name = "Darkmoon Rabbit", owned = 1 } },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("NEW_PET_ADDED", "BattlePet-0-1")

            assert.is_true(app.tally.summary().pets[1].speciesFirst)
        end)

        it("records another of a species already held as not a species first", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "none",
                pets = { ["BattlePet-0-2"] = { id = 456, name = "Darkmoon Rabbit", owned = 3 } },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("NEW_PET_ADDED", "BattlePet-0-2")

            assert.is_false(app.tally.summary().pets[1].speciesFirst)
        end)

        it("records a housing item as a warband first when the warband owns just one", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "none",
                housingItems = { [4001] = { name = "Sturdy Oak Chair", quantity = 1 } },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("HOUSING_DECOR_ADDED", 4001)

            assert.same(
                { { id = 4001, name = "Sturdy Oak Chair", at = 1000, warbandFirst = true } },
                app.tally.summary().housingItems
            )
        end)

        it("records a duplicate housing item as not a warband first", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "none",
                housingItems = { [4001] = { name = "Sturdy Oak Chair", quantity = 2 } },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("HOUSING_DECOR_ADDED", 4001)

            assert.is_false(app.tally.summary().housingItems[1].warbandFirst)
        end)

        it("sums housing experience from the housing xp event", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "none",
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("HOUSING_XP_GAINED", 120)
            recorded.frame:fire("HOUSING_XP_GAINED", 80)

            assert.equal(200, app.tally.summary().housingXP)
        end)

        it("records a housing level from the housing level up event", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "none",
                now = 1700000000,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("HOUSING_LEVEL_UP", 3)

            assert.same({ { level = 3, at = 1700000000 } }, app.tally.summary().housingLevelUps)
        end)

        -- The open world is a tracked segment now, so a loot line out there counts just
        -- as it would inside an instance.
        it("tracks loot fired out in the open world", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = nil,
                itemPrices = { [4242] = 60 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("CHAT_MSG_LOOT", "You receive loot: " .. link(4242) .. ".")

            assert.equal(60, app.tally.summary().itemValue)
        end)

        it("records a currency change from the currency event, named through the seam", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                currencies = { [1166] = "Timewarped Badge" },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            -- currencyType, quantity, quantityChange — the client hands over both the
            -- change and what the character is left holding.
            recorded.frame:fire("CURRENCY_DISPLAY_UPDATE", 1166, 30, 15)

            assert.same(
                { { id = 1166, name = "Timewarped Badge", amount = 15, total = 30 } },
                app.tally.summary().currencies
            )
        end)

        it("records an item-based currency gain when its owned count rises", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                currencyItems = { [5001] = { name = "Bloody Token", count = 40 } },
                trackedCurrencies = { 5001 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setItemCount(5001, 55)
            recorded.frame:fire("BAG_UPDATE_DELAYED")

            assert.same(
                { { id = 5001, name = "Bloody Token", amount = 15, total = 55 } },
                app.tally.summary().currencies
            )
        end)

        it("records an item-based currency spend when its owned count falls", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                currencyItems = { [5001] = { name = "Bloody Token", count = 40 } },
                trackedCurrencies = { 5001 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setItemCount(5001, 12)
            recorded.frame:fire("BAG_UPDATE_DELAYED")

            assert.equal(-28, app.tally.summary().currencies[1].amount)
        end)

        -- Depositing to (or withdrawing from) the warband bank moves the item between
        -- stores the owned count already spans, so the total is flat and nothing records.
        it("does not miscount a bank deposit as a currency change", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                currencyItems = { [5001] = { name = "Bloody Token", count = 40 } },
                trackedCurrencies = { 5001 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("BAG_UPDATE_DELAYED")

            assert.same({}, app.tally.summary().currencies)
        end)

        it("opens the currency manager on the slash command", function()
            local app = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            app.router.dispatch("currency")
            assert.is_true(app.currencyWindow.isShown())

            app.router.dispatch("currency")
            assert.is_false(app.currencyWindow.isShown())
        end)

        -- The whole loop through the real seams: pick an item up, drop it on the manager,
        -- and it becomes tracked; holdings that predate the choice are not booked, but a
        -- genuine gain afterwards is.
        it("tracks an item dropped on the manager, then counts it without back-dating", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                currencyItems = { [5001] = { name = "Bloody Token", count = 40 } },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            app.currencyWindow.show()
            recorded.setCursorItem(5001)
            local slot
            for _, frame in ipairs(recorded.frames) do
                if frame.parent and frame.parent.frameName == "ChronieCurrencyWindow"
                    and frame.frameType == "Button" and frame.template == "BackdropTemplate" then
                    slot = frame
                end
            end
            slot:run("OnReceiveDrag")
            assert.is_true(app.currencyItems.has(5001))

            -- First bag update after tracking only anchors the baseline at the held 40.
            recorded.setItemCount(5001, 55)
            recorded.frame:fire("BAG_UPDATE_DELAYED")
            assert.same({}, app.tally.summary().currencies)

            -- A further gain from that anchor is what counts.
            recorded.setItemCount(5001, 70)
            recorded.frame:fire("BAG_UPDATE_DELAYED")
            assert.equal(15, app.tally.summary().currencies[1].amount)
        end)

        it("records an achievement from the achievement event, named through the seam", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                now = 1700000000,
                achievements = { [1234] = "The Loremaster" },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("ACHIEVEMENT_EARNED", 1234)

            assert.same(
                { { id = 1234, name = "The Loremaster", at = 1700000000, accountFirst = true } },
                app.tally.summary().achievements
            )
        end)

        it("records the new level from the player level up event", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                now = 1700000000,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("PLAYER_LEVEL_UP", 42)

            assert.same(
                { { level = 42, at = 1700000000 } },
                app.tally.summary().levelUps
            )
        end)

        it("records a completed quest from the quest turn-in event", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                now = 1700000000,
                activeQuests = { 7848 },
                questStates = {
                    [7848] = {
                        name = "A Hunter's Challenge",
                        characterCompleted = false,
                        accountCompleted = false,
                    },
                },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("QUEST_TURNED_IN", 7848, 1000, 2000)

            assert.same(
                {
                    {
                        id = 7848,
                        name = "A Hunter's Challenge",
                        at = 1700000000,
                        characterFirst = true,
                        accountFirst = true,
                    },
                },
                app.tally.summary().quests
            )
        end)

        it("distinguishes a character-first quest from an account-first quest", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                activeQuests = { 7848 },
                questStates = {
                    [7848] = {
                        characterCompleted = false,
                        accountCompleted = true,
                    },
                },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("QUEST_TURNED_IN", 7848)

            local quest = app.tally.summary().quests[1]
            assert.is_true(quest.characterFirst)
            assert.is_false(quest.accountFirst)
        end)

        it("does not invent quest scope when no pre-completion snapshot exists", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("QUEST_TURNED_IN", 7848)

            local quest = app.tally.summary().quests[1]
            assert.is_nil(quest.characterFirst)
            assert.is_nil(quest.accountFirst)
        end)

        ---@param recorded table
        ---@return table? the results panel's frame, once something has built it
        local function panelFrame(recorded)
            for _, frame in ipairs(recorded.frames) do
                if frame.frameName == "ChronieResultsWindow" then
                    return frame
                end
            end
        end

        ---The header's own font strings: the two arrows, named by the glyphs they are drawn
        ---with, and the title between them. They are the only ones the panel builds without
        ---a justification, which is what tells them from every row in the body.
        ---@param frame table
        ---@return table `{ back, forward, title }`
        local function headerOf(frame)
            local header = {}
            for _, fontString in ipairs(frame.fontStrings) do
                if fontString.justify == nil then
                    if fontString.text == "«" then
                        header.back = fontString
                    elseif fontString.text == "»" then
                        header.forward = fontString
                    else
                        header.title = fontString
                    end
                end
            end
            return header
        end

        ---What the header says, without the disclosure icon in front of it.
        ---
        ---The title is the picker's own button — clicking it opens the list of everything the
        ---panel can be pointed at — so it carries the same `|T...|t` marker every openable
        ---block in the body does. That is markup rather than anything the header says, and it
        ---is stripped here for the same reason the body's headings are found by their names.
        ---@param frame table
        ---@return string?
        local function titleOf(frame)
            local title = headerOf(frame).title
            return title and (title.text:gsub("^|T.-|t ", ""))
        end

        ---The picker's own frame, once the title has been clicked: a second frame parented to
        ---the panel. Found by its parent rather than by position, because a great many frames
        ---exist by the time the whole addon has booted.
        ---@param recorded table
        ---@param panel table
        ---@return table?
        local function pickerFrame(recorded, panel)
            for _, frame in ipairs(recorded.frames) do
                if frame.frameType == "Frame" and frame.parent == panel then
                    return frame
                end
            end
        end

        ---The list the picker drew, as it reads: what a view is called on the left, and the
        ---metadata that tells one run of a dungeon from the next on the right.
        ---@param frame table the picker's frame
        ---@return table[] `{ { label = string, detail = string }, ... }`
        local function pickerRows(frame)
            local labels, details = {}, {}
            for _, fontString in ipairs(frame.fontStrings) do
                if fontString.shown and fontString.justify == "LEFT" then
                    labels[#labels + 1] = fontString.text
                elseif fontString.shown and fontString.justify == "RIGHT" then
                    details[#details + 1] = fontString.text
                end
            end
            local rows = {}
            for index, label in ipairs(labels) do
                rows[index] = { label = label, detail = details[index] }
            end
            return rows
        end

        ---Clicks the row of the list naming `label`, the way a player picks from a menu.
        ---@param frame table the picker's frame
        ---@param label string
        local function pickRow(frame, label)
            for _, fontString in ipairs(frame.fontStrings) do
                if fontString.shown and fontString.justify == "LEFT" and fontString.text == label then
                    fontString:run("OnMouseUp", "LeftButton")
                    return
                end
            end
            error("no row saying " .. label .. " on the list to pick")
        end

        ---What the panel is showing against one of the body's labels. The value font string
        ---is created straight after its label, which is what pairs the two.
        ---@param frame table
        ---@param label string
        ---@return string?
        local function panelValueFor(frame, label)
            for index, fontString in ipairs(frame.fontStrings) do
                if fontString.text == label then
                    local value = frame.fontStrings[index + 1]
                    return value and value.text
                end
            end
        end

        -- The panel could only ever say one thing: what is happening right now. The arrows
        -- are what reach the other two questions a damage meter answers with the same frame
        -- — what the evening adds up to, and what the dungeon before this one did — and only
        -- the whole addon wired together can say whether they reach the right segments.
        it("walks from the open segment to the session total and on to a filed one", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                money = 0,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            -- Coin picked up in Deadmines, or the segment is dropped as empty on the way out.
            recorded.setMoney(500)
            recorded.frame:fire("PLAYER_MONEY")
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            -- Twelve minutes of Westfall, so the segment left behind has an age to report.
            recorded.clock.advance(720)

            local frame = panelFrame(recorded)
            local header = headerOf(frame)
            assert.equal("Westfall", titleOf(frame))
            assert.equal("0c", panelValueFor(frame, "Gold Δ"))

            header.back:run("OnMouseUp", "LeftButton")

            assert.equal("Session · 2 segments", titleOf(frame))
            -- Deadmines' five silver plus the open segment's nothing: the body follows the
            -- header rather than staying on whatever was drawn before the arrow was clicked.
            assert.equal("5s 0c", panelValueFor(frame, "Gold Δ"))

            header.forward:run("OnMouseUp", "LeftButton")
            header.forward:run("OnMouseUp", "LeftButton")

            assert.equal("Deadmines · 12m ago", titleOf(frame))
            assert.equal("5s 0c", panelValueFor(frame, "Gold Δ"))
        end)

        -- The arrows walk the strip one step at a time, which is fine for the segment next
        -- door and useless four dungeons into an evening. The picker is the damage meter's own
        -- answer: a list of everything on offer, named and dated well enough to recognise,
        -- with the session total set apart from the segments. Only the whole addon wired
        -- together can say whether the panel was handed the real strip to draw a list from and
        -- a chooser that reaches back to it — a panel given neither is silently a panel whose
        -- title does nothing when it is clicked.
        it("opens the list from the title and stands on the session total picked out of it", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                money = 0,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            -- Coin picked up in Deadmines, or the segment is dropped as empty on the way out.
            recorded.setMoney(500)
            recorded.frame:fire("PLAYER_MONEY")
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            -- Twelve minutes of Westfall, so the dungeon left behind has an age to report and
            -- the open segment has a length.
            recorded.clock.advance(720)

            local frame = panelFrame(recorded)
            headerOf(frame).title:run("OnMouseUp", "LeftButton")

            local list = pickerFrame(recorded, frame)
            assert.same({
                { label = "Session", detail = "2 segments" },
                { label = "Westfall", detail = "12m · playing" },
                { label = "Deadmines", detail = "<1m · 12m ago" },
            }, pickerRows(list))

            pickRow(list, "Session")

            assert.equal("Session · 2 segments", titleOf(frame))
            -- Deadmines' five silver plus the open segment's nothing: the body follows the
            -- choice rather than staying on whatever the list was opened over.
            assert.equal("5s 0c", panelValueFor(frame, "Gold Δ"))
            assert.is_false(list.shown)
        end)

        -- A segment opening pulls the panel forward onto it, the way a damage meter jumps to
        -- the pull that just started. A player parked on the dungeon they left twenty minutes
        -- ago is looking at history, and history is not what a HUD is for once something new
        -- is happening. Nothing smaller than the whole addon can say this, because the module
        -- only learns a segment opened by being asked what to draw.
        it("comes back to the open segment when a new one starts under a filed view", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                money = 0,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.setMoney(500)
            recorded.frame:fire("PLAYER_MONEY")
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.clock.advance(120)

            local frame = panelFrame(recorded)
            headerOf(frame).forward:run("OnMouseUp", "LeftButton")
            assert.equal("Deadmines · 2m ago", titleOf(frame))

            recorded.setInstance({ name = "Elwynn Forest", kind = "none", difficultyId = 0,
                difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal("Elwynn Forest", titleOf(frame))
            -- And the dungeon is still one arrow away: the panel moved because something new
            -- opened, not because the view it was parked on fell out of the evening.
            headerOf(frame).forward:run("OnMouseUp", "LeftButton")
            assert.equal("Deadmines · 2m ago", titleOf(frame))
        end)

        -- The session total is the exception to that. Parking there is a deliberate "show me
        -- the evening", and the evening is still the evening on the far side of a loading
        -- screen — a panel that jumped off it at every zone boundary could never be left on it.
        it("stays on the session total through a new segment opening", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                money = 0,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.setMoney(500)
            recorded.frame:fire("PLAYER_MONEY")
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            local frame = panelFrame(recorded)
            headerOf(frame).back:run("OnMouseUp", "LeftButton")
            assert.equal("Session · 2 segments", titleOf(frame))

            recorded.clock.advance(120)
            recorded.setInstance({ name = "Elwynn Forest", kind = "none", difficultyId = 0,
                difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal("Session · 2 segments", titleOf(frame))
        end)

        -- Where the rest of the account stands is three parts wired together — the store that
        -- remembers every character, the module that reduces them to lines, and the panel that
        -- draws them — and only the whole addon says whether the panel was handed a tooltip to
        -- draw them in and a rollup to draw from. Neither is visible to a unit test of either
        -- end, and the panel without them is silently a panel with no hover at all.
        it("opens the whole account's standings over a faction the segment gained", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                -- A clock far enough from the epoch that a reading two days old is a real
                -- time rather than one before the world began.
                now = 1700000000,
                factions = {
                    ["Argent Dawn"] = {
                        standing = "Honored",
                        current = 3000,
                        max = 12000,
                        rank = 6,
                        system = "reaction",
                    },
                },
                db = {
                    holdings = {
                        ["Jaina-Ragnaros"] = {
                            factions = {
                                ["Argent Dawn"] = {
                                    standing = "Exalted",
                                    current = 1,
                                    max = 1,
                                    rank = 8,
                                    system = "reaction",
                                    at = 1700000000 - 2 * 24 * 60 * 60,
                                },
                            },
                        },
                    },
                },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.frame:fire(
                "CHAT_MSG_COMBAT_FACTION_CHANGE",
                "Your Argent Dawn reputation has increased by 40."
            )

            local frame = panelFrame(recorded)
            for _, fontString in ipairs(frame.fontStrings) do
                if fontString.shown and (fontString.text or ""):find("Reputation", 1, true) then
                    fontString:run("OnMouseUp", "LeftButton")
                    break
                end
            end
            for _, fontString in ipairs(frame.fontStrings) do
                if fontString.shown and fontString.justify == "LEFT"
                    and (fontString.text or ""):find("Argent Dawn", 1, true) then
                    fontString:run("OnEnter")
                    break
                end
            end

            local drawn = {}
            for _, line in ipairs(recorded.tooltip.lines) do
                drawn[#drawn + 1] = line.right and (line.text .. " → " .. line.right) or line.text
            end
            assert.same({
                "Argent Dawn",
                "Best → Exalted  1 / 1 · Jaina",
                " ",
                "Jaina · 2d ago → Exalted  1 / 1",
                "Thrall (you) → Honored  3,000 / 12,000",
            }, drawn)
        end)

        it("registers the events that feed the segment panel", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.equal(1, recorded.frame.registered.PLAYER_MONEY)
            assert.equal(1, recorded.frame.registered.CHAT_MSG_LOOT)
            assert.equal(1, recorded.frame.registered.GET_ITEM_INFO_RECEIVED)
            assert.equal(1, recorded.frame.registered.CHAT_MSG_COMBAT_FACTION_CHANGE)
            assert.equal(1, recorded.frame.registered.TRANSMOG_COLLECTION_SOURCE_ADDED)
            assert.equal(1, recorded.frame.registered.CURRENCY_DISPLAY_UPDATE)
            assert.equal(1, recorded.frame.registered.BAG_UPDATE_DELAYED)
            assert.equal(1, recorded.frame.registered.ACHIEVEMENT_EARNED)
            assert.equal(1, recorded.frame.registered.PLAYER_LEVEL_UP)
            assert.equal(1, recorded.frame.registered.NEW_MOUNT_ADDED)
            assert.equal(1, recorded.frame.registered.NEW_PET_ADDED)
            assert.equal(1, recorded.frame.registered.NEW_TOY_ADDED)
            assert.equal(1, recorded.frame.registered.QUEST_ACCEPTED)
            assert.equal(1, recorded.frame.registered.QUEST_LOG_UPDATE)
            assert.equal(1, recorded.frame.registered.QUEST_TURNED_IN)
            assert.equal(1, recorded.frame.registered.HOUSING_DECOR_ADDED)
            assert.equal(1, recorded.frame.registered.HOUSING_XP_GAINED)
            assert.equal(1, recorded.frame.registered.HOUSING_LEVEL_UP)
            assert.equal(1, recorded.frame.registered.PLAYER_XP_UPDATE)
            assert.equal(1, recorded.frame.registered.ENCOUNTER_END)
            assert.equal(1, recorded.frame.registered.CHALLENGE_MODE_START)
            assert.equal(1, recorded.frame.registered.CHALLENGE_MODE_COMPLETED)
            assert.equal(1, recorded.frame.registered.CHALLENGE_MODE_RESET)
        end)
    end)

    describe("what the player was doing", function()
        ---Boot inside an instance with a segment already open, which is what every one of
        ---these events needs before the tally will accept anything.
        ---@param options table?
        ---@return table app, table recorded
        local function zonedIn(options)
            options = options or {}
            options.playerName = options.playerName or "Thrall"
            options.realmName = options.realmName or "Ragnaros"
            options.instanceType = options.instanceType or "party"
            local app, recorded = boot(options)
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            return app, recorded
        end

        it("records a boss kill the client reported", function()
            local app, recorded = zonedIn()

            recorded.frame:fire("ENCOUNTER_END", 745, "Flame Leviathan", 4, 25, 1)

            local encounters = app.tally.summary().encounters
            assert.equal(1, #encounters)
            assert.equal(745, encounters[1].id)
            assert.equal("Flame Leviathan", encounters[1].name)
            assert.equal(25, encounters[1].groupSize)
            assert.is_true(encounters[1].success)
        end)

        it("records a wipe as an encounter that failed", function()
            local app, recorded = zonedIn()

            recorded.frame:fire("ENCOUNTER_END", 745, "Flame Leviathan", 4, 25, 0)

            assert.is_false(app.tally.summary().encounters[1].success)
        end)

        it("reads the keystone off the client when a run starts", function()
            local app, recorded = zonedIn({
                activeKeystone = { level = 14, mapId = 378, affixes = { 9, 6 } },
            })

            recorded.frame:fire("CHALLENGE_MODE_START")

            local keystone = app.tally.summary().keystone
            assert.equal(14, keystone.level)
            assert.equal(378, keystone.mapId)
            assert.is_false(keystone.completed)
        end)

        it("folds the completion report onto the run when it finishes", function()
            local app, recorded = zonedIn({
                activeKeystone = { level = 14, mapId = 378 },
                keystoneCompletion = {
                    level = 14, mapId = 378, durationMs = 1740000, onTime = true, upgrades = 2,
                },
            })
            recorded.frame:fire("CHALLENGE_MODE_START")

            recorded.frame:fire("CHALLENGE_MODE_COMPLETED")

            local keystone = app.tally.summary().keystone
            assert.is_true(keystone.completed)
            assert.is_true(keystone.onTime)
            assert.equal(2, keystone.upgrades)
        end)

        it("strips the completion when the party resets the key", function()
            local app, recorded = zonedIn({ activeKeystone = { level = 14 } })
            recorded.frame:fire("CHALLENGE_MODE_START")

            recorded.frame:fire("CHALLENGE_MODE_RESET")

            assert.is_false(app.tally.summary().keystone.completed)
        end)

        it("measures experience against the standing the segment opened on", function()
            local app, recorded = zonedIn({ experience = { level = 41, xp = 2000, xpMax = 10000 } })

            recorded.setExperience({ level = 41, xp = 4500, xpMax = 10000 })
            recorded.frame:fire("PLAYER_XP_UPDATE")

            local experience = app.tally.summary().experience
            assert.equal(2500, experience.gained)
            assert.near(0.25, experience.percent, 1e-9)
        end)

        -- A level-up empties the bar, so an addon that only listened to PLAYER_XP_UPDATE
        -- would lose the experience that carried the character over the line.
        it("counts the experience a level up was made of", function()
            local app, recorded = zonedIn({ experience = { level = 41, xp = 8000, xpMax = 10000 } })

            recorded.setExperience({ level = 42, xp = 3000, xpMax = 20000 })
            recorded.frame:fire("PLAYER_LEVEL_UP", 42)

            local summary = app.tally.summary()
            assert.equal(5000, summary.experience.gained)
            assert.equal(42, summary.experience.endLevel)
            assert.same({ level = 42, at = 1000 }, summary.levelUps[1])
        end)

        it("records nothing for a character at the level cap", function()
            local app, recorded = zonedIn({ experience = nil })

            recorded.frame:fire("PLAYER_XP_UPDATE")

            assert.is_nil(app.tally.summary().experience)
        end)

        it("files the expansion the location belongs to alongside the newest one", function()
            local app, recorded = zonedIn({
                instanceName = "Ulduar",
                tiers = {
                    { name = "Classic", raids = { "Molten Core" } },
                    { name = "The Burning Crusade", raids = { "Karazhan" } },
                    { name = "Wrath of the Lich King", raids = { "Ulduar" } },
                    { name = "Cataclysm", raids = { "Firelands" } },
                },
            })
            recorded.frame:fire("ENCOUNTER_END", 745, "Flame Leviathan", 4, 25, 1)

            recorded.setInstance({ name = "Orgrimmar", kind = "none" })
            recorded.frame:fire("ZONE_CHANGED_NEW_AREA")

            local record = app.segmentLog.all()[1]
            assert.equal("Ulduar", record.instance)
            assert.equal(3, record.expansionTier)
            assert.equal(4, record.latestExpansionTier)
        end)

        it("carries a keystone run all the way onto the filed segment", function()
            local app, recorded = zonedIn({
                instanceName = "Halls of Atonement",
                activeKeystone = { level = 14, mapId = 378, affixes = { 9, 6 } },
                keystoneCompletion = { level = 14, mapId = 378, durationMs = 1740000, onTime = true },
            })
            recorded.frame:fire("CHALLENGE_MODE_START")
            recorded.frame:fire("CHALLENGE_MODE_COMPLETED")

            recorded.setInstance({ name = "Oribos", kind = "none" })
            recorded.frame:fire("ZONE_CHANGED_NEW_AREA")

            local record = app.segmentLog.all()[1]
            assert.equal(14, record.keystone.level)
            assert.is_true(record.keystone.completed)
            assert.same({ 9, 6 }, record.keystone.affixes)
        end)
    end)

    describe("recording segments", function()
        local NOW = 1700000000

        ---Boot a character standing in the default fake instance, ready to zone.
        ---@param options table?
        ---@return table app, table recorded
        local function inside(options)
            options = options or {}
            options.playerName = options.playerName or "Thrall"
            options.realmName = options.realmName or "Ragnaros"
            options.now = options.now or NOW
            options.instanceType = options.instanceType or "party"
            local app, recorded = boot(options)
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            return app, recorded
        end

        ---Give the open segment an event, the way a coin pickup would, so it is not
        ---dropped as empty when it closes.
        ---@param recorded table
        ---@param amount integer
        local function earn(recorded, amount)
            recorded.setMoney(amount)
            recorded.frame:fire("PLAYER_MONEY")
        end

        it("writes nothing while the segment is still under way", function()
            local _, recorded = inside()

            assert.same({}, recorded.db.segments)
        end)

        it("files the segment into the db on the way back out to the world", function()
            local _, recorded = inside({
                class = "Warrior",
                classFile = "WARRIOR",
                level = 41,
                money = 0,
            })
            earn(recorded, 500)

            recorded.clock.advance(1800)
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal(1, #recorded.db.segments)
            local record = recorded.db.segments[1]
            assert.equal("Thrall-Ragnaros", record.character)
            assert.equal("Deadmines", record.instance)
            assert.equal("Normal", record.difficulty)
            assert.equal("WARRIOR", record.classFile)
            assert.equal(41, record.level)
            assert.equal(1800, record.seconds)
        end)

        -- A segment that saw nothing — a load screen straight back out — leaves no trace.
        it("drops an empty visit rather than filing it", function()
            local _, recorded = inside()

            recorded.clock.advance(60)
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.same({}, recorded.db.segments)
        end)

        it("carries the segment's takings onto the filed record", function()
            local _, recorded = inside({ money = 0, itemPrices = { [4242] = 60 } })

            earn(recorded, 2500)
            recorded.frame:fire(
                "CHAT_MSG_LOOT",
                "You receive loot: |cffa335ee|Hitem:4242::::::::::::|h[Item]|h|rx2."
            )
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            local record = recorded.db.segments[1]
            -- Loot value is inventory intake only; the wallet is reported separately.
            assert.equal(120, record.lootValue)
            assert.equal(2500, record.goldDiff)
        end)

        it("files one record per zone when zoning straight into the next one", function()
            local _, recorded = inside({ money = 0 })
            earn(recorded, 400)

            recorded.clock.advance(600)
            recorded.setInstance({ name = "Ulduar", kind = "raid", difficultyId = 4, difficulty = "25 Player" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            earn(recorded, 900)
            recorded.clock.advance(600)
            recorded.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal(2, #recorded.db.segments)
        end)

        it("starts a new outdoor segment after a seamless taxi zone change", function()
            local _, recorded = inside({
                instanceName = "Dragonblight",
                instanceType = "none",
                difficultyId = 0,
                difficultyName = "",
                itemPrices = { [1111] = 40, [2222] = 75 },
            })
            recorded.frame:fire(
                "CHAT_MSG_LOOT",
                "You receive loot: |cffffffff|Hitem:1111::::::::::::|h[Dragonblight Item]|h|r."
            )

            recorded.setInstance({ name = "Borean Tundra", kind = "none", difficultyId = 0, difficulty = "" })
            recorded.frame:fire("ZONE_CHANGED_NEW_AREA")
            recorded.frame:fire(
                "CHAT_MSG_LOOT",
                "You receive loot: |cffffffff|Hitem:2222::::::::::::|h[Borean Item]|h|r."
            )
            recorded.frame:fire("PLAYER_LOGOUT")

            assert.equal(2, #recorded.db.segments)
            assert.equal("Dragonblight", recorded.db.segments[1].instance)
            assert.equal(40, recorded.db.segments[1].lootValue)
            assert.equal("Borean Tundra", recorded.db.segments[2].instance)
            assert.equal(75, recorded.db.segments[2].lootValue)
        end)

        -- SavedVariables only reach disk when the client shuts down, so a segment that
        -- is still open at logout has to be filed there or it is lost outright.
        it("files the open segment when the player logs out inside the instance", function()
            local _, recorded = inside({ money = 0 })
            earn(recorded, 300)

            recorded.frame:fire("PLAYER_LOGOUT")

            assert.equal(1, #recorded.db.segments)
            assert.equal("Deadmines", recorded.db.segments[1].instance)
        end)

        it("files nothing at logout when the open segment saw nothing", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros", instanceType = nil })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("PLAYER_LOGOUT")

            assert.same({}, recorded.db.segments)
        end)

        it("registers the logout event that flushes the visit", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.equal(1, recorded.frame.registered.PLAYER_LOGOUT)
        end)

        it("keeps both characters' segments in one shared db", function()
            local db = {}
            local _, first = inside({ db = db, money = 0 })
            earn(first, 500)
            first.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            first.frame:fire("PLAYER_ENTERING_WORLD")

            local _, second = inside({ playerName = "Jaina", realmName = "Draenor", db = db, money = 0 })
            earn(second, 700)
            second.setInstance({ name = "Westfall", kind = "none", difficultyId = 0, difficulty = "" })
            second.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal(2, #db.segments)
        end)
    end)

    -- The pot belongs to the account rather than to any character, and it is only ever worth
    -- anything to the app once it is in SavedVariables — which the client writes on the way
    -- out and at no other moment. So what matters here is not that the store was called but
    -- that the number is in the file, from each of the three moments the addon reads it.
    describe("the warband bank's gold", function()
        it("has read nothing before the client has said anything", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.is_nil(recorded.db.warband)
        end)

        -- A character can be played for weeks without ever standing at a bank, and the pot is
        -- still part of what the account is worth. Reading it once at login is what keeps a
        -- roster from being short by the bank's whole balance.
        it("reads the pot at login, without waiting for anybody to open a bank", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                warbandMoney = 500000,
            })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.same({ gold = 500000, at = 1700000000 }, recorded.db.warband)
        end)

        it("writes the new balance down when the pot changes under any character", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                warbandMoney = 500000,
            })
            recorded.frame:fire("PLAYER_LOGIN")

            recorded.setWarbandMoney(620000)
            recorded.frame:fire("ACCOUNT_MONEY")

            assert.equal(620000, recorded.db.warband.gold)
        end)

        it("registers the event that keeps the pot current", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            assert.equal(1, recorded.frame.registered.ACCOUNT_MONEY)
        end)

        -- Logout is the freshest reading there is and the last one that can reach the file,
        -- because SavedVariables are only written on the way out. The number left here is what
        -- every other character's rollup reads until one of them logs in again.
        it("re-reads the pot on the way out, after the last event the client sent", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                warbandMoney = 500000,
                instanceType = "party",
            })
            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            -- Changed with no event to announce it, so only the logout read can find it.
            recorded.setWarbandMoney(750000)
            recorded.frame:fire("PLAYER_LOGOUT")

            assert.equal(750000, recorded.db.warband.gold)
        end)

        it("leaves the last reading standing on a client that has no warband bank", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                warbandMoney = 500000,
            })
            recorded.frame:fire("PLAYER_LOGIN")

            -- A build without C_Bank answers nothing at all, and nothing is not an empty
            -- bank: every other character on the account is about to read this number.
            recorded.setWarbandMoney(nil)
            recorded.frame:fire("ACCOUNT_MONEY")

            assert.equal(500000, recorded.db.warband.gold)
        end)

        -- The seam is read through `env.warbandMoney and ...`, so a client this addon was
        -- installed beside without one has to boot and run rather than raise on the event.
        it("survives an environment that does not offer the seam at all", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })
            recorded.env.warbandMoney = nil

            assert.has_no.errors(function()
                recorded.frame:fire("PLAYER_LOGIN")
                recorded.frame:fire("ACCOUNT_MONEY")
                recorded.frame:fire("PLAYER_LOGOUT")
            end)
            assert.is_nil(recorded.db.warband)
        end)
    end)

    describe("the whole wallet and reputation pane", function()
        local PANE = {
            currencies = {
                { id = 2245, name = "Flightstones", total = 5000 },
                { id = 3008, name = "Valorstones", total = 0 },
            },
            reputation = {
                {
                    faction = "The Consortium",
                    standing = "Honored",
                    current = 3000,
                    max = 12000,
                    rank = 6,
                    system = "reaction",
                },
            },
        }

        -- The hole this closes. A currency only ever reached the snapshot as part of a
        -- change to it, so an alt sitting on 5,000 Flightstones contributed nothing to the
        -- account's Flightstones until the next time it earned one — and it is absent from
        -- the currency's list rather than recorded as holding none, which is a hole rather
        -- than a zero.
        it("writes down what the panes hold, with no gain having been watched at all", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                held = PANE,
            })

            recorded.frame:fire("PLAYER_LOGIN")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            local entry = recorded.db.holdings["Thrall-Ragnaros"]
            assert.same({ name = "Flightstones", total = 5000, at = 1700000000 },
                entry.currencies[2245])
            assert.same({
                standing = "Honored",
                current = 3000,
                max = 12000,
                rank = 6,
                system = "reaction",
                at = 1700000000,
            }, entry.factions["The Consortium"])
        end)

        -- Zero is the reading that watching could never produce: nothing announces a
        -- balance the character no longer has, so a spent-out currency would otherwise go
        -- on being counted at whatever it was last seen at.
        it("records a currency the character has none of as none", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                held = PANE,
            })

            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal(0, recorded.db.holdings["Thrall-Ragnaros"].currencies[3008].total)
        end)

        it("reads the panes again on the way out, after the last event the client sent",
            function()
                local _, recorded = boot({
                    playerName = "Thrall",
                    realmName = "Ragnaros",
                    now = 1700000000,
                    instanceType = "party",
                    held = PANE,
                })
                recorded.frame:fire("PLAYER_ENTERING_WORLD")

                -- Spent with no event to announce it, so only the logout read can find it.
                recorded.setHeld({
                    currencies = { { id = 2245, name = "Flightstones", total = 250 } },
                })
                recorded.frame:fire("PLAYER_LOGOUT")

                assert.equal(250, recorded.db.holdings["Thrall-Ragnaros"].currencies[2245].total)
            end)

        -- The walk only ever adds. A pane the client will not answer for — one the server
        -- has not sent yet, a build that has moved the call — is not an empty wallet, and
        -- every other character's rollup is about to read these numbers.
        it("leaves what was already written standing when the panes say nothing", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                instanceType = "party",
                held = PANE,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setHeld(nil)
            recorded.frame:fire("PLAYER_LOGOUT")

            local entry = recorded.db.holdings["Thrall-Ragnaros"]
            assert.equal(5000, entry.currencies[2245].total)
            assert.is_table(entry.factions["The Consortium"])
        end)

        -- Gold is on neither pane. It answers outright and is already read whole at every
        -- segment close, so a sweep that touched it could only ever be a worse reading than
        -- the one already there — and the sweep runs after the close, where clobbering it
        -- is exactly what a careless one would do.
        it("leaves the wallet to the segment that closes it", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                instanceType = "party",
                money = 100000,
                held = PANE,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setMoney(125000)
            recorded.frame:fire("PLAYER_MONEY")
            recorded.frame:fire("PLAYER_LOGOUT")

            assert.equal(125000, recorded.db.holdings["Thrall-Ragnaros"].gold.total)
        end)

        -- The seam is read through `env.heldSweep`, so a harness that predates it — or a
        -- client build the walk could not be wired for — has to boot and run rather than
        -- raise on the way out, which is the one moment nothing could be recovered from.
        it("survives an environment that does not offer the seam at all", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })
            recorded.env.heldSweep = nil

            assert.has_no.errors(function()
                recorded.frame:fire("PLAYER_LOGIN")
                recorded.frame:fire("PLAYER_ENTERING_WORLD")
                recorded.frame:fire("PLAYER_LOGOUT")
            end)
            assert.same({}, recorded.db.holdings)
        end)
    end)

    describe("the player's own transmog sets", function()
        ---One set in the shape Main.lua reduces the client's three transmog calls to, so a
        ---test says only the part it is about.
        ---@param fields table
        ---@return table
        local function customSet(fields)
            return {
                id = fields.id,
                name = fields.name or "Look",
                icon = fields.icon,
                slots = fields.slots or {},
            }
        end

        -- Nothing in game is told about this and no panel shows it: the whole point is the
        -- file the app reads at logout, so the file is what the test looks at.
        it("files the wardrobe under the character on the way into the world", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                transmogCustomSets = {
                    customSet({
                        id = 3,
                        name = "Raid",
                        icon = 626185,
                        slots = { { slot = 0, appearance = 100 }, { slot = 11, appearance = 300 } },
                    }),
                },
            })

            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            local filed = recorded.db.customSets["Thrall-Ragnaros"]
            assert.same({
                {
                    id = 3,
                    name = "Raid",
                    icon = 626185,
                    slots = { { slot = 0, appearance = 100 }, { slot = 11, appearance = 300 } },
                },
            }, filed.sets)
            assert.equal(1700000000, filed.at)
        end)

        -- The event is what keeps the file current through a session. Everything the player
        -- does to their wardrobe while Chronie is watching arrives this way; the read inside
        -- the zoning handler above only ever catches up on what happened out of sight.
        it("files the wardrobe again when the client says it changed", function()
            local sets = { customSet({ id = 3, name = "Raid" }) }
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                transmogCustomSets = sets,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            sets[2] = customSet({ id = 5, name = "Town", slots = { { slot = 3, appearance = 200 } } })
            recorded.clock.set(1700000500)
            recorded.frame:fire("TRANSMOG_CUSTOM_SETS_CHANGED")

            local filed = recorded.db.customSets["Thrall-Ragnaros"]
            assert.equal(2, #filed.sets)
            assert.same({ { slot = 3, appearance = 200 } }, filed.sets[2].slots)
            assert.equal(1700000500, filed.at)
        end)

        -- The client fires that event for things that leave the wardrobe exactly as it was,
        -- reselecting a set in the dropdown among them. A stamp that crept forward on those
        -- would tell the app the player spent the evening on their wardrobe.
        it("leaves the moment alone when the event announced no real change", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                now = 1700000000,
                transmogCustomSets = { customSet({ id = 3, name = "Raid" }) },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.clock.set(1700000500)
            recorded.frame:fire("TRANSMOG_CUSTOM_SETS_CHANGED")

            assert.equal(1700000000, recorded.db.customSets["Thrall-Ragnaros"].at)
        end)

        -- The sets are the account's, but whether Chronie has ever looked is a fact about a
        -- character. Filed under one key, the last alt to log out would speak for every one
        -- of them, and an alt that has not been played since Chronie was installed would
        -- look like it shares a wardrobe it has never been shown.
        it("keeps each character's wardrobe apart in the saved file", function()
            local db = {}
            local _, thrall = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                db = db,
                transmogCustomSets = { customSet({ id = 3, name = "Raid" }) },
            })
            thrall.frame:fire("PLAYER_ENTERING_WORLD")

            local _, jaina = boot({
                playerName = "Jaina",
                realmName = "Ragnaros",
                db = db,
                transmogCustomSets = { customSet({ id = 5, name = "Town" }) },
            })
            jaina.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal("Raid", db.customSets["Thrall-Ragnaros"].sets[1].name)
            assert.equal("Town", db.customSets["Jaina-Ragnaros"].sets[1].name)
        end)
    end)

    describe("an outfit the app asked the game to hold", function()
        -- The one thing Chronie does that changes something in a WoW account rather than
        -- writing something down about it, so the test looks at both halves of that: the
        -- call the client actually received, and the player being told it happened.
        it("saves it on the way into the world, and says so by name", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                customSetRequests = {
                    {
                        id = 7,
                        name = "Winter Look",
                        icon = 626185,
                        slots = { { slot = 0, appearance = 100 }, { slot = 12, appearance = 900 } },
                    },
                },
            })

            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            local created = recorded.customSetWrites.created
            assert.equal(1, #created)
            assert.equal("Winter Look", created[1].name)
            assert.equal(626185, created[1].icon)
            assert.equal(13, #created[1].list)
            assert.equal(100, created[1].list[1].appearanceID)
            assert.equal(900, created[1].list[13].appearanceID)
            assert.is_truthy(recorded.lines[1]:find("Saved Winter Look to your transmog sets.", 1, true))
        end)

        -- The app keeps writing the same file until it has been told the request landed, so
        -- every load screen for the rest of the session reads a request that is already
        -- carried out. Doing it again would save the outfit over the player's wardrobe once
        -- per zoning, and pile up duplicates of it besides.
        it("does not save it a second time on the next load screen", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                customSetRequests = {
                    { id = 7, name = "Winter Look", slots = { { slot = 0, appearance = 100 } } },
                },
            })

            recorded.frame:fire("PLAYER_ENTERING_WORLD")
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal(1, #recorded.customSetWrites.created)
            assert.same({}, recorded.customSetWrites.modified)
            assert.equal(1, #recorded.lines)
        end)

        -- Account-wide, because the thing it is a record of is: a custom set belongs to the
        -- account, so a request carried out on one character has been carried out for all of
        -- them. Kept per character, the player would find the same outfit saved over their
        -- wardrobe again every time they logged a new alt in.
        it("is not carried out again by the next character to log in", function()
            local db = {}
            local requests = {
                { id = 7, name = "Winter Look", slots = { { slot = 0, appearance = 100 } } },
            }
            local _, thrall = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                db = db,
                customSetRequests = requests,
            })
            thrall.frame:fire("PLAYER_ENTERING_WORLD")

            local _, jaina = boot({
                playerName = "Jaina",
                realmName = "Ragnaros",
                db = db,
                customSetRequests = requests,
            })
            jaina.frame:fire("PLAYER_ENTERING_WORLD")

            assert.equal(1, #thrall.customSetWrites.created)
            assert.same({}, jaina.customSetWrites.created)
        end)

        -- A hand-installed copy carries the shipped-empty module, which asks for nothing.
        it("stays quiet when the app has asked for nothing", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            assert.same({}, recorded.customSetWrites.created)
            assert.same({}, recorded.lines)
        end)
    end)

    describe("the /chronie segments slash command", function()
        it("opens from the minimap button", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            for _, frame in ipairs(recorded.frames) do
                if frame.frameName == "ChronieMinimapButton" then
                    frame:run("OnClick")
                end
            end

            assert.is_true(app.segmentWindow.isShown())
        end)

        it("opens the segment window on the first call and closes it on the second", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("segments")
            assert.is_true(app.segmentWindow.isShown())

            recorded.slashRegistrations[1].handler("segments")
            assert.is_false(app.segmentWindow.isShown())
        end)

        it("titles the window with the retention window", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("segments")

            local titles = {}
            for _, frame in ipairs(recorded.frames) do
                if frame.frameName == "ChronieSegmentWindow" then
                    for index, fontString in ipairs(frame.fontStrings) do
                        titles[index] = fontString.text
                    end
                end
            end
            assert.equal("Segments — last 7 days", titles[1])
        end)

        it("stays lazy until the slash is used", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })
            assert.equal(2, #recorded.frames)

            recorded.slashRegistrations[1].handler("segments")

            assert.is_true(#recorded.frames > 1)
        end)

        it("filters the table and its totals as character, day, and location are edited", function()
            local db = {
                segments = {
                    {
                        id = "a",
                        character = "Thrall-Ragnaros",
                        classFile = "WARRIOR",
                        day = "2026-07-25",
                        instance = "Ulduar",
                        difficulty = "25 Player",
                        endedAt = 1000,
                        lootValue = 10000,
                        goldDiff = 0,
                        transmogs = {},
                        currencies = { { id = 1, name = "Honor", amount = 10 } },
                        reputation = { { faction = "Argent Dawn", amount = 20 } },
                    },
                    {
                        id = "b",
                        character = "Jaina-Draenor",
                        classFile = "MAGE",
                        day = "2026-07-24",
                        instance = "Deadmines",
                        difficulty = "Normal",
                        endedAt = 900,
                        lootValue = 20000,
                        goldDiff = 0,
                        transmogs = {},
                        currencies = { { id = 1, name = "Honor", amount = 30 } },
                        reputation = { { faction = "Argent Dawn", amount = 40 } },
                    },
                },
            }
            local _, recorded = boot({ db = db, now = 1100 })
            recorded.slashRegistrations[1].handler("segments")

            local edits = {}
            for _, frame in ipairs(recorded.frames) do
                if frame.frameType == "EditBox" then
                    edits[#edits + 1] = frame
                end
            end
            edits[1]:SetText("Thrall")
            edits[1]:run("OnTextChanged", true)
            edits[2]:SetText("07-25")
            edits[2]:run("OnTextChanged", true)
            edits[3]:SetText("Uld")
            edits[3]:run("OnTextChanged", true)

            local visible = {}
            for _, frame in ipairs(recorded.frames) do
                if frame.shown then
                    for _, text in ipairs(frame.fontStrings) do
                        if text.shown then
                            visible[text.text] = true
                        end
                    end
                end
            end
            assert.is_true(visible["+10"])
            assert.is_true(visible["+20"])
            assert.is_nil(visible["+30"])
            assert.is_nil(visible["+40"])
            assert.is_nil(visible["Deadmines"])
        end)

        it("names every subcommand there is in the usage text", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("nonsense")

            assert.equal(
                "|cff33ff99chronie|r: usage: /chronie locks | results | segments | currency "
                    .. "| report | log | events | note [text]",
                recorded.lines[1]
            )
        end)
    end)

    describe("the /chronie report slash command", function()
        ---@param recorded table
        ---@return string[] the text every edit box in the report window carries
        local function commands(recorded)
            local texts = {}
            for _, frame in ipairs(recorded.frames) do
                if frame.frameType == "EditBox" then
                    texts[#texts + 1] = frame.text
                end
            end
            return texts
        end

        it("opens the report window on the first call and closes it on the second", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("report")
            assert.is_true(app.reportWindow.isShown())

            recorded.slashRegistrations[1].handler("report")
            assert.is_false(app.reportWindow.isShown())
        end)

        it("puts the collector commands in copyable boxes", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("report")

            local texts = commands(recorded)
            assert.equal(3, #texts)
            assert.is_truthy(texts[1]:find("collect.py", 1, true))
            assert.is_truthy(texts[1]:find("--watch", 1, true))
            assert.is_truthy(texts[2]:find("--open", 1, true))
            assert.is_truthy(texts[3]:find("report.html", 1, true))
        end)

        -- The player is meant to copy out of these boxes, not type into them, so a
        -- stray keystroke has to put the command straight back.
        it("restores a box the player typed into", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })
            recorded.slashRegistrations[1].handler("report")
            local box
            for _, frame in ipairs(recorded.frames) do
                if frame.frameType == "EditBox" then
                    box = box or frame
                end
            end
            local original = box.text

            box:SetText("oops")
            box:run("OnTextChanged", true)

            assert.equal(original, box.text)
        end)

        it("takes its paths from the saved variables when they are set", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                db = { report = { python = "py -3", addonPath = "D:\\wow\\AddOns\\chronie" } },
            })

            recorded.slashRegistrations[1].handler("report")

            assert.equal('py -3 "D:\\wow\\AddOns\\chronie\\scripts\\collect.py" --watch', commands(recorded)[1])
        end)

        it("stays lazy until the slash is used", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })
            assert.equal(2, #recorded.frames)

            recorded.slashRegistrations[1].handler("report")

            assert.is_true(#recorded.frames > 1)
        end)
    end)

    describe("an event this client build refuses to register", function()
        -- The regression this whole seam exists for. Main.lua wired BAG_UPDATE_DELTA, a
        -- name no client defines, and since patch 8.0.1 RegisterEvent *raises* on such a
        -- name — so ns.main aborted on that line and every subscription after it was
        -- silently lost: achievements, level ups, collections, all three quest events and
        -- the slash command. Loot still worked, which is why it went unnoticed.
        local REFUSED = { "BAG_UPDATE_DELAYED" }

        ---Every event wired after the refused one, which is what used to disappear.
        local WIRED_AFTER = {
            "ACHIEVEMENT_EARNED",
            "PLAYER_LEVEL_UP",
            "NEW_MOUNT_ADDED",
            "NEW_PET_ADDED",
            "NEW_TOY_ADDED",
            "QUEST_ACCEPTED",
            "QUEST_LOG_UPDATE",
            "QUEST_TURNED_IN",
        }

        it("boots the addon rather than dying on the refusal", function()
            assert.has_no.errors(function()
                boot({ playerName = "Thrall", realmName = "Ragnaros", rejectEvents = REFUSED })
            end)
        end)

        it("registers every event wired after the refused one", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                rejectEvents = REFUSED,
            })

            for _, event in ipairs(WIRED_AFTER) do
                assert.is_truthy(recorded.frame.registered[event], event .. " was never registered")
            end
        end)

        it("leaves only the refused event unregistered", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                rejectEvents = REFUSED,
            })

            assert.is_nil(recorded.frame.registered.BAG_UPDATE_DELAYED)
            assert.is_truthy(recorded.frame.registered.CHAT_MSG_LOOT)
        end)

        it("still registers the slash command, which is wired last of all", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                rejectEvents = REFUSED,
            })

            assert.equal(1, #recorded.slashRegistrations)
            assert.same({ "/chronie" }, recorded.slashRegistrations[1].tokens)
        end)

        it("still records a quest turn-in and an achievement in the tally", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                now = 1700000000,
                rejectEvents = REFUSED,
                achievements = { [1234] = "The Loremaster" },
                activeQuests = { 7848 },
                questStates = {
                    [7848] = {
                        name = "A Hunter's Challenge",
                        characterCompleted = false,
                        accountCompleted = false,
                    },
                },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.frame:fire("QUEST_TURNED_IN", 7848)
            recorded.frame:fire("ACHIEVEMENT_EARNED", 1234)

            local summary = app.tally.summary()
            assert.equal("A Hunter's Challenge", summary.quests[1].name)
            assert.is_true(summary.quests[1].characterFirst)
            assert.equal("The Loremaster", summary.achievements[1].name)
        end)

        it("keeps the events before the refusal working too", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                money = 0,
                rejectEvents = REFUSED,
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setMoney(1000)
            recorded.frame:fire("PLAYER_MONEY")

            assert.equal(1000, app.tally.summary().goldLooted)
        end)

        -- Only the refused event's own feature is lost: nothing recounts the tracked
        -- currency items, because the batched bag update never arrives.
        it("loses only the feature the refused event fed", function()
            local app, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                instanceType = "party",
                rejectEvents = REFUSED,
                currencyItems = { [5001] = { name = "Bloody Token", count = 40 } },
                trackedCurrencies = { 5001 },
            })
            recorded.frame:fire("PLAYER_ENTERING_WORLD")

            recorded.setItemCount(5001, 55)

            assert.same({}, app.tally.summary().currencies)
        end)
    end)

    describe("the /chronie events slash command", function()
        it("says the client accepted everything when nothing was refused", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("events")

            assert.equal(
                "|cff33ff99chronie|r: this client accepted every event the addon tracks.",
                recorded.lines[1]
            )
        end)

        it("names the event this client refused", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                rejectEvents = { "BAG_UPDATE_DELAYED" },
            })

            recorded.slashRegistrations[1].handler("events")

            assert.equal(1, #recorded.lines)
            assert.is_truthy(recorded.lines[1]:find("BAG_UPDATE_DELAYED", 1, true))
            assert.is_truthy(recorded.lines[1]:find("1 event(s)", 1, true))
        end)

        it("names every refused event, in the order they were wired", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                rejectEvents = { "NEW_TOY_ADDED", "BAG_UPDATE_DELAYED" },
            })

            recorded.slashRegistrations[1].handler("events")

            assert.is_truthy(recorded.lines[1]:find("2 event(s)", 1, true))
            assert.is_truthy(recorded.lines[1]:find("BAG_UPDATE_DELAYED, NEW_TOY_ADDED", 1, true))
        end)

        -- Reported unprompted at login as well, so a feature this client cannot support
        -- shows up as something the player can see rather than as silence.
        it("reports the refused events at login", function()
            local _, recorded = boot({
                playerName = "Thrall",
                realmName = "Ragnaros",
                rejectEvents = { "BAG_UPDATE_DELAYED" },
            })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.equal(1, #recorded.lines)
            assert.is_truthy(recorded.lines[1]:find("BAG_UPDATE_DELAYED", 1, true))
        end)
    end)

    describe("the /chronie results slash command", function()
        it("names results in the usage text for an unknown subcommand", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("nonsense")

            assert.is_truthy(recorded.lines[1]:find("usage: /chronie locks | results", 1, true))
        end)

        it("opens the panel on the first /chronie results", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("results")

            assert.is_true(app.resultsWindow.isShown())
        end)

        it("closes the panel on a second /chronie results", function()
            local app, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("results")
            recorded.slashRegistrations[1].handler("results")

            assert.is_false(app.resultsWindow.isShown())
        end)

        it("stays lazy until the slash is used", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            -- Only the dispatcher frame; toggling results is what first builds the panel.
            assert.equal(2, #recorded.frames)

            recorded.slashRegistrations[1].handler("results")

            assert.is_true(#recorded.frames > 1)
        end)
    end)

    describe("combat logging", function()
        local ADVANCED = "advancedCombatLogging"

        ---@param options table?
        ---@return table app, table recorded
        local function bootLogging(options)
            options = options or {}
            options.playerName = options.playerName or "Thrall"
            options.realmName = options.realmName or "Ragnaros"
            return boot(options)
        end

        -- Logging does not survive a session, so the setting has to be re-asserted at
        -- every login rather than once ever.
        it("turns both switches on at login when the setting asks for it", function()
            local _, recorded = bootLogging({ settings = { combatLogging = true } })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.is_true(recorded.isLogging())
            assert.equal("1", recorded.cvar(ADVANCED))
        end)

        it("says logging is on, with advanced logging, once it is", function()
            local _, recorded = bootLogging({ settings = { combatLogging = true } })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.equal(
                "|cff33ff99chronie|r: combat logging is on, with advanced combat logging.",
                recorded.lines[1]
            )
        end)

        -- The default install: a player who never turned this on gets no log and no line
        -- about it, which is why the login handler stays silent by default.
        it("leaves the client alone at login when the setting is off", function()
            local _, recorded = bootLogging()

            recorded.frame:fire("PLAYER_LOGIN")

            assert.is_false(recorded.isLogging())
            assert.same({}, recorded.setCVarCalls)
            assert.same({}, recorded.lines)
        end)

        it("still logs, and tells the player what to tick, on a client refusing the CVar", function()
            local _, recorded = bootLogging({
                settings = { combatLogging = true },
                protectedCVars = { [ADVANCED] = "raise" },
            })

            recorded.frame:fire("PLAYER_LOGIN")

            assert.is_true(recorded.isLogging())
            assert.is_nil(recorded.cvar(ADVANCED))
            assert.equal(1, #recorded.lines)
            assert.is_truthy(recorded.lines[1]:find("Advanced Combat Logging", 1, true))
            assert.is_truthy(recorded.lines[1]:find("Network", 1, true))
        end)

        it("reports the client's own state on /chronie log", function()
            local _, recorded = bootLogging({ combatLogging = true })

            recorded.slashRegistrations[1].handler("log")

            assert.equal(1, #recorded.lines)
            assert.is_truthy(recorded.lines[1]:find("did not ask for it", 1, true))
        end)

        -- Asked of the client every time rather than remembered from login, so a switch
        -- the player has thrown by hand since is what the answer describes.
        it("reflects logging the player stopped by hand after login", function()
            local _, recorded = bootLogging({ settings = { combatLogging = true } })
            recorded.frame:fire("PLAYER_LOGIN")

            recorded.env.loggingCombat(false)
            recorded.slashRegistrations[1].handler("log")

            assert.is_false(recorded.isLogging())
            assert.is_truthy(recorded.lines[2]:find("not logging", 1, true))
        end)
    end)
end)
