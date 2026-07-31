/**
 * The transmog view: every set the installed game knows about, and the character wearing what
 * you have picked out of them.
 *
 * Two halves that do not move. On the left the sets, filtered by name and by everything else
 * the game says about them, each one opening in place to show what it is made of. On the right
 * the character, dressed in whatever has been clicked, and the rail of what that is. Neither
 * covers the other, which is the point: an outfit is assembled out of several sets — a helm
 * from one and a robe from another — and a dialog that had to be closed to reach the second
 * set made that the hard way round.
 *
 * The left half browses **five ways**, and the switch between them is the one control above all
 * of them. Sets are what somebody at Blizzard put together; items are the game's whole wardrobe
 * cut by the kind of thing — every head, every staff — which is the only way to reach the several
 * thousand looks no set names; yours are the outfits assembled here and saved under a name; and
 * the personal in-game sets are the ones the player saved at a transmogrifier long before Chronie
 * existed. The fifth is not a list of what the game holds at all: it is the sets a reader is one
 * slot short of being able to wear, which is arithmetic over every item in the game rather than
 * anything the game states — see `shelf.ts`. What survives every switch is the outfit, because it
 * lives here rather than in any browser: a helm out of a set is still on her while a two-hander is
 * picked out of the list, and what she is wearing when all of that is done is what a set of the
 * reader's own is made of.
 *
 * `transmog.ts` decides how sets group and filter, `wardrobe.ts` what a kind is and what a
 * filter over one leaves, `customSets.ts` how a saved set becomes rows and back again,
 * `outfit.ts` what goes where, and `outfitPanel.tsx` draws the body and holds the name box that
 * saves one. This is the browsing over them.
 *
 * Two things about the left half are worth saying plainly, because both were the other way
 * round once. **A row's whole width puts the piece on**, and Wowhead is an icon at the end of
 * it: dressing the character is the errand, and leaving the app is the exception. And **the
 * rows with nowhere to go are hidden** until the checkbox above them says otherwise — see
 * `onlyWearable`, and the count each set gives of what it left out.
 *
 * And a third: **a set can be shown as the clothes it is**. A card is a name, a count and a row
 * of chips, and none of that says what a set of clothes looks like — so the checkbox above the
 * grid draws each card as the character wearing that set, turnable under the hand, out of the
 * same `galleryTile.tsx` the wardrobe's own pictures come from. It is off until asked for and
 * it pages the grid when it is on, because a card of names is a string and a card of a set worn
 * is a body read out of the game's own files. What a set is *wearing* is never worked out here:
 * the backend reads it for the whole page at once — see `gallery::sets` — because a card holds
 * nothing but an id until somebody opens it.
 *
 * The list costs a second and a few hundred megabytes to read out of the game's own files, so
 * it arrives after the window has opened — which is why this view has a loading line and a
 * failure to draw, and no other one does.
 */

import "./transmogView.css";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { CustomSetList } from "./customSetList";
import { rowsOf } from "./customSets";
import { InGameSetList } from "./inGameSetList";
import { setLabel as inGameSetLabel } from "./inGameSets";
import { message } from "./failure";
import { plural } from "./format";
import { SET_PAGE, WHOLE, stillWantedSets } from "./gallery";
import type { Thumbnail } from "./gallery";
import { Turnable, lazyGalleryStage, useGalleryPaint } from "./galleryTile";
import type { Paint } from "./galleryTile";
import { lookKey } from "./herself";
import { NO_MARK_FILTER, indexMarks, tagChoices } from "./marks";
import { MarkControls, MarkFilters } from "./marksEditor";
import type { MarkActions } from "./marksEditor";
import { REASONS, wearable as canBeWorn } from "./modelPreview";
import type { AlternativeActions } from "./alternativesPanel";
import { locksAnything } from "./openings";
import { OpeningsPanel } from "./openingsPanel";
import {
  NOTHING_ON,
  isWorn,
  onlyWearable,
  setLabel,
  takeOff,
  toggle as toggleWorn,
  toggleAt,
  wearAll,
  wearAllAt,
  wearSet,
  wearable,
} from "./outfit";
import type { Outfit } from "./outfit";
import { OutfitPanel } from "./outfitPanel";
import { NO_QUALITIES, indexQualities, loadSetQualities as loadSetStore } from "./qualities";
import { Qualities, Swatch } from "./qualitiesChips";
import { ShelfList } from "./shelfList";
import { termText, withTerm } from "./terms";
import {
  alternateLabel,
  classLabel,
  classNames,
  expansionName,
  filterFamilies,
  foldFamilies,
  groupFamilies,
  patchName,
  variantLabel,
  whoWears,
} from "./transmog";
import type { Family } from "./transmog";
import {
  appearanceRows,
  appearanceSummary,
  iconIds,
  itemsBehind,
  qualityLabel,
  varyingFacts,
  wearerLabel,
} from "./transmogModal";
import type { AppearanceRow, AppearanceSource } from "./transmogModal";
import type { GalleryStage } from "./galleryStage";
import type { ModelStage } from "./modelViewer";
import { LinkOut } from "./ui";
import { WardrobeList } from "./wardrobeList";
import type {
  CharacterChosen,
  CharacterLookPayload,
  CharacterModelPayload,
  CharacterPick,
  CustomSetPiece,
  CustomSetsPayload,
  GalleryPayload,
  IconsPayload,
  InGameSetAppearancesPayload,
  InGameSetSlot,
  InGameSetsPayload,
  MarkSubjectKind,
  AlternativesPayload,
  LookalikesPayload,
  LookalikeVerdict,
  OpeningsPayload,
  Quality,
  QualitiesFile,
  SetGalleryPayload,
  SetQualitiesFile,
  SetWearers,
  TransmogMark,
  TransmogMarksPayload,
  TransmogPayload,
  SetRequest,
  TransmogSet,
  TransmogSetItemsPayload,
  WardrobePayload,
  WearersPayload,
  WornPiece,
  WornSetPayload,
} from "./types";

/**
 * The one thing a reader can do about a status that is a failure.
 *
 * Null far more often than not. It is here because the two most common reasons this view has no
 * wardrobe on it — the game folder has never been chosen, and the game is mid-patch — are both
 * one click from being resolved, and for as long as a failed command answered with a string this
 * view could only print the sentence and leave the reader to work the rest out.
 */
export interface StatusRecourse {
  label: string;
  act: () => void;
}

export interface TransmogViewProps {
  /** The loaded sets, or null while they are still being read out of the game. */
  payload: TransmogPayload | null;
  /** What the view says instead, when there is no payload: reading, or why there is not. */
  status: string;
  /** What to offer beside that sentence, when the failure is one somebody can act on. */
  statusRecourse?: StatusRecourse | null;
  /** Asks the backend what a set is made of, when a reader opens one. */
  loadSet: (setId: number) => Promise<TransmogSetItemsPayload>;
  /** Asks it for every look filling a kind of place, when a reader browses by item. */
  loadAppearances: (displayTypes: number[]) => Promise<WardrobePayload>;
  /** Asks the backend for the pictures those rows need, decoded out of the game's textures. */
  loadIcons: (iconFileDataIds: number[]) => Promise<IconsPayload>;
  /** Passed through to the panel: the bare body, and the body wearing the whole outfit. */
  loadCharacter: () => Promise<CharacterModelPayload>;
  loadWorn: (pieces: WornPiece[]) => Promise<WornSetPayload>;
  /** And through to the item browser: a page of looks, each on a body of its own. */
  loadGallery: (pieces: WornPiece[]) => Promise<GalleryPayload>;
  /**
   * The same for the sets: a page of the grid, each card worn whole.
   *
   * Ids rather than clothes, and that is the point. A card is a name and a count until somebody
   * opens it, so the window has nothing to send — what a set is wearing is read by the backend,
   * for the whole page out of one walk of each table, rather than by this view opening a dozen
   * sets to draw one screen. See `gallery::sets`.
   */
  loadSetGallery: (setIds: number[]) => Promise<SetGalleryPayload>;
  /**
   * Who that body is, and how somebody says otherwise.
   *
   * The one thing on this screen that changes every picture on it at once. The backend applies
   * what is stored to every body it draws whether or not this is ever asked for, so what the
   * view does with an answer is throw away the pictures of the woman who is no longer there —
   * see `look` below, which both panes hold their caches against.
   */
  herself: {
    load: () => Promise<CharacterLookPayload>;
    save: (body: number, picked: CharacterPick[]) => Promise<CharacterChosen>;
    onError: (error: unknown) => string;
  };
  /**
   * What the reader has said about the game's wardrobe, and the three ways they say more.
   *
   * The one thing on this screen that is not read out of the installed game — see `marks.ts`.
   * The payload is `null` until it has been read and stays `null` if it could not be: nothing
   * on the screen is then marked, and the first attempt to mark something says why.
   */
  marks: MarkActions & { payload: TransmogMarksPayload | null };
  /**
   * The sets the reader saved off the character, and the two ways they change.
   *
   * The other thing on this screen that is not read out of the installed game, shaped like the
   * marks above and for the same reasons: the payload lives in `app.tsx`, every write answers
   * with all of them, and what came back is what the view then draws. `null` until it has been
   * read; a reader who has never saved one sees an empty list rather than a missing browser.
   */
  custom: {
    payload: CustomSetsPayload | null;
    save: (name: string, pieces: CustomSetPiece[]) => Promise<CustomSetsPayload>;
    remove: (id: number) => Promise<CustomSetsPayload>;
    onApply: (payload: CustomSetsPayload) => void;
    onError: (error: unknown) => string;
    /** And the other keeping: asking the game itself to hold on to what she has on. */
    sendToGame: (
      name: string,
      icon: number | null,
      slots: InGameSetSlot[],
    ) => Promise<SetRequest[]>;
  };
  /**
   * The sets the player saved in the *game*, and what one turns out to be made of.
   *
   * The one browser on this screen nothing here can write to. An in-game set is held on
   * Blizzard's servers and reaches the app through the addon, so the payload is a snapshot of
   * what the last sync read — `null` until it has been read, and a reader whose characters have
   * saved none sees an empty list rather than a missing browser.
   */
  inGame: {
    payload: InGameSetsPayload | null;
    loadAppearances: (appearanceIds: number[]) => Promise<InGameSetAppearancesPayload>;
  };
  /** Passed through too — it is the one thing here that needs a graphics card. */
  createStage?: (container: HTMLElement) => ModelStage | Promise<ModelStage>;
  /** And the other: the one context a whole gallery of thumbnails is drawn through. */
  createGalleryStage?: () => GalleryStage | Promise<GalleryStage>;
  /**
   * What the committed store measured of the game's looks — see `qualities.ts`.
   *
   * Two of them, because the two browsers show two different things: the wardrobe shows what
   * each look is like, a slot's file at a time, and the sets show what a whole set is like out
   * of one small file. Neither reaches a backend; both are files in this repository, imported
   * on demand, and both are injected here so a test can hand over three rows instead of a few
   * hundred kilobytes of the game's chestpieces.
   */
  loadQualities?: (displayType: number) => Promise<QualitiesFile | null>;
  loadSetQualities?: () => Promise<SetQualitiesFile | null>;
  /**
   * Who the items behind each set say can really wear it — see `wearers.rs` and [`whoWears`].
   *
   * Its own read rather than part of the grid's payload, and asked for after it, because the
   * two cost different things: the sets are 34 ms of three small tables and this is the walk
   * of `Item` and `ItemSparse` the item browser pays for one slot at a time. Until it lands —
   * and for a set this install can describe no item of — the cards say what the game's own
   * mask says, which is what they said before any of this existed.
   */
  loadWearers?: () => Promise<WearersPayload>;
  /**
   * And which of one set's looks something outside it sells to anybody — see `openings.rs`.
   *
   * Per set and only for a set whose own rows lock somebody out, which is the difference from
   * `loadWearers` above: that is one read for the whole grid and this costs the same walk of
   * `Item` and `ItemSparse` again for each set opened. A set that shuts nobody out has nothing
   * to answer, so nothing is asked for it.
   */
  loadOpenings?: (setId: number) => Promise<OpeningsPayload>;
  /**
   * And what else in the game might do for a look nothing sells around — see `alternatives.ts`.
   *
   * The last and least certain step of the same question, behind a button on the one row of the
   * panel above that has no answer. Per look rather than per set, because that is the grain a
   * reader asks it at: they are standing in front of one red row.
   */
  loadAlternatives?: (appearanceId: number, displayType: number) => Promise<AlternativesPayload>;
  /**
   * Everything anybody has decided about one of those suggestions, and deciding one.
   *
   * Kept apart from the marks, which live in `app.tsx` because four browsers draw them: a
   * verdict on a suggestion is drawn in exactly one panel, so it is read when that panel first
   * opens and held here. Every write answers with all of them, which is the rule every edit in
   * this window follows — what was stored is what is then drawn.
   */
  loadLookalikes?: () => Promise<LookalikesPayload>;
  setLookalike?: (
    appearanceId: number,
    alternativeId: number,
    verdict: string | null,
  ) => Promise<LookalikesPayload>;
}

/**
 * What the view asks when nobody wired the read up: nothing, answered with nothing.
 *
 * Every card then draws the mask the game filed its set under, which is what the grid drew
 * before any of this existed and what it still draws for a set no item of which this install
 * can describe.
 */
const NOBODY_ASKED = (): Promise<WearersPayload> => Promise.resolve({ wearers: [], readCount: 0 });

/**
 * And what an unwired window says about how anybody gets a locked look: that it read nothing.
 *
 * An empty answer rather than a rejected promise, so the panel says what it says of a set whose
 * every locked look is encrypted rather than the sentence a failed command gets.
 */
const NOTHING_OPEN = (setId: number): Promise<OpeningsPayload> =>
  Promise.resolve({ setId, openings: [], blocked: [], readCount: 0, withheldCount: 0 });

/**
 * And what an unwired window offers in place of a look nothing sells around: nothing, having
 * measured nothing — but with the pictures reported as read, so the panel says "nothing looks
 * near enough" rather than "still reading", which would be a wait that never ends.
 */
const NOTHING_LIKE = (appearanceId: number): Promise<AlternativesPayload> =>
  Promise.resolve({
    appearanceId,
    geometryAnswers: false,
    sameMesh: [],
    lookalikesReady: true,
    lookalikes: [],
  });

const NOBODY_RULED = (): Promise<LookalikesPayload> => Promise.resolve({ said: [] });

/**
 * Which of the five browsers the reader is in.
 *
 * The game's sets, the game's whole wardrobe by the kind of thing, the sets they made
 * themselves, the ones they saved in the game long before Chronie existed — and the shelf of
 * sets a slot or two short of anybody being able to wear them, which is the only one of the five
 * that is not a list of what exists but a list of what nearly does. Five lists of one kind of
 * answer — something to put on her — and the outfit survives every switch between them, which is
 * what makes assembling one out of all five the ordinary thing rather than a trick.
 */
type Browsing = "sets" | "items" | "yours" | "ingame" | "shelf";

export function TransmogView({
  payload,
  status,
  statusRecourse = null,
  loadSet,
  loadAppearances,
  loadIcons,
  loadCharacter,
  loadWorn,
  loadGallery,
  loadSetGallery,
  herself,
  marks,
  custom,
  inGame,
  createStage,
  createGalleryStage = lazyGalleryStage,
  loadQualities,
  loadSetQualities = loadSetStore,
  loadWearers = NOBODY_ASKED,
  loadOpenings = NOTHING_OPEN,
  loadAlternatives = NOTHING_LIKE,
  loadLookalikes = NOBODY_RULED,
  setLookalike,
}: TransmogViewProps): ReactNode {
  const [browsing, setBrowsing] = useState<Browsing>("sets");
  /**
   * Who she is, as a string that changes when she does, and nothing else about her.
   *
   * It opens empty rather than reading the settings file, and that is not a stale value: which
   * answers the bodies are drawn with is the backend's throughout, and this only has to be
   * *different* from what it was when somebody changes one. See `herself.ts`.
   */
  const [look, setLook] = useState("");
  /**
   * The whole of what the grid is narrowed to by, dropdowns and all — see `terms.ts`.
   *
   * There were two selects beside it, an expansion and a class, and both asked for something
   * `facetsOf` already answers under a name. Every chip on every card writes into here instead,
   * which is the mechanism the measured colours and the reader's own tags were already using.
   */
  const [search, setSearch] = useState("");
  const [outfit, setOutfit] = useState<Outfit>(NOTHING_ON);
  /** What the sets are narrowed to beyond what the game says. The wardrobe keeps its own. */
  const [marked, setMarked] = useState(NO_MARK_FILTER);
  /**
   * Whether the rows nothing can be done with are left out, which they are until a reader says
   * otherwise. See [`onlyWearable`]: they are a disabled button and an apology, and a reader
   * clicking down a set to dress a character has no use for either.
   */
  const [hideUnwearable, setHideUnwearable] = useState(true);
  /** The sets a reader has opened, which stay open: comparing two of them is the ordinary use. */
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  /**
   * Which member of a family its card is currently drawn as, by the family's own card.
   *
   * Empty until somebody clicks a swatch on the rail, which is what the whole grid opens on: a
   * family is drawn as the set the game calls its root — see `foldFamilies` — and this is the
   * reader saying they meant the heroic one, or the copper one.
   */
  const [chosen, setChosen] = useState<ReadonlyMap<number, number>>(new Map());
  /**
   * Whether the cards are drawn as the character wearing each set.
   *
   * Off until asked for, the same way the wardrobe's is and for a stronger reason: a card
   * costs a name and a count to draw and a picture of one costs a body out of the game's own
   * files. What it changes besides the cards is how many of them there are — see `shown`.
   */
  const [asModels, setAsModels] = useState(false);
  /**
   * How many cards are drawn, which only means anything once the pictures are on.
   *
   * A grid of names is cheap enough to draw whole, and being able to see every set a search
   * left is what the grid is for — so nothing is paged until there is a body behind each card,
   * and then a page is [`SET_PAGE`] of them.
   */
  const [shown, setShown] = useState(SET_PAGE);

  // What a set is made of never changes under a running app — it is read out of the installed
  // game — so a set opened twice is read once. Kept outside React because a cache filling is
  // not a redraw; the counter below is what says one happened. A string in there is the
  // sentence saying why a set could not be read, kept for the same reason.
  const known = useRef(new Map<number, TransmogSetItemsPayload | string>()).current;
  // The pictures, by the id the rows name them by. Kept beside the sets rather than inside them
  // because sets share their icons: a collection's tier variants are the same textures
  // throughout, so a set opened after its neighbour draws complete straight away.
  const icons = useRef(new Map<number, string>()).current;
  const asked = useRef(new Set<number>()).current;
  // And how anybody gets the looks each opened set locks, kept the same way and for the same
  // reason: it is read out of the installed game, so a set opened twice is read once.
  const openings = useRef(new Map<number, OpeningsPayload>()).current;
  const askedOpenings = useRef(new Set<number>()).current;
  // And what else might do for each locked look somebody has actually asked about, kept the same
  // way again. Per look rather than per set, and only for the ones a button was pressed on.
  const alternatives = useRef(new Map<number, AlternativesPayload>()).current;
  const askedAlternatives = useRef(new Set<number>()).current;
  // What anybody has decided about one of those suggestions. Read once, the first time a panel
  // is opened, and re-read from whatever every write answers with.
  const [said, setSaid] = useState<LookalikeVerdict[]>([]);
  const askedSaid = useRef(false);
  // Which pictures have already been sent for. Both halves of the browser ask through the same
  // door — a wardrobe list of a hundred rows and a set of twelve want the same textures often
  // enough — and this is what stops the second asker asking again while the first is in flight.
  const askedIcons = useRef(new Set<number>()).current;
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  /**
   * Sends for the pictures some rows are waiting on, and redraws when they arrive.
   *
   * A picture that will not come stays an empty frame and nothing is said about it: an icon is
   * the one thing on a row that can be missing without the row losing its point, and the row
   * already names its slot and its item.
   */
  const wantIcons = useCallback(
    (wanted: number[]): void => {
      const missing = [...new Set(wanted)].filter(
        (id) => id > 0 && !icons.has(id) && !askedIcons.has(id),
      );
      if (!missing.length) return;
      for (const id of missing) askedIcons.add(id);
      void loadIcons(missing)
        .then((pictures) => {
          for (const [id, url] of Object.entries(pictures.icons || {})) {
            if (url) icons.set(Number(id), url);
          }
          redraw();
        })
        .catch(() => undefined);
    },
    [loadIcons, icons, askedIcons],
  );

  /**
   * Reads which of a set's locked looks something else in the game sells to anybody.
   *
   * A third step behind the two below rather than part of either, because it is the dearest of
   * the three and the one fewest sets need — and because the list of looks is worth reading
   * while it happens. A read that will not come leaves the panel saying it is still reading,
   * which is the honest thing for a panel whose whole content is what could not be found.
   */
  const wantOpenings = useCallback(
    (setId: number): void => {
      if (askedOpenings.has(setId)) return;
      askedOpenings.add(setId);
      void loadOpenings(setId)
        .then((answer) => {
          openings.set(setId, answer);
          redraw();
        })
        .catch(() => undefined);
    },
    [loadOpenings, openings, askedOpenings],
  );

  /**
   * Reads what else in the game might do for one look nothing sells around.
   *
   * The dearest read on this screen and the one fewest readers want, which is why it is behind a
   * button: it walks the wardrobe of the slot, and on a machine that has not swept the game's
   * textures yet it also starts the half-minute that does. The pictures its rows will want are
   * sent for as soon as the rows are known, exactly as a set's are.
   */
  const wantAlternatives = useCallback(
    (appearanceId: number, displayType: number): void => {
      if (!askedSaid.current) {
        askedSaid.current = true;
        void loadLookalikes()
          .then((answer) => setSaid(answer.said))
          .catch(() => undefined);
      }
      if (askedAlternatives.has(appearanceId)) return;
      askedAlternatives.add(appearanceId);
      void loadAlternatives(appearanceId, displayType)
        .then((answer) => {
          alternatives.set(appearanceId, answer);
          redraw();
          wantIcons([...answer.sameMesh, ...answer.lookalikes].map((one) => one.iconFileDataId));
        })
        .catch(() => undefined);
    },
    [loadAlternatives, loadLookalikes, alternatives, askedAlternatives, wantIcons],
  );

  /**
   * Says what one thinks of a suggestion, and draws whatever came back.
   *
   * A look somebody has already been offered and has already ruled on is re-asked for, because
   * the store the suggestion came out of may have been swept in the meantime — but the verdicts
   * themselves are what the write answered with, which is the rule every edit here follows.
   */
  const ruleOn = useCallback(
    (appearanceId: number, alternativeId: number, verdict: string | null): void => {
      if (!setLookalike) return;
      void setLookalike(appearanceId, alternativeId, verdict)
        .then((answer) => setSaid(answer.said))
        .catch(() => undefined);
    },
    [setLookalike],
  );

  const alternativeActions: AlternativeActions = useMemo(
    () => ({ found: alternatives, want: wantAlternatives, said, rule: ruleOn }),
    [alternatives, wantAlternatives, said, ruleOn],
  );

  /**
   * Reads what a set is made of, and then the pictures its rows are waiting on.
   *
   * The rows are worth drawing before the icons arrive — decoding a set's worth of textures
   * takes longer than reading the tables that named them — so this is two steps that redraw
   * separately rather than one that waits for both.
   */
  const read = useCallback(
    (setId: number): void => {
      if (asked.has(setId)) return;
      asked.add(setId);
      void loadSet(setId)
        .then((answer) => {
          known.set(setId, answer);
          redraw();
          wantIcons(iconIds(answer));
          // Only now can it be known whether there is anything to ask: the question is about
          // the set's *locked* looks, and what the set locks is what has just arrived. A set
          // open to everybody costs the walk of `Item` and `ItemSparse` for nothing.
          if (locksAnything(appearanceRows(answer))) wantOpenings(setId);
        })
        // A set that will not come is worth saying, because the reader clicked to see what was
        // in it.
        .catch((error: unknown) => {
          if (!known.has(setId)) known.set(setId, message(error));
          redraw();
        });
    },
    [loadSet, wantIcons, wantOpenings, known, asked],
  );

  const openSet = useCallback(
    (set: TransmogSet): void => {
      setOpen((was) => {
        const next = new Set(was);
        if (next.has(set.id)) next.delete(set.id);
        else {
          next.add(set.id);
          read(set.id);
        }
        return next;
      });
    },
    [read],
  );

  // What the game's own artwork was measured to be, for the sets. One small file for all of
  // them rather than a file per slot: a set's colours are the colours of the looks in it, worked
  // out once by `dump_qualities` and written down beside them. Read when the view first draws
  // and never again — a file in the bundle cannot change under a running window.
  const [setQualities, setSetQualities] = useState(NO_QUALITIES);
  useEffect(() => {
    let stale = false;
    void loadSetQualities()
      .then((file) => {
        if (!stale) setSetQualities(indexQualities(file));
      })
      // The cards drew without it before any of this existed, and they draw without it now.
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [loadSetQualities]);

  // Who the items behind each set say can really wear it. Read once the grid itself has
  // arrived — there is no install to read it out of when the sets could not be read — and
  // held as a lookup for the reason the marks below are: the search box re-filters several
  // thousand cards on every keystroke and each of them asks this once.
  const [wearers, setWearers] = useState<Map<number, SetWearers> | null>(null);
  useEffect(() => {
    if (!payload) return;
    let stale = false;
    void loadWearers()
      .then((answer) => {
        if (!stale) setWearers(new Map(answer.wearers.map((row) => [row.setId, row])));
      })
      // The cards drew the game's own mask before any of this existed, and they draw it now.
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [payload, loadWearers]);
  const wearersOf = useCallback((setId: number) => wearers?.get(setId), [wearers]);

  // A lookup per row rather than a scan of the list, because the search box re-filters several
  // thousand sets on every keystroke and each of them asks this once.
  const index = useMemo(() => indexMarks(marks.payload), [marks.payload]);
  const markOf = useCallback(
    (kind: MarkSubjectKind, id: number): TransmogMark | undefined => index.of(kind, id),
    [index],
  );
  // Only the tags actually written against a set, so the picker offers nothing that would
  // empty the grid. Recomputed when a mark changes and not on every keystroke.
  const setTags = useMemo(
    () =>
      tagChoices(
        index,
        "set",
        (payload?.sets ?? []).map((set) => set.id),
      ),
    [index, payload],
  );

  // The game's own statement about which of its rows are one set of clothes — see
  // `foldFamilies`. Worked out once per payload rather than per keystroke: it is a walk of
  // several thousand rows and the search box re-filters on every letter.
  const families = useMemo(() => foldFamilies(payload?.sets ?? []), [payload]);
  const shownFamilies = payload
    ? filterFamilies(families, {
        search,
        marks: { filter: marked, of: (id) => index.of("set", id) },
        // So that "brown" and `colour:brown` mean here what they already meant in the wardrobe
        // beside this: the card draws the same measured chip, and a chip the box cannot be asked
        // about is a chip that raises a question and will not answer it.
        qualities: (id) => setQualities.of(id),
        // And so that the class dropdown narrows to what a class can actually wear rather than
        // to what the game filed under it — the same fact the chip on the card now draws.
        wearers: wearersOf,
      })
    : [];
  // Paged only once there is a body behind each card — see `shown`.
  const drawn = asModels ? shownFamilies.slice(0, shown) : shownFamilies;

  // The pictures, by the set each is of. Kept outside React for the reason the set contents
  // are — one arriving is not a redraw, the counter above is what says one happened — and kept
  // across a search, so narrowing and widening again draws from what is already here.
  const bodies = useRef(new Map<number, Thumbnail>()).current;
  // Of whichever woman they were drawn of. Written during the render rather than in an effect,
  // so the request below is made once for the page as it now is: an effect that emptied the map
  // afterwards would leave this one having already decided nothing was missing.
  const drawnOf = useRef(look);
  if (drawnOf.current !== look) {
    drawnOf.current = look;
    bodies.clear();
  }
  /** Which set a family's card is currently showing, which is the root until somebody says. */
  const memberOf = (family: Family): TransmogSet =>
    family.members.find((one) => one.id === chosen.get(family.shown.id)) ?? family.shown;

  const wantedSets = asModels ? drawn.map((family) => memberOf(family).id) : [];
  const wantedKey = wantedSets.join(",");
  useEffect(() => {
    const missing = stillWantedSets(wantedSets, bodies);
    if (!missing.length) return;
    for (const setId of missing) bodies.set(setId, { kind: "wanted" });
    void loadSetGallery(missing)
      .then((answer) => {
        for (const row of answer.models) {
          bodies.set(
            row.setId,
            row.model
              ? { kind: "model", glb: row.model, shows: "worn" }
              : { kind: "nothing", note: REASONS.unshowable },
          );
        }
      })
      // A page that will not come leaves its cards without pictures rather than waiting for
      // ever. Everything a card said before anybody asked for one is still on it.
      .catch(() => {
        for (const setId of missing) {
          bodies.set(setId, { kind: "nothing", note: REASONS.unshowable });
        }
      })
      .finally(redraw);
    // The ids rather than the array, which is new on every render and would ask every time.
    // `wantedSets` cannot be read back out of the key the way the icon requests below are —
    // the effect needs the rows themselves — so this stays a suppression, and what holds it is
    // the exact call counts `transmogView.test.tsx` asserts on `loadSetGallery`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, look, loadSetGallery, bodies]);

  // One graphics context for the whole grid, held only while the pictures are on — the same
  // arrangement the wardrobe beside this makes, out of the same module.
  const paint = useGalleryPaint(asModels, createGalleryStage);

  /**
   * Every narrowing starts the grid again from the top, where the reader is looking.
   *
   * Only ever visible once the pictures are on, because that is the only time the grid has a
   * page — but done either way, so that turning them on after a search does not draw the
   * twelfth page of it.
   */
  const narrow = (change: () => void): void => {
    change();
    setShown(SET_PAGE);
  };

  const withheld =
    payload && payload.withheldCount > 0
      ? ` · ${plural(payload.withheldCount, "set")} the game keeps encrypted`
      : "";
  // The grid is shorter than the game's own count and says why. 436 sets of a shipping
  // install hold exactly another set's appearances, and a reader counting cards against the
  // number above would otherwise be missing several hundred with no explanation.
  const foldedCount = payload ? payload.sets.filter((set) => set.sameLookAs).length : 0;
  const folded =
    foldedCount > 0
      ? ` · ${plural(foldedCount, "set")} shown under another holding the same appearances`
      : "";
  // And shorter again for the other fold, which is much the larger of the two: 1,724 sets of a
  // shipping install are a difficulty or a colour of one the game names as their parent, and
  // they are on the card's rail rather than cards of their own — see `foldFamilies`.
  const variantCount = families.reduce((count, family) => count + family.members.length - 1, 0);
  const variants =
    variantCount > 0
      ? ` · ${plural(variantCount, "set")} shown as a variant on another's card`
      : "";

  return (
    <>
      <header className="view-head">
        <h1>Transmog</h1>
        <div className="sub" id="transmog-meta">
          {payload
            ? `${plural(payload.sets.length, "set")} from the installed game${withheld}${folded}${variants}`
            : status}
          {/* Only ever drawn over a failure the backend gave a code to, which is what keeps it
              from appearing beside "Reading the game's transmog tables…" or beside a sentence
              nothing can be done about. */}
          {!payload && statusRecourse ? (
            <button type="button" onClick={statusRecourse.act}>
              {statusRecourse.label}
            </button>
          ) : null}
        </div>
      </header>
      <div className="mog-layout">
        <div className="mog-half">
          {/* The one control above both browsers, because it is a statement about what a reader
            is looking for rather than about either list. Two buttons rather than a select:
            there are two of them and both are worth being one click away. */}
          <div className="mog-modes" role="group" aria-label="Browse the game by">
            <button
              type="button"
              aria-pressed={browsing === "sets"}
              onClick={() => setBrowsing("sets")}
            >
              Sets
            </button>
            <button
              type="button"
              aria-pressed={browsing === "items"}
              onClick={() => setBrowsing("items")}
            >
              Items
            </button>
            {/* Third rather than first, because the first two are the game and this is the
              reader — and on a fresh install it is empty, which is not what a view should
              open on. */}
            <button
              type="button"
              aria-pressed={browsing === "yours"}
              onClick={() => setBrowsing("yours")}
            >
              Yours
            </button>
            {/* Last, because it is the only one of the four that is not about this machine at
              all: these were saved in the game, by a character, and Chronie is reporting them
              rather than offering them. */}
            <button
              type="button"
              aria-pressed={browsing === "ingame"}
              onClick={() => setBrowsing("ingame")}
            >
              Personal in-game sets
            </button>
            {/* And the one that is not a list of what the game holds. Its own button rather than
              a filter over the grid, because "the sets I am one slot short of" is arithmetic
              over every item in the game and nobody finds it by guessing — see `shelf.ts`. */}
            <button
              type="button"
              aria-pressed={browsing === "shelf"}
              onClick={() => setBrowsing("shelf")}
            >
              One slot short
            </button>
          </div>
          {/* Named, because all four browsers are the same panel with the same controls in it — a
          class filter, a search box, a box about what she can wear — and "the class filter" is
          only a question with an answer once it is asked of one of them. */}
          <section
            className="panel mog-browser"
            id="transmog-browser"
            hidden={browsing !== "sets"}
            aria-label="The game's sets"
          >
            <div className="table-head">
              <div className="controls">
                {/* Terms in the placeholder beside the words, because `class:mage` is not a thing
                anybody guesses a search box takes — see `terms.ts`, and the chips on every card
                below, which write one into here when they are clicked. `open:` is the one term
                no chip writes, there being no chip for it: how much of a set anybody can have is
                a fact about the whole grid rather than about the card, and the shelf next door is
                where a reader meets it drawn. So the placeholder is the only place it is named. */}
                <input
                  id="transmog-search"
                  type="search"
                  placeholder="Filter by name, class, colour:brown or open:all…"
                  aria-label="Filter transmog sets"
                  value={search}
                  onChange={(event) => narrow(() => setSearch(event.target.value))}
                />
                {/* Applies to every set at once rather than to the one being read, because it is a
                statement about what a reader is here for and not about a particular set. */}
                <label className="mog-hide">
                  <input
                    type="checkbox"
                    id="transmog-hide-unwearable"
                    checked={hideUnwearable}
                    onChange={(event) => setHideUnwearable(event.target.checked)}
                  />
                  Hide what she cannot wear
                </label>
                {/* Beside it, because both are statements about what a reader is here for. A set
                is a set of clothes, and the one thing a name and a count cannot say is what it
                looks like — so this is what the grid is for once somebody is choosing rather
                than looking something up. It shortens the grid to a page: a card of names is a
                string, and a card of a set worn is a body out of the game's own files. */}
                <label className="mog-hide">
                  <input
                    type="checkbox"
                    id="transmog-as-models"
                    checked={asModels}
                    onChange={(event) => {
                      setAsModels(event.target.checked);
                      setShown(SET_PAGE);
                    }}
                  />
                  Show each set worn
                </label>
                {/* Beside the game's own filters rather than somewhere of their own, because
                "plate, Cataclysm, starred" is one question a reader asks and not two. */}
                <MarkFilters
                  scope="transmog"
                  favourite={marked.favourite}
                  tag={marked.tag}
                  choices={setTags}
                  onFavourite={(only) =>
                    narrow(() => setMarked((was) => ({ ...was, favourite: only })))
                  }
                  onTag={(tag) => narrow(() => setMarked((was) => ({ ...was, tag })))}
                />
                <span
                  className="count"
                  id="transmog-count"
                  role="status"
                  aria-label="How much of the grid is shown"
                >
                  {payload ? shownCount(drawn.length, shownFamilies.length) : ""}
                </span>
              </div>
            </div>
            <div id="transmog-list" className="mog-list" data-models={asModels}>
              {groupFamilies(drawn).map((group) => (
                <section className="mog-group" key={group.group}>
                  <h3>
                    {group.group}
                    <span className="muted"> · {plural(group.families.length, "set")}</span>
                  </h3>
                  <div className="mog-grid">
                    {group.families.map((family) => {
                      const set = memberOf(family);
                      return (
                        <Card
                          key={family.shown.id}
                          set={set}
                          family={family}
                          open={open.has(set.id)}
                          onToggle={() => openSet(set)}
                          // A rail of one member is a rail of the card itself, so picking one is
                          // only ever a swap. What follows it is what the card was already
                          // showing: a set opened stays open on the member picked instead, which
                          // is what makes the rail a way of comparing them rather than a way of
                          // losing your place.
                          onShow={(member) => {
                            setChosen((had) => new Map(had).set(family.shown.id, member.id));
                            if (!open.has(set.id)) return;
                            setOpen((had) => new Set(had).add(member.id));
                            read(member.id);
                          }}
                          contents={known.get(set.id)}
                          openings={openings.get(set.id)}
                          alternatives={alternativeActions}
                          icons={icons}
                          outfit={outfit}
                          hideUnwearable={hideUnwearable}
                          marks={marks}
                          markOf={markOf}
                          qualityOf={(setId) => setQualities.of(setId)}
                          wearersOf={wearersOf}
                          onFilter={(term) => narrow(() => setSearch((was) => withTerm(was, term)))}
                          body={asModels ? bodies.get(set.id) : undefined}
                          paint={paint}
                          onWear={(row) => setOutfit((was) => toggleWorn(was, row, setLabel(set)))}
                          onWearAll={(rows) => setOutfit((was) => wearSet(was, rows, set))}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
              {/* What is left, and the way to it — the same button the wardrobe has, and only ever
              here for the same reason: a grid of pictures is paged and a grid of names is not. */}
              {shownFamilies.length > drawn.length ? (
                <button
                  type="button"
                  className="mog-more"
                  onClick={() => setShown((was) => was + SET_PAGE)}
                >{`Show ${Math.min(SET_PAGE, shownFamilies.length - drawn.length)} more of ${plural(shownFamilies.length - drawn.length, "set")}`}</button>
              ) : null}
            </div>
            <div
              className="empty"
              id="transmog-empty"
              hidden={!payload || shownFamilies.length > 0}
            >
              <p className="empty-title">Nothing matches</p>
              <p>Try a different search, or one term fewer.</p>
            </div>
          </section>
          {/* Kept in the tree rather than swapped in, so that what a reader has read, searched
          and scrolled is still there when they come back to it. Nothing is read for it until
          it is first shown — see `hidden`, which the list takes as the word to start. */}
          <WardrobeList
            hidden={browsing !== "items"}
            load={loadAppearances}
            wantIcons={wantIcons}
            icons={icons}
            outfit={outfit}
            hideUnwearable={hideUnwearable}
            onHideUnwearable={setHideUnwearable}
            marks={marks}
            index={index}
            loadGallery={loadGallery}
            look={look}
            createGalleryStage={createGalleryStage}
            loadQualities={loadQualities}
            onWear={(row) => setOutfit((was) => toggleWorn(was, row))}
          />
          {/* Kept in the tree beside the other two, and for the stronger version of their reason:
          this list is already in memory, so hiding it costs nothing and swapping it out would
          throw away a search and a scroll for no saving at all. */}
          <CustomSetList
            hidden={browsing !== "yours"}
            payload={custom.payload}
            onDelete={custom.remove}
            onSaved={custom.onApply}
            onError={custom.onError}
            icons={icons}
            wantIcons={wantIcons}
            outfit={outfit}
            marks={marks}
            index={index}
            onWear={(row) => setOutfit((was) => toggleWorn(was, row))}
            onWearAll={(set) => setOutfit((was) => wearAll(was, rowsOf(set), set.name))}
          />
          {/* And in the tree beside the other three, for their reason: what a reader opened and
          searched here should still be open when they come back from trying a hat. */}
          <InGameSetList
            hidden={browsing !== "ingame"}
            payload={inGame.payload}
            loadAppearances={inGame.loadAppearances}
            icons={icons}
            wantIcons={wantIcons}
            outfit={outfit}
            // The place travels with the row rather than being worked out from it: an in-game set
            // is the only kind that names the slot, and so the only one that can say which hand a
            // one-hander is in. See `wearAllAt`.
            onWear={(place, row) => setOutfit((was) => toggleAt(was, place, row))}
            onWearAll={(set, pieces) =>
              setOutfit((was) => wearAllAt(was, pieces, inGameSetLabel(set)))
            }
          />
          {/* And the fifth, kept in the tree beside the other four for their reason. It shares
            the grid's own caches — what a set is made of, how anybody gets the looks it locks,
            and what else might do for the ones nothing sells around — so a set opened here and
            opened again over there is read once. */}
          <ShelfList
            hidden={browsing !== "shelf"}
            payload={payload}
            wearersOf={wearersOf}
            ready={wearers !== null}
            onOpen={read}
            contentsOf={(setId) => known.get(setId)}
            openingsOf={(setId) => openings.get(setId)}
            alternatives={alternativeActions}
            icons={icons}
          />
        </div>
        <OutfitPanel
          outfit={outfit}
          icons={icons}
          createStage={createStage}
          look={look}
          loadCharacter={loadCharacter}
          loadWorn={loadWorn}
          herself={{
            ...herself,
            onChanged: (chosen) => setLook(lookKey(chosen.body, chosen.picked)),
          }}
          save={{
            sets: custom.payload?.sets ?? [],
            onSave: custom.save,
            onSaved: custom.onApply,
            onError: custom.onError,
            onSendToGame: custom.sendToGame,
          }}
          onTakeOff={(place) => setOutfit((was) => takeOff(was, place))}
          onClearAll={() => setOutfit(NOTHING_ON)}
        />
      </div>
    </>
  );
}

/**
 * One set: what it is, what it looks like, and — once opened — what it is made of.
 *
 * Opening happens in place rather than in a dialog, which is what lets a reader keep two sets
 * open and take a piece out of each. The card is a heading and a button because a heading
 * cannot live inside a button.
 *
 * **A card is a family rather than a set**, and the rail under the chips is the rest of it: the
 * difficulties and the colours the game itself files under this one — see `foldFamilies`.
 * Everything above the rail is about whichever member is being shown, and clicking a square is
 * what changes which that is.
 *
 * **The picture goes above the name, and is not part of the button that opens the set.** Above,
 * because a reader with the pictures on is choosing by eye and the name is what they check
 * afterwards; outside the button, because the picture is something to drag — a click that
 * turned out to be a drag would otherwise open a set every time somebody looked at the back of
 * one.
 */
function Card({
  set,
  family,
  open,
  onToggle,
  onShow,
  contents,
  openings,
  alternatives,
  icons,
  outfit,
  hideUnwearable,
  marks,
  markOf,
  qualityOf,
  wearersOf,
  onFilter,
  body,
  paint,
  onWear,
  onWearAll,
}: {
  /** The member of the family this card is currently drawn as. */
  set: TransmogSet;
  /** And every member of it, which is the rail under the chips — see `foldFamilies`. */
  family: Family;
  open: boolean;
  onToggle: () => void;
  /** A member picked off that rail, which the card is then drawn as instead. */
  onShow: (member: TransmogSet) => void;
  /** What the set holds, the sentence saying why it could not be read, or nothing yet. */
  contents: TransmogSetItemsPayload | string | undefined;
  /**
   * And how anybody gets the looks it locks, or nothing — see `openings.ts`.
   *
   * Nothing where the read has not landed, and nothing where it was never asked for, which is
   * every set that locks nobody out. The panel is drawn only for a set that locks something,
   * so the two never have to be told apart.
   */
  openings: OpeningsPayload | undefined;
  /** And what else might do for the ones nothing sells around — see `alternativesPanel.tsx`. */
  alternatives: AlternativeActions;
  icons: Map<number, string>;
  outfit: Outfit;
  /** Whether the rows with nowhere to go are left out, which the browser decides for all. */
  hideUnwearable: boolean;
  marks: MarkActions;
  markOf: (kind: MarkSubjectKind, id: number) => TransmogMark | undefined;
  /**
   * What the committed store measured a whole set to be, or nothing where it holds none.
   *
   * A lookup rather than the one measurement, because the rail is a strip of the family's
   * colours: eighteen `Earthen Copper Regalia` under one root are eighteen shades, and the
   * squares are the only thing on the card that tells them apart at a glance.
   */
  qualityOf: (setId: number) => Quality | undefined;
  /**
   * What the items behind this set say about it, or nothing — see `wearers.rs`.
   *
   * The card draws one thing out of it, which is who can really wear the set. Nothing means two
   * different things and the card treats them alike, because the honest answer to both is the
   * game's own mask: the read has not landed yet, or it landed and this install can describe no
   * item of the set.
   */
  wearersOf: (setId: number) => SetWearers | undefined;
  /**
   * What a chip on the card asks of the grid when it is clicked — see `terms.ts`.
   *
   * The card's own chips only. The rows inside an opened set carry chips of their own and are
   * given none of this: they are looks, and the box above the grid filters sets.
   */
  onFilter: (term: string) => void;
  /**
   * The character wearing this set, when the pictures are on and one has arrived.
   *
   * `undefined` is the pictures being off, and the card is exactly what it was before any of
   * this existed.
   */
  body: Thumbnail | undefined;
  paint: Paint;
  onWear: (row: AppearanceRow) => void;
  onWearAll: (rows: AppearanceRow[]) => void;
}): ReactNode {
  const patch = patchName(set.patchIntroduced);
  // Who the items say, where that has been read, and the game's own mask until then — one
  // decision for the chip below and the list of classes the card is titled with, so the two
  // can never be about different things.
  const wearers = wearersOf(set.id)?.classMask;
  const classes = classNames(wearers ?? set.classMask);
  const rows = typeof contents === "object" ? appearanceRows(contents, set.name) : [];
  // Whatever is hidden is still worn by "wear all of", because that puts the set on rather
  // than what happens to be listed, and it is still counted below so nothing goes quietly.
  const shown = hideUnwearable ? onlyWearable(rows) : rows;
  const hidden = rows.length - shown.length;
  const name = set.name || "Unnamed set";
  const alternates = set.alternates ?? [];
  const worn = body?.kind === "model" ? body : null;

  return (
    <article
      className="mog-card"
      data-open={open}
      title={classes.length ? classes.join(", ") : undefined}
    >
      {/* A set is a body's worth of clothes, so the whole of her is the picture — there is no
          part of her it is about, and zooming to one would be showing a fraction of the thing
          the card is for. */}
      {worn ? <Turnable glb={worn.glb} focus={WHOLE} label={name} paint={paint} /> : null}
      <h4>
        <button type="button" className="mog-open" aria-expanded={open} onClick={onToggle}>
          {name}
        </button>
      </h4>
      <div className="mog-facts">
        {/* Who can wear it, which is a harder question than the game's own mask and a more
            useful answer: "Any plate wearer" is a Paladin set a Warrior can have after all,
            and "Paladin only" is a wall. The mask until that read lands — see `wearers.rs`,
            and [`whoWears`] for the three sentences it comes to.

            All three of these narrow the grid to what they say, which is what the two dropdowns
            over it used to be: a reader looking at "Plate · Cataclysm · Patch 4.0.1" and wanting
            more like it clicks the word they are looking at rather than hunting for the select
            that happens to hold it. `patch:` never had a dropdown at all. */}
        <Fact
          facet="class"
          said={wearers === undefined ? classLabel(set.classMask) : whoWears(wearers)}
          onFilter={onFilter}
        />
        <Fact facet="expansion" said={expansionName(set.expansionId)} onFilter={onFilter} />
        {patch ? <Fact facet="patch" said={patch} prefix="Patch " onFilter={onFilter} /> : null}
        {/* Last of the facts and dashed, because it is the one of them nobody wrote down: the
            game states the class, the expansion and the patch, and this was measured off the
            artwork of the looks the set holds. There is no size — a set is a body's worth of
            clothes whatever is in it. */}
        <Qualities quality={qualityOf(set.id)} onFilter={onFilter} />
      </div>
      {/* The difficulties and the colours the game itself files under this set, as the squares
          they differ by. 1,724 of the game's sets are one of these, and a card each is a raid
          tier shown thirteen times over — Nerub-ar Palace is 52 sets and 13 things to wear.
          Under the facts because it says which set the facts above are about, and above the
          reader's own mark because a star belongs to the member that is starred. */}
      <Variants family={family} showing={set} onShow={onShow} qualityOf={qualityOf} />
      {/* Under the game's own facts and on their own line, because they are a different kind
          of statement: everything above is true of this build for everybody, and this is what
          one reader said. Available with the card shut — starring a set is not a reason to
          have to read what is in it. */}
      <MarkControls
        kind="set"
        id={set.id}
        mark={markOf("set", set.id)}
        name={name}
        actions={marks}
        onFilter={onFilter}
      />
      {/* Who else wears exactly these clothes. 436 of the game's sets are another set's
          wardrobe under a different name — one per faction, one per class, or the same armour
          reissued a season later — and showing all of them is showing one set up to six times.
          They are named here instead, because the name is the part a reader was looking for
          and the only part that was ever different. */}
      {alternates.length ? (
        <ul className="mog-alternates" aria-label={`Sets holding the same appearances as ${name}`}>
          {alternates.map((alternate) => (
            <li key={alternate.id}>{alternateLabel(alternate, set)}</li>
          ))}
        </ul>
      ) : null}
      {/* Items rather than appearances, because items is what this number is. `TransmogSetItem`
          holds one row per item and the game's own table says nothing about how many looks
          they come to — that takes four more tables and is what opening the set is for. A card
          promising eight appearances over a list of three was the old way round. */}
      <div className="mog-foot">
        <span>{plural(set.itemCount, "item")}</span>
        <span className="muted">#{set.id}</span>
      </div>
      {open ? (
        <div className="mog-contents">
          {contents === undefined ? (
            <p className="muted">Reading what the set is made of…</p>
          ) : null}
          {typeof contents === "string" ? <p className="muted">{contents}</p> : null}
          {typeof contents === "object" ? (
            <>
              <div className="mog-contents-head">
                {/* Always, now: the card counts items and this counts looks, and for 65% of the
                sets in the game those are different numbers. It is the sentence that explains
                why a set of 126 items opened as a list of 11. */}
                <p className="detail-facts">{appearanceSummary(rows, contents)}</p>
                {/* Hidden rather than absent: the count on the card includes them, and a list
                shorter than it promised is what a reader would otherwise have to explain. */}
                {hidden ? (
                  <p className="detail-facts muted">
                    {`${plural(hidden, "appearance")} hidden, with nowhere on her to go`}
                  </p>
                ) : null}
                {/* A set is a set of clothes and seeing all of it at once is the ordinary thing to
                want; clicking twelve rows to get there is not. */}
                {rows.some((row) => wearable(row)) ? (
                  <button type="button" className="mog-wear-all" onClick={() => onWearAll(rows)}>
                    {`Wear all of ${name}`}
                  </button>
                ) : null}
              </div>
              {/* Which of the looks this set locks anybody can get anyway, and where. Above the
                  list because it is about the whole set and the list is one row at a time, and
                  only for a set that locks something — for the other two thirds of the game's
                  sets there is no question to answer. See `openings.ts`. */}
              {locksAnything(rows) ? (
                <OpeningsPanel
                  name={name}
                  rows={rows}
                  openings={openings}
                  alternatives={alternatives}
                  icons={icons}
                />
              ) : null}
              <ul className="mog-items" aria-label={`Appearances in ${name}`}>
                {shown.map((row, index) => (
                  <Line
                    key={`${row.appearanceId}-${index}`}
                    row={row}
                    worn={isWorn(outfit, row)}
                    icon={icons.get(row.iconFileDataId)}
                    marks={marks}
                    mark={markOf("appearance", row.appearanceId)}
                    onWear={() => onWear(row)}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * One thing the game states about a set, and the way to ask the grid for more like it.
 *
 * This is where the expansion and class dropdowns went. They asked what the card was already
 * printing, so a reader had two ways to say one thing and neither of them was the obvious one —
 * the obvious one being the word itself, which is what they were looking at. Clicking it writes
 * the term into the box above; see `terms.ts` for the syntax and `qualitiesChips.tsx` for the
 * chip that has worked this way since the measured colours arrived.
 *
 * It stays looking like the chip it was rather than becoming a button, for the reason the
 * measured one does: it is still the card stating a fact, and the underline on hover is the
 * whole of what says it can be clicked. Named by what it would do rather than by what it says,
 * because "Cataclysm" read out of a grid of several thousand cards is not something anybody can
 * act on.
 *
 * @param prefix What the chip prints before the value but does not ask for — "Patch 4.0.1" is
 *   what a reader reads and `patch:4.0.1` is the term, the word "Patch" being the key said aloud.
 */
function Fact({
  facet,
  said,
  prefix = "",
  onFilter,
}: {
  /** The key the term is asked under — and never React's own `key`. */
  facet: string;
  said: string;
  prefix?: string;
  onFilter: (term: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="chip mog-ask"
      aria-label={`Filter by ${facet}: ${said}`}
      title={`Filter by ${facet}: ${said}`}
      onClick={() => onFilter(termText(facet, said))}
    >
      {prefix}
      {said}
    </button>
  );
}

/**
 * The rail of a family: one square per member, and the one the card is drawn as pressed.
 *
 * **Squares rather than names, because the names are mostly the same word.** 1,026 of the 1,724
 * variants a shipping install holds are called exactly what their root is called — four
 * difficulties of one raid set are one name four times — and a rail of four identical strings is
 * four buttons a reader cannot choose between. What does differ is the artwork, which the
 * committed store has already measured: the square is the colour, drawn the one way the packaged
 * app's Content Security Policy allows an arbitrary colour to be drawn at all — see
 * `qualitiesChips.tsx`.
 *
 * The name is still the whole of what the button is *called*, because a square is nothing a
 * screen reader can read out and a reader who cannot see the colours has to be able to pick a
 * member all the same. Where the family holds two of a name, the id goes on the end of both —
 * see [`variantLabel`], which is the same fallback the card's own foot makes.
 *
 * Nothing at all for a set the game files under no parent, which is two thirds of them.
 */
function Variants({
  family,
  showing,
  onShow,
  qualityOf,
}: {
  family: Family;
  showing: TransmogSet;
  onShow: (member: TransmogSet) => void;
  qualityOf: (setId: number) => Quality | undefined;
}): ReactNode {
  if (family.members.length < 2) return null;
  // The member being shown rather than the family's root, so that the rail is named after the
  // card it is on however far down it a reader has clicked: a list called after a set whose
  // name is no longer above it is a list nobody could find twice.
  const name = showing.name || "Unnamed set";
  return (
    <ul className="mog-variants" aria-label={`Difficulties and colours of ${name}`}>
      {family.members.map((member) => {
        const quality = qualityOf(member.id);
        const said = variantLabel(member, family);
        return (
          <li key={member.id}>
            <button
              type="button"
              className="mog-variant"
              aria-pressed={member.id === showing.id}
              aria-label={`Show ${said}`}
              title={said}
              onClick={() => onShow(member)}
            >
              {/* An empty square rather than none, for the 213 sets of a shipping install the
                  store measured nothing of: a rail that lost a member wherever a colour was
                  missing would be a rail a reader could not count. */}
              {quality ? (
                <Swatch colour={quality.primary} />
              ) : (
                <span className="mog-variant-blank" aria-hidden="true" />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One appearance, as something to put on.
 *
 * Clicking it dresses the character in it and clicking it again takes it off; clicking a
 * second thing for the same place swaps rather than stacks, which is `outfit.ts`'s rule and
 * is what a reader trying hats expects.
 *
 * **The whole row is the button, and Wowhead is the small link at the end of it.** They were
 * the other way round — the name was the link and only the icon put the thing on — and the
 * row a reader means to click is the one with the name on it. Leaving the app is the rarer
 * errand of the two, so it gets the corner and an icon rather than the width of the row.
 *
 * Whether it can be worn at all is a fact about the game rather than about this install: an
 * appearance the game encrypts, and a thing it files under a weapon slot and gives nobody a
 * place to hold. Such a row is hidden unless the browser above is asked to show it, and when
 * it is shown it says why it is not on her instead of being a button that does nothing.
 */
function Line({
  row,
  worn,
  icon,
  marks,
  mark,
  onWear,
}: {
  row: AppearanceRow;
  worn: boolean;
  icon?: string;
  marks: MarkActions;
  /** What the reader said about this *look*, which is the same mark the wardrobe draws. */
  mark: TransmogMark | undefined;
  onWear: () => void;
}): ReactNode {
  const wanted = canBeWorn(row);
  const canWear = wanted.kind === "worn";
  const [showSources, setShowSources] = useState(false);
  // Items, not lines: a row saying "+2 items" over a list of one is what folding two
  // indistinguishable items into one line would otherwise produce.
  const others = itemsBehind(row) - 1;

  // An empty frame either way. A row whose appearance names no icon keeps it so the list stays
  // a column of pictures rather than one that indents wherever the game said nothing. The
  // frame says what it is a frame for and the picture inside it says nothing at all: the whole
  // row is one button and already carries the slot and the item in its own name, so a picture
  // announcing itself as well would have a screen reader read every row twice.
  return (
    <li className="mog-item" data-worn={worn}>
      <button
        type="button"
        className="mog-pick"
        aria-pressed={worn}
        disabled={!canWear}
        aria-label={`Wear ${row.slot}: ${row.label}`}
        onClick={onWear}
      >
        <span className="mog-icon" role="img" aria-label={`Icon for ${row.label}`}>
          {icon ? <img src={icon} alt="" /> : null}
        </span>
        <span className="badge">{row.slot}</span>
        <span className="mog-name">{row.label}</span>
      </button>
      {worn ? <span className="chip">worn</span> : null}
      {/* The look, not the item: a piece starred inside one set is starred wherever it turns
          up, including in the wardrobe list beside this one, because both key on the
          appearance. An appearance the game withholds has no id and gets no controls. */}
      <MarkControls
        kind="appearance"
        id={row.appearanceId}
        mark={mark}
        name={row.label}
        actions={marks}
      />
      {/* The one thing about a row worth saying without being asked. A reader whose class
          cannot wear the set's own version of a look can still have the look, and nothing else
          on the row would ever tell them so. */}
      {row.liftsRestriction ? (
        <span className="chip mog-lifted" title="Another item gives this look to any class">
          Any class too
        </span>
      ) : null}
      {/* Every item that gives the look, behind a count. The row above is the look and this is
          the shopping: a set names one appearance once per item that has it, and 15,304 of the
          28,486 appearances in the game's sets are named more than once. */}
      {others > 0 ? (
        <button
          type="button"
          className="mog-sources-toggle"
          aria-expanded={showSources}
          onClick={() => setShowSources((open) => !open)}
        >{`+${others} ${others === 1 ? "item" : "items"}`}</button>
      ) : null}
      {/* A withheld row says so where a name would be, and saying it twice is two elements
          with the same sentence in them rather than one clearer row. */}
      {canWear || row.withheld ? null : <span className="muted">{wanted.note}</span>}
      {/* The corner leaves for Wowhead only when there is one item to leave for. An
          appearance the game withholds has none, and a look several items give has no single
          one — "which of these did you mean" is a real question, and the answer is the list
          the count opens, where every item has a corner of its own. */}
      {row.withheld || others > 0 ? null : (
        <a
          className="mog-wowhead"
          href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`${row.label} on Wowhead`}
          aria-label={`${row.label} on Wowhead`}
        >
          <LinkOut />
        </a>
      )}
      {showSources ? <Sources row={row} /> : null}
    </li>
  );
}

/**
 * The items that give one look, and only what separates them.
 *
 * **Which columns are drawn is decided per row, not once for the list.** Half of the
 * appearances in the game that several items reach differ by nothing but their names, and a
 * class, a level and a quality repeated identically down five lines is five lines saying
 * nothing — so `varyingFacts` is asked first and a fact that is the same all the way down is
 * simply not drawn. What is left is the answer to the question the list is open for: what do I
 * have to be, and what do I have to have done, to wear this.
 *
 * The order is the same one `transmogModal` sorted the sources into: whatever anybody can wear
 * first, then the cheapest way in.
 */
function Sources({ row }: { row: AppearanceRow }): ReactNode {
  const varies = varyingFacts(row);
  return (
    <ul className="mog-sources" aria-label={`Items that give ${row.label}`}>
      {row.sources.map((source: AppearanceSource) => (
        <li key={source.modifiedAppearanceId} className="mog-source">
          <span className="mog-source-name">{source.label}</span>
          {/* One line standing for several items the game says nothing different about. */}
          {source.itemCount > 1 ? (
            <span className="chip">{`\u00d7${source.itemCount}`}</span>
          ) : null}
          {varies.allowableClass ? (
            <span className="chip">{wearerLabel(source.allowableClass)}</span>
          ) : null}
          {varies.quality ? <span className="chip">{qualityLabel(source.quality)}</span> : null}
          {varies.requiredLevel && source.requiredLevel > 0 ? (
            <span className="chip">{`Level ${source.requiredLevel}`}</span>
          ) : null}
          <a
            className="mog-wowhead"
            href={`https://www.wowhead.com/item=${encodeURIComponent(source.itemId)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${source.label} on Wowhead`}
          >
            <LinkOut />
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * How far down the filtered sets the grid has got.
 *
 * Two sentences rather than one, because the grid only has a page when the pictures are on and
 * "340 of 340 sets" would be an arithmetic problem set to a reader who is not being kept from
 * anything. Phrased the way the wardrobe's own count is — see `shownSummary`.
 */
function shownCount(shown: number, total: number): string {
  if (shown >= total) return `${plural(total, "set")} shown`;
  return `${shown} of ${plural(total, "set")}`;
}
