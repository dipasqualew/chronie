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

            assert.is_function(app.dispatcher.on)
            assert.is_function(app.logger.info)
            assert.is_function(app.greeter.greet)
            assert.equal("Hello World, Jaina!", app.greeter.greet("Jaina"))
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
