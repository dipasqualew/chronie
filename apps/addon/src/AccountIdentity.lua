local _, ns = ...

---Who this SavedVariables file belongs to.
---
---Account-level on purpose. SavedVariables are written per account, so a value stored in
---them is the account's by construction and every character on it reports the same author.
---Recording the character instead would be cheap now and unfixable later: entries are meant
---to be shareable one day, and "who made this" means the player, not whichever alt they
---happened to be logged into that evening.
---@class AccountIdentity
---@field id fun(): string? The account's id, minted on first use. Nil only while the client
---still cannot say who the player is, which is every moment before the world has loaded.

---@class AccountIdentityDeps
---@field db table SavedVariables root; mutated in place so the client persists the mint.
---@field now fun(): integer
---@field playerGUID fun(): string? The client's UnitGUID("player").

---@param deps AccountIdentityDeps
---@return AccountIdentity
function ns.newAccountIdentity(deps)
    local db = deps.db

    return {
        id = function()
            local account = db.account
            if type(account) == "table" and type(account.id) == "string" then
                return account.id
            end

            -- The player GUID carries Blizzard's own realm and character ids, so it is
            -- already unique across every account in the game — which is exactly what an
            -- id two players might one day compare has to be. It is minted once, from
            -- whichever character happened to be logged in first, and never consulted
            -- again: the character it names is not the point, the account that owns this
            -- file is. The minting second is folded in so a GUID that Blizzard ever reuses
            -- after a rename or a realm merge still cannot collide with an older account.
            local guid = deps.playerGUID and deps.playerGUID() or nil
            if not guid then
                return nil
            end

            local mintedAt = deps.now()
            db.account = { id = guid .. "|" .. tostring(mintedAt), createdAt = mintedAt }
            return db.account.id
        end,
    }
end
