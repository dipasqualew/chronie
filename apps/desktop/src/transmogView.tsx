/**
 * The transmog view: every set the installed game knows about, by collection.
 *
 * The backend hands over a flat list and `transmog.ts` decides how it groups, filters and
 * reads; this is the grid over it. The list costs a second and a few hundred megabytes to
 * read out of the game's own files, so it arrives after the window has opened — which is why
 * this view has a loading line and a failure to draw, and no other one does.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import { CLASSES, classLabel, classNames, expansionName, filterSets, groupSets, patchName } from "./transmog";
import type { TransmogPayload, TransmogSet } from "./types";

export interface TransmogViewProps {
  /** The loaded sets, or null while they are still being read out of the game. */
  payload: TransmogPayload | null;
  /** What the view says instead, when there is no payload: reading, or why there is not. */
  status: string;
  /** Opens one set. The grid knows which set was clicked and nothing about what is in it. */
  onOpenSet: (set: TransmogSet) => void;
}

export function TransmogView({ payload, status, onOpenSet }: TransmogViewProps): ReactNode {
  const [search, setSearch] = useState("");
  const [expansion, setExpansion] = useState("");
  const [klass, setKlass] = useState("");

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
    <section className="panel">
      <div className="table-head">
        <div className="controls">
          <input
            id="transmog-search" type="search" placeholder="Filter set or collection…"
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
              {group.sets.map((set) =>
                <Card key={set.id} set={set} onOpen={() => onOpenSet(set)} />)}
            </div>
          </section>
        ))}
      </div>
      <div className="empty" id="transmog-empty" hidden={!payload || sets.length > 0}>
        <p className="empty-title">Nothing matches</p>
        <p>Try a different search, class or expansion.</p>
      </div>
    </section>
  </>;
}

function Card({ set, onOpen }: { set: TransmogSet; onOpen: () => void }): ReactNode {
  const patch = patchName(set.patchIntroduced);
  const classes = classNames(set.classMask);
  // The name is the button rather than the card being one, because a card holds a heading and
  // a heading cannot live inside a button — and the heading is how the view is walked. The
  // card answers a click anywhere on it too, which is what makes the whole tile feel live.
  return (
    <article
      className="mog-card" title={classes.length ? classes.join(", ") : undefined}
      onClick={onOpen}
    >
      <h4><button type="button" className="mog-open">{set.name || "Unnamed set"}</button></h4>
      <div className="mog-facts">
        <span className="chip">{classLabel(set.classMask)}</span>
        <span className="chip">{expansionName(set.expansionId)}</span>
        {patch ? <span className="chip">Patch {patch}</span> : null}
      </div>
      <div className="mog-foot">
        <span>{plural(set.itemCount, "appearance")}</span>
        <span className="muted">#{set.id}</span>
      </div>
    </article>
  );
}
