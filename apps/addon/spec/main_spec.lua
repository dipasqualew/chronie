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
            assert.is_function(ns.main)
        end)

        it("does not auto-start outside the game", function()
            local ns = loader.load()

            assert.is_nil(ns.app)
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
        ---@return table instanceCell, table characterCell
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

            assert.is_false(app.instanceWindow.isShown())
            assert.is_false(app.characterWindow.isShown())
        end)

        it("opens the instance detail window when the instance cell is clicked", function()
            local app, recorded = opened()
            local instanceCell = rowCells(recorded)

            instanceCell:run("OnClick")

            assert.is_true(app.instanceWindow.isShown())
            assert.is_false(app.characterWindow.isShown())
        end)

        it("titles the instance detail window with the instance, which covers every difficulty", function()
            local app, recorded = opened()
            local instanceCell = rowCells(recorded)

            instanceCell:run("OnClick")

            assert.is_true(app.instanceWindow.isShown())
            assert.is_true(contains(
                textsOf(recorded, "ChronieInstanceDetailWindow"),
                "Ulduar"
            ))
        end)

        it("opens the character detail window when the character cell is clicked", function()
            local app, recorded = opened()
            local _, characterCell = rowCells(recorded)

            characterCell:run("OnClick")

            assert.is_true(app.characterWindow.isShown())
            assert.is_false(app.instanceWindow.isShown())
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
            local instanceCell, characterCell = rowCells(recorded)

            instanceCell:run("OnClick")
            characterCell:run("OnClick")

            assert.same({
                "ChronieLockoutWindow",
                "ChronieInstanceDetailWindow",
                "ChronieCharacterDetailWindow",
            }, recorded.specialFrames)
        end)
    end)

    describe("the lockout window's callbacks in isolation", function()
        ---Builds a window with fake deps only, so the click handlers can be driven
        ---without booting the whole addon.
        ---@return table window, table frames, table selections `{ instances, characters }`
        local function newWindow()
            local ns = loader.load()
            local createFrame, frames = fake.newCreateFrame()
            local selections = { instances = {}, characters = {} }

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
                            instance = "Ulduar",
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
                -- instance having an expansion keeps the cells out of the way.
                expansions = ns.newExpansionIndex(fake.newEncounterJournal()),
                onInstanceSelected = function(row)
                    selections.instances[#selections.instances + 1] = row
                end,
                onCharacterSelected = function(character)
                    selections.characters[#selections.characters + 1] = character
                end,
            })
            return window, frames, selections
        end

        ---@param frames table[]
        ---@return table instanceCell, table characterCell
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

        it("hands the clicked row to onInstanceSelected", function()
            local window, frames, selections = newWindow()
            window.toggle()
            local instanceCell = rowCells(frames)

            instanceCell:run("OnClick")

            assert.equal(1, #selections.instances)
            assert.equal("Ulduar", selections.instances[1].instance)
            assert.equal(4, selections.instances[1].difficultyId)
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

            assert.same({}, selections.instances)
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
            local files = loader.tocFiles()

            assert.equal("Main.lua", files[#files])
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

            -- currencyType, quantity, quantityChange — the client hands the change over.
            recorded.frame:fire("CURRENCY_DISPLAY_UPDATE", 1166, 30, 15)

            assert.same(
                { { id = 1166, name = "Timewarped Badge", amount = 15 } },
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
                { { id = 5001, name = "Bloody Token", amount = 15 } },
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

        it("names segments, currency, report and events in the usage text", function()
            local _, recorded = boot({ playerName = "Thrall", realmName = "Ragnaros" })

            recorded.slashRegistrations[1].handler("nonsense")

            assert.equal(
                "|cff33ff99chronie|r: usage: /chronie locks | results | segments | currency "
                    .. "| report | events",
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
end)
