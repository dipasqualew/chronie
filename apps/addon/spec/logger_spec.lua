local loader = require("addon_loader")

describe("ns.newLogger", function()
    local ns = loader.load()

    ---@return table logger, table lines captured sink output
    local function newLoggerWithSpySink(prefix)
        local lines = {}
        local logger = ns.newLogger({
            sink = function(message)
                lines[#lines + 1] = message
            end,
            prefix = prefix,
        })
        return logger, lines
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newLogger)
    end)

    it("sends prefix and message to the injected sink", function()
        local logger, lines = newLoggerWithSpySink("|cff33ff99chronie|r:")

        logger.info("Hello World, Thrall!")

        assert.same({ "|cff33ff99chronie|r: Hello World, Thrall!" }, lines)
    end)

    it("writes nothing until info is called", function()
        local _, lines = newLoggerWithSpySink("[p]")

        assert.same({}, lines)
    end)

    it("writes one line per info call, in order", function()
        local logger, lines = newLoggerWithSpySink("[p]")

        logger.info("first")
        logger.info("second")

        assert.same({ "[p] first", "[p] second" }, lines)
    end)

    it("uses the injected prefix verbatim", function()
        local logger, lines = newLoggerWithSpySink("<<>>")

        logger.info("msg")

        assert.same({ "<<>> msg" }, lines)
    end)

    it("handles an empty prefix and an empty message", function()
        local logger, lines = newLoggerWithSpySink("")

        logger.info("")

        assert.same({ " " }, lines)
    end)

    it("does not share state between instances", function()
        local a, aLines = newLoggerWithSpySink("[a]")
        local _, bLines = newLoggerWithSpySink("[b]")

        a.info("only a")

        assert.same({ "[a] only a" }, aLines)
        assert.same({}, bLines)
    end)

    it("works with a luassert spy as the sink", function()
        local sink = spy.new(function() end)
        local logger = ns.newLogger({ sink = sink, prefix = "[p]" })

        logger.info("msg")

        assert.spy(sink).was_called(1)
        assert.spy(sink).was_called_with("[p] msg")
    end)
end)
