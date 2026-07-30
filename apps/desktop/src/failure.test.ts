import { describe, expect, it } from "vitest";

import { CommandFailure, codeOf, commandFailure, message, recourse } from "./failure";

import type { CommandError } from "./types";

const failed = (fields: Partial<CommandError> = {}): CommandError => ({
  code: "internal",
  message: "Chronie hit a problem it did not expect.",
  retryable: false,
  ...fields,
});

describe("a failed command as the window reads it", () => {
  it("keeps the code, the sentence and whether asking again is honest", () => {
    const failure = commandFailure(
      failed({ code: "historyBusy", message: "Chronie's history is busy.", retryable: true }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe("historyBusy");
    expect(failure.message).toBe("Chronie's history is busy.");
    expect(failure.retryable).toBe(true);
  });

  it("passes an already-converted failure straight through", () => {
    const once = commandFailure(failed({ code: "notFound" }));

    expect(commandFailure(once)).toBe(once);
  });

  /**
   * Not every rejection is a command's. A Tauri call can fail before it reaches one, and the
   * browser fixture rejects with a plain `Error` — neither is worth crashing a window over, and
   * both still have a sentence in them.
   */
  it("takes a plain Error as an unnamed condition", () => {
    const failure = commandFailure(new Error("the mock is not installed"));

    expect(failure.code).toBe("internal");
    expect(failure.message).toBe("the mock is not installed");
    expect(failure.retryable).toBe(false);
  });

  it("takes a bare string the same way", () => {
    expect(codeOf("offline")).toBe("internal");
    expect(message("offline")).toBe("offline");
  });

  /** A `retryable` that never arrived is a `false`, not an `undefined` a button could read. */
  it("does not treat a missing retry flag as permission to offer one", () => {
    const failure = new CommandFailure({ code: "internal", message: "gone" } as CommandError);

    expect(failure.retryable).toBe(false);
  });
});

/**
 * The branch itself. Three answers, and each of the seven codes has to land on one of them —
 * because a screen showing "Try again" over a condition trying again cannot fix is worse than a
 * screen showing nothing.
 */
describe("what a screen can offer about a failure", () => {
  it("sends the two configuration conditions to Setup", () => {
    expect(recourse(failed({ code: "notConfigured" }))).toBe("setup");
    expect(recourse(failed({ code: "installNotFound" }))).toBe("setup");
  });

  it("offers another go for the races the backend called retryable", () => {
    expect(recourse(failed({ code: "gameFilesUnreadable", retryable: true }))).toBe("retry");
    expect(recourse(failed({ code: "historyBusy", retryable: true }))).toBe("retry");
  });

  it("offers nothing for the conditions somebody else has to change first", () => {
    expect(recourse(failed({ code: "historyTooNew" }))).toBe("none");
    expect(recourse(failed({ code: "invalidInput" }))).toBe("none");
    expect(recourse(failed({ code: "notFound" }))).toBe("none");
    expect(recourse(failed({ code: "internal" }))).toBe("none");
  });

  /**
   * Setup wins over the retry flag. Neither of those codes is retryable today, so this is a
   * statement about which rule is read first rather than about a case that exists — and it is
   * here because a backend that later decided a missing folder was worth retrying would
   * otherwise quietly replace the button that actually helps.
   */
  it("prefers Setup to a retry when a configuration failure claims both", () => {
    expect(recourse(failed({ code: "notConfigured", retryable: true }))).toBe("setup");
  });
});
