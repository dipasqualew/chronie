import { openUrl } from "@tauri-apps/plugin-opener";

import { commands } from "./bindings";
import { commandFailure } from "./failure";

import type { Result } from "./bindings";
import type { DesktopCommands, DesktopPort } from "./desktopPort";

/**
 * One generated answer, as a value or as a throw.
 *
 * The throw is a `CommandFailure` rather than the `CommandError` the backend sent, which is the
 * one place in the app where that conversion happens. Two reasons: a caller writing
 * `catch (error)` gets something with a stack and an `instanceof Error` like every other rejection
 * in the page, and the code arrives attached to it rather than having to be dug out of a bare
 * object at every call site.
 */
const unwrap = <Value>(answer: Value | Result<Value, unknown>): Value => {
  if (answer === null || typeof answer !== "object" || !("status" in answer)) return answer;
  if (answer.status === "ok") return answer.data;
  throw commandFailure(answer.error);
};

const generated = new Proxy(commands, {
  get:
    (target, key: keyof typeof commands) =>
    (...args: unknown[]) =>
      (target[key] as (...commandArgs: unknown[]) => Promise<Result<unknown, unknown>>)(
        ...args,
      ).then(unwrap),
}) as unknown as DesktopCommands;

/** The production adapter: generated Rust commands plus the operating-system URL handoff. */
export const tauriDesktop: DesktopPort = {
  ...generated,
  openUrl,
  pollDashboard: true,
  reloadWindow: (after) => {
    setTimeout(() => window.location.reload(), after);
  },
};
