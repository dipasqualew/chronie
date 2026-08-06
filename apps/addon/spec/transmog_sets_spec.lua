local loader = require("addon_loader")

describe("Blizzard's own transmog sets", function()
    local ns = loader.load()

    local SOURCE = 4242
    local SET = 1783
    local OTHER_SET = 1784

    ---The client's three set calls, each answering out of a table of its own and each writing
    ---down what it was asked about.
    ---
    ---Three separate deps rather than one lookup because the client separates them, and each
    ---refuses independently: a build will happily name the sets a source sits in and then
    ---decline to describe one of them, or list a set's pieces and refuse its name. Keying the
    ---fixtures by set id apart from each other is what lets a case model exactly one of those
    ---refusals without inventing a sentinel for "present but empty".
    ---
    ---The recordings matter as much as the answers. This is asked once per transmog row per
    ---repaint, so a lookup made before the cheap refusal is a cost paid on every frame the
    ---panel is on screen, and only a count of the calls can say it was not.
    ---@param options table? `{ containing = table<integer, integer[]>,
    ---info = table<integer, table>, pieces = table<integer, table[]> }`
    ---@return TransmogSets sets
    ---@return table asked `{ containing = integer[], info = integer[], pieces = integer[] }`
    local function newSets(options)
        options = options or {}
        local asked = { containing = {}, info = {}, pieces = {} }
        local sets = ns.newTransmogSets({
            setsContaining = function(sourceID)
                asked.containing[#asked.containing + 1] = sourceID
                return (options.containing or {})[sourceID]
            end,
            setInfo = function(setID)
                asked.info[#asked.info + 1] = setID
                return (options.info or {})[setID]
            end,
            setPieces = function(setID)
                asked.pieces[#asked.pieces + 1] = setID
                return (options.pieces or {})[setID]
            end,
        })
        return sets, asked
    end

    ---An eight-piece set of which three are held, which is the ordinary shape of the thing:
    ---part way in, and worth saying so.
    ---@return table[]
    local function eightPieces()
        return {
            { sourceID = 101, collected = true },
            { sourceID = 102, collected = true },
            { sourceID = 103, collected = true },
            { sourceID = 104, collected = false },
            { sourceID = 105, collected = false },
            { sourceID = 106, collected = false },
            { sourceID = 107, collected = false },
            { sourceID = 108, collected = false },
        }
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newTransmogSets)
        assert.is_function(ns.transmogClickAction)
        assert.is_function(ns.transmogSetTooltip)
    end)

    describe("ns.newTransmogSets", function()
        it("says which set the appearance sits in and how far into it the account is", function()
            local sets = newSets({
                containing = { [SOURCE] = { SET } },
                info = { [SET] = { name = "Bloodfang Armor", label = "Heroic" } },
                pieces = { [SET] = eightPieces() },
            })

            assert.same({
                setID = SET,
                name = "Bloodfang Armor",
                label = "Heroic",
                collected = 3,
                total = 8,
                sources = { 101, 102, 103, 104, 105, 106, 107, 108 },
            }, sets.forSource(SOURCE))
        end)

        -- The order is the dressing room's, not a detail. `showSet` fits the sources in the
        -- order it is handed them, and the client lists a set's pieces in the order the
        -- wardrobe draws them; sorting or reversing here would put a shoulder in a hand slot
        -- only when two pieces of the set share one, which is a bug nobody would find twice.
        it("hands over every piece's source id in the client's own order", function()
            local sets = newSets({
                containing = { [SOURCE] = { SET } },
                pieces = { [SET] = {
                    { sourceID = 909, collected = false },
                    { sourceID = 101, collected = true },
                    { sourceID = 505, collected = true },
                } },
            })

            assert.same({ 909, 101, 505 }, sets.forSource(SOURCE).sources)
        end)

        -- A source can sit in several sets at once — the same shoulder is in the base set and
        -- in each of its difficulty variants — and the row has room for one line about one of
        -- them. The client's own first is deterministic; "whichever is furthest along" would
        -- move the line under the player as they collected, so the row a dungeon opened with
        -- would be describing a different set by the time they left it.
        it("takes the first set the client named where several contain the source", function()
            local sets, asked = newSets({
                containing = { [SOURCE] = { SET, OTHER_SET } },
                info = { [SET] = { name = "Bloodfang Armor" }, [OTHER_SET] = { name = "Nightslayer" } },
                pieces = {
                    [SET] = eightPieces(),
                    [OTHER_SET] = { { sourceID = 201, collected = true } },
                },
            })

            local membership = sets.forSource(SOURCE)

            assert.equal(SET, membership.setID)
            assert.equal("Bloodfang Armor", membership.name)
            -- And the sets it did not pick were never looked into. Two more lookups per row
            -- per repaint, for an answer that is thrown away the moment it arrives.
            assert.same({ SET }, asked.pieces)
            assert.same({ SET }, asked.info)
        end)

        -- The tally files a source id with every collected appearance, but nothing guarantees
        -- one: an event the client would not resolve leaves the row with an item and no
        -- source. Asking the client which sets contain nothing is a call per row per repaint
        -- that can only ever answer nothing.
        it("asks the client nothing at all when there is no source id to ask about", function()
            local sets, asked = newSets({ containing = { [SOURCE] = { SET } } })

            assert.is_nil(sets.forSource(nil))
            assert.same({}, asked.containing)
        end)

        -- All four are the ordinary case rather than the exception: most appearances in the
        -- game belong to no set at all, and a build that lists a set it will not enumerate is
        -- something the panel meets rather than something it can rule out. Every one of them
        -- has to come back as "no set", because the alternative is a row drawn with a
        -- fraction over nothing — "3/0", or a fraction of a set the player is not collecting.
        for _, case in ipairs({
            {
                what = "the appearance belongs to no set the client knows of",
                containing = nil,
            },
            {
                what = "the client answered with an empty list of sets",
                containing = {},
            },
            {
                what = "the client will not enumerate the set's pieces",
                containing = { SET },
                pieces = nil,
            },
            {
                what = "the set the client named turned out to have no pieces in it",
                containing = { SET },
                pieces = {},
            },
        }) do
            it("answers nothing when " .. case.what, function()
                local sets = newSets({
                    containing = case.containing and { [SOURCE] = case.containing } or {},
                    info = { [SET] = { name = "Bloodfang Armor" } },
                    pieces = case.pieces and { [SET] = case.pieces } or {},
                })

                assert.is_nil(sets.forSource(SOURCE))
            end)
        end

        -- A piece the client will not name a source for is still a piece of the set: the
        -- player has eight slots to fill whether or not this build can say what goes in one
        -- of them. Counting it into the total and leaving it out of the fitting is the only
        -- reading that keeps both halves honest — "3/8" stays the truth the wardrobe shows,
        -- and the dressing room is handed nothing it cannot wear.
        it("counts a piece with no source id toward the total without trying to wear it", function()
            local sets = newSets({
                containing = { [SOURCE] = { SET } },
                pieces = { [SET] = {
                    { sourceID = 101, collected = true },
                    { collected = true },
                    { sourceID = 103, collected = false },
                } },
            })

            local membership = sets.forSource(SOURCE)

            assert.equal(3, membership.total)
            assert.equal(2, membership.collected)
            assert.same({ 101, 103 }, membership.sources)
        end)

        -- The client reports being collected as whatever it feels like — the wardrobe's own
        -- rows carry booleans, and a build that answered 1 and nil would be read exactly the
        -- same way by the player. Truthiness is the contract, and `false` and absent both
        -- have to land on the same side of it or a set reads as further along than it is.
        for _, case in ipairs({
            { what = "true", collected = true, expected = 1 },
            { what = "false", collected = false, expected = 0 },
            { what = "nothing at all", collected = nil, expected = 0 },
            { what = "a number the client used as a flag", collected = 1, expected = 1 },
        }) do
            it("counts a piece the client reports as " .. case.what, function()
                local sets = newSets({
                    containing = { [SOURCE] = { SET } },
                    pieces = { [SET] = { { sourceID = 101, collected = case.collected } } },
                })

                assert.equal(case.expected, sets.forSource(SOURCE).collected)
            end)
        end

        -- A set the client will not describe is still a set, and the fraction is the half of
        -- the row that is actually news. Refusing the membership over a missing name would
        -- take "5 of 8" off a row for want of a string the tooltip can do without.
        it("still answers with the set when the client will not name it", function()
            local sets = newSets({
                containing = { [SOURCE] = { SET } },
                pieces = { [SET] = { { sourceID = 101, collected = true } } },
            })

            local membership = sets.forSource(SOURCE)

            assert.equal(SET, membership.setID)
            assert.is_nil(membership.name)
            assert.is_nil(membership.label)
            assert.equal(1, membership.collected)
            assert.equal(1, membership.total)
        end)

        -- Read live rather than filed with the drop: the account collects another piece on
        -- another character an hour later and the row has to say so the next time it is
        -- painted. A membership cached behind the first answer would leave every panel on
        -- screen reporting the count it was opened with.
        it("asks again on every repaint rather than answering from the first reading", function()
            local pieces = { { sourceID = 101, collected = false } }
            local sets, asked = newSets({
                containing = { [SOURCE] = { SET } },
                pieces = { [SET] = pieces },
            })

            assert.equal(0, sets.forSource(SOURCE).collected)
            pieces[1].collected = true

            assert.equal(1, sets.forSource(SOURCE).collected)
            assert.same({ SOURCE, SOURCE }, asked.containing)
        end)
    end)

    describe("ns.transmogClickAction", function()
        -- The whole truth table, because the four actions differ only by which button and
        -- whether shift was down, and a pair swapped anywhere in it is a click that quietly
        -- does the wrong one of two plausible things. Shift is the widening modifier
        -- throughout: unshifted acts on the piece that dropped, shifted on the set it is in.
        for _, case in ipairs({
            {
                what = "a plain left click shows the piece that dropped",
                button = "LeftButton", shift = false, inSet = true, action = "previewItem",
            },
            {
                what = "a plain right click opens the piece that dropped",
                button = "RightButton", shift = false, inSet = true, action = "openItem",
            },
            {
                what = "shift widens a left click to the whole set",
                button = "LeftButton", shift = true, inSet = true, action = "previewSet",
            },
            {
                what = "shift widens a right click to the whole set",
                button = "RightButton", shift = true, inSet = true, action = "openSet",
            },
            -- Shift over a row that has no set has asked for something that does not exist,
            -- and the piece clicked is the nearest true answer. A click that silently did
            -- nothing reads as the panel being broken, which is a worse bug than a narrow
            -- answer to a wide question.
            {
                what = "shift falls back to the piece when there is no set to widen to",
                button = "LeftButton", shift = true, inSet = false, action = "previewItem",
            },
            {
                what = "a shifted right click falls back the same way",
                button = "RightButton", shift = true, inSet = false, action = "openItem",
            },
            -- Neither modifier nor membership is ever a certainty. `shiftDown` is a dep the
            -- panel may not have been handed, and the set lookup answers nothing for most
            -- appearances, so nil arrives on both far more often than false does.
            {
                what = "nothing at all was said about shift or about a set",
                button = "LeftButton", shift = nil, inSet = nil, action = "previewItem",
            },
            {
                what = "a right click arrives with neither answered",
                button = "RightButton", shift = nil, inSet = nil, action = "openItem",
            },
            -- The client reports a good half-dozen buttons, and the panel registers for more
            -- than the two it acts on. Right is the one that means something different; every
            -- other button is read as the ordinary click, so a thumb button previews rather
            -- than falling through the row into whatever is behind it.
            {
                what = "the middle button is read as an ordinary click",
                button = "MiddleButton", shift = false, inSet = true, action = "previewItem",
            },
            {
                what = "a thumb button is read as an ordinary click",
                button = "Button4", shift = true, inSet = true, action = "previewSet",
            },
            {
                what = "the client named no button at all",
                button = nil, shift = false, inSet = true, action = "previewItem",
            },
        }) do
            it(case.what, function()
                assert.equal(case.action,
                    ns.transmogClickAction(case.button, case.shift, case.inSet))
            end)
        end
    end)

    describe("ns.transmogSetTooltip", function()
        ---A membership as `forSource` hands one over. `false` is how a case asks for a field
        ---to be genuinely absent: a nil written into an overrides table is indistinguishable
        ---from a key nobody wrote, and half of what is worth testing here is the client
        ---having answered with nothing.
        ---@param overrides table?
        ---@return TransmogSetMembership
        local function membership(overrides)
            local base = {
                setID = SET,
                name = "Bloodfang Armor",
                collected = 3,
                total = 8,
                sources = { 101, 102 },
            }
            for key, value in pairs(overrides or {}) do
                base[key] = value ~= false and value or nil
            end
            return base
        end

        ---The tooltip as it reads on screen: the title, then `left` or `left → right` per
        ---line. What a player sees, rather than the roles the panel colours them by.
        ---@param content AccountTooltipContent?
        ---@return string[]
        local function readable(content)
            local out = { content.title }
            for _, line in ipairs(content.lines) do
                out[#out + 1] = line.right and (line.left .. " → " .. line.right) or line.left
            end
            return out
        end

        ---@param content AccountTooltipContent
        ---@param left string
        ---@return table? the first line saying that
        local function lineSaying(content, left)
            for _, line in ipairs(content.lines) do
                if line.left == left then
                    return line
                end
            end
            return nil
        end

        -- Most rows have no set, and the panel hangs the tooltip on whatever this returns:
        -- an empty content would mouse-enable the row for a tooltip with nothing in it,
        -- making a dead spot on a frame the player drags the panel by.
        it("has nothing to say about a row that belongs to no set", function()
            assert.is_nil(ns.transmogSetTooltip(nil))
        end)

        it("reads as the set, its qualifier, and how far in the account is", function()
            assert.same({
                "Bloodfang Armor",
                "Heroic",
                "Collected → 3 / 8",
                "",
                "Shift-click to try on the whole set",
                "Shift-right-click to open it in Collections",
            }, readable(ns.transmogSetTooltip(membership({ label = "Heroic" }))))
        end)

        -- The set id is not much of a title, and it is a great deal better than a tooltip
        -- headed by nothing at all: the player at least knows the row belongs to *a* set, and
        -- the fraction under it is the part that was worth hovering for.
        it("falls back to the set's id when the client named nothing", function()
            assert.equal("Set 1783", ns.transmogSetTooltip(membership({ name = false })).title)
        end)

        -- The label is the set's own qualifier and only some sets carry one. Drawing an empty
        -- line for the rest would push the fraction down the tooltip for no reason and read
        -- as a name the client failed to fetch.
        for _, case in ipairs({
            { what = "opens on the qualifier where the set has one", label = "Mythic", first = "Mythic" },
            { what = "opens straight on the fraction where it has none", label = false, first = "Collected" },
        }) do
            it(case.what, function()
                local content = ns.transmogSetTooltip(membership({ label = case.label }))

                assert.equal(case.first, content.lines[1].left)
            end)
        end

        it("marks the qualifier as a note rather than as a figure", function()
            local content = ns.transmogSetTooltip(membership({ label = "Mythic" }))

            assert.equal("note", lineSaying(content, "Mythic").role)
        end)

        -- Spaces around the slash, which is not the same string the row itself carries: the
        -- row is "3/8" squeezed into ninety pixels beside an icon, and the tooltip has the
        -- width to read as a sentence. Pinned because the two are easy to unify by accident.
        it("spaces the fraction out the way a tooltip has room to", function()
            assert.equal("3 / 8", lineSaying(ns.transmogSetTooltip(membership()), "Collected").right)
        end)

        -- The role is what colours the line, and it is the whole of how a finished set is
        -- told from one still being worked on. "Complete" is `collected >= total` rather than
        -- equality, because a client that counts a piece twice would otherwise leave a set
        -- the player has finished reading as unfinished forever.
        for _, case in ipairs({
            { what = "a set part way through", collected = 3, total = 8, role = "you" },
            { what = "the last piece still missing", collected = 7, total = 8, role = "you" },
            { what = "a set the account has finished", collected = 8, total = 8, role = "total" },
            { what = "a client counting more pieces than it listed", collected = 9, total = 8, role = "total" },
        }) do
            it("colours the fraction for " .. case.what, function()
                local content = ns.transmogSetTooltip(membership({
                    collected = case.collected,
                    total = case.total,
                }))

                assert.equal(case.role, lineSaying(content, "Collected").role)
            end)
        end

        -- These two lines are the only place in the addon the shifted actions are ever
        -- spelled out. A modifier nobody is told about is a feature nobody has, so losing
        -- them costs the whole of the set half of the row rather than a line of decoration.
        it("spells out both modifiers, under a blank so they read as instructions", function()
            local content = ns.transmogSetTooltip(membership())
            local lines = content.lines

            assert.equal("", lines[#lines - 2].left)
            assert.equal("blank", lines[#lines - 2].role)
            assert.equal("Shift-click to try on the whole set", lines[#lines - 1].left)
            assert.equal("Shift-right-click to open it in Collections", lines[#lines].left)
        end)

        -- Told even where there is nothing left to collect: the shifted left click is how a
        -- finished set gets tried on as a whole, which is exactly when a player wants to.
        it("still spells them out for a set that is already complete", function()
            local content = ns.transmogSetTooltip(membership({ collected = 8, total = 8 }))

            assert.is_not_nil(lineSaying(content, "Shift-click to try on the whole set"))
            assert.is_not_nil(lineSaying(content, "Shift-right-click to open it in Collections"))
        end)
    end)
end)
