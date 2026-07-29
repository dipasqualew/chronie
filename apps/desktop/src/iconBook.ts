/**
 * A book of pictures the game draws something with, kept for as long as the window is open.
 *
 * Two views of this app need the same errand run over different keys. A currency arrives from the
 * addon as an id and a balance; a place arrives as the name the client gave it. Neither carries a
 * picture, because an addon has a texture path and this app draws from FileDataIDs, so both take a
 * hop into the game's own tables made on the far side of the bridge and answered as something an
 * `<img>` can carry. The hop differs; everything around it does not.
 *
 * What is shared is the batching and the remembering, and both are worth having exactly once:
 *
 * - **One request per turn.** Every row asks for itself, because a row is the only thing that
 *   knows what it is about to draw. What crosses the bridge is one request carrying whatever
 *   asked in that turn, which matters because the cost on the far side is opening the game's
 *   storage rather than reading any one row out of it.
 * - **One request per key, ever.** What the game says cannot change under a running window, and a
 *   reader walking a roster of ten alts or a history of forty evenings meets the same currencies
 *   and the same dungeons over and over.
 *
 * A key the game has no picture for is remembered as such: the backend leaves it out of the
 * answer, and going back for it on every redraw would be a request that can never succeed. A
 * failed *request* is forgotten instead — the reasons are the ones that stop the whole game folder
 * being readable, it has not been chosen yet or it is mid-patch, and those are worth another try
 * the next time somebody opens a page. It is never reported, because a row with no picture is
 * exactly what this app drew before there were any, and an apology in its place would be worse.
 */

import type { IconsPayload } from "./types";

/** What a book can be keyed by: whatever the payload's own string keys can be read back as. */
export type IconKey = string | number;

export interface IconBookOptions<K extends IconKey> {
  /** Asks the backend for the pictures a list of keys is drawn with. */
  load: (keys: K[]) => Promise<IconsPayload>;
  /**
   * Runs the batch, once everything asking in this turn has asked. A microtask by default, and
   * a hook a test can hold open to see what one request ended up carrying.
   */
  schedule?: (run: () => void) => void;
}

export interface IconBook<K extends IconKey> {
  /**
   * Puts `keys` in the next request and watches for what comes back, until the function it hands
   * back is called.
   *
   * The unsubscribe shape is React's own: an effect returns it, and whatever was watching stops
   * when it leaves the screen.
   */
  learn: (keys: K[], changed: () => void) => () => void;
  /** The picture for a key, once it has arrived, and nothing until then. */
  icon: (key: K) => string | undefined;
}

/**
 * Whether a key is worth a request at all.
 *
 * Zero is what a row with no icon at all comes across as, and the empty string is what a segment
 * opened before the world finished loading was filed under. Neither is a thing the game can be
 * asked about, and both would otherwise take up a slot in `asked` for good.
 */
function worthAsking(key: IconKey): boolean {
  return typeof key === "number" ? key > 0 : key.trim() !== "";
}

export function createIconBook<K extends IconKey>({
  load,
  schedule = queueMicrotask,
}: IconBookOptions<K>): IconBook<K> {
  const icons = new Map<string, string>();
  /** Keys a request has already been made for, whatever it came back with. */
  const asked = new Set<string>();

  let pending = new Map<string, K>();
  let sending = false;
  const listeners = new Set<() => void>();

  async function send(keys: K[]): Promise<void> {
    try {
      const payload = await load(keys);
      for (const [key, url] of Object.entries(payload.icons ?? {})) {
        if (url) icons.set(key, url);
      }
    } catch {
      for (const key of keys) asked.delete(String(key));
      return;
    }
    // To everything on screen rather than to whoever asked: the same currency is on two
    // characters, and only the first of them put it in the request.
    for (const listener of [...listeners]) listener();
  }

  return {
    learn(keys, changed) {
      listeners.add(changed);
      for (const key of keys) {
        const spelled = String(key);
        if (worthAsking(key) && !asked.has(spelled)) {
          asked.add(spelled);
          pending.set(spelled, key);
        }
      }
      if (pending.size && !sending) {
        sending = true;
        schedule(() => {
          const carrying = [...pending.values()];
          pending = new Map();
          sending = false;
          void send(carrying);
        });
      }
      return () => listeners.delete(changed);
    },
    icon: (key) => icons.get(String(key)),
  };
}
