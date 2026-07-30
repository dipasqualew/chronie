/**
 * Opening and closing a `<dialog>`, which React has no prop for.
 *
 * `showModal` is what puts an element in the top layer, over its own backdrop, with everything
 * behind it inert and Escape wired up — and it is a method rather than an attribute. The `open`
 * attribute React *can* set gives none of that: it shows the element in the flow of the page. So
 * the four dialogs in this app are driven imperatively, from an effect, and each of them had
 * written out the same four lines to do it.
 *
 * Those four lines have one rule in them and it is the whole reason this is shared: **`showModal`
 * throws `InvalidStateError` on an element that is already open, and `close` fires a `close` event
 * on one that is already closed.** So neither may be called on the strength of a prop alone —
 * `element.open` is the state of record, and it is the element's rather than React's. Which matters
 * exactly when an effect runs more than once for the same prop: React tears effects down and sets
 * them up again to prove the teardown is real, and development Strict Mode does it to every effect
 * in the app. A second `showModal` on a dialog already showing is an exception in the console and
 * a modal that does not open.
 *
 * The reverse direction is not here, because it belongs to whoever is showing the dialog: Escape
 * closes a dialog without asking anybody, and the browser fires `close` when it does. Every caller
 * listens for that and puts its own state back — `onClose` on the element.
 *
 * A click on the backdrop, on the other hand, does *nothing* at all: `showModal` paints the page
 * behind the dialog and swallows the click, and every browser leaves closing on it to the page.
 * [`lightDismiss`] is that, for the dialogs where clicking away is what a reader expects — see the
 * comment on it for why it is not simply "the click was not inside".
 */

import { useEffect, useRef } from "react";
import type { MouseEvent, RefObject } from "react";

/**
 * A ref for a `<dialog>`, kept open exactly while `open` says so.
 *
 * Idempotent in both directions: called again for a state the element is already in, it does
 * nothing at all. That is what makes it safe to run twice, which is the only guarantee the
 * `<dialog>` element itself does not offer.
 */
/**
 * Whether a click on a dialog landed outside the dialog itself, and should therefore close it.
 *
 * Read off the pointer rather than off `event.target`, and that is the whole of the difference
 * between this working and not. The backdrop is not an element: a click on it arrives with the
 * `<dialog>` as its target, which makes `target === dialog` look like the test — until a reader
 * drags a selection across the modal's own padding, or releases the mouse on the gap between two
 * sections, and the same target closes a modal they were reading. Both of those land *inside* the
 * dialog's box, and the pointer is what says so.
 *
 * A click with no coordinates at all — the keyboard's own, which is what a `<button>` fires for
 * Enter and Space — reports 0,0 and is never a dismissal. So it is checked for first.
 */
export function lightDismiss(event: MouseEvent<HTMLDialogElement>): boolean {
  if (event.detail === 0) return false;
  const box = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  );
}

export function useModalDialog(open: boolean): RefObject<HTMLDialogElement | null> {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return dialog;
}
