-- Written independently of the Rust types: representative of a pre-version SavedVariables
-- file, with old omissions and one bad optional event beside one good one.
ChronieDB = {
    ["warband"] = {},
    ["segments"] = {
        {
            ["id"] = "old-1",
            ["character"] = "Aster-Vale",
            ["endedAt"] = 1700000000,
            ["transmogs"] = {
                { ["id"] = 19019, ["newAppearance"] = true },
                { ["id"] = "not-a-number", ["at"] = 1700000000 },
            },
            ["achievements"] = "not-a-list",
            ["lootValue"] = "not-a-number",
        },
        {
            ["id"] = "missing-character",
            ["endedAt"] = 1700000001,
        },
    },
}
