import { beforeEach, describe, expect, it, vi } from "vitest";

const generated = vi.hoisted(() => ({
  dashboard: vi.fn(),
  release: vi.fn(),
}));

vi.mock("./bindings", () => ({ commands: generated }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { tauriDesktop } from "./bridge";
import { message } from "./e2eDesktop";

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

  it("rejects with a generated command failure", async () => {
    generated.dashboard.mockResolvedValue({ status: "error", error: "offline" });

    await expect(tauriDesktop.dashboard()).rejects.toBe("offline");
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
