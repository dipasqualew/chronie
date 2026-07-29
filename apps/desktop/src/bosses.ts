/**
 * The portraits the Adventure Guide draws a boss with, kept for as long as the window is open.
 *
 * A fight arrives from the addon as the id the client handed `ENCOUNTER_END` — a
 * `DungeonEncounterID` — plus the name it was called at the time, and that is the whole of what
 * there is. So the picture is a hop into the game's own `JournalEncounter` and
 * `JournalEncounterCreature`, made on the far side of the bridge and answered as something an
 * `<img>` can carry. See `journal.rs`.
 *
 * Keyed by the encounter id rather than by the file behind it, for the same reason a currency is:
 * the id is what the segment carries, and the two table hops from one to the other are the
 * backend's to make. Unlike the places, nearly everything asked about comes back with something —
 * the game has a portrait for all but one of the fights its journal gives an id to — so a boss
 * line with nothing beside it means an install older than the fight rather than a gap in the
 * tables.
 *
 * The batching and the remembering are [`iconBook`]'s, which the places and the currency holdings
 * share.
 */

import { createIconBook } from "./iconBook";
import type { IconBook, IconBookOptions } from "./iconBook";

export type BossPortraitsOptions = IconBookOptions<number>;
export type BossPortraits = IconBook<number>;

export function createBossPortraits(options: BossPortraitsOptions): BossPortraits {
  return createIconBook<number>(options);
}
