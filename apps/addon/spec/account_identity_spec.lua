local loader = require("addon_loader")
local fake = require("fake_wow")

describe("ns.newAccountIdentity", function()
    local ns = loader.load()

    local NOW = 1700000000
    local GUID = "Player-970-0002FD1B"

    ---@param options table? `{ db, clock, playerGUID }`
    ---@return AccountIdentity identity, table db, table clock
    local function newIdentity(options)
        options = options or {}
        local db = options.db or {}
        local clock = options.clock or fake.newClock(NOW)
        local guid = options.playerGUID
        if guid == nil then
            guid = GUID
        end
        local identity = ns.newAccountIdentity({
            db = db,
            now = clock.now,
            playerGUID = function()
                return guid or nil
            end,
        })
        return identity, db, clock
    end

    it("is exported by the addon files", function()
        assert.is_function(ns.newAccountIdentity)
    end)

    it("mints an id from the player GUID and the moment it was minted", function()
        local identity = newIdentity()

        assert.equal(GUID .. "|" .. NOW, identity.id())
    end)

    it("writes the mint into the saved variables, with when it happened", function()
        local identity, db = newIdentity()

        identity.id()

        assert.same({ id = GUID .. "|" .. NOW, createdAt = NOW }, db.account)
    end)

    it("mints nothing until asked", function()
        local _, db = newIdentity()

        assert.is_nil(db.account)
    end)

    -- The point of the whole module: the id belongs to the account, so the alt someone
    -- happens to be logged into never changes who authored an entry.
    it("gives every character on the account the same id", function()
        local db = {}
        local first = newIdentity({ db = db })
        local minted = first.id()

        local second = newIdentity({
            db = db,
            clock = fake.newClock(NOW + 86400),
            playerGUID = "Player-970-000AAAAA",
        })

        assert.equal(minted, second.id())
    end)

    it("keeps the id it already minted rather than minting a second one", function()
        local identity, _, clock = newIdentity()
        local minted = identity.id()

        clock.advance(3600)

        assert.equal(minted, identity.id())
    end)

    it("gives two accounts different ids even on the same character id", function()
        local first = newIdentity()
        local second = newIdentity({ clock = fake.newClock(NOW + 1) })

        assert.not_equal(first.id(), second.id())
    end)

    -- Before the world has loaded the client will not say who the player is, and an entry
    -- authored by nobody is not something a later release could repair.
    it("mints nothing while the client cannot name the player", function()
        local identity, db = newIdentity({ playerGUID = false })

        assert.is_nil(identity.id())
        assert.is_nil(db.account)
    end)

    it("mints once the client can name the player, having refused before", function()
        local db = {}
        newIdentity({ db = db, playerGUID = false }).id()

        local identity = newIdentity({ db = db })

        assert.equal(GUID .. "|" .. NOW, identity.id())
    end)

    it("ignores a saved account record that carries no id", function()
        local identity, db = newIdentity({ db = { account = { createdAt = 1 } } })

        assert.equal(GUID .. "|" .. NOW, identity.id())
        assert.equal(NOW, db.account.createdAt)
    end)
end)
