local loader = require("addon_loader")

describe("segment views", function()
    local ns = loader.load()

    local CHARACTER = "Main-Ravencrest"
    -- The open segment began half an hour before the clock these tests read. The evening
    -- reaches back from that start, so a finished segment is inside it or outside it
    -- depending on how long a silence it left before OPENED.
    local OPENED = 1700000000
    local NOW = OPENED + 120
    -- The silence that ends an evening, mirroring the desktop app's SESSION_GAP_SECONDS.
    local GAP = 300

    ---A SegmentSummary with every field the panel reads, all at rest. Deliberately zeroed
    ---rather than absent: this is what the tally hands over for a segment nothing happened
    ---in, and it is what a merge of nothing has to come back looking like.
    ---@param overrides table?
    ---@return SegmentSummary
    local function summary(overrides)
        local base = {
            active = false,
            lootValue = 0,
            goldLooted = 0,
            itemValue = 0,
            goldDiff = 0,
            transmogs = {},
            currencyTotal = 0,
            currencies = {},
            reputationTotal = 0,
            reputation = {},
            achievements = {},
            levelUps = {},
            mounts = {},
            pets = {},
            quests = {},
            toys = {},
            housingItems = {},
            housingXP = 0,
            housingLevelUps = {},
            encounters = {},
            equipsetChanges = {},
        }
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        return base
    end

    ---A filed record, which is summary-shaped already plus the few fields the log adds.
    ---That is the whole reason the panel can draw one: nothing has to convert it.
    ---
    ---A test places one by when it ended, because that is the end the evening chains
    ---across; unless it says otherwise the segment ran for five minutes before that, which
    ---is long enough that two placed a few minutes apart chain into one evening.
    ---@param overrides table?
    ---@return SegmentRecord
    local function record(overrides)
        local base = summary({
            id = "segment",
            character = CHARACTER,
            instance = "Deadmines",
            endedAt = OPENED - 60,
        })
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        base.startedAt = base.startedAt or (base.endedAt - 300)
        return base
    end

    ---Build the views with hand-written deps: no frames, no panel, just the module and
    ---the six seams it reads the world through.
    ---
    ---The options table itself is kept by reference rather than read once, so a test can file
    ---a new segment into `options.segments`, or move `options.opened` onto the segment that
    ---just started, half way through and watch what that does to the selection — which is
    ---exactly what the game does while the panel is open. `options.live` is the exception: it
    ---is the tally, and the tally is one object that mutates rather than one that is replaced.
    ---@param options table? `{ live, location, opened, segments, character, now }`
    ---@return SegmentViews views, table counted `{ liveSummary = integer }`
    local function newViews(options)
        options = options or {}
        local live = options.live or summary()
        local segments = options.segments or {}
        local counted = { liveSummary = 0 }
        local views = ns.newSegmentViews({
            liveSummary = function()
                counted.liveSummary = counted.liveSummary + 1
                return live
            end,
            liveLocation = function()
                return options.location
            end,
            segments = function()
                return segments
            end,
            character = function()
                return options.character or CHARACTER
            end,
            liveStart = function()
                if options.opened == false then
                    return nil
                end
                return options.opened or OPENED
            end,
            now = function()
                return options.now or NOW
            end,
        })
        return views, counted
    end

    ---@param views SegmentView[]
    ---@return string[] the title of each, in the order they are offered
    local function titlesOf(views)
        local titles = {}
        for index, view in ipairs(views) do
            titles[index] = view.title
        end
        return titles
    end

    ---@param views SegmentView[]
    ---@return string[] the key of each, in the order they are offered
    local function keysOf(views)
        local keys = {}
        for index, view in ipairs(views) do
            keys[index] = view.key
        end
        return keys
    end

    ---@param views SegmentView[]
    ---@return string[] what the picker calls each, in the order they are offered
    local function labelsOf(views)
        local labels = {}
        for index, view in ipairs(views) do
            labels[index] = view.label
        end
        return labels
    end

    ---@param views SegmentView[]
    ---@return string[] the metadata beside each label, in the order they are offered
    local function detailsOf(views)
        local details = {}
        for index, view in ipairs(views) do
            details[index] = view.detail
        end
        return details
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.mergeSegmentSummaries)
        assert.is_function(ns.newSegmentViews)
    end)

    describe("adding a run of segments up", function()
        for _, field in ipairs({ "lootValue", "goldLooted", "itemValue", "goldDiff", "housingXP" }) do
            it("adds " .. field .. " up across the run", function()
                local merged = ns.mergeSegmentSummaries({
                    summary({ [field] = 30 }),
                    summary({ [field] = 12 }),
                })

                assert.equal(42, merged[field])
            end)
        end

        -- Summaries arrive oldest first and every list is concatenated in that order, so
        -- what is under a heading reads forward in time rather than in filing order.
        for _, key in ipairs({
            "transmogs", "achievements", "levelUps", "mounts", "pets", "quests", "toys",
            "housingItems", "housingLevelUps", "encounters", "equipsetChanges",
        }) do
            it("reads " .. key .. " forward in time", function()
                local merged = ns.mergeSegmentSummaries({
                    summary({ [key] = { { at = 10 } } }),
                    summary({ [key] = { { at = 20 }, { at = 30 } } }),
                })

                assert.same({ { at = 10 }, { at = 20 }, { at = 30 } }, merged[key])
            end)
        end

        it("folds two segments' worth of one currency into a single line", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ currencyTotal = 300, currencies = {
                    { id = 1792, name = "Honor", amount = 300, total = 1200 },
                } }),
                summary({ currencyTotal = 400, currencies = {
                    { id = 1792, name = "Honor", amount = 400, total = 1600 },
                } }),
            })

            -- The holding the last change landed on, not the sum of two balances.
            assert.same({ { id = 1792, name = "Honor", amount = 700, total = 1600 } }, merged.currencies)
            assert.equal(700, merged.currencyTotal)
        end)

        -- An item-based currency is keyed by item ID and a real one by currency type, and
        -- those are separate namespaces that land on the same number often enough. Folding
        -- on the id alone would add a bag of tokens into an unrelated currency's line.
        it("keeps two currencies that share a number but not a name apart", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ currencies = { { id = 1792, name = "Honor", amount = 300 } } }),
                summary({ currencies = { { id = 1792, name = "Bloody Token", amount = 5 } } }),
            })

            assert.equal(2, #merged.currencies)
            assert.equal(305, merged.currencyTotal)
        end)

        it("sorts the folded currencies by name, the way one segment's summary is", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ currencies = { { id = 3, name = "Valorstones", amount = 1 } } }),
                summary({ currencies = { { id = 1, name = "Honor", amount = 1 } } }),
                summary({ currencies = { { id = 2, name = "Resonance Crystals", amount = 1 } } }),
            })

            local names = {}
            for index, gain in ipairs(merged.currencies) do
                names[index] = gain.name
            end
            assert.same({ "Honor", "Resonance Crystals", "Valorstones" }, names)
        end)

        it("folds a faction gained in two segments into one line", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ reputationTotal = 250, reputation = {
                    { faction = "Dream Wardens", amount = 250 },
                } }),
                summary({ reputationTotal = 150, reputation = {
                    { faction = "Dream Wardens", amount = 150 },
                } }),
            })

            assert.equal(400, merged.reputation[1].amount)
            assert.equal(400, merged.reputationTotal)
        end)

        -- A standing is a position rather than something that happened, so it is the last
        -- one reported that is still true. Adding two standings up would be meaningless.
        it("ends on the standing the latest segment reported", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ reputation = { {
                    faction = "Dream Wardens", amount = 250,
                    standing = "Renown 8", current = 500, max = 2500, rank = 8, system = "renown",
                } } }),
                summary({ reputation = { {
                    faction = "Dream Wardens", amount = 150,
                    standing = "Renown 9", current = 150, max = 2500, rank = 9, system = "renown",
                } } }),
            })

            assert.same({ {
                faction = "Dream Wardens", amount = 400,
                standing = "Renown 9", current = 150, max = 2500, rank = 9, system = "renown",
            } }, merged.reputation)
        end)

        -- A gain parsed out of chat for a faction the client would not place carries no
        -- standing at all, and it must not knock out the one an earlier segment did place.
        it("leaves a standing alone when a later segment could not place the faction", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ reputation = { {
                    faction = "Dream Wardens", amount = 250,
                    standing = "Renown 8", current = 500, max = 2500, rank = 8, system = "renown",
                } } }),
                summary({ reputation = { { faction = "Dream Wardens", amount = 150 } } }),
            })

            assert.equal("Renown 8", merged.reputation[1].standing)
            assert.equal(400, merged.reputation[1].amount)
        end)

        it("sorts the folded factions by name, the way one segment's summary is", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ reputation = { { faction = "Timbermaw Hold", amount = 1 } } }),
                summary({ reputation = { { faction = "Argent Dawn", amount = 1 } } }),
            })

            assert.equal("Argent Dawn", merged.reputation[1].faction)
            assert.equal("Timbermaw Hold", merged.reputation[2].faction)
        end)

        it("adds experience up between the level it started on and the one it ended on", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ experience = { gained = 4000, percent = 0.5, startLevel = 70, endLevel = 70 } }),
                summary({ experience = { gained = 2000, percent = 0.25, startLevel = 70, endLevel = 71 } }),
            })

            assert.same({ gained = 6000, percent = 0.75, startLevel = 70, endLevel = 71 }, merged.experience)
        end)

        -- A keystone run is one per segment and a session holds as many as the player did,
        -- so there is no single run to report and the shape has room for exactly one.
        it("carries no keystone off a session that ran one", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ keystone = { level = 12, mapId = 375, completed = true } }),
            })

            assert.is_nil(merged.keystone)
        end)

        -- The wallet is a balance rather than something that happened, so the last one seen
        -- is the only one still true; summing them would report money nobody ever held.
        it("reports the wallet the session ended on rather than a sum of balances", function()
            local merged = ns.mergeSegmentSummaries({
                summary({ wallet = 12000 }),
                summary({ wallet = 9500 }),
            })

            assert.equal(9500, merged.wallet)
        end)

        -- The session view is rebuilt on every repaint out of tables the log and the tally
        -- still own. Sharing one would let the panel's own bookkeeping reach back into a
        -- filed record, which is what ns.copyEventList is in the merge for.
        it("shares no event table with the summaries it was built from", function()
            local event = { id = 19019, at = 5 }
            local merged = ns.mergeSegmentSummaries({ summary({ transmogs = { event } }) })

            merged.transmogs[1].id = 1

            assert.equal(19019, event.id)
        end)

        it("shares no currency or reputation table with the summaries it was built from", function()
            local gain = { id = 1792, name = "Honor", amount = 300 }
            local faction = { faction = "Dream Wardens", amount = 250 }
            local merged = ns.mergeSegmentSummaries({
                summary({ currencies = { gain }, reputation = { faction } }),
            })

            merged.currencies[1].amount = 0
            merged.reputation[1].amount = 0

            assert.equal(300, gain.amount)
            assert.equal(250, faction.amount)
        end)

        for _, case in ipairs({
            { what = "a session nobody has played a segment of yet", summaries = {} },
            { what = "one segment that saw nothing at all", summaries = { summary() } },
            { what = "a summary that carries none of the fields", summaries = { {} } },
        }) do
            it("answers a zeroed summary for " .. case.what, function()
                local merged = ns.mergeSegmentSummaries(case.summaries)

                assert.equal(0, merged.lootValue)
                assert.equal(0, merged.goldDiff)
                assert.equal(0, merged.housingXP)
                assert.equal(0, merged.currencyTotal)
                assert.equal(0, merged.reputationTotal)
                assert.same({}, merged.currencies)
                assert.same({}, merged.reputation)
                assert.same({}, merged.transmogs)
                assert.is_nil(merged.experience)
            end)
        end
    end)

    describe("everything the panel can be pointed at", function()
        -- What somebody glancing at a HUD is asking about is what is happening now, so that
        -- is where the panel opens; the session total is one row of the menu away rather
        -- than in front.
        it("opens on the segment being played rather than on the session total", function()
            local views = newViews({
                location = "Deadmines",
                segments = { record({ id = "a" }) },
            })

            assert.equal("live", views.selected().kind)
        end)

        -- The session is the separate question and sits on top of the menu on its own. Under
        -- it the evening runs in the order it happened: the oldest segment first and the one
        -- being played last, so the row at the bottom of the list is where the player is now.
        it("runs the session total, then the finished segments oldest first, then the open one", function()
            local views = newViews({
                location = "Wailing Caverns",
                segments = {
                    record({ id = "newer", instance = "Deadmines", endedAt = OPENED - 60 }),
                    record({ id = "older", instance = "Stockade", endedAt = OPENED - 420 }),
                },
            })

            local listed = views.list()

            local kinds = {}
            for index, view in ipairs(listed) do
                kinds[index] = view.kind
            end
            assert.same({ "session", "record", "record", "live" }, kinds)
            assert.same({
                "Session · 3 segments", "Stockade · 9m ago", "Deadmines · 3m ago", "Wailing Caverns",
            }, titlesOf(listed))
        end)

        -- An evening survives hopping alts — that is the app's own rule for what a session
        -- is — so the dungeon run that happened on the alt before this character logged in
        -- is part of it. It says whose it was, or it would read as somewhere this character
        -- has been.
        it("keeps an alt's segments on the list, and says whose they were", function()
            local views = newViews({
                segments = {
                    record({ id = "mine", instance = "Stockade", endedAt = OPENED - 60 }),
                    record({ id = "theirs", instance = "Deadmines", endedAt = OPENED - 420,
                        character = "Alt-Ravencrest" }),
                },
            })

            local listed = views.list()

            assert.equal(4, #listed)
            assert.equal("Alt — Deadmines · 9m ago", listed[2].title)
            assert.equal("Stockade · 3m ago", listed[3].title)
        end)

        -- An evening is what the desktop app says it is: segments chained across silences of
        -- no more than five minutes. The log keeps a week of history and the rest of it —
        -- last night's raid, this morning's dailies — belongs to other evenings.
        for _, case in ipairs({
            { what = "ended as the open one began", endedAt = OPENED, listed = true },
            { what = "left exactly five minutes of silence", endedAt = OPENED - GAP, listed = true },
            { what = "left a second more than five minutes", endedAt = OPENED - GAP - 1, listed = false },
            { what = "was played last night", endedAt = OPENED - 86400, listed = false },
        }) do
            it("puts a segment that " .. case.what .. (case.listed and " on the list" or " nowhere"), function()
                local views = newViews({ segments = { record({ id = "a", endedAt = case.endedAt }) } })

                assert.equal(case.listed and 3 or 2, #views.list())
            end)
        end

        -- The walk chains: each segment is measured against how far back the evening has
        -- already reached, not against the open segment, so an evening of short runs stays
        -- whole however long it has been going on.
        it("chains back through an evening far older than five minutes", function()
            local views = newViews({
                segments = {
                    record({ id = "third", endedAt = OPENED - 60 }),
                    record({ id = "second", endedAt = OPENED - 420 }),
                    record({ id = "first", endedAt = OPENED - 780 }),
                },
            })

            assert.equal(5, #views.list())
        end)

        -- And a silence in the middle of it ends the walk: nothing beyond the break belongs
        -- to this evening, however close together the segments on the far side of it are.
        it("stops at the first silence, and does not reach past it", function()
            local views = newViews({
                segments = {
                    record({ id = "tonight", endedAt = OPENED - 60 }),
                    record({ id = "earlier", endedAt = OPENED - 3600 }),
                    record({ id = "earlier still", endedAt = OPENED - 3900 }),
                },
            })

            assert.equal(3, #views.list())
        end)

        -- The list grows underneath the selection: a segment closing pushes every later one
        -- along by a place. Holding the choice as a position would silently move the panel
        -- onto a different segment than the player parked it on.
        it("stays on the segment it was showing when a newer one is filed", function()
            local segments = { record({ id = "a", instance = "Deadmines", endedAt = OPENED - 120 }) }
            local views = newViews({ segments = segments })
            assert.equal("record:a", views.select("record:a").key)

            table.insert(segments, 1, record({ id = "b", instance = "Stockade", endedAt = OPENED - 60 }))

            assert.equal("record:a", views.selected().key)
            -- The session, the one being looked at, the segment just filed, then the open one.
            assert.same({ "session", "record:a", "record:b", "live" }, keysOf(views.list()))
        end)

        -- A record pruned out of the log, or a character switch that emptied the session,
        -- leaves the panel standing on nothing. The open segment is the one view that always
        -- exists, so that is where it lands.
        it("falls back to the open segment when the one it was showing is gone", function()
            local segments = { record({ id = "a" }) }
            local views = newViews({ segments = segments })
            assert.equal("record:a", views.select("record:a").key)

            segments[1] = nil

            assert.equal("live", views.selected().kind)
        end)

        describe("what the header says", function()
            -- The open segment counts as one of them: the total on screen includes it, so a
            -- header claiming two while adding up three would be lying about its own number.
            for _, case in ipairs({
                { finished = 0, title = "Session · 1 segment" },
                { finished = 1, title = "Session · 2 segments" },
                { finished = 2, title = "Session · 3 segments" },
            }) do
                it("counts the open segment into " .. case.title, function()
                    local segments = {}
                    for index = 1, case.finished do
                        segments[index] = record({ id = "a" .. index, endedAt = OPENED - index * 60 })
                    end
                    local views = newViews({ segments = segments })

                    assert.equal(case.title, views.select("session").title)
                end)
            end

            it("names the open segment after where it is being played", function()
                local views = newViews({ location = "Wailing Caverns" })

                assert.equal("Wailing Caverns", views.selected().title)
            end)

            -- Between two zones, or before the first loading screen, there is no open segment
            -- and nothing to name it after.
            it("says Current Segment while no segment is open", function()
                local views = newViews({ location = nil })

                assert.equal("Current Segment", views.selected().title)
            end)

            -- formatAge answers "now" for anything inside the last minute, which is a fine
            -- staleness warning and a poor label: a segment that just closed sits one row above
            -- the one being played, and "Deadmines · now" beside "Deadmines" is not a
            -- difference anybody can see.
            for _, case in ipairs({
                { what = "twelve minutes ago", endedAt = NOW - 720, title = "Deadmines · 12m ago" },
                { what = "half a minute ago", endedAt = NOW - 30, title = "Deadmines · just now" },
                { what = "three hours ago", endedAt = NOW - 10800, title = "Deadmines · 3h ago" },
            }) do
                it("dates a segment that closed " .. case.what, function()
                    local views = newViews({
                        segments = { record({ id = "a", instance = "Deadmines", endedAt = case.endedAt }) },
                        -- The open segment picked up where that one left off, so however long
                        -- ago it closed, it is still this evening — a player can stand in one
                        -- zone for three hours.
                        opened = case.endedAt + 30,
                    })

                    assert.equal(case.title, views.select("record:a").title)
                end)
            end
        end)

        describe("what the picker calls each view", function()
            -- The header has one line and has to both name a view and place it in time, which
            -- is why it reads "Deadmines · 12m ago". A menu row has two columns, so the name
            -- goes in one and everything that tells two runs of the same dungeon apart goes in
            -- the other — and the two halves have to be separable to be laid out that way.
            it("splits the header's one line into a name and the metadata beside it", function()
                local views = newViews({
                    location = "Wailing Caverns",
                    segments = { record({ id = "a", instance = "Deadmines", endedAt = OPENED - 60 }) },
                })

                local listed = views.list()

                assert.same({ "Session", "Deadmines", "Wailing Caverns" }, labelsOf(listed))
                assert.same({ "2 segments", "5m · 3m ago", "2m · playing" }, detailsOf(listed))
            end)

            -- The open segment counts as one of them, the same as it does in the header: a
            -- menu offering "1 segment" beside two rows of segments would be contradicting
            -- itself on one line.
            for _, case in ipairs({
                { finished = 0, detail = "1 segment" },
                { finished = 1, detail = "2 segments" },
                { finished = 2, detail = "3 segments" },
            }) do
                it("counts the open segment into the session's " .. case.detail, function()
                    local segments = {}
                    for index = 1, case.finished do
                        segments[index] = record({ id = "a" .. index, endedAt = OPENED - index * 60 })
                    end
                    local views = newViews({ segments = segments })

                    assert.equal(case.detail, views.select("session").detail)
                end)
            end

            -- Rounded down to one unit, the same as the age beside it and for the same reason:
            -- this is a label on a menu row rather than a stopwatch, and "42m" is all it takes
            -- to tell one evening's Deadmines run from the other. Anything under a minute is
            -- "<1m" rather than "0m", because a zone walked straight through is a real thing to
            -- find on the list and "0m" reads as the module not knowing.
            for _, case in ipairs({
                { what = "a zone walked straight through", ran = 0, lasted = "<1m" },
                { what = "a second short of a minute", ran = 59, lasted = "<1m" },
                { what = "a minute exactly", ran = 60, lasted = "1m" },
                { what = "a second short of an hour", ran = 3599, lasted = "59m" },
                { what = "an hour exactly", ran = 3600, lasted = "1h" },
                { what = "a whole evening in one zone", ran = 4 * 3600, lasted = "4h" },
            }) do
                it("says a segment that has run for " .. case.what .. " lasted " .. case.lasted, function()
                    local views = newViews({ opened = NOW - case.ran })

                    assert.equal(case.lasted .. " · playing", views.selected().detail)
                end)
            end

            -- Between two zones, or before the first loading screen, there is no open segment
            -- to have been running for any length of time. The row still has to exist, because
            -- it is what the panel comes back to; it simply has no duration to report.
            it("says only that it is playing while no segment is open", function()
                local views = newViews({ opened = false })

                local view = views.selected()

                assert.equal("Current Segment", view.label)
                assert.equal("playing", view.detail)
            end)

            -- An evening survives hopping alts, so the list holds the alt's segments too, and
            -- one of those has to say whose it was or it reads as somewhere this character has
            -- been. Only the first name: the realm is this evening's either way.
            it("puts an alt's name in front of the place, and this character's nowhere", function()
                local views = newViews({
                    segments = {
                        record({ id = "mine", instance = "Stockade", endedAt = OPENED - 60 }),
                        record({ id = "theirs", instance = "Deadmines", endedAt = OPENED - 420,
                            character = "Alt-Ravencrest" }),
                    },
                })

                local listed = views.list()

                assert.equal("Alt — Deadmines", listed[2].label)
                assert.equal("Stockade", listed[3].label)
            end)

            -- The same reasoning the header's own dates were given: "now" is a fine staleness
            -- warning and a poor label, because a segment that just closed sits one row from
            -- the one being played.
            it("dates a segment that closed inside the last minute as just now", function()
                local views = newViews({
                    segments = { record({ id = "a", endedAt = NOW - 30 }) },
                    opened = NOW - 30,
                })

                assert.equal("5m · just now", views.select("record:a").detail)
            end)
        end)

        describe("what each view is drawn from", function()
            it("adds the running tally into the session total as well as the filed segments", function()
                local views = newViews({
                    live = summary({ lootValue = 5 }),
                    segments = {
                        record({ id = "newer", lootValue = 20, endedAt = OPENED - 60 }),
                        record({ id = "older", lootValue = 100, endedAt = OPENED - 420 }),
                    },
                })

                assert.equal(125, views.select("session").summary.lootValue)
            end)

            it("reads the session's events forward in time, ending on what is happening now", function()
                local views = newViews({
                    live = summary({ levelUps = { { level = 72, at = NOW } } }),
                    segments = {
                        record({ id = "newer", endedAt = OPENED - 60,
                            levelUps = { { level = 71, at = OPENED - 120 } } }),
                        record({ id = "older", endedAt = OPENED - 420,
                            levelUps = { { level = 70, at = OPENED - 500 } } }),
                    },
                })

                local levels = {}
                for index, event in ipairs(views.select("session").summary.levelUps) do
                    levels[index] = event.level
                end
                assert.same({ 70, 71, 72 }, levels)
            end)

            -- Adding a whole session up on every loot line, to draw a panel showing one
            -- segment, is work nobody asked for. The open segment's view is the tally itself
            -- rather than anything built out of it, which is what proves nothing was added up.
            it("hands the running tally straight through when that is the view on screen", function()
                local live = summary({ lootValue = 5 })
                local views = newViews({
                    live = live,
                    segments = { record({ id = "a", lootValue = 100 }) },
                })

                assert.equal(live, views.selected().summary)
            end)

            -- Same again from the other end: a filed record is summary-shaped already, so it
            -- is handed over as it stands rather than copied into something new.
            it("hands a filed record straight through, and never asks what is happening now", function()
                local filed = record({ id = "a", lootValue = 100 })
                local views, counted = newViews({ segments = { filed } })

                assert.equal(filed, views.select("record:a").summary)
                assert.equal(0, counted.liveSummary)
            end)

            it("leaves no record field behind on the view it hands back", function()
                local views = newViews({ segments = { record({ id = "a" }) } })

                assert.is_nil(views.select("record:a").record)
            end)
        end)
    end)

    describe("the list the picker draws", function()
        -- Everything on offer at once, in the order the panel itself holds them, so the menu
        -- and the panel can never disagree about what the evening holds or which end of it
        -- is now.
        it("hands over every view, in the order the panel holds them", function()
            local views = newViews({
                location = "Wailing Caverns",
                segments = {
                    record({ id = "newer", instance = "Deadmines", endedAt = OPENED - 60 }),
                    record({ id = "older", instance = "Stockade", endedAt = OPENED - 420 }),
                },
            })

            local listed = views.list()

            assert.same({ "session", "record:older", "record:newer", "live" }, keysOf(listed))
            assert.same({ "Session", "Stockade", "Deadmines", "Wailing Caverns" }, labelsOf(listed))
        end)

        -- The menu's whole job is to say which of them is on screen: a list that named the
        -- same three things whatever was being looked at would leave the player clicking the
        -- row they are already standing on.
        for _, case in ipairs({
            { what = "the session total", key = "session", current = { true, false, false } },
            { what = "a segment already filed", key = "record:a", current = { false, true, false } },
            { what = "the segment being played", key = "live", current = { false, false, true } },
        }) do
            it("ticks " .. case.what .. " while that is the view on screen", function()
                local views = newViews({ segments = { record({ id = "a" }) } })
                views.select(case.key)

                local ticked = {}
                for index, view in ipairs(views.list()) do
                    ticked[index] = view.current
                end
                assert.same(case.current, ticked)
            end)
        end

        -- A menu of five segments that materialised every row would add the whole evening up
        -- five times over to print five names. The list says what is on offer; the one view
        -- that is actually going to be drawn is the only one worth the arithmetic.
        it("names the views without adding a single one of them up", function()
            local views, counted = newViews({
                segments = {
                    record({ id = "newer", endedAt = OPENED - 60 }),
                    record({ id = "older", endedAt = OPENED - 420 }),
                },
            })

            local listed = views.list()

            assert.equal(4, #listed)
            for _, view in ipairs(listed) do
                assert.is_nil(view.summary)
            end
            assert.equal(0, counted.liveSummary)
        end)

        it("leaves no record field behind on the views it hands back", function()
            local views = newViews({ segments = { record({ id = "a" }) } })

            for _, view in ipairs(views.list()) do
                assert.is_nil(view.record)
            end
        end)

        -- Reading the menu is not choosing from it. A player who opens the list, thinks better
        -- of it and closes it again is looking at the same panel they were before.
        it("leaves the panel standing where it was", function()
            local views = newViews({ segments = { record({ id = "a" }) } })
            assert.equal("record:a", views.select("record:a").key)

            views.list()

            assert.equal("record:a", views.selected().key)
        end)
    end)

    describe("standing on a view by name", function()
        -- Held by name rather than by position, because the list grows underneath the menu
        -- and a row clicked a moment after a segment closed would otherwise land on its
        -- neighbour.
        it("stands on the session total, and adds it up on the way", function()
            local views = newViews({
                live = summary({ lootValue = 5 }),
                segments = { record({ id = "a", lootValue = 100, endedAt = OPENED - 60 }) },
            })

            local view = views.select("session")

            assert.equal("session", view.kind)
            assert.equal(105, view.summary.lootValue)
        end)

        it("stands on a filed segment, and hands the record straight through", function()
            local filed = record({ id = "a", lootValue = 100 })
            local views = newViews({ segments = { filed } })

            assert.equal(filed, views.select("record:a").summary)
        end)

        it("leaves the panel there afterwards", function()
            local views = newViews({ segments = { record({ id = "a" }) } })

            views.select("record:a")

            assert.equal("record:a", views.selected().key)
        end)

        -- A menu row is drawn from a list that was read a moment ago, and a segment can fall
        -- out of the evening between the list being drawn and a row on it being clicked.
        -- Standing on nothing is worse than standing where the player already was.
        it("leaves the panel where it is when the key names nothing on the list", function()
            local views = newViews({ segments = { record({ id = "a" }) } })
            views.select("record:a")

            local view = views.select("record:pruned")

            assert.equal("record:a", view.key)
            assert.equal("record:a", views.selected().key)
        end)
    end)

    describe("following the segment that just opened", function()
        ---The evening with one filed segment close enough behind the open one that moving the
        ---open one forward two minutes cannot push it out of the evening. Handed back as the
        ---options table itself, so a test can move `opened` the way a loading screen does.
        ---@return table options
        local function evening()
            return { segments = { record({ id = "a", endedAt = OPENED - 60 }) } }
        end

        -- A segment opening pulls the panel forward onto it, the way a damage meter jumps to
        -- the pull that just started. A player parked on a dungeon that finished twenty
        -- minutes ago is looking at history, and history is not what a HUD is for once
        -- something new is happening.
        it("pulls the panel off a filed segment when a new one opens", function()
            local options = evening()
            local views = newViews(options)
            assert.equal("record:a", views.select("record:a").key)

            options.opened = OPENED + 120

            assert.equal("live", views.selected().kind)
            -- And the segment it was parked on is still on the list: the panel moved because
            -- something new opened, not because the view under it was pruned away.
            assert.same({ "session", "record:a", "live" }, keysOf(views.list()))
        end)

        -- The session total is the exception to that. Parking there is a deliberate "show me
        -- the evening", and the evening is still the evening after a loading screen.
        it("leaves the panel on the session total when a new segment opens", function()
            local options = evening()
            local views = newViews(options)
            assert.equal("session", views.select("session").kind)

            options.opened = OPENED + 120

            assert.equal("session", views.selected().kind)
        end)

        -- Every repaint asks, and a panel that moved on every repaint would be unusable: only
        -- a start that is not the one already seen counts as somewhere new.
        it("leaves the panel alone while the same segment is still being played", function()
            local views = newViews(evening())
            assert.equal("record:a", views.select("record:a").key)

            assert.equal("record:a", views.selected().key)
            assert.equal("record:a", views.selected().key)
        end)

        -- Between one segment closing and the next opening there is no open segment at all —
        -- a loading screen, a flight path, the walk back out of a dungeon — and that gap is
        -- not a change of its own. The next start is compared against the last one actually
        -- seen, so closing and reopening counts once rather than twice.
        it("treats a gap with nothing open as no change, and the reopen as the one change", function()
            local options = evening()
            local views = newViews(options)
            assert.equal("record:a", views.select("record:a").key)

            options.opened = false
            assert.equal("record:a", views.selected().key)

            options.opened = OPENED + 120
            assert.equal("live", views.selected().kind)
        end)
    end)
end)
