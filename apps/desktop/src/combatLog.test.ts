import { describe, expect, it, vi } from "vitest";
import { createCombatLogging, evidence, stateSentence } from "./combatLog";
import type { CombatLogActions } from "./combatLog";
import type { CombatLogStatus } from "./types";

/** The moment every sentence below is reckoned from, so "3 days ago" is a fact, not a clock. */
const NOW = 1_785_000_000;

const HOUR = 3600;
const DAY = 86_400;

/** An install doing the thing properly: asked for, ticked, and writing. */
const status = (overrides: Partial<CombatLogStatus> = {}): CombatLogStatus => ({
  requested: true,
  advanced: true,
  source: "WTF/Account/EXAMPLE/config-cache.wtf",
  log: { name: "WoWCombatLog-072612_183012.txt", bytes: 4_404_019, modified: NOW - HOUR },
  growing: true,
  state: "advanced",
  ...overrides,
});

describe("stateSentence", () => {
  it("says nothing is being written, and nothing costs, when the switch is off", () => {
    const sentence = stateSentence(status({ requested: false, state: "off", growing: false }), NOW);

    expect(sentence).toContain("Combat logging is off");
    expect(sentence).toContain("nothing is using disk");
  });

  // The setting and the install are two different facts, and this is the case where they
  // disagree. Saying only "off" here would have the panel deny a file that is growing on the
  // reader's own disk — which is the one thing a status line must never do.
  it("owns up to an install that is logging without Chronie having asked", () => {
    const sentence = stateSentence(status({ requested: false, state: "off", growing: true }), NOW);

    expect(sentence).toContain("writing a combat log anyway");
    expect(sentence).toContain("outside Chronie");
    expect(sentence).not.toContain("nothing is using disk");
  });

  // A log without the advanced flag has no positions in it, so it is useless for the thing
  // Chronie wants it for — and the fix is a box in the game, named here as the game names it.
  it("names the box to tick when logging is on without the advanced flag", () => {
    const sentence = stateSentence(status({ state: "basic", advanced: false, growing: false }), NOW);

    expect(sentence).toContain("advanced combat logging is off");
    expect(sentence).toContain("no positions");
    expect(sentence).toContain("Advanced Combat Logging");
    expect(sentence).toContain("Network");
    expect(sentence).not.toContain("could not read");
  });

  // Not knowing is its own answer. A config nothing could be read out of is the reason the
  // field is nullable at all, and reporting it as "off" would send a reader to tick a box
  // that may well already be ticked.
  it.each<[string, CombatLogStatus]>([
    ["a config that read back as nothing", status({ state: "basic", advanced: null, growing: false })],
    // The same install described by a backend that left the field out altogether.
    ["a status that never mentioned it", { requested: true, growing: false, state: "basic" }],
  ])("admits it cannot confirm the advanced flag given %s", (_case, unknown) => {
    const sentence = stateSentence(unknown, NOW);

    expect(sentence).toContain("could not read the game's settings");
    expect(sentence).toContain("cannot confirm advanced logging");
    expect(sentence).not.toContain("advanced combat logging is off");
  });

  it("simply confirms an install that is doing it properly", () => {
    expect(stateSentence(status(), NOW))
      .toBe("Advanced combat logging is on, and the game is writing to it.");
  });

  // How long ago is the whole content of this one: "nothing since Tuesday" is a problem and
  // "nothing for ten minutes" is a game that happens to be shut.
  it("carries how long a set-up install has been writing nothing", () => {
    const sentence = stateSentence(
      status({ state: "stale", growing: false, log: { name: "WoWCombatLog.txt", bytes: 12, modified: NOW - 3 * DAY } }),
      NOW,
    );

    expect(sentence).toContain("nothing has been written 3 days ago");
    expect(sentence).toContain("if you have been playing since, the game is not logging");
  });

  // A machine that will not date a file leaves nothing to reckon an age from, and reckoning
  // one from the epoch would put "20659 days ago" on screen — a number that is not only
  // wrong but reads as a catastrophe.
  it("admits it cannot date a log this machine will not date", () => {
    const sentence = stateSentence(
      status({
        state: "stale",
        growing: false,
        log: { name: "WoWCombatLog.txt", bytes: 12, modified: null },
      }),
      NOW,
    );

    expect(sentence).toContain("will not say when the log was last written");
    expect(sentence).not.toContain("ago");
  });

  it("says an install with no log at all has none, rather than dating one that does not exist", () => {
    const sentence = stateSentence(status({ state: "stale", growing: false, log: null }), NOW);

    expect(sentence).toContain("no combat log at all yet");
    expect(sentence).toContain("the next time you log in");
    expect(sentence).not.toContain("ago");
  });
});

describe("evidence", () => {
  it("names the newest log, its size and its age, so the sentence above can be checked", () => {
    expect(evidence(status(), NOW)[0])
      .toBe("Newest log: WoWCombatLog-072612_183012.txt — 4.2 MB, last written an hour ago.");
  });

  it("says outright when the game's Logs folder holds nothing", () => {
    expect(evidence(status({ log: null }), NOW)[0])
      .toBe("No combat log found in the game's Logs folder.");
  });

  // A filesystem that will not date a file still has one, and the row is worth keeping: the
  // name and the size are the two things a reader can go and look at.
  it("keeps a log a filesystem will not date, and says the date is what is missing", () => {
    expect(evidence(status({ log: { name: "WoWCombatLog.txt", bytes: 900, modified: null } }), NOW)[0])
      .toBe("Newest log: WoWCombatLog.txt — 900 bytes, with no date this machine will report.");
  });

  it.each<[boolean, string]>([
    [true, "Advanced logging reads on in WTF/Account/EXAMPLE/config-cache.wtf."],
    [false, "Advanced logging reads off in WTF/Account/EXAMPLE/config-cache.wtf."],
  ])("names the file the advanced flag was read out of, reading %s", (advanced, line) => {
    expect(evidence(status({ advanced }), NOW)[1]).toBe(line);
  });

  it("says the advanced flag is unknown when no config could be read", () => {
    expect(evidence(status({ source: null, advanced: null }), NOW)[1])
      .toBe("No game config could be read, so the advanced setting is unknown.");
  });
});

/* ---------- the panel itself ---------- */

/**
 * The checkbox as the panel uses it, with the click a person makes on top.
 *
 * Vitest runs these in node, where there is no document to build a real input in — and there
 * would be little point if there were: the panel only ever reads `checked`, writes `disabled`
 * and listens for `change`, so those three are the whole of what a test has to stand in for.
 */
interface FakeToggle {
  checked: boolean;
  disabled: boolean;
  addEventListener: (type: string, handler: () => void) => void;
  /** What a browser does when the box is clicked: move it, then tell whoever is listening. */
  click: (checked: boolean) => void;
}

function fakeToggle(): FakeToggle {
  const handlers: Array<() => void> = [];
  const toggle: FakeToggle = {
    checked: false,
    disabled: false,
    addEventListener: (_type, handler) => {
      handlers.push(handler);
    },
    click: (checked) => {
      toggle.checked = checked;
      for (const handler of handlers) handler();
    },
  };
  return toggle;
}

/** The two places the panel writes to: a line of text, and a block of markup under it. */
interface FakeElement {
  textContent: string | null;
  innerHTML: string;
  dataset: Record<string, string | undefined>;
}

const fakeElement = (): FakeElement => ({ textContent: null, innerHTML: "", dataset: {} });

/** A promise a test hands the outcome to whenever it likes, to look at the panel mid-change. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** How the error double reports anything that went wrong, recognisable wherever it lands. */
const said = (error: unknown): string => `The install said: ${String(error)}`;

/**
 * The panel over elements a test owns and actions a test answers, which is the only way to
 * drive it: nothing here talks to a backend, and nothing monkey patches one.
 */
function panel(actions: Partial<CombatLogActions> = {}) {
  const toggle = fakeToggle();
  const state = fakeElement();
  const detail = fakeElement();
  const logging = createCombatLogging({
    elements: {
      toggle: toggle as unknown as HTMLInputElement,
      state: state as unknown as HTMLElement,
      detail: detail as unknown as HTMLElement,
    },
    actions: {
      status: () => Promise.resolve(status()),
      set: (enabled) => Promise.resolve(status({ requested: enabled })),
      onError: said,
      ...actions,
    },
  });
  return { toggle, state, detail, logging };
}

describe("createCombatLogging", () => {
  it("ticks the box from the setting and states where the install stands", () => {
    const view = panel();

    view.logging.render(status({ state: "basic", advanced: false, growing: false }));

    expect(view.toggle.checked).toBe(true);
    expect(view.state.textContent).toContain("advanced combat logging is off");
    // The stylesheet colours the line from this, and only from this — a sentence that reads
    // as a problem in the colour of a success is the failure it exists to prevent.
    expect(view.state.dataset.state).toBe("basic");
    expect(view.detail.innerHTML).toContain("WoWCombatLog-072612_183012.txt");
    expect(view.detail.innerHTML).toContain("config-cache.wtf");
  });

  it("unticks the box for an install nothing has asked to log", () => {
    const view = panel();
    view.logging.render(status());

    view.logging.render(status({ requested: false, state: "off", growing: false }));

    expect(view.toggle.checked).toBe(false);
    expect(view.state.dataset.state).toBe("off");
  });

  // A log's name comes off the reader's own disk, and the evidence is written as markup.
  it("puts a log's name into the markup as text rather than as tags", () => {
    const view = panel();

    view.logging.render(status({ log: { name: "<b>log</b>.txt", bytes: 12, modified: NOW } }));

    expect(view.detail.innerHTML).toContain("&lt;b&gt;log&lt;/b&gt;.txt");
    expect(view.detail.innerHTML).not.toContain("<b>");
  });

  it("draws whatever the install answers when asked again", async () => {
    const view = panel({ status: () => Promise.resolve(status({ state: "stale", growing: false, log: null })) });

    await view.logging.refresh();

    expect(view.state.textContent).toContain("no combat log at all yet");
    expect(view.state.dataset.state).toBe("stale");
  });

  // The panel is polled while somebody is looking at it, so a backend that cannot answer must
  // leave a sentence behind rather than an unhandled rejection nobody sees.
  it("reports a question the backend could not answer, without throwing", async () => {
    const view = panel({ status: () => Promise.reject(new Error("no game folder is set")) });

    await expect(view.logging.refresh()).resolves.toBeUndefined();

    expect(view.state.textContent).toBe("The install said: Error: no game folder is set");
  });

  it.each<[string, boolean, string]>([
    ["ticking it", true, "stale"],
    ["unticking it", false, "off"],
  ])("%s tells the backend, then repaints from what that left", async (_case, wanted, expected) => {
    const set = vi.fn((enabled: boolean) => Promise.resolve(status({
      requested: enabled,
      growing: false,
      state: enabled ? "stale" : "off",
    })));
    const view = panel({ set });

    view.toggle.click(wanted);

    await vi.waitFor(() => expect(view.state.dataset.state).toBe(expected));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(wanted);
    expect(view.toggle.checked).toBe(wanted);
    expect(view.toggle.disabled).toBe(false);
  });

  // The game reads the addon's files at load and never again, so the switch does nothing at
  // all until the next login. Saying so while the write is still in flight is the point: a
  // control that silently takes an hour to mean anything is what this copy exists to prevent.
  it.each<[string, boolean, string]>([
    ["on", true, "Turning combat logging on. It starts at your next login or /reload."],
    ["off", false, "Turning combat logging off. It stops at your next login or /reload."],
  ])("says a change to %s waits for the next login while the write is in flight", async (_case, wanted, copy) => {
    const answer = deferred<CombatLogStatus>();
    const view = panel({ set: () => answer.promise });

    view.toggle.click(wanted);

    expect(view.state.textContent).toBe(copy);
    // And nothing can be clicked again in the meantime, so two writes cannot cross.
    expect(view.toggle.disabled).toBe(true);

    answer.resolve(status({ requested: wanted, growing: false, state: wanted ? "stale" : "off" }));
    await vi.waitFor(() => expect(view.toggle.disabled).toBe(false));
    expect(view.state.textContent).not.toBe(copy);
  });

  // The switch stands for what the backend was told. A write that failed changed nothing, so
  // a box left ticked would be the app claiming it had done something it had not.
  it("puts the switch back where it was when the setting could not be written", async () => {
    const view = panel({ set: () => Promise.reject(new Error("the addon folder is read-only")) });

    view.toggle.click(true);

    await vi.waitFor(() => expect(view.toggle.checked).toBe(false));
    expect(view.state.textContent).toBe("The install said: Error: the addon folder is read-only");
    // And it can be tried again, which a switch left disabled could not be.
    expect(view.toggle.disabled).toBe(false);
  });
});
