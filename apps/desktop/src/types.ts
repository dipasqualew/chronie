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
  pets?: CollectibleEvent[];
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
 * One model for the whole app — a Human Female, because gear is authored to look right on
 * human proportions — so it is asked for once and shown for every set opened after. There is
 * no `null` here, unlike an appearance's own model: every armour slot in the game is drawn on
 * this one mesh, so an install that cannot produce it has nothing to fall back to and the
 * command says what went wrong instead.
 */
export interface CharacterModelPayload {
  model: string;
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

export interface Settings {
  wowPath?: string | null;
  lastSync?: string | null;
  /** Whether the addon has been asked to start combat logging at login. */
  combatLogging?: boolean;
  /** After how many days a log Chronie has read to its end is deleted. Absent or null means
   * nothing is ever deleted, which is what every install starts as. */
  retainLogDays?: number | null;
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
 * What the retention section of Setup is drawn from. Mirrors `retention::Report`.
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
  /** The bare character body, which every set detail opens on. */
  characterModel: string;
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
  /** The screenshots Chronie holds, keyed by capture row id: the thumbnail a grid draws and
   * the full-size picture opening one asks for. An id absent from here is a capture with no
   * image, which is what the real backend answers nothing for. */
  captureImages: Record<number, E2ECaptureImage>;
  settings: Settings;
  /** What the install is doing about combat logs. State rather than a fixture: ticking the
   * box in the panel under test advances it, the way the real backend's own answer changes. */
  combatLog: CombatLogStatus;
  /** What a sweep of the game's Logs folder would do. State rather than a fixture, for the
   * same reason: turning retention on in the panel has to move what the panel then says. */
  logRetention: LogRetention;
  chosenPath: string;
  syncResult: SyncResult;
  installResult: InstallResult;
  appUpdate: AppUpdateResult;
  /** Where a link handed to the operating system is recorded instead, in the order asked. */
  openedUrls: string[];
  wifi: E2EWifi;
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
