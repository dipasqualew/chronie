local loader = require("addon_loader")

describe("Blizzard's own transmog sets", function()
    local ns = loader.load()

    local SOURCE = 4242
    local SET = 1783
    local OTHER_SET = 1784
    -- Two other items in the game wearing the same look as SOURCE, in the order the client
    -- lists them. A set names item-modified-appearance rows rather than looks, so a set that
    -- lists one of these says nothing at all about SOURCE when it is asked directly.
    local SHARED = 4243
    local LATER_SHARED = 4244

    ---The client's four set calls, each answering out of a table of its own and each writing
    ---down what it was asked about.
    ---
    ---Four separate deps rather than one lookup because the client separates them, and each
    ---refuses independently: a build will happily name the sets a source sits in and then
    ---decline to describe one of them, or list a set's pieces and refuse its name. Keying the
    ---fixtures by set id apart from each other is what lets a case model exactly one of those
    ---refusals without inventing a sentinel for "present but empty".
    ---
    ---The recordings matter as much as the answers. This is asked once per transmog row per
    ---repaint, so a lookup made before the cheap refusal is a cost paid on every frame the
    ---panel is on screen, and only a count of the calls can say it was not.
    ---`classes` and `armor` are the two the client may not have been wired at all, and they are
    ---withheld unless a case names them. That is not tidiness: a set is described one line
    ---shorter on a build without them, so a helper that always passed them would have quietly
    ---changed the answer to every case in this file that asserts a whole membership.
    ---@param options table? `{ containing = table<integer, integer[]>,
    ---info = table<integer, table>, pieces = table<integer, table[]>,
    ---shared = table<integer, integer[]>, classes = table<integer, string>,
    ---armor = table<integer, string> }`
    ---@return TransmogSets sets
    ---@return table asked `{ containing = integer[], info = integer[], pieces = integer[],
    ---shared = integer[], armor = integer[] }`
    local function newSets(options)
        options = options or {}
        local asked = { containing = {}, info = {}, pieces = {}, shared = {}, armor = {}, classes = {} }
        local sets = ns.newTransmogSets({
            setsContaining = function(sourceID)
                asked.containing[#asked.containing + 1] = sourceID
                return (options.containing or {})[sourceID]
            end,
            setInfo = function(setID)
                asked.info[#asked.info + 1] = setID
                -- Named by default, and only by default. Whether the client will name a set
                -- is what decides which of several a source is reported under, so a fixture
                -- that left the name out to say "this case is about counting" would silently
                -- have been saying "this set is skipped" instead. A case that cares says so
                -- by passing `info` and taking the naming into its own hands.
                if options.info == nil then
                    return { name = "Set " .. setID }
                end
                return options.info[setID]
            end,
            setPieces = function(setID)
                asked.pieces[#asked.pieces + 1] = setID
                return (options.pieces or {})[setID]
            end,
            sharedSources = function(sourceID)
                asked.shared[#asked.shared + 1] = sourceID
                -- A list of one by default, holding the source itself. The client's own
                -- answer always has it in there, and an item nothing else in the game shares
                -- a look with is the ordinary reading — so a case that says nothing about
                -- sharing gets the widening finding nothing rather than the widening being
                -- switched off. Nothing at all is a different answer, and it is one a case
                -- makes on purpose by passing `shared` and leaving the source out of it.
                if options.shared == nil then
                    return { sourceID }
                end
                return options.shared[sourceID]
            end,
            className = options.classes and function(classID)
                asked.classes[#asked.classes + 1] = classID
                return options.classes[classID]
            end or nil,
            -- Recorded as well as answered, because *which source* this is asked about is the
            -- whole of what the field means: the set may be tier plate and the item that
            -- dropped wearing its look a mail world drop, and only the call says which of the
            -- two the player was told about.
            armorType = options.armor and function(sourceID)
                asked.armor[#asked.armor + 1] = sourceID
                return options.armor[sourceID]
            end or nil,
        })
        return sets, asked
    end

    ---The classes the client will name, in its own id order, which is what a set's `classMask`
    ---is read against: bit n, counting from zero, is class id n + 1.
    ---
    ---Five real classes rather than thirteen, because what the decoding turns on is the bit
    ---position and how many classes the client will name *at all* — a mask covering every one
    ---of them is not a restriction — and five says both as plainly as thirteen would. Id 6 is
    ---left unnamed and id 7 named with an empty string, which are the two ways a live client
    ---declines an id: a row past the end of the roster, and one it has no localisation for.
    local CLASSES = {
        [1] = "Warrior", [2] = "Paladin", [3] = "Hunter", [4] = "Rogue", [5] = "Priest",
        [7] = "",
    }

    ---The bit a class id occupies in a `classMask`, so a fixture can say "Warrior and Paladin"
    ---rather than 3 and leave the reader to work out which it meant.
    ---@param ... integer class ids
    ---@return integer mask
    local function maskOf(...)
        local mask = 0
        for _, classID in ipairs({ ... }) do
            mask = mask + 2 ^ (classID - 1)
        end
        return mask
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
        -- that can only ever answer nothing — and so is asking it what else in the game wears
        -- the look of nothing, which is the road the widening would otherwise take on exactly
        -- these rows, every one of them having found no set to begin with.
        it("asks the client nothing at all when there is no source id to ask about", function()
            local sets, asked = newSets({ containing = { [SOURCE] = { SET } } })

            assert.is_nil(sets.forSource(nil))
            assert.same({}, asked.containing)
            assert.same({}, asked.shared)
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

        -- `TransmogSet` on 12.0.5 carries 5143 rows and 46 of them have no name in any locale.
        -- They are the table's own grouping scaffolding, they hold real sources, and they sort
        -- ahead of the real sets on every source that touches one — so taking the first id
        -- outright drew "Set 2 — 1/18" over Magister's Regalia, and drew a marker naming
        -- nothing on 635 further sources whose only set is one of those rows. A set the player
        -- cannot be shown in the collections journal is not one to tell them about, and the
        -- name is the only thing in the data that separates the two.
        for _, case in ipairs({
            { what = "named nothing at all", name = nil },
            { what = "named with an empty string", name = "" },
        }) do
            it("skips a set the client " .. case.what .. " in favour of the one behind it", function()
                local sets, asked = newSets({
                    containing = { [SOURCE] = { OTHER_SET, SET } },
                    info = {
                        [OTHER_SET] = { name = case.name },
                        [SET] = { name = "Magister's Regalia" },
                    },
                    pieces = {
                        [OTHER_SET] = { { sourceID = 999, collected = true } },
                        [SET] = eightPieces(),
                    },
                })

                local membership = sets.forSource(SOURCE)

                assert.equal(SET, membership.setID)
                assert.equal("Magister's Regalia", membership.name)
                assert.equal(8, membership.total)
                -- And the skipped set was never enumerated. Walking the pieces of a set that
                -- lost is a cost paid on every repaint for an answer thrown away.
                assert.same({ SET }, asked.pieces)
            end)
        end

        -- Nothing behind it to fall back to, which is the 635-source case: the marker is left
        -- off the row entirely rather than drawn against a set that cannot be named or opened.
        it("answers nothing when no set containing the source can be named", function()
            local sets, asked = newSets({
                containing = { [SOURCE] = { SET, OTHER_SET } },
                info = { [SET] = {}, [OTHER_SET] = nil },
                pieces = { [SET] = eightPieces() },
            })

            assert.is_nil(sets.forSource(SOURCE))
            assert.same({}, asked.pieces)
        end)

        -- The whole of what the widening is for. A set lists the exact item-modified-appearance
        -- rows it is made of, and several different items wear one look — so the world drop
        -- wearing a tier shoulder's look is in no set the client will name over it, while the
        -- wardrobe files it under the same appearance and credits the set for either. The piece
        -- counts and the sources are the *set's*, not the item's: what the player is being told
        -- is how far into Bloodfang Armor they are, and the dressing room is handed Bloodfang
        -- Armor to wear.
        it("reports the set that names another item wearing the same look", function()
            local sets = newSets({
                containing = { [SHARED] = { SET } },
                info = { [SET] = { name = "Bloodfang Armor", label = "Heroic" } },
                pieces = { [SET] = eightPieces() },
                shared = { [SOURCE] = { SOURCE, SHARED } },
            })

            assert.same({
                setID = SET,
                name = "Bloodfang Armor",
                label = "Heroic",
                collected = 3,
                total = 8,
                sources = { 101, 102, 103, 104, 105, 106, 107, 108 },
                sharedLook = true,
            }, sets.forSource(SOURCE))
        end)

        -- A piece the set itself lists is answered in the one lookup it always took, and that
        -- is what keeps the cost of the widening where it belongs: this is asked once per
        -- transmog row per repaint, and the list of everything wearing a look is a client call
        -- plus a set lookup for each item in it. Paid on the rows that need it and on no other.
        it("says nothing of a shared look, and asks nothing about one, for a piece its set names", function()
            local sets, asked = newSets({
                containing = { [SOURCE] = { SET } },
                pieces = { [SET] = eightPieces() },
            })

            assert.is_nil(sets.forSource(SOURCE).sharedLook)
            assert.same({}, asked.shared)
        end)

        -- The source is in its own shared list, because the client's answer is every item
        -- wearing the look and this item wears it. Asking it a second time is a lookup per row
        -- per repaint for an answer already known to be nothing.
        it("passes over the source itself rather than asking it a second time", function()
            local sets, asked = newSets({
                containing = { [SHARED] = { SET } },
                pieces = { [SET] = eightPieces() },
                shared = { [SOURCE] = { SOURCE, SHARED } },
            })

            assert.equal(SET, sets.forSource(SOURCE).setID)
            assert.same({ SOURCE, SHARED }, asked.containing)
        end)

        -- The same rule the source's own sets are chosen by, one step out: the client's order
        -- decides, because the row has space for one set and any other tie-break moves the line
        -- under the player as they collect. Two items wearing one look can each be in a set of
        -- their own — a tier shoulder and its recoloured dungeon twin — and the first the
        -- client lists is the one the panel speaks for.
        it("takes the first item wearing the look that is in a set the client named", function()
            local sets = newSets({
                containing = { [SHARED] = { SET }, [LATER_SHARED] = { OTHER_SET } },
                info = { [SET] = { name = "Bloodfang Armor" }, [OTHER_SET] = { name = "Nightslayer" } },
                pieces = { [SET] = eightPieces(), [OTHER_SET] = { { sourceID = 201, collected = true } } },
                shared = { [SOURCE] = { SOURCE, SHARED, LATER_SHARED } },
            })

            assert.equal("Bloodfang Armor", sets.forSource(SOURCE).name)
        end)

        -- And the naming rule reaches every item the look is worn by, not only the one that
        -- dropped. The 46 unnamed grouping rows sort ahead of the real sets wherever they turn
        -- up, so an item whose only set is one of them is exactly as much use to a player as an
        -- item in no set at all — and stopping at it would hide the real set behind it.
        it("passes over an item whose only set the client will not name for one behind it", function()
            local sets = newSets({
                containing = { [SHARED] = { OTHER_SET }, [LATER_SHARED] = { SET } },
                info = { [OTHER_SET] = { name = "" }, [SET] = { name = "Magister's Regalia" } },
                pieces = { [OTHER_SET] = { { sourceID = 999, collected = true } }, [SET] = eightPieces() },
                shared = { [SOURCE] = { SOURCE, SHARED, LATER_SHARED } },
            })

            local membership = sets.forSource(SOURCE)

            assert.equal(SET, membership.setID)
            assert.equal("Magister's Regalia", membership.name)
            assert.is_true(membership.sharedLook)
        end)

        -- "The source is in no set the client will name" is one state however it is arrived at:
        -- a source in no set at all, and a source whose every set is one of the unnamed grouping
        -- rows, are both a row with nothing to say about itself, and both are worth the look
        -- outwards. Stopping at the second would leave the widening off precisely the sources
        -- that touch the scaffolding rows, which is 635 of them.
        it("looks outwards when none of the source's own sets can be named either", function()
            local sets = newSets({
                containing = { [SOURCE] = { OTHER_SET }, [SHARED] = { SET } },
                info = { [OTHER_SET] = { name = "" }, [SET] = { name = "Bloodfang Armor" } },
                pieces = { [SET] = eightPieces() },
                shared = { [SOURCE] = { SOURCE, SHARED } },
            })

            local membership = sets.forSource(SOURCE)

            assert.equal(SET, membership.setID)
            assert.is_true(membership.sharedLook)
        end)

        -- Finding nothing is what the widening does nearly every time, and all three of these
        -- have to end as quietly as the narrow lookup did: most appearances belong to no set
        -- and are worn by nothing that does either. The client refusing to say what wears a
        -- look is the same answer by another road — an unresolved source, or a build with no
        -- row for it — and a row drawn over any of them would be a fraction of somebody else's
        -- set.
        for _, case in ipairs({
            {
                what = "no other item wearing the look is in a set either",
                shared = { SOURCE, SHARED },
            },
            {
                what = "the client would not say what else wears the look",
                shared = nil,
            },
            {
                what = "the client answered with an empty list of items wearing it",
                shared = {},
            },
        }) do
            it("answers nothing when " .. case.what, function()
                local sets = newSets({
                    containing = {},
                    info = { [SET] = { name = "Bloodfang Armor" } },
                    pieces = { [SET] = eightPieces() },
                    shared = case.shared and { [SOURCE] = case.shared } or {},
                })

                assert.is_nil(sets.forSource(SOURCE))
            end)
        end

        -- Who the thing is actually for, which is the question a player standing over a drop
        -- asks before "how far into the set am I": a mail wearer reading a plate set's
        -- fraction is reading somebody else's number. All three come off different calls —
        -- the armour off the item behind the appearance, the classes off the set's own mask,
        -- the faction off its row — and land together on one membership.
        it("says what the piece is made of and who the set is for", function()
            local sets = newSets({
                containing = { [SOURCE] = { SET } },
                info = {
                    [SET] = {
                        name = "Bloodfang Armor",
                        classMask = maskOf(1, 2),
                        requiredFaction = "Horde",
                    },
                },
                pieces = { [SET] = eightPieces() },
                classes = CLASSES,
                armor = { [SOURCE] = "Plate" },
            })

            assert.same({
                setID = SET,
                name = "Bloodfang Armor",
                collected = 3,
                total = 8,
                sources = { 101, 102, 103, 104, 105, 106, 107, 108 },
                armor = "Plate",
                -- In the client's own class order, which is the order the mask is written in
                -- and the order a player reads a class list in everywhere else in the game.
                classes = { "Warrior", "Paladin" },
                faction = "Horde",
            }, sets.forSource(SOURCE))
        end)

        -- The armour is the *dropped item's*, and this is the case that says so. The set was
        -- found through another item wearing the same look, so a reading taken off the set —
        -- or off the source that led to it — would tell a mail wearer they had just picked up
        -- plate. The one they are holding is the one they need to know about.
        it("reports the armour of the source asked about, not of the item the set named", function()
            local sets, asked = newSets({
                containing = { [SHARED] = { SET } },
                pieces = { [SET] = eightPieces() },
                shared = { [SOURCE] = { SOURCE, SHARED } },
                armor = { [SOURCE] = "Mail", [SHARED] = "Plate" },
            })

            assert.equal("Mail", sets.forSource(SOURCE).armor)
            assert.same({ SOURCE }, asked.armor)
        end)

        -- Most of what drops has no armour type at all — a cloak, a ring, every weapon in the
        -- game — and a build may not have been wired the lookup in the first place. Both are
        -- described by saying nothing, because a line reading "Armor —" is worse than no line.
        for _, case in ipairs({
            { what = "the client will not say what the item is made of", armor = {} },
            { what = "the build wired no armour lookup at all", armor = nil },
        }) do
            it("says nothing about armour when " .. case.what, function()
                local sets = newSets({
                    containing = { [SOURCE] = { SET } },
                    pieces = { [SET] = eightPieces() },
                    armor = case.armor,
                })

                assert.is_nil(sets.forSource(SOURCE).armor)
            end)
        end

        -- The mask is a bitfield and every one of these is a way of reading it wrong. An
        -- off-by-one in the bit position names the class next door — a plate set reported for
        -- paladins and hunters — which is exactly the kind of wrong a player believes.
        for _, case in ipairs({
            {
                what = "names the two classes a plate set is for",
                mask = maskOf(1, 2),
                classes = { "Warrior", "Paladin" },
            },
            -- The high bit of the roster, which is what catches a reader that stopped one id
            -- short or counted the bits from one.
            {
                what = "names the single class a set is locked to",
                mask = maskOf(5),
                classes = { "Priest" },
            },
            {
                what = "names classes either side of a gap in the mask",
                mask = maskOf(1, 3, 5),
                classes = { "Warrior", "Hunter", "Priest" },
            },
            -- A set anyone can wear is not a restriction, and the line would be on every
            -- cosmetic and holiday set in the game saying nothing at all.
            {
                what = "is silent about a set every class the client names can wear",
                mask = maskOf(1, 2, 3, 4, 5),
                classes = nil,
            },
            -- Ids the client will not name count for neither side of that comparison. A mask
            -- claiming one of them is still every class as far as a player is concerned, and
            -- an id counted into the total would turn "anyone" back into a restriction.
            {
                what = "is silent where the mask also claims an id the client will not name",
                mask = maskOf(1, 2, 3, 4, 5, 6, 7),
                classes = nil,
            },
            {
                what = "leaves an unnamed id out of the list it does draw",
                mask = maskOf(1, 2, 6),
                classes = { "Warrior", "Paladin" },
            },
            {
                what = "leaves out an id the client named with an empty string",
                mask = maskOf(1, 2, 7),
                classes = { "Warrior", "Paladin" },
            },
            -- Nothing the client will name is selected, so there is nobody to name. Reported
            -- as no restriction rather than as an empty list, which a tooltip would draw as a
            -- "Classes" line with nothing after it.
            {
                what = "has nothing to say where only unnamed ids are claimed",
                mask = maskOf(6, 7),
                classes = nil,
            },
            { what = "has nothing to say for an empty mask", mask = 0, classes = nil },
            { what = "has nothing to say where the set carries no mask", mask = nil, classes = nil },
        }) do
            it("decodes a class mask and " .. case.what, function()
                local sets = newSets({
                    containing = { [SOURCE] = { SET } },
                    info = { [SET] = { name = "Bloodfang Armor", classMask = case.mask } },
                    pieces = { [SET] = eightPieces() },
                    classes = CLASSES,
                })

                assert.same(case.classes, sets.forSource(SOURCE).classes)
            end)
        end

        -- The one answer in this module that is safe to remember, and the reason it is worth
        -- remembering: everything else here is asked again on every repaint because it moves,
        -- and the roster of classes the game has does not move while the client is running. Two
        -- rows drawn and redrawn is four calls to `forSource` and would be ninety-six lookups
        -- without this, for twenty-four facts. Asserted as the id walk itself rather than as a
        -- count, so a cache that remembered the wrong thing cannot pass.
        it("reads the roster of classes once however many sets it is asked about", function()
            local sets, asked = newSets({
                containing = { [SOURCE] = { SET }, [SHARED] = { OTHER_SET } },
                info = {
                    [SET] = { name = "Bloodfang Armor", classMask = maskOf(1, 2) },
                    [OTHER_SET] = { name = "Nightslayer Armor", classMask = maskOf(4) },
                },
                pieces = { [SET] = eightPieces(), [OTHER_SET] = eightPieces() },
                classes = CLASSES,
            })

            sets.forSource(SOURCE)
            sets.forSource(SHARED)
            sets.forSource(SOURCE)

            local walked = {}
            for classID = 1, 24 do
                walked[classID] = classID
            end
            assert.same(walked, asked.classes)
        end)

        -- Never read at all where there is nothing to read it with. A build wired no `className`
        -- must not pay the walk to discover that, on the first set or on any of them.
        it("does not go looking for a roster on a build that has none", function()
            local sets, asked = newSets({
                containing = { [SOURCE] = { SET } },
                info = { [SET] = { name = "Bloodfang Armor", classMask = maskOf(1, 2) } },
                pieces = { [SET] = eightPieces() },
            })

            sets.forSource(SOURCE)

            assert.same({}, asked.classes)
        end)

        -- A mask nobody can turn into names is a number, and a tooltip has no use for one. The
        -- set is described exactly as it was before classes were read at all.
        it("says nothing of classes on a build that will not name them", function()
            local sets = newSets({
                containing = { [SOURCE] = { SET } },
                info = { [SET] = { name = "Bloodfang Armor", classMask = maskOf(1, 2) } },
                pieces = { [SET] = eightPieces() },
            })

            assert.is_nil(sets.forSource(SOURCE).classes)
        end)

        -- The empty string is the client's own way of saying "either side", and it is the one
        -- that matters: nearly every set in the game carries it, so a reader that passed it
        -- through would draw "Faction →" with nothing after it on almost every tooltip.
        for _, case in ipairs({
            { what = "names the side that can collect it", required = "Alliance", faction = "Alliance" },
            { what = "is silent where the client answered an empty string", required = "", faction = nil },
            { what = "is silent where the set carries no faction at all", required = nil, faction = nil },
        }) do
            it("reads the required faction and " .. case.what, function()
                local sets = newSets({
                    containing = { [SOURCE] = { SET } },
                    info = { [SET] = { name = "Bloodfang Armor", requiredFaction = case.required } },
                    pieces = { [SET] = eightPieces() },
                })

                assert.same(case.faction, sets.forSource(SOURCE).faction)
            end)
        end

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

        -- The set is being named over an item the set does not list, and a player who knows
        -- Bloodfang Armor — and knows this world drop is not a piece of it — is otherwise being
        -- told something that looks plainly wrong. The line goes above the fraction because it
        -- is what the fraction has to be read in the light of, and under the qualifier because
        -- the qualifier is part of the set's name rather than a remark about this row.
        it("says the set wears the look on another item, between the qualifier and the fraction", function()
            assert.same({
                "Bloodfang Armor",
                "Heroic",
                "The set wears this look on another item",
                "Collected → 3 / 8",
                "",
                "Shift-click to try on the whole set",
                "Shift-right-click to open it in Collections",
            }, readable(ns.transmogSetTooltip(membership({ label = "Heroic", sharedLook = true }))))
        end)

        it("marks that as a remark about the row rather than as a figure", function()
            local content = ns.transmogSetTooltip(membership({ sharedLook = true }))

            assert.equal("note", lineSaying(content, "The set wears this look on another item").role)
        end)

        -- Left off every ordinary row, which is most of them. A piece the set itself lists is
        -- being described exactly as it is, and the line over one would be telling the player
        -- something untrue about a set they can see their own shoulder in.
        it("says nothing of another item for a piece the set names itself", function()
            local content = ns.transmogSetTooltip(membership())

            assert.is_nil(lineSaying(content, "The set wears this look on another item"))
        end)

        -- Who may wear it, above how far into it the account has got, because a fraction is a
        -- progress report and a progress report is only worth reading once the thing is yours
        -- to make progress on. Under the shared-look note, which is about this row rather than
        -- about the set. The whole tooltip is asserted rather than the three lines alone,
        -- because the order between them is the only thing here a reader could get wrong.
        it("says who the set is for between the shared-look note and the fraction", function()
            assert.same({
                "Bloodfang Armor",
                "Heroic",
                "The set wears this look on another item",
                "Armor → Plate",
                "Classes → Warrior, Paladin",
                "Faction → Horde",
                "Collected → 3 / 8",
                "",
                "Shift-click to try on the whole set",
                "Shift-right-click to open it in Collections",
            }, readable(ns.transmogSetTooltip(membership({
                label = "Heroic",
                sharedLook = true,
                armor = "Plate",
                classes = { "Warrior", "Paladin" },
                faction = "Horde",
            }))))
        end)

        -- One class is a lock and several are a list, and a tooltip that said "Classes →
        -- Priest" would read as a client that had lost the rest of them.
        for _, case in ipairs({
            { what = "one class alone", classes = { "Priest" }, left = "Class", other = "Classes" },
            {
                what = "the several a plate set is for",
                classes = { "Warrior", "Paladin" },
                left = "Classes",
                other = "Class",
                right = "Warrior, Paladin",
            },
        }) do
            it("labels the line for " .. case.what, function()
                local content = ns.transmogSetTooltip(membership({ classes = case.classes }))

                assert.equal(case.right or case.classes[1], lineSaying(content, case.left).right)
                assert.is_nil(lineSaying(content, case.other))
            end)
        end

        -- Facts about the set rather than figures the panel colours, which is what separates
        -- them from the fraction under them: "other" is the neutral role, and a class list
        -- drawn in the account's purple would read as a count of something.
        for _, case in ipairs({
            { what = "the armour", left = "Armor", overrides = { armor = "Plate" } },
            { what = "the class list", left = "Classes", overrides = { classes = { "Warrior", "Paladin" } } },
            { what = "the faction", left = "Faction", overrides = { faction = "Horde" } },
        }) do
            it("marks " .. case.what .. " as a plain fact about the set", function()
                local content = ns.transmogSetTooltip(membership(case.overrides))

                assert.equal("other", lineSaying(content, case.left).role)
            end)
        end

        -- Left off the great majority of sets, which restrict nobody: a cosmetic set anyone
        -- can wear on either side would otherwise carry three lines saying "anyone", and the
        -- fraction — the part worth hovering for — would be three lines further down.
        for _, case in ipairs({
            { what = "an armour line for a set with no material", left = "Armor" },
            { what = "a class line for a set every class can wear", left = "Classes" },
            { what = "a singular class line either", left = "Class" },
            { what = "a faction line for a set both sides can collect", left = "Faction" },
        }) do
            it("draws no " .. case.what, function()
                assert.is_nil(lineSaying(ns.transmogSetTooltip(membership()), case.left))
            end)
        end

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
