/**
 * The one floating tooltip, shared by everything on the page that carries a `data-tip`.
 *
 * One element and one pair of listeners rather than a tooltip per circle: the things wearing
 * a tip are redrawn constantly — every activity edit repaints a whole view — and a tooltip
 * that had to be re-attached on each repaint would be a tooltip that sometimes was not.
 *
 * It is positioned through `style` on the element rather than through React state, and
 * deliberately: the tip follows the pointer, so it moves on every mousemove, and rendering
 * the whole app at that rate to move one box is work nobody asked for.
 */

import "./tooltip.css";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/** The nearest thing carrying a tip, for an event that may have fired on the document. */
function hostOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
}

function anchorOf(host: HTMLElement): { x: number; y: number } {
  const box = host.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top };
}

/**
 * Wires the tooltip to everything carrying `data-tip`, by delegation. The tip's value is
 * trusted HTML built by whoever drew the element — the one place that still builds any, and
 * it escapes the character's own name on the way in.
 */
export function Tooltip(): ReactNode {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tooltip = element.current;
    if (!tooltip) return;

    const hide = (): void => { tooltip.style.opacity = "0"; };
    const show = (event: Event): void => {
      const host = hostOf(event.target);
      if (!host) return hide();
      tooltip.innerHTML = host.dataset.tip ?? "";
      tooltip.style.opacity = "1";
      const box = tooltip.getBoundingClientRect();
      // Focus has no pointer position of its own, so the tip is hung off the element instead.
      const pointer = event as MouseEvent;
      const anchor = pointer.clientX ? { x: pointer.clientX, y: pointer.clientY } : anchorOf(host);
      tooltip.style.left = `${Math.max(Math.min(anchor.x + 14, window.innerWidth - box.width - 8), 8)}px`;
      tooltip.style.top = `${Math.max(anchor.y - box.height - 12, 8)}px`;
    };
    const focused = (event: FocusEvent): void => {
      if (hostOf(event.target)) show(event);
    };

    document.addEventListener("mousemove", show);
    document.addEventListener("mouseleave", hide);
    document.addEventListener("focusin", focused);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mousemove", show);
      document.removeEventListener("mouseleave", hide);
      document.removeEventListener("focusin", focused);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
    };
  }, []);

  // Named as well as live, because the window is full of status lines and this is the only one
  // that is about wherever the pointer happens to be.
  return <div id="tooltip" role="status" aria-label="What the pointer is on" ref={element} />;
}
