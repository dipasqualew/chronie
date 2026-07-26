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
}

export interface ReputationGain {
  faction: string;
  amount: number;
  at?: number | null;
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
  encounters?: EncounterEvent[];
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
  appearanceId: number;
  /** Which slot it fills: 0 head, 1 shoulder, 2–10 the rest of the armour, 11 up weapons. */
  displayType: number;
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
 * The pictures for a set's appearances, decoded out of the game's own textures.
 *
 * Keyed by the FileDataID the appearance named, and holding a PNG as a `data:` URL, which is
 * how a picture reaches a window that has no origin to load one from. An icon this install
 * cannot show — a texture it never downloaded, or one belonging to content the game keeps
 * encrypted — is simply absent, because a row with no icon and a row whose icon has not
 * arrived draw the same placeholder.
 */
export interface TransmogIconsPayload {
  icons: Record<string, string>;
}

export interface Settings {
  wowPath?: string | null;
  lastSync?: string | null;
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
 * The whole backend, stubbed, as the end-to-end tests install it on `window`. Typing it here
 * rather than in the spec is what makes a fixture that has drifted from a command's real
 * answer a compile error instead of a puzzling test failure.
 */
export interface E2EMock {
  dashboard: DashboardPayload;
  transmog: TransmogPayload;
  /** What each set is made of, keyed by set id, as opening one asks for. */
  transmogItems: Record<number, TransmogSetItemsPayload>;
  /** The decoded icons, keyed the way the appearances name them. An id absent from here is
   * an icon the install cannot show, which is a row the real backend answers nothing for. */
  transmogIcons: Record<number, string>;
  settings: Settings;
  chosenPath: string;
  syncResult: SyncResult;
  installResult: InstallResult;
  appUpdate: AppUpdateResult;
  /** Where a link handed to the operating system is recorded instead, in the order asked. */
  openedUrls: string[];
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
