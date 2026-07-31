/**
 * What else might do, for a look nothing in the game sells around — behind a button on that row.
 *
 * Behind a button rather than drawn into the openings table, because both halves of what this
 * costs are worth being asked for rather than spent: the geometry is a walk of the game's tables
 * and the pictures are half a minute of decoding, and — more to the point — everything here is
 * approximate where everything in the table above it is exact. A reader who wants the certain
 * answer should not have to read past a list of maybes to reach it.
 *
 * The rows are `alternatives.ts`'s. This draws them, and the one thing it decides is which of the
 * two claims a row is making: "the same armour, another colour" is an equality out of the mesh
 * and "94.5% alike" is a distance out of the pictures, and a panel that drew them alike would be
 * lending the second the first's certainty.
 */

import "./alternativesPanel.css";

import type { ReactNode } from "react";

import { alternativeRows, alternativesSummary, CONFIRMED, REJECTED } from "./alternatives";
import type { AlternativeRow } from "./alternatives";
import type { OpeningRow } from "./openings";
import type { AlternativesPayload, LookalikeVerdict } from "./types";
import { LinkOut } from "./ui";

/** Reading the suggestions for a look, and saying what one thinks of them. */
export interface AlternativeActions {
  /** What has been read so far, by the look it was read for. */
  found: Map<number, AlternativesPayload>;
  /** Sends for one, if it has not been sent for already. */
  want: (appearanceId: number, displayType: number) => void;
  /** Everything anybody has decided about a suggestion, whichever look it was made for. */
  said: LookalikeVerdict[];
  /** And deciding: `CONFIRMED`, `REJECTED`, or nothing to go back to having said neither. */
  rule: (appearanceId: number, alternativeId: number, verdict: string | null) => void;
}

export function AlternativesPanel({
  row,
  alternatives,
  icons,
}: {
  /** The locked slot the panel was opened from — see `openings.ts`. */
  row: OpeningRow;
  alternatives: AlternativeActions;
  icons: Map<number, string>;
}): ReactNode {
  const payload = alternatives.found.get(row.appearanceId);
  if (!payload) return <p className="muted">Reading what else in the game looks like this…</p>;
  const rows = alternativeRows(payload, alternatives.said);
  return (
    <div className="mog-alternatives">
      <p className="detail-facts">{alternativesSummary(payload)}</p>
      {rows.length ? (
        <ul aria-label={`Possible alternatives to ${row.own}`}>
          {rows.map((one) => (
            <Row
              key={one.appearanceId}
              row={one}
              icon={icons.get(one.iconFileDataId)}
              onRule={(verdict) => alternatives.rule(row.appearanceId, one.appearanceId, verdict)}
            />
          ))}
        </ul>
      ) : null}
      {/* Said once, under the list, rather than on every row. Nothing above this line is the
          game's own word for anything: the first rows are two signatures this app wrote being
          equal and the rest are two thumbnails it took being near, and a reader deciding to
          chase one of them should know which of those they are looking at. */}
      {rows.length ? (
        <p className="detail-facts muted">
          Chronie measured these off the game&apos;s own models and textures. Have a look before you
          go anywhere — and say so either way, so it stops asking.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One suggestion, the claim it is making, and the two buttons that settle it.
 *
 * `data-verdict` rather than a colour written into the markup: the packaged app's Content
 * Security Policy will not carry a nonce on a `style` attribute, so nothing this window draws is
 * styled from a `style` prop — see the note in `CLAUDE.md`.
 */
function Row({
  row,
  icon,
  onRule,
}: {
  row: AlternativeRow;
  icon: string | undefined;
  onRule: (verdict: string | null) => void;
}): ReactNode {
  return (
    <li data-verdict={row.verdict ?? "none"}>
      {icon ? <img src={icon} alt="" /> : <span className="mog-alternative-blank" />}
      <span className="mog-alternative-name">{row.label}</span>
      {/* The strength of the claim, in words. "The same armour" is an equality between two mesh
          signatures; a percentage is a distance between two thumbnails under a threshold this
          install cut for this slot. They are not the same kind of statement. */}
      <span className="mog-alternative-claim">
        {row.exact ? "The same armour, another colour" : row.likeness}
      </span>
      {/* Which kind of armour it is, because the world drop that lifts a class lock nearly
          always lifts the class and not the armour type: a cloth answer is right for a Priest
          and no use whatever to a Druid. */}
      {row.kind ? <span className="mog-alternative-kind">{row.kind}</span> : null}
      {row.requirement ? <span className="mog-alternative-kind">{row.requirement}</span> : null}
      <a
        className="mog-wowhead"
        href={`https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${row.label} on Wowhead`}
      >
        <LinkOut />
      </a>
      {/* Clicking the answer already given takes it back, which is what a pressed button means
          — and puts the row back to nobody having looked at it rather than to a third verdict. */}
      <Verdict row={row} word={CONFIRMED} says="That is the one" onRule={onRule} />
      <Verdict row={row} word={REJECTED} says="Not this one" onRule={onRule} />
    </li>
  );
}

function Verdict({
  row,
  word,
  says,
  onRule,
}: {
  row: AlternativeRow;
  word: string;
  says: string;
  onRule: (verdict: string | null) => void;
}): ReactNode {
  const held = row.verdict === word;
  return (
    <button
      type="button"
      className="mog-alternative-verdict"
      data-said={word}
      aria-pressed={held}
      aria-label={`${says}: ${row.label}`}
      onClick={() => onRule(held ? null : word)}
    >
      {says}
    </button>
  );
}
