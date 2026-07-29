import { describe, expect, it } from "vitest";
import {
  ago,
  dayLabel,
  duration,
  escapeHtml,
  fileSize,
  gold,
  initials,
  plural,
  signed,
  signedGold,
} from "./format";

describe("gold", () => {
  it.each<[number, string]>([
    [0, "0c"],
    [45, "45c"],
    [1234, "12s 34c"],
    [10_000, "1g 0s"],
    [325_078, "32g 50s"],
  ])("reads %i copper as %s", (copper, expected) => {
    expect(gold(copper)).toBe(expected);
  });

  // A missing value is not a loss, and a negative one has already been handled by the
  // caller that knows it is a difference; clamping here keeps "-0c" off the screen.
  it("treats absent copper as nothing", () => {
    expect(gold(undefined)).toBe("0c");
  });
});

describe("signedGold", () => {
  it("keeps a loss negative", () => {
    expect(signedGold(-1200)).toBe("-12s 0c");
  });

  it("leaves a gain reading as gold", () => {
    expect(signedGold(32_000)).toBe("3g 20s");
  });
});

describe("duration", () => {
  it.each<[number, string]>([
    [0, "0s"],
    [45, "45s"],
    [900, "15m"],
    [1037, "17m 17s"],
    [3600, "1h 00m"],
    [12_420, "3h 27m"],
  ])("reads %i seconds as %s", (seconds, expected) => {
    expect(duration(seconds)).toBe(expected);
  });

  // Beside "06:05 PM – 06:22 PM" a bare "17:17" reads as another time of day; every length
  // on screen has to be tellable from a clock at a glance.
  it("never looks like a time of day", () => {
    expect(duration(1037)).not.toContain(":");
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 6, 26, 21, 30);

  it("names the day that is still happening", () => {
    expect(dayLabel("2026-07-26", now)).toBe("Today");
  });

  it("names the one before it", () => {
    expect(dayLabel("2026-07-25", now)).toBe("Yesterday");
  });

  // Asserted by its parts rather than a whole string: the order of day and month is the
  // reader's locale to decide, and pinning one would fail everywhere the other is normal.
  it("spells out a day further back without repeating this year", () => {
    const label = dayLabel("2026-07-04", now);
    expect(label).toContain("Sat");
    expect(label).toContain("4");
    expect(label).toContain("Jul");
    expect(label).not.toContain("2026");
  });

  it("adds the year once the day is no longer in it", () => {
    expect(dayLabel("2025-12-31", now)).toContain("2025");
  });

  it("passes a value it cannot read straight through", () => {
    expect(dayLabel("not-a-day", now)).toBe("not-a-day");
  });
});

describe("initials", () => {
  it("takes two letters from the name, not the realm", () => {
    expect(initials("Aster-Vale")).toBe("AS");
  });

  it("copes with a name too short to have two", () => {
    expect(initials("K")).toBe("K");
    expect(initials("")).toBe("?");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup carried by a name from the game", () => {
    expect(escapeHtml('<img src=x onerror="boom">')).toBe(
      "&lt;img src=x onerror=&quot;boom&quot;&gt;",
    );
  });
});

describe("plural", () => {
  it.each<[number, string]>([
    [1, "1 quest"],
    [3, "3 quests"],
  ])("counts %i as %s", (count, expected) => {
    expect(plural(count, "quest")).toBe(expected);
  });
});

describe("signed", () => {
  it("marks a gain and leaves a loss alone", () => {
    expect(signed(25)).toBe("+25");
    expect(signed(-4)).toBe("-4");
  });
});

describe("fileSize", () => {
  it("never shows more digits than a person is judging by", () => {
    expect(fileSize(0)).toBe("0 bytes");
    expect(fileSize(900)).toBe("900 bytes");
    expect(fileSize(4096)).toBe("4.0 KB");
    expect(fileSize(4_404_019)).toBe("4.2 MB");
    expect(fileSize(3_221_225_472)).toBe("3.0 GB");
  });
});

describe("ago", () => {
  const NOW = 1_800_000_000;

  it.each<[number, string]>([
    [NOW - 5, "just now"],
    [NOW - 90, "a minute ago"],
    [NOW - 600, "10 minutes ago"],
    [NOW - 7_200, "2 hours ago"],
    [NOW - 200_000, "2 days ago"],
    [NOW - 86_400, "yesterday"],
  ])("reads %i as %s", (at, expected) => {
    expect(ago(at, NOW)).toBe(expected);
  });

  // A clock that disagrees with the file's is not worth a sentence about the future.
  it("does not describe a moment that has not happened yet", () => {
    expect(ago(NOW + 500, NOW)).toBe("just now");
  });
});
