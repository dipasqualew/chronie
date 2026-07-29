/**
 * The second browser: every look the game holds for one kind of place.
 *
 * A flat list rather than a grid of cards, because there is nothing to group five thousand
 * heads by — so a row is found by what its button would do, which is put the thing on her.
 */

import type { Locator, Page } from "@playwright/test";

import { TransmogView } from "./transmog";

export class Wardrobe {
  readonly page: Page;
  readonly list: Locator;

  constructor(page: Page) {
    this.page = page;
    this.list = new TransmogView(page).view.getByRole("region", {
      name: "Every look the game holds",
    });
  }

  /** What is drawn right now, which is a page of it rather than the whole kind. */
  rows(): Locator {
    return this.list.getByRole("list", { name: "Appearances" }).getByRole("listitem");
  }

  /** Whatever the list says about itself, found by the words on it. */
  saying(text: string | RegExp): Locator {
    return this.list.getByText(text);
  }

  /** Which kind of place is being browsed: an armour slot, or a kind of thing held. */
  kind(): Locator {
    return this.list.getByLabel("Kind of appearance");
  }

  search(): Locator {
    return this.list.getByLabel("Filter appearances");
  }

  klass(): Locator {
    return this.list.getByLabel("Class");
  }

  /** The button on one row, which puts that look on the character or takes it off again. */
  wear(slot: string, label: string): Locator {
    return this.list.getByRole("button", { name: `Wear ${slot}: ${label}` });
  }

  /** One row, found by the look it is for — by its star's name, which is exact. */
  row(label: string): Locator {
    return this.rows().filter({
      has: this.page.getByRole("button", { name: `Favourite ${label}`, exact: true }),
    });
  }

  /** The star on that row, which is against the look — the same one a set's row carries. */
  star(label: string): Locator {
    return this.row(label).getByRole("button", { name: `Favourite ${label}`, exact: true });
  }

  /** What the reader has said about the look, as the chips read. */
  tags(label: string): Locator {
    return this.row(label).getByRole("button", { name: /^Filter by the tag / });
  }

  favouritesOnly(): Locator {
    return this.list.getByRole("checkbox", { name: "Favourites only" });
  }

  tagFilter(): Locator {
    return this.list.getByLabel("Tag", { exact: true });
  }

  /** How far down the kind the reader has got, and what the game would not say. */
  count(): Locator {
    return this.list.getByRole("status", { name: "How much of the wardrobe is shown" });
  }

  /** The switch between a list of names and a grid of the character wearing each of them. */
  asModels(): Locator {
    return this.list.getByRole("checkbox", { name: "Show worn" });
  }

  /** The pictures themselves, one per tile, once the gallery is on. */
  bodies(): Locator {
    return this.list.getByRole("img", { name: /, drawn$/ });
  }

  /**
   * How many of those actually have a character on them.
   *
   * @see pixelsOf for reading one of them rather than counting all of them.
   *
   * Counted from the pixels and not from the elements, and that is the whole point of it. A
   * canvas that was never drawn on is the same rectangle in the DOM as one that was, and the way
   * this fails is silent: a window making a graphics context per row gets about sixteen out of a
   * browser and then loses the ones it made first, so the grid fills in at the bottom and goes
   * blank at the top. Reading the alpha channel is what tells those two apart.
   */
  async painted(): Promise<number> {
    return this.bodies().evaluateAll(
      (canvases) =>
        canvases.filter((canvas) => {
          const picture = (canvas as HTMLCanvasElement).getContext("2d");
          if (!picture) return false;
          const { width, height } = canvas as HTMLCanvasElement;
          if (!width || !height) return false;
          const { data } = picture.getImageData(0, 0, width, height);
          // Any pixel that is not fully transparent. The stage draws on a transparent background,
          // so "something was drawn here" is exactly "some alpha is not zero".
          for (let at = 3; at < data.length; at += 4) if (data[at] !== 0) return true;
          return false;
        }).length,
    );
  }
}

/**
 * What is actually on one canvas, as something two readings can be compared by.
 *
 * A picture that turned and a picture that did not are the same element with the same
 * attributes and the same size, so the only way to tell them apart from outside is to look at
 * the pixels. `toDataURL` is the whole canvas as one string, which is exactly the comparison
 * wanted here — not what it looks like, only whether it changed.
 */
export async function pixelsOf(canvas: Locator): Promise<string> {
  return canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
}
