/**
 * The screenshots of a segment or of an evening: a grid of them, and the one somebody opened.
 *
 * Two rules shape all of it. Thumbnails in the grid and the full picture only in the viewer,
 * because a grid of full-size screenshots is tens of megabytes of decoded pixels in a webview
 * and it would be paid again on every repaint. And a tile with no picture is a tile that says
 * why — an entry that asked for no screenshot and a marker whose file was never found are two
 * different things to be told, and neither of them is a broken image.
 *
 * Everything the reader can change goes through the backend and comes back as a whole
 * dashboard, the way an activity edit does, so what ends up on screen is what was stored.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  captureFacts, captureSummary, captureTip, captureTitle, capturedMoments, deleteWarning,
  missingReason, noteChanged, thumbnailIds,
} from "./captures";
import type { CaptureAlbum, CapturedMoment } from "./captures";
import { clock } from "./format";
import type { CaptureImagePayload, DashboardPayload, Segment } from "./types";

/** Everything the gallery needs a backend for. Injected, so it is drivable without one. */
export interface CaptureActions {
  /** Asks for one capture at the size it was taken. */
  loadImage: (captureId: number) => Promise<CaptureImagePayload>;
  /** Writes what somebody said about it; empty clears it. Answers with the whole dashboard. */
  setNote: (captureId: number, note: string) => Promise<DashboardPayload>;
  /** Deletes the entry and the file together. Answers with the whole dashboard. */
  remove: (captureId: number) => Promise<DashboardPayload>;
  onApply: (payload: DashboardPayload) => void;
  onError: (error: unknown) => string;
}

export interface CaptureGalleryProps {
  /** The segments whose captures are being shown: one for a segment, an evening's for a session. */
  segments: Segment[];
  album: CaptureAlbum;
  actions: CaptureActions;
}

/**
 * The pictures belonging to a set of segments, and the viewer over them.
 *
 * Draws nothing at all when there are none, so a caller can drop it into a modal without
 * having to ask first — a segment nobody photographed should not grow an empty heading.
 */
export function CaptureGallery({ segments, album, actions }: CaptureGalleryProps): ReactNode {
  const moments = capturedMoments(segments);
  const [open, setOpen] = useState<string | null>(null);
  // The album is a cache outside React — shared with every other grid the reader opens — so a
  // thumbnail landing has nothing to change that React would notice by itself.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const wanted = thumbnailIds(moments).join(",");
  useEffect(() => {
    const ids = wanted ? wanted.split(",").map(Number) : [];
    // Asking again costs nothing: the album keeps what it has been handed and what it has
    // already asked about, so a repeat is filtered to nothing before it reaches a backend.
    if (ids.length) void album.learn(ids, redraw);
  }, [wanted, album]);

  if (!moments.length) return null;

  // The source id rather than the row id, because a delete repaints the grid and a row id can
  // be reused by the next capture ingested; the addon's own id never is.
  const index = moments.findIndex(({ capture }) => capture.sourceId === open);

  return (
    <div className="captures">
      <ul className="capture-grid">
        {moments.map((moment) => (
          <li key={moment.capture.sourceId}>
            <CaptureTile
              moment={moment}
              thumbnail={album.thumbnail(moment.capture.id)}
              onOpen={() => setOpen(moment.capture.sourceId)}
            />
          </li>
        ))}
      </ul>
      {/* Mounted only while something is open, because more than one grid can be on screen at
          once — an evening unfolded on its card, and a segment's own in the modal over it —
          and two dialogs answering to one id is one id too many. */}
      {index >= 0 ? <CaptureViewer
        moment={moments[index]}
        index={index}
        count={moments.length}
        actions={actions}
        onStep={(by) => {
          const next = moments[index + by];
          if (next) setOpen(next.capture.sourceId);
        }}
        onClose={() => setOpen(null)}
        onDeleted={(captureId) => {
          album.forget(captureId);
          setOpen(null);
        }}
      /> : null}
    </div>
  );
}

interface TileProps {
  moment: CapturedMoment;
  thumbnail?: string;
  onOpen: () => void;
}

/**
 * One picture as a tile, or the reason there is none.
 *
 * The button is named for the moment and the place rather than "screenshot 3 of 8", because
 * that is what a reader is looking for and it is the only thing a screen reader will read.
 * The picture itself carries no alternative text: the tile already says what it is beside it,
 * and a second announcement would have every tile read twice.
 */
function CaptureTile({ moment, thumbnail, onOpen }: TileProps): ReactNode {
  const { capture, segment } = moment;
  const missing = missingReason(capture);
  const note = capture.note || "";
  return (
    <button
      type="button" className="capture-tile" onClick={onOpen}
      aria-label={`Open the screenshot from ${segment.instance} at ${clock(capture.at)}`}
      data-tip={captureTip(moment)}
    >
      <span className="capture-thumb" data-state={missing ? "missing" : "stored"}>
        {thumbnail
          ? <img src={thumbnail} alt="" />
          : <span className="capture-placeholder" aria-hidden="true">{missing ? "🚫" : "🖼️"}</span>}
      </span>
      <span className="capture-caption">
        <span className="capture-when">{captureTitle(moment)}</span>
        {note
          ? <span className="capture-note">{note}</span>
          : <span className="capture-where muted">{missing ?? segment.instance}</span>}
      </span>
    </button>
  );
}

interface ViewerProps {
  /** The one that is open. The viewer is not mounted at all when none is. */
  moment: CapturedMoment;
  /** Where it sits in the grid it was opened from, and how long that grid is. */
  index: number;
  count: number;
  actions: CaptureActions;
  onStep: (by: number) => void;
  onClose: () => void;
  onDeleted: (captureId: number) => void;
}

/**
 * One screenshot at the size it was taken, with the note under it and the way to delete it.
 *
 * The picture is asked for when it is opened and not before — it is a few megabytes, and the
 * grid above it has already shown what is in it. Stepping to the next one asks again, which is
 * what keeps a window holding one screenshot rather than an evening's worth.
 *
 * The note is a field the reader types into and a value the backend owns, which is the awkward
 * pair every editor has. It is held here while it is being typed, and put back from the stored
 * capture whenever a different picture is opened — so an edit somebody abandoned by stepping
 * away does not follow them onto the next one.
 */
function CaptureViewer(
  { moment, index, count, actions, onStep, onClose, onDeleted }: ViewerProps,
): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const capture = moment.capture;
  const [image, setImage] = useState<CaptureImagePayload | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);

  // `showModal` is the dialog's own state and React has no prop for it, so the element is
  // driven here, once, as it mounts. The reverse direction is `onClose`: Escape closes a dialog
  // without asking anybody, and the grid behind has to find out.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const { sourceId, id: captureId, note: stored } = capture;
  useEffect(() => {
    setTyped(stored || "");
    setStatus("");
    setConfirming(false);
  // Keyed on which capture is open rather than on the note: a repaint carrying the note that
  // was just written must not reach in and rewrite what somebody has started typing since.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  useEffect(() => {
    setImage(null);
    let current = true;
    void actions.loadImage(captureId)
      .then((payload) => { if (current) setImage(payload); })
      .catch((error: unknown) => { if (current) setStatus(actions.onError(error)); });
    return () => { current = false; };
  }, [captureId, actions]);

  const write = useCallback(async (run: () => Promise<DashboardPayload>): Promise<boolean> => {
    setBusy(true);
    setStatus("");
    try {
      actions.onApply(await run());
      return true;
    } catch (error) {
      setStatus(actions.onError(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [actions]);

  const missing = missingReason(capture);
  const shown = image?.image ?? null;
  // The row's own size, or what the file actually turned out to be once it was read. They
  // differ only when the file has been replaced under the row, and then the second is the one
  // worth showing because it describes what is on screen.
  const size = image?.byteSize ?? capture.byteSize ?? 0;
  const facts = captureFacts({ ...moment, capture: { ...capture, byteSize: size || null } });

  return (
    <dialog
      id="capture-viewer" aria-labelledby="capture-viewer-title" ref={dialog} onClose={onClose}
      onKeyDown={(event) => {
        // Only while nothing is being typed into: the arrow keys belong to the field the
        // moment somebody is in it, and stepping away mid-sentence would lose the sentence.
        if (event.target instanceof HTMLTextAreaElement) return;
        if (event.key === "ArrowLeft") onStep(-1);
        if (event.key === "ArrowRight") onStep(1);
      }}
    >
      <div className="detail-head">
        <div>
          <h2 className="detail-title" id="capture-viewer-title">{moment.segment.instance}</h2>
          <span className="detail-position">{index + 1} of {count}</span>
        </div>
        <div className="detail-nav">
          <button
            type="button" aria-label="Previous screenshot"
            disabled={index === 0} onClick={() => onStep(-1)}
          >‹</button>
          <button
            type="button" aria-label="Next screenshot"
            disabled={index >= count - 1} onClick={() => onStep(1)}
          >›</button>
          <button type="button" aria-label="Close screenshot" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="detail-body">
        <div className="capture-full" data-state={shown ? "shown" : missing ? "missing" : "loading"}>
          {shown
            ? <img src={shown} alt={`Screenshot from ${moment.segment.instance}`} />
            : <p className="muted">
              {missing ?? (image
                // A row that says the file is there and a file that is not: the row carries a
                // hash and a size precisely so this is detectable and can be said out loud
                // rather than appearing as a picture that never loads.
                ? "Chronie's copy of this picture is no longer on disk."
                : "Opening the picture…")}
            </p>}
        </div>
        <p className="detail-facts">{facts.join(" · ")}</p>
        <div className="capture-note-edit">
          <label htmlFor="capture-note">Note</label>
          <textarea
            id="capture-note" rows={2} value={typed} disabled={busy}
            placeholder="What was happening?"
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className="dialog-actions">
            <button
              type="button" className="primary" disabled={busy || !noteChanged(capture, typed)}
              onClick={() => void write(() => actions.setNote(capture.id, typed))}
            >Save note</button>
            <button
              type="button" disabled={busy || !capture.note}
              onClick={() => {
                setTyped("");
                void write(() => actions.setNote(capture.id, ""));
              }}
            >Clear note</button>
            <span className="spacer" />
            {confirming
              ? <>
                <button
                  type="button" className="danger" disabled={busy}
                  onClick={() => void write(() => actions.remove(capture.id))
                    .then((done) => { if (done) onDeleted(capture.id); })}
                >Yes, delete it</button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </>
              : <button type="button" className="danger" onClick={() => setConfirming(true)}>
                Delete
              </button>}
          </div>
          {confirming ? <p className="capture-warning" role="alert">{deleteWarning(capture)}</p> : null}
          {status ? <p className="capture-status" role="status">{status}</p> : null}
        </div>
      </div>
    </dialog>
  );
}

/**
 * A fold that says how many pictures there are before it draws any of them.
 *
 * The timeline's own idiom: nothing on that page is a list until somebody has asked for a
 * list, and an evening's screenshots are the largest thing a session card could grow.
 */
export function CaptureFold(
  { segments, album, actions, open, onToggle }:
  CaptureGalleryProps & { open: boolean; onToggle: () => void },
): ReactNode {
  const moments = capturedMoments(segments);
  if (!moments.length) return null;
  return <>
    <button type="button" className="session-toggle" aria-expanded={open} onClick={onToggle}>
      <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      📷 {captureSummary(moments)}
    </button>
    {open ? <CaptureGallery segments={segments} album={album} actions={actions} /> : null}
  </>;
}
