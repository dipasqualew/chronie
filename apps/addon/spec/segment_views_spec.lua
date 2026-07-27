local loader = require("addon_loader")

describe("segment views", function()
    local ns = loader.load()

    local CHARACTER = "Main-Ravencrest"
    -- The addon loaded half an hour before the clock these tests read, so a segment can be
    -- placed inside this session or before it by moving its endedAt either side of START.
    local START = 1700000000
    local NOW = START + 1800

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
    ---@param overrides table?
    ---@return SegmentRecord
    local function record(overrides)
        local base = summary({
            id = "segment",
            character = CHARACTER,
            instance = "Deadmines",
            endedAt = NOW,
        })
        for key, value in pairs(overrides or {}) do
            base[key] = value
        end
        return base
    end

    ---Build the strip with hand-written deps: no frames, no panel, just the module and
    ---the six seams it reads the world through.
    ---
    ---`options.segments` is kept by reference rather than copied, so a test can file a new
    ---segment into it half way through and watch what that does to the selection — which is
    ---exactly what the game does while the panel is open.
    ---@param options table? `{ live, location, segments, character, sessionStart, now }`
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
            sessionStart = function()
                return options.sessionStart or START
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
                    record({ id = "newer", instance = "Deadmines", endedAt = NOW - 60 }),
                    record({ id = "older", instance = "Stockade", endedAt = NOW - 600 }),
                },
            })

            local strip = walk(views)

            local kinds = {}
            for index, view in ipairs(strip) do
                kinds[index] = view.kind
            end
            assert.same({ "session", "live", "record", "record" }, kinds)
            assert.same({
                "Session · 3 segments", "Wailing Caverns", "Deadmines · 1m ago", "Stockade · 10m ago",
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
                    record({ id = "newer", endedAt = NOW - 60 }),
                    record({ id = "older", endedAt = NOW - 600 }),
                },
            })

            assert.equal("record:newer", views.move(1).key)
            assert.equal("record:older", views.move(1).key)
            assert.equal("record:older", views.move(1).key)
        end)

        -- The log is account-wide, so it holds every character's segments. The panel is one
        -- character's HUD and a strip mixing an alt's evening into it would be nonsense.
        it("leaves another character's segments off the strip", function()
            local views = newViews({
                segments = {
                    record({ id = "mine" }),
                    record({ id = "theirs", character = "Alt-Ravencrest" }),
                },
            })

            assert.equal(3, #walk(views))
        end)

        -- "This session" is since the addon loaded, the same way a damage meter's is. The
        -- log keeps a week of history and none of it belongs on this evening's strip.
        for _, case in ipairs({
            { what = "closed exactly as the session began", endedAt = START, onStrip = true },
            { what = "closed a second before it", endedAt = START - 1, onStrip = false },
            { what = "closed a day before it", endedAt = START - 86400, onStrip = false },
        }) do
            it("puts a segment " .. case.what .. (case.onStrip and " on the strip" or " nowhere"), function()
                local views = newViews({ segments = { record({ id = "a", endedAt = case.endedAt }) } })

                assert.equal(case.onStrip and 3 or 2, #walk(views))
            end)
        end

        -- The strip grows underneath the selection: a segment closing pushes every older one
        -- along by a place. Holding the choice as a position would silently move the panel
        -- onto a different segment than the player parked it on.
        it("stays on the segment it was showing when a newer one is filed", function()
            local segments = { record({ id = "a", instance = "Deadmines", endedAt = NOW - 600 }) }
            local views = newViews({ segments = segments })
            assert.equal("record:a", views.move(1).key)

            table.insert(segments, 1, record({ id = "b", instance = "Stockade", endedAt = NOW - 60 }))

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
                        segments[index] = record({ id = "a" .. index, endedAt = NOW - index })
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
                        -- Far enough back that a three-hour-old segment is still this session.
                        sessionStart = NOW - 86400,
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
                        record({ id = "newer", lootValue = 20, endedAt = NOW - 60 }),
                        record({ id = "older", lootValue = 100, endedAt = NOW - 600 }),
                    },
                })

                assert.equal(125, views.move(-1).summary.lootValue)
            end)

            it("reads the session's events forward in time, ending on what is happening now", function()
                local views = newViews({
                    live = summary({ levelUps = { { level = 72, at = NOW } } }),
                    segments = {
                        record({ id = "newer", endedAt = NOW - 60, levelUps = { { level = 71, at = NOW - 120 } } }),
                        record({ id = "older", endedAt = NOW - 600, levelUps = { { level = 70, at = NOW - 700 } } }),
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
