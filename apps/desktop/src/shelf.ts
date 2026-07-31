/**
 * The sets that are one slot short of anybody being able to wear them.
 *
 * The grid says who can wear a set — "Any plate wearer", "Paladin only" — and `openings.ts` says,
 * once a set is opened, which of its looks something else in the game sells around. Between those
 * two there is a thing neither of them can be asked for: **the sets a reader can almost have**.
 * Measured on a shipping install, 201 of the game's single-class sets are exactly one slot short
 * of being open to everybody and 441 are two short, and which slot did it is spread evenly enough
 * that there is no shortcut — chest 145, shoulder 142, legs 137, head 133, back 125, and so on
 * down. Those are the most interesting objects in the wardrobe: a look with a single named
 * obstacle in front of it.
 *
 * Nobody finds them by guessing a filter, so this is the list, and `shelfList.tsx` is the browser
 * over it. What a row is drawn from is the whole-grid read `wearers.rs` already does — no set has
 * to be opened for the shelf to exist, which is what lets it be a list of six hundred rows rather
 * than six hundred reads.
 *
 * **A blocked slot has one of two kinds of answer, and the shelf says which.** `shapes.rs`
 * answers "what else in the game hangs exactly this geometry" exactly, freely and with no
 * threshold — but only where the slot hangs geometry at all. Head, shoulder and everything
 * carried in a hand do; a chestpiece, a legging, a belt, a boot, a bracer, a glove, a cloak and a
 * tabard are paint on a body every look in the slot shares, and there the honest answer is a
 * ranked list of lookalikes a person has to confirm — see `alternatives.ts`, whose whole point is
 * not to pass the second off as the first. Held against the spread above, that divides the shelf
 * roughly in half: about 275 of these sets can be answered with "the same helm, in this colour,
 * anybody can wear it" and the rest cannot. So the split is drawn rather than smoothed over, and
 * the exact ones come first.
 */

import { plural } from "./format";
import { classNames, whoWears } from "./transmog";
import { slotName } from "./transmogModal";
import type { SetWearers, TransmogSet } from "./types";

/**
 * How many shut slots a set can have and still be something a reader can almost have.
 *
 * Two, which is where the issue's own measurement stops and where the phrase stops meaning
 * anything: one obstacle is a question with an answer, two is a pair of them, and a set with
 * three is simply a set for somebody else. The grid is where those are found.
 */
export const NEAR_MISS = 2;

/**
 * The places on the body that hang geometry of their own, as `ItemAppearance.DisplayType`
 * numbers them: head, shoulder, and everything carried in a hand.
 *
 * The window's copy of `Shape::names_a_mesh`, and the one thing about a blocked slot that decides
 * what kind of answer a reader is going to get. It is written out here rather than asked of the
 * backend because it is a fact about the game's own filing rather than about this install: no
 * chestpiece in any build hangs a mesh, and a call per row to be told so would be six hundred
 * calls to learn nothing.
 */
const HANGS_A_MESH = new Set([0, 1, 11, 12, 13, 14, 15]);

/** Whether the geometry can speak for a slot at all — see [`HANGS_A_MESH`]. */
export function answersExactly(displayType: number): boolean {
  return HANGS_A_MESH.has(displayType);
}

/** One place on the body a set will not let everybody fill, and what can be said about it. */
export interface BlockedSlot {
  displayType: number;
  /** What the place is called, in the words every other list in this view uses. */
  slot: string;
  /**
   * Whether the answer for it is an equality out of the geometry rather than a ranking out of
   * the pictures — see the module note, and `alternatives.ts` for the two claims themselves.
   */
  exact: boolean;
}

/** One set of the shelf: what it is, who can wear it, and what stands between. */
export interface ShelfRow {
  set: TransmogSet;
  /** Who the items behind it say can wear it, as a mask — see `whoWears`. */
  wearers: number;
  /** How many of its slots anybody can already fill. */
  open: number;
  /** And the one or two they cannot, in the order the game numbers the places. */
  blocked: BlockedSlot[];
}

/**
 * The shelf: every set a slot or two short of anybody, in the order worth reading them.
 *
 * **A set with no open slot at all is not a near miss**, whatever its count of shut ones. "One
 * slot short" is a claim about a thing you can almost have, and a set of one slot that nothing
 * sells around is a wall with one brick in it rather than a wardrobe with a gap.
 *
 * Sets holding exactly another set's appearances are left out, the same fold the grid makes: they
 * are the same clothes under a second name and would be the same row written twice, blocked at
 * the same slot for the same reason. Variants — a raid tier's difficulties, a recolour's eighteen
 * shades — are *not* folded, because those are genuinely different looks, each with its own
 * items and its own answer.
 *
 * The order is the reading order: fewest obstacles first, then the ones the geometry can answer
 * exactly, then whatever order the backend sorted the grid into. A reader who scrolls no further
 * than the top of this list is looking at the sets that are one item away and can be settled
 * today.
 */
export function shelfRows(
  sets: TransmogSet[],
  said: (setId: number) => SetWearers | undefined,
): ShelfRow[] {
  const rows: ShelfRow[] = [];
  for (const set of sets) {
    if (set.sameLookAs) continue;
    const about = said(set.id);
    if (!about) continue;
    const blocked = about.blockedSlots;
    if (!blocked.length || blocked.length > NEAR_MISS || about.openSlots === 0) continue;
    rows.push({
      set,
      wearers: about.classMask,
      open: about.openSlots,
      blocked: blocked.map((displayType) => ({
        displayType,
        slot: slotName(displayType),
        exact: answersExactly(displayType),
      })),
    });
  }
  return rows
    .map((row, at) => ({ row, at }))
    .sort(
      (left, right) =>
        left.row.blocked.length - right.row.blocked.length ||
        Number(anyExact(right.row)) - Number(anyExact(left.row)) ||
        left.at - right.at,
    )
    .map(({ row }) => row);
}

/** Whether anything about this row can be answered without a person confirming it. */
export function anyExact(row: ShelfRow): boolean {
  return row.blocked.some((slot) => slot.exact);
}

/**
 * The shelf narrowed by what was typed, which is words and only words.
 *
 * The grid over the game's sets takes terms — `class:mage`, `colour:brown` — because it is
 * several thousand cards and a reader needs to cut it several ways at once. This is six hundred
 * rows already cut the one way that matters, so the box is what it looks like: a name, a
 * collection, or the class the chip on the row says.
 */
export function filterShelf(rows: ShelfRow[], search: string): ShelfRow[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((row) => {
    const said = [
      row.set.name,
      row.set.group,
      whoWears(row.wearers),
      ...classNames(row.wearers),
      ...row.blocked.map((slot) => slot.slot),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => said.includes(word));
  });
}

/**
 * The one line over the list, which is the answer for a reader who reads nothing else.
 *
 * Two numbers rather than one, because they are two different errands: a set one slot short is a
 * single question, and a set two short is a pair of them. The count of what the geometry can
 * settle on its own is the third, and it is the one that says how much of this list is work a
 * person has to do by eye — see `alternatives.ts`.
 */
export function shelfSummary(rows: ShelfRow[]): string {
  if (!rows.length) return "No set the game knows about is a slot or two short of everybody";
  const one = rows.filter((row) => row.blocked.length === 1).length;
  const two = rows.length - one;
  const exact = rows.filter(anyExact).length;
  const short = [
    one ? `${plural(one, "set")} one slot short` : "",
    two ? `${plural(two, "set")} two short` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return exact
    ? `${short} · ${exact} of them blocked where the game's own geometry can answer exactly`
    : short;
}

/**
 * How a row says what stands between the reader and the set.
 *
 * The slot rather than the item, because the item is not known until the set is opened and the
 * slot is the whole of what a reader is choosing by: somebody who will not chase a chestpiece
 * this month will chase a helm.
 */
export function blockedLabel(row: ShelfRow): string {
  const slots = row.blocked.map((slot) => slot.slot).join(" and ");
  const filled = `${row.open} of ${plural(row.open + row.blocked.length, "slot")} open to anybody`;
  return row.blocked.length === 1
    ? `${filled} · ${slots} is the whole of what stops it`
    : `${filled} · ${slots} are what stop it`;
}

/**
 * And what kind of answer those obstacles have, which is the thing this shelf exists to say
 * twice rather than once.
 *
 * A promise about the *question*, not about the answer: a helm the geometry can speak for may
 * still turn out to have no other colour in the game, and the sentence has to survive that. What
 * it claims is only which measure applies — an equality anybody can check, or a ranking somebody
 * has to look at. See `alternatives.ts`, whose whole thread was about not letting the second wear
 * the first's clothes.
 */
export function answerNote(row: ShelfRow): string {
  const exact = row.blocked.filter((slot) => slot.exact);
  const ranked = row.blocked.filter((slot) => !slot.exact);
  if (!ranked.length) {
    return "The game hangs a mesh here, so the same piece in another colour is an exact question with an exact answer.";
  }
  if (!exact.length) {
    return "Every look in this slot is paint on the one body, so all anybody can offer is a ranking to confirm by eye.";
  }
  return `${exact.map((slot) => slot.slot).join(" and ")} the geometry can answer exactly; ${ranked
    .map((slot) => slot.slot)
    .join(" and ")} only the pictures can rank.`;
}
