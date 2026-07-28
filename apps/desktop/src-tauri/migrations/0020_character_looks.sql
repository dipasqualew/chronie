-- Who each of the reader's characters is, so the app can draw one of them rather than a stranger.
--
-- The transmog view has had a body and a set of answers about it since there was anywhere to say
-- who the character on the stage should be, and every one of them was the reader inventing
-- somebody: fifty-one bodies on a list and a select per question. These two tables are the other
-- direction — the people they actually play, read out of the game by the addon — and what they buy
-- is the shortcut, "show me this hat on my warrior", instead of twenty selects that approximate her.
--
-- **The two halves of a look come from different places in the game, and only one of them is
-- always readable.** A race and a sex the client will state wherever a character is standing. What
-- a character is *made of* it will state in exactly one place: `GetAvailableCustomizations`, which
-- answers only while the barber's screen is up. So `race` is NOT NULL and the choices table is
-- ordinarily empty — a character who has not had a haircut since Chronie was installed has a row
-- here and no rows there, and is drawn on the right body with the swatches the game itself opens
-- on. See `apps/addon/src/CharacterLook.lua` and `look.rs`.
--
-- **Stored as the client's own numbers**, which is the same bargain `0018_in_game_sets.sql` makes
-- next door and for the same reason: a race id, a `UnitSex`, and pairs of
-- `ChrCustomizationOption` and `ChrCustomizationChoice` ids. What those come to — which `ChrModel`
-- a Mag'har Orc is, what a swatch of "Hair Color" looks like — is read out of the installed game
-- every time it is asked for, because that is where the answer lives and it changes with the
-- patch. Writing it down here would be a second copy of the game's files, stale on the next one.
--
-- The consequence is the one the in-game sets already have: a character is remembered on a machine
-- with no game installed, and cannot be *drawn* on one.

CREATE TABLE character_looks (
    -- One row per character, not per look: this is who somebody is now, and the history of who
    -- they used to be is not something anybody has asked to see.
    character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    -- `ChrRaces.ID`, as `UnitRace` reports it. Not null because it is what decides the body, and
    -- a character with no body is one the shortcut would offer and then do nothing about.
    race         INTEGER NOT NULL,
    -- `UnitSex`, which is the client's numbering and not the tables': 1 nobody, 2 male, 3 female,
    -- against the 0 male and 1 female every DB2 column with an opinion writes. Kept as the client
    -- said it, and translated in `look.rs` beside the table it is translated into.
    sex          INTEGER NOT NULL,
    -- When the addon last saw this character *differ*, rather than when it last looked.
    observed_at  INTEGER
) STRICT, WITHOUT ROWID;

-- What the character was made of, one row per question the game asked about them.
--
-- At most one answer per question, which is the game's own rule: a body cannot wear two
-- hairstyles, and the character creation screen has one swatch selected per option at a time.
CREATE TABLE character_look_choices (
    character_id INTEGER NOT NULL
        REFERENCES character_looks(character_id) ON DELETE CASCADE,
    -- `ChrCustomizationOption.ID` and `ChrCustomizationChoice.ID` — the two numbers the client's
    -- own `C_BarberShop.SetCustomizationChoice(optionID, choiceID)` takes, and the two the app's
    -- own settings file already stores when a reader answers a question by hand. That they are
    -- the same numbers is the whole reason a character read out of the game can be worn here.
    option_id    INTEGER NOT NULL,
    choice_id    INTEGER NOT NULL,
    PRIMARY KEY (character_id, option_id)
) STRICT, WITHOUT ROWID;
