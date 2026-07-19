local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newClassDisplay", function()
    local ns = loader.load()

    ---The exact escape sequences the addon is expected to emit for the three classes
    ---the fake knows about, at the default icon size. Spelled out in full rather than
    ---rebuilt from the same format string the source uses, so that a change to either
    ---side shows up here instead of cancelling itself out.
    local ICON = {
        WARRIOR = "|TInterface\\TargetingFrame\\UI-Classes-Circles:14:14:0:0:256:256:0:64:0:64|t",
        MAGE = "|TInterface\\TargetingFrame\\UI-Classes-Circles:14:14:0:0:256:256:64:127:0:64|t",
        PRIEST = "|TInterface\\TargetingFrame\\UI-Classes-Circles:14:14:0:0:256:256:127:190:0:64|t",
    }

    ---What a character whose class we never learned is drawn in.
    local UNKNOWN_COLOR = { 0.8, 0.8, 0.8 }
    local UNKNOWN_CODE = "|cffcccccc"

    local NAME = "Thrall-Ragnaros"

    ---@param options table? `{ classColor = fun?, classIconCoords = table?, iconSize = integer? }`
    ---@return ClassDisplay
    local function newDisplay(options)
        options = options or {}
        local classColor, classIconCoords = fake.newClassLook()
        return ns.newClassDisplay({
            classColor = options.classColor or classColor,
            classIconCoords = options.classIconCoords or classIconCoords,
            iconSize = options.iconSize,
        })
    end

    ---@param display ClassDisplay
    ---@param classFile string?
    ---@return number[] `{ r, g, b }`
    local function colorTriple(display, classFile)
        local r, g, b = display.colorOf(classFile)
        return { r, g, b }
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newClassDisplay)
    end)

    describe("colorOf", function()
        ---@type { classFile: string, color: number[] }[]
        local cases = {
            { classFile = "WARRIOR", color = { 0.78, 0.61, 0.43 } },
            { classFile = "MAGE", color = { 0.25, 0.78, 0.92 } },
            { classFile = "PRIEST", color = { 1, 1, 1 } },
        }

        for _, case in ipairs(cases) do
            it("reads the client's colour for " .. case.classFile, function()
                local display = newDisplay()

                assert.same(case.color, colorTriple(display, case.classFile))
            end)
        end

        -- A character remembered before the addon started recording class tokens.
        it("falls back to grey when the class is unknown to us", function()
            local display = newDisplay()

            assert.same(UNKNOWN_COLOR, colorTriple(display, nil))
        end)

        it("falls back to grey for a class the client has no colour for", function()
            local display = newDisplay()

            assert.same(UNKNOWN_COLOR, colorTriple(display, "EVOKER"))
        end)

        -- A client that answers with a partial colour is answering with no colour.
        it("falls back to grey when the client returns an incomplete colour", function()
            local display = newDisplay({
                classColor = function()
                    return 0.5
                end,
            })

            assert.same(UNKNOWN_COLOR, colorTriple(display, "WARRIOR"))
        end)
    end)

    describe("icon", function()
        for _, classFile in ipairs({ "WARRIOR", "MAGE", "PRIEST" }) do
            it("crops the class sheet to " .. classFile, function()
                local display = newDisplay()

                assert.equal(ICON[classFile], display.icon(classFile))
            end)
        end

        ---@type { name: string, classFile: string?, coords: table? }[]
        local blank = {
            { name = "the class is unknown to us", classFile = nil },
            { name = "the client has no coordinates for the class", classFile = "EVOKER" },
            { name = "the client published no coordinates at all", classFile = "WARRIOR", coords = {} },
        }

        for _, case in ipairs(blank) do
            it("draws nothing when " .. case.name, function()
                local display = newDisplay({ classIconCoords = case.coords })

                assert.equal("", display.icon(case.classFile))
            end)
        end

        it("sizes the icon as asked", function()
            local display = newDisplay({ iconSize = 20 })

            assert.equal(
                "|TInterface\\TargetingFrame\\UI-Classes-Circles:20:20:0:0:256:256:64:127:0:64|t",
                display.icon("MAGE")
            )
        end)
    end)

    describe("label", function()
        it("puts the icon in front of the name", function()
            local display = newDisplay()

            assert.equal(ICON.WARRIOR .. " " .. NAME, display.label("WARRIOR", NAME))
        end)

        it("leaves the name uncoloured, so the caller owns the cell colour", function()
            local display = newDisplay()

            assert.is_nil(display.label("WARRIOR", NAME):find("|c", 1, true))
        end)

        -- No icon means no separator either: a leading space would misalign the column.
        ---@type { name: string, classFile: string? }[]
        local bare = {
            { name = "the class is unknown to us", classFile = nil },
            { name = "the class has no icon", classFile = "EVOKER" },
        }

        for _, case in ipairs(bare) do
            it("is the name alone when " .. case.name, function()
                local display = newDisplay()

                assert.equal(NAME, display.label(case.classFile, NAME))
            end)
        end
    end)

    describe("decorate", function()
        ---@type { classFile: string, expected: string }[]
        local cases = {
            { classFile = "WARRIOR", expected = ICON.WARRIOR .. " |cffc79c6e" .. NAME .. "|r" },
            { classFile = "MAGE", expected = ICON.MAGE .. " |cff40c7eb" .. NAME .. "|r" },
            { classFile = "PRIEST", expected = ICON.PRIEST .. " |cffffffff" .. NAME .. "|r" },
        }

        for _, case in ipairs(cases) do
            it("colours the name inline for " .. case.classFile, function()
                local display = newDisplay()

                assert.equal(case.expected, display.decorate(case.classFile, NAME))
            end)
        end

        -- Nothing is known about the character, so nothing is claimed: an inline grey
        -- would read as a real class colour rather than as an absence.
        it("is the bare name when the class is unknown to us", function()
            local display = newDisplay()

            assert.equal(NAME, display.decorate(nil, NAME))
        end)

        it("greys a class the client has no colour for", function()
            local display = newDisplay()

            assert.equal(UNKNOWN_CODE .. NAME .. "|r", display.decorate("EVOKER", NAME))
        end)

        it("colours the name even when the class has no icon", function()
            local display = newDisplay({ classIconCoords = {} })

            assert.equal("|cffc79c6e" .. NAME .. "|r", display.decorate("WARRIOR", NAME))
        end)

        -- A client colour outside 0-1 must not overflow the two hex digits.
        it("clamps a colour the client reports outside the 0-1 range", function()
            local display = newDisplay({
                classIconCoords = {},
                classColor = function()
                    return -1, 2, 0.5
                end,
            })

            assert.equal("|cff00ff80" .. NAME .. "|r", display.decorate("WARRIOR", NAME))
        end)
    end)
end)
