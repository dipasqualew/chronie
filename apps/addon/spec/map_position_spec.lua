local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.readMapPosition", function()
    local ns = loader.load()

    it("is exported by the addon files", function()
        assert.is_function(ns.readMapPosition)
    end)

    it("reports the map and the point the client gives", function()
        local cMap = fake.newMap({ uiMapID = 84, x = 0.25, y = 0.75 })

        assert.same({ uiMapID = 84, x = 0.25, y = 0.75 }, ns.readMapPosition(cMap))
    end)

    it("asks about the player, on the map the player is best placed on", function()
        local cMap, recorded = fake.newMap({ uiMapID = 84, x = 0.25, y = 0.75 })

        ns.readMapPosition(cMap)

        assert.same({
            { call = "GetBestMapForUnit", unit = "player" },
            { call = "GetPlayerMapPosition", uiMapID = 84, unit = "player" },
        }, recorded.asked)
    end)

    -- The common case inside a dungeon or a raid, not an edge case: the client names the
    -- map perfectly happily and then declines to place the player on it.
    it("keeps the map when the client will not give a point", function()
        local cMap = fake.newMap({ uiMapID = 2296 })

        assert.same({ uiMapID = 2296 }, ns.readMapPosition(cMap))
    end)

    -- A 0,0 would read to everything downstream as the top-left corner of the map, which
    -- is a fabricated answer rather than a missing one.
    it("never invents a point where the client refused one", function()
        local cMap = fake.newMap({ uiMapID = 2296 })

        local position = ns.readMapPosition(cMap)

        assert.is_nil(position.x)
        assert.is_nil(position.y)
    end)

    it("keeps a genuine zero, which is a real corner of a real map", function()
        local cMap = fake.newMap({ uiMapID = 84, x = 0, y = 0 })

        assert.same({ uiMapID = 84, x = 0, y = 0 }, ns.readMapPosition(cMap))
    end)

    it("reports nowhere at all when the client cannot name a map", function()
        assert.is_nil(ns.readMapPosition(fake.newMap()))
    end)

    it("reports nowhere rather than erroring on a client with no map API", function()
        assert.is_nil(ns.readMapPosition(nil))
        assert.is_nil(ns.readMapPosition({}))
    end)

    -- Half an API is as good as none here: a build that names maps but cannot place a
    -- player on them still has to produce a usable record rather than an error.
    it("keeps the map on a client that cannot place the player at all", function()
        local cMap = fake.newMap({ uiMapID = 84, x = 0.5, y = 0.5 })
        cMap.GetPlayerMapPosition = nil

        assert.same({ uiMapID = 84 }, ns.readMapPosition(cMap))
    end)
end)
