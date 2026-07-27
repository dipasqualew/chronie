//! The geometry behind one appearance, from a display id to something a window can show.
//!
//! Four of the game's tables stand between "the reader clicked a helm" and a mesh:
//! `ItemDisplayInfo` says which model resource and which material the appearance uses,
//! `ModelFileData` turns the first into the FileDataID of an `.m2`, and `TextureFileData`
//! turns the second into a `.blp`. That chain is written down in `docs/game-files.md`,
//! verified against a real install.
//!
//! Only heads, shoulders, weapons and shields get this far. Everything between them — chest,
//! waist, legs, feet, wrist, hands, back, tabard — has no model at all and is texture painted
//! onto the character's body, which is the work in `docs/character-rendering.md` rather than
//! here. Those appearances answer with nothing, and the window keeps showing their icon.

use std::cell::RefCell;

use serde_json::{json, Value};

use crate::casc::GameFiles;
use crate::db2::Db2;
use crate::glb;
use crate::icons::{data_url, png_of};
use crate::m2::{Model, Paint};
use crate::transmog::{display_column, ITEM_DISPLAY_INFO, MODEL_SLOTS, MODEL_SLOT_BITS};

/// `ModelFileData` — every `.m2` the client owns, keyed by the resource that names it.
///
/// Shared with `worn`, which asks it the same question for a model that goes on a body.
pub const MODEL_FILE_DATA: u32 = 1337833;
/// `TextureFileData` — the same for `.blp`s.
///
/// Shared with `worn`, which asks it a wider question: an item's model wants the one file its
/// material names, and a body texture wants every file it names so that another table can say
/// which of them was painted for the character being drawn.
pub const TEXTURE_FILE_DATA: u32 = 982459;

/// The one column of `ModelFileData` that is not the row id: which model resource the file is.
pub const MODEL_RESOURCES_ID: usize = 4;
/// The same for `TextureFileData`.
pub const MATERIAL_RESOURCES_ID: usize = 2;

/// The largest texture worth re-encoding for a model.
///
/// Item textures are authored at a few hundred pixels a side. The composited character atlas
/// is 2048 wide and is the largest thing the game paints anything with, so nothing above that
/// is a texture that belongs on an item.
const LARGEST_TEXTURE: u32 = 2048;

/// The model an appearance is drawn with, as a `.glb`, or nothing when it has none.
///
/// A `null` model is an ordinary answer rather than a failure. Most armour has no geometry to
/// show; an install can be missing the file an appearance names; and the game withholds
/// content it has not shipped. All three leave the window showing the icon it already has.
/// What does fail is a model that is there and cannot be read, because that is this app being
/// wrong about the format rather than the install being short of a file.
pub fn model_of(files: &dyn GameFiles, display_info_id: u32) -> Result<Value, String> {
    Ok(match glb_of(files, display_info_id)? {
        Some(glb) => json!({
            "displayInfoId": display_info_id,
            "model": data_url("model/gltf-binary", &glb),
        }),
        None => json!({ "displayInfoId": display_info_id, "model": Value::Null }),
    })
}

/// The same, as the `.glb` bytes themselves — which is what `dump_model` writes to a file.
pub fn glb_of(files: &dyn GameFiles, display_info_id: u32) -> Result<Option<Vec<u8>>, String> {
    let Some((slot, model_resource, material_resource)) = resources(files, display_info_id)?
    else {
        return Ok(None);
    };

    // The same question `worn` asks of a helm about to go on a head, and the same answer: a
    // model resource names a file per body, or a pair of files one per shoulder, and this app
    // draws one body and one shoulder at a time. The slot is which shoulder.
    let Some(model_file) = crate::worn::model_file(files, model_resource, slot)? else {
        return Ok(None);
    };
    let Ok(bytes) = files.read(model_file) else {
        return Ok(None);
    };

    let model = Model::parse(&bytes)?;
    let skin = model
        .skin_file_data_id()
        .ok_or("the model names no skin profile, so nothing says how to draw it")?;
    let mesh = model.with_skin(&files.read(skin)?)?;

    // The one texture the item itself supplies, resolved the first time a part asks for it
    // and not before: `TextureFileData` is a table with a row per texture the client owns,
    // and a model that paints itself entirely out of its own `TXID` never needs it opened.
    let supplied: RefCell<Option<Option<u32>>> = RefCell::new(None);
    let picture = |paint| {
        let texture = match paint {
            Paint::File(fdid) => Some(fdid),
            // Whichever type asked: an item's model wants one texture and the appearance's
            // material is it. Only a character declares several and has to tell them apart.
            Paint::Supplied(_) => *supplied.borrow_mut().get_or_insert_with(|| match material_resource {
                0 => None,
                resource => file_named(files, TEXTURE_FILE_DATA, MATERIAL_RESOURCES_ID, resource)
                    .ok()
                    .flatten(),
            }),
        }?;
        // A texture that will not decode leaves its part grey rather than failing the model:
        // the shape of a helm is most of what a reader opened it for.
        files.read(texture).and_then(|blp| png_of(&blp, LARGEST_TEXTURE)).ok()
    };
    Ok(Some(glb::write(&[glb::Piece::only(&mesh, &picture)])?))
}

/// What a display says it is drawn with: a model slot, its resource, and the material that
/// paints it.
///
/// Both arrays are of two. This shows the first slot that holds anything, which for a helm or
/// a weapon is the whole of it — and for a pair of shoulders is one pad. Showing both is what
/// [`crate::character`] does now, because both is only meaningful once there is a body with a
/// shoulder on either side of it to hang them from.
fn resources(
    files: &dyn GameFiles,
    display_info_id: u32,
) -> Result<Option<(usize, u32, u32)>, String> {
    let displays = Db2::parse(files.read(ITEM_DISPLAY_INFO)?)?;
    let Some(display) = displays.rows().find(|row| row.id() == display_info_id) else {
        return Ok(None);
    };
    Ok((0..MODEL_SLOTS)
        .map(|slot| {
            (
                slot,
                display.element(display_column::MODEL_RESOURCES_ID, slot, MODEL_SLOT_BITS),
                display.element(display_column::MATERIAL_RESOURCES_ID, slot, MODEL_SLOT_BITS),
            )
        })
        .find(|(_, model, _)| *model != 0))
}

/// The FileDataID of the one file in `table` that is the given resource.
///
/// A resource can name more than one file — a texture and its second usage sit under the same
/// id — and the client numbers a file's variants above the file itself, so the lowest id is
/// the one to draw. That rule is enough for a *texture*: `worn` is where the one that names a
/// file per body lives, because the table that says which body is which is a different one.
pub(crate) fn file_named(
    files: &dyn GameFiles,
    table: u32,
    column: usize,
    resource: u32,
) -> Result<Option<u32>, String> {
    let table = Db2::parse(files.read(table)?)?;
    Ok(table
        .rows()
        .filter(|row| row.number(column) == resource)
        .map(|row| row.id())
        .min())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::casc::{fixture_files, DirFiles};

    /// The fixture displays, by what the generator made each of them.
    const HELM: u32 = 900001;
    const SHOULDERS: u32 = 900002;
    const CHESTPIECE: u32 = 900003;
    const WEAPON: u32 = 900007;
    /// Shoulders whose only model sits in the second of the two slots.
    const SECOND_SLOT_ONLY: u32 = 900009;
    /// A display in a section the game encrypts, so nothing can be read about it.
    const WITHHELD: u32 = 900900;

    fn model(display_info_id: u32) -> Value {
        model_of(&fixture_files(), display_info_id).unwrap()
    }

    /// The `.glb` out of an answer, decoded back from the data URL the window receives.
    fn glb(answer: &Value) -> Vec<u8> {
        let url = answer["model"].as_str().expect("the answer holds a model");
        let encoded = url
            .strip_prefix("data:model/gltf-binary;base64,")
            .unwrap_or_else(|| panic!("not a glb data url: {url}"));
        use base64::{engine::general_purpose::STANDARD, Engine};
        STANDARD.decode(encoded).unwrap()
    }

    /// The JSON half of a `.glb`, which is where everything worth asserting on lives.
    fn scene(bytes: &[u8]) -> Value {
        let length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        serde_json::from_slice(&bytes[20..20 + length]).unwrap()
    }

    /// Fixture files that remember what was asked of them.
    struct Noted {
        files: DirFiles,
        asked: RefCell<Vec<u32>>,
    }

    impl Noted {
        fn new() -> Self {
            Self {
                files: fixture_files(),
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl GameFiles for Noted {
        fn read(&self, fdid: u32) -> Result<Vec<u8>, String> {
            self.asked.borrow_mut().push(fdid);
            self.files.read(fdid)
        }
    }

    // The chain the module exists for: a display id, four tables later, is a scene with
    // geometry and a picture in it.
    #[test]
    fn walks_a_display_down_to_a_model_a_window_can_show() {
        let answer = model(HELM);
        assert_eq!(answer["displayInfoId"], HELM);
        let scene = scene(&glb(&answer));
        assert_eq!(scene["asset"]["version"], "2.0");
        assert_eq!(scene["meshes"][0]["primitives"].as_array().unwrap().len(), 1);
        assert_eq!(scene["accessors"][0]["count"], 8);
        assert_eq!(scene["images"][0]["mimeType"], "image/png");
    }

    // The files a read opens are the behaviour: the helm's own texture comes out of the
    // model's `TXID`, and the item's material is only read when a part asks for it.
    #[test]
    fn reads_the_model_its_skin_and_the_textures_the_two_of_them_name() {
        let files = Noted::new();
        model_of(&files, HELM).unwrap();
        assert_eq!(
            files.asked.into_inner(),
            vec![
                ITEM_DISPLAY_INFO,
                MODEL_FILE_DATA,
                // Which of the resource's three files is this body's, which is a table of
                // its own — and the reason a helm shown alone is the same helm worn.
                1_349_053, // ComponentModelFileData
                140001, // the helm's .m2
                141001, // the skin profile its SFID names
                150001, // the texture its TXID names
            ]
        );
    }

    // A mesh that leaves its texture to the item is what makes one model serve every recolour
    // of it, and resolving that goes through a different table than the model's own textures.
    #[test]
    fn paints_a_model_with_the_texture_the_item_supplies() {
        let files = Noted::new();
        let answer = model_of(&files, SHOULDERS).unwrap();
        let asked = files.asked.into_inner();
        assert!(asked.contains(&TEXTURE_FILE_DATA), "{asked:?}");
        // 51002 is the shoulder's first material, and 150002 the texture the table gives it.
        assert!(asked.contains(&150002), "{asked:?}");
        assert_eq!(scene(&glb(&answer))["images"].as_array().unwrap().len(), 1);
    }

    // Shoulders keep a left model and a right one, and a display can fill either slot. A
    // reader that stopped at the first would call half the shoulders in the game flat.
    #[test]
    fn finds_a_model_kept_only_in_the_second_slot() {
        let files = Noted::new();
        let answer = model_of(&files, SECOND_SLOT_ONLY).unwrap();
        assert!(answer["model"].is_string());
        // 41005 is that display's second model resource, and 140005 the file behind it.
        assert!(files.asked.into_inner().contains(&140005));
    }

    // Most of a set is armour, which has no geometry at all — and that is the ordinary case
    // rather than a failure, because the row it belongs to still has its icon.
    #[test]
    fn answers_with_nothing_for_an_appearance_that_has_no_model() {
        assert_eq!(model(CHESTPIECE), json!({ "displayInfoId": CHESTPIECE, "model": null }));
    }

    // The two ways an install can hold no answer: a display in a section the game encrypts,
    // and one this build's tables do not mention at all.
    #[test]
    fn answers_with_nothing_for_a_display_it_cannot_read() {
        assert_eq!(model(WITHHELD)["model"], Value::Null);
        assert_eq!(model(404_040)["model"], Value::Null);
    }

    // A weapon is the other half of what has geometry, and the one whose model the fixture
    // splits across two levels of the index list.
    #[test]
    fn shows_a_weapon_as_well_as_a_helm() {
        let scene = scene(&glb(&model(WEAPON)));
        assert_eq!(scene["meshes"][0]["primitives"].as_array().unwrap().len(), 2);
    }

    // A model the install does not hold is a gap in the install, not a broken app — but a
    // model that is there and will not parse is this app being wrong about the format, and
    // saying so beats a row that silently keeps its icon.
    #[test]
    fn tells_a_missing_model_apart_from_an_unreadable_one() {
        // Display 900010 names a model resource whose file the fixture directory omits.
        assert_eq!(model(900_010)["model"], Value::Null);
        // Display 900011 names one that is there and holds no MD21 chunk.
        let error = model_of(&fixture_files(), 900_011).unwrap_err();
        assert!(error.contains("MD21"), "{error}");
    }

    // The browser tests load `helm.glb` into three.js, which is the only place anything
    // actually reads what this module writes. That is worth nothing if the file has drifted
    // from what the converter now produces, so this is what ties the two together:
    //
    //     cargo run --example dump_model -- --fixtures apps/desktop/fixtures/transmog \
    //         900001 apps/desktop/fixtures/transmog/helm.glb
    #[test]
    fn writes_the_glb_the_browser_tests_load() {
        let committed = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("fixtures")
                .join("transmog")
                .join("helm.glb"),
        )
        .expect("the fixture glb is committed");
        assert_eq!(
            glb_of(&fixture_files(), HELM).unwrap(),
            Some(committed),
            "helm.glb is stale; regenerate it with the dump_model example"
        );
    }

    #[test]
    fn says_so_when_the_chain_starts_at_a_table_that_is_not_there() {
        let temp = tempfile::tempdir().unwrap();
        let error = model_of(&DirFiles::new(temp.path()), HELM).unwrap_err();
        assert!(error.contains("1266429.db2"), "{error}");
    }
}
