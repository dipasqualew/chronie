/**
 * The picture a faction borrows from its own Exalted achievement, kept for as long as the window is
 * open.
 *
 * A reputation arrives from the addon as a name, an amount and a standing — the client reports a
 * faction by its localised name — so a name is the whole of what there is to key on, the same as a
 * place. What is different is that there is nothing to look up: `Faction` has no icon column. What
 * the backend answers with instead is the icon of the achievement for reaching Exalted with that
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

export type FactionIconsOptions = IconBookOptions<string>;
export type FactionIcons = IconBook<string>;

export function createFactionIcons(options: FactionIconsOptions): FactionIcons {
  return createIconBook<string>(options);
}
