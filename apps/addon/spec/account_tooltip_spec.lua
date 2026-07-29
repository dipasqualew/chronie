local loader = require("addon_loader")

describe("the account's answer to a hovered row", function()
    local ns = loader.load()

    local NOW = 1700000000
    local DAY = 24 * 60 * 60
    local PLAYING = "Main-Ravencrest"

    ---What an option is worth: whatever the case asked for, or the default when it asked for
    ---nothing. `false` is how a case asks for the field to be genuinely absent — a `nil` in a
    ---Lua table is indistinguishable from a key nobody wrote, and half of what is worth
    ---testing here is what happens when the client answered with nothing.
    ---@param value any
    ---@param default any
    ---@return any
    local function given(value, default)
        if value == nil then
            return default
        end
        return value ~= false and value or nil
    end

    ---The left column of every line, so a test can say what the tooltip reads like without
    ---pinning the shape of every entry it is made of.
    ---@param content table?
    ---@return string[]
    local function lefts(content)
        local out = {}
        for _, line in ipairs(content and content.lines or {}) do
            out[#out + 1] = line.left
        end
        return out
    end

    ---The line whose left column starts with `prefix`, or nil.
    ---@param content table?
    ---@param prefix string
    ---@return table?
    local function lineFor(content, prefix)
        for _, line in ipairs(content and content.lines or {}) do
            if line.left:sub(1, #prefix) == prefix then
                return line
            end
        end
        return nil
    end

    describe("ns.groupDigits", function()
        it("is exported by the addon files", function()
            assert.is_function(ns.groupDigits)
        end)

        -- The bar caption under a faction and the tooltip over it print the same number, so
        -- the grouping has to be one function rather than two that agree today.
        for _, case in ipairs({
            { value = 0, reads = "0" },
            { value = 999, reads = "999" },
            { value = 1000, reads = "1,000" },
            { value = 12000, reads = "12,000" },
            { value = 1234567, reads = "1,234,567" },
            { value = -2500, reads = "-2,500" },
            { value = nil, reads = "0" },
        }) do
            it("reads " .. tostring(case.value) .. " as " .. case.reads, function()
                assert.equal(case.reads, ns.groupDigits(case.value))
            end)
        end
    end)

    describe("ns.standingTooltip", function()
        ---@param overrides table?
        ---@return table
        local function gain(overrides)
            local base = {
                faction = "Dream Wardens",
                amount = 250,
                standing = "Renown 8",
                current = 500,
                max = 2500,
                rank = 8,
                system = "renown",
            }
            for key, value in pairs(overrides or {}) do
                base[key] = given(value, value)
            end
            return base
        end

        ---@param characters table[]?
        ---@param best table?
        ---@return table?
        local function rollup(characters, best)
            if not characters then
                return nil
            end
            return { faction = "Dream Wardens", best = best or characters[1], characters = characters }
        end

        ---@param options table?
        ---@return table?
        local function tooltip(options)
            options = options or {}
            return ns.standingTooltip({
                faction = given(options.faction, "Dream Wardens"),
                gain = given(options.gain, gain()),
                rollup = options.rollup,
                character = given(options.character, PLAYING),
                now = given(options.now, NOW),
            })
        end

        it("is exported by the addon files", function()
            assert.is_function(ns.standingTooltip)
        end)

        it("titles itself with the faction hovered", function()
            assert.equal("Dream Wardens", tooltip().title)
        end)

        it("has nothing to draw for a faction nobody has been placed with", function()
            assert.is_nil(tooltip({ gain = { faction = "Dream Wardens", amount = 250 } }))
        end)

        it("has nothing to draw when the row names no faction", function()
            assert.is_nil(tooltip({ faction = false }))
            assert.is_nil(tooltip({ faction = "" }))
        end)

        it("lists the character being played from the client rather than from its own file", function()
            -- The stored row is what this character wrote down at its last logout; the gain is
            -- what the client answered a moment ago. The panel must not report the stale one
            -- back at the player who is watching the fresh one move.
            local content = tooltip({
                rollup = rollup({
                    {
                        character = PLAYING,
                        standing = "Renown 5",
                        current = 100,
                        max = 2500,
                        rank = 5,
                        system = "renown",
                        at = NOW - 7 * DAY,
                    },
                }),
            })

            assert.same({ "Best", "Main (you)", "No other character has been seen here." }, lefts(content))
            assert.equal("Renown 8  500 / 2,500", lineFor(content, "Main").right)
        end)

        it("counts the character being played once when the store already had a row for it", function()
            local content = tooltip({
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Renown 3", rank = 3, system = "renown", at = NOW },
                    { character = PLAYING, standing = "Renown 5", rank = 5, system = "renown", at = NOW - DAY },
                }),
            })

            assert.same({ "Best", " ", "Main (you)", "Alt" }, lefts(content))
        end)

        it("crowns whoever is furthest along, and says so before the roster", function()
            local content = tooltip({
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Renown 22", rank = 22, system = "renown", at = NOW },
                }),
            })

            assert.equal("Renown 22 · Alt", lineFor(content, "Best").right)
            assert.equal("total", lineFor(content, "Best").role)
        end)

        it("crowns the character being played when it is the one out in front", function()
            local content = tooltip({
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Renown 4", rank = 4, system = "renown", at = NOW },
                }),
            })

            assert.equal("Renown 8  500 / 2,500 · you", lineFor(content, "Best").right)
        end)

        -- The store's `best` is computed over stored rows only. A character that overtook the
        -- account's best during this very session must not still be told somebody is ahead.
        it("crowns a standing earned this session over the one the store had filed", function()
            local content = tooltip({
                gain = gain({ standing = "Renown 23", rank = 23 }),
                rollup = rollup(
                    {
                        {
                            character = "Alt-Ravencrest",
                            standing = "Renown 22",
                            rank = 22,
                            system = "renown",
                            at = NOW - DAY,
                        },
                        { character = PLAYING, standing = "Renown 21", rank = 21, system = "renown", at = NOW - DAY },
                    },
                    { character = "Alt-Ravencrest", standing = "Renown 22", rank = 22, system = "renown" }
                ),
            })

            assert.equal("Renown 23  500 / 2,500 · you", lineFor(content, "Best").right)
            assert.same({ "Best", " ", "Main (you)", "Alt · 1d ago" }, lefts(content))
        end)

        it("orders the roster by how far along each character is", function()
            local content = tooltip({
                gain = gain({ standing = "Renown 10", rank = 10 }),
                rollup = rollup({
                    { character = "Aaa-Ravencrest", standing = "Renown 4", rank = 4, system = "renown", at = NOW },
                    { character = "Bbb-Ravencrest", standing = "Renown 22", rank = 22, system = "renown", at = NOW },
                    { character = "Ccc-Ravencrest", standing = "Renown 13", rank = 13, system = "renown", at = NOW },
                }),
            })

            assert.same({ "Best", " ", "Bbb", "Ccc", "Main (you)", "Aaa" }, lefts(content))
        end)

        it("breaks a tie on progress into the level, then on name", function()
            local content = tooltip({
                gain = false,
                character = false,
                rollup = rollup({
                    {
                        character = "Bbb-Ravencrest",
                        standing = "Honored",
                        current = 10,
                        max = 12000,
                        rank = 6,
                        system = "reaction",
                        at = NOW,
                    },
                    {
                        character = "Aaa-Ravencrest",
                        standing = "Honored",
                        current = 9000,
                        max = 12000,
                        rank = 6,
                        system = "reaction",
                        at = NOW,
                    },
                    {
                        character = "Ccc-Ravencrest",
                        standing = "Honored",
                        current = 10,
                        max = 12000,
                        rank = 6,
                        system = "reaction",
                        at = NOW,
                    },
                }),
            })

            assert.same({ "Best", " ", "Aaa", "Bbb", "Ccc" }, lefts(content))
        end)

        -- A rank read off the reaction ladder runs 1 to 8 where a friendship's runs into the
        -- thousands, so the two cannot be ranked against each other. The odd reading keeps its
        -- place in the list and is simply never crowned.
        it("never ranks a standing read off another ladder against the rest", function()
            local content = tooltip({
                gain = false,
                character = false,
                rollup = rollup(
                    {
                        {
                            character = "Alt-Ravencrest",
                            standing = "Best Friend",
                            rank = 42000,
                            system = "friendship",
                            at = NOW,
                        },
                        { character = "Zed-Ravencrest", standing = "Revered", rank = 7, system = "reaction", at = NOW },
                    },
                    { character = "Zed-Ravencrest", standing = "Revered", rank = 7, system = "reaction" }
                ),
            })

            assert.equal("Revered · Zed", lineFor(content, "Best").right)
            assert.same({ "Best", " ", "Zed", "Alt" }, lefts(content))
        end)

        it("crowns nobody when no standing can be placed on a ladder at all", function()
            local content = tooltip({
                gain = gain({ rank = false, system = false }),
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Honored", at = NOW },
                }),
            })

            assert.is_nil(lineFor(content, "Best"))
            assert.same({ "Alt", "Main (you)" }, lefts(content))
        end)

        it("says how stale a character's standing is, and nothing for a fresh one", function()
            local content = tooltip({
                rollup = rollup({
                    {
                        character = "Alt-Ravencrest",
                        standing = "Renown 22",
                        rank = 22,
                        system = "renown",
                        at = NOW - 3 * DAY,
                    },
                    {
                        character = "Zed-Ravencrest",
                        standing = "Renown 20",
                        rank = 20,
                        system = "renown",
                        at = NOW - 30,
                    },
                }),
            })

            assert.same({ "Best", " ", "Alt · 3d ago", "Zed", "Main (you)" }, lefts(content))
        end)

        it("says nothing about staleness without a clock to say it against", function()
            local content = tooltip({
                now = false,
                rollup = rollup({
                    {
                        character = "Alt-Ravencrest",
                        standing = "Renown 22",
                        rank = 22,
                        system = "renown",
                        at = NOW - 3 * DAY,
                    },
                }),
            })

            assert.same({ "Best", " ", "Alt", "Main (you)" }, lefts(content))
        end)

        it("keeps the realm on every name once two characters share one", function()
            local content = tooltip({
                character = "Main-Ravencrest",
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Renown 4", rank = 4, system = "renown", at = NOW },
                    { character = "Alt-Draenor", standing = "Renown 6", rank = 6, system = "renown", at = NOW },
                }),
            })

            assert.same({ "Best", " ", "Main-Ravencrest (you)", "Alt-Draenor", "Alt-Ravencrest" }, lefts(content))
        end)

        it("says outright that nobody else has met the faction", function()
            local content = tooltip()

            assert.same({ "Best", "Main (you)", "No other character has been seen here." }, lefts(content))
            assert.equal("note", lineFor(content, "No other").role)
        end)

        it("colours the account's figure and the played character's row apart", function()
            local content = tooltip({
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Renown 22", rank = 22, system = "renown", at = NOW },
                }),
            })

            assert.equal("total", lineFor(content, "Best").role)
            assert.equal("you", lineFor(content, "Main").role)
            assert.equal("other", lineFor(content, "Alt").role)
        end)

        it("says a standing it has numbers but no name for, and admits to neither", function()
            local content = tooltip({
                gain = gain({ standing = false }),
                rollup = rollup({
                    { character = "Alt-Ravencrest", rank = 3, system = "renown", at = NOW },
                }),
            })

            assert.equal("500 / 2,500", lineFor(content, "Main").right)
            assert.equal("unknown", lineFor(content, "Alt").right)
        end)
    end)

    ---The same crown the tooltip's "Best" line is drawn from, lifted out so the panel's own
    ---line can state it without opening a tooltip to find it. Everything the tooltip already
    ---obeys about who leads is what this has to obey too, which is why the cases below read
    ---like the ones above them.
    describe("ns.bestStanding", function()
        ---@param overrides table?
        ---@return table
        local function gain(overrides)
            local base = {
                faction = "Dream Wardens",
                amount = 250,
                standing = "Renown 8",
                current = 500,
                max = 2500,
                rank = 8,
                system = "renown",
            }
            for key, value in pairs(overrides or {}) do
                base[key] = given(value, value)
            end
            return base
        end

        ---@param characters table[]?
        ---@param best table?
        ---@return table?
        local function rollup(characters, best)
            if not characters then
                return nil
            end
            return { faction = "Dream Wardens", best = best or characters[1], characters = characters }
        end

        ---@param options table?
        ---@return table?
        local function crown(options)
            options = options or {}
            return ns.bestStanding({
                faction = given(options.faction, "Dream Wardens"),
                gain = given(options.gain, gain()),
                rollup = options.rollup,
                character = given(options.character, PLAYING),
                now = given(options.now, NOW),
            })
        end

        it("is exported by the addon files", function()
            assert.is_function(ns.bestStanding)
        end)

        it("crowns whoever on the account has got furthest, and dates the reading", function()
            local row = crown({
                rollup = rollup({
                    {
                        character = "Alt-Ravencrest",
                        standing = "Renown 22",
                        rank = 22,
                        system = "renown",
                        at = NOW - 3 * DAY,
                    },
                }),
            })

            assert.equal("Alt-Ravencrest", row.character)
            assert.equal("Alt", row.name)
            assert.equal("Renown 22", row.standing)
            assert.equal(22, row.rank)
            assert.equal("renown", row.system)
            assert.equal(NOW - 3 * DAY, row.at)
            assert.is_not_true(row.you)
        end)

        -- The stored row for this character was written at its last logout; the gain is what
        -- the client answered a moment ago. The two are one character, so the fresh reading
        -- replaces the stale one rather than standing beside it as a second contender.
        it("crowns the character being played from the client rather than from its own file", function()
            local row = crown({
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Renown 4", rank = 4, system = "renown", at = NOW },
                    {
                        character = PLAYING,
                        standing = "Renown 5",
                        current = 100,
                        max = 2500,
                        rank = 5,
                        system = "renown",
                        at = NOW - 7 * DAY,
                    },
                }),
            })

            assert.equal(PLAYING, row.character)
            assert.is_true(row.you)
            assert.equal("Renown 8", row.standing)
            assert.equal(500, row.current)
            assert.equal(2500, row.max)
            assert.equal(8, row.rank)
            assert.equal(NOW, row.at)
        end)

        -- The store's `best` is computed over stored rows only. A character that overtook the
        -- account's best during this very session holds the crown from the moment it did.
        it("crowns a standing earned this session over the one the store had filed", function()
            local row = crown({
                gain = gain({ standing = "Renown 23", rank = 23 }),
                rollup = rollup(
                    {
                        {
                            character = "Alt-Ravencrest",
                            standing = "Renown 22",
                            rank = 22,
                            system = "renown",
                            at = NOW - DAY,
                        },
                        { character = PLAYING, standing = "Renown 21", rank = 21, system = "renown", at = NOW - DAY },
                    },
                    { character = "Alt-Ravencrest", standing = "Renown 22", rank = 22, system = "renown" }
                ),
            })

            assert.equal(PLAYING, row.character)
            assert.is_true(row.you)
            assert.equal("Renown 23", row.standing)
        end)

        -- A roster of one is still a roster, and the one reading in it is still the account's
        -- highest: "nobody else has been here" is not the same answer as "nothing is known".
        it("crowns the character being played when nobody else has been seen with the faction", function()
            local row = crown({ rollup = nil })

            assert.equal(PLAYING, row.character)
            assert.equal("Main", row.name)
            assert.is_true(row.you)
            assert.equal("Renown 8", row.standing)
        end)

        it("has nothing to crown when the row names no faction", function()
            assert.is_nil(crown({ faction = false }))
            assert.is_nil(crown({ faction = "" }))
        end)

        it("has nothing to crown for a faction nobody has been placed with", function()
            assert.is_nil(crown({ gain = { faction = "Dream Wardens", amount = 250 }, rollup = nil }))
        end)

        -- A standing with no rank cannot be ranked, so there is nobody to put in front. The
        -- row is known and simply not comparable, which is a different answer from silence
        -- only the caller can tell apart.
        it("crowns nobody when no standing can be placed on a ladder at all", function()
            assert.is_nil(crown({
                gain = gain({ rank = false, system = false }),
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Honored", at = NOW },
                }),
            }))
        end)

        -- A rank read off the reaction ladder runs 1 to 8 where a friendship's runs into the
        -- thousands, so a row off the ladder being ranked is never the one crowned however
        -- large its number reads.
        it("never crowns a standing read off another ladder", function()
            local row = crown({
                gain = false,
                character = false,
                rollup = rollup(
                    {
                        {
                            character = "Alt-Ravencrest",
                            standing = "Best Friend",
                            rank = 42000,
                            system = "friendship",
                            at = NOW,
                        },
                        { character = "Zed-Ravencrest", standing = "Revered", rank = 7, system = "reaction", at = NOW },
                    },
                    { character = "Zed-Ravencrest", standing = "Revered", rank = 7, system = "reaction" }
                ),
            })

            assert.equal("Zed-Ravencrest", row.character)
            assert.equal("Zed", row.name)
        end)

        -- Shortening both of two same-named alts would name the crown something two characters
        -- answer to, so the realm goes back on every row the moment one short name is claimed
        -- twice — the same rule the roster in the tooltip is named by.
        it("keeps the realm on the name once two characters share one", function()
            local row = crown({
                gain = false,
                character = false,
                rollup = rollup({
                    { character = "Alt-Ravencrest", standing = "Renown 4", rank = 4, system = "renown", at = NOW },
                    { character = "Alt-Draenor", standing = "Renown 26", rank = 26, system = "renown", at = NOW },
                }, { character = "Alt-Draenor", standing = "Renown 26", rank = 26, system = "renown" }),
            })

            assert.equal("Alt-Draenor", row.character)
            assert.equal("Alt-Draenor", row.name)
        end)
    end)

    describe("ns.currencyTooltip", function()
        ---@param options table?
        ---@return table?
        local function tooltip(options)
            options = options or {}
            return ns.currencyTooltip({
                name = given(options.name, "Valorstones"),
                gain = options.gain,
                rollup = options.rollup,
                character = given(options.character, PLAYING),
                now = given(options.now, NOW),
            })
        end

        ---@param characters table[]
        ---@param accountWide boolean?
        ---@return table
        local function rollup(characters, accountWide)
            local total = 0
            for _, held in ipairs(characters) do
                total = total + held.total
            end
            return {
                id = 3008,
                name = "Valorstones",
                total = total,
                accountWide = accountWide or false,
                characters = characters,
                oldest = NOW,
            }
        end

        it("is exported by the addon files", function()
            assert.is_function(ns.currencyTooltip)
        end)

        it("has nothing to draw before any character has reported a holding", function()
            assert.is_nil(tooltip())
            assert.is_nil(tooltip({ gain = { id = 3008, name = "Valorstones", amount = 250 } }))
        end)

        it("adds up what the whole account is holding, and says who holds it", function()
            local content = tooltip({
                gain = { id = 3008, name = "Valorstones", amount = 250, total = 1200 },
                rollup = rollup({
                    { character = "Alt-Ravencrest", name = "Valorstones", total = 1910, at = NOW - 2 * DAY },
                    { character = "Zed-Ravencrest", name = "Valorstones", total = 300, at = NOW - 9 * DAY },
                }),
            })

            assert.equal("Valorstones", content.title)
            assert.same({ "Account", " ", "Alt · 2d ago", "Main (you)", "Zed · 9d ago" }, lefts(content))
            assert.equal("3,410", lineFor(content, "Account").right)
            assert.equal("1,200", lineFor(content, "Main").right)
        end)

        -- The stored row was written at that character's last logout; the segment has been
        -- spending and earning since. Adding both counts the same character twice.
        it("counts the played character once, at what the client says it now holds", function()
            local content = tooltip({
                gain = { id = 3008, name = "Valorstones", amount = 250, total = 1200 },
                rollup = rollup({
                    { character = PLAYING, name = "Valorstones", total = 950, at = NOW - DAY },
                    { character = "Alt-Ravencrest", name = "Valorstones", total = 1000, at = NOW },
                }),
            })

            assert.same({ "Account", " ", "Main (you)", "Alt" }, lefts(content))
            assert.equal("2,200", lineFor(content, "Account").right)
        end)

        it("falls back to the stored holding when the segment never saw a total", function()
            local content = tooltip({
                gain = { id = 3008, name = "Valorstones", amount = 250 },
                rollup = rollup({
                    { character = PLAYING, name = "Valorstones", total = 950, at = NOW - DAY },
                }),
            })

            assert.equal("950", lineFor(content, "Main").right)
            assert.equal("950", lineFor(content, "Account").right)
        end)

        -- Every character is answered with the account's one shared balance, so the rows are
        -- one number reported over and over. Summing them multiplies the pot by the roster.
        it("counts a warband-wide pot once rather than once per character", function()
            local content = tooltip({
                gain = { id = 3008, name = "Valorstones", amount = 250, total = 3410 },
                rollup = rollup({
                    { character = PLAYING, name = "Valorstones", total = 3160, at = NOW - DAY },
                    { character = "Alt-Ravencrest", name = "Valorstones", total = 3160, at = NOW - 2 * DAY },
                    { character = "Zed-Ravencrest", name = "Valorstones", total = 3160, at = NOW - 9 * DAY },
                }, true),
            })

            assert.same({ "Warband", "One pot the whole account shares." }, lefts(content))
            assert.equal("3,410", lineFor(content, "Warband").right)
        end)

        it("dates a shared pot by the freshest reading of it", function()
            local content = tooltip({
                gain = false,
                rollup = rollup({
                    { character = "Alt-Ravencrest", name = "Valorstones", total = 3160, at = NOW - 2 * DAY },
                    { character = "Zed-Ravencrest", name = "Valorstones", total = 900, at = NOW - 9 * DAY },
                }, true),
            })

            assert.same({ "Warband · 2d ago", "One pot the whole account shares." }, lefts(content))
            assert.equal("3,160", lineFor(content, "Warband").right)
        end)

        it("orders the roster by who is holding the most", function()
            local content = tooltip({
                gain = { id = 3008, name = "Valorstones", amount = 250, total = 500 },
                rollup = rollup({
                    { character = "Aaa-Ravencrest", name = "Valorstones", total = 10, at = NOW },
                    { character = "Bbb-Ravencrest", name = "Valorstones", total = 9000, at = NOW },
                    { character = "Ccc-Ravencrest", name = "Valorstones", total = 700, at = NOW },
                }),
            })

            assert.same({ "Account", " ", "Bbb", "Ccc", "Main (you)", "Aaa" }, lefts(content))
        end)

        it("says outright that nobody else is holding any", function()
            local content = tooltip({ gain = { id = 3008, name = "Valorstones", amount = 250, total = 1200 } })

            assert.same({ "Account", "Main (you)", "No other character has been seen holding any." }, lefts(content))
        end)

        it("takes the currency's name from the rollup when the row was drawn without one", function()
            local content = tooltip({
                name = false,
                rollup = rollup({
                    { character = "Alt-Ravencrest", name = "Valorstones", total = 10, at = NOW },
                }),
            })

            assert.equal("Valorstones", content.title)
        end)

        it("has nothing to draw for a currency nothing can name", function()
            assert.is_nil(tooltip({ name = false, gain = { id = 3008, amount = 250, total = 5 } }))
        end)
    end)
end)
