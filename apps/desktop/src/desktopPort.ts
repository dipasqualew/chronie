import type { commands } from "./bindings";

type CommandResult<T> = T extends { status: "ok"; data: infer Value }
  ? Value
  : T extends { status: "error"; error: unknown }
    ? never
    : T;

export type DesktopCommands = {
  [Name in keyof typeof commands]: (
    ...args: Parameters<(typeof commands)[Name]>
  ) => Promise<CommandResult<Awaited<ReturnType<(typeof commands)[Name]>>>>;
};

/** Everything React may ask the desktop host to do. */
export type DesktopPort = DesktopCommands & {
  openUrl: (url: string) => Promise<void>;
  pollDashboard: boolean;
  reloadWindow: (after: number) => void;
};
