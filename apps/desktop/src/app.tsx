/**
 * The window: six views over one loaded dashboard, and the plumbing behind them.
 *
 * Timeline is what happened, Characters is who it happened to, Details is every row of it,
 * Query is the same history with the questions left open, Transmog is what the installed game
 * holds, Settings is the plumbing. The first three read the same segments, and every write goes
 * through the backend and comes back as a whole dashboard — so what is on screen is always what
 * was stored, never what the page hoped a write did.
 *
 * A view is hidden rather than unmounted when the reader is somewhere else. That is what keeps
 * a scroll position, an unfolded summary and a table's sort where they were left, and it is
 * the whole reason the tabs are not a router.
 */

import "./app.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ActivityEditor } from "./activityEditor";
import { createCaptureAlbum } from "./captures";
import { buildCharacters } from "./characters";
import { Characters } from "./charactersView";
import { createCurrencyIcons } from "./currencies";
import { createBossPortraits } from "./bosses";
import { createPlaceIcons } from "./places";
import { Details } from "./details";
import { duration, plural } from "./format";
import { gapEvidence, gapSentence } from "./gap";
import { createAchievementBook } from "./achievements";
import { desktop, message } from "./desktop";
import { createItemBook } from "./items";
import { installExternalLinks } from "./links";
import { QueryView } from "./queryView";
import { useAsyncResource, usePoll } from "./resource";
import type { StillWanted } from "./resource";
import { AppearanceModal } from "./appearanceModal";
import type { AppearanceModalState } from "./appearanceModal";
import { SegmentModal } from "./segmentModal";
import type { SegmentModalState } from "./segmentModal";
import { buildSessions } from "./sessions";
import { Settings as SettingsView } from "./settings";
import { Timeline } from "./timeline";
import { Tooltip } from "./tooltip";
import { TransmogView } from "./transmogView";
import { VersionTag } from "./versionTag";
import type { DashboardPayload, Release, Segment, SessionGap, Settings } from "./types";

const VIEWS = ["timeline", "characters", "details", "query", "transmog", "settings"] as const;
type View = (typeof VIEWS)[number];

const TAB_LABELS: Record<View, string> = {
  timeline: "Timeline",
  characters: "Characters",
  details: "Details",
  query: "Query",
  transmog: "Transmog",
  settings: "Settings",
};

/** How often the window looks for segments it has not seen. */
const DASHBOARD_POLL_MS = 30_000;

export interface AppProps {
  payload: DashboardPayload;
  settings: Settings;
  /** Which build is running, or nothing when the backend would not say. */
  release: Release | null;
}

export function App({ payload, settings, release }: AppProps): ReactNode {
  const [segments, setSegments] = useState<Segment[]>(payload.segments || []);
  // Nothing can be collected until the game folder is known, so a first run opens on the one
  // screen that can do anything about it rather than on an empty timeline.
  const [view, setView] = useState<View>(settings.wowPath ? "timeline" : "settings");
  const [showing, setShowing] = useState<SegmentModalState | null>(null);
  const [gap, setGap] = useState<SessionGap | null>(null);
  // The one transmog source a reader has clicked through to a picture of, which is nothing
  // until they do: the tables behind it are the game's largest and are opened on that click.
  const [drawing, setDrawing] = useState<AppearanceModalState | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  // The four things the transmog screen is drawn from, each asked for the first time somebody
  // opens a view that wants it and kept for the life of the window. `resource.ts` is what says
  // when — and, more to the point, what says an answer arriving after the reader has gone
  // somewhere else is not written to the screen, and that a torn-down and re-established effect
  // is one read of the game's files rather than two.
  //
  // The sets come out of the game's own files, which costs a second and a few hundred megabytes.
  const sets = useAsyncResource({ when: view === "transmog", load: desktop.transmogSets });
  // What the reader has said about the game's wardrobe, which is the only thing on that screen
  // that comes out of Chronie's own database rather than out of the installed game. Read
  // alongside the sets rather than with them: it answers in a millisecond where they take a
  // second. A failure here is left silent on purpose — the screen simply has nothing marked on
  // it, and the first attempt to mark something says why it will not.
  const marks = useAsyncResource({ when: view === "transmog", load: desktop.transmogMarks });
  // And the sets the reader saved, on the same terms, and silent about a failure for the same
  // reason: the browser it feeds is one of three and the two beside it are the game's.
  const customSets = useAsyncResource({ when: view === "transmog", load: desktop.customSets });
  // And the sets the player saved in the game. Also Chronie's own database — the addon put them
  // there and the collector filed them — so this is a millisecond and not the second the game's
  // files cost. Wanted by two views rather than one, and one read serves whichever is opened
  // first.
  const inGameSets = useAsyncResource({
    when: view === "transmog" || view === "characters",
    load: desktop.inGameSets,
  });

  // Kinds the backend can guess at, plus any the user has already invented, so the editor's
  // picker offers what this history actually contains rather than only what the app ships with.
  const knownKinds = useMemo(
    () =>
      [
        ...new Set([
          ...(payload.knownActivityKinds || []),
          ...segments.flatMap((segment) => (segment.activities || []).map((entry) => entry.kind)),
        ]),
      ].sort(),
    [payload.knownActivityKinds, segments],
  );

  // What the game says about an achievement outlives any one segment, so the book is made once
  // for the whole window rather than per modal: a reader walking a history meets the same
  // achievements over and over, and each is looked up the first time and never again.
  const achievements = useMemo(
    () =>
      createAchievementBook({
        load: (ids) => desktop.achievementDetails(ids),
        loadIcons: (iconFileDataIds) => desktop.gameIcons(iconFileDataIds),
      }),
    [],
  );

  // And the same for items, which every view that names one asks for itself: a row puts its
  // own id in the book and the book sends one request for whatever asked in that turn, so a
  // segment of twenty pieces is one lookup and the second segment naming the same piece is
  // none. One book for the window, because a wardrobe is the same wardrobe on every screen.
  const items = useMemo(
    () =>
      createItemBook({
        load: (ids) => desktop.itemDetails(ids),
        loadIcons: (iconFileDataIds) => desktop.gameIcons(iconFileDataIds),
      }),
    [],
  );

  // And the pictures the game draws a currency with, on the same terms and for the same reason:
  // a reader walking a roster of ten alts meets the same handful of currencies on every one of
  // them, so each is asked about once for the life of the window.
  const currencyIcons = useMemo(() => createCurrencyIcons({ load: desktop.currencyIcons }), []);

  // And the pictures the game draws a place with, which every segment row and the modal over it
  // ask for by the name the addon filed them under. One book for the window because a history is
  // the same forty evenings on every screen, and most of what it is asked about — the open world
  // — comes back with nothing at all and is remembered as such.
  const placeIcons = useMemo(() => createPlaceIcons({ load: desktop.placeIcons }), []);

  // And the portraits the game draws a boss with, which only the segment modal names. One book
  // regardless, because a raid night is the same eight bosses across every segment of it and a
  // reader stepping through them would otherwise ask about each fight once per evening it was in.
  const bossPortraits = useMemo(() => createBossPortraits({ load: desktop.bossPortraits }), []);

  // The same argument as the achievement book: a thumbnail outlives any one grid, and a reader
  // scrolling back through a history meets the same evening's pictures over and over. One
  // album for the window means each one crosses the bridge once.
  const album = useMemo(() => createCaptureAlbum(desktop.captureThumbnails), []);

  // Every write answers with the whole dashboard, so what ends up on screen is what was
  // stored. Which matters more for a note than for anything else in the app: a sentence that
  // looked saved and was not is one nobody will think to type again.
  const captureActions = useMemo(
    () => ({
      loadImage: desktop.captureImage,
      setNote: desktop.setCaptureNote,
      remove: desktop.deleteCapture,
      onApply: applyDashboard,
      onError: message,
      // `applyDashboard` is redeclared on every render and does not close over anything that
      // changes, so pinning the actions here is what keeps the viewer's effects from re-running.
    }),
    [],
  );

  const sessions = useMemo(() => buildSessions(segments), [segments]);
  const profiles = useMemo(
    () => buildCharacters(segments, payload.holdings),
    [segments, payload.holdings],
  );

  // Every link the window draws is a link out of it, and the window is the wrong place for a
  // web page. A url the backend will not open is a dead link on screen, so it is worth saying.
  // The installer answers with the way to stop, and this returns it: one click on one link has
  // to reach the operating system once, and two live listeners is two browser tabs.
  useEffect(
    () =>
      installExternalLinks({
        root: document,
        open: desktop.openUrl,
        onFailure: (url, error) =>
          console.error(`Chronie could not open ${url}: ${message(error)}`),
      }),
    [],
  );

  // Whether an evening was played that never reached the file. Asked on the same beat the
  // segments are, and for the same reason: the answer changes underneath the window, as the
  // client writes its combat log and as a sync brings the history level with it again. A
  // failure leaves the last answer alone rather than clearing it — the notice is about data
  // that is already gone, and a backend that is briefly not answering is not news that it
  // came back.
  const askGap = useCallback(async (live: StillWanted): Promise<void> => {
    try {
      const answer = await desktop.sessionGap();
      if (live()) setGap(answer);
    } catch {
      // See above: the last answer is left where it is.
    }
  }, []);
  usePoll(askGap, { active: Boolean(desktop.pollDashboard), every: DASHBOARD_POLL_MS });

  // Somebody may be playing while this window is open, and the collector picks up what the
  // game wrote within half a minute. Anything new means every view is out of date at once.
  //
  // An effect of its own rather than a `usePoll`, and the difference is the first ask: this one
  // deliberately has none. What it does with an answer is reload the window, and the answer it
  // would get on the beat it mounted is the dashboard the window was just built from.
  useEffect(() => {
    if (!desktop.pollDashboard) return;
    const signature = (list: Segment[]): string =>
      JSON.stringify(list.map((segment) => [segment.id, segment.endedAt]));
    const known = signature(segments);
    const timer = setInterval(() => {
      void desktop.dashboard().then((next) => {
        if (signature(next.segments || []) !== known) window.location.reload();
      });
    }, DASHBOARD_POLL_MS);
    return () => clearInterval(timer);
  }, [segments]);

  /**
   * Folds a fresh dashboard onto the segments already on screen.
   *
   * Only the parts a write can have changed, rather than replacing the segments outright: the
   * page keeps its identity — an open modal, an unfolded summary — and picks up the two lists
   * that an edit in this window can move.
   */
  function applyDashboard(fresh: DashboardPayload): void {
    const byId = new Map((fresh.segments || []).map((segment) => [segment.segmentId, segment]));
    setSegments((list) =>
      list.map((segment) => {
        const next = byId.get(segment.segmentId);
        return next
          ? { ...segment, activities: next.activities || [], captures: next.captures || [] }
          : segment;
      }),
    );
  }

  // The modal walks the list it was opened from, and that list is re-resolved against the
  // segments on screen — so an activity edit, or a note, lands in the open modal too.
  const walking = useMemo((): SegmentModalState | null => {
    if (!showing) return null;
    const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
    return {
      index: showing.index,
      order: showing.order.map((segment) => byId.get(segment.segmentId) ?? segment),
    };
  }, [showing, segments]);

  const openSegment = (segmentId: number, order: Segment[]): void => {
    if (!order.length) return;
    setShowing({
      order,
      index: Math.max(
        order.findIndex((s) => s.segmentId === segmentId),
        0,
      ),
    });
  };

  const editingSegment =
    editing == null ? null : (segments.find((segment) => segment.segmentId === editing) ?? null);

  const meta = segments.length
    ? [
        plural(sessions.length, "play session"),
        plural(segments.length, "segment"),
        plural(new Set(segments.map((segment) => segment.character)).size, "character"),
        `${duration(segments.reduce((total, segment) => total + (segment.seconds || 0), 0))} played`,
      ].join(" · ")
    : "Nothing collected yet.";

  const missing = gapSentence(gap);

  // What the transmog view says instead of a wardrobe, which is nothing at all once there is
  // one. Derived from where the read has got to rather than kept beside it in a second piece of
  // state — the pair used to be able to disagree, and a screen saying it was still reading over
  // a wardrobe that had arrived was what that looked like.
  const setsStatus =
    sets.state === "loading" ? READING_SETS : sets.state === "failed" ? message(sets.error) : "";

  const rosterMeta = profiles.length
    ? [
        plural(profiles.length, "character"),
        plural(
          profiles.reduce((total, entry) => total + entry.segmentCount, 0),
          "segment",
        ),
        `${duration(profiles.reduce((total, entry) => total + entry.seconds, 0))} played`,
      ].join(" · ")
    : "Nothing collected yet.";

  return (
    <div className="wrap">
      <nav className="appbar" aria-label="Application">
        <span className="brand">Chronie</span>
        <VersionTag release={release} />
        {VIEWS.map((name) => (
          <button
            key={name}
            id={`${name}-tab`}
            type="button"
            className={name === view ? "primary" : undefined}
            aria-current={name === view ? "page" : "false"}
            onClick={() => setView(name)}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </nav>

      {/* Each view is a landmark named after the tab that opens it, which is what makes it
          reachable — by a screen reader jumping between regions, and by the browser suite,
          which addresses every view the same way. The hidden ones are out of the tree
          entirely, so the name only ever belongs to the view on screen. */}
      <main id="timeline-view" aria-label={TAB_LABELS.timeline} hidden={view !== "timeline"}>
        <header className="view-head">
          <h1>Timeline</h1>
          {/* A live region, because it is recomputed as segments arrive and it is the one line
              that says how much of a history is on screen. */}
          <div
            className="sub"
            id="timeline-meta"
            role="status"
            aria-label="What the timeline holds"
          >
            {meta}
          </div>
          {/* Only ever drawn when there is a hole, and an alert rather than a status because
              it is not a description of the page — it is the page admitting it is incomplete.
              A reader who never sees this has never lost a session. */}
          {missing && (
            <div className="notice" id="timeline-gap" role="alert" aria-label="Missing play">
              <p>{missing}</p>
              {gapEvidence(gap).map((line) => (
                <p className="sub" key={line}>
                  {line}
                </p>
              ))}
            </div>
          )}
        </header>
        <div id="timeline">
          <Timeline
            sessions={sessions}
            onOpenSegment={openSegment}
            items={items}
            places={placeIcons}
            album={album}
            captures={captureActions}
          />
        </div>
      </main>

      <section
        id="characters-view"
        aria-label={TAB_LABELS.characters}
        hidden={view !== "characters"}
      >
        <header className="view-head">
          <h1>Characters</h1>
          <div
            className="sub"
            id="characters-meta"
            role="status"
            aria-label="What the roster holds"
          >
            {rosterMeta}
          </div>
        </header>
        <Characters
          profiles={profiles}
          onOpenSegment={openSegment}
          items={items}
          inGameSets={inGameSets.value}
          currencyIcons={currencyIcons}
          places={placeIcons}
          loadSetAppearances={desktop.inGameSetAppearances}
          loadWorn={desktop.characterWornSet}
        />
      </section>

      <section id="details-view" aria-label={TAB_LABELS.details} hidden={view !== "details"}>
        <header className="view-head">
          <h1>Details</h1>
          <div className="sub">
            Every segment on its own row. Click a column to sort, a row to open it.
          </div>
        </header>
        <Details segments={segments} onOpenSegment={openSegment} items={items} />
      </section>

      <section id="query-view" aria-label={TAB_LABELS.query} hidden={view !== "query"}>
        <QueryView
          visible={view === "query"}
          actions={{
            run: desktop.runQuery,
            schema: desktop.querySchema,
            onError: message,
          }}
        />
      </section>

      <section id="transmog-view" aria-label={TAB_LABELS.transmog} hidden={view !== "transmog"}>
        <TransmogView
          payload={sets.value}
          status={setsStatus}
          loadSet={desktop.transmogSetItems}
          loadAppearances={desktop.transmogAppearances}
          loadIcons={desktop.gameIcons}
          loadCharacter={desktop.characterModel}
          loadWorn={desktop.wornSet}
          loadGallery={desktop.galleryModels}
          loadSetGallery={desktop.gallerySets}
          herself={{
            load: desktop.characterLook,
            save: desktop.saveCharacterLook,
            onError: message,
          }}
          marks={{
            payload: marks.value,
            setFavourite: desktop.setTransmogFavourite,
            setTag: desktop.setTransmogTag,
            deleteTag: desktop.deleteTransmogTag,
            // Every write answers with every mark, so the browsers repaint from what was
            // stored — the same rule the activity and capture edits follow. `put` rather than a
            // setter, so the resource counts the write as its own answer and nothing goes back
            // to the database for a version of it from before the edit.
            onApply: marks.put,
            onError: message,
          }}
          custom={{
            payload: customSets.value,
            save: desktop.saveCustomSet,
            remove: desktop.deleteCustomSet,
            // Every write answers with every saved set, for the reason above it.
            onApply: customSets.put,
            onError: message,
            sendToGame: desktop.sendSetToGame,
          }}
          inGame={{
            payload: inGameSets.value,
            loadAppearances: desktop.inGameSetAppearances,
          }}
        />
      </section>

      <section id="settings-view" aria-label={TAB_LABELS.settings} hidden={view !== "settings"}>
        <SettingsView
          settings={settings}
          visible={view === "settings"}
          actions={{
            choosePath: desktop.chooseWowPath,
            savePath: desktop.saveWowPath,
            syncNow: desktop.syncNow,
            installAddon: desktop.installAddon,
            checkForAppUpdate: desktop.checkForAppUpdate,
            onSynced: reloadWindow(800),
            onError: message,
          }}
          captures={{
            setTriggers: desktop.setCaptureTriggers,
            setStorage: desktop.setCaptureStorage,
            onError: message,
          }}
          combatLog={{
            status: desktop.combatLogging,
            set: desktop.setCombatLogging,
            onError: message,
          }}
          retention={{
            status: desktop.logRetention,
            set: desktop.setLogRetention,
            onError: message,
          }}
          wifi={{
            discover: desktop.wifiDiscover,
            send: desktop.wifiSend,
            startWaiting: desktop.wifiReceiveStart,
            stopWaiting: desktop.wifiReceiveStop,
            status: desktop.wifiReceiveStatus,
            answer: desktop.wifiAnswerOffer,
            // Every view on screen is of a history that has just been replaced, and folding a
            // whole new database into the page in flight is not worth inventing — the window
            // starts again from what is now stored.
            onReplaced: reloadWindow(1200),
            onError: message,
          }}
        />
      </section>

      <Tooltip />

      <SegmentModal
        showing={walking}
        achievements={achievements}
        items={items}
        places={placeIcons}
        bosses={bossPortraits}
        holdings={payload.holdings}
        album={album}
        captures={captureActions}
        onStep={(by) =>
          setShowing((was) => {
            if (!was) return was;
            const next = was.index + by;
            return next < 0 || next >= was.order.length ? was : { ...was, index: next };
          })
        }
        onClose={() => setShowing(null)}
        onEditActivities={setEditing}
        onShowAppearance={setDrawing}
      />

      {/* Over the segment rather than instead of it: the reader is looking at one row of a
          list they are part way through, and closing the picture puts them back on it. */}
      <AppearanceModal
        showing={drawing}
        onClose={() => setDrawing(null)}
        loadAppearance={desktop.itemAppearances}
        loadGallery={desktop.galleryModels}
      />

      <ActivityEditor
        segment={editingSegment}
        knownKinds={knownKinds}
        onApply={applyDashboard}
        onClose={() => setEditing(null)}
        actions={{
          add: desktop.addActivity,
          update: desktop.updateActivity,
          remove: desktop.deleteActivity,
          reset: desktop.resetActivities,
          onError: message,
        }}
      />
    </div>
  );
}

/** What the transmog view says while the game's tables are being read. */
const READING_SETS = "Reading the game's transmog tables…";

/**
 * Starting the window again, a moment later.
 *
 * Two things replace the whole history rather than change part of it — a sync that found new
 * segments, and a database arriving from another machine — and folding either into the page in
 * flight is not worth inventing. The delay is so the sentence that says what happened is on
 * screen long enough to read. The browser suite drives the same buttons and cannot survive a
 * reload mid-test, so under it this does nothing.
 */
const reloadWindow = (after: number) => (): void => {
  desktop.reloadWindow(after);
};
