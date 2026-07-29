/**
 * Domain-only frontend types and aliases for Rust-generated command DTOs.
 *
 * `bindings.ts` is authoritative for every value that crosses the Tauri boundary. The aliases
 * below preserve the vocabulary the views use without mirroring any payload by hand.
 */

export type {
  AchievementDetail,
  AchievementDetailsPayload,
  AchievementEvent,
  Activity,
  ActivitySource,
  ActivityValue,
  AccountCurrency,
  AccountFaction,
  AccountGold,
  AccountHoldings,
  Alternate,
  AppUpdateResult,
  Capture,
  CaptureImagePayload,
  CaptureImageState,
  CaptureThumbnailsPayload,
  CharacterBody,
  CharacterChosen,
  CharacterLookPayload,
  CharacterModelPayload,
  CharacterPick,
  CharacterQuestion,
  CharacterStanding,
  CharacterSwatch,
  CollectibleEvent,
  CurrencyGain,
  CurrencyHolder,
  CustomSet,
  CustomSetsPayload,
  DashboardPayload,
  EncounterEvent,
  EquipsetChangeEvent,
  EquipsetChangeKind,
  EquipsetSlotChange,
  ExperienceGain,
  GalleryKind,
  GalleryModel,
  GalleryPayload,
  GoldHolder,
  HousingItemEvent,
  IconsPayload,
  InGameSet,
  InGameSetAppearancesPayload,
  InGameSetsPayload,
  InstallResult,
  ItemAppearance,
  ItemAppearancesPayload,
  ItemDetail,
  ItemDetailsPayload,
  KeystoneRun,
  LevelUpEvent,
  PlayedCharacter,
  QueryAnswer,
  QueryCell,
  QueryColumn,
  QuerySchema,
  QueryTable,
  QuestEvent,
  Release,
  ReputationGain,
  SameLookReason,
  Segment,
  SetGalleryModel,
  SetGalleryPayload,
  SettingsPayload as Settings,
  SyncResult,
  TransmogAppearance,
  TransmogEvent,
  TransmogPayload,
  TransmogSet,
  TransmogSetItemsPayload,
  WardrobeAppearance,
  WardrobePayload,
  WornPiece,
  WornSetPayload,
  Piece as CustomSetPiece,
  CharacterSets as CharacterInGameSets,
  Slot as InGameSetSlot,
  Request as SetRequest,
  TransmogTag,
  TransmogMark,
  TransmogMarksPayload,
  Quality as CaptureQuality,
  LogFile as CombatLogFile,
  State as CombatLogState,
  Status as CombatLogStatus,
  Pile as LogPile,
  Gone as LogDeletion,
  Report as LogRetention,
  Verdict as SessionGap,
  Gap as LostSession,
  Peer as WifiPeer,
  Offer as WifiOffer,
  Waiting as WifiWaiting,
  Outcome as WifiOutcome,
  ReceiveStatus as WifiReceiveStatus,
  Receipt as WifiReceipt,
} from "./bindings";

import type {
  AchievementDetail,
  AppUpdateResult,
  CharacterLookPayload,
  CharacterQuestion,
  CustomSetsPayload,
  DashboardPayload,
  InGameSetAppearancesPayload,
  InGameSetsPayload,
  InstallResult,
  ItemAppearance,
  ItemDetail,
  Peer,
  QueryAnswer,
  QuerySchema,
  Receipt,
  ReceiveStatus,
  Report,
  Release,
  Request,
  Segment,
  SettingsPayload,
  Status,
  SyncResult,
  TransmogPayload,
  TransmogMarksPayload,
  TransmogSetItemsPayload,
  Verdict,
  Waiting,
  WardrobePayload,
} from "./bindings";

import type { commands } from "./bindings";

export type ActivityMetadata = Parameters<typeof commands.addActivity>[2];

/** A subject the local transmog annotation store accepts. */
export type MarkSubjectKind = "set" | "appearance" | "custom";

/** A measured colour/size annotation used by fixture files, not by a command. */
export interface Quality {
  id: number;
  primary: string;
  accent?: string;
  size?: string;
}

export interface QualitiesFile {
  displayType: number;
  build: string;
  sizeCuts: Record<string, Record<string, number>>;
  appearances: Quality[];
}

export interface SetQualitiesFile {
  build: string;
  sets: Quality[];
}

/**
 * The composable browser fixture. Its fields are command answers plus the state each area
 * adapter mutates while a scenario runs.
 */
export interface E2EMock {
  dashboard: DashboardPayload;
  transmog: TransmogPayload;
  transmogItems: Record<number, TransmogSetItemsPayload>;
  wardrobe: Record<string, WardrobePayload>;
  transmogMarks: TransmogMarksPayload;
  customSets: CustomSetsPayload;
  inGameSets: InGameSetsPayload;
  inGameSetAppearances: Record<string, InGameSetAppearancesPayload>;
  setRequests: Request[];
  characterModel: string;
  characterLook: CharacterLookPayload;
  characterQuestions: Record<number, CharacterQuestion[]>;
  wornSets: Record<string, string>;
  /** Whose body the window asked an outfit to be drawn on, in the order asked. State rather
   * than a fixture, and the only thing a test can see of that question: the mock holds one
   * picture of a body and has no game to redraw it from, so what is checkable is that the
   * character view asked on behalf of the character whose page it is. */
  wornSetsAskedFor: string[];
  /** The decoded icons, keyed the way whatever named them named them. An id absent from here
   * is an icon the install cannot show, which is a row the real backend answers nothing for. */
  gameIcons: Record<number, string>;
  /** The picture each currency is drawn with, keyed by the currency's own id rather than by the
   * file behind it — which is the whole shape of the real command, because the hop from one to
   * the other happens in the backend. A currency absent from here is one the game names no
   * picture for, which the real backend also leaves out. */
  currencyIcons: Record<number, string>;
  /** The picture each place is drawn with, keyed by the name a segment was filed under rather
   * than by the file behind it — which is the whole shape of the real command, because the hop
   * from one to the other happens in the backend. A place absent from here is one the game names
   * no picture for, which is most of them: the open world has none anywhere. */
  placeIcons: Record<string, string>;
  /** What the game says about each achievement, keyed by id. An id absent from here is one
   * the install can say nothing about, which the real backend also answers nothing for. */
  achievementDetails: Record<number, AchievementDetail>;
  itemDetails: Record<number, ItemDetail>;
  itemAppearances: Record<number, ItemAppearance>;
  captureImages: Record<number, E2ECaptureImage>;
  settings: SettingsPayload;
  release: Release;
  combatLog: Status;
  /** What the backend makes of the install's combat log against the history it holds. A
   * fixture rather than something the mock derives, because the rule that produces it is
   * `gap.rs` and is tested there — what a browser test is for is what the window does with
   * each answer. */
  sessionGap: Verdict;
  logRetention: Report;
  query: E2EQuery;
  chosenPath: string;
  syncResult: SyncResult;
  installResult: InstallResult;
  appUpdate: AppUpdateResult;
  openedUrls: string[];
  wifi: E2EWifi;
}

export interface E2EQuery {
  schema: QuerySchema;
  answers: Record<string, QueryAnswer | { error: string }>;
}

export interface E2ECaptureImage {
  thumbnail: string;
  full: string;
  byteSize: number;
}

export interface E2EWifi {
  peers: Peer[];
  receipt: Receipt;
  status: ReceiveStatus;
  incoming?: Waiting | null;
  sentTo: string[];
}

export type EventListKey = {
  [K in keyof Segment]-?: NonNullable<Segment[K]> extends unknown[] ? K : never;
}[keyof Segment];

export type EventOf<K extends EventListKey> = NonNullable<Segment[K]>[number];

export const eventsOf = <K extends EventListKey>(segment: Segment, key: K): Array<EventOf<K>> =>
  (segment[key] ?? []) as Array<EventOf<K>>;

declare global {
  // A `var` is the only declaration that reaches globalThis.
  var __Chronie_E2E__: E2EMock | undefined;
}
