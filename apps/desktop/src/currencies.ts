/**
 * The pictures the game draws a currency with, kept for as long as the window is open.
 *
 * Everything else about a currency arrives from the addon — an id, a name and a balance — and
 * the one thing an addon cannot send is the icon, because an addon has a texture path and this
 * app draws from FileDataIDs. So the picture is a hop into the game's own `CurrencyTypes`, made
 * on the far side of the bridge and answered as something an `<img>` can carry. See
 * `currencies.rs`.
 *
 * The same book [`items.ts`] keeps and for the same two reasons: what the game says cannot change
 * under a running window, and a reader moving down a roster of ten alts meets the same handful of
 * currencies on every one of them. So an id is asked about once, and switching characters asks
 * only about whatever the last one did not hold.
 *
 * Thinner than the item book because the errand is: one request and one kind of answer, where an
 * item is a lookup and then a second lookup for the picture the first one named.
 */

import type { IconsPayload } from "./types";

export interface CurrencyIconsOptions {
  /** Asks the backend for the pictures a list of currencies is drawn with. */
  load: (currencyIds: number[]) => Promise<IconsPayload>;
  /**
   * Runs the batch, once everything asking in this turn has asked. A microtask by default, and
   * a hook a test can hold open to see what one request ended up carrying.
   */
  schedule?: (run: () => void) => void;
}

export interface CurrencyIcons {
  /**
   * Puts `currencyIds` in the next request and watches for what comes back, until the function
   * it hands back is called.
   *
   * The unsubscribe shape is React's own: an effect returns it, and whatever was watching stops
   * when it leaves the screen.
   */
  learn: (currencyIds: number[], changed: () => void) => () => void;
  /** The picture for a currency, once it has arrived, and nothing until then. */
  icon: (currencyId: number) => string | undefined;
}

/**
 * The currencies this window has been told about, and their pictures.
 *
 * A failed request is forgotten rather than remembered as nothing, the way the item book forgets
 * one: the reasons are the ones that stop the whole game folder being readable — it has not been
 * chosen yet, or it is mid-patch — and those are worth another try the next time somebody opens a
 * character. It is never reported, because a row with no picture is exactly what this app drew
 * before there were any, and an apology in its place would be worse.
 *
 * A currency the game has no picture for is a different thing and is remembered: the backend
 * leaves it out of the answer, and the id stays in `asked` so nothing goes looking twice.
 */
export function createCurrencyIcons(
  { load, schedule = queueMicrotask }: CurrencyIconsOptions,
): CurrencyIcons {
  const icons = new Map<number, string>();
  /** Ids a request has already been made for, whatever it came back with. */
  const asked = new Set<number>();

  let pending = new Set<number>();
  let sending = false;
  const listeners = new Set<() => void>();

  async function send(ids: number[]): Promise<void> {
    try {
      const payload = await load(ids);
      for (const [id, url] of Object.entries(payload.icons ?? {})) icons.set(Number(id), url);
    } catch {
      for (const id of ids) asked.delete(id);
      return;
    }
    // To everything on screen rather than to whoever asked: the same currency is on two
    // characters, and only the first of them put it in the request.
    for (const listener of [...listeners]) listener();
  }

  return {
    learn(currencyIds, changed) {
      listeners.add(changed);
      for (const id of currencyIds) {
        if (id > 0 && !asked.has(id)) {
          asked.add(id);
          pending.add(id);
        }
      }
      if (pending.size && !sending) {
        sending = true;
        schedule(() => {
          const carrying = [...pending];
          pending = new Set();
          sending = false;
          void send(carrying);
        });
      }
      return () => listeners.delete(changed);
    },
    icon: (currencyId) => icons.get(currencyId),
  };
}
