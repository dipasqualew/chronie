local loader = require("addon_loader")

describe("ns.newSlashRouter", function()
    local ns = loader.load()

    ---A router with "locks" wired up, plus recordings of what each seam saw.
    ---@return table router, table recorded `{ locks, unknown }`
    local function newRouter()
        local recorded = { locks = {}, unknown = {} }

        local router = ns.newSlashRouter({
            onUnknown = function(subcommand)
                recorded.unknown[#recorded.unknown + 1] = subcommand
            end,
        })
        router.add("locks", function(argument)
            recorded.locks[#recorded.locks + 1] = argument
        end)

        return router, recorded
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newSlashRouter)
    end)

    describe("routing a known subcommand", function()
        it("routes locks to its handler", function()
            local router, recorded = newRouter()

            router.dispatch("locks")

            assert.equal(1, #recorded.locks)
            assert.same({}, recorded.unknown)
        end)

        it("routes each dispatch separately", function()
            local router, recorded = newRouter()

            router.dispatch("locks")
            router.dispatch("locks")

            assert.equal(2, #recorded.locks)
        end)

        it("routes the last handler registered for a subcommand", function()
            local seen = {}
            local router = ns.newSlashRouter({ onUnknown = function() end })
            router.add("locks", function()
                seen[#seen + 1] = "first"
            end)
            router.add("locks", function()
                seen[#seen + 1] = "second"
            end)

            router.dispatch("locks")

            assert.same({ "second" }, seen)
        end)

        it("keeps subcommands apart", function()
            local seen = {}
            local router = ns.newSlashRouter({ onUnknown = function() end })
            router.add("locks", function()
                seen[#seen + 1] = "locks"
            end)
            router.add("config", function()
                seen[#seen + 1] = "config"
            end)

            router.dispatch("config")

            assert.same({ "config" }, seen)
        end)
    end)

    describe("normalising the typed text", function()
        it("matches a subcommand typed in upper case", function()
            local router, recorded = newRouter()

            router.dispatch("LOCKS")

            assert.equal(1, #recorded.locks)
        end)

        it("matches a subcommand typed in mixed case", function()
            local router, recorded = newRouter()

            router.dispatch("LoCkS")

            assert.equal(1, #recorded.locks)
        end)

        it("matches a subcommand registered in upper case", function()
            local seen = 0
            local router = ns.newSlashRouter({ onUnknown = function() end })
            router.add("LOCKS", function()
                seen = seen + 1
            end)

            router.dispatch("locks")

            assert.equal(1, seen)
        end)

        it("tolerates leading whitespace", function()
            local router, recorded = newRouter()

            router.dispatch("   locks")

            assert.equal(1, #recorded.locks)
        end)

        it("tolerates trailing whitespace", function()
            local router, recorded = newRouter()

            router.dispatch("locks   ")

            assert.same({ "" }, recorded.locks)
        end)

        it("tolerates whitespace on both sides", function()
            local router, recorded = newRouter()

            router.dispatch("  locks  ")

            assert.same({ "" }, recorded.locks)
        end)

        it("tolerates a tab-separated argument", function()
            local router, recorded = newRouter()

            router.dispatch("locks\tsorted")

            assert.same({ "sorted" }, recorded.locks)
        end)
    end)

    describe("passing the argument through", function()
        it("passes an empty argument when only the subcommand was typed", function()
            local router, recorded = newRouter()

            router.dispatch("locks")

            assert.same({ "" }, recorded.locks)
        end)

        it("passes the argument that follows the subcommand", function()
            local router, recorded = newRouter()

            router.dispatch("locks raid")

            assert.same({ "raid" }, recorded.locks)
        end)

        it("passes the whole remainder, spaces included", function()
            local router, recorded = newRouter()

            router.dispatch("locks sort by instance")

            assert.same({ "sort by instance" }, recorded.locks)
        end)

        it("does not leak trailing whitespace into the argument", function()
            local router, recorded = newRouter()

            router.dispatch("locks raid   ")

            assert.same({ "raid" }, recorded.locks)
        end)

        it("keeps the argument's original case", function()
            local router, recorded = newRouter()

            router.dispatch("LOCKS RaidOnly")

            assert.same({ "RaidOnly" }, recorded.locks)
        end)
    end)

    describe("falling through to onUnknown", function()
        it("reports an unknown subcommand", function()
            local router, recorded = newRouter()

            router.dispatch("nonsense")

            assert.same({ "nonsense" }, recorded.unknown)
            assert.same({}, recorded.locks)
        end)

        it("lower-cases the unknown subcommand it reports", function()
            local router, recorded = newRouter()

            router.dispatch("NoNsEnSe")

            assert.same({ "nonsense" }, recorded.unknown)
        end)

        it("reports the empty string for an empty command", function()
            local router, recorded = newRouter()

            router.dispatch("")

            assert.same({ "" }, recorded.unknown)
        end)

        it("reports the empty string for whitespace only", function()
            local router, recorded = newRouter()

            router.dispatch("    ")

            assert.same({ "" }, recorded.unknown)
        end)

        it("reports the empty string when the client passes nil", function()
            local router, recorded = newRouter()

            router.dispatch(nil)

            assert.same({ "" }, recorded.unknown)
        end)

        it("does not pass the argument of an unknown subcommand as the subcommand", function()
            local router, recorded = newRouter()

            router.dispatch("nonsense with args")

            assert.same({ "nonsense" }, recorded.unknown)
        end)
    end)
end)
