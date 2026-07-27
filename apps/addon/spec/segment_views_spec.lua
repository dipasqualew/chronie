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

    ---Build the strip with hand-written deps: no frames, no panel, just the module and
    ---the six seams it reads the world through.
    ---
    ---`options.segments` is kept by reference rather than copied, so a test can file a new
    ---segment into it half way through and watch what that does to the selection — which is
    ---exactly what the game does while the panel is open.
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

    ---Every view on the strip, in order. The module only ever hands out the one being
    ---stood on, so walking from the far end is the only way to see the whole shape — which
    ---is also the only way a player sees it.
    ---@param views SegmentViews
    ---@return SegmentView[]
    local function walk(views)
        -- Far enough back to clamp against the session total whatever the strip holds.
        local view = views.move(-99)
        local seen = { view }
        while view.index < view.count do
            view = views.move(1)
            seen[#seen + 1] = view
        end
        return seen
    end

    ---@param views SegmentView[]
    ---@return string[] the title of each, in strip order
    local function titlesOf(views)
        local titles = {}
        for index, view in ipairs(views) do
            titles[index] = view.title
        end
        return titles
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

    describe("the strip the arrows walk", function()
        -- What somebody glancing at a HUD is asking about is what is happening now, so that
        -- is where the panel opens; the session total is one arrow away rather than in front.
        it("opens on the segment being played rather than on the session total", function()
            local views = newViews({
                location = "Deadmines",
                segments = { record({ id = "a" }) },
            })

            assert.equal("live", views.selected().kind)
        end)

        it("runs the session total, then the open segment, then the finished ones newest first", function()
            local views = newViews({
                location = "Wailing Caverns",
                segments = {
                    record({ id = "newer", instance = "Deadmines", endedAt = OPENED - 60 }),
                    record({ id = "older", instance = "Stockade", endedAt = OPENED - 420 }),
                },
            })

            local strip = walk(views)

            local kinds = {}
            for index, view in ipairs(strip) do
                kinds[index] = view.kind
            end
            assert.same({ "session", "live", "record", "record" }, kinds)
            assert.same({
                "Session · 3 segments", "Wailing Caverns", "Deadmines · 3m ago", "Stockade · 9m ago",
            }, titlesOf(strip))
        end)

        it("numbers every view against the length of the strip", function()
            local views = newViews({ segments = { record({ id = "a" }) } })

            local strip = walk(views)

            assert.equal(3, #strip)
            for index, view in ipairs(strip) do
                assert.equal(index, view.index)
                assert.equal(3, view.count)
            end
        end)

        it("reaches the session total from the open segment and stops there", function()
            local views = newViews({ segments = { record({ id = "a" }) } })

            assert.equal("session", views.move(-1).kind)
            assert.equal("session", views.move(-1).kind)
            assert.equal(1, views.selected().index)
        end)

        it("walks back through the finished segments and stops at the oldest", function()
            local views = newViews({
                segments = {
                    record({ id = "newer", endedAt = OPENED - 60 }),
                    record({ id = "older", endedAt = OPENED - 420 }),
                },
            })

            assert.equal("record:newer", views.move(1).key)
            assert.equal("record:older", views.move(1).key)
            assert.equal("record:older", views.move(1).key)
        end)

        -- An evening survives hopping alts — that is the app's own rule for what a session
        -- is — so the dungeon run that happened on the alt before this character logged in
        -- is part of it. It says whose it was, or it would read as somewhere this character
        -- has been.
        it("keeps an alt's segments on the strip, and says whose they were", function()
            local views = newViews({
                segments = {
                    record({ id = "mine", instance = "Stockade", endedAt = OPENED - 60 }),
                    record({ id = "theirs", instance = "Deadmines", endedAt = OPENED - 420,
                        character = "Alt-Ravencrest" }),
                },
            })

            local strip = walk(views)

            assert.equal(4, #strip)
            assert.equal("Stockade · 3m ago", strip[3].title)
            assert.equal("Alt — Deadmines · 9m ago", strip[4].title)
        end)

        -- An evening is what the desktop app says it is: segments chained across silences of
        -- no more than five minutes. The log keeps a week of history and the rest of it —
        -- last night's raid, this morning's dailies — belongs to other evenings.
        for _, case in ipairs({
            { what = "ended as the open one began", endedAt = OPENED, onStrip = true },
            { what = "left exactly five minutes of silence", endedAt = OPENED - GAP, onStrip = true },
            { what = "left a second more than five minutes", endedAt = OPENED - GAP - 1, onStrip = false },
            { what = "was played last night", endedAt = OPENED - 86400, onStrip = false },
        }) do
            it("puts a segment that " .. case.what .. (case.onStrip and " on the strip" or " nowhere"), function()
                local views = newViews({ segments = { record({ id = "a", endedAt = case.endedAt }) } })

                assert.equal(case.onStrip and 3 or 2, #walk(views))
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

            assert.equal(5, #walk(views))
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

            assert.equal(3, #walk(views))
        end)

        -- The strip grows underneath the selection: a segment closing pushes every older one
        -- along by a place. Holding the choice as a position would silently move the panel
        -- onto a different segment than the player parked it on.
        it("stays on the segment it was showing when a newer one is filed", function()
            local segments = { record({ id = "a", instance = "Deadmines", endedAt = OPENED - 120 }) }
            local views = newViews({ segments = segments })
            assert.equal("record:a", views.move(1).key)

            table.insert(segments, 1, record({ id = "b", instance = "Stockade", endedAt = OPENED - 60 }))

            local view = views.selected()
            assert.equal("record:a", view.key)
            -- Session, live, the segment just filed, then the one being looked at.
            assert.equal(4, view.index)
            assert.equal(4, view.count)
        end)

        -- A record pruned out of the log, or a character switch that emptied the session,
        -- leaves the arrows standing on nothing. The open segment is the one view that
        -- always exists, so that is where they land.
        it("falls back to the open segment when the one it was showing is gone", function()
            local segments = { record({ id = "a" }) }
            local views = newViews({ segments = segments })
            assert.equal("record:a", views.move(1).key)

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

                    assert.equal(case.title, views.move(-1).title)
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
            -- staleness warning and a poor label: a segment that just closed sits one arrow
            -- from the one being played, and "Deadmines · now" beside "Deadmines" is not a
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

                    assert.equal(case.title, views.move(1).title)
                end)
            end
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

                assert.equal(125, views.move(-1).summary.lootValue)
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
                for index, event in ipairs(views.move(-1).summary.levelUps) do
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

                assert.equal(filed, views.move(1).summary)
                assert.equal(0, counted.liveSummary)
            end)

            it("leaves no record field behind on the view it hands back", function()
                local views = newViews({ segments = { record({ id = "a" }) } })

                assert.is_nil(views.move(1).record)
            end)
        end)
    end)
end)
