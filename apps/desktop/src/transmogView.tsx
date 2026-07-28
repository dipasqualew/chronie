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
 * The left half browses **two ways**, and the switch between them is the one control above
 * both. Sets are what somebody at Blizzard put together; items are the game's whole wardrobe
 * cut by the kind of thing — every head, every staff — which is the only way to reach the
 * several thousand looks no set names. What survives the switch is the outfit, because it
 * lives here rather than in either browser: a helm out of a set is still on her while a
 * two-hander is picked out of the list.
 *
 * `transmog.ts` decides how sets group and filter, `wardrobe.ts` what a kind is and what a
 * filter over one leaves, `outfit.ts` what goes where, and `outfitPanel.tsx` draws the body.
 * This is the browsing over them.
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

import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import { NO_MARK_FILTER, indexMarks, tagChoices } from "./marks";
import { MarkControls, MarkFilters } from "./marksEditor";
import type { MarkActions } from "./marksEditor";
import { wearable as canBeWorn } from "./modelPreview";
import {
  NOTHING_ON, isWorn, onlyWearable, setLabel, takeOff, toggle as toggleWorn, wearSet, wearable,
} from "./outfit";
import type { Outfit } from "./outfit";
import { OutfitPanel } from "./outfitPanel";
import {
  CLASSES, alternateLabel, classLabel, classNames, expansionName, filterSets, groupSets, patchName,
} from "./transmog";
import {
  appearanceRows, appearanceSummary, iconIds, itemsBehind, qualityLabel, varyingFacts, wearerLabel,
} from "./transmogModal";
import type { AppearanceRow, AppearanceSource } from "./transmogModal";
import type { ModelStage } from "./modelViewer";
import { LinkOut } from "./ui";
import { WardrobeList } from "./wardrobeList";
import type {
  CharacterModelPayload,
  IconsPayload,
  MarkSubjectKind,
  TransmogMark,
  TransmogMarksPayload,
  TransmogPayload,
  TransmogSet,
  TransmogSetItemsPayload,
  WardrobePayload,
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
  /** Asks it for every look filling a kind of place, when a reader browses by item. */
  loadAppearances: (displayTypes: number[]) => Promise<WardrobePayload>;
  /** Asks the backend for the pictures those rows need, decoded out of the game's textures. */
  loadIcons: (iconFileDataIds: number[]) => Promise<IconsPayload>;
  /** Passed through to the panel: the bare body, and the body wearing the whole outfit. */
  loadCharacter: () => Promise<CharacterModelPayload>;
  loadWorn: (pieces: WornPiece[]) => Promise<WornSetPayload>;
  /**
   * What the reader has said about the game's wardrobe, and the three ways they say more.
   *
   * The one thing on this screen that is not read out of the installed game — see `marks.ts`.
   * The payload is `null` until it has been read and stays `null` if it could not be: nothing
   * on the screen is then marked, and the first attempt to mark something says why.
   */
  marks: MarkActions & { payload: TransmogMarksPayload | null };
  /** Passed through too — it is the one thing here that needs a graphics card. */
  createStage?: (container: HTMLElement) => ModelStage | Promise<ModelStage>;
}

/** Which half of the browser the reader is in: the game's sets, or the game's whole wardrobe. */
type Browsing = "sets" | "items";

export function TransmogView(
  {
    payload, status, loadSet, loadAppearances, loadIcons, loadCharacter, loadWorn, marks,
    createStage,
  }: TransmogViewProps,
): ReactNode {
  const [browsing, setBrowsing] = useState<Browsing>("sets");
  const [search, setSearch] = useState("");
  const [expansion, setExpansion] = useState("");
  const [klass, setKlass] = useState("");
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
  const wantIcons = useCallback((wanted: number[]): void => {
    const missing = [...new Set(wanted)]
      .filter((id) => id > 0 && !icons.has(id) && !askedIcons.has(id));
    if (!missing.length) return;
    for (const id of missing) askedIcons.add(id);
    void loadIcons(missing)
      .then((pictures) => {
        for (const [id, url] of Object.entries(pictures.icons || {})) icons.set(Number(id), url);
        redraw();
      })
      .catch(() => undefined);
  }, [loadIcons, icons, askedIcons]);

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
        wantIcons(iconIds(answer));
      })
      // A set that will not come is worth saying, because the reader clicked to see what was
      // in it.
      .catch((error: unknown) => {
        if (!known.has(setId)) known.set(setId, message(error));
        redraw();
      });
  }, [loadSet, wantIcons, known, asked]);

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
    () => tagChoices(index, "set", (payload?.sets ?? []).map((set) => set.id)),
    [index, payload],
  );

  const sets = payload
    ? filterSets(payload.sets, {
      search, expansion, klass, marks: { filter: marked, of: (id) => index.of("set", id) },
    })
    : [];
  // Only offer the expansions this install actually has sets for.
  const expansions = payload
    ? [...new Set(payload.sets.map((set) => set.expansionId))].sort((a, b) => b - a)
    : [];
  const withheld = payload && payload.withheldCount > 0
    ? ` · ${plural(payload.withheldCount, "set")} the game keeps encrypted`
    : "";
  // The grid is shorter than the game's own count and says why. 436 sets of a shipping
  // install hold exactly another set's appearances, and a reader counting cards against the
  // number above would otherwise be missing several hundred with no explanation.
  const foldedCount = payload ? payload.sets.filter((set) => set.sameLookAs).length : 0;
  const folded = foldedCount > 0
    ? ` · ${plural(foldedCount, "set")} shown under another holding the same appearances`
    : "";

  return <>
    <header className="view-head">
      <h1>Transmog</h1>
      <div className="sub" id="transmog-meta">
        {payload
          ? `${plural(payload.sets.length, "set")} from the installed game${withheld}${folded}`
          : status}
      </div>
    </header>
    <div className="mog-layout">
      <div className="mog-half">
        {/* The one control above both browsers, because it is a statement about what a reader
            is looking for rather than about either list. Two buttons rather than a select:
            there are two of them and both are worth being one click away. */}
        <div className="mog-modes" role="group" aria-label="Browse the game by">
          <button
            type="button" aria-pressed={browsing === "sets"}
            onClick={() => setBrowsing("sets")}
          >Sets</button>
          <button
            type="button" aria-pressed={browsing === "items"}
            onClick={() => setBrowsing("items")}
          >Items</button>
        </div>
      <section className="panel mog-browser" id="transmog-browser" hidden={browsing !== "sets"}>
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
            {/* Beside the game's own filters rather than somewhere of their own, because
                "plate, Cataclysm, starred" is one question a reader asks and not two. */}
            <MarkFilters
              scope="transmog" favourite={marked.favourite} tag={marked.tag} choices={setTags}
              onFavourite={(only) => setMarked((was) => ({ ...was, favourite: only }))}
              onTag={(tag) => setMarked((was) => ({ ...was, tag }))}
            />
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
                    hideUnwearable={hideUnwearable} marks={marks} markOf={markOf}
                    onWear={(row) => setOutfit((was) => toggleWorn(was, row, setLabel(set)))}
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
      {/* Kept in the tree rather than swapped in, so that what a reader has read, searched
          and scrolled is still there when they come back to it. Nothing is read for it until
          it is first shown — see `hidden`, which the list takes as the word to start. */}
      <WardrobeList
        hidden={browsing !== "items"} load={loadAppearances} wantIcons={wantIcons} icons={icons}
        outfit={outfit} hideUnwearable={hideUnwearable} onHideUnwearable={setHideUnwearable}
        marks={marks} index={index}
        onWear={(row) => setOutfit((was) => toggleWorn(was, row))}
      />
      </div>
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
  {
    set, open, onToggle, contents, icons, outfit, hideUnwearable, marks, markOf, onWear,
    onWearAll,
  }: {
    set: TransmogSet;
    open: boolean;
    onToggle: () => void;
    /** What the set holds, the sentence saying why it could not be read, or nothing yet. */
    contents: TransmogSetItemsPayload | string | undefined;
    icons: Map<number, string>;
    outfit: Outfit;
    /** Whether the rows with nowhere to go are left out, which the browser decides for all. */
    hideUnwearable: boolean;
    marks: MarkActions;
    markOf: (kind: MarkSubjectKind, id: number) => TransmogMark | undefined;
    onWear: (row: AppearanceRow) => void;
    onWearAll: (rows: AppearanceRow[]) => void;
  },
): ReactNode {
  const patch = patchName(set.patchIntroduced);
  const classes = classNames(set.classMask);
  const rows = typeof contents === "object" ? appearanceRows(contents, set.name) : [];
  // Whatever is hidden is still worn by "wear all of", because that puts the set on rather
  // than what happens to be listed, and it is still counted below so nothing goes quietly.
  const shown = hideUnwearable ? onlyWearable(rows) : rows;
  const hidden = rows.length - shown.length;
  const name = set.name || "Unnamed set";
  const alternates = set.alternates ?? [];

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
      {/* Under the game's own facts and on their own line, because they are a different kind
          of statement: everything above is true of this build for everybody, and this is what
          one reader said. Available with the card shut — starring a set is not a reason to
          have to read what is in it. */}
      <MarkControls
        kind="set" id={set.id} mark={markOf("set", set.id)} name={name} actions={marks}
      />
      {/* Who else wears exactly these clothes. 436 of the game's sets are another set's
          wardrobe under a different name — one per faction, one per class, or the same armour
          reissued a season later — and showing all of them is showing one set up to six times.
          They are named here instead, because the name is the part a reader was looking for
          and the only part that was ever different. */}
      {alternates.length
        ? <ul className="mog-alternates" aria-label={`Sets holding the same appearances as ${name}`}>
          {alternates.map((alternate) => (
            <li key={alternate.id}>{alternateLabel(alternate, set)}</li>
          ))}
        </ul>
        : null}
      {/* Items rather than appearances, because items is what this number is. `TransmogSetItem`
          holds one row per item and the game's own table says nothing about how many looks
          they come to — that takes four more tables and is what opening the set is for. A card
          promising eight appearances over a list of three was the old way round. */}
      <div className="mog-foot">
        <span>{plural(set.itemCount, "item")}</span>
        <span className="muted">#{set.id}</span>
      </div>
      {open ? <div className="mog-contents">
        {contents === undefined ? <p className="muted">Reading what the set is made of…</p> : null}
        {typeof contents === "string" ? <p className="muted">{contents}</p> : null}
        {typeof contents === "object" ? <>
          <div className="mog-contents-head">
            {/* Always, now: the card counts items and this counts looks, and for 65% of the
                sets in the game those are different numbers. It is the sentence that explains
                why a set of 126 items opened as a list of 11. */}
            <p className="detail-facts">{appearanceSummary(rows, contents)}</p>
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
                icon={icons.get(row.iconFileDataId)} marks={marks}
                mark={markOf("appearance", row.appearanceId)} onWear={() => onWear(row)}
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
  { row, worn, icon, marks, mark, onWear }: {
    row: AppearanceRow;
    worn: boolean;
    icon?: string;
    marks: MarkActions;
    /** What the reader said about this *look*, which is the same mark the wardrobe draws. */
    mark: TransmogMark | undefined;
    onWear: () => void;
  },
): ReactNode {
  const wanted = canBeWorn(row);
  const canWear = wanted.kind === "worn";
  const [showSources, setShowSources] = useState(false);
  // Items, not lines: a row saying "+2 items" over a list of one is what folding two
  // indistinguishable items into one line would otherwise produce.
  const others = itemsBehind(row) - 1;

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
      {/* The look, not the item: a piece starred inside one set is starred wherever it turns
          up, including in the wardrobe list beside this one, because both key on the
          appearance. An appearance the game withholds has no id and gets no controls. */}
      <MarkControls
        kind="appearance" id={row.appearanceId} mark={mark} name={row.label} actions={marks}
      />
      {/* The one thing about a row worth saying without being asked. A reader whose class
          cannot wear the set's own version of a look can still have the look, and nothing else
          on the row would ever tell them so. */}
      {row.liftsRestriction
        ? <span className="chip mog-lifted" title="Another item gives this look to any class">
          Any class too
        </span>
        : null}
      {/* Every item that gives the look, behind a count. The row above is the look and this is
          the shopping: a set names one appearance once per item that has it, and 15,304 of the
          28,486 appearances in the game's sets are named more than once. */}
      {others > 0
        ? <button
          type="button" className="mog-sources-toggle" aria-expanded={showSources}
          onClick={() => setShowSources((open) => !open)}
        >{`+${others} ${others === 1 ? "item" : "items"}`}</button>
        : null}
      {/* A withheld row says so where a name would be, and saying it twice is two elements
          with the same sentence in them rather than one clearer row. */}
      {canWear || row.withheld ? null : <span className="muted">{wanted.note}</span>}
      {/* The corner leaves for Wowhead only when there is one item to leave for. An
          appearance the game withholds has none, and a look several items give has no single
          one — "which of these did you mean" is a real question, and the answer is the list
          the count opens, where every item has a corner of its own. */}
      {row.withheld || others > 0 ? null : (
        <a
          className="mog-wowhead" href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
          target="_blank" rel="noopener noreferrer" title={`${row.label} on Wowhead`}
          aria-label={`${row.label} on Wowhead`}
        ><LinkOut /></a>
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
          {source.itemCount > 1 ? <span className="chip">{`\u00d7${source.itemCount}`}</span> : null}
          {varies.allowableClass
            ? <span className="chip">{wearerLabel(source.allowableClass)}</span>
            : null}
          {varies.quality ? <span className="chip">{qualityLabel(source.quality)}</span> : null}
          {varies.requiredLevel && source.requiredLevel > 0
            ? <span className="chip">{`Level ${source.requiredLevel}`}</span>
            : null}
          <a
            className="mog-wowhead"
            href={`https://www.wowhead.com/item=${encodeURIComponent(source.itemId)}`}
            target="_blank" rel="noopener noreferrer"
            aria-label={`${source.label} on Wowhead`}
          ><LinkOut /></a>
        </li>
      ))}
    </ul>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
