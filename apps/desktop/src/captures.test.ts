import { describe, expect, it, vi } from "vitest";

import {
  captureFacts, captureReason, captureSummary, captureTip, capturedMoments, createCaptureAlbum,
  deleteWarning, fileSize, missingReason, noteChanged, thumbnailIds,
} from "./captures";
import { clock } from "./format";
import type { Capture, CaptureThumbnailsPayload, Segment } from "./types";

const EVENING = 1_785_063_600;

const capture = (overrides: Partial<Capture> = {}): Capture => ({
  id: 11,
  sourceId: "TEST|1|11",
  at: EVENING + 1400,
  imageState: "stored",
  ...overrides,
});

const segment = (overrides: Partial<Segment> = {}): Segment => ({
  segmentId: 1,
  id: "synthetic-001",
  character: "Aster-Vale",
  day: "2026-07-26",
  instance: "Glass Caverns",
  difficulty: "",
  instanceType: "scenario",
  startedAt: EVENING,
  endedAt: EVENING + 1800,
  seconds: 1800,
  lootValue: 0,
  goldDiff: 0,
  housingXP: 0,
  ...overrides,
});

describe("capturedMoments", () => {
  // An evening is read the way it went, unlike everything else in this app — a set of
  // photographs in reverse is a story told backwards.
  it("puts an evening's pictures in the order they were taken", () => {
    const first = capture({ id: 1, sourceId: "a", at: EVENING + 10 });
    const second = capture({ id: 2, sourceId: "b", at: EVENING + 20 });
    const third = capture({ id: 3, sourceId: "c", at: EVENING + 30 });

    const moments = capturedMoments([
      segment({ segmentId: 2, captures: [third] }),
      segment({ segmentId: 1, captures: [second, first] }),
    ]);

    expect(moments.map((moment) => moment.capture.sourceId)).toEqual(["a", "b", "c"]);
    // Each one keeps the segment it was taken in, which is where everything but the moment
    // comes from: who was playing, and where they were standing.
    expect(moments[0].segment.segmentId).toBe(1);
    expect(moments[2].segment.segmentId).toBe(2);
  });

  // Two captures a second apart is what the addon's own cooldown allows, and two in the same
  // second is what a clock that went backwards produces. Neither may reshuffle on a repaint.
  it("breaks a tie on the row id rather than on where the segment happened to be", () => {
    const moments = capturedMoments([segment({
      captures: [
        capture({ id: 9, sourceId: "later", at: EVENING }),
        capture({ id: 4, sourceId: "earlier", at: EVENING }),
      ],
    })]);

    expect(moments.map((moment) => moment.capture.sourceId)).toEqual(["earlier", "later"]);
  });

  it("finds nothing in segments that were never photographed", () => {
    expect(capturedMoments([segment(), segment({ captures: [] })])).toEqual([]);
  });
});

// The three reasons there is no picture are three different things to tell somebody, and one
// of them is not a failure at all.
describe("missingReason", () => {
  it("says nothing about a capture whose picture Chronie holds", () => {
    expect(missingReason(capture())).toBeNull();
  });

  it("tells an entry that asked for no picture apart from one whose file was lost", () => {
    expect(missingReason(capture({ imageState: "none" }))).toContain("A note");
    expect(missingReason(capture({ imageState: "missing" }))).toContain("could not find the file");
  });
});

describe("thumbnailIds", () => {
  it("asks only for the captures that have a picture to ask for", () => {
    const moments = capturedMoments([segment({
      captures: [
        capture({ id: 1, sourceId: "a" }),
        capture({ id: 2, sourceId: "b", imageState: "missing" }),
        capture({ id: 3, sourceId: "c", imageState: "none" }),
      ],
    })]);

    expect(thumbnailIds(moments)).toEqual([1]);
  });
});

describe("captureReason", () => {
  // The presence of a trigger is the whole difference between a capture somebody pressed the
  // key for and one Chronie took by itself, so it is worth saying — in words.
  it("says in words which rule took a picture by itself", () => {
    expect(captureReason(capture({ trigger: "accountFirstAchievement" })))
      .toBe("Taken for an account first");
    expect(captureReason(capture())).toBe("");
  });

  // The allowlist is the player's and lives in a settings file, so a name this build has
  // never heard of is a setting from a later one rather than a bug to hide.
  it("names a rule it does not know rather than saying nothing", () => {
    expect(captureReason(capture({ trigger: "firstKillOfTheTier" })))
      .toBe("Taken automatically: firstKillOfTheTier");
  });
});

describe("captureFacts", () => {
  it("takes who and where from the segment the picture was taken in", () => {
    const [moment] = capturedMoments([segment({ captures: [capture({ byteSize: 3_204_112 })] })]);

    // The clock through the app's own formatter rather than a literal: what it reads is the
    // machine's locale and zone, and a fixed string would pass in one place and fail in another.
    expect(captureFacts(moment))
      .toEqual(["Aster-Vale", "Glass Caverns", clock(EVENING + 1400), "3.1 MB"]);
  });

  it("leaves out a size nobody has said", () => {
    const [moment] = capturedMoments([segment({ captures: [capture()] })]);

    expect(captureFacts(moment)).not.toContain("0 bytes");
  });
});

describe("fileSize", () => {
  it.each([
    [512, "512 bytes"],
    [1, "1 byte"],
    [2048, "2 kB"],
    [1_500_000, "1.4 MB"],
    [3_204_112, "3.1 MB"],
    [12_000_000_000, "11 GB"],
  ])("says %s bytes as %s", (bytes, said) => {
    expect(fileSize(bytes)).toBe(said);
  });
});

// The one string of markup this feature builds, and therefore the one place a note has to be
// escaped by hand: the shared tooltip assigns `data-tip` straight to `innerHTML`.
describe("captureTip", () => {
  it("puts a note containing markup into the tooltip as text", () => {
    const [moment] = capturedMoments([segment({
      captures: [capture({ note: "<b>first</b> Yogg kill" })],
    })]);

    const tip = captureTip(moment);
    expect(tip).toContain("&lt;b&gt;first&lt;/b&gt; Yogg kill");
    expect(tip).not.toContain("<b>first</b>");
  });

  it("escapes a place name out of the game as well", () => {
    const [moment] = capturedMoments([segment({
      instance: "The <Hall> of \"Fame\"", captures: [capture()],
    })]);

    expect(captureTip(moment)).toContain("The &lt;Hall&gt; of &quot;Fame&quot;");
  });

  it("says there is no note rather than drawing an empty tooltip", () => {
    const [moment] = capturedMoments([segment({ captures: [capture()] })]);

    expect(captureTip(moment)).toContain("No note yet");
  });
});

describe("captureSummary", () => {
  // A player who took ten screenshots and finds nine is owed the explanation on the way in,
  // not after opening the grid and counting.
  it("counts the pictures, and says how many are only markers", () => {
    const moments = capturedMoments([segment({
      captures: [
        capture({ id: 1, sourceId: "a" }),
        capture({ id: 2, sourceId: "b" }),
        capture({ id: 3, sourceId: "c", imageState: "missing" }),
      ],
    })]);

    expect(captureSummary(moments)).toBe("2 screenshots · 1 without a file");
  });

  it("says only the count when every picture is there", () => {
    const moments = capturedMoments([segment({ captures: [capture()] })]);

    expect(captureSummary(moments)).toBe("1 screenshot");
  });
});

describe("noteChanged", () => {
  // A field somebody clicked into and out of again has not been edited, and asking the
  // backend to say so would repaint the whole window for nothing.
  it.each([
    ["a note where there was none", undefined, "new", true],
    ["the same note back again", "same", "same", false],
    ["the same note with padding", "same", "  same  ", false],
    ["nothing where there was a note", "was", "   ", true],
    ["nothing where there was nothing", undefined, "  ", false],
  ])("reads %s", (_case, stored, typed, changed) => {
    expect(noteChanged(capture({ note: stored }), typed)).toBe(changed);
  });
});

describe("deleteWarning", () => {
  // Delete means a row and a file. A confirmation that did not say so would be asking about
  // something smaller than what is about to happen.
  it("says the picture goes too, when there is one", () => {
    expect(deleteWarning(capture())).toContain("deleted from Chronie's storage");
    expect(deleteWarning(capture({ imageState: "none" }))).not.toContain("picture");
  });
});

describe("createCaptureAlbum", () => {
  const answer = (ids: number[]): Promise<CaptureThumbnailsPayload> =>
    Promise.resolve({ thumbnails: Object.fromEntries(ids.map((id) => [id, `picture-${id}`])) });

  it("asks for a picture once and hands it to every grid after that", async () => {
    const load = vi.fn(answer);
    const album = createCaptureAlbum(load);
    const changed = vi.fn();

    await album.learn([1, 2, 1], changed);
    await album.learn([2, 3], changed);

    expect(load.mock.calls).toEqual([[[1, 2]], [[3]]]);
    expect(album.thumbnail(1)).toBe("picture-1");
    expect(album.thumbnail(3)).toBe("picture-3");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("says nothing and asks nothing when it already has everything", async () => {
    const load = vi.fn(answer);
    const album = createCaptureAlbum(load);
    const changed = vi.fn();
    await album.learn([1], changed);
    changed.mockClear();

    await album.learn([1], changed);

    expect(load).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  // A grid whose pictures did not arrive draws the same placeholder as one whose captures
  // have none, and it is worth another try the next time somebody opens that evening.
  it("tries again after a request that failed", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("no game folder is set"))
      .mockImplementation(answer);
    const album = createCaptureAlbum(load);

    await album.learn([1], () => {});
    expect(album.thumbnail(1)).toBeUndefined();

    await album.learn([1], () => {});
    expect(album.thumbnail(1)).toBe("picture-1");
  });

  // A capture id is a SQLite rowid, and a rowid is reused once the row holding the highest one
  // is deleted — so a picture kept for a deleted capture could be drawn for the next one
  // ingested, which is a photograph of somebody else's evening.
  it("forgets the picture of a capture that has been deleted", async () => {
    const load = vi.fn(answer);
    const album = createCaptureAlbum(load);
    await album.learn([7], () => {});

    album.forget(7);

    expect(album.thumbnail(7)).toBeUndefined();
    await album.learn([7], () => {});
    expect(load).toHaveBeenCalledTimes(2);
  });
});
