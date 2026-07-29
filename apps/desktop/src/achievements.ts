/**
 * What the game says about an achievement, kept beside what the addon recorded of it.
 *
 * A segment carries an id and, when the client happened to have the achievement loaded at
 * the moment it was earned, a name. The game's own tables carry everything else — the
 * sentence describing it, what it grants, the tree it is filed under, what it is worth, the
 * picture beside it — and the backend reads them on demand.
 *
 * So this is the one part of a segment that is not in the segment. The book below is what
 * fetches it and remembers it; [`achievementLine`] is what a row makes of the two halves,
 * including when the second half never arrives — an install can say nothing at all about an
 * achievement it does not have, and a row still has to draw.
 */

import type { Book } from "./book";
import { eventsOf } from "./types";
import type {
  AchievementDetail,
  AchievementDetailsPayload,
  AchievementEvent,
  IconsPayload,
  Segment,
} from "./types";

/** The sides an achievement can be for, in the game's own numbering. */
const HORDE = 0;
const ALLIANCE = 1;

/** The ids a segment names, without the repeats and without the ones that are not ids. */
export function achievementIds(segment: Segment): number[] {
  return [...new Set(eventsOf(segment, "achievements").map((event) => event.id))].filter(
    (id) => id > 0,
  );
}

/** One achievement as a row reads it, with everything the markup needs already decided. */
export interface AchievementLine {
  /** What names it: the game's own title, else the name the addon caught, else the id. */
  title: string;
  /** What had to be done, in the game's words. Empty until the game has been asked. */
  description: string;
  /** What earning it granted, when it granted anything. */
  reward: string;
  /** The tree it is filed under, as one line. Empty when the game withholds the tree. */
  category: string;
  /** What it is worth, already worded. Empty for an achievement worth nothing at all. */
  worth: string;
  /** Which side it is for, when it is for one. */
  side: string;
  /** The picture the game shows beside it, or zero when there is none to ask for. */
  iconFileDataId: number;
  /** Whether it was the first on the account or only on the character. */
  first: string;
}

/**
 * How a row reads, out of what the addon recorded and what the game could be asked.
 *
 * The addon's own name is the fallback rather than the other way round: the game's title is
 * the one that is definitely spelled the way the game spells it, while the addon's was
 * whatever the client had loaded at the time — and for an achievement the install cannot
 * describe at all, the addon's name is the only name there is.
 */
export function achievementLine(
  event: AchievementEvent,
  detail?: AchievementDetail,
): AchievementLine {
  return {
    title: detail?.title || event.name || `Achievement ${event.id}`,
    description: detail?.description ?? "",
    reward: detail?.reward ?? "",
    category: (detail?.category ?? []).join(" › "),
    worth: detail && detail.points > 0 ? `${detail.points} points` : "",
    side: detail?.faction === ALLIANCE ? "Alliance" : detail?.faction === HORDE ? "Horde" : "",
    iconFileDataId: detail?.iconFileDataId ?? 0,
    first: event.accountFirst ? "account first" : "character first",
  };
}

export interface AchievementBookOptions {
  /** Asks the backend what the game says about a list of ids. */
  load: (ids: number[]) => Promise<AchievementDetailsPayload>;
  /** Asks the backend for the pictures those achievements name. */
  loadIcons: (iconFileDataIds: number[]) => Promise<IconsPayload>;
}

export interface AchievementBook extends Book<number> {
  /**
   * Looks up whatever of `ids` has not been looked up already, and the pictures for it, and
   * watches for what comes back until the function it hands back is called.
   *
   * `changed` is called when the words arrive and again when the pictures do, because the two are
   * separate reads of the game's storage and a list of achievements is worth reading while the
   * second is still going. It is never called for a request that turned up nothing new — and
   * never after the caller has stopped listening, which is the point of the unsubscribe: reading
   * the game's tables takes about a second, and a reader can close a segment inside one.
   */
  learn: (ids: number[], changed: () => void) => () => void;
  detail: (id: number) => AchievementDetail | undefined;
  /** The picture for an achievement, once it has arrived. */
  icon: (id: number) => string | undefined;
}

/**
 * The achievements this window has been told about, and their pictures.
 *
 * What the game says cannot change under a running app, and a reader walking their history
 * meets the same achievements over and over — so an id is asked about once. The backend
 * remembers them too; this saves the round trip as well.
 *
 * A lookup that fails is forgotten rather than remembered as nothing: the reasons are the
 * ones that stop the whole game folder being readable — it has not been chosen yet, or it is
 * mid-patch — and those are worth one more try when the reader opens the next segment. It is
 * never reported, because a row that says what the addon recorded is what the app showed
 * before any of this, and an apology in its place would be worse.
 */
export function createAchievementBook({
  load,
  loadIcons,
}: AchievementBookOptions): AchievementBook {
  const known = new Map<number, AchievementDetail>();
  const icons = new Map<number, string>();
  /** Ids a request has already been made for, whatever it came back with. */
  const asked = new Set<number>();
  /** Textures a request has already been made for, likewise. */
  const askedIcons = new Set<number>();
  /** Everything currently on screen that is waiting to hear about any of this. */
  const listeners = new Set<() => void>();
  /** How many times anything has arrived, which is the snapshot React compares. See `book.ts`. */
  let version = 0;

  /**
   * Says that something new has arrived, to everything currently on screen.
   *
   * To all of them rather than to whoever asked, the same as the item book beside it: the same
   * achievement can be in two open lists, and only the first of them put it in the request.
   */
  const tell = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  /** The two reads one `learn` turns into: the words, and then the pictures they name. */
  async function fetch(ids: number[]): Promise<void> {
    const fresh = [...new Set(ids)].filter((id) => id > 0 && !asked.has(id));
    for (const id of fresh) asked.add(id);
    if (fresh.length) {
      try {
        const payload = await load(fresh);
        for (const [id, detail] of Object.entries(payload.achievements ?? {})) {
          if (detail) known.set(Number(id), detail);
        }
      } catch {
        for (const id of fresh) asked.delete(id);
        return;
      }
      tell();
    }

    const pictures = [...new Set(ids.map((id) => known.get(id)?.iconFileDataId ?? 0))].filter(
      (fdid) => fdid > 0 && !askedIcons.has(fdid),
    );
    if (!pictures.length) return;
    for (const fdid of pictures) askedIcons.add(fdid);
    try {
      const payload = await loadIcons(pictures);
      for (const [fdid, url] of Object.entries(payload.icons ?? {})) {
        if (url) icons.set(Number(fdid), url);
      }
    } catch {
      for (const fdid of pictures) askedIcons.delete(fdid);
      return;
    }
    tell();
  }

  return {
    learn(ids, changed) {
      listeners.add(changed);
      void fetch(ids);
      return () => listeners.delete(changed);
    },
    version: () => version,
    detail: (id) => known.get(id),
    icon: (id) => {
      const fdid = known.get(id)?.iconFileDataId;
      return fdid ? icons.get(fdid) : undefined;
    },
  };
}
