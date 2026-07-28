local _, ns = ...

-- Written by the Chronie desktop app when it has an outfit for the game to hold on to.
--
-- This is the way *in*. Everything else Chronie collects travels the other way — the addon
-- writes SavedVariables and the app reads them at logout — and that road only runs downhill:
-- the client reads a SavedVariables file once at load and rewrites the whole of it from memory
-- when the player logs out, so anything the app put there while the game was running is never
-- read and then destroyed. A file of the addon's own is not written by the client at all, which
-- is what makes it somewhere the app can actually leave a message. See `docs/transmog-sets.md`.
--
-- Shipped empty, and overwritten by the app the way `src/Settings.lua` is. A hand-installed copy
-- gets this one and must still load, so the shape it declares here is the shape the generated
-- one has to keep.
--
-- Editing it by hand lasts until the app next writes it, which it does whenever an outfit is
-- sent to the game and again whenever the addon is installed.
ns.customSetRequests = {
    -- What the app last had to say, as a moment. Only ever read for the record it leaves
    -- behind: what decides whether a request runs is whether its own id has been done.
    issuedAt = 0,
    requests = {},
}
