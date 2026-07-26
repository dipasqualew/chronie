import { describe, expect, it } from "vitest";
import { message } from "./bridge.js";

describe("message", () => {
  it("extracts an Error message", () => {
    expect(message(new Error("broken"))).toBe("broken");
  });

  it("stringifies command failures", () => {
    expect(message("offline")).toBe("offline");
  });
});
