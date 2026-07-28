/**
 * The shapes the backend hands the window, written down once.
 *
 * Every one of these mirrors a `serde_json::json!` literal in `src-tauri/src/collector.rs`,
 * which is the only place they are produced. The event lists are all optional because the
 * views are written to survive a payload that predates a field — a segment recorded before a
 * table existed simply has nothing under that key, and the reading code says `|| []` rather
 * than trusting the backend to have filled it in.
 */

/* ---------- events on a segment ---------- */

export interface AchievementEvent {
  id: number;
  name?: string | null;
  at?: number | null;
  accountFirst?: boolean | null;
}

export interface LevelUpEvent {
  level: number;
  at?: number | null;
}

/** Mounts, pets and toys are all "a thing collected at a time", and read identically. */
export interface CollectibleEvent {
  id: number;
  name?: string | null;
  at?: number | null;
  guid?: string | null;
}

/**
 * A battle pet caught, and whether the collection actually grew.
 *
 * The one collectible the game lets a player own several of: a mount is collected or not, but
 * the same rabbit can be caught twenty times. Only the client can tell the two apart and only
 * at the moment of the catch, so the addon reads its owned count there and sends the answer.
 *
 * Absent, not false, on a catch recorded before the addon asked. "Another of one owned" and
 * "nobody said" are different things to a view deciding whether the pet is worth a line.
 */
export interface PetEvent extends CollectibleEvent {
  speciesFirst?: boolean | null;
}

export interface TransmogEvent {
  id: number;
  name?: string | null;
  sourceID?: number | null;
  appearanceID?: number | null;
  at?: number | null;
  /** True for an appearance new to the collection, false for a variant of one owned. */
  newAppearance?: boolean | null;
}

export interface QuestEvent {
  id: number;
  name?: string | null;
  at?: number | null;
  characterFirst?: boolean | null;
  accountFirst?: boolean | null;
}

export interface HousingItemEvent {
  id: number;
  name?: string | null;
  at?: number | null;
  warbandFirst?: boolean | null;
}

export interface CurrencyGain {
  id: number;
  name: string;
  amount: number;
  at?: number | null;
  /**
   * What the character held once the last change of the segment had landed — the number
   * that decides whether the gain is enough to buy anything. Absent when the client never
   * said, which is not the same as holding none.
   */
  total?: number | null;
}

/**
 * A reputation gain, and where it left the character standing with that faction.
 *
 * The standing is a bar rather than a number, because the client's four reputation systems
 * agree on nothing else: renown counts levels of its own, paragon fills the same bar over
 * and over past Exalted, a friendship has ranks with their own names, and everything else
 * is the reaction ladder. The addon picks between them and sends the result as a level name
 * with a position inside it, so nothing downstream has to know which system answered.
 */
export interface ReputationGain {
  faction: string;
  amount: number;
  at?: number | null;
  /** The level's own name — "Honored", "Renown 12", "Best Friend". */
  standing?: string | null;
  /** How far into that level the character is. */
  current?: number | null;
  /** What the level takes to finish; absent or zero for a level with nothing after it. */
  max?: number | null;
}

/**
 * What one slot of an equipment set holds after a change, and what it replaced.
 *
 * The `previous*` half is not stored anywhere: the backend derives it from the row behind
 * this one in the ledger — the last time the same character's same set had the same slot
 * written — so there is exactly one place a slot's history is written down.
 *
 * A level and a name arrive when the item was on the character at the moment of the change,
 * which is the ordinary case: saving a set saves what is equipped. A change only noticed at
 * a later login has the id alone, and a row that says less is still a row.
 */
export interface EquipsetSlotChange {
  /** Inventory slot id: 1 head, 2 neck, 3 shoulder, and so on to 19 tabard. */
  slot: number;
  /** What is in the slot now. Absent for a slot the change emptied. */
  itemId?: number | null;
  /** What that item is really worth, upgrades and all — not the base level of its id. */
  itemLevel?: number | null;
  itemName?: string | null;
  previousItemId?: number | null;
  previousItemLevel?: number | null;
  previousItemName?: string | null;
}

/** A set that appeared, one that went away, or one whose items were edited. */
export type EquipsetChangeKind = "created" | "deleted" | "updated";

/**
 * One thing that happened to one of the character's equipment sets.
 *
 * A rename is not one of them: the set is the same set holding the same items under a new
 * label, and the new name simply travels on the next real change.
 */
export interface EquipsetChangeEvent {
  /** The client's own id for the set, which survives a rename. Unique per character. */
  setId: number;
  name: string;
  kind: EquipsetChangeKind;
  at?: number | null;
  /** The slots that changed, ascending. Empty when a set that held nothing came or went. */
  items?: EquipsetSlotChange[];
}

/**
 * What Chronie has of a capture's image. Mirrors the `image_state` column.
 *
 * Three states rather than a boolean, because the three reasons there is no picture are three
 * different things to tell somebody: `none` is an entry that never asked for one — a note
 * rather than a screenshot — `missing` is a marker whose file could not be found, and `stored`
 * is a picture Chronie holds and is about to hand over.
 */
export type CaptureImageState = "none" | "stored" | "missing";

/**
 * One thing somebody thought was worth remembering, and whatever Chronie has of the picture.
 *
 * A capture is not a child of the segment the way the other event lists are: the row survives
 * a re-sync, the file it points at is one Chronie has taken custody of, and the segment is a
 * link rather than an owner. What it is doing on the segment here is the same thing it is
 * doing in the database — saying where it was taken.
 */
export interface Capture {
  /** The database row id, which is what a note or a deletion is filed against. */
  id: number;
  /** The addon's own id for the entry, unique across accounts. */
  sourceId: string;
  /** Epoch second. What the pictures of an evening are ordered by. */
  at: number;
  /** The same moment in local time, as the client names its files: "MMDDYY_HHMMSS". */
  stamp?: string | null;
  imageState: CaptureImageState;
  /**
   * What somebody said about it, typed in game or in this window. The most user-supplied
   * string in the application, and the only one that has ever been typed rather than read off
   * something the game said.
   */
  note?: string | null;
  /** The rule that fired it by itself, absent when a person pressed the key. */
  trigger?: string | null;
  /** The achievement it was taken for, as the game numbers it, when it was taken for one. */
  achievementId?: number | null;
  byteSize?: number | null;
  /** What the game called the file before Chronie took it. */
  sourceName?: string | null;
  uiMapId?: number | null;
  /** Normalised across the map, 0..1, and absent together. */
  mapX?: number | null;
  mapY?: number | null;
}

export interface EncounterEvent {
  id: number;
  name?: string | null;
  at?: number | null;
  difficultyId?: number | null;
  groupSize?: number | null;
  success: boolean;
}

/* ---------- activities ---------- */

export type ActivityMetadata = Record<string, unknown>;

/** "inferred" is Chronie's guess; "manual" is the player's own word on it. */
export type ActivitySource = "inferred" | "manual";

export interface Activity {
  id: number;
  kind: string;
  source: ActivitySource;
  /** How sure the backend's rule was, from 0 to 1. A manual entry is always 1. */
  confidence: number;
  metadata: ActivityMetadata;
}

/* ---------- a segment ---------- */

export interface KeystoneRun {
  level: number;
  mapId?: number | null;
  affixes?: number[];
  startedAt?: number | null;
  completedAt?: number | null;
  completed: boolean;
  durationMs?: number | null;
  onTime?: boolean | null;
  upgrades?: number | null;
}

export interface ExperienceGain {
  gained: number;
  percent: number;
  startLevel?: number | null;
  endLevel?: number | null;
}

/**
 * One stretch of play, in one place, on one character — what the addon records and what the
 * whole app is a view over.
 */
export interface Segment {
  /** The database row id, which is what an activity is filed against. */
  segmentId: number;
  /** The addon's own identity for the segment, which survives a rename of the row. */
  id: string;
  character: string;
  classFile?: string | null;
  level?: number | null;
  day: string;
  instance: string;
  difficulty: string;
  instanceType: string;
  difficultyId?: number | null;
  startedAt: number;
  endedAt: number;
  seconds: number;
  lootValue: number;
  goldDiff: number;
  currencyTotal?: number;
  reputationTotal?: number;
  housingXP: number;
  expansionTier?: number | null;
  latestExpansionTier?: number | null;
  /** Absent, not zeroed, when the character earned no experience in the segment. */
  experience?: ExperienceGain | null;
  keystone?: KeystoneRun | null;
  activities?: Activity[];
  captures?: Capture[];
  encounters?: EncounterEvent[];
  equipsetChanges?: EquipsetChangeEvent[];
  transmogs?: TransmogEvent[];
  currencies?: CurrencyGain[];
  reputation?: ReputationGain[];
  achievements?: AchievementEvent[];
  levelUps?: LevelUpEvent[];
  mounts?: CollectibleEvent[];
  pets?: PetEvent[];
  quests?: QuestEvent[];
  toys?: CollectibleEvent[];
  housingItems?: HousingItemEvent[];
  housingLevelUps?: LevelUpEvent[];
}

/* ---------- what the commands answer with ---------- */

export interface DashboardPayload {
  generatedAt?: string;
  /** The kinds this build's inference can produce, for the editor's picker. */
  knownActivityKinds?: string[];
  segments?: Segment[];
  /** What every character on the account was last seen holding. */
  holdings?: AccountHoldings;
}

/* ---------- what the account holds, as opposed to what one character does ---------- */

/** One character's share of an account total. Mirrors a row of `character_currencies`. */
export interface CurrencyHolder {
  character: string;
  total: number;
  /** When it was read. Every one of these is last known rather than live. */
  at?: number | null;
}

/**
 * What the whole account holds of one currency.
 *
 * The per-character rows travel with the total rather than being summarised away: a sum
 * nobody can break back down is a number nobody can check, and `oldest` is what says how much
 * of it might have moved since anybody looked.
 */
export interface AccountCurrency {
  id: number;
  name?: string | null;
  /** The wallets added up — or, when `accountWide`, the freshest reading of the one pot. */
  total: number;
  /**
   * True when this is the warband's one shared pot rather than a holding per character.
   *
   * The game answers every character that asks with the same account-wide balance, so the
   * rows below are one number reported several times and adding them up would multiply the
   * pot by the size of the roster. It also changes what the rows *mean* on screen: a
   * character's line is the account's balance seen from there, not that character's share.
   */
  accountWide?: boolean;
  oldest?: number | null;
  characters: CurrencyHolder[];
}

/** Where one character stands with a faction. Mirrors a row of `character_standings`. */
export interface CharacterStanding {
  character: string;
  standing?: string | null;
  current?: number | null;
  max?: number | null;
  /**
   * How far up this faction's own ladder the standing sits, and which ladder that is. A name
   * cannot be ranked — "Renown 12" and "Honored" do not sort — and a rank only means anything
   * against the same ladder, so the two always travel together.
   */
  rank?: number | null;
  system?: string | null;
  at?: number | null;
}

/**
 * Where the account as a whole stands with one faction.
 *
 * `best` is null when no character's standing could be placed on a ladder at all, which is a
 * different thing from nobody being ahead.
 */
export interface AccountFaction {
  faction: string;
  best?: CharacterStanding | null;
  characters: CharacterStanding[];
}

/** What one character was last seen carrying. Mirrors a row of `character_gold`. */
export interface GoldHolder {
  character: string;
  /** Copper, the unit the client counts in. */
  total: number;
  at?: number | null;
}

/**
 * What the account is worth in gold.
 *
 * `warband` is the one pot every character shares, so it is added to the total once rather
 * than per character. Null when no character has ever reported one — an account whose file
 * predates the reading has not claimed to hold nothing, it has simply never been asked.
 */
export interface AccountGold {
  characters: GoldHolder[];
  /** The wallets alone, without the warband bank. */
  wallets: number;
  warband?: number | null;
  warbandAt?: number | null;
  total: number;
  /** The eldest reading in the total, which is the weakest claim in it. */
  oldest?: number | null;
}

export interface AccountHoldings {
  currencies: AccountCurrency[];
  factions: AccountFaction[];
  gold?: AccountGold | null;
}

/* ---------- transmog ---------- */

/**
 * One transmog set, as the game's own tables describe it.
 *
 * This comes from the installed game files rather than from anything the addon collected,
 * so it says what exists rather than what the player owns.
 */
export interface TransmogSet {
  id: number;
  name: string;
  /** The collection the set belongs to, already resolved to its name. */
  group: string;
  groupId: number;
  /** A bit per class, in the game's class order. Zero means the set is not class-specific. */
  classMask: number;
  expansionId: number;
  /** The set this one is a variant of, or zero. */
  parentId: number;
  flags: number;
  /** Where the set sits in the game's own ordering of its group. */
  uiOrder: number;
  /** The patch the set arrived in, written as major then two digits each of minor and patch. */
  patchIntroduced: number;
  itemCount: number;
  /**
   * The other sets holding exactly this set's appearances, where this is the one shown.
   *
   * Absent for all but 329 of the game's sets. See `sameLookAs` for the other end of it.
   */
  alternates?: Alternate[];
  /**
   * The set this one is shown under, when it is not the one shown. Absent otherwise.
   *
   * 436 sets of a shipping install carry one. They stay in the payload — the counts above are
   * about what the game holds — and the grid leaves them out while still searching their names.
   */
  sameLookAs?: number;
}

/** Why two sets that hold exactly the same appearances are two sets at all. */
export type SameLookReason = "faction" | "class" | "reissue";

/** A set that is another set's clothes, named so the one shown can say who else wears it. */
export interface Alternate {
  id: number;
  name: string;
  group: string;
  classMask: number;
  expansionId: number;
  patchIntroduced: number;
  reason: SameLookReason;
}

export interface TransmogPayload {
  sets: TransmogSet[];
  readCount: number;
  /** What the game's table says it holds, which is more than can be read. */
  declaredCount: number;
  /** Sets Blizzard encrypted because they belong to content it has not shipped. */
  withheldCount: number;
}

/**
 * One appearance out of a set, followed through the game's tables as far as they go.
 *
 * Everything past the appearance the set itself names can be zero: a hop that lands in a
 * section Blizzard encrypted reads as nothing at all, and the row still says as much as this
 * install can answer rather than being dropped for being incomplete.
 */
export interface TransmogAppearance {
  /** The `ItemModifiedAppearance` the set names, which is where the chain starts. */
  modifiedAppearanceId: number;
  itemId: number;
  /** What the game calls the item, or empty where its table says nothing. */
  name: string;
  appearanceId: number;
  /** Which slot it fills: 0 head, 1 shoulder, 2–10 the rest of the armour, 11 up weapons. */
  displayType: number;
  /**
   * Where the game says the item is worn, out of `ItemSparse`: 1 head, 13 a one-hander, 14 a
   * shield, 17 a two-hander, 22 an off hand. Zero where the game withholds the item.
   *
   * For a weapon it is the only thing that says which hand, because the four display types
   * above cover a sword, a bow, a shield and a tome between them and distinguish none of it.
   */
  inventoryType: number;
  /**
   * Who may wear the item, as a bit per class, or `0xffff` for anybody.
   *
   * This and the two below it are facts about the *item* rather than about the appearance,
   * and they are here because several items reach one appearance and this is what tells them
   * apart. Zero where the game withholds the item.
   */
  allowableClass: number;
  /** The level a character has to have reached to equip it. Zero is the ordinary answer. */
  requiredLevel: number;
  /** The colour the game writes the name in: 0 poor, 2 uncommon, 4 epic, 5 legendary. */
  quality: number;
  displayInfoId: number;
  /** The game's icon for it, as a FileDataID, or zero when it names none. */
  iconFileDataId: number;
  /** Whether it has geometry of its own. Only heads, shoulders, weapons and shields do. */
  hasModel: boolean;
}

export interface TransmogSetItemsPayload {
  setId: number;
  appearances: TransmogAppearance[];
  /** Appearances that could be followed all the way to an item. */
  readCount: number;
  /** Appearances a hop of the chain arrives at encrypted, and so cannot be named. */
  withheldCount: number;
}

/**
 * One look out of the game's whole wardrobe, as `wardrobe::WardrobeAppearance` reads it.
 *
 * The other way round from a set: this is an appearance the game holds for a place on the
 * body, whether or not any set names it, already followed to the item that gives it most
 * cheaply. A row is a *look* rather than an item, so `itemCount` is how many items the game
 * sells it through and the name is one of theirs.
 *
 * Everything the item says can be missing — the game encrypts what it has not shipped — and a
 * zero means the tables said nothing rather than that they said zero.
 */
export interface WardrobeAppearance {
  appearanceId: number;
  /** The item the row is named after, out of however many give the look. */
  itemId: number;
  name: string;
  /** Which slot it fills: 0 head, 1 shoulder, 2–10 the rest of the armour, 11 up weapons. */
  displayType: number;
  /** Where the item is worn, which for a weapon is what says which hand holds it. */
  inventoryType: number;
  /** What kind of thing the item is: 4 armour, 2 a weapon, or something worn by nobody. */
  classId: number;
  /** Which kind of that kind — the axe, the staff, the dagger. `wardrobe.ts` names them. */
  subclassId: number;
  allowableClass: number;
  requiredLevel: number;
  quality: number;
  displayInfoId: number;
  iconFileDataId: number;
  hasModel: boolean;
  /** How many items of the game give this look, the one it is named after included. */
  itemCount: number;
  /** True when a class-locked item and an unrestricted one both give it. */
  liftsRestriction: boolean;
}

export interface WardrobePayload {
  /** The kinds of place asked for, as the game's own display types. */
  displayTypes: number[];
  appearances: WardrobeAppearance[];
  readCount: number;
  /** Looks this install can reach no item of, and so can say nothing whatever about. */
  withheldCount: number;
}

/* ---------- the sets somebody puts together themselves ---------- */

/**
 * One piece of a saved outfit, as `customsets::Piece` stores it.
 *
 * The same numbers the row it was picked out of carried, written down rather than looked up
 * again — see `0017_custom_sets.sql` for why. `displayInfoId` is what the character is drawn
 * from and `appearanceId` is the game's own unit of collection, which is what lets a piece
 * inside a saved set carry the same star it carries everywhere else in the view.
 */
export interface CustomSetPiece {
  /** Where on the body it goes, in `outfit.ts`'s own words: `armour-3`, `hand-right`. */
  place: string;
  appearanceId: number;
  itemId: number;
  /** What the row was called when it was saved, which is the item the look was named after. */
  name: string;
  displayType: number;
  inventoryType: number;
  displayInfoId: number;
  iconFileDataId: number;
  hasModel: boolean;
}

/**
 * One set the reader saved off the character, whole.
 *
 * Unlike a `TransmogSet`, which is a card that costs four table walks to open: a saved set is
 * already the list of looks, so there is nothing to defer and no second command to ask with.
 */
export interface CustomSet {
  /** This database's own numbering, which is what a mark against the set is keyed by. */
  id: number;
  name: string;
  /** When it was first saved, and when it was last saved over. Seconds. */
  createdAt: number;
  updatedAt: number;
  /** In no meaningful order — `customSets.ts` puts them in the order the body reads. */
  pieces: CustomSetPiece[];
}

export interface CustomSetsPayload {
  sets: CustomSet[];
}

/* ---------- the sets the player saved in the game itself ---------- */

/**
 * One appearance in a set the player saved in game, as `ingamesets::Slot` reads it.
 *
 * `slot` is the client's own `TransmogSlot`: 0 head, 1 shoulder, 2 back, 3 chest, 4 body,
 * 5 tabard, 6 wrist, 7 hand, 8 waist, 9 legs, 10 feet, 11 main hand, 12 off hand. It is the one
 * number in the whole chain that says which *hand* a one-hander is held in, which is why it
 * survives all the way here rather than being turned into a place on the way.
 *
 * `appearanceId` is an `ItemModifiedAppearance` id — the same number a `CustomSetPiece` carries
 * as `appearanceId`, and the same number a `TransmogAppearance` carries as
 * `modifiedAppearanceId`. That one shared number is what lets all three be drawn by one lot of
 * code.
 */
export interface InGameSetSlot {
  slot: number;
  appearanceId: number;
  /** The two things a slot usually has not got. Absent rather than zero — see the migration. */
  secondaryAppearanceId?: number | null;
  illusionId?: number | null;
}

/**
 * One set the player saved in the game, as `ingamesets::InGameSet` stores it.
 *
 * Unlike a `CustomSet`, which arrives whole: this names its appearances and nothing else,
 * because names and pictures and display ids are the *game's* to say and re-recording them
 * here would be caching the game's files in a database. So a set can be listed without the
 * game installed and only opened with it — see `0018_in_game_sets.sql`.
 */
export interface InGameSet {
  /** The client's own id, which survives a rename and is what an edit names the set by. */
  id: number;
  /** Empty when the client would not say — which its own API is documented as sometimes doing. */
  name: string;
  /** The picture the game shows it under, as a FileDataID, where it names one. */
  icon?: number | null;
  /** When the addon last saw this character's wardrobe *differ*, rather than when it looked. */
  observedAt?: number | null;
  slots: InGameSetSlot[];
}

/** What one character was last seen to have saved in game. */
export interface CharacterInGameSets {
  /** `Name-Realm`, as everything else keyed by a character in this app is. */
  character: string;
  sets: InGameSet[];
}

/**
 * Every character's in-game sets.
 *
 * Keyed by character even though the game holds the sets against the *account*, because whether
 * Chronie has ever looked is a fact about a character: an alt nobody has played since the addon
 * was installed has no entry, and that is the truth rather than an empty wardrobe.
 */
export interface InGameSetsPayload {
  characters: CharacterInGameSets[];
}

/**
 * An outfit this app has asked the game to hold on to, as `ingamesets::Request` stores it.
 *
 * The one thing Chronie writes into a WoW account, and it happens in two steps: the request is
 * recorded here and the *addon* carries it out at the player's next login, because nothing in a
 * desktop app can reach a running game. So `outcome` is absent for as long as the game has not
 * been opened — which is the ordinary state of a request, not an error.
 */
export interface SetRequest {
  id: number;
  name: string;
  icon?: number | null;
  createdAt: number;
  /** `created`, `updated`, `full`, `refused` or `failed`, once the addon has answered. */
  outcome?: string | null;
  appliedAt?: number | null;
  /** The client's id for the set that resulted, where one did. */
  setId?: number | null;
  slots: InGameSetSlot[];
}

/**
 * What an in-game set is made of, once the game's files have been asked.
 *
 * The same shape as `TransmogSetItemsPayload` minus the set id, and deliberately: it is built by
 * the same four table walks over the same kind of ids, so the window opens one with the code it
 * already had for the other.
 */
export interface InGameSetAppearancesPayload {
  appearances: TransmogAppearance[];
  readCount: number;
  withheldCount: number;
}

/* ---------- what somebody says about the game's wardrobe ---------- */

/**
 * Which of the three things a mark can be against, as `marks.rs` spells them.
 *
 * A set is numbered by the game's own `TransmogSet.id`, a look by `ItemAppearance.id` and a set
 * of the reader's own by Chronie's, and the countings overlap — so the kind is half of the
 * identity and never optional. An appearance rather than an item, because everywhere else in
 * this view a row is a look and not the item that sells it.
 */
export type MarkSubjectKind = "set" | "appearance" | "custom";

/**
 * One thing somebody said about a set or a look.
 *
 * A value of `null` is a **label** — the key is the whole of what was said. That is not the
 * same as an empty string, and the backend refuses to store one: see `marks::clean_value`.
 */
export interface TransmogTag {
  key: string;
  value: string | null;
}

/**
 * Everything somebody has said about one subject.
 *
 * Only the subjects something *was* said about have one. A set nobody starred and nobody
 * tagged has no mark at all, which is what keeps the payload the size of what a person did
 * rather than the size of the game's wardrobe.
 */
export interface TransmogMark {
  kind: MarkSubjectKind;
  /** The game's own id for the thing, which is why nothing here is a foreign key. */
  id: number;
  favourite: boolean;
  /** Sorted by key, so a row of chips does not reshuffle under an unrelated edit. */
  tags: TransmogTag[];
}

/** Every mark in the database, which is the whole of what the window is ever given. */
export interface TransmogMarksPayload {
  marks: TransmogMark[];
}

/* ---------- what the game's own pictures say about it ---------- */

/**
 * What one look is like, as `qualities.rs` measured it and `apps/desktop/data/qualities/` holds
 * it.
 *
 * **The other half of a mark, and deliberately the same shape of thing.** A mark is what one
 * reader said; this is what the game's own textures and meshes say, measured once off a real
 * install and committed — so a reader with no game on the machine has it, and a reader with one
 * pays nothing for it. The window says which is which rather than mixing them, because "I called
 * this my raid set" and "this is mostly dark red" are different kinds of claim.
 *
 * These arrive by `import` rather than across the command bridge, which is why nothing in
 * `bridge.ts` mentions them: they are files in this repository, not something the backend reads
 * out of an install at runtime.
 */
export interface Quality {
  /** The `ItemAppearance.id` this was measured of — or the `TransmogSet.id`, in the sets' file. */
  id: number;
  /** The colour most of it is, as `#rrggbb`. */
  primary: string;
  /** The fullest colour that is not a shade of the primary. Absent where it is all one colour. */
  accent?: string;
  /**
   * How big it is *for its slot*: one of `small`, `medium` or `large`.
   *
   * Relative, and only within the file it is in. There is no number of metres that makes a helm
   * large, so the word is a third of that slot's own distribution — a small staff is not a small
   * anything else. Absent where nothing about the appearance could be measured, and absent
   * throughout the sets' file, a set being a body's worth of clothes whatever is in it.
   */
  size?: string;
}

/** One slot's file: every look filling it, and what the words in it were read against. */
export interface QualitiesFile {
  /** The `ItemAppearance.DisplayType` this file is of. */
  displayType: number;
  /** The build of the game it was measured off, as `.build.info` states it. */
  build: string;
  /**
   * Where the cuts between the size words fell, per way of measuring — `geometry` for the slots
   * that hang a mesh and `cover` for the ones that only paint her.
   *
   * Nothing in the window reads these. They are in the file so that a word can be audited
   * against the measurement it came from without re-running the tool, which is the difference
   * between a stored opinion and a stored reading.
   */
  sizeCuts: Record<string, { small: number; large: number; rows: number }>;
  /** Sorted by id ascending, which is what makes the committed file diffable. */
  appearances: Quality[];
}

/** The sets' file: what each of the game's own sets is like, as the looks in it are. */
export interface SetQualitiesFile {
  build: string;
  sets: Quality[];
}

/**
 * The pictures for a list of things, decoded out of the game's own textures.
 *
 * Keyed by the FileDataID whatever named them named them by — an appearance, an achievement
 * — and holding a PNG as a `data:` URL, which is how a picture reaches a window that has no
 * origin to load one from. An icon this install cannot show — a texture it never downloaded,
 * or one belonging to content the game keeps encrypted — is simply absent, because a row
 * with no icon and a row whose icon has not arrived draw the same placeholder.
 */
export interface IconsPayload {
  icons: Record<string, string>;
}

/**
 * One piece of an outfit, as the backend's `worn::Piece` reads it.
 *
 * Three numbers the rows already carry. The display is which appearance; the display type is
 * which slot, which is what says both which geoset groups it drives and where it sits in the
 * stack of textures; and the inventory type is the one thing the slot cannot say, which is
 * which hand a weapon is held in.
 */
export interface WornPiece {
  displayInfoId: number;
  displayType: number;
  inventoryType: number;
}

/**
 * The character wearing a set of clothes, as a `.glb` in a data URL.
 *
 * `null` means what it means everywhere else on this chain: there is nothing to show and the
 * window keeps the icons. What arrives when there is, is the whole body — its atlas painted
 * with every piece's textures in the order they composite, and its geosets switched to the
 * variants the pieces drive, one per group. Which is the only way the game itself draws a
 * chestpiece: there is no chestpiece, there is a character wearing one.
 *
 * No display id comes back, unlike an appearance's own model, because there is no one
 * appearance this is the answer for.
 */
export interface WornSetPayload {
  model: string | null;
}

/**
 * The character an appearance is worn on, bare, as a `.glb` in a data URL.
 *
 * One model for the whole app — whichever body the reader picked, and a Human Female until
 * somebody says otherwise, because gear is authored to look right on human proportions — so it
 * is asked for once and shown for every set opened after. There is no `null` here, unlike an
 * appearance's own model: every armour slot in the game is drawn on whatever body is chosen, so
 * an install that cannot produce it has nothing to fall back to and the command says what went
 * wrong instead.
 */
export interface CharacterModelPayload {
  model: string;
}

/** One swatch of one question about her: a `customization::Swatch`.
 *
 * The name is the game's own and is empty for most of them — a skin tone is a square of colour
 * on the character creation screen and has nothing to be called. `herself.ts` is what numbers
 * those; nothing invents a name in the payload, where a later build could contradict it.
 */
export interface CharacterSwatch {
  id: number;
  name: string;
}

/** One thing the game's own character creation screen asks about her: a `customization::Question`. */
export interface CharacterQuestion {
  id: number;
  name: string;
  /** Every answer to it, in the order the screen offers them. The first is what an unanswered
   * question takes, which is what every body in this app was before any of this. */
  swatches: CharacterSwatch[];
}

/** One answer, as it is stored and sent: a `customization::Picked`. */
export interface CharacterPick {
  question: number;
  swatch: number;
}

/** What was stored when the reader said who she is: the body, and the answers about it. */
export interface CharacterChosen {
  body: number;
  picked: CharacterPick[];
}

/** One body an appearance can be shown on: a `body::Named`, which is a `ChrModel` and a name. */
export interface CharacterBody {
  id: number;
  name: string;
}

/**
 * Who she could be and who she is, which is one payload because none of it is any use alone.
 *
 * The bodies are what this build has a mesh for; the questions are the ones the installed game
 * asks about **the body currently chosen**, so a patch that adds a hairstyle adds a swatch here
 * with no code anywhere — and picking the other body is a different list of questions entirely.
 * What has been picked is out of the settings file, and is what the backend applies to every
 * body it draws whether or not this payload was ever asked for. A question missing from `picked`
 * keeps the swatch the game itself opens on.
 */
export interface CharacterLookPayload {
  bodies: CharacterBody[];
  /** The `ChrModel` being drawn, which the questions below belong to. */
  body: number;
  questions: CharacterQuestion[];
  /** Every body's answers, not only this one's — the question ids are the game's own and no
   * two bodies share one, so switching bodies and back finds the answers still there. */
  picked: CharacterPick[];
  /** The reader's own characters, as the addon read them out of the game: a `look::Known` each.
   * Empty on an install the addon has never run on, and on a machine with no game to resolve a
   * race against. */
  characters: PlayedCharacter[];
}

/**
 * Somebody the reader actually plays, offered as a shortcut into the form: a `look::Known`.
 *
 * The other direction from everything else on the panel, which is the reader inventing a person
 * out of fifty-one bodies and a select per question. This is a person who already exists.
 *
 * `picked` is empty far more often than not, and that is not a character with no hair. The client
 * will only enumerate what a character is made of while the barber's screen is up — see
 * `look.rs` — so a character nobody has had a haircut on since Chronie was installed arrives as
 * the right body and the swatches the game itself opens on.
 */
export interface PlayedCharacter {
  /** `Name-Realm`, which is what the whole app files a character under. */
  character: string;
  /** The `ChrModel` their race and sex come to, resolved against the installed game. */
  body: number;
  picked: CharacterPick[];
}

/**
 * What a gallery row turned out to be a picture of. Mirrors the two words `gallery.rs` sends.
 *
 * `worn` is a whole character with the appearance somewhere on her, which is the only way to
 * draw armour: a chestpiece is paint on a body and there is no chestpiece. `held` is the item's
 * own mesh with no body at all, which is what a weapon, a shield and an off-hand are.
 */
export type GalleryKind = "worn" | "held";

/**
 * One row of a gallery page: an appearance, and the picture it can be shown as.
 *
 * The display id comes back with the model — unlike `WornSetPayload`, where there is no one
 * appearance the body is the answer for — because a page is a list and the window has to line
 * the answers back up with the rows it asked about.
 *
 * The kind comes back with it because the two are framed differently: a body is two metres of
 * character and the camera is pointed at the part of her the slot is on, and a held model is
 * the object with nothing else in the picture. The backend decides it, and the window reads it
 * rather than re-deriving it from the display type — one answer instead of two that can drift.
 */
export interface GalleryModel {
  displayInfoId: number;
  kind: GalleryKind;
  /** `null` for a row this install can draw nothing for, which keeps its icon. */
  model: string | null;
}

/**
 * A page of the wardrobe, every appearance on it worn on a body of its own.
 *
 * The plural of `WornSetPayload` and not of anything else: the game does not draw an item, it
 * draws a character wearing the item, because most of the game's armour has no geometry of its
 * own at all. So a gallery of twenty looks is twenty bodies, and the backend builds one body and
 * dresses it twenty times — see `gallery.rs`, and `budget.rs` for what that costs.
 */
export interface GalleryPayload {
  models: GalleryModel[];
}

/**
 * One card of the set grid, and the picture of the whole set on a body.
 *
 * There is no `kind` here and there never can be: a set is a body's worth of clothes, so the
 * picture is always a character — even for the weapon rack, where every piece of it is
 * something she is holding. `GalleryModel`'s two ways of framing a row are about showing one
 * appearance, and a set is not one appearance.
 */
export interface SetGalleryModel {
  setId: number;
  /** `null` where this install has nothing to put on her for the set. The card draws without. */
  model: string | null;
}

/**
 * A page of the set grid, each set worn whole on a body of its own.
 *
 * Asked for by id rather than by pieces, which is the one thing it does not have in common with
 * `GalleryPayload`. A card is a name and a count until somebody opens it, so the window has no
 * clothes to send: what the set is wearing is read by the backend, for the whole page out of one
 * walk of each table — see `gallery::sets`.
 */
export interface SetGalleryPayload {
  models: SetGalleryModel[];
}

/* ---------- achievements, as the game describes them ---------- */

/**
 * One achievement in the words and pictures the game shows it with.
 *
 * The addon records an id and whatever name the client had loaded at the time; this is the
 * rest, read out of the installed game rather than out of any segment. An achievement the
 * install says nothing about has none of this, which is why every reader of it starts by
 * asking whether there is one.
 */
export interface AchievementDetail {
  id: number;
  title: string;
  /** What has to be done to earn it, as one sentence. */
  description: string;
  /** What earning it grants — a title, a mount, a tabard. Empty for most of them. */
  reward: string;
  /** The tree it is filed under, outermost first. Empty when the game withholds it. */
  category: string[];
  categoryId: number;
  /** What it is worth. Zero is an answer: a feat of strength is worth nothing. */
  points: number;
  /** The picture beside it, as a FileDataID to be asked for through `gameIcons`. */
  iconFileDataId: number;
  /** `0` Horde, `1` Alliance, `-1` both — which nearly every achievement is. */
  faction: number;
}

export interface AchievementDetailsPayload {
  /** Keyed by the id the segment named, and holding only what this install can describe. */
  achievements: Record<string, AchievementDetail>;
}

/* ---------- items, as the game describes them ---------- */

/**
 * One item in the facts the game keeps about it, out of `Item` and `ItemSparse`.
 *
 * Numbers rather than words, deliberately: which subclass of armour is "Leather" and which
 * slot is "Shoulders" is the window's business, and `items.ts` is where that is decided. An
 * item this install says nothing about has none of this, which is why every reader of it
 * starts by asking whether there is one.
 */
export interface ItemDetail {
  id: number;
  /** What the game calls it. Empty for an item the big table holds no readable row for. */
  name: string;
  /** What kind of thing it is: 4 armour, 2 a weapon, and a dozen kinds nothing is worn from. */
  classId: number;
  /** Which kind of that kind — for armour, which armour class; for a weapon, which weapon. */
  subclassId: number;
  /** Where it is worn: 1 head, 5 chest, 13 a one-hander, 17 a two-hander. Zero for a thing
   * that is not worn at all. */
  inventoryType: number;
  /** The colour the game writes the name in: 0 poor through 5 legendary, 7 heirloom. */
  quality: number;
  /** The level needed to equip it. Zero is the ordinary answer. */
  requiredLevel: number;
  /** A bit per class, in the game's class order, or 0xFFFF for anybody. */
  allowableClass: number;
  /** The picture beside it, as a FileDataID to be asked for through `gameIcons`. */
  iconFileDataId: number;
}

export interface ItemDetailsPayload {
  /** Keyed by the id the segment named, and holding only what this install can describe. */
  items: Record<string, ItemDetail>;
}

/**
 * The look one item carries, as the numbers something has to have to be drawn.
 *
 * A segment holds item ids and nothing else — that is what the addon can catch at the moment
 * the game says a transmog source was learned — and every view that draws an appearance needs
 * the three below. `appearances.rs` is the hop between, and it is not made until a reader asks
 * to see one: the tables behind it are hundreds of thousands of rows.
 *
 * The three that matter are the same three `WornPiece` is made of, and the appearance id comes
 * with them because it is what the rest of the app keys a mark on.
 */
export interface ItemAppearance {
  appearanceId: number;
  displayInfoId: number;
  displayType: number;
  inventoryType: number;
}

export interface ItemAppearancesPayload {
  /**
   * Keyed by the item id asked about. An item that resolves to no look is absent rather than
   * present and empty, the same as everywhere else on this bridge.
   */
  appearances: Record<string, ItemAppearance>;
}

/**
 * The thumbnails for a grid of captures, keyed by the row id each was asked for by.
 *
 * `data:` URLs, for the same reason the icons are: the window has no origin to load a file
 * from, and every byte it draws comes across the command bridge. A capture that could not be
 * made into a thumbnail — no image, or a file that has gone missing under the row — is simply
 * absent, because a tile with no picture and a tile whose picture has not arrived yet draw the
 * same placeholder.
 */
export interface CaptureThumbnailsPayload {
  thumbnails: Record<string, string>;
}

/**
 * One capture at the size it was taken, as a `data:` URL.
 *
 * `null` is an ordinary answer rather than a failure: an entry that asked for no picture, a
 * marker whose file was never found, and a file that has disappeared from under a row that
 * says it is there all arrive this way, and the viewer says so instead of showing a broken
 * image.
 */
export interface CaptureImagePayload {
  id: number;
  image: string | null;
  byteSize?: number;
}

/**
 * How much of a screenshot Chronie keeps once it has taken custody of it. Mirrors
 * `captures::Quality`.
 *
 * Four named levels rather than a number, because a quality slider is a figure nobody can
 * predict the effect of. `original` is the file the game wrote, byte for byte; the other three
 * re-encode, and only the last two change the size. Every install that has not said otherwise
 * is on `balanced` — the store is forever and the client writes megabytes a shot.
 */
export type CaptureQuality = "original" | "high" | "balanced" | "small";

export interface Settings {
  wowPath?: string | null;
  lastSync?: string | null;
  /** Whether the addon has been asked to start combat logging at login. */
  combatLogging?: boolean;
  /** After how many days a log Chronie has read to its end is deleted. Absent or null means
   * nothing is ever deleted, which is what every install starts as. */
  retainLogDays?: number | null;
  /**
   * Which rules photograph a moment without being asked — see `captureSettings.ts` for what
   * each name means, and `ns.newCaptureTriggers` in the addon for what acts on them.
   *
   * Absent means an install this build has not written settings for yet, which the backend
   * answers with its own conservative default rather than with nothing. An explicit empty list
   * is a different thing and means what it says: photograph nothing unless a key is pressed.
   */
  captureTriggers?: string[];
  /** How much of each screenshot the store keeps. Absent reads as `balanced`. */
  captureQuality?: CaptureQuality;
  /** Whether the game keeps its own copy of a screenshot Chronie now holds. */
  keepOriginalScreenshots?: boolean;
}

/* ---------- asking the history a question directly ---------- */

/**
 * One cell of an answer. Mirrors what `query::cell` writes: SQLite's five storage classes
 * reduced to the three JSON has words for, with a blob described rather than carried.
 *
 * Numbers stay numbers all the way across, which is the whole reason the chart beside the
 * table can plot a column without parsing figures back out of text.
 */
export type QueryCell = string | number | null;

/** What one query answered. Mirrors `query::Answer`. */
export interface QueryAnswer {
  columns: string[];
  rows: QueryCell[][];
  /** True when the query had more rows than the limit allowed — see `query::MAX_ROWS`. */
  truncated: boolean;
  elapsedMs: number;
}

/** One column of a table, as the table declared it. Mirrors `query::Column`. */
export interface QueryColumn {
  name: string;
  /** The declared type — `INTEGER`, `TEXT`, and empty for the columns that have none. */
  kind: string;
  primaryKey: boolean;
}

/** One table or view a query may name. Mirrors `query::Table`. */
export interface QueryTable {
  name: string;
  view: boolean;
  /** `null` for a view, where counting the rows would mean running the view. */
  rowCount?: number | null;
  columns: QueryColumn[];
}

/** Everything a query could name. Mirrors `query::Schema`. */
export interface QuerySchema {
  tables: QueryTable[];
}

/* ---------- combat logging ---------- */

/** The newest file in the game's `Logs/` folder. Mirrors `combatlog::LogFile`. */
export interface CombatLogFile {
  name: string;
  bytes: number;
  /** Epoch seconds, or null on a filesystem that will not say. */
  modified?: number | null;
}

/**
 * Which of the four things is true of the install. Mirrors `combatlog::State`.
 *
 * `basic` and `stale` are both "asked for, not confirmed", and they are kept apart because
 * the answer to each is different: `basic` means a box to tick, `stale` means a log nobody
 * is writing to.
 */
export type CombatLogState = "off" | "basic" | "advanced" | "stale";

/** What the combat logging panel is drawn from. Mirrors `combatlog::Status`. */
export interface CombatLogStatus {
  requested: boolean;
  /** The advanced CVar as the game's own config records it. `null` means no config could be
   * read at all, which is not the same as off and is never shown as if it were. */
  advanced?: boolean | null;
  /** Which file that came from, relative to the game folder. */
  source?: string | null;
  log?: CombatLogFile | null;
  growing: boolean;
  state: CombatLogState;
}

/* ---------- clearing the logs up again ---------- */

/**
 * A group of logs, as a number to weigh and a few names to check it against. Mirrors
 * `retention::Pile` — `count` and `bytes` cover every file, `files` only the first ten.
 */
export interface LogPile {
  count: number;
  bytes: number;
  files: CombatLogFile[];
}

/** One log Chronie deleted, as the record of its going. Mirrors `retention::Gone`. */
export interface LogDeletion {
  name: string;
  bytes: number;
  modified?: number | null;
  linesRead: number;
  retainDays: number;
  /** Epoch seconds. */
  deletedAt: number;
}

/**
 * What the retention section of Settings is drawn from. Mirrors `retention::Report`.
 *
 * `doomed` is computed whether or not `enabled`, because the question worth answering before
 * somebody turns the sweeper on is which files that would cost them. That preview is the dry
 * run: it is on screen before the switch, not after the first sweep.
 */
export interface LogRetention {
  enabled: boolean;
  /** The window in days — in force when `enabled`, and previewed at when not. */
  days: number;
  doomed: LogPile;
  /** Old logs nothing has ever read. Never deleted; always shown. */
  unread: LogPile;
  /** Old logs a read has started and not finished. Transient. */
  unfinished: LogPile;
  /** What sweeps have actually removed, newest first. */
  removed: LogDeletion[];
}

export interface SyncResult {
  added: number;
  updated: number;
  segmentCount: number;
}

export interface InstallResult {
  version: string;
}

export interface AppUpdateResult {
  updated: boolean;
  version: string;
}

/**
 * Which build of Chronie this is. Mirrors `Release` in `lib.rs`.
 *
 * The channel is the rolling GitHub release the build was published under and the commit is the
 * one it was cut from — the whole forty characters, because the link needs them even though
 * nobody reads them. A commit is empty when the build came from a tree with no git behind it,
 * which is a build that cannot say where it came from rather than one that came from nowhere.
 */
export interface Release {
  channel: string;
  commit: string;
}

/* ---------- moving the history between machines ---------- */

/** A Chronie found waiting on this network. Mirrors `wifi::Peer`. */
export interface WifiPeer {
  device: string;
  /** `host:port`, which is also what a person may type in by hand. */
  address: string;
}

/** What a sender says about the database it is offering. Mirrors `wifi::Offer`. */
export interface WifiOffer {
  protocol: number;
  device: string;
  segmentCount: number;
  characterCount: number;
  newestDay?: string | null;
  bytes: number;
}

/** An offer on this machine's screen, waiting to be answered. Mirrors `wifi::Waiting`. */
export interface WifiWaiting {
  offer: WifiOffer;
  from: string;
  /** True once it has been accepted and the bytes are on their way. */
  receiving: boolean;
}

/** The last thing that happened to the receiving half. Mirrors `wifi::Outcome`. */
export interface WifiOutcome {
  stored: boolean;
  message: string;
}

/** Everything the receiving panel is drawn from. Mirrors `wifi::ReceiveStatus`. */
export interface WifiReceiveStatus {
  listening: boolean;
  device: string;
  addresses: string[];
  port: number;
  offer?: WifiWaiting | null;
  outcome?: WifiOutcome | null;
}

/** What became of a database this machine sent. Mirrors `wifi::Receipt`. */
export interface WifiReceipt {
  stored: boolean;
  reason: string;
  segmentCount: number;
}

/**
 * The whole backend, stubbed, as the end-to-end tests install it on `window`. Typing it here
 * rather than in the spec is what makes a fixture that has drifted from a command's real
 * answer a compile error instead of a puzzling test failure.
 */
export interface E2EMock {
  dashboard: DashboardPayload;
  transmog: TransmogPayload;
  /** What each set is made of, keyed by set id, as opening one asks for. */
  transmogItems: Record<number, TransmogSetItemsPayload>;
  /** Every look filling one kind of place, keyed by the display types asked for, ascending
   * and joined by commas. A key absent from here is a kind the install holds nothing for,
   * which the real backend answers with an empty list rather than an error. */
  wardrobe: Record<string, WardrobePayload>;
  /** What somebody has already said about the game's wardrobe. State rather than a fixture:
   * starring a set in the page under test writes here and the next read shows it, which is the
   * same "write, then repaint from storage" the real backend gives. */
  transmogMarks: TransmogMarksPayload;
  /** The sets this reader has saved off the character. State rather than a fixture, for the
   * reason the marks are: saving one in the page under test writes here and the browser beside
   * it then holds it, which is the same "write, then repaint from storage" the backend gives. */
  customSets: CustomSetsPayload;
  /** The sets the player saved in the game. A fixture rather than state: nothing in the app
   * changes these directly — an edit becomes a request the addon carries out at next login,
   * so what the window draws is always what the last sync read. */
  inGameSets: InGameSetsPayload;
  /** What one of those is made of once the game's files have been asked, keyed by its
   * appearance ids ascending and joined by commas — the same keying the worn sets use, and for
   * the same reason: it says which set the window actually asked to open. */
  inGameSetAppearances: Record<string, InGameSetAppearancesPayload>;
  /** The outfits somebody has asked the game to save. State rather than a fixture: sending one
   * in the page under test writes here, and it stays unanswered — which is what a real request
   * is until the player next logs in, and so the state the window mostly has to draw. */
  setRequests: SetRequest[];
  /** The bare character body, which every set detail opens on. */
  characterModel: string;
  /** What the reader may be asked about her, and what they have answered. State rather than a
   * fixture, for the reason the marks are: answering one in the page under test writes here and
   * the next read shows it, which is the "write, then repaint from storage" the backend gives.
   * The bodies do not change with it — the mock has one picture of her and no game to redraw
   * from — so what a test can see is that the window asked for them again. */
  characterLook: CharacterLookPayload;
  /** What each body is asked, keyed by `ChrModel`: picking the other body is a different list
   * of questions entirely, which the real backend re-reads out of the game. */
  characterQuestions: Record<number, CharacterQuestion[]>;
  /** The body wearing an outfit, keyed by that outfit's display ids in ascending order and
   * joined by commas — see `wornSetKey`. A key absent from here is a set this install can put
   * on nobody, which the real backend answers with `null`. Keying by the pieces rather than by
   * one of them is what lets a test say which outfit the window actually asked for, which is
   * the whole of what a row toggling changes. */
  wornSets: Record<string, string>;
  /** The decoded icons, keyed the way whatever named them named them. An id absent from here
   * is an icon the install cannot show, which is a row the real backend answers nothing for. */
  gameIcons: Record<number, string>;
  /** What the game says about each achievement, keyed by id. An id absent from here is one
   * the install can say nothing about, which the real backend also answers nothing for. */
  achievementDetails: Record<number, AchievementDetail>;
  /** What the game says about each item the segments name, keyed by id, and absent for the
   * ones an install cannot describe — the same bargain the achievements above make. */
  itemDetails: Record<number, ItemDetail>;
  /** The look each of those items carries, keyed by item id, for the rows a reader can click
   * through to a picture of. Absent for an item that resolves to no appearance, which is what
   * the real backend leaves out of its answer. */
  itemAppearances: Record<number, ItemAppearance>;
  /** The screenshots Chronie holds, keyed by capture row id: the thumbnail a grid draws and
   * the full-size picture opening one asks for. An id absent from here is a capture with no
   * image, which is what the real backend answers nothing for. */
  captureImages: Record<number, E2ECaptureImage>;
  settings: Settings;
  /** Which build the window is showing itself as, so the suite can follow the two links in the
   * app bar to a commit and a release it knows the addresses of. */
  release: Release;
  /** What the install is doing about combat logs. State rather than a fixture: ticking the
   * box in the panel under test advances it, the way the real backend's own answer changes. */
  combatLog: CombatLogStatus;
  /** What a sweep of the game's Logs folder would do. State rather than a fixture, for the
   * same reason: turning retention on in the panel has to move what the panel then says. */
  logRetention: LogRetention;
  /** The database as the Query view is allowed to see it: what a query may name, and what
   * each query it is given answers with. */
  query: E2EQuery;
  chosenPath: string;
  syncResult: SyncResult;
  installResult: InstallResult;
  appUpdate: AppUpdateResult;
  /** Where a link handed to the operating system is recorded instead, in the order asked. */
  openedUrls: string[];
  wifi: E2EWifi;
}

/**
 * SQLite, stubbed.
 *
 * There is no database behind the browser suite, so a query is answered from a table of
 * prepared answers rather than run. Keyed by the query's own text with its whitespace
 * collapsed, so a fixture can lay a statement out over several lines and a test can type it
 * however it likes. An entry carrying `error` is a query the real backend would refuse, which
 * is how the one path that matters most — a mistake, said plainly, with the editor intact —
 * is reachable at all.
 */
export interface E2EQuery {
  schema: QuerySchema;
  answers: Record<string, QueryAnswer | { error: string }>;
}

/** One capture's pictures as the mock holds them: the tile, and the thing behind it. */
export interface E2ECaptureImage {
  thumbnail: string;
  full: string;
  byteSize: number;
}

/**
 * The WiFi station, stubbed. `status` is state rather than a fixture: the mock advances it
 * the way the backend's own station would, so the page under test walks the same
 * start-offer-answer path a real transfer takes.
 */
export interface E2EWifi {
  peers: WifiPeer[];
  receipt: WifiReceipt;
  status: WifiReceiveStatus;
  /** The offer that turns up once this Chronie starts waiting, if the fixture has one. */
  incoming?: WifiWaiting | null;
  /** Where a database was offered, in the order offered. */
  sentTo: string[];
}

/**
 * The keys under which a segment carries a list of events, and the event a given one holds.
 *
 * Several places walk those lists by name — the highlight builder, the details table's
 * column declarations — and this is what keeps `segment.achievements` and the function that
 * formats an achievement tied together rather than agreeing by convention.
 */
export type EventListKey = {
  [K in keyof Segment]-?: NonNullable<Segment[K]> extends unknown[] ? K : never;
}[keyof Segment];

export type EventOf<K extends EventListKey> = NonNullable<Segment[K]>[number];

/** Reads one of those lists off a segment, defaulting the absent ones to empty. */
export const eventsOf = <K extends EventListKey>(segment: Segment, key: K): Array<EventOf<K>> =>
  (segment[key] ?? []) as Array<EventOf<K>>;

declare global {
  // eslint-disable-next-line no-var -- a `var` is the only declaration that reaches globalThis.
  var __Chronie_E2E__: E2EMock | undefined;
}
