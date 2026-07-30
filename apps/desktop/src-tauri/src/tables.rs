//! Where the game keeps what this app reads, and where each fact came from.
//!
//! Generated from `docs/game-tables.json` by `bun run tables:generate`. Do not edit: change the
//! registry and run that, which rewrites this, the FileDataIDs the fixture generators use
//! and the table in `docs/game-files.md` together.
//!
//! The few single files the app names outright rather than through a table are here too, for
//! the same reason: a FileDataID is a fact a patch can invalidate.
//!
//! Nothing here is an opinion about what a value means. A column's position is mechanical
//! and a game patch can invalidate it, which is why it is recorded once with the build it
//! was read off; what a class mask, a geoset group or a points column *is* stays in the
//! module that acts on it.
//!
//! The readers take their columns from here. The fixture generators deliberately do not —
//! see `scripts/game-tables.ts` — and `db2.rs`'s tests keep their own literals, so a
//! wrong number in the registry still has something independent to fail against.

/// `TransmogSet` — the sets themselves, and the one table on the chain with a string in it.
///
/// Verified on 12.0.5.67.
pub const TRANSMOG_SET: u32 = 1376213;

/// `TransmogSetItem` — the appearances one set is made of, one row per piece.
///
/// Verified on 12.0.5.67.
pub const TRANSMOG_SET_ITEM: u32 = 1376212;

/// `TransmogSetGroup` — what the collections a set can belong to are called.
///
/// Verified on 12.0.5.67.
pub const TRANSMOG_SET_GROUP: u32 = 1576116;

/// `ItemModifiedAppearance` — what ties an appearance to an item.
///
/// Read from both ends: `transmog` asks what a named set is made of, `wardrobe` asks what
/// fills a place on the body.
///
/// Verified on 12.0.5.67.
pub const ITEM_MODIFIED_APPEARANCE: u32 = 982457;

/// `ItemAppearance` — one look, and the picture the game draws it with.
///
/// Verified on 12.0.5.67.
pub const ITEM_APPEARANCE: u32 = 982462;

/// `ItemDisplayInfo` — what one look actually puts on a character: the models it swaps and
/// the geoset groups it switches.
///
/// The tail of this table is array columns of awkward widths, and the community is wrong
/// about two of them. `docs/game-files.md` has the run that settled them.
///
/// Verified on 12.0.5.67 with `examples/dump_display_columns`.
pub const ITEM_DISPLAY_INFO: u32 = 1266429;

/// `ItemDisplayInfoMaterialRes` — which texture an appearance paints each part of a body
/// with.
///
/// Its own id is of no use to anybody: what ties a row to an appearance is the relationship
/// block, which [`crate::db2::Row::foreign_id`] reads.
///
/// Verified on 12.0.5.67.
pub const ITEM_DISPLAY_INFO_MATERIAL_RES: u32 = 1280614;

/// `ModelFileData` — every `.m2` the client owns, keyed by the resource that names it.
///
/// Read for an item's own model and for a model that goes on a body; the row id is the
/// file's own FileDataID.
///
/// Verified on 12.0.5.67.
pub const MODEL_FILE_DATA: u32 = 1337833;

/// `TextureFileData` — the same for `.blp`s, and asked a wider question: an item's model
/// wants the one file its material names, and a body texture wants every file it names so
/// that another table can say which of them was painted for the character being drawn.
///
/// Verified on 12.0.5.67.
pub const TEXTURE_FILE_DATA: u32 = 982459;

/// `ComponentTextureFileData` — which body a given texture file was painted for.
///
/// Keyed by the texture's own FileDataID, which is the row id. Silence is not exclusion:
/// most of the game's armour has no row here at all.
///
/// Verified on 12.0.5.67.
pub const COMPONENT_TEXTURE_FILE_DATA: u32 = 1278239;

/// `ComponentModelFileData` — the same for a model file, and the same three columns with a
/// fourth behind them.
///
/// Verified on 12.0.5.67.
pub const COMPONENT_MODEL_FILE_DATA: u32 = 1349053;

/// `HelmetGeosetData` — which of a body's geoset groups a helm hides, race by race.
///
/// Which helm a row belongs to is the relationship block, so [`crate::db2::Row::foreign_id`]
/// is what reads it. Two more columns follow the two below and are left alone: one is zero
/// on all but five of the table's 19,150 rows, and `RaceBitSelection` is `32` or `-1`
/// throughout.
///
/// Verified on 12.0.5.67.
pub const HELMET_GEOSET_DATA: u32 = 2821752;

/// `CharComponentTextureSections` — where each part of a body lands in that layout's atlas.
///
/// The layout is an ordinary column here rather than a relationship block, unlike
/// `ChrModelTextureLayer`'s.
///
/// Verified on 12.0.5.67.
pub const CHAR_COMPONENT_TEXTURE_SECTIONS: u32 = 1360263;

/// `CharComponentTextureLayouts` — the atlas layouts themselves. Named for the chain's sake
/// and read by nothing: what a layout *is* comes out of the two tables that key off it.
///
/// Verified on 12.0.5.67.
pub const CHAR_COMPONENT_TEXTURE_LAYOUTS: u32 = 1360262;

/// `ChrModelMaterial` — how large each of a layout's atlases is, texture type by texture
/// type. Its id is its own first column.
///
/// Verified on 12.0.5.67.
pub const CHR_MODEL_MATERIAL: u32 = 3566562;

/// `ChrModelTextureLayer` — how one texture layout is composited, a layer at a time.
///
/// Its id is beside the rows and the layout it belongs to is in the relationship block, so
/// neither is a column — which is what puts `TextureType` at 0 rather than at 1 or 2.
///
/// Verified on 12.0.5.67.
pub const CHR_MODEL_TEXTURE_LAYER: u32 = 3548976;

/// `ChrModel` — every playable body the game has, and which texture layout each composites
/// in. Keeps its id **inside** the row, in column 2.
///
/// Verified on 12.0.5.67 with `examples/dump_bodies`.
pub const CHR_MODEL: u32 = 3384313;

/// `ChrRaces` — every race the game ships, with the name to show and whether anybody can be
/// one.
///
/// Verified on 12.0.5.67 with `examples/dump_bodies`.
pub const CHR_RACES: u32 = 1305311;

/// `ChrRaceXChrModel` — which bodies a race is made of.
///
/// It states a sex of its own in column 2, and it is not the one used: a Dracthyr's single
/// body is listed twice there, once under each, while the body itself says it belongs to
/// neither. What a body *is* comes from `ChrModel`.
///
/// Verified on 12.0.5.67.
pub const CHR_RACE_X_CHR_MODEL: u32 = 3490304;

/// `CreatureDisplayInfo` — what a `ChrModel`'s display id actually displays.
///
/// Verified on 12.0.5.67 with `examples/dump_bodies`.
pub const CREATURE_DISPLAY_INFO: u32 = 1108759;

/// `CreatureModelData` — and the mesh behind that.
///
/// Verified on 12.0.5.67 with `examples/dump_bodies`.
pub const CREATURE_MODEL_DATA: u32 = 1365368;

/// `ChrCustomizationOption` — the things a body can be asked about, and whose body it is.
/// Keeps its id **inside** the row.
///
/// Verified on 12.0.5.67 with `examples/dump_customization`.
pub const CHR_CUSTOMIZATION_OPTION: u32 = 3384247;

/// `ChrCustomizationChoice` — the swatches of one option. Keeps its id inside the row as
/// well.
///
/// Verified on 12.0.5.67 with `examples/dump_customization`.
pub const CHR_CUSTOMIZATION_CHOICE: u32 = 3450554;

/// `ChrCustomizationElement` — what one customization choice does to a character. Its id is
/// kept beside the rows rather than in them.
///
/// The eight columns past the material are the rest of what a choice can do — a skinned
/// model, a bone set, a voice — and none of them is a picture or a geoset.
///
/// Verified on 12.0.5.67 with `examples/dump_customization`.
pub const CHR_CUSTOMIZATION_ELEMENT: u32 = 3512765;

/// `ChrCustomizationMaterial` — which target a customization paints, and with what. Its id
/// is also kept beside the rows.
///
/// Verified on 12.0.5.67 with `examples/dump_customization`.
pub const CHR_CUSTOMIZATION_MATERIAL: u32 = 3459652;

/// `ChrCustomizationGeoset` — the group and value a customization switches on. Its id is
/// kept beside the rows.
///
/// Verified on 12.0.5.67 with `examples/dump_customization`.
pub const CHR_CUSTOMIZATION_GEOSET: u32 = 3456171;

/// `Achievement` — every achievement the game has, read for two different questions: what a
/// player earned, and the picture a faction borrows from its own Exalted achievement.
///
/// Verified on 12.0.5.67 with `examples/dump_achievements`.
pub const ACHIEVEMENT: u32 = 1260179;

/// `Achievement_Category` — a category names its parent and nothing else, which is what
/// makes the tree something to walk rather than something to read.
///
/// Verified on 12.0.5.67 with `examples/dump_achievements`.
pub const ACHIEVEMENT_CATEGORY: u32 = 1324299;

/// `Faction` — every faction the game has a standing for, and what it is called. Its id sits
/// in a list beside the rows.
///
/// Column 0 is 256 bits wide — the four race masks the real table opens with, stored as one
/// column — which is what puts the name at column 1 rather than at column 0 the way every
/// other table in this app has it.
///
/// Verified on 12.0.5.67823 with `examples/dump_achievements`.
pub const FACTION: u32 = 1361972;

/// `Criteria` — one row per thing that can be required of a player.
///
/// Verified on 12.0.5.67823 with `examples/dump_achievements`.
pub const CRITERIA: u32 = 1263817;

/// `CriteriaTree` — how criteria are grouped into what an achievement actually asks for. Its
/// id sits in a list beside the rows.
///
/// Verified on 12.0.5.67823 with `examples/dump_achievements`.
pub const CRITERIA_TREE: u32 = 1263818;

/// `Item` — the two megabytes of what-kind-of-thing-an-item-is, beside the sixty-three of
/// `ItemSparse`. Its ids sit in a list of their own rather than in a column.
///
/// [`INVENTORY_TYPE`] agrees with the `ItemSparse` column `dump_inventory_types` found on
/// 100.00% of the 171,898 items both tables hold, and every piece of armour in the game
/// reads as `items::ARMOR` with one of the five armour subclasses.
///
/// Verified on 12.0.5.67 with `examples/dump_item_facts`.
pub const ITEM: u32 = 841626;

/// `ItemSparse` — every item in the game and what it is called. 63 MB of it, and the only
/// table here whose records vary in length.
///
/// A column of such a table is only findable by walking the ones in front of it, and a
/// string column is as long as the text in it — so the reader has to be told which columns
/// those are before it can find any of them. The table opens with five.
///
/// Verified on 12.0.5.67 with `examples/dump_items`.
pub const ITEM_SPARSE: u32 = 1572924;

/// `JournalInstance` — the Encounter Journal's dungeons and raids. An ordinary table of
/// fixed-size records whose id sits in a list beside the rows.
///
/// It holds four FileDataIDs side by side and only one of them is an icon — the others are
/// a 512×512 background, a 256×128 button banner and a 512×512 lore illustration — so
/// taking the wrong one of the four hands the window a picture far too large for the space.
///
/// Verified on 12.0.5.67823 with `examples/dump_journal`.
pub const JOURNAL_INSTANCE: u32 = 1237438;

/// `LFGDungeons` — everything the group finder can put a player in, delves included. The
/// same shape of table: fixed-size records, ids in a list beside them, strings in a block
/// of their own.
///
/// Verified on 12.0.5.67823 with `examples/dump_journal`.
pub const LFG_DUNGEONS: u32 = 1361033;

/// `JournalEncounter` — the Adventure Guide's bosses, one row per fight per difficulty tier.
/// Holds no picture and is the way to the table that does.
///
/// Its id sits in a column of its own rather than in a list beside the rows — column 3,
/// which [`crate::db2::Row::id`] reads — and that id is what `JournalEncounterCreature`
/// hangs off.
///
/// Verified on 12.0.5.67823 with `examples/dump_journal`.
pub const JOURNAL_ENCOUNTER: u32 = 1240336;

/// `JournalEncounterCreature` — the creatures shown for a fight, and their portraits.
///
/// Its id is in column 2, and the row it belongs to is named in a column rather than through
/// the relationship map — so this is an ordinary join on a number, not a
/// [`crate::db2::Row::foreign_id`].
///
/// Verified on 12.0.5.67823 with `examples/dump_journal`.
pub const JOURNAL_ENCOUNTER_CREATURE: u32 = 1301155;

/// `CurrencyTypes` — every currency the game has, with the picture each is drawn with. An
/// ordinary table of fixed-size records: its two strings sit in a block of their own, so
/// nothing past them moves and no column has to be walked to.
///
/// Column 3 is the only one of the table's first ten that holds FileDataIDs at all — 574
/// rows hold something there and every one of the 574 resolves to a texture this install
/// can decode.
///
/// Verified on 12.0.5.67823 with `examples/dump_currencies`.
pub const CURRENCY_TYPES: u32 = 1095531;

/// `UiMap` — every place the game will draw a map of, from the cosmos down to a cave, keyed
/// by the same localised name the client reports a player's position under. 1,922 rows on
/// 12.0.5.67823, and that is where the zones are: the two journal tables between them know
/// 805 places and Durotar is not one of them.
///
/// Keeps its id **inside** the row, so [`crate::db2::Row::id`] answers with the map id and no
/// column has to be read for it. A name is on several rows more often than not, which is what
/// columns 4 and 5 are read for.
///
/// Verified on 12.0.5.67823 with `examples/dump_maps`.
pub const UI_MAP: u32 = 1957206;

/// `UiMapXMapArt` — which art a map is drawn with, and when. The map it belongs to is in the
/// relationship block, so [`crate::db2::Row::foreign_id`] is what reads it.
///
/// 1,928 rows for 1,922 maps: fourteen maps have art of their own for a phase of a campaign,
/// and every one of the fourteen also has an unphased row. Nothing here can tell whether a
/// phase is active — that is a player's own progress — so the unphased row is the one taken.
///
/// Verified on 12.0.5.67823 with `examples/dump_maps`.
pub const UI_MAP_X_MAP_ART: u32 = 1957217;

/// `UiMapArt` — one map's art, which is 188 rows and almost no content of its own: what it
/// holds worth having is which style it is drawn in, and the style is what says how large the
/// finished picture is and how the fragments are laid out inside it.
///
/// Its other two columns are a highlight texture and that texture's atlas entry, neither of
/// which is the map — the highlight is the shape the game paints over a zone under the
/// pointer.
///
/// Verified on 12.0.5.67823 with `examples/dump_maps`.
pub const UI_MAP_ART: u32 = 1957202;

/// `UiMapArtStyleLayer` — how one style's fragments make a picture: how large the whole is,
/// and how large one fragment of it is. Nine rows for the whole game, and the style they
/// belong to is in the relationship block.
///
/// Both sizes are read and neither can be worked out from the other end. The classic zones
/// are 1,002×668 out of 256-pixel fragments, which is a 4×3 grid holding 1,024×768 — so a
/// reader that took the grid's own size would hand over 22 pixels of nothing down one side
/// and 100 along the bottom. The modern ones are 3,840×2,560 out of the same fragments,
/// exactly 15×10, and the cosmic map is a single 512-pixel one.
///
/// The three columns past the fragment size are two floats and a zoom-step count, which is
/// the trap here: a reader that counted past column 4 would read a float's bits as a number.
///
/// Verified on 12.0.5.67823 with `examples/dump_maps`.
pub const UI_MAP_ART_STYLE_LAYER: u32 = 1957208;

/// `UiMapArtTile` — the fragments themselves, one row per texture, which is 66,704 rows on
/// 12.0.5.67823. The art each belongs to is in the relationship block.
///
/// A row says where its fragment goes rather than what it is of, and the two indices are the
/// way round the game's own names put them: row before column. Reading them the other way
/// round transposes a map, which on the classic 4×3 grid is not a subtle failure — a third of
/// the fragments land outside the picture altogether.
///
/// Verified on 12.0.5.67823 with `examples/dump_maps`.
pub const UI_MAP_ART_TILE: u32 = 1957210;

/// `WorldMapOverlay` — the part of a map that only appears once a player has been there. 2,909
/// rows on 12.0.5.67823, one per named area of a zone, each a picture pasted at a stated place
/// over the map's own art.
///
/// This is what makes a map the map somebody remembers rather than a sheet of parchment. The
/// `UiMapArt` grid underneath is the **unexplored** map: terrain, a few mountains and the
/// neighbours' names, and nothing of Orgrimmar, Razor Hill or the roads between them. Those are
/// here, area by area, and the game pastes each one on as its area is discovered.
///
/// Keeps its id **inside** the row and states the art it belongs to in column 1, inline rather
/// than in the relationship block — the one table in this chain that does. The eight columns
/// past the offsets are the rectangle the pointer has to be inside to name the area, a player
/// condition, flags, and the four `AreaID`s; none of them is read.
///
/// Verified on 12.0.5.67823 with `examples/dump_maps`.
pub const WORLD_MAP_OVERLAY: u32 = 1134579;

/// `WorldMapOverlayTile` — the fragments an overlay is made of, which is the same arrangement
/// `UiMapArtTile` uses for the map underneath: 20,867 rows, a row and a column index apiece, and
/// the overlay in the relationship block.
///
/// Every one of the 20,867 is on layer 0 on 12.0.5.67823, so nothing here has ever had to
/// choose a layer — but the column is read all the same, because the base art's does choose one
/// and an overlay drawn from another layer would be a second copy of the same ground.
///
/// Verified on 12.0.5.67823 with `examples/dump_maps`.
pub const WORLD_MAP_OVERLAY_TILE: u32 = 1957212;

/// The banner the group finder shows when it will not say which dungeon it is sending a
/// player to — a door with a crest on it, 256×128, the same shape as the banners the two
/// journal tables name.
///
/// Which is what makes it the picture for a place the game draws none for. Most places are
/// that: an evening in Durotar is a name neither journal table has heard of, and a modal
/// whose header appeared only for dungeons would be two different modals.
///
/// `interface/lfgframe/ui-lfg-background-randomdungeon.blp`
///
/// Verified on 12.0.5.67823 with `examples/dump_journal`.
pub const UNKNOWN_PLACE_BANNER: u32 = 337493;

/// Columns of `TransmogSet` that this app reads.
pub mod transmog_set {
    /// `Name_lang`
    pub const NAME: usize = 0;

    /// `ClassMask`
    pub const CLASS_MASK: usize = 2;

    /// `Flags`
    pub const FLAGS: usize = 4;

    /// `TransmogSetGroupID`
    pub const GROUP_ID: usize = 5;

    /// `ParentTransmogSetID`
    pub const PARENT_ID: usize = 7;

    /// `ExpansionID`
    pub const EXPANSION_ID: usize = 9;

    /// `PatchIntroduced`
    pub const PATCH_INTRODUCED: usize = 10;

    /// `UiOrder`
    pub const UI_ORDER: usize = 11;
}

/// Columns of `TransmogSetItem` that this app reads.
pub mod transmog_set_item {
    /// `TransmogSetID`
    ///
    /// The set is a relationship the game duplicates into the record, which is why it reads
    /// as an ordinary column rather than through [`crate::db2::Row::foreign_id`].
    pub const SET_ID: usize = 0;

    /// `ItemModifiedAppearanceID`
    pub const MODIFIED_APPEARANCE_ID: usize = 1;
}

/// Columns of `TransmogSetGroup` that this app reads.
pub mod transmog_set_group {
    /// `Name_lang`
    ///
    /// The one column of the table that is not the row id.
    pub const NAME: usize = 0;
}

/// Columns of `ItemModifiedAppearance` that this app reads.
pub mod item_modified_appearance {
    /// `ItemID`
    pub const ITEM_ID: usize = 1;

    /// `ItemAppearanceID`
    pub const APPEARANCE_ID: usize = 3;
}

/// Columns of `ItemAppearance` that this app reads.
pub mod item_appearance {
    /// `DisplayType`
    ///
    /// Which slot the appearance fills; the game's own numbering, tabulated in the docs.
    /// It says nothing about a weapon — see `ItemSparse.InventoryType`.
    pub const DISPLAY_TYPE: usize = 0;

    /// `ItemDisplayInfoID`
    pub const DISPLAY_INFO_ID: usize = 1;

    /// `DefaultIconFileDataID`
    pub const ICON_FILE_DATA_ID: usize = 2;
}

/// Columns of `ItemDisplayInfo` that this app reads.
pub mod item_display_info {
    /// `ModelResourcesID[2]`
    ///
    /// A fixed-size array of two, not a scalar. Shoulders keep a model in each slot, and a
    /// reader that stops at the first element reports half of them as having no geometry.
    pub const MODEL_RESOURCES_ID: usize = 10;
    /// How many elements `MODEL_RESOURCES_ID` holds.
    pub const MODEL_RESOURCES_ID_ELEMENTS: usize = 2;
    /// How wide one element of `MODEL_RESOURCES_ID` is; the file records only the total.
    pub const MODEL_RESOURCES_ID_BITS: u32 = 32;

    /// `ModelMaterialResourcesID[2]`
    ///
    /// The same shape, and parallel to it: slot `i`'s model is painted with slot `i`'s
    /// material. This is the texture an item's own model uses, and not the one armour is
    /// drawn on the body with — that comes out of `ItemDisplayInfoMaterialRes`.
    pub const MATERIAL_RESOURCES_ID: usize = 11;
    /// How many elements `MATERIAL_RESOURCES_ID` holds.
    pub const MATERIAL_RESOURCES_ID_ELEMENTS: usize = 2;
    /// How wide one element of `MATERIAL_RESOURCES_ID` is; the file records only the total.
    pub const MATERIAL_RESOURCES_ID_BITS: u32 = 32;

    /// `ModelType[2]`
    ///
    /// What kind of model each of the two slots holds. Nothing reads it; it is named because
    /// it is what sits between the materials and the geoset groups, and reading it *as* the
    /// geoset groups is the mistake this table invites.
    pub const MODEL_TYPE: usize = 12;

    /// `GeosetGroup[6]`
    ///
    /// Which variant of each geoset group the display switches on: an array of six, read one
    /// element at a time like the two above.
    ///
    /// This column holds six values where 12 holds two, and a robe puts a 1 in its third
    /// while leaving its second at 0.
    pub const GEOSET_GROUP: usize = 13;
    /// How many elements `GEOSET_GROUP` holds.
    pub const GEOSET_GROUP_ELEMENTS: usize = 6;
    /// How wide one element of `GEOSET_GROUP` is; the file records only the total.
    pub const GEOSET_GROUP_BITS: u32 = 32;

    /// `HelmetGeosetVis[2]`
    ///
    /// Which rows of `HelmetGeosetData` say what a helm hides: an array of two, one per
    /// gender. Column 14 between them is `AttachmentGeosetGroup[6]`, which nothing reads.
    pub const HELMET_GEOSET_VIS: usize = 15;
    /// How many elements `HELMET_GEOSET_VIS` holds.
    pub const HELMET_GEOSET_VIS_ELEMENTS: usize = 2;
    /// How wide one element of `HELMET_GEOSET_VIS` is; the file records only the total.
    pub const HELMET_GEOSET_VIS_BITS: u32 = 32;
}

/// Columns of `ItemDisplayInfoMaterialRes` that this app reads.
pub mod item_display_info_material_res {
    /// `ComponentSection`
    ///
    /// Which part of the body, 0 to 8. The layout says where each of those lands.
    pub const COMPONENT_SECTION: usize = 0;

    /// `MaterialResourcesID`
    pub const MATERIAL_RESOURCES_ID: usize = 1;
}

/// Columns of `ModelFileData` that this app reads.
pub mod model_file_data {
    /// `ModelResourcesID`
    ///
    /// The one column that is not the row id: which model resource the file is.
    pub const MODEL_RESOURCES_ID: usize = 4;
}

/// Columns of `TextureFileData` that this app reads.
pub mod texture_file_data {
    /// `MaterialResourcesID`
    pub const MATERIAL_RESOURCES_ID: usize = 2;
}

/// Columns of `ComponentTextureFileData` that this app reads.
pub mod component_texture_file_data {
    /// `GenderIndex`
    pub const GENDER: usize = 0;

    /// `ClassID`
    pub const CLASS: usize = 1;

    /// `RaceID`
    pub const RACE: usize = 2;
}

/// Columns of `ComponentModelFileData` that this app reads.
pub mod component_model_file_data {
    /// `GenderIndex`
    pub const GENDER: usize = 0;

    /// `ClassID`
    pub const CLASS: usize = 1;

    /// `RaceID`
    pub const RACE: usize = 2;

    /// `PositionIndex`
    ///
    /// Which shoulder. The two tags are orthogonal and each slot uses exactly one of them —
    /// a helm is `gender 0 or 1, position -1`, and every one of the 10,449 shoulder
    /// resources is `gender 2, positions 0 and 1`.
    pub const POSITION: usize = 3;
}

/// Columns of `HelmetGeosetData` that this app reads.
pub mod helmet_geoset_data {
    /// `RaceID`
    pub const RACE: usize = 0;

    /// `HideGeosetGroup`
    pub const HIDE_GEOSET_GROUP: usize = 1;
}

/// Columns of `CharComponentTextureSections` that this app reads.
pub mod char_component_texture_sections {
    /// `CharComponentTexturelayoutsID`
    pub const LAYOUT: usize = 0;

    /// `SectionType`
    pub const SECTION: usize = 1;

    /// `X`
    pub const X: usize = 2;

    /// `Y`
    pub const Y: usize = 3;

    /// `Width`
    pub const WIDTH: usize = 4;

    /// `Height`
    pub const HEIGHT: usize = 5;
}

/// Columns of `ChrModelMaterial` that this app reads.
pub mod chr_model_material {
    /// `CharComponentTextureLayoutsID`
    pub const LAYOUT: usize = 1;

    /// `TextureType`
    pub const TEXTURE_TYPE: usize = 2;

    /// `Width`
    pub const WIDTH: usize = 3;

    /// `Height`
    pub const HEIGHT: usize = 4;
}

/// Columns of `ChrModelTextureLayer` that this app reads.
pub mod chr_model_texture_layer {
    /// `TextureType`
    pub const TEXTURE_TYPE: usize = 0;

    /// `Layer`
    pub const LAYER: usize = 1;

    /// `BlendMode`
    pub const BLEND_MODE: usize = 3;

    /// `TextureSectionTypeBitMask`
    ///
    /// Which of the layout's rectangles the layer paints, as one bit per `SectionType`.
    pub const SECTION_MASK: usize = 4;

    /// `ChrModelTextureTargetID[2]`
    ///
    /// An array; the second element is unused on the body layout.
    pub const TEXTURE_TARGET: usize = 7;
    /// How many elements `TEXTURE_TARGET` holds.
    pub const TEXTURE_TARGET_ELEMENTS: usize = 2;
    /// How wide one element of `TEXTURE_TARGET` is; the file records only the total.
    pub const TEXTURE_TARGET_BITS: u32 = 32;
}

/// Columns of `ChrModel` that this app reads.
pub mod chr_model {
    /// `Sex`
    pub const SEX: usize = 3;

    /// `DisplayID`
    pub const DISPLAY: usize = 4;

    /// `CharComponentTextureLayoutID`
    pub const LAYOUT: usize = 5;
}

/// Columns of `ChrRaces` that this app reads.
pub mod chr_races {
    /// `Name_lang`
    ///
    /// The name a reader is shown. Column 1 beside it is the client's own word for the race,
    /// and it is the one that calls the Undead "Scourge" and the Haranir "Harronir".
    pub const NAME: usize = 2;

    /// `Flags`
    pub const FLAGS: usize = 15;
}

/// Columns of `ChrRaceXChrModel` that this app reads.
pub mod chr_race_x_chr_model {
    /// `ChrRacesID`
    pub const RACE: usize = 0;

    /// `ChrModelID`
    pub const MODEL: usize = 1;
}

/// Columns of `CreatureDisplayInfo` that this app reads.
pub mod creature_display_info {
    /// `ModelID`
    pub const MODEL: usize = 1;
}

/// Columns of `CreatureModelData` that this app reads.
pub mod creature_model_data {
    /// `FileDataID`
    pub const FILE: usize = 2;
}

/// Columns of `ChrCustomizationOption` that this app reads.
pub mod chr_customization_option {
    /// `Name_lang`
    ///
    /// "Skin Color", "Hair Style", "Ears" — what the screen calls the question.
    pub const NAME: usize = 0;

    /// `ChrModelID`
    pub const MODEL: usize = 4;

    /// `OrderIndex`
    ///
    /// Where the question sits among this body's, in the order the screen lists them.
    pub const ORDER: usize = 5;
}

/// Columns of `ChrCustomizationChoice` that this app reads.
pub mod chr_customization_choice {
    /// `Name_lang`
    ///
    /// Empty for most swatches: a skin colour is a square of colour on the character
    /// creation screen and has nothing to be called.
    pub const NAME: usize = 0;

    /// `ChrCustomizationOptionID`
    pub const OPTION: usize = 2;

    /// `OrderIndex`
    ///
    /// Which swatch this is, in the order the character creation screen lists them.
    pub const ORDER: usize = 5;
}

/// Columns of `ChrCustomizationElement` that this app reads.
pub mod chr_customization_element {
    /// `ChrCustomizationChoiceID`
    ///
    /// Not a relationship block: an ordinary column.
    pub const CHOICE: usize = 0;

    /// `RelatedChrCustomizationChoiceID`
    ///
    /// A second choice that must be chosen too, or zero where the element is unconditional.
    pub const RELATED: usize = 1;

    /// `ChrCustomizationGeosetID`
    pub const GEOSET: usize = 2;

    /// `ChrCustomizationMaterialID`
    pub const MATERIAL: usize = 4;
}

/// Columns of `ChrCustomizationMaterial` that this app reads.
pub mod chr_customization_material {
    /// `ChrModelTextureTargetID`
    pub const TEXTURE_TARGET: usize = 0;

    /// `MaterialResourcesID`
    pub const MATERIAL_RESOURCES_ID: usize = 1;
}

/// Columns of `ChrCustomizationGeoset` that this app reads.
pub mod chr_customization_geoset {
    /// `GeosetType`
    pub const TYPE: usize = 0;

    /// `GeosetID`
    pub const VALUE: usize = 1;
}

/// Columns of `Achievement` that this app reads.
pub mod achievement {
    /// `Description_lang`
    pub const DESCRIPTION: usize = 0;

    /// `Title_lang`
    pub const TITLE: usize = 1;

    /// `Reward_lang`
    pub const REWARD: usize = 2;

    /// `Faction`
    pub const FACTION: usize = 5;

    /// `Category`
    pub const CATEGORY: usize = 7;

    /// `Points`
    ///
    /// Not the number of points on its own — see `achievements::points_of`.
    pub const POINTS: usize = 9;

    /// `IconFileID`
    pub const ICON_FILE_ID: usize = 12;

    /// `Criteria_tree`
    ///
    /// The root of the tree of criteria that earns it, into `CriteriaTree`. How
    /// [`crate::reputations`] gets from a faction back to an achievement.
    pub const CRITERIA_TREE: usize = 14;
}

/// Columns of `Achievement_Category` that this app reads.
pub mod achievement_category {
    /// `Name_lang`
    pub const NAME: usize = 0;

    /// `Parent`
    pub const PARENT: usize = 2;
}

/// Columns of `Faction` that this app reads.
pub mod faction {
    /// `Name_lang`
    ///
    /// The only column read, and the join: a segment carries this string and nothing else
    /// about the faction.
    pub const NAME: usize = 1;
}

/// Columns of `Criteria` that this app reads.
pub mod criteria {
    /// `Type`
    ///
    /// What kind of thing is being asked for. `reputations::REPUTATION_CRITERIA` is the one
    /// that matters; the table has a hundred-odd others.
    pub const TYPE: usize = 1;

    /// `Asset`
    ///
    /// What the requirement is about, whose meaning depends entirely on the type beside it.
    /// For a type-46 row it is a faction id; for the row next to it, a map or an item.
    pub const ASSET: usize = 2;
}

/// Columns of `CriteriaTree` that this app reads.
pub mod criteria_tree {
    /// `Parent`
    ///
    /// The node this one hangs off, and zero on a root. Every one of the 92,387 rows that
    /// name a parent name a row that exists, which is what says this is the column.
    pub const PARENT: usize = 1;

    /// `CriteriaID`
    ///
    /// The criterion this node is, when it is a leaf rather than a grouping.
    pub const CRITERIA_ID: usize = 4;
}

/// Columns of `Item` that this app reads.
pub mod item {
    /// `ClassID`
    ///
    /// What kind of thing it is: 2 weapon, 4 armour, and a dozen kinds nothing is worn from.
    pub const CLASS: usize = 0;

    /// `SubclassID`
    ///
    /// Which kind of that kind: for armour, 1 cloth, 2 leather, 3 mail, 4 plate, 5 cosmetic.
    pub const SUBCLASS: usize = 1;

    /// `InventoryType`
    ///
    /// Where it is worn, in the same numbering `ItemSparse` uses. Kept in both tables; this
    /// is the copy in the small one, and the reason `ItemSparse` is opened only for names.
    pub const INVENTORY_TYPE: usize = 3;

    /// `IconFileDataID`
    ///
    /// The picture the game draws beside it, decoded through [`crate::icons`].
    pub const ICON_FILE_ID: usize = 6;
}

/// Columns of `ItemSparse` that this app reads.
pub mod item_sparse {
    /// `Description_lang, Display3_lang, Display2_lang, Display1_lang, Display_lang`
    ///
    /// Every column of the table that holds text, in the order it holds them.
    ///
    /// **These positions are the community's and were not read off an install**, unlike the
    /// chain around them. A patch that reorders the table shows empty names rather than
    /// wrong ones, because the view falls back to the item's id.
    ///
    /// Unverified — the community's table definitions; not read off an install.
    pub const TEXT: [usize; 5] = [1, 2, 3, 4, 5];

    /// `Display_lang`
    ///
    /// What the item is called.
    ///
    /// Unverified — the community's table definitions; not read off an install.
    pub const NAME: usize = 5;

    /// `AllowableClass`
    ///
    /// A bit per class, or `items::ANY_CLASS` for anybody — which is what nearly every item
    /// carries. `0xFFFF` on all but 29,455 items, and those are the class sets, the rogue
    /// poisons and the warlock grimoires.
    ///
    /// Verified on 12.0.5.67 with `examples/dump_item_facts`.
    pub const ALLOWABLE_CLASS: usize = 52;

    /// `RequiredLevel`
    ///
    /// The level a character has to have reached to equip it. Zero for most things, and
    /// never above the cap.
    ///
    /// Verified on 12.0.5.67 with `examples/dump_item_facts`.
    pub const REQUIRED_LEVEL: usize = 65;

    /// `InventoryType`
    ///
    /// Where the item is worn, which is the one thing `ItemAppearance.DisplayType` will not
    /// say about a weapon: a one-hander is 13, a two-hander 17, a shield 14, an off-hand 22.
    ///
    /// Found rather than trusted: every armour slot has exactly one `InventoryType` it can
    /// be, and this column is the one that agrees with all eleven of them on 99.8% of the
    /// 77,356 pieces of armour in the game. Nothing else comes within 13%.
    ///
    /// Verified on 12.0.5.67 with `examples/dump_inventory_types`.
    pub const INVENTORY_TYPE: usize = 66;

    /// `OverallQualityID`
    ///
    /// The colour the game writes the name in: 0 poor, 2 uncommon, 4 epic, 5 legendary. It
    /// spans exactly 0..8, with 771 legendaries and 478 heirlooms in the whole game.
    ///
    /// Verified on 12.0.5.67 with `examples/dump_item_facts`.
    pub const QUALITY: usize = 67;
}

/// Columns of `JournalInstance` that this app reads.
pub mod journal_instance {
    /// `Name_lang`
    ///
    /// What the instance is called, in the locale the install is running in.
    pub const NAME: usize = 0;

    /// `ButtonSmallFileDataID`
    ///
    /// The picture beside it, decoded through [`crate::icons`]. Every one of the 209 the
    /// table names decodes at 128×128, which is what makes this the one of the four files
    /// an icon can be.
    pub const BUTTON_SMALL_FILE_DATA_ID: usize = 5;

    /// `ButtonFileDataID`
    ///
    /// The wide banner the game draws the place across, decoded through [`crate::icons`].
    /// Every one of the 209 the table names decodes at 256×128 — the only one of the four
    /// files shaped like a header rather than like a square or a portrait.
    pub const BUTTON_FILE_DATA_ID: usize = 4;
}

/// Columns of `LFGDungeons` that this app reads.
pub mod lfg_dungeons {
    /// `Name_lang`
    ///
    /// What the group finder calls the place, in the locale the install is running in.
    pub const NAME: usize = 0;

    /// `IconTextureFileID`
    ///
    /// The picture beside it in the finder's list, as a FileDataID.
    pub const ICON_TEXTURE_FILE_ID: usize = 5;

    /// `PopupBgTextureFileID`
    ///
    /// The wide banner the finder puts behind the dungeon it is offering. 1,702 of the
    /// 1,824 rows name one and every one of those decodes at 256×128, the same shape
    /// `JournalInstance.ButtonFileDataID` holds — which is what lets the two tables fill in
    /// for each other for a delve or a scenario the journal has no row for.
    pub const POPUP_BG_TEXTURE_FILE_ID: usize = 7;
}

/// Columns of `JournalEncounter` that this app reads.
pub mod journal_encounter {
    /// `Name_lang`
    ///
    /// What the fight is called: "Glubtok", "Queen Ansurek". Not read to answer anything —
    /// the addon already caught the name off the client — but it is what says a run of this
    /// table landed on the right rows.
    pub const NAME: usize = 0;

    /// `JournalInstanceID`
    ///
    /// The instance the fight is in, joining back to `JournalInstance`'s own id. Not part of
    /// the portrait hop; it is what the dumper checks the table against, because a Deadmines
    /// boss reading 63 is the same 63 the place icons are already keyed by.
    pub const JOURNAL_INSTANCE_ID: usize = 4;

    /// `DungeonEncounterID`
    ///
    /// The id the *client* knows this fight by, and the one thing here a segment already
    /// carries: `ENCOUNTER_END`'s first argument is a `DungeonEncounterID`.
    pub const DUNGEON_ENCOUNTER_ID: usize = 5;
}

/// Columns of `JournalEncounterCreature` that this app reads.
pub mod journal_encounter_creature {
    /// `Name_lang`
    ///
    /// The creature's own name, which is not always the fight's: the Ascendant Council is
    /// four rows called Feludius, Ignacious, Arion and Terrastra. Only the dumper reads it.
    pub const NAME: usize = 0;

    /// `JournalEncounterID`
    ///
    /// The `JournalEncounter` row this creature belongs to, by that table's id.
    pub const JOURNAL_ENCOUNTER_ID: usize = 3;

    /// `ModelFileDataID`
    ///
    /// The portrait, decoded through [`crate::icons`]. Every one of the 1,172 the table
    /// names decodes at 128×64, which is what makes it a portrait rather than one of the
    /// banners and backgrounds this chain could otherwise have landed on.
    pub const PORTRAIT_FILE_DATA_ID: usize = 5;

    /// `OrderIndex`
    ///
    /// Where the guide puts this creature among the fight's others, counting from zero. The
    /// rows are **not** stored in this order.
    pub const ORDER_INDEX: usize = 6;
}

/// Columns of `CurrencyTypes` that this app reads.
pub mod currency_types {
    /// `Name_lang`
    ///
    /// What the currency is called — "Honor", "Valorstones". Read by the dumper, not by the
    /// app: the addon already sends the name the client showed the player.
    pub const NAME: usize = 0;

    /// `InventoryIconFileID`
    ///
    /// The picture beside it, decoded through [`crate::icons`].
    pub const ICON_FILE_DATA_ID: usize = 3;
}

/// Columns of `UiMap` that this app reads.
pub mod ui_map {
    /// `Name_lang`
    ///
    /// What the place is called, in the locale the install is running in — the same string the
    /// two journal tables are keyed by, and the only thing a segment arrives carrying.
    pub const NAME: usize = 0;

    /// `System`
    ///
    /// Which of the game's map systems the row belongs to: 0 the world map, 1 the flight map,
    /// 2 the Adventure Guide's. Read to prefer the world's, because that is the map a player
    /// opens with M.
    pub const SYSTEM: usize = 4;

    /// `Type`
    ///
    /// How deep the place sits: 0 cosmic, 1 world, 2 continent, 3 zone, 4 dungeon, 5 micro, 6
    /// orphan. Read to break a tie between rows of one name — "Durotar" is a zone, an orphan
    /// and an Adventure Guide zone at once, and the zone is the one worth drawing.
    pub const TYPE: usize = 5;
}

/// Columns of `UiMapXMapArt` that this app reads.
pub mod ui_map_x_map_art {
    /// `PhaseID`
    ///
    /// Which phase the art belongs to, 0 for the art a map is drawn with the rest of the time.
    pub const PHASE: usize = 0;

    /// `UiMapArtID`
    ///
    /// The art itself, which is what the fragments hang off.
    pub const ART: usize = 1;
}

/// Columns of `UiMapArt` that this app reads.
pub mod ui_map_art {
    /// `UiMapArtStyleID`
    ///
    /// The style, which `UiMapArtStyleLayer` describes.
    pub const STYLE: usize = 2;
}

/// Columns of `UiMapArtStyleLayer` that this app reads.
pub mod ui_map_art_style_layer {
    /// `LayerIndex`
    ///
    /// Which layer of the style this describes. Layer 0 is the one drawn at the scale a map
    /// opens at; two styles have a second layer, and both of those are the size of their
    /// first.
    pub const LAYER_INDEX: usize = 0;

    /// `LayerWidth`
    ///
    /// How wide the finished picture is, which is less than the grid holding it.
    pub const WIDTH: usize = 1;

    /// `LayerHeight`
    ///
    /// And how tall.
    pub const HEIGHT: usize = 2;

    /// `TileWidth`
    ///
    /// How wide one fragment is — 256 for every style but the cosmic map's, which is 512.
    pub const TILE_WIDTH: usize = 3;

    /// `TileHeight`
    ///
    /// And how tall one is.
    pub const TILE_HEIGHT: usize = 4;
}

/// Columns of `UiMapArtTile` that this app reads.
pub mod ui_map_art_tile {
    /// `RowIndex`
    ///
    /// Which row of the grid the fragment sits in, counting from the top.
    pub const ROW_INDEX: usize = 0;

    /// `ColIndex`
    ///
    /// And which column, counting from the left.
    pub const COL_INDEX: usize = 1;

    /// `LayerIndex`
    ///
    /// Which layer of the style it belongs to.
    pub const LAYER_INDEX: usize = 2;

    /// `FileDataID`
    ///
    /// The texture, decoded through [`crate::icons`] like every other picture the app draws.
    pub const FILE_DATA_ID: usize = 3;
}

/// Columns of `WorldMapOverlay` that this app reads.
pub mod world_map_overlay {
    /// `UiMapArtID`
    ///
    /// Which map's art the overlay belongs to.
    pub const ART: usize = 1;

    /// `TextureWidth`
    ///
    /// How wide the overlay's own picture is — and, like the map it goes on, less than the grid
    /// of fragments holding it.
    pub const WIDTH: usize = 2;

    /// `TextureHeight`
    ///
    /// And how tall.
    pub const HEIGHT: usize = 3;

    /// `OffsetX`
    ///
    /// Where its left edge goes, in the pixels of the finished map rather than in fragments.
    pub const LEFT: usize = 4;

    /// `OffsetY`
    ///
    /// And its top edge.
    pub const TOP: usize = 5;
}

/// Columns of `WorldMapOverlayTile` that this app reads.
pub mod world_map_overlay_tile {
    /// `RowIndex`
    ///
    /// Which row of the overlay's own grid the fragment sits in.
    pub const ROW_INDEX: usize = 0;

    /// `ColIndex`
    ///
    /// And which column.
    pub const COL_INDEX: usize = 1;

    /// `LayerIndex`
    ///
    /// Which layer of the map's style it belongs to.
    pub const LAYER_INDEX: usize = 2;

    /// `FileDataID`
    ///
    /// The texture, decoded through [`crate::icons`] like the rest.
    pub const FILE_DATA_ID: usize = 3;
}
