import { openUrl } from "@tauri-apps/plugin-opener";

import { commands } from "./bindings";

import type { Result } from "./bindings";
import type { DesktopCommands, DesktopPort } from "./desktopPort";

const unwrap = <Value>(answer: Value | Result<Value, unknown>): Value => {
  if (answer === null || typeof answer !== "object" || !("status" in answer)) return answer;
  if (answer.status === "ok") return answer.data;
  throw answer.error;
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
