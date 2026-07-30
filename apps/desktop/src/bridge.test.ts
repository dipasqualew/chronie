import { beforeEach, describe, expect, it, vi } from "vitest";

const generated = vi.hoisted(() => ({
  dashboard: vi.fn(),
  release: vi.fn(),
}));

vi.mock("./bindings", () => ({ commands: generated }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { tauriDesktop } from "./bridge";
import { CommandFailure, commandFailure, message } from "./failure";

beforeEach(() => {
  generated.dashboard.mockReset();
  generated.release.mockReset();
});

describe("production desktop adapter", () => {
  it("unwraps a generated command answer", async () => {
    const dashboard = { segments: [] };
    generated.dashboard.mockResolvedValue({ status: "ok", data: dashboard });

    await expect(tauriDesktop.dashboard()).resolves.toBe(dashboard);
  });

  /**
   * The backend answers a failed command with a code, a sentence and a retry flag. The bridge is
   * where that becomes a throw, and it throws an `Error` rather than the bare object: a caller
   * writing `catch (error)` gets the same shape every other rejection in the page has, with the
   * code attached rather than waiting to be dug out.
   */
  it("rejects with a coded failure the page can branch on", async () => {
    generated.dashboard.mockResolvedValue({
      status: "error",
      error: {
        code: "historyBusy",
        message: "Chronie's history is busy. Try again in a moment.",
        retryable: true,
      },
    });

    const failure = await tauriDesktop.dashboard().then(
      () => null,
      (error: unknown) => commandFailure(error),
    );

    expect(failure).toBeInstanceOf(CommandFailure);
    expect(failure?.code).toBe("historyBusy");
    expect(failure?.message).toBe("Chronie's history is busy. Try again in a moment.");
    expect(failure?.retryable).toBe(true);
  });

  /** A failure from before a command was reached still arrives as something with a sentence. */
  it("rejects with an unnamed condition when what came back was only a string", async () => {
    generated.dashboard.mockResolvedValue({ status: "error", error: "offline" });

    const failure = await tauriDesktop.dashboard().then(
      () => null,
      (error: unknown) => commandFailure(error),
    );

    expect(failure?.code).toBe("internal");
    expect(failure?.message).toBe("offline");
  });

  it("leaves a command without a Result wrapper alone", async () => {
    const release = { channel: "dev", commit: "abc", url: "https://example.test" };
    generated.release.mockResolvedValue(release);

    await expect(tauriDesktop.release()).resolves.toBe(release);
  });
});

describe("message", () => {
  it("extracts an Error message", () => {
    expect(message(new Error("broken"))).toBe("broken");
  });

  it("stringifies command failures", () => {
    expect(message("offline")).toBe("offline");
  });
});
