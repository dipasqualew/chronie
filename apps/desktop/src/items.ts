/**
 * What the game says about an item, kept beside what the addon recorded of it.
 *
 * A segment carries item ids — the transmog sources a character learned, the pieces an
 * equipment set changed to hold — and, when the client happened to have the item loaded at the
 * moment, a name. Everything a player recognises an item by is in the game's own tables: what
 * it is called, what it is worth, what kind of armour it is, where it is worn, who may wear it
 * and the picture beside it. The backend reads those and answers with numbers; this is where
 * the numbers become the words on screen.
 *
 * [`itemLine`] is what a row makes of the two halves, including when the second half never
 * arrives — an install can say nothing about an item it does not have, and a row still has to
 * draw. [`createItemBook`] is what fetches and remembers them.
 */

import type { IconsPayload, ItemDetail, ItemDetailsPayload } from "./types";

/** The class of thing an item is, in the game's own numbering. */
const WEAPON = 2;
const ARMOR = 4;

/** A class mask nobody is excluded by, which is what nearly every item carries. */
const ANY_CLASS = 0xffff;

/**
 * The armour classes, by the subclass the game files a piece under.
 *
 * Subclass 0 is deliberately absent. It is what rings, necks and trinkets are filed as —
 * "Miscellaneous", which is the game admitting the question does not apply — and a chip
 * saying so on every ring would be noise rather than information.
 */
const ARMOR_CLASSES: Record<number, string> = {
  1: "Cloth",
  2: "Leather",
  3: "Mail",
  4: "Plate",
  5: "Cosmetic",
  6: "Shield",
};

/**
 * What kind of weapon it is.
 *
 * The game keeps one-handed and two-handed axes, maces and swords as separate subclasses;
 * they are collapsed here because the slot beside them already says which, and "Two-hand ·
 * Sword (2H)" says it twice.
 */
const WEAPON_KINDS: Record<number, string> = {
  0: "Axe",
  1: "Axe",
  2: "Bow",
  3: "Gun",
  4: "Mace",
  5: "Mace",
  6: "Polearm",
  7: "Sword",
  8: "Sword",
  9: "Warglaive",
  10: "Staff",
  13: "Fist weapon",
  15: "Dagger",
  16: "Thrown",
  18: "Crossbow",
  19: "Wand",
  20: "Fishing pole",
};

/**
 * Where the game says an item is worn.
 *
 * 0 is not in here and neither are the kinds nothing is worn from: a hearthstone, a bag of
 * flour and a quest item are all "worn nowhere", which is a fact about the item rather than a
 * slot to name.
 */
const SLOTS: Record<number, string> = {
  1: "Head",
  2: "Neck",
  3: "Shoulders",
  4: "Shirt",
  5: "Chest",
  6: "Waist",
  7: "Legs",
  8: "Feet",
  9: "Wrists",
  10: "Hands",
  11: "Ring",
  12: "Trinket",
  13: "One-hand",
  14: "Off hand",
  15: "Ranged",
  16: "Back",
  17: "Two-hand",
  19: "Tabard",
  20: "Chest",
  21: "Main hand",
  22: "Off hand",
  23: "Held in off hand",
  26: "Ranged",
  28: "Relic",
  29: "Profession tool",
  30: "Profession accessory",
};

/** What the game is worth calling each quality, for the ones worth saying out loud. */
const QUALITIES: Record<number, string> = {
  0: "Poor",
  1: "Common",
  2: "Uncommon",
  3: "Rare",
  4: "Epic",
  5: "Legendary",
  6: "Artifact",
  7: "Heirloom",
};

/**
 * The classes, in the order the game numbers them: the mask holds `1 << (class - 1)`.
 *
 * Every class the game has shipped is here, and the mask on a legacy item can still carry
 * bits above them — the ones set aside for classes that never arrived. Those are ignored
 * rather than named, which is why a restriction is built from this list rather than from the
 * bits that happen to be set.
 */
const CLASSES = [
  "Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Death Knight", "Shaman", "Mage",
  "Warlock", "Monk", "Druid", "Demon Hunter", "Evoker",
];

/** One item as a row reads it, with everything the markup needs already decided. */
export interface ItemLine {
  /** What names it: the game's own name, else the name the addon caught, else the id. */
  name: string;
  /**
   * The colour the game writes the name in, or null for an item nothing is known about.
   *
   * Null rather than zero, because zero is poor quality — the grey of a broken sword — and an
   * item whose lookup has not come back is not grey, it is uncoloured.
   */
  quality: number | null;
  /** "Epic", "Rare". Empty until the game has been asked. */
  qualityName: string;
  /** What kind of thing it is: "Leather", "Plate", "Sword". Empty when the game files it
   * under nothing worth saying. */
  kind: string;
  /** Where it is worn: "Shoulders", "Two-hand". Empty for a thing that is not worn. */
  slot: string;
  /** Who may wear it, when it is not everybody: "Warrior, Paladin, Death Knight only". */
  restriction: string;
  /** The level it takes, when it takes one: "Level 60". */
  requirement: string;
  /** The picture the game shows beside it, or zero when there is none to ask for. */
  iconFileDataId: number;
}

/**
 * What an item is called, wherever in the app it is named.
 *
 * The game's name leads and the addon's is the fallback, the same way round as an
 * achievement's: the game's is the one that is definitely spelled the way the game spells it,
 * while the addon's was whatever the client had loaded at the time — and for an item the
 * install cannot describe at all, the addon's name is the only name there is. Under both of
 * them is the id, which is at least something a reader can look up.
 *
 * One function rather than the four copies of `name || "Item " + id` this app grew, because
 * the copies disagreed: a summary chip worded before anything had been asked said "Item 39473"
 * while the list it unfolded into said "Insanity's Grip", about the same piece, on the same
 * card. Anything that has to say what an item is called says it through here.
 */
export const itemName = (id: number, recorded?: string | null, detail?: ItemDetail): string =>
  detail?.name || recorded || `Item ${id}`;

/**
 * How a row reads, out of what the addon recorded and what the game could be asked.
 */
export function itemLine(
  id: number,
  recorded?: string | null,
  detail?: ItemDetail,
): ItemLine {
  const quality = detail && detail.name ? detail.quality : null;
  return {
    name: itemName(id, recorded, detail),
    quality,
    qualityName: quality == null ? "" : QUALITIES[quality] ?? "",
    kind: kindOf(detail),
    slot: detail ? SLOTS[detail.inventoryType] ?? "" : "",
    restriction: restrictionOf(detail),
    requirement: detail && detail.requiredLevel > 0 ? `Level ${detail.requiredLevel}` : "",
    iconFileDataId: detail?.iconFileDataId ?? 0,
  };
}

/** Which armour class or which weapon, and nothing at all for the kinds that are neither. */
function kindOf(detail?: ItemDetail): string {
  if (!detail) return "";
  if (detail.classId === ARMOR) return ARMOR_CLASSES[detail.subclassId] ?? "";
  if (detail.classId === WEAPON) return WEAPON_KINDS[detail.subclassId] ?? "";
  return "";
}

/**
 * Who may wear it, named class by class, and empty when anybody may.
 *
 * The mask is read against the classes the game has rather than bit by bit: a legacy item can
 * have bits set for classes that never shipped, and a mask covering every class that exists
 * is not a restriction however many spare bits it carries.
 */
function restrictionOf(detail?: ItemDetail): string {
  if (!detail) return "";
  const mask = detail.allowableClass;
  if (mask === 0 || mask === ANY_CLASS) return "";
  const named = CLASSES.filter((_, index) => (mask & (1 << index)) !== 0);
  if (!named.length || named.length === CLASSES.length) return "";
  return `${named.join(", ")} only`;
}

export interface ItemBookOptions {
  /** Asks the backend what the game says about a list of ids. */
  load: (ids: number[]) => Promise<ItemDetailsPayload>;
  /** Asks the backend for the pictures those items name. */
  loadIcons: (iconFileDataIds: number[]) => Promise<IconsPayload>;
  /**
   * Runs the batch, once everything asking in this turn has asked. A microtask by default,
   * and a hook a test can hold open to see what one request ended up carrying.
   */
  schedule?: (run: () => void) => void;
}

export interface ItemBook {
  /**
   * Puts `ids` in the next request and watches for what comes back, until the function it
   * hands back is called.
   *
   * Every item on screen calls this for itself, which is why the request is batched rather
   * than sent: twenty items in a segment are one lookup, and the read behind it opens the
   * game's sixty-three megabyte table once for however many ids it carries. `changed` fires
   * when the words arrive and again when the pictures do — two reads, and a list of items is
   * worth reading while the second is still going — and it fires for a row whose item some
   * other row asked after first, which is what makes the same item on two rows draw twice
   * rather than once.
   *
   * The unsubscribe shape is React's own: an effect returns it and the row stops listening
   * when it leaves the screen.
   */
  learn: (ids: number[], changed: () => void) => () => void;
  detail: (id: number) => ItemDetail | undefined;
  /** The picture for an item, once it has arrived. */
  icon: (id: number) => string | undefined;
}

/**
 * The items this window has been told about, and their pictures.
 *
 * What the game says about an item cannot change under a running app, and a reader walking
 * their history meets the same items over and over — a set collected piece by piece, a
 * favourite weapon transmogged onto everything — so an id is asked about once. The backend
 * remembers them too; this saves the round trip as well.
 *
 * A lookup that fails is forgotten rather than remembered as nothing: the reasons are the ones
 * that stop the whole game folder being readable — it has not been chosen yet, or it is
 * mid-patch — and those are worth one more try when the reader opens the next segment. It is
 * never reported, because a row that says what the addon recorded is what the app showed
 * before any of this, and an apology in its place would be worse.
 */
export function createItemBook(
  { load, loadIcons, schedule = queueMicrotask }: ItemBookOptions,
): ItemBook {
  const known = new Map<number, ItemDetail>();
  const icons = new Map<number, string>();
  /** Ids a request has already been made for, whatever it came back with. */
  const asked = new Set<number>();
  /** Textures a request has already been made for, likewise. */
  const askedIcons = new Set<number>();

  /** What the next request will carry, and everything on screen waiting to hear about it. */
  let pending = new Set<number>();
  let sending = false;
  const listeners = new Set<() => void>();

  /**
   * Says that something new has arrived, to everything currently on screen.
   *
   * To all of them rather than to whoever asked, because who asked is not who is waiting: the
   * same item can be on two rows, and only the first of them puts it in the request.
   */
  const tell = (): void => {
    for (const listener of [...listeners]) listener();
  };

  /** Sends whatever has piled up since the last request, as one request. */
  async function send(ids: number[]): Promise<void> {
    try {
      const payload = await load(ids);
      for (const [id, detail] of Object.entries(payload.items ?? {})) known.set(Number(id), detail);
    } catch {
      for (const id of ids) asked.delete(id);
      return;
    }
    tell();

    const pictures = [...new Set(ids.map((id) => known.get(id)?.iconFileDataId ?? 0))]
      .filter((fdid) => fdid > 0 && !askedIcons.has(fdid));
    if (!pictures.length) return;
    for (const fdid of pictures) askedIcons.add(fdid);
    try {
      const payload = await loadIcons(pictures);
      for (const [fdid, url] of Object.entries(payload.icons ?? {})) icons.set(Number(fdid), url);
    } catch {
      for (const fdid of pictures) askedIcons.delete(fdid);
      return;
    }
    tell();
  }

  function learn(ids: number[], changed: () => void): () => void {
    listeners.add(changed);
    for (const id of ids) {
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
  }

  return {
    learn,
    detail: (id) => known.get(id),
    icon: (id) => {
      const fdid = known.get(id)?.iconFileDataId;
      return fdid ? icons.get(fdid) : undefined;
    },
  };
}
