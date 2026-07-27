local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.readLocation", function()
    local ns = loader.load()

    it("is exported by the addon files", function()
        assert.is_function(ns.readLocation)
    end)

    -- Issue #87 exactly. GetInstanceInfo names the continent out in the open world, so every
    -- segment spent anywhere on Northrend was filed under "Northrend" and the zone the player
    -- actually spent the time in never reached the log.
    it("names the zone rather than the continent in the open world", function()
        local client = fake.newZone({ instanceName = "Northrend", kind = "none", zoneText = "The Storm Peaks" })

        assert.same({ name = "The Storm Peaks", kind = "none" }, ns.readLocation(client))
    end)

    -- Inside an instance the two answers differ the other way round: the instance is "Utgarde
    -- Keep" and the zone holding its door is "Howling Fjord". The instance name is what
    -- ExpansionIndex.forInstance and the difficulty pairing are filed under, so it has to win.
    for _, kind in ipairs({ "party", "raid", "pvp", "arena", "scenario" }) do
        it("keeps the instance's own name in a " .. kind, function()
            local client = fake.newZone({
                instanceName = "Utgarde Keep",
                kind = kind,
                zoneText = "Howling Fjord",
            })

            assert.equal("Utgarde Keep", ns.readLocation(client).name)
        end)
    end

    -- A loading screen answers "" here. Narrowing to that would file the segment under no
    -- name at all, which is worse than the continent it replaced.
    it("keeps the continent when the zone text is empty", function()
        local client = fake.newZone({ instanceName = "Northrend", kind = "none", zoneText = "" })

        assert.equal("Northrend", ns.readLocation(client).name)
    end)

    it("keeps the continent when the client names no zone at all", function()
        local client = fake.newZone({ instanceName = "Northrend", kind = "none" })

        assert.equal("Northrend", ns.readLocation(client).name)
    end)

    -- IsInInstance's type reads "none" out in the world, but a client that has not settled
    -- yet answers nothing at all, and that is still the open world as far as narrowing goes.
    it("treats a nil kind as the open world too", function()
        local client = fake.newZone({ instanceName = "Eastern Kingdoms", zoneText = "Eversong Forest" })

        assert.equal("Eversong Forest", ns.readLocation(client).name)
    end)

    -- The narrowing rewrites the name, and everything filed beside it — the tracker's identity
    -- key included — has to survive that rewrite untouched.
    it("carries the kind and the difficulty through the narrowing", function()
        local client = fake.newZone({
            instanceName = "Northrend",
            kind = "none",
            difficultyId = 1,
            difficulty = "Normal",
            zoneText = "The Storm Peaks",
        })

        assert.same({
            name = "The Storm Peaks",
            kind = "none",
            difficultyId = 1,
            difficulty = "Normal",
        }, ns.readLocation(client))
    end)

    -- Half an API is as good as none here: a build that names instances but has no
    -- GetRealZoneText still has to produce a usable record rather than an error.
    it("keeps the client's own name when there is no zone text to ask for", function()
        local client = fake.newZone({ instanceName = "Northrend", kind = "none", zoneText = "The Storm Peaks" })
        client.getRealZoneText = nil

        assert.equal("Northrend", ns.readLocation(client).name)
    end)

    it("reports nowhere rather than erroring on a client with no zone API", function()
        assert.is_nil(ns.readLocation(nil))
        assert.is_nil(ns.readLocation({}))
    end)
end)
