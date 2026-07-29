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
 * and the backdrop close a dialog without asking anybody, and the browser fires `close` either
 * way. Every caller listens for that and puts its own state back — `onClose` on the element.
 */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * A ref for a `<dialog>`, kept open exactly while `open` says so.
 *
 * Idempotent in both directions: called again for a state the element is already in, it does
 * nothing at all. That is what makes it safe to run twice, which is the only guarantee the
 * `<dialog>` element itself does not offer.
 */
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
