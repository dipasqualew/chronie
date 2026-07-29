import { openUrl } from "@tauri-apps/plugin-opener";

import { wearable as canBeWorn, wornSetKey } from "./modelPreview";
import { appearanceRows } from "./transmogModal";

import type {
  AchievementDetail,
  AchievementDetailsPayload,
  Activity,
  ActivityMetadata,
  AppUpdateResult,
  Capture,
  CaptureImagePayload,
  CaptureQuality,
  CaptureThumbnailsPayload,
  CharacterLookPayload,
  CharacterChosen,
  CharacterModelPayload,
  CharacterPick,
  CombatLogStatus,
  CustomSetPiece,
  CustomSetsPayload,
  DashboardPayload,
  GalleryKind,
  GalleryPayload,
  IconsPayload,
  InGameSetAppearancesPayload,
  InGameSetSlot,
  InGameSetsPayload,
  InstallResult,
  ItemDetail,
  ItemAppearance,
  ItemAppearancesPayload,
  ItemDetailsPayload,
  LogRetention,
  MarkSubjectKind,
  QueryAnswer,
  QuerySchema,
  Release,
  Segment,
  SessionGap,
  SetGalleryPayload,
  SetRequest,
  Settings,
  SyncResult,
  TransmogMark,
  TransmogMarksPayload,
  TransmogPayload,
  TransmogSetItemsPayload,
  WardrobePayload,
  WifiPeer,
  WifiReceipt,
  WifiReceiveStatus,
  WornPiece,
  WornSetPayload,
} from "./types";

const mock = globalThis.__Chronie_E2E__;

const missingMock = <Value>(): Promise<Value> =>
  Promise.reject(new Error("The end-to-end mock is not installed."));

/** Picks the segment an edit belongs to. */
type Locate = (segment: Segment) => boolean;

/** Applies the edit to that segment's activity list, given the next free activity id. */
type Apply = (activities: Activity[], nextId: number) => void;

export const e2eDesktop = {
  pollDashboard: false,
  reloadWindow: (_after: number): void => undefined,
  dashboard: (): Promise<DashboardPayload> =>
    mock ? Promise.resolve(structuredClone(mock.dashboard)) : missingMock(),
  // Reading the game's own tables takes about a second and a couple of hundred megabytes
  // of transient memory, so the window asks only when the view is first opened.
  transmogSets: (): Promise<TransmogPayload> =>
    mock ? Promise.resolve(structuredClone(mock.transmog)) : missingMock(),
  // Opening a set walks four more of the game's tables, so it is asked for per set rather
  // than loaded with the grid — a wardrobe's worth of joins nobody has clicked on is waste.
  transmogSetItems: (setId: number): Promise<TransmogSetItemsPayload> =>
    mock
      ? Promise.resolve(structuredClone(mock.transmogItems[setId] ?? emptySet(setId)))
      : missingMock(),
  // Every look filling one kind of place, which is the other way of browsing the game: asked
  // for a kind at a time, because the whole wardrobe is fifty-five thousand rows and fourteen
  // megabytes. Kept by the caller once it arrives — what the game holds cannot change under a
  // running window — so a reader going back and forth between two kinds pays for each once.
  transmogAppearances: (displayTypes: number[]): Promise<WardrobePayload> =>
    mock
      ? Promise.resolve(
          structuredClone(mock.wardrobe[wardrobeKey(displayTypes)] ?? emptyWardrobe(displayTypes)),
        )
      : missingMock(),
  // Everything anybody has said about the game's wardrobe with their own hands: a star and a
  // set of tags, against a set or a look. Read whole, because it is the size of what one person
  // typed rather than the size of the game — and re-read after every write below, so what the
  // browser draws is what the database holds.
  transmogMarks: (): Promise<TransmogMarksPayload> =>
    mock ? Promise.resolve(structuredClone(mock.transmogMarks)) : missingMock(),
  setTransmogFavourite: (
    kind: MarkSubjectKind,
    id: number,
    favourite: boolean,
  ): Promise<TransmogMarksPayload> =>
    mock
      ? Promise.resolve(
          mockMark(kind, id, (mark) => {
            mark.favourite = favourite;
          }),
        )
      : missingMock(),
  setTransmogTag: (
    kind: MarkSubjectKind,
    id: number,
    key: string,
    value: string | null,
  ): Promise<TransmogMarksPayload> => {
    if (!mock) return missingMock();
    // The half of `marks::clean_key` and `clean_value` a test can tell apart from a working
    // field: the whitespace made ordinary, and a value that says nothing stored as a label.
    const cleaned = key.trim().replace(/\s+/g, " ");
    const said = (value ?? "").trim().replace(/\s+/g, " ") || null;
    if (!cleaned) return Promise.reject(new Error("A tag needs a name."));
    return Promise.resolve(
      mockMark(kind, id, (mark) => {
        const at = mark.tags.findIndex((tag) => sameKey(tag.key, cleaned));
        if (at >= 0) mark.tags[at] = { key: cleaned, value: said };
        else mark.tags.push({ key: cleaned, value: said });
        mark.tags.sort((left, right) => left.key.localeCompare(right.key));
      }),
    );
  },
  deleteTransmogTag: (
    kind: MarkSubjectKind,
    id: number,
    key: string,
  ): Promise<TransmogMarksPayload> =>
    mock
      ? Promise.resolve(
          mockMark(kind, id, (mark) => {
            mark.tags = mark.tags.filter((tag) => !sameKey(tag.key, key));
          }),
        )
      : missingMock(),
  // The sets the reader put together on the character themselves. Read whole and re-read after
  // every write, for the reason the marks are: tens of sets somebody saved by hand, against the
  // several thousand the game ships, and what the browser draws should be what was stored.
  customSets: (): Promise<CustomSetsPayload> =>
    mock ? Promise.resolve(structuredClone(mock.customSets)) : missingMock(),
  saveCustomSet: (name: string, pieces: CustomSetPiece[]): Promise<CustomSetsPayload> => {
    if (!mock) return missingMock();
    // The half of `customsets::clean_name` and `clean_pieces` a test can tell apart from a
    // working form: a name is tidied and required, and an empty outfit is not a set.
    const cleaned = name.trim().replace(/\s+/g, " ");
    if (!cleaned) {
      return Promise.reject(new Error("Give the set a name and it will be saved under it."));
    }
    if (!pieces.length) {
      return Promise.reject(
        new Error("Put something on her first, and then it can be saved as a set."),
      );
    }
    const sets = mock.customSets.sets;
    const at = sets.findIndex((set) => sameKey(set.name, cleaned));
    const now = Math.floor(Date.now() / 1000);
    // Saving over a set by name, which is the backend's own `ON CONFLICT(name)`: the same set
    // keeps its id — and so keeps whatever was said about it — and takes the new clothes.
    if (at >= 0) sets[at] = { ...sets[at]!, name: cleaned, updatedAt: now, pieces };
    else {
      const id = sets.reduce((highest, set) => Math.max(highest, set.id), 0) + 1;
      sets.push({ id, name: cleaned, createdAt: now, updatedAt: now, pieces });
    }
    sets.sort((left, right) => left.name.localeCompare(right.name));
    return Promise.resolve(structuredClone(mock.customSets));
  },
  deleteCustomSet: (id: number): Promise<CustomSetsPayload> => {
    if (!mock) return missingMock();
    mock.customSets.sets = mock.customSets.sets.filter((set) => set.id !== id);
    // And everything said about it, which the backend deletes in the same breath: the ids are
    // Chronie's own, so a mark left behind is one the next set saved could find itself wearing.
    mock.transmogMarks.marks = mock.transmogMarks.marks.filter(
      (mark) => !(mark.kind === "custom" && mark.id === id),
    );
    return Promise.resolve(structuredClone(mock.customSets));
  },
  // The sets the player saved in the *game*, which the addon reports and nothing here writes.
  // Read once with the rest of the transmog screen: this is a snapshot of what the last sync
  // found, and it changes when the player changes it in game rather than when anything here
  // does.
  inGameSets: (): Promise<InGameSetsPayload> =>
    mock ? Promise.resolve(structuredClone(mock.inGameSets)) : missingMock(),
  // And what one of them is made of, which costs the game's files. An in-game set names its
  // appearances and nothing else — see `0018_in_game_sets.sql` — so this is the hop from ids to
  // rows, and it is why a set can be listed on a machine without the game and only opened on
  // one with it.
  inGameSetAppearances: (appearanceIds: number[]): Promise<InGameSetAppearancesPayload> => {
    if (!mock) return missingMock();
    // Keyed the way the worn sets are, so a test can say which set the window asked to open
    // rather than only that it asked for something.
    const key = [...appearanceIds].sort((left, right) => left - right).join(",");
    return Promise.resolve(
      structuredClone(
        mock.inGameSetAppearances[key] ?? { appearances: [], readCount: 0, withheldCount: 0 },
      ),
    );
  },
  // The one thing Chronie writes into a WoW account, and it is deliberately two steps: this
  // records the request, and the *addon* saves the set the next time the player logs in. See
  // `docs/transmog-sets.md` — nothing in a desktop app can reach a running game.
  sendSetToGame: (
    name: string,
    icon: number | null,
    slots: InGameSetSlot[],
  ): Promise<SetRequest[]> => {
    if (!mock) return missingMock();
    // The half of the backend's own refusals a test can tell apart from a working form, the
    // same two `saveCustomSet` above models: a name is required, and an empty outfit is not
    // an outfit.
    const cleaned = name.trim().replace(/\s+/g, " ");
    if (!cleaned) {
      return Promise.reject(new Error("Give the set a name and it will be saved under it."));
    }
    if (!slots.length) {
      return Promise.reject(
        new Error("Put something on her first, and then it can be sent to the game."),
      );
    }
    // Unanswered, which is what a real one is until the player has logged in — so the fixture
    // is in the state the window actually has to draw rather than the one it ends in.
    const id = mock.setRequests.reduce((highest, one) => Math.max(highest, one.id), 0) + 1;
    mock.setRequests.unshift({
      id,
      name: cleaned,
      icon,
      createdAt: Math.floor(Date.now() / 1000),
      slots,
    });
    return Promise.resolve(structuredClone(mock.setRequests));
  },
  setRequests: (): Promise<SetRequest[]> =>
    mock ? Promise.resolve(structuredClone(mock.setRequests)) : missingMock(),
  // What the game says about a list of achievements the segments named. The backend keeps
  // every one it has looked up, so a reader walking a history of them pays for each once.
  achievementDetails: (ids: number[]): Promise<AchievementDetailsPayload> =>
    mock ? Promise.resolve({ achievements: mockAchievements(ids) }) : missingMock(),
  // What the game says about a list of items the segments named — the transmog collected, the
  // pieces an equipment set holds. Batched by the caller rather than asked one item at a time,
  // because the read behind it opens the game's largest table once per request however many
  // ids that request carries.
  itemDetails: (ids: number[]): Promise<ItemDetailsPayload> =>
    mock ? Promise.resolve({ items: mockItems(ids) }) : missingMock(),
  // The look an item carries, which a segment has no other way to reach: it holds item ids, and
  // drawing an appearance takes the display it resolves to. Asked when a reader clicks a row
  // rather than when the segment is drawn — the three tables behind it are hundreds of thousands
  // of rows, and a modal listing thirty sources would walk them to fill in pictures nobody
  // asked to see.
  itemAppearances: (itemIds: number[]): Promise<ItemAppearancesPayload> =>
    mock ? Promise.resolve({ appearances: mockItemAppearances(itemIds) }) : missingMock(),
  // The pictures a list of rows needs, asked for once the rows are drawn. The backend keeps
  // every texture it has decoded, so this is answered from memory for everything a
  // neighbouring set or an earlier segment already showed.
  gameIcons: (iconFileDataIds: number[]): Promise<IconsPayload> =>
    mock ? Promise.resolve({ icons: mockIcons(iconFileDataIds) }) : missingMock(),
  // Currency ids need one backend-only table hop before they become texture ids, so this
  // command is keyed by the currency the view already has rather than by the file behind it.
  currencyIcons: (currencyIds: number[]): Promise<IconsPayload> =>
    mock ? Promise.resolve({ icons: mockCurrencyIcons(currencyIds) }) : missingMock(),
  // Place names need two backend-only table hops before they become texture ids, so this command
  // is keyed by the name the segment already carries rather than by the file behind it.
  placeIcons: (places: string[]): Promise<IconsPayload> =>
    mock ? Promise.resolve({ icons: mockPlaceIcons(places) }) : missingMock(),
  // And the bosses inside them, on the same terms: the encounter id the addon recorded needs the
  // same two backend-only hops before it is a texture, so the command is keyed by the id.
  bossPortraits: (encounters: number[]): Promise<IconsPayload> =>
    mock ? Promise.resolve({ icons: mockBossPortraits(encounters) }) : missingMock(),
  // The body every appearance is worn on. One model for the whole app, so the window asks the
  // first time a set is opened and keeps it for every set after.
  characterModel: (): Promise<CharacterModelPayload> =>
    mock ? Promise.resolve({ model: mock.characterModel }) : missingMock(),
  // Who that body is: everything the game's own character creation screen asks about her, and
  // what this reader has answered. Asked for only when somebody opens the panel that shows it —
  // it walks five of the game's tables, and every body drawn above already has the answers
  // applied whether or not anybody ever looks at them.
  characterLook: (): Promise<CharacterLookPayload> =>
    mock ? Promise.resolve(structuredClone(mock.characterLook)) : missingMock(),
  // And says who she is from now on, answering with what was stored. Nothing is drawn by this:
  // the window redraws her by asking for the bodies again, which is the errand it already runs
  // whenever what she is wearing changes.
  saveCharacterLook: (body: number, picked: CharacterPick[]): Promise<CharacterChosen> => {
    if (!mock) return missingMock();
    // The half of `body::known` and `customization::clean` a test can tell apart from a working
    // form: a body has to be one on offer, and a question takes one answer, the last winning.
    if (!mock.characterLook.bodies.some((one) => one.id === body)) {
      return Promise.reject(new Error("There is no body of that kind to draw her on."));
    }
    const cleaned: CharacterPick[] = [];
    for (const answer of picked) {
      if (!answer.question || !answer.swatch) {
        return Promise.reject(
          new Error("That choice names no question of hers, or no swatch of it."),
        );
      }
      const held = cleaned.find((one) => one.question === answer.question);
      if (held) held.swatch = answer.swatch;
      else cleaned.push({ ...answer });
    }
    mock.characterLook.body = body;
    mock.characterLook.picked = cleaned;
    // The questions the *other* body is asked, because that is what changing body means: the
    // real backend re-reads them out of the game for whichever body is now being drawn.
    mock.characterLook.questions = mock.characterQuestions[body] ?? [];
    return Promise.resolve({ body, picked: structuredClone(cleaned) });
  },
  // The same body wearing a set of clothes, which is how every slot is shown. A list rather
  // than one appearance because two of the three subsystems behind character rendering exist
  // to arbitrate between pieces — which of two owns a contested geoset group, and which of two
  // textures painting the same rectangle goes on top — and neither can be asked one piece at a
  // time. Each piece carries the slot, which says which geoset groups it drives and where it
  // sits in the stack, and where the item is worn, which says which hand a weapon is in.
  wornSet: (pieces: WornPiece[]): Promise<WornSetPayload> =>
    mock ? Promise.resolve({ model: mock.wornSets[wornSetKey(pieces)] ?? null }) : missingMock(),
  // The same outfit on a named character's body. The fixture holds one model, so it records
  // whose body was requested and answers the picture for the clothes.
  characterWornSet: (character: string, pieces: WornPiece[]): Promise<WornSetPayload> => {
    if (!mock) return missingMock();
    mock.wornSetsAskedFor.push(character);
    return Promise.resolve({ model: mock.wornSets[wornSetKey(pieces)] ?? null });
  },
  // A page of the wardrobe, each look on a body of its own. A page at a time rather than a row
  // at a time because the two cost almost the same: the body, her skin and the game's six tables
  // are read once for whatever is asked for, and a row adds only its own textures and geometry.
  // The stub answers each row out of the same map `wornSet` reads, because a gallery row *is* an
  // outfit of one and gets the same key.
  galleryModels: (pieces: WornPiece[]): Promise<GalleryPayload> =>
    mock
      ? Promise.resolve({
          models: pieces.map((piece) => ({
            displayInfoId: piece.displayInfoId,
            kind: mockGalleryKind(piece.displayType),
            model: mock.wornSets[wornSetKey([piece])] ?? null,
          })),
        })
      : missingMock(),
  // And a page of the *set* grid, each card worn whole. Ids rather than pieces, because a card
  // is a name and a count until somebody opens it: what the set is wearing is read by the
  // backend for the whole page rather than by the window opening a dozen sets to draw one.
  //
  // The stub answers each card out of the same map `wornSet` reads, keyed by what the set is
  // wearing — because that is exactly what a card's picture is, and a fixture that answered
  // some other body would let a card showing the wrong clothes pass.
  gallerySets: (setIds: number[]): Promise<SetGalleryPayload> =>
    mock
      ? Promise.resolve({
          models: setIds.map((setId) => ({
            setId,
            model: mock.wornSets[wornSetKey(mockSetPieces(setId))] ?? null,
          })),
        })
      : missingMock(),
  // One question, typed by the reader, asked of their own history. The backend refuses
  // anything that is not a read and stops anything that will not finish, so what can come
  // back from here is rows or a sentence about why there are none.
  runQuery: (sql: string, _limit: number): Promise<QueryAnswer> =>
    mock ? mockQuery(sql) : missingMock(),
  // What the history holds, so a query can be written without reading the migrations. Asked
  // for when the view is first opened and kept: tables do not appear while somebody is typing.
  querySchema: (): Promise<QuerySchema> =>
    mock ? Promise.resolve(structuredClone(mock.query.schema)) : missingMock(),
  // Links leave the app entirely: the backend asks the operating system to open them, which
  // is the only way a page in a Tauri window reaches the reader's browser.
  openUrl: (url: string): Promise<void> => {
    if (mock) {
      mock.openedUrls.push(url);
      return Promise.resolve();
    }
    return openUrl(url);
  },
  settings: (): Promise<Settings> =>
    mock ? Promise.resolve(structuredClone(mock.settings)) : missingMock(),
  // Which build is running, which is baked into the binary at compile time and cannot change
  // under a window that is already open — so it is asked for once, on the way to the first paint.
  release: (): Promise<Release> =>
    mock ? Promise.resolve(structuredClone(mock.release)) : missingMock(),
  chooseWowPath: (): Promise<string | null> =>
    mock ? Promise.resolve(mock.chosenPath) : missingMock(),
  saveWowPath: (wowPath: string): Promise<Settings> => {
    if (mock) {
      mock.settings.wowPath = wowPath;
      return Promise.resolve(mock.settings);
    }
    return missingMock();
  },
  syncNow: (): Promise<SyncResult> => (mock ? Promise.resolve(mock.syncResult) : missingMock()),
  // What the install is really doing about combat logs — read from the game's own config and
  // its Logs folder, not from the setting, which is why it is worth asking repeatedly.
  combatLogging: (): Promise<CombatLogStatus> =>
    mock ? Promise.resolve(structuredClone(mock.combatLog)) : missingMock(),
  // Answers with the state the change leaves behind rather than an acknowledgement, so the
  // panel repaints from what the install now says. The mock advances its own state the way
  // the backend does: the setting moves, and nothing about the game's config moves with it.
  setCombatLogging: (enabled: boolean): Promise<CombatLogStatus> => {
    if (mock) {
      mock.settings.combatLogging = enabled;
      mock.combatLog.requested = enabled;
      mock.combatLog.state = mockCombatLogState(mock.combatLog);
      return Promise.resolve(structuredClone(mock.combatLog));
    }
    return missingMock();
  },
  // Whether an evening was played that the game never wrote out. A fixture, because the rule
  // behind it reads two files and a database and is tested where it lives; what a browser
  // test asks is what the timeline does when the answer comes back missing.
  sessionGap: (): Promise<SessionGap> =>
    mock ? Promise.resolve(structuredClone(mock.sessionGap)) : missingMock(),
  // What a sweep of the game's Logs folder would delete, what it will not touch, and what it
  // already has. Asked for rather than assumed, because all three change under the app.
  logRetention: (): Promise<LogRetention> =>
    mock ? Promise.resolve(structuredClone(mock.logRetention)) : missingMock(),
  // `null` turns the sweeper off. Nothing is deleted by this call: it records a setting, and
  // the sweep happens on the next sync. The mock moves the same two facts the backend does —
  // whether it is on, and at what window — and leaves the piles where they are, because what
  // is in the folder does not change just because somebody ticked a box.
  setLogRetention: (days: number | null): Promise<LogRetention> => {
    if (mock) {
      mock.settings.retainLogDays = days;
      mock.logRetention.enabled = days !== null;
      if (days !== null) mock.logRetention.days = days;
      return Promise.resolve(structuredClone(mock.logRetention));
    }
    return missingMock();
  },
  // Which things photograph themselves. The list reaches the game inside the addon, so the
  // backend reinstalls it on the way through — and answers with the whole of the settings, so
  // the panel repaints from what was stored. The mock records the same list the real one saves.
  setCaptureTriggers: (triggers: string[]): Promise<Settings> => {
    if (mock) {
      mock.settings.captureTriggers = triggers;
      return Promise.resolve(structuredClone(mock.settings));
    }
    return missingMock();
  },
  // What is kept of a picture, and whether the game keeps its own copy. The two travel together
  // because they are one decision about disk, and neither reaches the addon at all.
  setCaptureStorage: (quality: CaptureQuality, keepOriginals: boolean): Promise<Settings> => {
    if (mock) {
      mock.settings.captureQuality = quality;
      mock.settings.keepOriginalScreenshots = keepOriginals;
      return Promise.resolve(structuredClone(mock.settings));
    }
    return missingMock();
  },
  // Every activity command answers with the whole dashboard, so the window repaints from
  // what was actually stored rather than from what the page hoped the write did. Under the
  // e2e mock the same shape is produced by editing the mock's dashboard in place.
  addActivity: (
    segmentId: number,
    kind: string,
    metadata: ActivityMetadata,
  ): Promise<DashboardPayload> =>
    mock
      ? Promise.resolve(
          mockEdit(bySegment(segmentId), (activities, nextId) => {
            dropInferred(activities, kind);
            activities.push({ id: nextId, kind, source: "manual", confidence: 1, metadata });
          }),
        )
      : missingMock(),
  updateActivity: (
    activityId: number,
    kind: string,
    metadata: ActivityMetadata,
  ): Promise<DashboardPayload> =>
    mock
      ? Promise.resolve(
          mockEdit(byActivity(activityId), (activities) => {
            const found = activities.find((entry) => entry.id === activityId);
            if (found) Object.assign(found, { kind, source: "manual", confidence: 1, metadata });
          }),
        )
      : missingMock(),
  deleteActivity: (activityId: number): Promise<DashboardPayload> =>
    mock
      ? Promise.resolve(
          mockEdit(byActivity(activityId), (activities) => {
            const at = activities.findIndex((entry) => entry.id === activityId);
            if (at >= 0) activities.splice(at, 1);
          }),
        )
      : missingMock(),
  resetActivities: (segmentId: number): Promise<DashboardPayload> =>
    mock
      ? Promise.resolve(mockEdit(bySegment(segmentId), (activities) => activities.splice(0)))
      : missingMock(),
  // The two ways a capture changes, answering with the whole dashboard the way the activity
  // edits do — so a note that looked saved and was not cannot happen. The mock edits its own
  // stored dashboard, which is the same "write, then repaint from storage" flow.
  setCaptureNote: (captureId: number, note: string): Promise<DashboardPayload> =>
    mock
      ? Promise.resolve(
          mockCaptureEdit(captureId, (captures, at) => {
            const found = captures[at];
            // The backend cleans a note by the addon's own rules; the mock does the half of that a
            // test can tell apart from a working field — trimming, and no note at all for nothing.
            if (found) found.note = note.trim() || null;
          }),
        )
      : missingMock(),
  deleteCapture: (captureId: number): Promise<DashboardPayload> =>
    mock
      ? Promise.resolve(
          mockCaptureEdit(captureId, (captures, at) => {
            captures.splice(at, 1);
            if (mock) delete mock.captureImages[captureId];
          }),
        )
      : missingMock(),
  // The pictures a grid needs, asked for once the tiles are drawn. Answered from a cache on
  // disk after the first look at an evening, which is why asking for a whole grid is cheap.
  captureThumbnails: (captureIds: number[]): Promise<CaptureThumbnailsPayload> =>
    mock ? Promise.resolve({ thumbnails: mockThumbnails(captureIds) }) : missingMock(),
  // One capture at the size it was taken, which is a few megabytes and is therefore asked for
  // only when somebody opens it.
  captureImage: (captureId: number): Promise<CaptureImagePayload> => {
    if (mock) {
      const held = mock.captureImages[captureId];
      return Promise.resolve(
        held
          ? { id: captureId, image: held.full, byteSize: held.byteSize }
          : { id: captureId, image: null },
      );
    }
    return missingMock();
  },
  installAddon: (): Promise<InstallResult> =>
    mock ? Promise.resolve(mock.installResult) : missingMock(),
  checkForAppUpdate: (): Promise<AppUpdateResult> =>
    mock ? Promise.resolve(mock.appUpdate) : missingMock(),
  // Only the Chronies on this network that are waiting for a database answer, so this is a
  // short list and every entry in it can be sent to.
  wifiDiscover: (): Promise<WifiPeer[]> =>
    mock ? Promise.resolve(structuredClone(mock.wifi.peers)) : missingMock(),
  // Waits on somebody at the other machine reading an offer and answering it, so this call
  // is measured in minutes rather than milliseconds.
  wifiSend: (address: string): Promise<WifiReceipt> => {
    if (mock) {
      mock.wifi.sentTo.push(address);
      return Promise.resolve(structuredClone(mock.wifi.receipt));
    }
    return missingMock();
  },
  wifiReceiveStart: (): Promise<WifiReceiveStatus> =>
    mock
      ? Promise.resolve(
          mockReceive((status) => {
            status.listening = true;
            status.outcome = null;
            // The fixture's sender is already knocking, which is what a test needs to reach the
            // one screen in this feature that matters.
            status.offer = mock.wifi.incoming ? structuredClone(mock.wifi.incoming) : null;
          }),
        )
      : missingMock(),
  wifiReceiveStop: (): Promise<WifiReceiveStatus> =>
    mock
      ? Promise.resolve(
          mockReceive((status) => {
            status.listening = false;
            status.offer = null;
            status.addresses = [];
          }),
        )
      : missingMock(),
  wifiReceiveStatus: (): Promise<WifiReceiveStatus> =>
    mock ? Promise.resolve(mockReceive(() => {})) : missingMock(),
  wifiAnswerOffer: (accepted: boolean): Promise<WifiReceiveStatus> =>
    mock
      ? Promise.resolve(
          mockReceive((status) => {
            const waiting = status.offer;
            if (!waiting) throw new Error("There is no database waiting to be accepted.");
            status.offer = null;
            status.outcome = accepted
              ? {
                  stored: true,
                  message:
                    `Replaced this history with ${waiting.offer.device}'s: ` +
                    `${waiting.offer.segmentCount} segments across ${waiting.offer.characterCount} characters.`,
                }
              : {
                  stored: false,
                  message: `Turned down the database from ${waiting.offer.device}.`,
                };
          }),
        )
      : missingMock(),
};

/**
 * The e2e mock's answer to one query.
 *
 * Matched on the query's text with its whitespace collapsed, so a fixture may lay a statement
 * out over several lines and the page may send it back exactly as typed. A query the fixture
 * says nothing about is refused rather than answered with an empty table, which is the one
 * thing a stubbed database must never do: an empty result and an unrecognised query look
 * identical on screen, and only one of them means the test is testing anything.
 */
function mockQuery(sql: string): Promise<QueryAnswer> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const held = mock.query.answers[sql.trim().replace(/\s+/g, " ")];
  if (!held) return Promise.reject(new Error("no such table: main.that_one"));
  if ("error" in held) return Promise.reject(new Error(held.error));
  return Promise.resolve(structuredClone(held));
}

/**
 * Which state the mock's install is in once the setting has moved, mirroring the rule in
 * `combatlog::status`: the setting decides only whether anything was asked for, and the
 * game's own config and log files decide the rest.
 */
function mockCombatLogState(status: CombatLogStatus): CombatLogStatus["state"] {
  if (!status.requested) return "off";
  if (status.advanced !== true) return "basic";
  return status.growing ? "advanced" : "stale";
}

/**
 * Advances the e2e mock's receiving half and hands back a fresh copy, the way the real
 * station answers every call with its whole state.
 */
function mockReceive(advance: (status: WifiReceiveStatus) => void): WifiReceiveStatus {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  advance(mock.wifi.status);
  return structuredClone(mock.wifi.status);
}

/** A set the e2e mock says nothing about, which the real backend would answer for. */
const emptySet = (setId: number): TransmogSetItemsPayload => ({
  setId,
  appearances: [],
  readCount: 0,
  withheldCount: 0,
});

/**
 * What the e2e mock's version of one set is wearing, by the backend's own two rules.
 *
 * Worked out here rather than answered from a fixture of its own, because the fixture that
 * matters is already there: `wornSets` is what the character looks like in a given set of
 * clothes, and a card's picture is a character in the clothes of one set. Keying into it means
 * a card and the panel beside it cannot disagree about what wearing a set looks like.
 *
 * The rules are `transmog::set_pieces`'s: a row with nowhere on her to go is dropped — see
 * `canBeWorn`, which is the same reading the rows themselves are drawn from — and a piece the
 * set names twice is worn once. Nothing collapses two pieces contesting one slot, because
 * neither does the backend: a robe and a pair of legs are both what the set says, and the
 * game's own priority table is what settles them.
 */
function mockSetPieces(setId: number): WornPiece[] {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const held = mock.transmogItems[setId];
  if (!held) return [];
  const worn: WornPiece[] = [];
  for (const row of appearanceRows(held, "")) {
    if (canBeWorn(row).kind !== "worn") continue;
    const piece = {
      displayInfoId: row.displayInfoId,
      displayType: row.displayType,
      inventoryType: row.inventoryType,
    };
    const already = worn.some(
      (one) =>
        one.displayInfoId === piece.displayInfoId &&
        one.displayType === piece.displayType &&
        one.inventoryType === piece.inventoryType,
    );
    if (!already) worn.push(piece);
  }
  return worn;
}

/** How the e2e mock's wardrobe is keyed: the display types, ascending, joined by commas. */
const wardrobeKey = (displayTypes: number[]): string =>
  [...displayTypes].sort((left, right) => left - right).join(",");

/** A kind the mock holds nothing for, which the real backend answers with an empty list. */
const emptyWardrobe = (displayTypes: number[]): WardrobePayload => ({
  displayTypes,
  appearances: [],
  readCount: 0,
  withheldCount: 0,
});

/** Two tag keys the store would treat as one, which is `COLLATE NOCASE` in the migration. */
const sameKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Applies an edit to what the e2e mock holds about one subject, and hands back a fresh copy.
 *
 * The same "write, then repaint from storage" the real commands give, and with the store's own
 * rule about which subjects exist at all: a mark that ends up saying nothing — unstarred and
 * untagged — is deleted rather than kept as an empty row, because that is what the two tables
 * do and a browser counting the marks would otherwise count subjects nobody has touched.
 */
function mockMark(
  kind: MarkSubjectKind,
  id: number,
  apply: (mark: TransmogMark) => void,
): TransmogMarksPayload {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const marks = mock.transmogMarks.marks;
  let mark = marks.find((one) => one.kind === kind && one.id === id);
  if (!mark) {
    mark = { kind, id, favourite: false, tags: [] };
    marks.push(mark);
  }
  apply(mark);
  if (!mark.favourite && !mark.tags.length) {
    mock.transmogMarks.marks = marks.filter((one) => one !== mark);
  }
  return structuredClone(mock.transmogMarks);
}

/**
 * The icons the e2e mock holds among those asked for.
 *
 * An id it holds nothing for is left out rather than answered with an empty string, which is
 * what the real backend does for a texture the install cannot show.
 */
function mockIcons(wanted: number[]): Record<string, string> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, string> = {};
  for (const id of wanted) {
    const url = mock.gameIcons[id];
    if (url) found[String(id)] = url;
  }
  return found;
}

/** The currency pictures held by the e2e mock, keyed by currency id. */
function mockCurrencyIcons(wanted: number[]): Record<string, string> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, string> = {};
  for (const id of wanted) {
    const url = mock.currencyIcons[id];
    if (url) found[String(id)] = url;
  }
  return found;
}

/** The place pictures held by the e2e mock, keyed by the name the segment was filed under. */
function mockPlaceIcons(wanted: string[]): Record<string, string> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, string> = {};
  for (const place of wanted) {
    const url = mock.placeIcons[place];
    if (url) found[place] = url;
  }
  return found;
}

/** The boss portraits held by the e2e mock, keyed by the encounter id the segment recorded. */
function mockBossPortraits(wanted: number[]): Record<string, string> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, string> = {};
  for (const encounter of wanted) {
    const url = mock.bossPortraits[encounter];
    if (url) found[String(encounter)] = url;
  }
  return found;
}

/** The achievements the e2e mock can describe among those asked for, keyed the same way. */
function mockAchievements(wanted: number[]): Record<string, AchievementDetail> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, AchievementDetail> = {};
  for (const id of wanted) {
    const detail = mock.achievementDetails[id];
    if (detail) found[String(id)] = detail;
  }
  return found;
}

/** The items the e2e mock can describe among those asked for, keyed the same way. */
function mockItems(wanted: number[]): Record<string, ItemDetail> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, ItemDetail> = {};
  for (const id of wanted) {
    const detail = mock.itemDetails[id];
    if (detail) found[String(id)] = detail;
  }
  return found;
}

/**
 * What the real backend would have said a gallery row is a picture of.
 *
 * The eleven armour slots are head through tabard and everything the game numbers above them is
 * carried in a hand, so a display type above ten comes back as the item's own mesh. This is the
 * one place in the window that decides it rather than reading it — because here there is no
 * backend to have read it from, and a stub that always claimed `worn` would let the browser
 * suite pass while the real thing framed every weapon as a character. It mirrors `worn::held`,
 * which is where the boundary is actually stated.
 */
const ARMOUR_SLOTS = 11;

function mockGalleryKind(displayType: number): GalleryKind {
  return displayType >= ARMOUR_SLOTS ? "held" : "worn";
}

/** The looks the e2e mock can resolve among the items asked about, keyed the same way. */
function mockItemAppearances(wanted: number[]): Record<string, ItemAppearance> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, ItemAppearance> = {};
  for (const id of wanted) {
    const look = mock.itemAppearances[id];
    if (look) found[String(id)] = look;
  }
  return found;
}

/** The thumbnails the e2e mock holds among those asked for, keyed the way icons are. */
function mockThumbnails(wanted: number[]): Record<string, string> {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const found: Record<string, string> = {};
  for (const id of wanted) {
    const held = mock.captureImages[id];
    if (held) found[String(id)] = held.thumbnail;
  }
  return found;
}

/**
 * Applies an edit to the capture with a given id wherever it sits in the mock's dashboard, and
 * hands back a fresh copy — the same flow `mockEdit` gives the activity commands.
 */
function mockCaptureEdit(
  captureId: number,
  apply: (captures: Capture[], at: number) => void,
): DashboardPayload {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  for (const segment of mock.dashboard.segments || []) {
    const at = (segment.captures || []).findIndex((capture) => capture.id === captureId);
    if (at >= 0) apply(segment.captures ?? [], at);
  }
  return structuredClone(mock.dashboard);
}

/** Drops the guess for a kind the user has just taken over, mirroring the backend's rule. */
function dropInferred(activities: Activity[], kind: string): void {
  const at = activities.findIndex((entry) => entry.kind === kind && entry.source === "inferred");
  if (at >= 0) activities.splice(at, 1);
}

const bySegment =
  (segmentId: number): Locate =>
  (segment) =>
    segment.segmentId === segmentId;
const byActivity =
  (activityId: number): Locate =>
  (segment) =>
    (segment.activities || []).some((entry) => entry.id === activityId);

/**
 * Applies an edit to the e2e mock's stored dashboard and hands back a fresh copy, so the
 * page under test sees the same "write, then repaint from storage" flow the real app gets
 * from the backend. `locate` picks the segment the edit belongs to.
 */
function mockEdit(locate: Locate, apply: Apply): DashboardPayload {
  if (!mock) throw new Error("The end-to-end mock is not installed.");
  const segments = mock.dashboard.segments || [];
  for (const segment of segments) segment.activities ??= [];
  const nextId =
    1 +
    Math.max(
      0,
      ...segments.flatMap((segment) => (segment.activities || []).map((entry) => entry.id || 0)),
    );
  const target = segments.find(locate);
  if (target) apply((target.activities ??= []), nextId);
  return structuredClone(mock.dashboard);
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
