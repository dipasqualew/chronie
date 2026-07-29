/**
 * Links out of the window.
 *
 * A web page has nowhere to go inside a Tauri window. There is no second window for a link
 * to open in, so `target="_blank"` does nothing at all, and following it in place would
 * replace the app with wowhead and leave no way back. So a click on an external link never
 * travels: it is caught here and handed to the operating system, which opens it in whichever
 * browser the reader already uses.
 */

/** The links that belong to a browser rather than to the page. */
const EXTERNAL = /^(https?|mailto):/i;

/** As much of an anchor as this needs, so a test can hand it one without a document. */
export interface Linkish {
  getAttribute(name: string): string | null;
}

/** As much of a click as this needs: what was clicked, and the chance to answer it. */
export interface ClickLike {
  target: unknown;
  preventDefault(): void;
}

/**
 * What clicks are heard on. The document in the window; something smaller in a test.
 *
 * Both halves, because a listener that can only be added is a listener the window is stuck
 * with: React sets an effect up, tears it down and sets it up again to find exactly that, and
 * the second install would answer every click twice — two calls to the operating system, two
 * browser tabs on one click.
 */
export interface ClickSource {
  addEventListener(type: "click", listener: (event: ClickLike) => void): void;
  removeEventListener(type: "click", listener: (event: ClickLike) => void): void;
}

/** The url a click should leave the window with, or nothing when it stays inside. */
export function externalUrl(anchor: Linkish | null | undefined): string | null {
  const href = anchor?.getAttribute("href")?.trim();
  return href && EXTERNAL.test(href) ? href : null;
}

/** The link a click happened inside, which is rarely the element the click landed on. */
export const closestLink = (target: unknown): Linkish | null =>
  target instanceof Element ? target.closest("a[href]") : null;

export interface ExternalLinkOptions {
  /** One listener here also covers the dialogs: a click bubbles out of a `<dialog>`. */
  root: ClickSource;
  /** Hands the url to the operating system. */
  open: (url: string) => Promise<unknown>;
  /** How a click's target is resolved to the link it happened inside. */
  linkOf?: (target: unknown) => Linkish | null;
  /** Told when the operating system would not take it, so a dead link is not silent. */
  onFailure?: (url: string, error: unknown) => void;
}

/**
 * Answers every click on an external link, wherever in the window it happens — including in
 * markup that has not been written yet, which is why it listens at the root rather than
 * binding each anchor as it is drawn.
 *
 * Answers with the way to stop: the shape React's effects take, and the reason they can be
 * trusted to. One click on one link has to reach the operating system exactly once, and the
 * only thing that can promise that is an installer that can be uninstalled.
 */
export function installExternalLinks(options: ExternalLinkOptions): () => void {
  const { root, open, linkOf = closestLink, onFailure } = options;
  const answer = (event: ClickLike): void => {
    const url = externalUrl(linkOf(event.target));
    if (!url) return;
    // The click is answered here or nowhere: left alone it either does nothing at all, or
    // takes the whole app to the page.
    event.preventDefault();
    void Promise.resolve(open(url)).catch((error: unknown) => onFailure?.(url, error));
  };
  root.addEventListener("click", answer);
  return () => root.removeEventListener("click", answer);
}
