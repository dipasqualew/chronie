/**
 * What the game calls each table this app reads.
 *
 * Generated from `docs/game-tables.json` by `bun run tables:generate`. Do not edit.
 *
 * FileDataIDs only, on purpose. A fixture's *layout* — which column holds what, in which
 * storage, at which bit offset — is decided in the `make-*-fixtures.ts` script that writes
 * the table, and has to stay decided there: if the writer took its column positions from the
 * same registry the reader takes them from, one wrong index would move both halves together
 * and every test over them would still pass. Which table a file *is* carries no such risk,
 * and it was the number actually being copied between three places.
 */

export const FILE_DATA_ID = {
  /** `TransmogSet` */
  transmogSet: 1376213,
  /** `TransmogSetItem` */
  transmogSetItem: 1376212,
  /** `TransmogSetGroup` */
  transmogSetGroup: 1576116,
  /** `ItemModifiedAppearance` */
  itemModifiedAppearance: 982457,
  /** `ItemAppearance` */
  itemAppearance: 982462,
  /** `ItemDisplayInfo` */
  itemDisplayInfo: 1266429,
  /** `ItemDisplayInfoMaterialRes` */
  itemDisplayInfoMaterialRes: 1280614,
  /** `ModelFileData` */
  modelFileData: 1337833,
  /** `TextureFileData` */
  textureFileData: 982459,
  /** `ComponentTextureFileData` */
  componentTextureFileData: 1278239,
  /** `ComponentModelFileData` */
  componentModelFileData: 1349053,
  /** `HelmetGeosetData` */
  helmetGeosetData: 2821752,
  /** `CharComponentTextureSections` */
  charComponentTextureSections: 1360263,
  /** `CharComponentTextureLayouts` */
  charComponentTextureLayouts: 1360262,
  /** `ChrModelMaterial` */
  chrModelMaterial: 3566562,
  /** `ChrModelTextureLayer` */
  chrModelTextureLayer: 3548976,
  /** `ChrModel` */
  chrModel: 3384313,
  /** `ChrRaces` */
  chrRaces: 1305311,
  /** `ChrRaceXChrModel` */
  chrRaceXChrModel: 3490304,
  /** `CreatureDisplayInfo` */
  creatureDisplayInfo: 1108759,
  /** `CreatureModelData` */
  creatureModelData: 1365368,
  /** `ChrCustomizationOption` */
  chrCustomizationOption: 3384247,
  /** `ChrCustomizationChoice` */
  chrCustomizationChoice: 3450554,
  /** `ChrCustomizationElement` */
  chrCustomizationElement: 3512765,
  /** `ChrCustomizationMaterial` */
  chrCustomizationMaterial: 3459652,
  /** `ChrCustomizationGeoset` */
  chrCustomizationGeoset: 3456171,
  /** `Achievement` */
  achievement: 1260179,
  /** `Achievement_Category` */
  achievementCategory: 1324299,
  /** `Faction` */
  faction: 1361972,
  /** `Criteria` */
  criteria: 1263817,
  /** `CriteriaTree` */
  criteriaTree: 1263818,
  /** `Item` */
  item: 841626,
  /** `ItemSparse` */
  itemSparse: 1572924,
  /** `JournalInstance` */
  journalInstance: 1237438,
  /** `LFGDungeons` */
  lfgDungeons: 1361033,
  /** `JournalEncounter` */
  journalEncounter: 1240336,
  /** `JournalEncounterCreature` */
  journalEncounterCreature: 1301155,
  /** `CurrencyTypes` */
  currencyTypes: 1095531,
  /** `UiMap` */
  uiMap: 1957206,
  /** `UiMapXMapArt` */
  uiMapXMapArt: 1957217,
  /** `UiMapArt` */
  uiMapArt: 1957202,
  /** `UiMapArtStyleLayer` */
  uiMapArtStyleLayer: 1957208,
  /** `UiMapArtTile` */
  uiMapArtTile: 1957210,
  /** `WorldMapOverlay` */
  worldMapOverlay: 1134579,
  /** `WorldMapOverlayTile` */
  worldMapOverlayTile: 1957212,
} as const;
