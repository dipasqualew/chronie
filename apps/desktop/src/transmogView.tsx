/**
 * The transmog view: every set the installed game knows about, and the character wearing what
 * you have picked out of them.
 *
 * Two halves that do not move. On the left the sets, filtered by name and by everything else
 * the game says about them, each one opening in place to show what it is made of. On the right
 * the character, dressed in whatever has been clicked, and the list of what that is. Neither
 * covers the other, which is the point: an outfit is assembled out of several sets — a helm
 * from one and a robe from another — and a dialog that had to be closed to reach the second
 * set made that the hard way round.
 *
 * `transmog.ts` decides how sets group and filter, `outfit.ts` decides what goes where, and
 * `outfitPanel.tsx` draws the body. This is the browsing over them.
 *
 * Two things about the left half are worth saying plainly, because both were the other way
 * round once. **A row's whole width puts the piece on**, and Wowhead is an icon at the end of
 * it: dressing the character is the errand, and leaving the app is the exception. And **the
 * rows with nowhere to go are hidden** until the checkbox above them says otherwise — see
 * `onlyWearable`, and the count each set gives of what it left out.
 *
 * The list costs a second and a few hundred megabytes to read out of the game's own files, so
 * it arrives after the window has opened — which is why this view has a loading line and a
 * failure to draw, and no other one does.
 */

import { useCallback, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import { wearable as canBeWorn } from "./modelPreview";
import {
  NOTHING_ON, isWorn, onlyWearable, takeOff, toggle as toggleWorn, wearSet, wearable,
} from "./outfit";
import type { Outfit } from "./outfit";
import { OutfitPanel } from "./outfitPanel";
import { CLASSES, classLabel, classNames, expansionName, filterSets, groupSets, patchName } from "./transmog";
import { appearanceRows, appearanceSummary, iconIds } from "./transmogModal";
import type { AppearanceRow } from "./transmogModal";
import type { ModelStage } from "./modelViewer";
import type {
  CharacterModelPayload,
  IconsPayload,
  TransmogPayload,
  TransmogSet,
  TransmogSetItemsPayload,
  WornPiece,
  WornSetPayload,
} from "./types";

export interface TransmogViewProps {
  /** The loaded sets, or null while they are still being read out of the game. */
  payload: TransmogPayload | null;
  /** What the view says instead, when there is no payload: reading, or why there is not. */
  status: string;
  /** Asks the backend what a set is made of, when a reader opens one. */
  loadSet: (setId: number) => Promise<TransmogSetItemsPayload>;
  /** Asks the backend for the pictures those rows need, decoded out of the game's textures. */
  loadIcons: (iconFileDataIds: number[]) => Promise<IconsPayload>;
  /** Passed through to the panel: the bare body, and the body wearing the whole outfit. */
  loadCharacter: () => Promise<CharacterModelPayload>;
  loadWorn: (pieces: WornPiece[]) => Promise<WornSetPayload>;
  /** Passed through too — it is the one thing here that needs a graphics card. */
  createStage?: (container: HTMLElement) => ModelStage | Promise<ModelStage>;
}

export function TransmogView(
  { payload, status, loadSet, loadIcons, loadCharacter, loadWorn, createStage }: TransmogViewProps,
): ReactNode {
  const [search, setSearch] = useState("");
  const [expansion, setExpansion] = useState("");
  const [klass, setKlass] = useState("");
  const [outfit, setOutfit] = useState<Outfit>(NOTHING_ON);
  /**
   * Whether the rows nothing can be done with are left out, which they are until a reader says
   * otherwise. See [`onlyWearable`]: they are a disabled button and an apology, and a reader
   * clicking down a set to dress a character has no use for either.
   */
  const [hideUnwearable, setHideUnwearable] = useState(true);
  /** The sets a reader has opened, which stay open: comparing two of them is the ordinary use. */
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

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
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  /**
   * Reads what a set is made of, and then the pictures its rows are waiting on.
   *
   * The rows are worth drawing before the icons arrive — decoding a set's worth of textures
   * takes longer than reading the tables that named them — so this is two steps that redraw
   * separately rather than one that waits for both.
   */
  const read = useCallback((setId: number): void => {
    if (asked.has(setId)) return;
    asked.add(setId);
    void loadSet(setId)
      .then((answer) => {
        known.set(setId, answer);
        redraw();
        const wanted = iconIds(answer).filter((id) => !icons.has(id));
        if (!wanted.length) return;
        return loadIcons(wanted).then((pictures) => {
          for (const [id, url] of Object.entries(pictures.icons || {})) icons.set(Number(id), url);
          redraw();
        });
      })
      // An icon is the one thing on a row that can be missing without the row losing its point,
      // so a picture that will not come stays an empty frame. A set that will not come is worth
      // saying, because the reader clicked to see what was in it.
      .catch((error: unknown) => {
        if (!known.has(setId)) known.set(setId, message(error));
        redraw();
      });
  }, [loadSet, loadIcons, known, icons, asked]);

  const openSet = useCallback((set: TransmogSet): void => {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(set.id)) next.delete(set.id);
      else {
        next.add(set.id);
        read(set.id);
      }
      return next;
    });
  }, [read]);

  const sets = payload ? filterSets(payload.sets, { search, expansion, klass }) : [];
  // Only offer the expansions this install actually has sets for.
  const expansions = payload
    ? [...new Set(payload.sets.map((set) => set.expansionId))].sort((a, b) => b - a)
    : [];
  const withheld = payload && payload.withheldCount > 0
    ? ` · ${plural(payload.withheldCount, "set")} the game keeps encrypted`
    : "";

  return <>
    <header className="view-head">
      <h1>Transmog</h1>
      <div className="sub" id="transmog-meta">
        {payload
          ? `${plural(payload.sets.length, "set")} from the installed game${withheld}`
          : status}
      </div>
    </header>
    <div className="mog-layout">
      <section className="panel mog-browser">
        <div className="table-head">
          <div className="controls">
            <input
              id="transmog-search" type="search" placeholder="Filter by name, class, expansion…"
              aria-label="Filter transmog sets" value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              id="transmog-expansion" aria-label="Expansion" value={expansion}
              onChange={(event) => setExpansion(event.target.value)}
            >
              <option value="">All expansions</option>
              {expansions.map((id) => <option key={id} value={id}>{expansionName(id)}</option>)}
            </select>
            <select
              id="transmog-class" aria-label="Class" value={klass}
              onChange={(event) => setKlass(event.target.value)}
            >
              <option value="">All classes</option>
              {CLASSES.map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>
            {/* Applies to every set at once rather than to the one being read, because it is a
                statement about what a reader is here for and not about a particular set. */}
            <label className="mog-hide">
              <input
                type="checkbox" id="transmog-hide-unwearable" checked={hideUnwearable}
                onChange={(event) => setHideUnwearable(event.target.checked)}
              />
              Hide what she cannot wear
            </label>
            <span className="count" id="transmog-count">
              {payload ? `${plural(sets.length, "set")} shown` : ""}
            </span>
          </div>
        </div>
        <div id="transmog-list" className="mog-list">
          {groupSets(sets).map((group) => (
            <section className="mog-group" key={group.group}>
              <h3>{group.group}<span className="muted"> · {plural(group.sets.length, "set")}</span></h3>
              <div className="mog-grid">
                {group.sets.map((set) => (
                  <Card
                    key={set.id} set={set} open={open.has(set.id)} onToggle={() => openSet(set)}
                    contents={known.get(set.id)} icons={icons} outfit={outfit}
                    hideUnwearable={hideUnwearable}
                    onWear={(row) => setOutfit((was) => toggleWorn(was, row, set))}
                    onWearAll={(rows) => setOutfit((was) => wearSet(was, rows, set))}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="empty" id="transmog-empty" hidden={!payload || sets.length > 0}>
          <p className="empty-title">Nothing matches</p>
          <p>Try a different search, class or expansion.</p>
        </div>
      </section>
      <OutfitPanel
        outfit={outfit} icons={icons} createStage={createStage}
        loadCharacter={loadCharacter} loadWorn={loadWorn}
        onTakeOff={(place) => setOutfit((was) => takeOff(was, place))}
        onClearAll={() => setOutfit(NOTHING_ON)}
      />
    </div>
  </>;
}

/**
 * One set: what it is, and — once opened — what it is made of.
 *
 * Opening happens in place rather than in a dialog, which is what lets a reader keep two sets
 * open and take a piece out of each. The card is a heading and a button because a heading
 * cannot live inside a button.
 */
function Card(
  { set, open, onToggle, contents, icons, outfit, hideUnwearable, onWear, onWearAll }: {
    set: TransmogSet;
    open: boolean;
    onToggle: () => void;
    /** What the set holds, the sentence saying why it could not be read, or nothing yet. */
    contents: TransmogSetItemsPayload | string | undefined;
    icons: Map<number, string>;
    outfit: Outfit;
    /** Whether the rows with nowhere to go are left out, which the browser decides for all. */
    hideUnwearable: boolean;
    onWear: (row: AppearanceRow) => void;
    onWearAll: (rows: AppearanceRow[]) => void;
  },
): ReactNode {
  const patch = patchName(set.patchIntroduced);
  const classes = classNames(set.classMask);
  const rows = typeof contents === "object" ? appearanceRows(contents) : [];
  // Whatever is hidden is still worn by "wear all of", because that puts the set on rather
  // than what happens to be listed, and it is still counted below so nothing goes quietly.
  const shown = hideUnwearable ? onlyWearable(rows) : rows;
  const hidden = rows.length - shown.length;
  const name = set.name || "Unnamed set";

  return (
    <article
      className="mog-card" data-open={open}
      title={classes.length ? classes.join(", ") : undefined}
    >
      <h4>
        <button type="button" className="mog-open" aria-expanded={open} onClick={onToggle}>
          {name}
        </button>
      </h4>
      <div className="mog-facts">
        <span className="chip">{classLabel(set.classMask)}</span>
        <span className="chip">{expansionName(set.expansionId)}</span>
        {patch ? <span className="chip">Patch {patch}</span> : null}
      </div>
      <div className="mog-foot">
        <span>{plural(set.itemCount, "appearance")}</span>
        <span className="muted">#{set.id}</span>
      </div>
      {open ? <div className="mog-contents">
        {contents === undefined ? <p className="muted">Reading what the set is made of…</p> : null}
        {typeof contents === "string" ? <p className="muted">{contents}</p> : null}
        {typeof contents === "object" ? <>
          <div className="mog-contents-head">
            {/* The summary only when it says something the card above does not. The card
                already counts the set's appearances, so repeating that count under it is
                noise — what is worth saying is that some of them cannot be read, or that the
                list came out a different length from what the set promised. */}
            {contents.withheldCount > 0 || rows.length !== set.itemCount
              ? <p className="detail-facts">{appearanceSummary(contents)}</p>
              : null}
            {/* Hidden rather than absent: the count on the card includes them, and a list
                shorter than it promised is what a reader would otherwise have to explain. */}
            {hidden
              ? <p className="detail-facts muted">
                {`${plural(hidden, "appearance")} hidden, with nowhere on her to go`}
              </p>
              : null}
            {/* A set is a set of clothes and seeing all of it at once is the ordinary thing to
                want; clicking twelve rows to get there is not. */}
            {rows.some((row) => wearable(row))
              ? <button type="button" className="mog-wear-all" onClick={() => onWearAll(rows)}>
                {`Wear all of ${name}`}
              </button>
              : null}
          </div>
          <ul className="mog-items">
            {shown.map((row, index) => (
              <Line
                key={`${row.appearanceId}-${index}`} row={row} worn={isWorn(outfit, row)}
                icon={icons.get(row.iconFileDataId)} onWear={() => onWear(row)}
              />
            ))}
          </ul>
        </> : null}
      </div> : null}
    </article>
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
function Line(
  { row, worn, icon, onWear }:
  { row: AppearanceRow; worn: boolean; icon?: string; onWear: () => void },
): ReactNode {
  const wanted = canBeWorn(row);
  const canWear = wanted.kind === "worn";

  // An empty frame either way. A row whose appearance names no icon keeps it so the list stays
  // a column of pictures rather than one that indents wherever the game said nothing. The
  // picture is decorative: the row already says which slot it is and which item it came from.
  return (
    <li className="mog-item" data-worn={worn}>
      <button
        type="button" className="mog-pick" aria-pressed={worn} disabled={!canWear}
        aria-label={`Wear ${row.slot}: ${row.label}`} onClick={onWear}
      >
        <span className="mog-icon">{icon ? <img src={icon} alt="" /> : null}</span>
        <span className="badge">{row.slot}</span>
        <span className="mog-name">{row.label}</span>
      </button>
      {worn ? <span className="chip">worn</span> : null}
      {/* A withheld row says so where a name would be, and saying it twice is two elements
          with the same sentence in them rather than one clearer row. */}
      {canWear || row.withheld ? null : <span className="muted">{wanted.note}</span>}
      {/* Nothing to look up for an appearance the game withholds: it has no item behind it. */}
      {row.withheld ? null : (
        <a
          className="mog-wowhead" href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
          target="_blank" rel="noopener noreferrer" title={`${row.label} on Wowhead`}
          aria-label={`${row.label} on Wowhead`}
        ><LinkOut /></a>
      )}
    </li>
  );
}

/**
 * The mark on the link out: a box with an arrow leaving it, drawn rather than written.
 *
 * Drawn because there is nothing to write it with. The window ships no icon font and loads
 * nothing from the network, and the arrows in the fonts it does have are a lottery across
 * machines — so the one glyph this view needs is eleven points of SVG in the markup.
 */
function LinkOut(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5L7.5 8.5" />
      <path d="M12 9.5V13C12 13.3 11.8 13.5 11.5 13.5H3C2.7 13.5 2.5 13.3 2.5 13V4.5C2.5 4.2 2.7 4 3 4H6.5" />
    </svg>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
