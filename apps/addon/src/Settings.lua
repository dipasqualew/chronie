local _, ns = ...

---What the desktop app has asked this installed copy of the addon to do.
---
---This file is the channel between the two halves. The desktop app writes the whole addon
---folder every time it starts, and it writes this one file from its own saved settings
---rather than from the bundle — so what is on disk in the game folder is always what the
---Setup screen last said, and the addon reads a plain table instead of guessing.
---
---The values here are the defaults: what a copy installed by hand, or by an app that has
---never been told otherwise, ends up with. Everything in it is off, because everything in
---it costs the player something they did not ask for.
---@class ChronieSettings
---@field combatLogging boolean Whether to start combat logging at login. Off by default: a
---raid night of combat log is hundreds of megabytes, and nothing deletes it again yet.
---@field captureTriggers string[] Which things worth remembering take a picture of
---themselves — see ns.newCaptureTriggers for what each name means. Conservative rather than
---empty: "the first time this account ever did this" is rare enough to be worth a
---photograph every time, which "an achievement fired" is not.
---@field sync ChronieSyncSettings What the addon does on its own account, unasked.

---The work Chronie starts by itself, rather than because somebody pressed something.
---
---One field so far, and the shape is a table rather than another flat flag because that is
---the question it belongs to: not "what is recorded" but "what runs unprompted".
---@class ChronieSyncSettings
---@field census boolean Whether a loading screen may provoke an account census. Off. The audit
---in front of the walk is a handful of calls and names nothing in the steady state, which is
---true and is not the whole story: the first pass walks every mount, appearance and achievement
---id the client will answer for — thirteen thousand of the last alone — a patch makes every
---loading screen the first one again, and a partial domain is walked once a session by design.
---A player who wanted their lockouts and their evening never agreed to that bill.
---
---Nothing is removed by switching it off. Census.lua walks exactly as it always did; what
---changes is who asks. `/chronie census refresh` and the Collection screen's Resync button
---both still walk everything whatever this says, because a walk somebody asked for by name is
---not the addon running by itself.
ns.settings = {
    combatLogging = false,
    captureTriggers = { "accountFirstAchievement" },
    sync = {
        census = false,
    },
}
