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
ns.settings = {
    combatLogging = false,
}
