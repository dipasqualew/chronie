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
---@field census boolean Whether a loading screen may provoke a walk of the account's
---**collections** — the mounts, pets, toys, heirlooms, titles, appearances and achievements. On.
---
---It shipped off for a while, and what was wrong with it was the walk rather than the switch.
---A slice ran every single frame until the pass was done, nothing waited out a pull, a plan of
---fifty-five thousand positions was drawn inside one frame, and — the one that actually hurt —
---the two suspicions an audit can never settle meant the whole wardrobe was re-walked at *every*
---loading screen rather than once. `Census.lua` is where each of those is now answered, and a
---pass costs a few per cent of a frame for half a minute.
---
---**A character's wallet and standings are not behind this**, and never should have been. They
---are the other family — `ns.censusHoldings` — they are what every character screen in the app
---is drawn from, and they complete a pane sweep that already runs unasked at every loading
---screen. Switching the collections off used to switch those off with them, silently, which is
---the bug this pair of families exists to make impossible.
---
---And nothing at all is removed by switching this off. `/chronie census refresh` and the
---Collection screen's Resync button both still walk everything whatever it says, because a walk
---somebody asked for by name is not the addon running by itself.
ns.settings = {
    combatLogging = false,
    captureTriggers = { "accountFirstAchievement" },
    sync = {
        census = true,
    },
}
