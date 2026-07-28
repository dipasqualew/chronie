local loader = require("addon_loader")

describe("ns.newCharacterLook", function()
    local ns = loader.load()

    local NOW = 1700000000

    ---One option in the shape `C_BarberShop.GetAvailableCustomizations` hands them back: an id,
    ---a list of choices, and a one-based place in that list saying which is on the character.
    ---@param id integer
    ---@param at integer?
    ---@param choices integer[]?
    ---@return table
    local function option(id, at, choices)
        local offered = {}
        for index, choice in ipairs(choices or { 100, 101, 102 }) do
            offered[index] = { id = choice, name = "" }
        end
        return { id = id, currentChoiceIndex = at, choices = offered }
    end

    ---The client's reply: categories, each holding options. One category unless a test is about
    ---the nesting, because nothing downstream keeps it.
    ---@param options table[]
    ---@return table
    local function categories(options)
        return { { name = "Body", id = 1, options = options } }
    end

    ---Builds a look over readings the test can edit between two syncs.
    ---
    ---`race` and `sex` default to a character the client can name; `false` is how a test says the
    ---client would not name one, since nil is what "the test did not mention it" already means.
    ---@param options table? `{ race, sex, said = table?, store = table? }`
    ---@return table look, table state, table store
    local function newLook(options)
        options = options or {}
        local state = {
            race = options.race == nil and 1 or options.race or nil,
            sex = options.sex == nil and 3 or options.sex or nil,
            said = options.said,
        }
        local store = options.store or {}
        local look = ns.newCharacterLook({
            readRace = function()
                return state.race
            end,
            readSex = function()
                return state.sex
            end,
            readChoices = function()
                return state.said
            end,
            store = store,
            now = function()
                return NOW
            end,
        })
        return look, state, store
    end

    describe("the first look", function()
        -- The race and the sex are readable wherever the character is standing, which is the
        -- half of a look that does not need the barber's chair — and the half the app needs to
        -- pick a body at all.
        it("files who the character is even where nothing will say what they are made of", function()
            local look, _, store = newLook({ race = 22, sex = 2 })

            look.sync()

            assert.equal(22, store.race)
            assert.equal(2, store.sex)
            assert.is_nil(store.choices)
            assert.equal(NOW, store.at)
        end)

        it("files the answers when the game is willing to give them", function()
            local look, _, store = newLook({
                said = categories({ option(14, 2), option(16, 1) }),
            })

            look.sync()

            assert.same({ { option = 14, choice = 101 }, { option = 16, choice = 100 } }, store.choices)
        end)

        it("stamps the moment it was handed, rather than reading the clock", function()
            local look, _, store = newLook()

            look.sync(1700009999)

            assert.equal(1700009999, store.at)
        end)
    end)

    describe("reading what the client hands back", function()
        -- `currentChoiceIndex` is a place in the option's own list rather than an id, which is
        -- how Blizzard's own customization frames read it. Taking it for an id would file a
        -- number that names some other body's swatch, or nothing at all.
        it("follows the current index into the option's own list of choices", function()
            local look = newLook({ said = categories({ option(14, 3, { 500, 501, 502 }) }) })

            assert.same({ { option = 14, choice = 502 } }, look.sync().choices)
        end)

        -- Which tab of the barber's screen a question sits under is the game's arrangement of
        -- its own screen, and nothing downstream draws that screen.
        it("flattens the categories away and keeps the pairs", function()
            local look = newLook({
                said = {
                    { name = "Body", options = { option(14, 1) } },
                    { name = "Hair", options = { option(16, 2), option(17, 1) } },
                },
            })

            assert.same({
                { option = 14, choice = 100 },
                { option = 16, choice = 101 },
                { option = 17, choice = 100 },
            }, look.sync().choices)
        end)

        -- The client orders these for its own screen, and a file whose rows reshuffle between
        -- two readings of an unchanged character is one the comparison could never call
        -- unchanged.
        it("orders the answers by option, whatever order the client listed them in", function()
            local look = newLook({
                said = categories({ option(31, 1), option(14, 1), option(22, 1) }),
            })

            local ordered = {}
            for index, answer in ipairs(look.sync().choices) do
                ordered[index] = answer.option
            end
            assert.same({ 14, 22, 31 }, ordered)
        end)

        -- Everything downstream reads a question with no answer as the swatch the game itself
        -- opens on, so an unanswered option is an absence rather than a value to invent.
        it("drops an option the client offered no current choice for", function()
            local look = newLook({
                said = categories({ option(14, nil), option(16, 1) }),
            })

            assert.same({ { option = 16, choice = 100 } }, look.sync().choices)
        end)

        it("drops an option whose current choice is past the end of its list", function()
            local look = newLook({
                said = categories({ option(14, 9), option(16, 1) }),
            })

            assert.same({ { option = 16, choice = 100 } }, look.sync().choices)
        end)

        it("drops an option the client would not number", function()
            local look = newLook({
                said = categories({ option(nil, 1), option(16, 1) }),
            })

            assert.same({ { option = 16, choice = 100 } }, look.sync().choices)
        end)

        it("survives a reply whose rows are not rows at all", function()
            local look = newLook({
                said = { "Body", 7, { options = { "hair", option(16, 1) } } },
            })

            assert.same({ { option = 16, choice = 100 } }, look.sync().choices)
        end)

        -- The client's own tables are its to mutate, so a look that held on to one would find
        -- every later edit already inside the record it is meant to be comparing against.
        it("does not share a table with the client, so a later edit cannot reach it", function()
            local look, state, store = newLook({ said = categories({ option(14, 1) }) })
            look.sync()

            state.said[1].options[1].choices[1].id = 999

            assert.equal(100, store.choices[1].choice)
        end)
    end)

    describe("what the game will not say", function()
        -- The one fact the whole module is shaped around: `GetAvailableCustomizations` answers
        -- nothing anywhere but the barber's chair, and nothing is the game declining to be asked
        -- rather than a character with no hair, no face and no skin.
        it("keeps the answers a previous session took at the barber's", function()
            local look, state, store = newLook({ said = categories({ option(14, 2) }) })
            look.sync(1)

            state.said = nil
            look.sync(NOW)

            assert.same({ { option = 14, choice = 101 } }, store.choices)
            assert.equal(1, store.at)
        end)

        -- Every playable body in the game is asked something, so a reply with nothing answered
        -- in it is a read taken a moment too early rather than a character made of nothing.
        it("keeps them when the reply arrives with nothing answered in it", function()
            local look, state, store = newLook({ said = categories({ option(14, 2) }) })
            look.sync(1)

            state.said = categories({ option(14, nil) })
            look.sync(NOW)

            assert.same({ { option = 14, choice = 101 } }, store.choices)
            assert.equal(1, store.at)
        end)

        -- And the half that is always readable still is: a character whose race the app has
        -- never had is one it cannot draw at all, which would be a worse silence than an
        -- undecorated body.
        it("still files the race on a look that could say nothing else", function()
            local look, _, store = newLook({ race = 22, sex = 2 })

            look.sync()

            assert.equal(22, store.race)
        end)

        -- A look that learned nothing writes nothing, stamp included. The client cannot name a
        -- character before the world has loaded, and a stamp on that read would say Chronie had
        -- looked at somebody on an evening it never saw one.
        it("files nothing at all about a client that would not name the race either", function()
            local look, _, store = newLook({ race = false, sex = false })

            look.sync()

            assert.same({}, store)
        end)
    end)

    describe("the moment it files against", function()
        ---A look that has already filed once, which is the state every test below is about.
        ---@param options table?
        ---@return table look, table state, table store
        local function filed(options)
            local look, state, store = newLook(options)
            look.sync(1)
            return look, state, store
        end

        -- This runs on the far side of every loading screen there is, so a stamp that moved on
        -- every look would report a trip to the barber's every time the character changed zone.
        it("does not move when a second look says exactly the same thing", function()
            local look, _, store = filed({ said = categories({ option(14, 2), option(16, 1) }) })

            look.sync(NOW)

            assert.equal(1, store.at)
        end)

        it("moves when an answer was changed at the barber's", function()
            local look, state, store = filed({ said = categories({ option(14, 2) }) })

            state.said = categories({ option(14, 3) })
            look.sync(NOW)

            assert.equal(NOW, store.at)
            assert.same({ { option = 14, choice = 102 } }, store.choices)
        end)

        it("moves when a character gained an answer they did not have", function()
            local look, state, store = filed({ said = categories({ option(14, 2) }) })

            state.said = categories({ option(14, 2), option(16, 1) })
            look.sync(NOW)

            assert.equal(NOW, store.at)
        end)

        -- A race change is the one edit to a character that changes which body the app draws
        -- them on rather than what is painted onto it.
        it("moves when the character changed race", function()
            local look, state, store = filed({ race = 1 })

            state.race = 22
            look.sync(NOW)

            assert.equal(NOW, store.at)
            assert.equal(22, store.race)
        end)

        it("moves when the character changed sex", function()
            local look, state, store = filed({ sex = 2 })

            state.sex = 3
            look.sync(NOW)

            assert.equal(NOW, store.at)
        end)

        -- A store handed back by a previous session is what makes a session where nothing
        -- changed leave the stamp where the last one left it.
        it("compares against a look a previous session left behind", function()
            local look, state, store = newLook({
                store = { at = 1, race = 1, sex = 3, choices = { { option = 14, choice = 101 } } },
                said = categories({ option(14, 2) }),
            })

            look.sync(NOW)
            assert.equal(1, store.at)

            state.said = categories({ option(14, 3) })
            look.sync(NOW)
            assert.equal(NOW, store.at)
        end)

        -- SavedVariables is a file a player can edit, and a row that is not a row is a
        -- difference to write over rather than something to raise about.
        it("writes over a stored look whose rows are not rows", function()
            local look, _, store = newLook({
                store = { at = 1, race = 1, sex = 3, choices = { "hair" } },
                said = categories({ option(14, 2) }),
            })

            look.sync(NOW)

            assert.same({ { option = 14, choice = 101 } }, store.choices)
            assert.equal(NOW, store.at)
        end)
    end)
end)
