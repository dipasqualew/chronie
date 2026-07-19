std = "lua51"
max_line_length = 120

-- WoW passes (addonName, namespace) as varargs to every file in the .toc.
files["*.lua"] = { ignore = { "212/_" } }

-- Specs run under busted, which injects describe/it/assert/spy/stub as globals.
files["spec/**/*.lua"] = { std = "lua51+busted" }

read_globals = {
    "CreateFrame",
    "UnitName",
    "UnitClass",
    "UnitLevel",
    "GetRealmName",
    "GetNumSavedInstances",
    "GetSavedInstanceInfo",
    "GetSavedInstanceEncounterInfo",
    "GameTooltip",
    "RequestRaidInfo",
    "RAID_CLASS_COLORS",
    "CLASS_ICON_TCOORDS",
    "EJ_GetNumTiers",
    "EJ_GetCurrentTier",
    "EJ_SelectTier",
    "EJ_GetTierInfo",
    "EJ_GetInstanceByIndex",
    "UIParent",
    "UISpecialFrames",
    "print",
    "time", -- WoW aliases os.time / os.date as bare globals
    "date",
}


globals = {
    "WdpWowDB", -- SavedVariables
    "SlashCmdList",
}

exclude_files = { ".luacheckrc" }
