std = "lua51"
max_line_length = 120

-- WoW passes (addonName, namespace) as varargs to every file in the .toc.
files["apps/addon/*.lua"] = { ignore = { "212/_" } }

-- Specs run under busted, which injects describe/it/assert/spy/stub as globals.
files["apps/addon/spec/**/*.lua"] = { std = "lua51+busted" }

read_globals = {
    "CreateFrame",
    "UnitName",
    "UnitClass",
    "UnitLevel",
    "UnitGUID",
    "UnitRace",
    "UnitSex",
    "C_BarberShop",
    "UnitXP",
    "UnitXPMax",
    "C_ChallengeMode",
    "C_PartyInfo",
    "C_DelvesUI",
    "C_ScenarioInfo",
    "C_Timer",
    "GetRealmName",
    "GetNumSavedInstances",
    "GetSavedInstanceInfo",
    "GetSavedInstanceEncounterInfo",
    "GetNumSavedWorldBosses",
    "GetSavedWorldBossInfo",
    "GameTooltip",
    "RequestRaidInfo",
    "RAID_CLASS_COLORS",
    "CLASS_ICON_TCOORDS",
    "EJ_GetNumTiers",
    "EJ_GetCurrentTier",
    "EJ_SelectTier",
    "EJ_GetTierInfo",
    "EJ_GetInstanceByIndex",
    "EJ_GetInstanceInfo",
    "GetMoney",
    "C_Bank",
    "Enum",
    "GetInstanceInfo",
    "GetRealZoneText",
    "GetItemInfo",
    "C_Item",
    "GetCursorInfo",
    "ClearCursor",
    "C_TransmogCollection",
    -- Blizzard's own tier and vendor sets, which is what says a dropped shoulder is the fifth
    -- of eight. Signatures out of the 12.0.5.67823 client's own usage strings.
    "C_TransmogSets",
    "IsShiftKeyDown",
    "C_EquipmentSet",
    "GetInventoryItemID",
    "ItemLocation",
    "C_CurrencyInfo",
    "C_Reputation",
    "C_MajorFactionData",
    "C_GossipInfo",
    "C_QuestLog",
    "C_MountJournal",
    "C_PetJournal",
    "C_ToyBox",
    -- The census's four grow-only collections. `PlayerHasToy` and the three title calls are
    -- bare globals rather than members of a namespace, which is genuinely what 12.0.5.67823
    -- offers: both predate `C_` namespaces and neither was ever moved into one. Signatures out
    -- of the client's own `titledocumentation.lua` and `blizzard_toybox.lua`.
    "PlayerHasToy",
    "C_Heirloom",
    "GetNumTitles",
    "IsTitleKnown",
    "GetTitleName",
    "C_HousingCatalog",
    "C_Map",
    "Screenshot",
    "GetBindingKey",
    "LoggingCombat",
    -- Undocumented on 12.0.5 and read out of the client binary rather than a wiki. Every one
    -- of these is reached through a nil check and a pcall (see LogProbe.lua) precisely because
    -- nothing outside the binary says they exist, let alone what they do.
    "LoggingChat",
    "C_Log",
    "SendSystemMessage",
    "C_CombatLogSecure",
    "DEFAULT_CHAT_FRAME",
    "C_CVar",
    "GetCVar",
    "SetCVar",
    "GetAchievementInfo",
    -- The achievement tree, which is the only way to enumerate achievements: there is no id
    -- list, so `ns.achievementCensus` walks categories and offsets. Read out of Blizzard's own
    -- Blizzard_AchievementUI on 12.0.5.67823, where GetNumCompletedAchievements is used as
    -- `numAchievements, numCompleted = GetNumCompletedAchievements(IN_GUILD_VIEW)`.
    "GetCategoryList",
    "GetCategoryNumAchievements",
    "GetNumCompletedAchievements",
    -- Which client build this is, so a census can say which game it was taken of. Fourth return.
    "GetBuildInfo",
    "AchievementFrame_LoadUI",
    "AchievementFrame",
    "AchievementFrame_SelectAchievement",
    "ShowUIPanel",
    "DressUpItemLink",
    "DressUpFrame",
    "SideDressUpFrame",
    "TransmogAndMountDressupFrame",
    "CollectionsJournal_LoadUI",
    "ToggleCollectionsJournal",
    "WardrobeCollectionFrame",
    "FACTION_STANDING_INCREASED",
    "FACTION_STANDING_INCREASED_BONUS",
    "FACTION_STANDING_INCREASED_ACCOUNT_WIDE",
    "LOOT_ITEM_SELF",
    "LOOT_ITEM_SELF_MULTIPLE",
    "LOOT_ITEM_PUSHED_SELF",
    "LOOT_ITEM_PUSHED_SELF_MULTIPLE",
    "LOOT_ITEM_BONUS_ROLL_SELF",
    "LOOT_ITEM_BONUS_ROLL_SELF_MULTIPLE",
    "UIParent",
    "Minimap",
    "UISpecialFrames",
    "print",
    "time", -- WoW aliases os.time / os.date as bare globals
    "date",
}


globals = {
    "ChronieDB", -- SavedVariables
    "SlashCmdList",
}

exclude_files = { ".luacheckrc" }
