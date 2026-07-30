/**
 * What the window knows about a command that would not do what it was asked.
 *
 * The backend used to answer a failed command with a string, so the only thing this side could do
 * with one was print it. Five files had grown the same three-line `message()` helper for exactly
 * that, and there was nowhere to put the question a screen actually wants to ask — *can I do
 * anything about this?* A missing game folder, an install mid-patch and a typo in a query all
 * arrived looking identical, so all three got the same dead sentence.
 *
 * A command now answers with a `CommandError`: a code out of a union `bindings.ts` generates from
 * the Rust, a sentence written for whoever is reading it, and whether asking again would be
 * honest. This module is where that lands. [`CommandFailure`] is an `Error`, deliberately —
 * everything that already reached for `error.message` keeps working, and the code is there for
 * the places where behaviour genuinely differs.
 */

import type { CommandError, FailureCode } from "./types";

/**
 * A failed command, as an `Error` so it throws and reads like one.
 *
 * `message` is the backend's own sentence and nothing else — no path, no SQLite wording. The
 * account of what actually happened went to `chronie.log` on the way past, which is where it
 * belongs and where a screenshot of an alert cannot leak it from.
 */
export class CommandFailure extends Error {
  /** One of the backend's codes, or `"internal"` for anything that has not got one yet. */
  readonly code: FailureCode;
  /** Whether the same call could reasonably work if it were made again. */
  readonly retryable: boolean;

  constructor(failure: CommandError) {
    super(failure.message);
    this.name = "CommandFailure";
    this.code = failure.code;
    this.retryable = failure.retryable === true;
  }
}

/**
 * Whatever came back from a failed command, as a [`CommandFailure`].
 *
 * Tolerant on purpose. The generated client types the error, but this is a process boundary and
 * what is being unwrapped has already been through JSON: a Tauri call that fails before it reaches
 * a command rejects with something else entirely, and a browser fixture is free to reject with a
 * plain `Error`. None of those is worth crashing the window over, and all of them still have a
 * sentence in them somewhere.
 */
export function commandFailure(error: unknown): CommandFailure {
  if (error instanceof CommandFailure) return error;
  if (isCommandError(error)) return new CommandFailure(error);
  return new CommandFailure({ code: "internal", message: message(error), retryable: false });
}

/** The sentence to show, out of a failure of any shape. */
export function message(error: unknown): string {
  if (isCommandError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** The code, for a screen deciding what to offer. `"internal"` when nothing said. */
export function codeOf(error: unknown): FailureCode {
  return commandFailure(error).code;
}

/**
 * What a screen can offer somebody about a failure, beyond repeating its sentence.
 *
 * Three answers, because there are three things a window can honestly do. `"setup"` is for the
 * two conditions somebody fixes in one click, and it is what earns this whole mechanism: "Choose
 * the game folder in Setup first." was a dead end for as long as it was only a string. `"retry"`
 * is for the races — an install being patched, a history somebody else is writing — where the same
 * call in a moment is the answer. Everything else is `"none"`, and a button there would be a lie.
 */
export type Recourse = "setup" | "retry" | "none";

export function recourse(error: unknown): Recourse {
  const failure = commandFailure(error);
  if (failure.code === "notConfigured" || failure.code === "installNotFound") return "setup";
  return failure.retryable ? "retry" : "none";
}

/**
 * Whether `value` has the shape the backend promises for a failed command.
 *
 * Structural rather than an `instanceof`: what arrives has crossed the IPC bridge as JSON, so
 * there is no class left on it by the time this sees it.
 */
function isCommandError(value: unknown): value is CommandError {
  if (value === null || typeof value !== "object") return false;
  const held = value as Partial<CommandError>;
  return typeof held.code === "string" && typeof held.message === "string";
}
