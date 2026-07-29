/**
 * The star and the tags, on whatever is being marked.
 *
 * One component for both halves of the transmog browser, because a set card and a wardrobe row
 * are marked in exactly the same way and a reader who learns it on one has learned it on the
 * other. What a mark *means* is `marks.ts`; where it is stored is `marks.rs`; this is the
 * handful of controls over it.
 *
 * **Every write goes to the backend and the answer replaces what is on screen.** Nothing here
 * keeps its own copy of a mark and edits it optimistically — the same rule the activity editor
 * and the capture note follow, and for the same reason: a star that lit up and was not stored
 * is a lie the reader has no way to catch. What that costs is a round trip per click, which
 * against a local SQLite file is not a thing anybody can see.
 *
 * The controls are drawn on every row rather than behind a menu, and the form to add a tag is
 * not: a star is one click and worth its width on a list of a hundred, and two text boxes are
 * not. So the star and whatever tags exist are always there, and "+ tag" opens the rest.
 */

import "./marksEditor.css";

import { useState } from "react";
import type { ReactNode } from "react";

import { tagLabel } from "./marks";
import { termText } from "./terms";
import { Star } from "./ui";
import type { MarkSubjectKind, TransmogMark, TransmogMarksPayload } from "./types";

/**
 * The three writes, and where a refusal goes.
 *
 * Each answers with every mark in the database rather than with the one that changed, which is
 * what lets the view repaint from storage — see `collector::transmog_marks`.
 */
export interface MarkActions {
  setFavourite: (
    kind: MarkSubjectKind,
    id: number,
    favourite: boolean,
  ) => Promise<TransmogMarksPayload>;
  setTag: (
    kind: MarkSubjectKind,
    id: number,
    key: string,
    value: string | null,
  ) => Promise<TransmogMarksPayload>;
  deleteTag: (kind: MarkSubjectKind, id: number, key: string) => Promise<TransmogMarksPayload>;
  /** What the whole view does with a fresh payload, which is hold it and redraw. */
  onApply: (payload: TransmogMarksPayload) => void;
  onError: (error: unknown) => string;
}

export interface MarkControlsProps {
  kind: MarkSubjectKind;
  /** The game's own id for the thing — a `TransmogSet.id`, or an `ItemAppearance.id`. */
  id: number;
  /** What has already been said about it, or nothing, which is the ordinary case. */
  mark: TransmogMark | undefined;
  /**
   * What the thing is called, which is only ever used to name the controls.
   *
   * A star with no words on it needs one: "Favourite" alone, repeated down a list of a hundred
   * rows, tells a screen reader's user which button they are on and nothing about which look
   * it belongs to.
   */
  name: string;
  actions: MarkActions;
  /**
   * What the list wants asked of it when a tag is clicked, where it takes terms at all.
   *
   * A tag is a `key: value` and the box above the list reads `key:value`, so the chip is the way
   * in: click "faction: horde" and the list narrows to what carries it, with the term written out
   * in the box where a second one can be added beside it. Absent on a row that is not part of the
   * list being filtered — a look inside an opened set is drawn under a box that filters *sets*,
   * and a chip there that narrowed the grid by its own tag would be answering another question.
   */
  onFilter?: (term: string) => void;
}

/**
 * A subject that cannot be marked at all, which is one the game would not describe.
 *
 * An appearance Blizzard encrypts arrives with an id of zero — every hop of the chain that
 * lands in withheld content reads as nothing — and the backend refuses to store a mark against
 * it. Drawing a star that always fails is worse than drawing none, so the row simply has none.
 */
export function canBeMarked(id: number): boolean {
  return id > 0;
}

export function MarkControls({
  kind,
  id,
  mark,
  name,
  actions,
  onFilter,
}: MarkControlsProps): ReactNode {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState("");

  if (!canBeMarked(id)) return null;

  const favourite = mark?.favourite ?? false;
  const tags = mark?.tags ?? [];

  /** Sends one write and hands what came back to the view, or says why nothing changed. */
  const write = (change: Promise<TransmogMarksPayload>, after?: () => void): void => {
    setFailure("");
    void change
      .then((payload) => {
        actions.onApply(payload);
        after?.();
      })
      .catch((error: unknown) => setFailure(actions.onError(error)));
  };

  return (
    <span className="mark">
      <button
        type="button"
        className="mark-star"
        aria-pressed={favourite}
        // Named by what pressing it would do, so it reads the same whichever state it is in —
        // the pressed state is what says which way round it currently is.
        aria-label={`Favourite ${name}`}
        title={favourite ? `${name} is a favourite` : `Make ${name} a favourite`}
        onClick={() => write(actions.setFavourite(kind, id, !favourite))}
      >
        <Star filled={favourite} />
      </button>
      {tags.map((tag) => (
        <span className="chip mark-tag" key={tag.key.toLowerCase()}>
          {/* In its own element rather than as a bare text node, so that what the tag says
              can be read on its own — the × beside it is part of the chip and not part of
              the sentence. And a button wherever the list beneath can be narrowed by it, which
              is how a reader gets from "I filed six of these under horde" to seeing the six. */}
          {/* "the tag" in the name, because a card carries measured chips that also narrow the
              grid — see `qualitiesChips` — and "filter by brown" out of a grid of cards does
              not say which of the two kinds of thing it is. */}
          {onFilter ? (
            <button
              type="button"
              className="mark-tag-text mark-tag-ask"
              aria-label={`Filter by the tag ${tagLabel(tag)}`}
              title={`Filter by the tag ${tagLabel(tag)}`}
              onClick={() => onFilter(termText(tag.key, tag.value))}
            >
              {tagLabel(tag)}
            </button>
          ) : (
            <span className="mark-tag-text">{tagLabel(tag)}</span>
          )}
          <button
            type="button"
            className="mark-drop"
            aria-label={`Remove the tag ${tagLabel(tag)} from ${name}`}
            onClick={() => write(actions.deleteTag(kind, id, tag.key))}
          >
            {"×"}
          </button>
        </span>
      ))}
      <button
        type="button"
        className="mark-open"
        aria-expanded={adding}
        aria-label={`Tag ${name}`}
        onClick={() => setAdding((was) => !was)}
      >
        + tag
      </button>
      {adding ? (
        <form
          className="mark-form"
          onSubmit={(event) => {
            event.preventDefault();
            // The backend cleans and refuses; this only avoids sending a form nobody filled
            // in, which would otherwise answer "A tag needs a name." for a stray Enter.
            if (!key.trim()) return;
            write(actions.setTag(kind, id, key, value || null), () => {
              setKey("");
              setValue("");
              setAdding(false);
            });
          }}
        >
          <input
            className="mark-key"
            type="text"
            value={key}
            autoFocus
            aria-label={`Tag name for ${name}`}
            placeholder="wishlist"
            onChange={(event) => setKey(event.target.value)}
          />
          {/* Optional, and said so on the box rather than in a note under it: a tag with
              nothing here is a label, which is half of what this feature is. */}
          <input
            className="mark-value"
            type="text"
            value={value}
            aria-label={`Tag value for ${name} (optional)`}
            placeholder="value, or leave empty"
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit" className="mark-save">
            Add
          </button>
        </form>
      ) : null}
      {failure ? (
        <span className="mark-failure" role="alert">
          {failure}
        </span>
      ) : null}
    </span>
  );
}

export interface MarkFiltersProps {
  /** Namespaces the ids, because both browsers draw one of these at the same time. */
  scope: string;
  favourite: boolean;
  onFavourite: (only: boolean) => void;
  tag: string;
  onTag: (token: string) => void;
  /** Every tag in use against this kind of subject — see `tagChoices`. */
  choices: Array<{ token: string; label: string }>;
}

/**
 * The two controls that narrow a browser to what the reader themselves said about it.
 *
 * A checkbox and a picker, beside the filters that read the game — because from the reader's
 * side "plate, Cataclysm, starred" is one question and not two, and putting their own marks
 * somewhere else on the screen would make it two.
 *
 * The picker is absent entirely until there is something in it. An empty dropdown offering
 * only "Any tag" is a control that cannot do anything, and every install starts with one.
 */
export function MarkFilters({
  scope,
  favourite,
  onFavourite,
  tag,
  onTag,
  choices,
}: MarkFiltersProps): ReactNode {
  return (
    <>
      <label className="mog-hide">
        <input
          type="checkbox"
          id={`${scope}-favourites`}
          checked={favourite}
          onChange={(event) => onFavourite(event.target.checked)}
        />
        Favourites only
      </label>
      {choices.length ? (
        <select
          id={`${scope}-tag`}
          aria-label="Tag"
          value={tag}
          onChange={(event) => onTag(event.target.value)}
        >
          <option value="">Any tag</option>
          {choices.map((choice) => (
            <option key={choice.token} value={choice.token}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : null}
    </>
  );
}
