/**
 * The pictures the game draws a currency with, kept for as long as the window is open.
 *
 * Everything else about a currency arrives from the addon — an id, a name and a balance — and
 * the one thing an addon cannot send is the icon, because an addon has a texture path and this
 * app draws from FileDataIDs. So the picture is a hop into the game's own `CurrencyTypes`, made
 * on the far side of the bridge and answered as something an `<img>` can carry. See
 * `currencies.rs`.
 *
 * Keyed by the currency's own id rather than by the file behind it, because that is what a
 * character's holdings carry and the hop from one to the other is the backend's to make. The
 * batching and the remembering are [`iconBook`]'s, which the places on the timeline share.
 */

import { createIconBook } from "./iconBook";
import type { IconBook, IconBookOptions } from "./iconBook";

export type CurrencyIconsOptions = IconBookOptions<number>;
export type CurrencyIcons = IconBook<number>;

export function createCurrencyIcons(options: CurrencyIconsOptions): CurrencyIcons {
  return createIconBook<number>(options);
}
