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
    "UnitXP",
    "UnitXPMax",
    "C_ChallengeMode",
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
    "GetMoney",
    "C_Bank",
    "Enum",
    "GetInstanceInfo",
    "GetItemInfo",
    "C_Item",
    "GetCursorInfo",
    "ClearCursor",
    "C_TransmogCollection",
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
    "C_HousingCatalog",
    "C_Map",
    "Screenshot",
    "GetBindingKey",
    "LoggingCombat",
    "C_CVar",
    "GetCVar",
    "SetCVar",
    "GetAchievementInfo",
    "AchievementFrame_LoadUI",
    "AchievementFrame",
    "AchievementFrame_SelectAchievement",
    "ShowUIPanel",
    "DressUpItemLink",
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
