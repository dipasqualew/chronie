/**
 * Correcting what Chronie guessed a segment was.
 *
 * Activities are the one thing on a segment the user writes rather than the game, so this is
 * the one dialog that writes. Every write goes to the backend and comes back as a whole
 * dashboard, which the window then repaints from — so what is on screen is always what was
 * stored, never what the page hoped a write did.
 *
 * A row's fields are held as the raw strings the reader typed rather than as parsed metadata,
 * because half a number is not a number: parsing on every keystroke would empty the box under
 * somebody typing a minus sign. They are parsed once, on the way out.
 */

import "./activityEditor.css";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { activityFields, activityLabel, parseMetadata } from "./activities";
import type { ActivityField } from "./activities";
import { useModalDialog } from "./dialog";
import { duration } from "./format";
import type { ActivityMetadata, DashboardPayload, Segment } from "./types";

/** One row of the editor, whether or not it stands for something already stored. */
interface EditorRow {
  /** Keys the row. A row the user has just added carries a negative draft id. */
  rowId: number;
  /** Absent until the row has been stored, which is what tells an add from an update. */
  id?: number;
  kind: string;
  /** The field boxes as typed, keyed by field key. */
  values: Record<string, string>;
  dirty: boolean;
}

export interface ActivityEditorActions {
  add: (segmentId: number, kind: string, metadata: ActivityMetadata) => Promise<DashboardPayload>;
  update: (
    activityId: number,
    kind: string,
    metadata: ActivityMetadata,
  ) => Promise<DashboardPayload>;
  remove: (activityId: number) => Promise<DashboardPayload>;
  reset: (segmentId: number) => Promise<DashboardPayload>;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

export interface ActivityEditorProps {
  /** The segment being edited, or null when the dialog is closed. */
  segment: Segment | null;
  /**
   * The kinds to offer: the ones the backend can guess at, plus any the user has already
   * invented, so the picker offers what this history actually contains rather than only what
   * the app ships with.
   */
  knownKinds: string[];
  actions: ActivityEditorActions;
  onApply: (payload: DashboardPayload) => void;
  onClose: () => void;
}

/** What a stored activity's metadata looks like in the boxes. */
function rawValues(metadata: ActivityMetadata): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "boolean" ? (value ? "yes" : "no") : String(value),
    ]),
  );
}

const rowsOf = (segment: Segment | null): EditorRow[] =>
  (segment?.activities || []).map((activity) => ({
    rowId: activity.id,
    id: activity.id,
    kind: activity.kind,
    values: rawValues(activity.metadata || {}),
    dirty: false,
  }));

export function ActivityEditor({
  segment,
  knownKinds,
  actions,
  onApply,
  onClose,
}: ActivityEditorProps): ReactNode {
  // `showModal` rather than the `open` attribute, and not only for the backdrop: this dialog is
  // opened from on top of the segment detail, which is itself modal. A dialog that is merely open
  // sits below the top layer, which would leave this one behind that one's backdrop — on screen,
  // and unreachable. React has no prop for `showModal`, so the element is driven from an effect;
  // `dialog.ts` is where that lives.
  const dialog = useModalDialog(segment !== null);

  return (
    <dialog
      id="activity-editor"
      aria-labelledby="activity-editor-title"
      ref={dialog}
      onClose={onClose}
    >
      {segment ? (
        <EditorBody
          segment={segment}
          knownKinds={knownKinds}
          actions={actions}
          onApply={onApply}
          onClose={onClose}
        />
      ) : null}
    </dialog>
  );
}

function EditorBody({
  segment,
  knownKinds,
  actions,
  onApply,
  onClose,
}: ActivityEditorProps & { segment: Segment }): ReactNode {
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [saying, setSaying] = useState("");
  const [draftSequence, setDraftSequence] = useState(0);

  // Rows are read back from whatever the backend last answered with, so a delete or a reset
  // leaves the editor showing what is stored rather than what was on screen before it.
  useEffect(() => {
    setRows(rowsOf(segment));
    setSaying("");
  }, [segment]);

  const edit = (rowId: number, change: (row: EditorRow) => EditorRow): void =>
    setRows((was) => was.map((row) => (row.rowId === rowId ? change(row) : row)));

  async function run(action: () => Promise<void>): Promise<void> {
    setSaying("");
    try {
      await action();
    } catch (error) {
      setSaying(actions.onError(error));
    }
  }

  function removeRow(row: EditorRow): void {
    // A draft the user added and changed their mind about was never stored, so it is simply
    // forgotten; anything else has to be deleted where it lives.
    if (row.id === undefined) {
      setRows((was) => was.filter((entry) => entry.rowId !== row.rowId));
      return;
    }
    const activityId = row.id;
    void run(async () => onApply(await actions.remove(activityId)));
  }

  /** Saves every row the user actually touched, then hands each answer back to be repainted. */
  async function save(): Promise<void> {
    for (const row of rows) {
      if (!row.dirty) continue;
      const metadata = parseMetadata(row.kind, row.values);
      onApply(
        row.id === undefined
          ? await actions.add(segment.segmentId, row.kind, metadata)
          : await actions.update(row.id, row.kind, metadata),
      );
    }
  }

  const kinds = (selected: string): string[] =>
    [...new Set([...knownKinds, selected].filter(Boolean))].sort();

  return (
    <form method="dialog" className="dialog-body">
      <h2 id="activity-editor-title">Activities — {segment.instance}</h2>
      <div className="sub" id="activity-editor-sub">
        {segment.character} · {segment.day} · {duration(segment.seconds)}
      </div>
      <div className="editor-list" id="activity-editor-list">
        {rows.length ? (
          rows.map((row) => (
            <div className="editor-row" key={row.rowId}>
              <div className="row-head">
                <select
                  aria-label="Activity kind"
                  value={row.kind}
                  onChange={(event) =>
                    edit(row.rowId, (was) => ({ ...was, kind: event.target.value, dirty: true }))
                  }
                >
                  {kinds(row.kind).map((kind) => (
                    <option key={kind} value={kind}>
                      {activityLabel(kind)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${activityLabel(row.kind)}`}
                  onClick={() => removeRow(row)}
                >
                  Remove
                </button>
              </div>
              <div className="editor-fields">
                {activityFields(row.kind).length ? (
                  activityFields(row.kind).map((field) => (
                    <Field
                      key={field.key}
                      row={row}
                      field={field}
                      onChange={(value) =>
                        edit(row.rowId, (was) => ({
                          ...was,
                          values: { ...was.values, [field.key]: value },
                          dirty: true,
                        }))
                      }
                    />
                  ))
                ) : (
                  <span className="muted">
                    Chronie has no fields for this kind; it will be saved by name.
                  </span>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="muted">No activities on this segment yet.</div>
        )}
      </div>
      <p className="status" id="activity-editor-status" role="status">
        {saying}
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          id="activity-add"
          onClick={() => {
            const rowId = draftSequence - 1;
            setDraftSequence(rowId);
            setRows((was) => [
              ...was,
              {
                rowId,
                kind: knownKinds[0] || "mythic_plus",
                values: {},
                dirty: true,
              },
            ]);
          }}
        >
          Add activity
        </button>
        <button
          type="button"
          id="activity-reset"
          onClick={() => void run(async () => onApply(await actions.reset(segment.segmentId)))}
        >
          Reset to guesses
        </button>
        <button
          type="button"
          id="activity-close"
          className="primary spacer"
          onClick={() =>
            void run(async () => {
              await save();
              onClose();
            })
          }
        >
          Done
        </button>
      </div>
    </form>
  );
}

/**
 * One field of one row.
 *
 * The label sits beside its control rather than wrapping it: a wrapping label takes its
 * accessible name from its whole text content, which for a select would swallow every option
 * ("Beat the timer UnknownYesNo") and leave the field unaddressable by its name.
 *
 * Booleans use a three-way select — yes, no, and an empty "unknown" — so an unset flag stays
 * unset instead of defaulting to false.
 */
function Field({
  row,
  field,
  onChange,
}: {
  row: EditorRow;
  field: ActivityField;
  onChange: (value: string) => void;
}): ReactNode {
  const id = `field-${row.rowId}-${field.key}`;
  const value = row.values[field.key] ?? "";
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      {field.type === "boolean" ? (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Unknown</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      ) : (
        <input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
