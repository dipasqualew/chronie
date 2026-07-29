import { describe, expect, it, vi } from "vitest";
import { achievementIds, achievementLine, createAchievementBook } from "./achievements";
import type {
  AchievementDetail,
  AchievementDetailsPayload,
  AchievementEvent,
  IconsPayload,
  Segment,
} from "./types";

/** What the addon recorded, with only the fields a test cares about spelled out. */
const event = (fields: Partial<AchievementEvent> = {}): AchievementEvent => ({
  id: 101,
  name: "Into the Light",
  at: 1785063600,
  accountFirst: false,
  ...fields,
});

/** What the game says, likewise. */
const detail = (fields: Partial<AchievementDetail> = {}): AchievementDetail => ({
  id: 101,
  title: "Into the Light",
  description: "Reach the lighthouse at the end of the pier.",
  reward: "",
  category: ["Chronicles", "Tideglass Deeps"],
  categoryId: 10,
  points: 10,
  iconFileDataId: 250001,
  faction: -1,
  ...fields,
});

/** A segment carrying nothing but the achievements a test is about. */
const segment = (achievements: AchievementEvent[]): Segment => ({
  segmentId: 1,
  id: "synthetic-001",
  character: "Aster-Vale",
  day: "2026-07-26",
  instance: "Glass Caverns",
  difficulty: "",
  instanceType: "scenario",
  startedAt: 0,
  endedAt: 60,
  seconds: 60,
  lootValue: 0,
  goldDiff: 0,
  housingXP: 0,
  achievements,
});

describe("achievementIds", () => {
  // The list goes to the backend, which opens the game's storage for it — so a segment that
  // earned the same achievement twice, or carries an event with no id at all, must not turn
  // into two lookups or into a lookup for nothing.
  it.each<[string, AchievementEvent[], number[]]>([
    ["a segment with nothing on it", [], []],
    ["one achievement", [event()], [101]],
    ["the same one twice", [event(), event()], [101]],
    ["several, in the order they were earned", [event({ id: 9 }), event({ id: 4 })], [9, 4]],
    ["an event carrying no id", [event({ id: 0 }), event({ id: 7 })], [7]],
  ])("asks after %s", (_what, achievements, expected) => {
    expect(achievementIds(segment(achievements))).toEqual(expected);
  });

  it("survives a segment recorded before the addon kept achievements at all", () => {
    const older = segment([]);
    delete older.achievements;
    expect(achievementIds(older)).toEqual([]);
  });
});

describe("achievementLine", () => {
  // Everything a row shows when both halves are in hand.
  it("reads an achievement the game can describe", () => {
    expect(achievementLine(event(), detail({ points: 25, reward: "Reward: Title" }))).toEqual({
      title: "Into the Light",
      description: "Reach the lighthouse at the end of the pier.",
      reward: "Reward: Title",
      category: "Chronicles › Tideglass Deeps",
      worth: "25 points",
      side: "",
      iconFileDataId: 250001,
      first: "character first",
    });
  });

  // Before the lookup lands, and for an achievement this install cannot describe at all, the
  // row is what the app showed before any of this: the name the addon caught, and no more.
  it("falls back to what the addon recorded when the game says nothing", () => {
    expect(achievementLine(event({ accountFirst: true }), undefined)).toEqual({
      title: "Into the Light",
      description: "",
      reward: "",
      category: "",
      worth: "",
      side: "",
      iconFileDataId: 0,
      first: "account first",
    });
  });

  // The addon records no name when the client had not loaded the achievement at the moment
  // it was earned, which is common enough on a fresh login.
  it("names an achievement by its number when neither half has a name", () => {
    expect(achievementLine(event({ name: null }), undefined).title).toBe("Achievement 101");
  });

  // The game's spelling wins, because the addon's was whatever the client had loaded.
  it("prefers the game's own title to the one the addon caught", () => {
    expect(achievementLine(event({ name: "into the light" }), detail()).title).toBe(
      "Into the Light",
    );
  });

  it.each<[string, number, string]>([
    ["the Horde", 0, "Horde"],
    ["the Alliance", 1, "Alliance"],
    ["both sides", -1, ""],
  ])("says an achievement for %s belongs to %i", (_who, faction, expected) => {
    expect(achievementLine(event(), detail({ faction })).side).toBe(expected);
  });

  // Half the real table is worth nothing — feats of strength and the whole legacy tree — and
  // "0 points" beside every one of them would be noise rather than information.
  it.each<[number, string]>([
    [0, ""],
    [5, "5 points"],
    [10, "10 points"],
    [100, "100 points"],
  ])("words %i points as %s", (points, expected) => {
    expect(achievementLine(event(), detail({ points })).worth).toBe(expected);
  });

  // The game withholds the category tree for content it has not shipped, so a described
  // achievement can still have nowhere to say it sits.
  it("says nothing about the tree when the game withholds it", () => {
    expect(achievementLine(event(), detail({ category: [] })).category).toBe("");
  });
});

describe("createAchievementBook", () => {
  /** A backend that answers for the achievements it was given, and remembers being asked. */
  function backend(known: Record<number, AchievementDetail> = { 101: detail() }) {
    const asked: number[][] = [];
    const askedIcons: number[][] = [];
    const load = vi.fn(async (ids: number[]): Promise<AchievementDetailsPayload> => {
      asked.push(ids);
      const achievements: Record<string, AchievementDetail> = {};
      for (const id of ids) {
        const found = known[id];
        if (found) achievements[String(id)] = found;
      }
      return { achievements };
    });
    const loadIcons = vi.fn(async (fdids: number[]): Promise<IconsPayload> => {
      askedIcons.push(fdids);
      return { icons: Object.fromEntries(fdids.map((fdid) => [String(fdid), `data:${fdid}`])) };
    });
    return { load, loadIcons, asked, askedIcons };
  }

  it("looks an achievement up and hands back what the game said", async () => {
    const { load, loadIcons } = backend();
    const book = createAchievementBook({ load, loadIcons });
    await book.learn([101], () => {});

    expect(book.detail(101)).toEqual(detail());
    expect(book.icon(101)).toBe("data:250001");
  });

  // The words arrive before the pictures — they are two reads of the game's storage — and a
  // list of achievements is worth reading while the second is still going.
  it("says so when the words land and again when the pictures do", async () => {
    const { load, loadIcons } = backend();
    const changed = vi.fn();
    const book = createAchievementBook({ load, loadIcons });
    await book.learn([101], changed);

    expect(changed).toHaveBeenCalledTimes(2);
  });

  // A reader walking their history meets the same achievements over and over, once per
  // segment that mentions them, and each lookup opens the game's storage.
  it("asks after an achievement once however many segments name it", async () => {
    const { load, loadIcons, asked, askedIcons } = backend({ 101: detail(), 9: detail({ id: 9 }) });
    const book = createAchievementBook({ load, loadIcons });

    await book.learn([101, 101], () => {});
    await book.learn([101], () => {});
    // A second segment naming one of the same achievements and one of its own — which shares
    // its picture, so there is nothing new to decode either.
    await book.learn([101, 9], () => {});

    expect(asked).toEqual([[101], [9]]);
    expect(askedIcons).toEqual([[250001]]);
  });

  // Nothing further is coming, so nothing is redrawn for it.
  it("says nothing changed when it had nothing to ask", async () => {
    const { load, loadIcons } = backend();
    const book = createAchievementBook({ load, loadIcons });
    await book.learn([101], () => {});

    const changed = vi.fn();
    await book.learn([101], changed);
    expect(changed).not.toHaveBeenCalled();
  });

  // An id the install cannot describe is still an id it has been asked about, and asking
  // again would open the game's storage to arrive back at the same nothing.
  it("does not go looking again for an achievement the game could not describe", async () => {
    const { load, loadIcons, asked } = backend({});
    const book = createAchievementBook({ load, loadIcons });

    await book.learn([77], () => {});
    await book.learn([77], () => {});

    expect(book.detail(77)).toBeUndefined();
    expect(book.icon(77)).toBeUndefined();
    expect(asked).toEqual([[77]]);
  });

  // The reasons a lookup fails are the ones that stop the whole game folder being read — it
  // has not been chosen yet, or it is mid-patch — and those are worth one more try when the
  // reader opens the next segment. None of it reaches the row, which says what the addon
  // recorded either way.
  it("keeps quiet about a lookup that failed, and tries again later", async () => {
    const { loadIcons } = backend();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Choose the game folder in Setup first."))
      .mockResolvedValueOnce({ achievements: { 101: detail() } });
    const book = createAchievementBook({ load, loadIcons });
    const changed = vi.fn();

    await expect(book.learn([101], changed)).resolves.toBeUndefined();
    expect(book.detail(101)).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();

    await book.learn([101], changed);
    expect(book.detail(101)).toEqual(detail());
  });

  // A picture that would not decode is not a reason to lose the words that came with it.
  it("keeps the words when the pictures could not be fetched", async () => {
    const { load } = backend();
    const loadIcons = vi.fn().mockRejectedValue(new Error("no such texture"));
    const book = createAchievementBook({ load, loadIcons });
    const changed = vi.fn();

    await book.learn([101], changed);
    expect(book.detail(101)).toEqual(detail());
    expect(book.icon(101)).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  // The install has nothing to show for some achievements, and there is no texture behind
  // the zero they carry.
  it("asks for no picture for an achievement the game names none for", async () => {
    const { load, loadIcons, askedIcons } = backend({ 101: detail({ iconFileDataId: 0 }) });
    const book = createAchievementBook({ load, loadIcons });

    await book.learn([101], () => {});
    expect(askedIcons).toEqual([]);
    expect(book.icon(101)).toBeUndefined();
  });
});
