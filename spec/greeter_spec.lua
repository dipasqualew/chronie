local loader = require("addon_loader")

describe("ns.newGreeter", function()
    ---Loaded through the real .toc so the spec exercises the file's
    ---(addonName, namespace) varargs contract, not a hand-rolled require.
    local ns = loader.load()

    it("is exported by the addon files", function()
        assert.is_function(ns.newGreeter)
    end)

    describe("greet", function()
        local cases = {
            {
                name = "applies the template to the player name",
                template = "Hello World, %s!",
                playerName = "Thrall",
                expected = "Hello World, Thrall!",
            },
            {
                name = "honours a different template",
                template = "Greetings %s, welcome back.",
                playerName = "Jaina",
                expected = "Greetings Jaina, welcome back.",
            },
            {
                name = "falls back to stranger for a nil name",
                template = "Hello World, %s!",
                playerName = nil,
                expected = "Hello World, stranger!",
            },
            {
                name = "falls back to stranger for an empty name",
                template = "Hello World, %s!",
                playerName = "",
                expected = "Hello World, stranger!",
            },
            {
                name = "falls back to stranger when called with no arguments",
                template = "Hello World, %s!",
                playerName = nil,
                expected = "Hello World, stranger!",
            },
            {
                name = "does not trim names that are merely whitespace-ish",
                template = "Hello World, %s!",
                playerName = " ",
                expected = "Hello World,  !",
            },
        }

        for _, case in ipairs(cases) do
            it(case.name, function()
                local greeter = ns.newGreeter({ template = case.template })

                assert.equal(case.expected, greeter.greet(case.playerName))
            end)
        end

        it("is pure: repeated calls return the same greeting", function()
            local greeter = ns.newGreeter({ template = "Hello World, %s!" })

            assert.equal("Hello World, Thrall!", greeter.greet("Thrall"))
            assert.equal("Hello World, Thrall!", greeter.greet("Thrall"))
        end)

        it("keeps instances independent", function()
            local formal = ns.newGreeter({ template = "Well met, %s." })
            local casual = ns.newGreeter({ template = "yo %s" })

            assert.equal("Well met, Thrall.", formal.greet("Thrall"))
            assert.equal("yo Thrall", casual.greet("Thrall"))
        end)
    end)
end)
