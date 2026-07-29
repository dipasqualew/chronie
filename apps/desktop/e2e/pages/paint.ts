/**
 * What the browser actually drew, read back off elements a page object handed over.
 *
 * These are readings rather than locators, which is why they take one instead of finding one:
 * what a class colour comes to on screen is a question about an element somebody has already
 * asked for by name.
 *
 * Computed rather than read off the markup, and that is the whole point of them. A class colour
 * reaches the screen through a custom property and a rule in the stylesheet that names it, and
 * only the browser can say the two ever met — a rule that washed the colour down to nothing, or
 * never named it at all, is invisible from the markup and plain here.
 */

import type { Locator } from "@playwright/test";

/** The colour each of a set of elements is ringed in. */
export const borderColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderTopColor));

/** The colour each of them is filled with, which is where a 22% wash would show. */
export const fillColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));

/** The colour each writes its text in, which is the half that has to read against the fill. */
export const inkColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));

/**
 * The colour of the rail down the left edge of each of a set of elements.
 *
 * The rail is an inset box-shadow rather than a border, so that the hairline holding a
 * priest's white apart from the card can sit inside it. Its first layer is the class colour
 * and the second is that hairline, which is why only the first is read.
 */
export const railColours = (elements: Locator): Promise<string[]> =>
  elements.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? ""),
  );

/**
 * How much of each element in a row the one after it covers, as a fraction of its own width.
 * The last has nothing on top of it and so has no fraction of its own.
 *
 * Only the browser does layout, so only the browser can say whether a stacked cast still
 * reads. And the bounding box alone cannot say it: the rings are drawn with `box-shadow`,
 * which occupies no space, so a circle paints further than it measures. The ring is read
 * back off the element rather than assumed, which is the point — the overlap has to be
 * judged against what a circle actually covers, whatever it happens to be wearing.
 */
export const overlapFractions = (elements: Locator): Promise<number[]> =>
  elements.evaluateAll((nodes) => {
    const ringOf = (node: Element): number => {
      const spreads = [
        ...getComputedStyle(node).boxShadow.matchAll(/(?:-?[\d.]+px\s+){3}(-?[\d.]+)px/g),
      ].map((layer) => Number(layer[1]));
      return Math.max(0, ...spreads);
    };
    return nodes.slice(0, -1).map((node, index) => {
      const next = nodes[index + 1]!;
      const box = node.getBoundingClientRect();
      const covered = box.right - (next.getBoundingClientRect().left - ringOf(next));
      return Math.max(0, covered) / box.width;
    });
  });
