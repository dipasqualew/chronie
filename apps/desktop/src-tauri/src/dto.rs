//! Serializable command payloads.
//!
//! These are the Rust side of the desktop contract. Commands return these named shapes and
//! Tauri Specta generates the TypeScript client from them; the collector may still assemble
//! database rows dynamically inside its own boundary, but untyped JSON never crosses IPC.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

macro_rules! dto {
    ($name:ident { $($fields:tt)* }) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $($fields)* }
    };
}

macro_rules! string_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
        #[serde(rename_all = "camelCase")]
        pub enum $name { $($variant),+ }
    };
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum ActivityValue {
    Null(()),
    Bool(bool),
    Number(f64),
    String(String),
}

pub type ActivityMetadata = HashMap<String, ActivityValue>;

string_enum!(EquipsetChangeKind {
    Created,
    Deleted,
    Updated
});
string_enum!(CaptureImageState {
    None,
    Stored,
    Missing
});
string_enum!(ActivitySource { Inferred, Manual });
string_enum!(SameLookReason {
    Faction,
    Class,
    Reissue
});
string_enum!(GalleryKind { Worn, Held });
string_enum!(MarkSubjectKind {
    Set,
    Appearance,
    Custom
});

impl MarkSubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Set => "set",
            Self::Appearance => "appearance",
            Self::Custom => "custom",
        }
    }
}

dto!(AchievementEvent {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_first: Option<bool>,
});

dto!(LevelUpEvent {
    pub level: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
});

dto!(CollectibleEvent {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guid: Option<String>,
});

dto!(PetEvent {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub species_first: Option<bool>,
});

dto!(TransmogEvent {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "sourceID")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<i64>,
    #[serde(rename = "appearanceID")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_appearance: Option<bool>,
});

dto!(QuestEvent {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_first: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_first: Option<bool>,
});

dto!(HousingItemEvent {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warband_first: Option<bool>,
});

dto!(CurrencyGain {
    pub id: i64,
    pub name: String,
    pub amount: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
});

dto!(ReputationGain {
    pub faction: String,
    pub amount: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
});

dto!(EquipsetSlotChange {
    pub slot: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_level: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_item_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_item_level: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_item_name: Option<String>,
});

dto!(EquipsetChangeEvent {
    pub set_id: i64,
    pub name: String,
    pub kind: EquipsetChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[specta(optional)]
    pub items: Vec<EquipsetSlotChange>,
});

dto!(Capture {
    pub id: i64,
    pub source_id: String,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp: Option<String>,
    pub image_state: CaptureImageState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub achievement_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_map_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_y: Option<f64>,
});

dto!(EncounterEvent {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub difficulty_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_size: Option<i64>,
    pub success: bool,
});

dto!(Activity {
    pub id: i64,
    pub kind: String,
    pub source: ActivitySource,
    pub confidence: f64,
    pub metadata: ActivityMetadata,
});

dto!(KeystoneRun {
    pub level: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_id: Option<i64>,
    #[specta(optional)]
    pub affixes: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_time: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upgrades: Option<i64>,
});

dto!(ExperienceGain {
    pub gained: i64,
    pub percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_level: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_level: Option<i64>,
});

dto!(Segment {
    pub segment_id: i64,
    pub id: String,
    pub character: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<i64>,
    pub day: String,
    pub instance: String,
    pub difficulty: String,
    pub instance_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub difficulty_id: Option<i64>,
    pub started_at: i64,
    pub ended_at: i64,
    pub seconds: i64,
    pub loot_value: i64,
    pub gold_diff: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency_total: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reputation_total: Option<i64>,
    #[serde(rename = "housingXP")]
    pub housing_xp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expansion_tier: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_expansion_tier: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experience: Option<ExperienceGain>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keystone: Option<KeystoneRun>,
    #[specta(optional)]
    pub activities: Vec<Activity>,
    #[specta(optional)]
    pub captures: Vec<Capture>,
    #[specta(optional)]
    pub encounters: Vec<EncounterEvent>,
    #[specta(optional)]
    pub equipset_changes: Vec<EquipsetChangeEvent>,
    #[specta(optional)]
    pub transmogs: Vec<TransmogEvent>,
    #[specta(optional)]
    pub currencies: Vec<CurrencyGain>,
    #[specta(optional)]
    pub reputation: Vec<ReputationGain>,
    #[specta(optional)]
    pub achievements: Vec<AchievementEvent>,
    #[specta(optional)]
    pub level_ups: Vec<LevelUpEvent>,
    #[specta(optional)]
    pub mounts: Vec<CollectibleEvent>,
    #[specta(optional)]
    pub pets: Vec<PetEvent>,
    #[specta(optional)]
    pub quests: Vec<QuestEvent>,
    #[specta(optional)]
    pub toys: Vec<CollectibleEvent>,
    #[specta(optional)]
    pub housing_items: Vec<HousingItemEvent>,
    #[specta(optional)]
    pub housing_level_ups: Vec<LevelUpEvent>,
});

dto!(CurrencyHolder {
    pub character: String,
    pub total: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
});

dto!(AccountCurrency {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub total: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_wide: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest: Option<i64>,
    pub characters: Vec<CurrencyHolder>,
});

dto!(CharacterStanding {
    pub character: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
});

dto!(AccountFaction {
    pub faction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best: Option<CharacterStanding>,
    pub characters: Vec<CharacterStanding>,
});

dto!(GoldHolder {
    pub character: String,
    pub total: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
});

dto!(AccountGold {
    pub characters: Vec<GoldHolder>,
    pub wallets: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warband: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warband_at: Option<i64>,
    pub total: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest: Option<i64>,
});

dto!(AccountHoldings {
    pub currencies: Vec<AccountCurrency>,
    pub factions: Vec<AccountFaction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gold: Option<AccountGold>,
});

dto!(DashboardPayload {
    #[specta(optional)]
    pub generated_at: String,
    #[specta(optional)]
    pub known_activity_kinds: Vec<String>,
    #[specta(optional)]
    pub segments: Vec<Segment>,
    #[specta(optional)]
    pub holdings: AccountHoldings,
});

dto!(TransmogSet {
    pub id: u32,
    pub name: String,
    pub group: String,
    pub group_id: u32,
    pub class_mask: u32,
    pub expansion_id: u32,
    pub parent_id: u32,
    pub flags: u32,
    pub ui_order: u32,
    pub patch_introduced: u32,
    pub item_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternates: Option<Vec<Alternate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_look_as: Option<u32>,
});

dto!(Alternate {
    pub id: u32,
    pub name: String,
    pub group: String,
    pub class_mask: u32,
    pub expansion_id: u32,
    pub patch_introduced: u32,
    pub reason: SameLookReason,
});

dto!(TransmogPayload {
    pub sets: Vec<TransmogSet>,
    pub read_count: usize,
    pub declared_count: usize,
    pub withheld_count: usize,
});

dto!(TransmogAppearance {
    pub modified_appearance_id: u32,
    pub item_id: u32,
    pub name: String,
    pub appearance_id: u32,
    pub display_type: u32,
    pub inventory_type: u32,
    pub allowable_class: u32,
    pub required_level: u32,
    pub quality: u32,
    pub display_info_id: u32,
    pub icon_file_data_id: u32,
    pub has_model: bool,
});

dto!(TransmogSetItemsPayload {
    pub set_id: u32,
    pub appearances: Vec<TransmogAppearance>,
    pub read_count: usize,
    pub withheld_count: usize,
});

dto!(WardrobeAppearance {
    pub appearance_id: u32,
    pub item_id: u32,
    pub name: String,
    pub display_type: u32,
    pub inventory_type: u32,
    pub class_id: u32,
    pub subclass_id: u32,
    pub allowable_class: u32,
    pub required_level: u32,
    pub quality: u32,
    pub display_info_id: u32,
    pub icon_file_data_id: u32,
    pub has_model: bool,
    pub item_count: usize,
    pub lifts_restriction: bool,
});

dto!(WardrobePayload {
    pub display_types: Vec<u32>,
    pub appearances: Vec<WardrobeAppearance>,
    pub read_count: usize,
    pub withheld_count: usize,
});

dto!(CustomSetPiece {
    pub place: String,
    pub appearance_id: i64,
    pub item_id: i64,
    pub name: String,
    pub display_type: i64,
    pub inventory_type: i64,
    pub display_info_id: i64,
    pub icon_file_data_id: i64,
    pub has_model: bool,
});

dto!(InGameSetSlot {
    pub slot: i64,
    pub appearance_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_appearance_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub illusion_id: Option<i64>,
});

dto!(InGameSetAppearancesPayload {
    pub appearances: Vec<TransmogAppearance>,
    pub read_count: usize,
    pub withheld_count: usize,
});

dto!(IconsPayload {
    pub icons: HashMap<String, String>,
});

dto!(TransmogTag {
    pub key: String,
    pub value: Option<String>,
});

dto!(TransmogMark {
    pub kind: MarkSubjectKind,
    pub id: i64,
    pub favourite: bool,
    pub tags: Vec<TransmogTag>,
});

dto!(TransmogMarksPayload {
    pub marks: Vec<TransmogMark>,
});

dto!(CharacterModelPayload {
    pub model: String,
});

dto!(CharacterSwatch {
    pub id: u32,
    pub name: String,
});

dto!(CharacterQuestion {
    pub id: u32,
    pub name: String,
    pub swatches: Vec<CharacterSwatch>,
});

dto!(CharacterPick {
    pub question: u32,
    pub swatch: u32,
});

dto!(CharacterChosen {
    pub body: u32,
    pub picked: Vec<CharacterPick>,
});

dto!(CharacterBody {
    pub id: u32,
    pub name: String,
});

dto!(PlayedCharacter {
    pub character: String,
    pub body: u32,
    pub picked: Vec<CharacterPick>,
});

dto!(CharacterLookPayload {
    pub bodies: Vec<CharacterBody>,
    pub body: u32,
    pub questions: Vec<CharacterQuestion>,
    pub picked: Vec<CharacterPick>,
    pub characters: Vec<PlayedCharacter>,
});

dto!(WornPiece {
    pub display_info_id: u32,
    pub display_type: u32,
    pub inventory_type: u32,
});

dto!(WornSetPayload {
    pub model: Option<String>,
});

dto!(CharacterWornSetPayload {
    pub model: Option<String>,
    /// How much of the character the body is really theirs — see [`character::Likeness`].
    ///
    /// A shape of its own rather than a `WornSetPayload` with a field added, because the two
    /// commands are asking different questions: the wardrobe draws whoever the reader invented
    /// and there is nothing to be uncertain about, and this draws somebody the app has to
    /// recognise first and is frequently unable to.
    pub likeness: crate::character::Likeness,
});

dto!(GalleryModel {
    pub display_info_id: u32,
    pub kind: GalleryKind,
    pub model: Option<String>,
});

dto!(GalleryPayload {
    pub models: Vec<GalleryModel>,
});

dto!(SetGalleryModel {
    pub set_id: u32,
    pub model: Option<String>,
});

dto!(SetGalleryPayload {
    pub models: Vec<SetGalleryModel>,
});

dto!(AchievementDetail {
    pub id: u32,
    pub title: String,
    pub description: String,
    pub reward: String,
    pub category: Vec<String>,
    pub category_id: u32,
    pub points: u32,
    pub icon_file_data_id: u32,
    pub faction: i32,
});

dto!(AchievementDetailsPayload {
    pub achievements: HashMap<String, AchievementDetail>,
});

dto!(ItemDetail {
    pub id: u32,
    pub name: String,
    pub class_id: u32,
    pub subclass_id: u32,
    pub inventory_type: u32,
    pub quality: u32,
    pub required_level: u32,
    pub allowable_class: u32,
    pub icon_file_data_id: u32,
});

dto!(ItemDetailsPayload {
    pub items: HashMap<String, ItemDetail>,
});

dto!(ItemAppearance {
    pub appearance_id: u32,
    pub display_info_id: u32,
    pub display_type: u32,
    pub inventory_type: u32,
});

dto!(ItemAppearancesPayload {
    pub appearances: HashMap<String, ItemAppearance>,
});

dto!(CaptureThumbnailsPayload {
    pub thumbnails: HashMap<String, String>,
});

dto!(CaptureImagePayload {
    pub id: i64,
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<i64>,
});

dto!(SettingsPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wow_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<String>,
    #[specta(optional)]
    pub combat_logging: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retain_log_days: Option<u32>,
    #[specta(optional)]
    pub keep_original_screenshots: bool,
    #[specta(optional)]
    pub capture_quality: crate::captures::Quality,
    #[specta(optional)]
    pub capture_triggers: Vec<String>,
    #[specta(optional)]
    pub character_look: Vec<CharacterPick>,
    #[specta(optional)]
    pub character_body: u32,
});

dto!(QueryAnswer {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<QueryCell>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum QueryCell {
    Null(()),
    Integer(i64),
    Float(f64),
    String(String),
}

dto!(QueryColumn {
    pub name: String,
    pub kind: String,
    pub primary_key: bool,
});

dto!(QueryTable {
    pub name: String,
    pub view: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_count: Option<i64>,
    pub columns: Vec<QueryColumn>,
});

dto!(QuerySchema {
    pub tables: Vec<QueryTable>,
});

/// One value re-read as the shape the boundary declares, by way of JSON.
///
/// A failure here means the two shapes disagree, which is a bug in this crate rather than anything
/// a reader did — so it stays a string, and the boundary files it under
/// [`crate::failure::FailureCode::Internal`] like every other condition nobody has named.
pub fn convert<T: Serialize, U: DeserializeOwned>(value: T) -> Result<U, String> {
    serde_json::to_value(value)
        .map_err(|error| error.to_string())
        .and_then(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
}
