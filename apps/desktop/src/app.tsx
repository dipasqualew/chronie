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

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ActivityEditor } from "./activityEditor";
import { createCaptureAlbum } from "./captures";
import { buildCharacters } from "./characters";
import { Characters } from "./charactersView";
import { Details } from "./details";
import { duration, plural } from "./format";
import { createAchievementBook } from "./achievements";
import { desktop, message } from "./bridge";
import { createItemBook } from "./items";
import { installExternalLinks } from "./links";
import { QueryView } from "./queryView";
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
import type {
  CustomSetsPayload, DashboardPayload, Release, Segment, Settings, TransmogMarksPayload,
  TransmogPayload,
} from "./types";

const VIEWS = ["timeline", "characters", "details", "query", "transmog", "settings"] as const;
type View = typeof VIEWS[number];

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
  // The one transmog source a reader has clicked through to a picture of, which is nothing
  // until they do: the tables behind it are the game's largest and are opened on that click.
  const [drawing, setDrawing] = useState<AppearanceModalState | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [transmog, setTransmog] = useState<TransmogPayload | null>(null);
  const [transmogStatus, setTransmogStatus] = useState("");
  // What the reader has said about the game's wardrobe, which is the only thing on that screen
  // that comes out of Chronie's own database rather than out of the installed game.
  const [marks, setMarks] = useState<TransmogMarksPayload | null>(null);
  // And the sets they put together out of it themselves, which come from the same place and
  // are read in the same breath.
  const [customSets, setCustomSets] = useState<CustomSetsPayload | null>(null);

  // Kinds the backend can guess at, plus any the user has already invented, so the editor's
  // picker offers what this history actually contains rather than only what the app ships with.
  const knownKinds = useMemo(() => [...new Set([
    ...(payload.knownActivityKinds || []),
    ...segments.flatMap((segment) => (segment.activities || []).map((entry) => entry.kind)),
  ])].sort(), [payload.knownActivityKinds, segments]);

  // What the game says about an achievement outlives any one segment, so the book is made once
  // for the whole window rather than per modal: a reader walking a history meets the same
  // achievements over and over, and each is looked up the first time and never again.
  const achievements = useMemo(() => createAchievementBook({
    load: (ids) => desktop.achievementDetails(ids),
    loadIcons: (iconFileDataIds) => desktop.gameIcons(iconFileDataIds),
  }), []);

  // And the same for items, which every view that names one asks for itself: a row puts its
  // own id in the book and the book sends one request for whatever asked in that turn, so a
  // segment of twenty pieces is one lookup and the second segment naming the same piece is
  // none. One book for the window, because a wardrobe is the same wardrobe on every screen.
  const items = useMemo(() => createItemBook({
    load: (ids) => desktop.itemDetails(ids),
    loadIcons: (iconFileDataIds) => desktop.gameIcons(iconFileDataIds),
  }), []);

  // The same argument as the achievement book: a thumbnail outlives any one grid, and a reader
  // scrolling back through a history meets the same evening's pictures over and over. One
  // album for the window means each one crosses the bridge once.
  const album = useMemo(() => createCaptureAlbum(desktop.captureThumbnails), []);

  // Every write answers with the whole dashboard, so what ends up on screen is what was
  // stored. Which matters more for a note than for anything else in the app: a sentence that
  // looked saved and was not is one nobody will think to type again.
  const captureActions = useMemo(() => ({
    loadImage: desktop.captureImage,
    setNote: desktop.setCaptureNote,
    remove: desktop.deleteCapture,
    onApply: applyDashboard,
    onError: message,
  // `applyDashboard` is redeclared on every render and does not close over anything that
  // changes, so pinning the actions here is what keeps the viewer's effects from re-running.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const sessions = useMemo(() => buildSessions(segments), [segments]);
  const profiles = useMemo(
    () => buildCharacters(segments, payload.holdings), [segments, payload.holdings],
  );

  // Every link the window draws is a link out of it, and the window is the wrong place for a
  // web page. A url the backend will not open is a dead link on screen, so it is worth saying.
  useEffect(() => {
    installExternalLinks({
      root: document,
      open: desktop.openUrl,
      onFailure: (url, error) => console.error(`Chronie could not open ${url}: ${message(error)}`),
    });
  }, []);

  // The sets come out of the game's own files, which costs a second and a few hundred
  // megabytes to read, so the view asks for them the first time it is opened and keeps them.
  useEffect(() => {
    if (view !== "transmog" || transmog || transmogStatus === LOADING) return;
    setTransmogStatus(LOADING);
    void desktop.transmogSets()
      .then(setTransmog)
      .catch((error: unknown) => setTransmogStatus(message(error)));
  }, [view, transmog, transmogStatus]);

  // And what the reader has already said about them, read alongside rather than with them: it
  // is Chronie's own database and answers in a millisecond, where the sets are the game's
  // files and take a second. A failure here is left silent on purpose — the screen simply has
  // nothing marked on it, and the first attempt to mark something says why it will not.
  useEffect(() => {
    if (view !== "transmog" || marks) return;
    void desktop.transmogMarks().then(setMarks).catch(() => undefined);
  }, [view, marks]);

  // The sets the reader saved, on the same terms: Chronie's own database, read when the view is
  // first opened, and silent about a failure because the browser it feeds is one of three and
  // the two beside it are the game's.
  useEffect(() => {
    if (view !== "transmog" || customSets) return;
    void desktop.customSets().then(setCustomSets).catch(() => undefined);
  }, [view, customSets]);

  // Somebody may be playing while this window is open, and the collector picks up what the
  // game wrote within half a minute. Anything new means every view is out of date at once.
  useEffect(() => {
    if (globalThis.__Chronie_E2E__) return;
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
    setSegments((list) => list.map((segment) => {
      const next = byId.get(segment.segmentId);
      return next
        ? { ...segment, activities: next.activities || [], captures: next.captures || [] }
        : segment;
    }));
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
    setShowing({ order, index: Math.max(order.findIndex((s) => s.segmentId === segmentId), 0) });
  };

  const editingSegment = editing == null
    ? null
    : segments.find((segment) => segment.segmentId === editing) ?? null;

  const meta = segments.length
    ? [
      plural(sessions.length, "play session"),
      plural(segments.length, "segment"),
      plural(new Set(segments.map((segment) => segment.character)).size, "character"),
      `${duration(segments.reduce((total, segment) => total + (segment.seconds || 0), 0))} played`,
    ].join(" · ")
    : "Nothing collected yet.";

  const rosterMeta = profiles.length
    ? [
      plural(profiles.length, "character"),
      plural(profiles.reduce((total, entry) => total + entry.segmentCount, 0), "segment"),
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
            key={name} id={`${name}-tab`} type="button"
            className={name === view ? "primary" : undefined}
            aria-current={name === view ? "page" : "false"}
            onClick={() => setView(name)}
          >{TAB_LABELS[name]}</button>
        ))}
      </nav>

      <main id="timeline-view" hidden={view !== "timeline"}>
        <header className="view-head">
          <h1>Timeline</h1>
          <div className="sub" id="timeline-meta">{meta}</div>
        </header>
        <div id="timeline">
          <Timeline
            sessions={sessions} onOpenSegment={openSegment} items={items}
            album={album} captures={captureActions}
          />
        </div>
      </main>

      <section id="characters-view" hidden={view !== "characters"}>
        <header className="view-head">
          <h1>Characters</h1>
          <div className="sub" id="characters-meta">{rosterMeta}</div>
        </header>
        <Characters profiles={profiles} onOpenSegment={openSegment} items={items} />
      </section>

      <section id="details-view" hidden={view !== "details"}>
        <header className="view-head">
          <h1>Details</h1>
          <div className="sub">Every segment on its own row. Click a column to sort, a row to
            open it.</div>
        </header>
        <Details segments={segments} onOpenSegment={openSegment} items={items} />
      </section>

      <section id="query-view" hidden={view !== "query"}>
        <QueryView
          visible={view === "query"}
          actions={{
            run: desktop.runQuery,
            schema: desktop.querySchema,
            onError: message,
          }}
        />
      </section>

      <section id="transmog-view" hidden={view !== "transmog"}>
        <TransmogView
          payload={transmog}
          status={transmogStatus}
          loadSet={desktop.transmogSetItems}
          loadAppearances={desktop.transmogAppearances}
          loadIcons={desktop.gameIcons}
          loadCharacter={desktop.characterModel}
          loadWorn={desktop.wornSet}
          loadGallery={desktop.galleryModels}
          marks={{
            payload: marks,
            setFavourite: desktop.setTransmogFavourite,
            setTag: desktop.setTransmogTag,
            deleteTag: desktop.deleteTransmogTag,
            // Every write answers with every mark, so the browsers repaint from what was
            // stored — the same rule the activity and capture edits follow.
            onApply: setMarks,
            onError: message,
          }}
          custom={{
            payload: customSets,
            save: desktop.saveCustomSet,
            remove: desktop.deleteCustomSet,
            // Every write answers with every saved set, for the reason above it.
            onApply: setCustomSets,
            onError: message,
          }}
        />
      </section>

      <section id="settings-view" hidden={view !== "settings"}>
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
        holdings={payload.holdings}
        album={album}
        captures={captureActions}
        onStep={(by) => setShowing((was) => {
          if (!was) return was;
          const next = was.index + by;
          return next < 0 || next >= was.order.length ? was : { ...was, index: next };
        })}
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
const LOADING = "Reading the game's transmog tables…";

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
  if (globalThis.__Chronie_E2E__) return;
  setTimeout(() => window.location.reload(), after);
};
