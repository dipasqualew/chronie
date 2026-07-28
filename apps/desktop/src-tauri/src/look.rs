//! Who the reader's own characters are, as the addon reports them.
//!
//! Everything else about the character in the transmog view is the reader inventing somebody: a
//! body off a list of fifty-one, and an answer to each of the questions the character creation
//! screen asks about it. This is the other way round — the people they actually play, read out of
//! the game and offered as a shortcut, so that "show me this on my warrior" is one click rather
//! than twenty selects. `0020_character_looks.sql` is where they are stored, `collector.rs` is the
//! SQL, and `herself.ts` is the window.
//!
//! **The two halves of a look come from different places in the game, and that shape survives all
//! the way to here.** A race and a sex are readable wherever a character is standing. What they
//! are *made of* is not: `C_BarberShop.GetAvailableCustomizations` is the only call in the client
//! that will enumerate a character's own customization, and it answers nothing anywhere but the
//! barber's chair. So a character who has never had a haircut with Chronie installed arrives here
//! as a race and nothing more — which is still worth having, because the race is what decides the
//! body, and the body is most of what a reader means by "my warrior".
//!
//! The numbers cross the boundary unchanged and that is the whole reason this works. The addon
//! writes `ChrCustomizationOption.ID` and `ChrCustomizationChoice.ID`, which are what
//! `C_BarberShop.SetCustomizationChoice` takes; [`crate::customization`] reads those same two
//! tables out of the installed game. There is no vocabulary in between to go stale.
//!
//! One translation does happen, and it happens here rather than in the addon: the client's
//! `UnitSex` and the game's own tables disagree about how to number a sex. See [`Look::body`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::body;
use crate::casc::GameFiles;
use crate::customization::Picked;

/// `UnitSex`, which is not `ChrModel.Sex`: the client answers 1 for a unit that has no sex, 2
/// male and 3 female, while every table in the game with an opinion writes 0 male and 1 female.
///
/// The addon writes down what the client said, because an addon that never opens a DB2 has no
/// business claiming to know what one says. The translation lives here, beside the table it is a
/// translation into.
const UNIT_MALE: i64 = 2;
const UNIT_FEMALE: i64 = 3;

/// What one character was last seen to be, as it is stored.
///
/// The race is the client's `ChrRaces` id and the sex is the client's `UnitSex`, both exactly as
/// the addon read them. Neither is resolved to anything until [`resolve`], because resolving
/// needs the installed game and a character is worth remembering on a machine that has not got
/// one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    /// `Name-Realm`, the key everything else in this database files a character under.
    pub character: String,
    pub race: i64,
    pub sex: i64,
    /// When the addon last saw this character *differ*, rather than when it last looked.
    pub observed_at: Option<i64>,
    /// Every question this character has an answer to. Empty for a character who has not sat in
    /// a barber's chair since Chronie was installed, which is most of a roster.
    pub picked: Vec<Picked>,
}

impl Look {
    /// The `ChrModel` this character is, or nothing where this install offers no such body.
    ///
    /// Nothing is an ordinary answer and covers every way a race can fail to name a body the app
    /// can draw: a race the installed game does not have, a body whose mesh does not resolve, and
    /// a client that would not say what sex the character is at all. Each of those is a character
    /// left off the shortcut rather than one offered and then failed on.
    fn body(&self, files: &dyn GameFiles) -> Result<Option<u32>, String> {
        let sex = match self.sex {
            UNIT_MALE => 0,
            UNIT_FEMALE => 1,
            // Not a sex the client names, which is `UnitSex`'s own 1 and anything a hand-edited
            // file put there. A body of no sex is still findable — the Dracthyr's is the game's
            // one — so this asks for a sex that matches nothing and lets that fallback answer.
            _ => u32::MAX,
        };
        let Ok(race) = u32::try_from(self.race) else {
            return Ok(None);
        };
        body::of_race(files, race, sex)
    }
}

/// One of the reader's characters as the window is offered them: somebody to become in one click.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Known {
    pub character: String,
    /// The `ChrModel` to draw them on.
    pub body: u32,
    /// What to answer about that body. Empty is the ordinary case and means the body as the game
    /// itself opens it — see the module note.
    pub picked: Vec<Picked>,
}

/// One number out of a Lua value the addon wrote, when it really is one.
fn number(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(found) => found.as_i64().or_else(|| Some(found.as_f64()? as i64)),
        _ => None,
    }
}

/// One answered question out of the addon's list, or nothing where the row does not describe one.
///
/// Both halves are required and neither may be zero: zero is no row of either table, so a pair
/// carrying one is a hand-edited file rather than an answer, and it would be dropped again at the
/// far end by [`crate::customization::clean`].
fn answer(value: &Value) -> Option<Picked> {
    let question = number(value.get("option"))?;
    let swatch = number(value.get("choice"))?;
    Some(Picked {
        question: u32::try_from(question).ok().filter(|found| *found != 0)?,
        swatch: u32::try_from(swatch).ok().filter(|found| *found != 0)?,
    })
}

/// Every character's look out of the `characterLook` table the addon writes.
///
/// Shaped `{ ["Name-Realm"] = { race = …, sex = …, at = …, choices = { … } } }`.
///
/// **A character with no race contributes nothing at all**, and that is the one field that can
/// fail a whole entry. The race is what decides the body; without it there is nobody to draw, and
/// an entry that named only a hairstyle would put a character on the shortcut that does nothing
/// when it is picked. The choices are the other way round: absent is the ordinary state of a
/// character who has not been to a barber, and an empty list is a body drawn as the game opens it.
pub fn read(value: &Value) -> Vec<Look> {
    let Some(characters) = value.as_object() else {
        return Vec::new();
    };
    let mut found: Vec<Look> = characters
        .iter()
        .filter_map(|(character, entry)| {
            let mut picked: Vec<Picked> = entry
                .get("choices")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().filter_map(answer).collect())
                .unwrap_or_default();
            // The addon already sorts these, and sorting again is not distrust of it: this is a
            // file a player can edit, and two readings of an unchanged character should write the
            // same rows in the same order. One answer per question for the same reason `clean`
            // allows one — a body cannot wear two hairstyles.
            picked.sort_by_key(|answer| answer.question);
            picked.dedup_by_key(|answer| answer.question);
            Some(Look {
                character: character.clone(),
                race: number(entry.get("race"))?,
                // A client that named the race and not the sex is not a client this app has seen,
                // but a body of no sex is findable and a race of no body is not, so the sex is
                // allowed to be missing and the race is not.
                sex: number(entry.get("sex")).unwrap_or_default(),
                observed_at: number(entry.get("at")),
                picked,
            })
        })
        .collect();
    found.sort_by(|left, right| left.character.cmp(&right.character));
    found
}

/// The looks this install can actually draw, in the order they were given.
///
/// Every character whose race comes out at a body stays; the rest are dropped, because the
/// shortcut is a list of people the reader can become and a name that cannot be drawn is not one
/// of them. An install this app cannot read the tables of drops all of them, which is the same
/// answer the rest of the panel gives on such an install: nothing to offer, said once.
pub fn resolve(files: &dyn GameFiles, looks: &[Look]) -> Result<Vec<Known>, String> {
    let mut found = Vec::with_capacity(looks.len());
    for look in looks {
        if let Some(body) = look.body(files)? {
            found.push(Known {
                character: look.character.clone(),
                body,
                picked: look.picked.clone(),
            });
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::fixture_files;
    use serde_json::json;

    /// The fixtures' races and bodies, which are one of each way a race can name a body. See
    /// `body.rs`'s own tests, where the same numbers are read from the other end.
    const HUMAN: i64 = 1;
    const DRACTHYR: i64 = 4;
    const VULPERA: i64 = 5;
    const HUMAN_FEMALE: u32 = 2;
    const HUMAN_MALE: u32 = 1;
    const SEXLESS: u32 = 8;

    /// `UnitSex` as the client answers it, which is not how the tables number a sex.
    const MALE: i64 = 2;
    const FEMALE: i64 = 3;

    fn drawn(looks: &[Look]) -> Vec<Known> {
        resolve(&fixture_files(), looks).unwrap()
    }

    #[test]
    fn reads_a_character_the_addon_saw_at_the_barbers() {
        let found = read(&json!({
            "Aster-Vale": {
                "race": 1,
                "sex": 3,
                "at": 1_700_000_000,
                "choices": [{ "option": 14, "choice": 133 }, { "option": 16, "choice": 21 }],
            }
        }));

        assert_eq!(
            found,
            vec![Look {
                character: "Aster-Vale".into(),
                race: 1,
                sex: 3,
                observed_at: Some(1_700_000_000),
                picked: vec![
                    Picked { question: 14, swatch: 133 },
                    Picked { question: 16, swatch: 21 },
                ],
            }]
        );
    }

    /// Most of a roster. A character the addon has only ever seen walking around is a race and a
    /// sex, and that is enough to draw them on the right body.
    #[test]
    fn reads_a_character_who_has_never_had_a_haircut() {
        let found = read(&json!({ "Aster-Vale": { "race": 1, "sex": 2 } }));

        assert_eq!(found[0].picked, Vec::new());
        assert_eq!(found[0].observed_at, None);
    }

    /// The race is what decides the body, and a character with no body is one the shortcut would
    /// offer and then do nothing about.
    #[test]
    fn refuses_a_character_with_no_race() {
        let found = read(&json!({
            "Aster-Vale": { "sex": 3, "choices": [{ "option": 14, "choice": 133 }] },
            "Zia-Vale": { "race": 1, "sex": 3 },
        }));

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].character, "Zia-Vale");
    }

    /// Zero names no row of either table, so a pair carrying one is a hand-edited file rather
    /// than an answer — and the settings file at the far end would refuse the whole payload for it.
    #[test]
    fn refuses_an_answer_that_names_no_question_or_no_swatch() {
        let found = read(&json!({
            "Aster-Vale": { "race": 1, "sex": 3, "choices": [
                { "option": 0, "choice": 133 },
                { "option": 14, "choice": 0 },
                { "choice": 21 },
                { "option": 16, "choice": 21 },
            ] }
        }));

        assert_eq!(found[0].picked, vec![Picked { question: 16, swatch: 21 }]);
    }

    /// A body cannot wear two hairstyles, and a file a player edited by hand can say it does.
    #[test]
    fn keeps_one_answer_per_question() {
        let found = read(&json!({
            "Aster-Vale": { "race": 1, "sex": 3, "choices": [
                { "option": 16, "choice": 21 },
                { "option": 14, "choice": 133 },
                { "option": 16, "choice": 22 },
            ] }
        }));

        assert_eq!(
            found[0].picked,
            vec![
                Picked { question: 14, swatch: 133 },
                Picked { question: 16, swatch: 21 },
            ]
        );
    }

    /// By name, so two syncs of an unchanged file write the same rows in the same order.
    #[test]
    fn orders_the_characters_by_name() {
        let found = read(&json!({
            "Zia-Vale": { "race": 1, "sex": 3 },
            "Aster-Vale": { "race": 1, "sex": 2 },
        }));

        assert_eq!(found[0].character, "Aster-Vale");
        assert_eq!(found[1].character, "Zia-Vale");
    }

    #[test]
    fn survives_a_table_the_addon_has_never_written() {
        assert!(read(&Value::Null).is_empty());
        assert!(read(&json!([1, 2, 3])).is_empty());
    }

    /* ---------- and then the body they come out as ---------- */

    /// The translation the addon deliberately does not do: `UnitSex` counts from two and the
    /// game's own tables count from zero, so taking the client's number as the table's would
    /// draw every character as somebody the tables have no body for.
    #[test]
    fn draws_a_character_on_the_body_of_their_race_and_sex() {
        let looks = read(&json!({
            "Aster-Vale": { "race": HUMAN, "sex": FEMALE },
            "Bram-Vale": { "race": HUMAN, "sex": MALE },
        }));

        assert_eq!(
            drawn(&looks).iter().map(|known| known.body).collect::<Vec<_>>(),
            vec![HUMAN_FEMALE, HUMAN_MALE]
        );
    }

    #[test]
    fn carries_the_answers_through_to_the_body_they_are_about() {
        let looks = read(&json!({
            "Aster-Vale": {
                "race": HUMAN, "sex": FEMALE,
                "choices": [{ "option": 16, "choice": 133 }],
            }
        }));

        assert_eq!(
            drawn(&looks),
            vec![Known {
                character: "Aster-Vale".into(),
                body: HUMAN_FEMALE,
                picked: vec![Picked { question: 16, swatch: 133 }],
            }]
        );
    }

    /// A race whose one body the game gives no sex, which is what the Dracthyr is. Neither the
    /// client's number nor a client that would not say one should keep them off the list.
    #[test]
    fn draws_a_race_the_game_gives_one_body_whatever_the_client_said_about_sex() {
        let looks = read(&json!({
            "Aster-Vale": { "race": DRACTHYR, "sex": FEMALE },
            "Bram-Vale": { "race": DRACTHYR },
        }));

        assert_eq!(
            drawn(&looks).iter().map(|known| known.body).collect::<Vec<_>>(),
            vec![SEXLESS, SEXLESS]
        );
    }

    /// A character this install has no body for is left off rather than offered. The shortcut is
    /// a list of people the reader can become, and a name that draws nothing is not one.
    #[test]
    fn leaves_off_a_character_this_install_cannot_draw() {
        let looks = read(&json!({
            "Aster-Vale": { "race": VULPERA, "sex": MALE },
            "Zia-Vale": { "race": HUMAN, "sex": FEMALE },
        }));

        assert_eq!(
            drawn(&looks).iter().map(|known| known.character.as_str()).collect::<Vec<_>>(),
            vec!["Zia-Vale"]
        );
    }

    /// A file a player edited by hand can say a character is race minus four, and the answer to
    /// that is a character nobody can draw rather than a panel that will not open.
    #[test]
    fn leaves_off_a_character_whose_race_is_not_a_race() {
        let looks = read(&json!({ "Aster-Vale": { "race": -4, "sex": MALE } }));

        assert!(drawn(&looks).is_empty());
    }
}
