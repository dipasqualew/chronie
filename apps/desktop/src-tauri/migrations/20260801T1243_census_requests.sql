-- Walks this app has asked the game to take, and what came of each.
--
-- The second thing Chronie says back to a WoW account, and it travels the road the first one
-- proved: a SavedVariables file is read by the client once at load and rewritten wholesale at
-- logout, so the app cannot leave a message there. What it writes instead is a source file of the
-- addon's own, listed in `chronie.toc`, which the client loads and never writes — see
-- `0019_set_requests.sql`, where that was settled, and `docs/account-census.md` for what this one
-- asks for.
--
-- **This exists because the addon's audit is deliberately conservative.** A census pass is
-- provoked by a build change, a domain that was never whole, or the client's own counter saying
-- there is more, and none of those is a timer — that argument is the whole middle of
-- `docs/account-census.md` and it still holds. What none of them covers is a person who simply
-- knows a reading is stale. This is how they say so.
--
-- **A request outlives the file it is written into**, for the reason the set requests do: the app
-- has no way to know the game ever loaded. So the row is kept, written into the addon's folder on
-- every install and every ask, and only stops being written once the addon has said what became
-- of it. The acknowledgement comes back the ordinary way, in SavedVariables, and lands in the
-- three columns at the bottom.
--
-- Nothing in here is per account. A census is a reading of what one account holds, but a request
-- names no account and no character, and the first roster to walk it has walked it — the same
-- rule `sync_set_request_outcomes` follows next door and for the same reason: an install with two
-- accounts would otherwise walk every domain twice for one button press.

CREATE TABLE census_requests (
    -- AUTOINCREMENT, because this id crosses into the game's own folder and comes back again:
    -- the addon remembers which requests it has carried out by it, and SQLite handing a deleted
    -- row's id to the next request would have the addon skip a walk it had never taken.
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  INTEGER NOT NULL,
    -- When the addon finished the walk it asked for, what it did, and what it actually walked.
    -- All three NULL means the request has not been answered yet — which is exactly the set of
    -- rows that gets written into the addon's folder.
    --
    -- `applied_at` is the moment the walk *ended* rather than the moment it was picked up, and
    -- the addon is careful about the difference: a pass a logout cut short never records one at
    -- all, so the request stays open and the next login walks again. That is what makes asking
    -- for a resync mean getting one rather than getting whatever fitted before teatime.
    applied_at  INTEGER,
    outcome     TEXT
) STRICT;

-- Which domains one request asked for, by the addon's own word for each — "mounts",
-- "appearances". No rows at all asks for every domain the addon can walk, which is what the
-- Resync button sends.
--
-- A table rather than a column of comma-separated names, because this is the seam a targeted
-- probe arrives on: the app knows the whole catalogue out of the game's DB2 tables and the addon
-- does not, so "walk these and tell me" is a thing only this end can decide to ask for, and it
-- will want to be queried rather than parsed when it does.
CREATE TABLE census_request_domains (
    request_id INTEGER NOT NULL REFERENCES census_requests(id) ON DELETE CASCADE,
    domain     TEXT NOT NULL,
    PRIMARY KEY (request_id, domain)
) STRICT, WITHOUT ROWID;

-- What the addon actually walked, which is not always what was asked for: a client build missing
-- a domain's calls cannot walk it however plainly the request named it, and a reader who asked
-- for everything and got four of five domains should be able to see which four.
CREATE TABLE census_request_walked (
    request_id INTEGER NOT NULL REFERENCES census_requests(id) ON DELETE CASCADE,
    domain     TEXT NOT NULL,
    PRIMARY KEY (request_id, domain)
) STRICT, WITHOUT ROWID;

-- The one question asked of this table on every install and every ask: what is still waiting.
CREATE INDEX census_requests_waiting ON census_requests(applied_at);
