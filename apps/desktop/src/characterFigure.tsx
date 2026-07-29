/**
 * The character, wearing one of the sets they saved in the game.
 *
 * The one picture on this page, and it earns its place by answering a question nothing else on
 * it can: *who is this*. A roster row is two initials in a class colour and a profile is a grid
 * of numbers, and neither is how a player recognises their own alt — they recognise the tabard.
 *
 * Three things make it different from every other body this app draws, and all three are the
 * same difference stated at different heights:
 *
 * - **It is drawn on their body, not on the reader's.** Everywhere else a look is being chosen
 *   and is shown on whoever is going to wear it — a person the reader assembled out of fifty-one
 *   bodies and a select per question. Here the wearer is already decided and is not the reader's
 *   invention, so the request carries the character's name and the backend resolves the body.
 *   See `character_worn_set`.
 * - **The clothes are theirs too.** Not a set out of the game's catalogue but one this player put
 *   together at a transmogrifier, read off their own account by the addon.
 * - **Nothing here is a way in to anything.** The transmog view is where a set is opened, taken
 *   apart and worn piece by piece; this is a portrait. Picking another set changes the portrait
 *   and nothing else.
 *
 * The set is read the moment it is chosen, which costs the game's own tables — an in-game set
 * names appearances and nothing else, see `inGameSets.ts` — and the outfit is then one more
 * request for the body wearing it. Both are kept for as long as this character is the one on
 * screen, so flipping between their sets costs nothing the second time.
 */

import "./characterFigure.css";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { WHOLE } from "./gallery";
import type { GalleryStage } from "./galleryStage";
import { Turnable, lazyGalleryStage, useGalleryPaint } from "./galleryTile";
import { appearanceIds, setLabel, wornFrom } from "./inGameSets";
import type { InGameSet, InGameSetAppearancesPayload, WornPiece, WornSetPayload } from "./types";

export interface CharacterFigureProps {
  /** Whose portrait it is, which is also whose body the backend is asked to draw. */
  character: string;
  /** What they saved in game, or null where Chronie has never read this character's wardrobe. */
  sets: InGameSet[] | null;
  /** Asks the game's files what a set's appearances actually are. */
  loadAppearances: (appearanceIds: number[]) => Promise<InGameSetAppearancesPayload>;
  /** Asks for that character wearing them. */
  loadWorn: (character: string, pieces: WornPiece[]) => Promise<WornSetPayload>;
  /** The graphics context the picture is painted through; injected so tests need no WebGL. */
  createGalleryStage?: () => GalleryStage | Promise<GalleryStage>;
}

/** What one set turned out to be worth drawing: the model, or the reason there is none. */
type Portrait =
  { kind: "reading" } | { kind: "drawn"; glb: string } | { kind: "nothing"; note: string };

/** A set with nothing in it is a set the player made and has not filled, and cannot be worn. */
const filled = (sets: InGameSet[] | null): InGameSet[] =>
  (sets ?? []).filter((set) => set.slots.length > 0);

export function CharacterFigure({
  character,
  sets,
  loadAppearances,
  loadWorn,
  createGalleryStage = lazyGalleryStage,
}: CharacterFigureProps): ReactNode {
  const wearable = filled(sets);
  // Held by set id rather than by position, so a sync that adds a set does not silently move
  // the reader onto somebody else's clothes. Null means "whichever is first", which is what a
  // reader who has chosen nothing is looking at.
  const [chosen, setChosen] = useState<number | null>(null);
  const showing = wearable.find((set) => set.id === chosen) ?? wearable[0];

  // What each set came to. Outside React for the reason the set list keeps its own outside it:
  // a cache filling is not a redraw, and the counter below is what says one happened. Keyed by
  // character and set together — the ids are the account's, and two alts' wardrobes are two
  // wardrobes.
  const known = useRef(new Map<string, Portrait>()).current;
  const asked = useRef(new Set<string>()).current;
  const [, redraw] = useState(0);

  const paint = useGalleryPaint(true, createGalleryStage);

  const read = useCallback(
    async (key: string, set: InGameSet): Promise<void> => {
      try {
        const opened = await loadAppearances(appearanceIds(set));
        const pieces = wornFrom(opened.appearances);
        if (!pieces.length) {
          known.set(key, { kind: "nothing", note: NOTHING_TO_WEAR });
          return;
        }
        const worn = await loadWorn(character, pieces);
        known.set(
          key,
          worn.model
            ? { kind: "drawn", glb: worn.model }
            : { kind: "nothing", note: NOTHING_TO_DRAW },
        );
      } catch (error: unknown) {
        // Worth saying, because on a machine with no game installed this is the failure a reader
        // meets on every character — and a blank frame would look like a bug in Chronie rather
        // than like an app that cannot reach the game's files.
        known.set(key, {
          kind: "nothing",
          note: error instanceof Error ? error.message : String(error),
        });
      } finally {
        redraw((count) => count + 1);
      }
    },
    [character, loadAppearances, loadWorn, known],
  );

  const key = showing ? `${character}:${showing.id}` : "";
  useEffect(() => {
    if (!showing || asked.has(key)) return;
    asked.add(key);
    known.set(key, { kind: "reading" });
    void read(key, showing);
  }, [key, showing, read, asked, known]);

  // Chronie has never looked at this character's wardrobe, which is a question this app has not
  // asked rather than one the game answered — so it says nothing at all. See `wardrobeSummary`.
  if (!sets) return null;

  const portrait = known.get(key);
  const name = showing ? setLabel(showing) : "";

  return (
    <figure className="figure" aria-label={`${character}, drawn`}>
      <div className="figure-stage">
        {portrait?.kind === "drawn" ? (
          <Turnable
            // Keyed by the outfit, so moving to another set starts a fresh canvas rather than
            // repainting one that is still holding the last body's bitmap.
            key={key}
            glb={portrait.glb}
            focus={WHOLE}
            label={`${character} wearing ${name}`}
            paint={paint}
          />
        ) : (
          <p className="figure-note muted">
            {portrait?.kind === "nothing" ? portrait.note : figureWait(wearable.length)}
          </p>
        )}
      </div>
      {wearable.length > 1 ? (
        <figcaption className="figure-pick">
          <label htmlFor={`figure-set-${character}`}>Wearing</label>
          <select
            id={`figure-set-${character}`}
            value={showing?.id ?? ""}
            onChange={(event) => setChosen(Number(event.target.value))}
          >
            {wearable.map((set) => (
              <option key={set.id} value={set.id}>
                {setLabel(set)}
              </option>
            ))}
          </select>
        </figcaption>
      ) : wearable.length === 1 ? (
        <figcaption className="figure-pick muted">Wearing {name}</figcaption>
      ) : null}
    </figure>
  );
}

/** What the frame says while there is nothing in it yet, which is two different silences. */
const figureWait = (count: number): string =>
  count
    ? "Dressing the character…"
    : "No transmog sets saved in game, so there is nothing to dress this character in.";

/** Every piece of the set is one the game gives no place on a body. */
const NOTHING_TO_WEAR = "Nothing in this set can be worn on a character.";

/** And the other end: the pieces have places and this install has no model to put in them. */
const NOTHING_TO_DRAW = "This install holds nothing to draw this set on a character with.";
