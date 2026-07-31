/**
 * The picture a faction borrows from its own Exalted achievement, kept for as long as the window is
 * open.
 *
 * Keyed by the faction's own id, the way a currency is keyed by its. A chat line reports a faction
 * by its localised name and for a long time that name was the whole of what there was to key on —
 * which meant the backend had to enter the game's tables through `Faction`'s name column, matching
 * case-insensitively and following every one of the fourteen names that sit on more than one row.
 * The addon sends the id beside the name now, and none of that is a question any more.
 *
 * What has not changed is that there is nothing to look up: `Faction` has no icon column. What the
 * backend answers with instead is the icon of the achievement for reaching Exalted with that
 * faction, which is per-faction artwork the game already draws beside it. See `reputations.rs`.
 *
 * **Most of what this is asked about comes back with nothing, and the modern half comes back with
 * nothing.** Renown is not reputation with an Exalted tier, so the Council of Dornogal and every
 * other Dragonflight-and-later faction has no such achievement — those have artwork of their own
 * behind a texture atlas the app cannot crop yet. A renown line drawing no picture is the ordinary
 * case rather than a failure.
 *
 * The batching and the remembering are [`iconBook`]'s, which the places, the bosses and the
 * currency holdings share.
 */

import { createIconBook } from "./iconBook";
import type { IconBook, IconBookOptions } from "./iconBook";

export type FactionIconsOptions = IconBookOptions<number>;
export type FactionIcons = IconBook<number>;

export function createFactionIcons(options: FactionIconsOptions): FactionIcons {
  return createIconBook<number>(options);
}
