//! The tolerant wire format written by the addon, and the normalized segment domain.
//!
//! SavedVariables are a compatibility boundary rather than trusted Rust input. Every wire
//! field is optional and independently tolerant: a hand-edited scalar or one malformed event
//! is ignored without costing the rest of its segment. Normalization is the one place that
//! decides which fields identify a segment and which historical omissions receive defaults.

use chrono::{DateTime, Local};
use serde::{de::DeserializeOwned, Deserialize, Deserializer};
use serde_json::Value;
use std::collections::BTreeMap;

pub const CURRENT_SEGMENT_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaCompatibility {
    Legacy,
    Current,
    Older(i64),
    Newer(i64),
}

/// One account's top-level `ChronieDB` table.
///
/// Unknown fields are deliberately ignored by serde. Fields whose own readers already define
/// a typed boundary remain as values here and are handed to those readers; the collector itself
/// never indexes the root by a string key.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawSavedVariables {
    #[serde(deserialize_with = "tolerant_option")]
    pub segment_schema_version: Option<i64>,
    #[serde(deserialize_with = "tolerant_vec")]
    pub segments: Vec<RawSegment>,
    #[serde(deserialize_with = "tolerant_map")]
    pub activities: BTreeMap<String, RawLockoutActivity>,
    #[serde(deserialize_with = "tolerant_nested_map")]
    pub characters: BTreeMap<String, BTreeMap<String, RawLockout>>,
    #[serde(deserialize_with = "tolerant_map")]
    pub roster: BTreeMap<String, RawRosterEntry>,
    #[serde(deserialize_with = "tolerant_map")]
    pub holdings: BTreeMap<String, RawHoldingSnapshot>,
    #[serde(deserialize_with = "tolerant_default")]
    pub warband: RawWarband,
    pub custom_sets: Value,
    pub custom_set_requests: Value,
    pub character_look: Value,
    pub entries: Value,
}

impl RawSavedVariables {
    pub fn compatibility(&self) -> SchemaCompatibility {
        match self.segment_schema_version {
            None => SchemaCompatibility::Legacy,
            Some(CURRENT_SEGMENT_SCHEMA_VERSION) => SchemaCompatibility::Current,
            Some(version) if version < CURRENT_SEGMENT_SCHEMA_VERSION => {
                SchemaCompatibility::Older(version)
            }
            Some(version) => SchemaCompatibility::Newer(version),
        }
    }

    /// Every known version uses the same tolerant normalization today.
    ///
    /// Legacy and older files gain the defaults below; newer files are read best-effort with
    /// unknown fields ignored. Keeping the match explicit makes a future incompatible version
    /// choose its policy here instead of accidentally inheriting the current one.
    pub fn take_segments(&mut self) -> Vec<Segment> {
        let raw = std::mem::take(&mut self.segments);
        match self.compatibility() {
            SchemaCompatibility::Legacy
            | SchemaCompatibility::Current
            | SchemaCompatibility::Older(_)
            | SchemaCompatibility::Newer(_) => normalize_segments(raw),
        }
    }
}

pub fn read(value: Value) -> RawSavedVariables {
    serde_json::from_value(value).unwrap_or_default()
}

fn normalize_segments(raw: Vec<RawSegment>) -> Vec<Segment> {
    raw.into_iter().filter_map(RawSegment::normalize).collect()
}

fn tolerant_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    Ok(serde_json::from_value(value).ok())
}

fn tolerant_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    Ok(value_or_empty_table(value).unwrap_or_default())
}

fn value_or_empty_table<T>(value: Value) -> Option<T>
where
    T: Default + DeserializeOwned,
{
    match value {
        // Lua serializes both an empty list and an empty map as `{}`. At a typed map/table
        // position the surrounding field supplies the missing distinction.
        Value::Array(entries) if entries.is_empty() => Some(T::default()),
        value => serde_json::from_value(value).ok(),
    }
}

fn tolerant_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    let Value::Array(entries) = value else {
        return Ok(Vec::new());
    };
    Ok(entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

fn tolerant_map<'de, D, T>(deserializer: D) -> Result<BTreeMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: Default + DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    let Value::Object(entries) = value else {
        return Ok(BTreeMap::new());
    };
    Ok(entries
        .into_iter()
        .filter_map(|(key, entry)| value_or_empty_table(entry).map(|value| (key, value)))
        .collect())
}

fn tolerant_nested_map<'de, D, T>(
    deserializer: D,
) -> Result<BTreeMap<String, BTreeMap<String, T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Default + DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    let Value::Object(outer) = value else {
        return Ok(BTreeMap::new());
    };
    Ok(outer
        .into_iter()
        .filter_map(|(outer_key, entries)| {
            let entries = match entries {
                Value::Object(entries) => entries,
                // Lua's empty table carries no evidence of whether it was a list or a map.
                // Here the containing field says it is a map, and an explicitly empty map is
                // meaningful: it clears a character's current lockouts.
                Value::Array(entries) if entries.is_empty() => serde_json::Map::new(),
                _ => return None,
            };
            let inner = entries
                .into_iter()
                .filter_map(|(key, entry)| value_or_empty_table(entry).map(|value| (key, value)))
                .collect();
            Some((outer_key, inner))
        })
        .collect())
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawSegment {
    #[serde(deserialize_with = "tolerant_option")]
    id: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    character: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    class_file: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    level: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    day: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    instance: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    difficulty: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    instance_type: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    difficulty_id: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    started_at: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    ended_at: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    seconds: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    loot_value: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    gold_diff: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    currency_total: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    reputation_total: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    housing_xp: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    expansion_tier: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    latest_expansion_tier: Option<i64>,
    #[serde(deserialize_with = "tolerant_vec")]
    transmogs: Vec<RawTransmogEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    currencies: Vec<RawCurrencyGain>,
    #[serde(deserialize_with = "tolerant_vec")]
    reputation: Vec<RawReputationGain>,
    #[serde(deserialize_with = "tolerant_vec")]
    achievements: Vec<RawAchievementEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    level_ups: Vec<RawLevelUpEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    mounts: Vec<RawCollectionEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    pets: Vec<RawPetEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    quests: Vec<RawQuestEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    toys: Vec<RawCollectionEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    housing_items: Vec<RawHousingItemEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    housing_level_ups: Vec<RawLevelUpEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    encounters: Vec<RawEncounterEvent>,
    #[serde(deserialize_with = "tolerant_vec")]
    equipset_changes: Vec<RawEquipsetChange>,
    #[serde(deserialize_with = "tolerant_option")]
    keystone: Option<RawKeystone>,
    #[serde(deserialize_with = "tolerant_option")]
    delve: Option<RawDelve>,
    #[serde(deserialize_with = "tolerant_option")]
    experience: Option<RawExperience>,
}

impl RawSegment {
    pub fn normalize(self) -> Option<Segment> {
        let ended_at = self.ended_at?;
        Some(Segment {
            id: self.id?,
            character: self.character?,
            class_file: self.class_file,
            level: self.level,
            day: self.day.unwrap_or_else(|| {
                DateTime::from_timestamp(ended_at, 0)
                    .map(|date| date.with_timezone(&Local).format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| "Unknown".to_string())
            }),
            instance: self.instance.unwrap_or_else(|| "Unknown".to_string()),
            difficulty: self.difficulty.unwrap_or_default(),
            instance_type: self.instance_type.unwrap_or_default(),
            difficulty_id: self.difficulty_id,
            started_at: self.started_at.unwrap_or(ended_at),
            ended_at,
            seconds: self.seconds.unwrap_or_default(),
            loot_value: self.loot_value.unwrap_or_default(),
            gold_diff: self.gold_diff.unwrap_or_default(),
            currency_total: self.currency_total.unwrap_or_default(),
            reputation_total: self.reputation_total.unwrap_or_default(),
            housing_xp: self.housing_xp.unwrap_or_default(),
            expansion_tier: self.expansion_tier,
            latest_expansion_tier: self.latest_expansion_tier,
            transmogs: self
                .transmogs
                .into_iter()
                .filter_map(RawTransmogEvent::normalize)
                .collect(),
            currencies: self
                .currencies
                .into_iter()
                .filter_map(RawCurrencyGain::normalize)
                .collect(),
            reputation: self
                .reputation
                .into_iter()
                .filter_map(RawReputationGain::normalize)
                .collect(),
            achievements: self
                .achievements
                .into_iter()
                .filter_map(RawAchievementEvent::normalize)
                .collect(),
            level_ups: self
                .level_ups
                .into_iter()
                .filter_map(RawLevelUpEvent::normalize)
                .collect(),
            mounts: self
                .mounts
                .into_iter()
                .filter_map(RawCollectionEvent::normalize)
                .collect(),
            pets: self
                .pets
                .into_iter()
                .filter_map(RawPetEvent::normalize)
                .collect(),
            quests: self
                .quests
                .into_iter()
                .filter_map(RawQuestEvent::normalize)
                .collect(),
            toys: self
                .toys
                .into_iter()
                .filter_map(RawCollectionEvent::normalize)
                .collect(),
            housing_items: self
                .housing_items
                .into_iter()
                .filter_map(RawHousingItemEvent::normalize)
                .collect(),
            housing_level_ups: self
                .housing_level_ups
                .into_iter()
                .filter_map(RawLevelUpEvent::normalize)
                .collect(),
            encounters: self
                .encounters
                .into_iter()
                .filter_map(RawEncounterEvent::normalize)
                .collect(),
            equipset_changes: self
                .equipset_changes
                .into_iter()
                .filter_map(RawEquipsetChange::normalize)
                .collect(),
            keystone: self.keystone.map(RawKeystone::normalize),
            delve: self.delve.map(RawDelve::normalize),
            experience: self.experience.map(RawExperience::normalize),
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Segment {
    pub id: String,
    pub character: String,
    pub class_file: Option<String>,
    pub level: Option<i64>,
    pub day: String,
    pub instance: String,
    pub difficulty: String,
    pub instance_type: String,
    pub difficulty_id: Option<i64>,
    pub started_at: i64,
    pub ended_at: i64,
    pub seconds: i64,
    pub loot_value: i64,
    pub gold_diff: i64,
    pub currency_total: i64,
    pub reputation_total: i64,
    pub housing_xp: i64,
    pub expansion_tier: Option<i64>,
    pub latest_expansion_tier: Option<i64>,
    pub transmogs: Vec<TransmogEvent>,
    pub currencies: Vec<CurrencyGain>,
    pub reputation: Vec<ReputationGain>,
    pub achievements: Vec<AchievementEvent>,
    pub level_ups: Vec<LevelUpEvent>,
    pub mounts: Vec<CollectionEvent>,
    pub pets: Vec<PetEvent>,
    pub quests: Vec<QuestEvent>,
    pub toys: Vec<CollectionEvent>,
    pub housing_items: Vec<HousingItemEvent>,
    pub housing_level_ups: Vec<LevelUpEvent>,
    pub encounters: Vec<EncounterEvent>,
    pub equipset_changes: Vec<EquipsetChange>,
    pub keystone: Option<Keystone>,
    pub delve: Option<Delve>,
    pub experience: Option<Experience>,
}

macro_rules! optional_fields {
    ($name:ident { $($field:ident: $kind:ty),* $(,)? }) => {
        #[derive(Debug, Default, Deserialize)]
        #[serde(default, rename_all = "camelCase")]
        pub struct $name {
            $(
                #[serde(deserialize_with = "tolerant_option")]
                pub $field: Option<$kind>,
            )*
        }
    };
}

optional_fields!(RawTransmogEvent {
    id: i64,
    at: i64,
    source_id: i64,
    appearance_id: i64,
    new_appearance: bool,
});

impl RawTransmogEvent {
    fn normalize(self) -> Option<TransmogEvent> {
        Some(TransmogEvent {
            id: self.id?,
            at: self.at,
            source_id: self.source_id,
            appearance_id: self.appearance_id,
            new_appearance: self.new_appearance,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransmogEvent {
    pub id: i64,
    pub at: Option<i64>,
    pub source_id: Option<i64>,
    pub appearance_id: Option<i64>,
    pub new_appearance: Option<bool>,
}

optional_fields!(RawCurrencyGain {
    id: i64,
    name: String,
    amount: i64,
    total: i64,
});

impl RawCurrencyGain {
    fn normalize(self) -> Option<CurrencyGain> {
        Some(CurrencyGain {
            id: self.id?,
            name: self.name.unwrap_or_else(|| "Unknown".to_string()),
            amount: self.amount.unwrap_or_default(),
            total: self.total,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CurrencyGain {
    pub id: i64,
    pub name: String,
    pub amount: i64,
    pub total: Option<i64>,
}

optional_fields!(RawReputationGain {
    faction: String,
    amount: i64,
    standing: String,
    current: i64,
    max: i64,
    rank: i64,
    system: String,
});

impl RawReputationGain {
    fn normalize(self) -> Option<ReputationGain> {
        Some(ReputationGain {
            faction: self.faction?,
            amount: self.amount.unwrap_or_default(),
            standing: self.standing,
            current: self.current,
            max: self.max,
            rank: self.rank,
            system: self.system,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReputationGain {
    pub faction: String,
    pub amount: i64,
    pub standing: Option<String>,
    pub current: Option<i64>,
    pub max: Option<i64>,
    pub rank: Option<i64>,
    pub system: Option<String>,
}

optional_fields!(RawAchievementEvent {
    id: i64,
    name: String,
    at: i64,
    account_first: bool,
});

impl RawAchievementEvent {
    fn normalize(self) -> Option<AchievementEvent> {
        Some(AchievementEvent {
            id: self.id?,
            name: self.name,
            at: self.at,
            account_first: self.account_first,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AchievementEvent {
    pub id: i64,
    pub name: Option<String>,
    pub at: Option<i64>,
    pub account_first: Option<bool>,
}

optional_fields!(RawLevelUpEvent {
    level: i64,
    at: i64
});

impl RawLevelUpEvent {
    fn normalize(self) -> Option<LevelUpEvent> {
        Some(LevelUpEvent {
            level: self.level?,
            at: self.at,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LevelUpEvent {
    pub level: i64,
    pub at: Option<i64>,
}

optional_fields!(RawCollectionEvent {
    id: i64,
    name: String,
    at: i64,
    guid: String,
});

impl RawCollectionEvent {
    fn normalize(self) -> Option<CollectionEvent> {
        Some(CollectionEvent {
            id: self.id?,
            name: self.name,
            at: self.at,
            guid: self.guid,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionEvent {
    pub id: i64,
    pub name: Option<String>,
    pub at: Option<i64>,
    pub guid: Option<String>,
}

optional_fields!(RawPetEvent {
    id: i64,
    name: String,
    at: i64,
    guid: String,
    species_first: bool,
});

impl RawPetEvent {
    fn normalize(self) -> Option<PetEvent> {
        Some(PetEvent {
            id: self.id?,
            name: self.name,
            at: self.at,
            guid: self.guid,
            species_first: self.species_first,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PetEvent {
    pub id: i64,
    pub name: Option<String>,
    pub at: Option<i64>,
    pub guid: Option<String>,
    pub species_first: Option<bool>,
}

optional_fields!(RawQuestEvent {
    id: i64,
    at: i64,
    name: String,
    character_first: bool,
    account_first: bool,
});

impl RawQuestEvent {
    fn normalize(self) -> Option<QuestEvent> {
        Some(QuestEvent {
            id: self.id?,
            at: self.at,
            name: self.name,
            character_first: self.character_first,
            account_first: self.account_first,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestEvent {
    pub id: i64,
    pub at: Option<i64>,
    pub name: Option<String>,
    pub character_first: Option<bool>,
    pub account_first: Option<bool>,
}

optional_fields!(RawHousingItemEvent {
    id: i64,
    name: String,
    at: i64,
    warband_first: bool,
});

impl RawHousingItemEvent {
    fn normalize(self) -> Option<HousingItemEvent> {
        Some(HousingItemEvent {
            id: self.id?,
            name: self.name,
            at: self.at,
            warband_first: self.warband_first,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HousingItemEvent {
    pub id: i64,
    pub name: Option<String>,
    pub at: Option<i64>,
    pub warband_first: Option<bool>,
}

optional_fields!(RawEncounterEvent {
    id: i64,
    name: String,
    at: i64,
    difficulty_id: i64,
    group_size: i64,
    success: bool,
});

impl RawEncounterEvent {
    fn normalize(self) -> Option<EncounterEvent> {
        Some(EncounterEvent {
            id: self.id?,
            name: self.name,
            at: self.at,
            difficulty_id: self.difficulty_id,
            group_size: self.group_size,
            success: self.success.unwrap_or(false),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EncounterEvent {
    pub id: i64,
    pub name: Option<String>,
    pub at: Option<i64>,
    pub difficulty_id: Option<i64>,
    pub group_size: Option<i64>,
    pub success: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawEquipsetChange {
    #[serde(deserialize_with = "tolerant_option")]
    set_id: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    name: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    kind: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    at: Option<i64>,
    #[serde(deserialize_with = "tolerant_vec")]
    items: Vec<RawEquipsetItem>,
}

impl RawEquipsetChange {
    fn normalize(self) -> Option<EquipsetChange> {
        let kind = match self.kind.as_deref()? {
            "created" => EquipsetChangeKind::Created,
            "deleted" => EquipsetChangeKind::Deleted,
            "updated" => EquipsetChangeKind::Updated,
            _ => return None,
        };
        Some(EquipsetChange {
            set_id: self.set_id?,
            name: self.name.unwrap_or_default(),
            kind,
            at: self.at,
            items: self
                .items
                .into_iter()
                .filter_map(RawEquipsetItem::normalize)
                .collect(),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EquipsetChange {
    pub set_id: i64,
    pub name: String,
    pub kind: EquipsetChangeKind,
    pub at: Option<i64>,
    pub items: Vec<EquipsetItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EquipsetChangeKind {
    Created,
    Deleted,
    Updated,
}

impl EquipsetChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Deleted => "deleted",
            Self::Updated => "updated",
        }
    }
}

optional_fields!(RawEquipsetItem {
    slot: i64,
    item_id: i64,
    item_level: i64,
    item_name: String,
});

impl RawEquipsetItem {
    fn normalize(self) -> Option<EquipsetItem> {
        Some(EquipsetItem {
            slot: self.slot?,
            item_id: self.item_id,
            item_level: self.item_level,
            item_name: self.item_name,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EquipsetItem {
    pub slot: i64,
    pub item_id: Option<i64>,
    pub item_level: Option<i64>,
    pub item_name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawKeystone {
    #[serde(deserialize_with = "tolerant_option")]
    level: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    map_id: Option<i64>,
    #[serde(deserialize_with = "tolerant_vec")]
    affixes: Vec<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    started_at: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    completed_at: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    completed: Option<bool>,
    #[serde(deserialize_with = "tolerant_option")]
    duration_ms: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    on_time: Option<bool>,
    #[serde(deserialize_with = "tolerant_option")]
    upgrades: Option<i64>,
}

impl RawKeystone {
    fn normalize(self) -> Keystone {
        Keystone {
            level: self.level,
            map_id: self.map_id,
            affixes: self.affixes,
            started_at: self.started_at,
            completed_at: self.completed_at,
            completed: self.completed.unwrap_or(false),
            duration_ms: self.duration_ms,
            on_time: self.on_time,
            upgrades: self.upgrades,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Keystone {
    pub level: Option<i64>,
    pub map_id: Option<i64>,
    pub affixes: Vec<i64>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub completed: bool,
    pub duration_ms: Option<i64>,
    pub on_time: Option<bool>,
    pub upgrades: Option<i64>,
}

optional_fields!(RawDelve {
    tier: i64,
    scenario_id: i64,
    started_at: i64,
    completed_at: i64,
    completed: bool,
});

impl RawDelve {
    fn normalize(self) -> Delve {
        Delve {
            tier: self.tier,
            scenario_id: self.scenario_id,
            started_at: self.started_at,
            completed_at: self.completed_at,
            completed: self.completed.unwrap_or(false),
        }
    }
}

/// One delve, as the addon watched it. The delve's name is the segment's own instance name —
/// a delve is an instance — so what is kept here is only what a segment cannot otherwise say:
/// the tier it was run at, and which of the delve's stories the client rolled.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Delve {
    pub tier: Option<i64>,
    pub scenario_id: Option<i64>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub completed: bool,
}

optional_fields!(RawExperience {
    gained: i64,
    percent: f64,
    start_level: i64,
    end_level: i64,
});

impl RawExperience {
    fn normalize(self) -> Experience {
        Experience {
            gained: self.gained.unwrap_or_default(),
            percent: self.percent.unwrap_or_default(),
            start_level: self.start_level,
            end_level: self.end_level,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Experience {
    pub gained: i64,
    pub percent: f64,
    pub start_level: Option<i64>,
    pub end_level: Option<i64>,
}

optional_fields!(RawLockoutActivity {
    activity: String,
    kind: String,
    period: String,
    is_raid: bool,
});

optional_fields!(RawRosterEntry {
    class_file: String,
    level: i64,
});

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawLockout {
    #[serde(deserialize_with = "tolerant_option")]
    pub key: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    pub activity: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    pub instance: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    pub is_raid: Option<bool>,
    #[serde(deserialize_with = "tolerant_option")]
    pub difficulty_id: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    pub difficulty: Option<String>,
    #[serde(deserialize_with = "tolerant_option")]
    pub max_players: Option<i64>,
    #[serde(deserialize_with = "tolerant_option")]
    pub expiry: Option<i64>,
    #[serde(deserialize_with = "tolerant_vec")]
    pub encounters: Vec<RawLockoutEncounter>,
}

optional_fields!(RawLockoutEncounter {
    name: String,
    killed: bool,
});

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawHoldingSnapshot {
    #[serde(deserialize_with = "tolerant_map")]
    pub currencies: BTreeMap<String, RawCurrencyHolding>,
    #[serde(deserialize_with = "tolerant_option")]
    pub gold: Option<RawObservedTotal>,
    #[serde(deserialize_with = "tolerant_map")]
    pub factions: BTreeMap<String, RawStanding>,
}

optional_fields!(RawCurrencyHolding {
    name: String,
    total: i64,
    at: i64,
    account_wide: bool,
});

optional_fields!(RawObservedTotal {
    total: i64,
    at: i64
});

optional_fields!(RawStanding {
    standing: String,
    current: i64,
    max: i64,
    rank: i64,
    system: String,
    at: i64,
});

optional_fields!(RawWarband { gold: i64, at: i64 });

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collector::read_saved_variable;

    fn fixture(name: &str) -> RawSavedVariables {
        let text = match name {
            "legacy" => include_str!("../fixtures/savedvariables/legacy.lua"),
            "current" => include_str!("../fixtures/savedvariables/current.lua"),
            "newer" => include_str!("../fixtures/savedvariables/newer.lua"),
            _ => panic!("unknown fixture"),
        };
        let value = read_saved_variable(text, "ChronieDB")
            .unwrap()
            .expect("ChronieDB fixture");
        read(value)
    }

    #[test]
    fn normalizes_an_independently_written_legacy_file() {
        let mut raw = fixture("legacy");
        assert_eq!(raw.compatibility(), SchemaCompatibility::Legacy);

        let segments = raw.take_segments();
        assert_eq!(segments.len(), 1);
        let segment = &segments[0];
        assert_eq!(segment.id, "old-1");
        assert_eq!(segment.started_at, segment.ended_at);
        assert_eq!(segment.instance, "Unknown");
        assert_eq!(segment.transmogs.len(), 1);
        assert_eq!(segment.transmogs[0].id, 19019);
        assert!(segment.achievements.is_empty());
        assert_eq!(segment.loot_value, 0);
    }

    #[test]
    fn reads_the_current_version_and_ignores_unknown_fields() {
        let mut raw = fixture("current");
        assert_eq!(raw.compatibility(), SchemaCompatibility::Current);

        let segments = raw.take_segments();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].currencies[0].total, None);
        assert_eq!(segments[0].encounters[0].success, false);
    }

    #[test]
    fn best_effort_reads_a_newer_version_without_claiming_it_is_current() {
        let mut raw = fixture("newer");
        assert_eq!(raw.compatibility(), SchemaCompatibility::Newer(99));

        let segments = raw.take_segments();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].id, "future-1");
        assert_eq!(segments[0].pets[0].species_first, Some(false));
    }
}
