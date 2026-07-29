/**
 * The timeline: play sessions down a spine, newest first, each one a card that summarises an
 * evening and unfolds into what it counted.
 *
 * A session is an article named after the day and the hour it started, which is how a reader
 * finds one and the only thing a screen reader reads out of the row of them. Everything inside
 * a card is asked for within that article — the cast, the activities, the running totals — so
 * two evenings on screen never answer for each other.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { Shell } from "./shell";

export class Timeline {
  readonly page: Page;
  readonly view: Locator;

  constructor(page: Page) {
    this.page = page;
    this.view = new Shell(page).view("Timeline");
  }

  async open(): Promise<void> {
    await expect(this.view.getByRole("heading", { name: "Timeline", level: 1 })).toBeVisible();
  }

  /** How much history is on screen, as the line under the heading reads it. */
  summary(): Locator {
    return this.view.getByRole("status", { name: "What the timeline holds" });
  }

  /** The evenings, newest first. */
  sessions(): Locator {
    return this.view.getByRole("article", { name: /^Play session / });
  }

  /**
   * Who played that evening, as the row of class circles.
   *
   * Asked of the group the card puts them in rather than of every named picture on it: the
   * running totals are marks too, and a card that earned gold and reputation would otherwise
   * report a cast of five for an evening two characters played.
   */
  cast(session: Locator): Locator {
    return session.getByRole("group", { name: "Who played" }).getByRole("img");
  }

  /** The evening's activities, which are the first thing a card says. */
  activities(session: Locator): Locator {
    return session.getByRole("list", { name: "What was done" }).getByRole("button");
  }

  /**
   * The quieter half of a card: the small change of an evening beside its running numbers.
   *
   * One strip rather than two, because a quest handed in and a faction ground are equally not
   * the news — so this is where both are asked for. Private: a spec asks for one or the other
   * by what it is, and the strip they share is only how this file finds them.
   */
  private quiet(within: Locator): Locator {
    return within.getByRole("group", { name: "The quieter marks" });
  }

  /**
   * The running numbers in it, folded to one mark per kind with the figures in the hover.
   *
   * The pictures alone, which is still only the numbers: a mark that stands for something that
   * happened is pressable and is therefore a button, and `mark` is how those are asked for.
   */
  tallies(session: Locator): Locator {
    return this.quiet(session).getByRole("img");
  }

  /**
   * One of the marks that stand for something that happened, by the sentence it gave up.
   *
   * By the whole of that sentence, because a mark carries none of it on the card: the words a
   * chip would have worn are its hover and its name and nowhere else.
   */
  mark(within: Locator, saying: string | RegExp): Locator {
    return this.quiet(within).getByLabel(saying);
  }

  /**
   * One of those marks, found by the kind of number it stands for.
   *
   * By the whole of what it is announced as — "Currency: Warband Chit +100, …" — because that
   * name is the only place the figures survive at all once the strip is drawn as icons.
   */
  tally(session: Locator, kind: string): Locator {
    return session.getByRole("img", { name: new RegExp(`^${kind}: `) });
  }

  /** The segment rows an opened card unfolds into, which the roster draws too. */
  segments(session: Locator): Locator {
    return session.getByRole("button", { name: /^Open segment:/ });
  }

  /**
   * The picture the game draws a place with, on the row that happened there.
   *
   * Found by the place it is of, because that is the only thing the frame says: the row names
   * the place beside it, so a picture that announced itself as well would have a screen reader
   * read every row twice. Where the game draws nothing — the open world, which is most of a
   * history — there is no frame at all, and asking for one is how a spec says so.
   */
  placeIcon(segment: Locator, place: string): Locator {
    return segment.getByRole("img", { name: `Icon for ${place}` });
  }

  /** The fold on a card, by what it says it holds: "2 segments", "3 screenshots". */
  fold(session: Locator, saying: string | RegExp): Locator {
    return session.getByRole("button", { name: saying });
  }

  /** A summary chip, by the words on it — "2 levels", "Clockwork Glider". */
  chip(session: Locator, saying: string | RegExp): Locator {
    return session.getByRole("button", { name: saying });
  }

  /** One of the things a summary unfolded into, which is a way back to its segment. */
  unfolded(session: Locator, name: string): Locator {
    return session.getByRole("button", { name: `Open the segment ${name} was recorded in` });
  }
}
