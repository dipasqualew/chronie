local _, ns = ...

---One thing the character creation screen asked about this character, and the answer to it.
---
---Both numbers are the game's own: `ChrCustomizationOption.ID` and `ChrCustomizationChoice.ID`,
---which are the two the client's own `C_BarberShop.SetCustomizationChoice(optionID, choiceID)`
---takes. That is the whole reason a pair is worth writing down — the desktop app reads those
---same two tables out of the installed game to work out what a body is made of, so an answer
---recorded here is an answer it can draw, with no vocabulary in between to go stale.
---@class CharacterChoiceState
---@field option integer
---@field choice integer

---What one character looks like, as much of it as the client will say.
---@class CharacterLookState
---@field race integer? The client's raceID, out of UnitRace.
---@field sex integer? The client's UnitSex: 1 nobody, 2 male, 3 female.
---@field choices CharacterChoiceState[]? Every option this character has an answer to, ascending
---by option. Nil until the game has been willing to say once — see the module note below.

---Keeps the last look at who this character is, so the app can be told about them.
---@class CharacterLook
---@field sync fun(at: integer?): CharacterLookState Take a look, and file it if it says
---anything the last one did not.

---@class CharacterLookDeps
---@field readRace fun(): integer? UnitRace's third return for the player.
---@field readSex fun(): integer? UnitSex("player").
---@field readChoices fun(): table? C_BarberShop.GetAvailableCustomizations(), which answers
---nothing everywhere except the barber's chair.
---@field store table Where the last look is kept, so a logout still has it to write out.
---@field now fun(): integer

---One number, or nothing, out of whatever the client handed over.
---@param value any
---@return integer?
local function number(value)
    return type(value) == "number" and value or nil
end

---Something to walk, whatever the client gave: `ipairs` on a string walks nothing and `ipairs`
---on a number raises, and the difference between those two is not worth finding out at runtime.
---@param value any
---@return table
local function list(value)
    return type(value) == "table" and value or {}
end

---The answer to one option, or nothing where the client did not give one.
---
---`currentChoiceIndex` is a place in the option's own `choices` list and not an id — Blizzard's
---own character customization frames index it exactly this way — so the id has to be fetched
---through it. An option the client offers and nobody has answered contributes nothing, which is
---the right absence: everything downstream reads a question with no answer as the swatch the
---game itself opens on, and inventing an answer here would be inventing the game's default in
---the one place a later build could move it.
---@param option any
---@return CharacterChoiceState?
local function answerOf(option)
    if type(option) ~= "table" then
        return nil
    end
    local id, at = number(option.id), number(option.currentChoiceIndex)
    if not id or not at then
        return nil
    end
    local chosen = list(option.choices)[at]
    local choice = type(chosen) == "table" and number(chosen.id) or nil
    if not choice then
        return nil
    end
    return { option = id, choice = choice }
end

---Every answered option out of the client's categories, or nothing when it said nothing.
---
---The client hands back categories — Body, Hair, Face and the rest of the tabs down the side of
---the barber's screen — each holding the options on that tab. Which tab a question sits under is
---the game's own arrangement of its screen and nothing downstream draws that screen, so the
---nesting is flattened away and the pairs are what is kept.
---
---**Nothing found is nothing said, not "this character has no options."** Every playable body in
---the game is asked something, so an empty reply is the client declining rather than an answer —
---and treating it as an answer would let one read taken a moment too early wipe a record that
---was correct. The absence is what [`sync`] leans on to keep the last real look.
---@param categories any
---@return CharacterChoiceState[]?
local function answers(categories)
    local found = {}
    for _, category in ipairs(list(categories)) do
        if type(category) == "table" then
            for _, option in ipairs(list(category.options)) do
                found[#found + 1] = answerOf(option)
            end
        end
    end
    if #found == 0 then
        return nil
    end
    -- Ascending by option, because the client orders these for its own screen and a file whose
    -- rows reshuffle between two readings of an unchanged character is a file the comparison
    -- below could never call unchanged.
    table.sort(found, function(left, right)
        return left.option < right.option
    end)
    return found
end

---Whether two looks say the same thing.
---
---Both sides are already normalised and both lists are already in order, which is what makes a
---walk in step a fair comparison rather than an accident of ordering. The right-hand side comes
---back out of SavedVariables, which a player can edit by hand, so a row that is not a row at all
---counts as a difference rather than as a reason to raise.
---@param left CharacterLookState
---@param right CharacterLookState
---@return boolean
local function same(left, right)
    if left.race ~= right.race or left.sex ~= right.sex then
        return false
    end
    local mine, theirs = left.choices, right.choices
    if mine == nil or theirs == nil then
        return mine == theirs
    end
    if #mine ~= #theirs then
        return false
    end
    for index, answer in ipairs(mine) do
        local other = theirs[index]
        if type(other) ~= "table"
            or answer.option ~= other.option
            or answer.choice ~= other.choice then
            return false
        end
    end
    return true
end

---@param deps CharacterLookDeps
---@return CharacterLook
function ns.newCharacterLook(deps)
    local readRace = deps.readRace
    local readSex = deps.readSex
    local readChoices = deps.readChoices
    local store = deps.store
    local now = deps.now

    ---Looks at who the character is and files the look, if it says anything the last one did not.
    ---
    ---**The two halves of a look are readable in different places, and that is the shape of this
    ---whole module.** The race and the sex are readable wherever the character is standing, so
    ---they are read every time. The answers are not: the client will only enumerate what a
    ---character was made of while the barber's screen is up, which is `GetAvailableCustomizations`
    ---and is the only call in the game that says it. So the answers are taken whenever the game
    ---offers them and *kept* the rest of the time, and a character who has never sat in the chair
    ---since Chronie was installed is recorded as their race and nothing more — which is still
    ---enough for the app to draw the right body.
    ---
    ---`at` moves only when the look actually differs, the same rule the transmog snapshot
    ---follows: a stamp that crept forward on every zone change would tell the app somebody had
    ---been at the barber's on an evening they walked past one.
    ---@param at integer?
    ---@return CharacterLookState
    local function sync(at)
        local look = {
            race = number(readRace()),
            sex = number(readSex()),
            choices = answers(readChoices()) or store.choices,
        }
        if not same(look, store) then
            store.race = look.race
            store.sex = look.sex
            store.choices = look.choices
            store.at = at or now()
        end
        return look
    end

    return { sync = sync }
end
