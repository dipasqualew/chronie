/**
 * One transmog set, opened: what the game says it is made of.
 *
 * The grid can only count a set's appearances, because that is all `TransmogSetItem` holds.
 * Following one of them to an actual item takes three more of the game's tables, which the
 * backend walks on demand — so this is the one view that asks for something after the page
 * has loaded, and the one that has a loading state and a failure to draw.
 *
 * There are no names here yet, only ids and a way through to Wowhead. That is deliberate:
 * item names live in a table the DB2 reader cannot open yet, and a row that says which slot
 * it fills, shows the game's own picture of it and links out is worth opening a set for.
 *
 * The icons arrive after the rows do. Decoding a set's worth of textures takes longer than
 * reading the tables that named them, and a list of slots is worth looking at while that
 * happens — so a row draws an empty frame and fills it in when its picture turns up, or
 * leaves it empty for good if the install has nothing to put there.
 */

import { escapeHtml, plural } from "./format";
import { classLabel, expansionName, patchName } from "./transmog";
import type {
  TransmogAppearance,
  TransmogIconsPayload,
  TransmogSet,
  TransmogSetItemsPayload,
} from "./types";

/**
 * The slot an appearance fills, as `ItemAppearance.DisplayType` numbers them.
 *
 * The names are the community's, recorded in `docs/game-files.md`; which of them carry a
 * model of their own was verified against a real install, the naming was not. The values
 * past this list are weapons and shields, which the definitions do not pin down well enough
 * to name one by one.
 */
const SLOTS = [
  "Head", "Shoulder", "Chest", "Waist", "Legs", "Feet", "Wrist", "Hands", "Back",
  "Tabard", "Shirt",
] as const;

/** The display types that are a weapon or a shield rather than a piece of armour. */
const WEAPONRY = new Set([11, 12, 13, 15]);

export function slotName(displayType: number): string {
  return SLOTS[displayType] ?? (WEAPONRY.has(displayType) ? "Weapon or shield" : `Slot ${displayType}`);
}

/** One appearance as a row reads it, with everything the markup needs already decided. */
export interface AppearanceRow {
  slot: string;
  /** What names the row. An id until item names arrive, and a plain apology before that. */
  label: string;
  itemId: number;
  appearanceId: number;
  /** Which texture is the row's picture, or zero when the game names none for it. */
  iconFileDataId: number;
  hasModel: boolean;
  /** True when the game encrypts a hop of the chain, so nothing can be said about it. */
  withheld: boolean;
}

/**
 * The rows a payload draws as, in the order the backend already sorted them.
 *
 * An appearance the game withholds keeps its place rather than being dropped, because the
 * set's own count includes it and a list one shorter than the card promised reads as a bug.
 */
export function appearanceRows(payload: TransmogSetItemsPayload): AppearanceRow[] {
  return (payload.appearances || []).map((appearance: TransmogAppearance) => {
    const withheld = !appearance.itemId;
    return {
      slot: withheld ? "Unknown slot" : slotName(appearance.displayType),
      label: withheld ? "The game keeps this appearance encrypted" : `Item ${appearance.itemId}`,
      itemId: appearance.itemId,
      appearanceId: appearance.appearanceId,
      iconFileDataId: appearance.iconFileDataId,
      hasModel: appearance.hasModel,
      withheld,
    };
  });
}

/**
 * The textures a set's rows need, without the repeats.
 *
 * A set names the same appearance twice often enough, and two slots of one set can share a
 * picture, so asking per row would ask for the same texture several times over. Zero is what
 * an appearance the tables give no icon carries, and there is no file behind it.
 */
export function iconIds(payload: TransmogSetItemsPayload): number[] {
  const wanted = (payload.appearances || []).map((appearance) => appearance.iconFileDataId);
  return [...new Set(wanted)].filter((id) => id > 0);
}

/** How the set's contents read as one line: how many, and how many could not be named. */
export function appearanceSummary(payload: TransmogSetItemsPayload): string {
  const total = (payload.appearances || []).length;
  if (!total) return "The game lists no appearances for this set.";
  const withheld = payload.withheldCount > 0
    ? ` · ${payload.withheldCount} the game keeps encrypted`
    : "";
  return `${plural(total, "appearance")}${withheld}`;
}

export interface TransmogModalOptions {
  dialog: HTMLDialogElement;
  /** Asks the backend what a set is made of. Injected so the modal is drivable without one. */
  load: (setId: number) => Promise<TransmogSetItemsPayload>;
  /** Asks the backend for the pictures those rows need, decoded out of the game's textures. */
  loadIcons: (iconFileDataIds: number[]) => Promise<TransmogIconsPayload>;
}

export interface TransmogModal {
  /** Opens the modal on a set and starts reading it, if it has not been read already. */
  open: (set: TransmogSet) => void;
  isOpen: () => boolean;
}

/** The dialog's own furniture, which index.html is required to carry. */
function part(dialog: HTMLDialogElement, selector: string): HTMLElement {
  const found = dialog.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`The transmog detail dialog is missing ${selector}.`);
  return found;
}

export function createTransmogModal(
  { dialog, load, loadIcons }: TransmogModalOptions,
): TransmogModal {
  // What a set is made of never changes under a running app — it is read out of the
  // installed game — so a set opened twice is read once.
  const known = new Map<number, TransmogSetItemsPayload>();
  // The pictures, by the id the rows name them by. Kept beside the sets rather than inside
  // them because sets share their icons: a collection's tier variants are the same textures
  // throughout, so a set opened after its neighbour draws complete straight away.
  const pictures = new Map<number, string>();
  let showing: number | null = null;

  function open(set: TransmogSet): void {
    showing = set.id;
    part(dialog, ".detail-title").textContent = set.name || `Set ${set.id}`;
    part(dialog, ".detail-position").textContent = [
      set.group,
      classLabel(set.classMask),
      expansionName(set.expansionId),
      patchName(set.patchIntroduced) ? `Patch ${patchName(set.patchIntroduced)}` : "",
    ].filter(Boolean).join(" · ");
    if (!dialog.open) dialog.showModal();

    const cached = known.get(set.id);
    if (cached) return draw(cached);

    part(dialog, ".detail-body").innerHTML =
      '<p class="muted">Reading what the set is made of…</p>';
    void load(set.id)
      .then((payload) => {
        known.set(set.id, payload);
        // A reader who clicked through to another set while this one was still being read
        // is looking at that one; landing this on top of it would be a jump they did not ask
        // for.
        if (showing === set.id) draw(payload);
      })
      .catch((error: unknown) => {
        if (showing !== set.id) return;
        part(dialog, ".detail-body").innerHTML =
          `<p class="muted">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
      });
  }

  function draw(payload: TransmogSetItemsPayload): void {
    const rows = appearanceRows(payload);
    part(dialog, ".detail-body").innerHTML = `
      <p class="detail-facts">${escapeHtml(appearanceSummary(payload))}</p>
      ${rows.length ? `<ul class="mog-items">${rows.map(line).join("")}</ul>` : ""}
    `;
    fillIcons();

    const wanted = iconIds(payload).filter((id) => !pictures.has(id));
    if (wanted.length === 0) return;
    void loadIcons(wanted)
      .then((payload) => {
        for (const [id, url] of Object.entries(payload.icons || {})) pictures.set(Number(id), url);
        fillIcons();
      })
      // An icon is the one thing on a row that can be missing without the row losing its
      // point, so a picture that will not come stays an empty frame rather than an error
      // where the set used to be.
      .catch(() => {});
  }

  /**
   * Puts every picture now in hand into the frame waiting for it.
   *
   * By the id in the frame's own attribute rather than by position, so this stays right for
   * whichever set is on screen — a reader who opened another one while the first was still
   * decoding gets the icons of the set they are actually looking at.
   */
  function fillIcons(): void {
    for (const frame of dialog.querySelectorAll<HTMLElement>(".mog-icon[data-icon]")) {
      const url = pictures.get(Number(frame.dataset.icon));
      if (!url || frame.firstElementChild) continue;
      const picture = new Image();
      // Decorative: the row already says which slot it is and which item it came from, and
      // the game gives its textures no description worth reading out.
      picture.alt = "";
      picture.src = url;
      frame.replaceChildren(picture);
    }
  }

  part(dialog, '[data-role="close"]').addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { showing = null; });

  return { open, isOpen: () => dialog.open };
}

/** One appearance, pictured and named as far as the tables allow, and linked out for the rest. */
function line(row: AppearanceRow): string {
  const name = row.withheld
    ? `<span class="muted">${escapeHtml(row.label)}</span>`
    : `<a href="https://www.wowhead.com/item=${encodeURIComponent(row.itemId)}"
        target="_blank" rel="noopener noreferrer">${escapeHtml(row.label)}</a>`;
  // An empty frame either way. A row whose appearance names no icon keeps it so the list
  // stays a column of pictures rather than one that indents wherever the game said nothing.
  const icon = row.iconFileDataId
    ? `<span class="mog-icon" data-icon="${escapeHtml(row.iconFileDataId)}"></span>`
    : '<span class="mog-icon"></span>';
  return `<li class="mog-item">
    ${icon}
    <span class="badge">${escapeHtml(row.slot)}</span>
    ${name}
    ${row.hasModel ? '<span class="chip">has its own model</span>' : ""}
    ${row.appearanceId ? `<span class="muted">appearance ${escapeHtml(row.appearanceId)}</span>` : ""}
  </li>`;
}
