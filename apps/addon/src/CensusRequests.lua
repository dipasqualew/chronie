local _, ns = ...

-- Written by the Chronie desktop app when somebody has asked it for a fresh census.
--
-- The same road into the game `src/CustomSetRequests.lua` travels and for the same reason: a
-- SavedVariables file is read by the client once at load and rewritten wholesale from memory at
-- logout, so anything the app left there while the game was running is never read and then
-- destroyed. A source file of the addon's own is loaded by the client and never written by it,
-- which is what makes it somewhere the app can leave a message. See `docs/transmog-sets.md` for
-- where that was settled and `docs/account-census.md` for what this one asks.
--
-- **A request is picked up at the next load and answered at the next logout.** Nothing about it
-- is immediate, which is why the app's own button says "next time you log in" rather than
-- implying anything happens now.
--
-- Shipped empty, and overwritten by the app the way `src/Settings.lua` is. A hand-installed copy
-- gets this one and must still load, so the shape it declares here is the shape the generated
-- one has to keep.
--
-- Editing it by hand lasts until the app next writes it, which it does whenever a resync is asked
-- for and again whenever the addon is installed.
ns.censusRequests = {
    -- What the app last had to say, as a moment. Only ever read for the record it leaves behind:
    -- what decides whether a request runs is whether its own id has been done.
    issuedAt = 0,
    -- Each `{ id = <the app's own id>, domains = { "mounts", ... } }`. An absent or empty
    -- `domains` asks for every domain this build can walk, which is what the Resync button sends;
    -- naming them is what a targeted probe would use.
    requests = {},
}
