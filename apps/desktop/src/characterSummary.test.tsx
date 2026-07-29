import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildCharacters } from "./characters";
import type { CharacterProfile } from "./characters";
import { CharacterSummary } from "./characterSummary";
import { createCurrencyIcons } from "./currencies";
import type { CurrencyIcons } from "./currencies";
import type { AccountHoldings, InGameSet, Segment } from "./types";

afterEach(cleanup);

const BASE = 1_785_000_000;

const segment = (overrides: Partial<Segment> = {}): Segment => ({
  segmentId: 1,
  id: "synthetic-1",
  character: "Aster-Vale",
  classFile: "MAGE",
  level: 12,
  day: "2026-07-26",
  instance: "Glass Caverns",
  difficulty: "",
  instanceType: "none",
  startedAt: BASE,
  endedAt: BASE + 600,
  seconds: 600,
  lootValue: 0,
  goldDiff: 0,
  housingXP: 0,
  ...overrides,
});

const GLASS_TOKEN = 7;
const WARBAND_CHIT = 10;
const PICTURE = "data:image/png;base64,token";

const HOLDINGS: AccountHoldings = {
  currencies: [
    {
      id: GLASS_TOKEN,
      name: "Glass Token",
      total: 30_000,
      oldest: BASE,
      characters: [
        { character: "Aster-Vale", total: 12_450, at: BASE },
        { character: "Brin-Hearth", total: 17_550, at: BASE },
      ],
    },
    {
      id: WARBAND_CHIT,
      name: "Warband Chit",
      total: 6_000,
      accountWide: true,
      oldest: BASE,
      characters: [{ character: "Aster-Vale", total: 6_000, at: BASE }],
    },
  ],
  factions: [
    {
      // Somebody else is out in front here, which is the row a reader actually wants a column
      // for: "Honored, and the alt you never play is Revered".
      faction: "Cavern Cartographers",
      best: {
        character: "Brin-Hearth",
        standing: "Revered",
        current: 3_000,
        max: 21_000,
        rank: 7,
        system: "reaction",
        at: BASE,
      },
      characters: [
        {
          character: "Aster-Vale",
          standing: "Honored",
          current: 4_200,
          max: 12_000,
          rank: 6,
          system: "reaction",
          at: BASE,
        },
      ],
    },
    {
      faction: "Deepwater Wardens",
      best: {
        character: "Aster-Vale",
        standing: "Exalted",
        rank: 8,
        system: "reaction",
        at: BASE,
      },
      characters: [
        {
          character: "Aster-Vale",
          standing: "Exalted",
          rank: 8,
          system: "reaction",
          at: BASE,
        },
      ],
    },
  ],
  gold: {
    characters: [{ character: "Aster-Vale", total: 125_000, at: BASE }],
    wallets: 125_000,
    warband: 1_200_000,
    total: 1_325_000,
    oldest: BASE,
  },
};

const SET: InGameSet = {
  id: 4,
  name: "Tideglass",
  icon: 130_001,
  observedAt: null,
  slots: [{ slot: 0, appearanceId: 71_001 }],
};

/** A book over an install that draws Glass Token and has no picture for the warband's pot. */
function icons(): CurrencyIcons {
  return createCurrencyIcons({
    load: (ids) =>
      Promise.resolve({
        icons: Object.fromEntries(
          ids.filter((id) => id === GLASS_TOKEN).map((id) => [String(id), PICTURE]),
        ),
      }),
  });
}

function show({
  wardrobe = null,
  profile,
}: { wardrobe?: InGameSet[] | null; profile?: CharacterProfile } = {}): CharacterProfile {
  const entry = profile ?? buildCharacters([segment({ lootValue: 245_000 })], HOLDINGS)[0]!;
  render(<CharacterSummary entry={entry} wardrobe={wardrobe} currencyIcons={icons()} />);
  return entry;
}

/** The cells of the row a table names something on, in the order the table draws them. */
const rowFor = (table: string, name: string) =>
  within(screen.getByRole("table", { name: table })).getByRole("row", { name: new RegExp(name) });

describe("CharacterSummary", () => {
  it("adds up what is known about the character", () => {
    show();

    expect(screen.getByRole("group", { name: "Played" }).textContent).toContain("10m");
    expect(screen.getByRole("group", { name: "Segments" }).textContent).toContain("1");
    expect(screen.getByRole("group", { name: "Looted" }).textContent).toContain("24g 50s");
    expect(screen.getByRole("group", { name: "Wallet" }).textContent).toContain("12g 50s");
  });

  /** What the roster is sitting on is a different question from what this pocket holds. */
  it("says what the account is worth where it differs from the wallet", () => {
    show();

    expect(screen.getByText(/132g 50s across the account/)).toBeTruthy();
    expect(screen.getByText(/120g 0s in the warband bank/)).toBeTruthy();
  });

  describe("the currencies", () => {
    it("is a table of what is held against what the account holds", () => {
      show();

      const row = rowFor("Currencies", "Glass Token");
      expect(row.textContent).toContain("12,450");
      expect(row.textContent).toContain("30,000");
    });

    /**
     * A warband currency's two numbers are one pot reported twice, so an account column would
     * repeat the balance on the line and read as a coincidence rather than as the same money.
     */
    it("says a warband pot is shared and leaves its account column empty", () => {
      show();

      const row = rowFor("Currencies", "Warband Chit");
      expect(row.textContent).toContain("shared across the warband");
      expect(row.textContent).not.toContain("6,000 6,000");
    });

    it("draws the picture the game draws a currency with", async () => {
      show();

      // Asked for by tag rather than by role: the picture is decoration in the strict sense —
      // the row says everything without it — so it carries no accessible name to ask for.
      await waitFor(() =>
        expect(rowFor("Currencies", "Glass Token").querySelector("img")?.getAttribute("src")).toBe(
          PICTURE,
        ),
      );
    });

    /** A row whose currency the game names no picture for still draws, blank in that column. */
    it("draws a currency the game has no picture for anyway", async () => {
      show();

      await waitFor(() =>
        expect(rowFor("Currencies", "Glass Token").querySelector("img")).toBeTruthy(),
      );
      expect(rowFor("Currencies", "Warband Chit").querySelector("img")).toBeNull();
      expect(rowFor("Currencies", "Warband Chit").textContent).toContain("Warband Chit");
    });
  });

  describe("the reputations", () => {
    /**
     * A reputation is grind a warband does once, so the question in front of a faction is
     * rarely "how far am I" and nearly always "how far are we, and is it me".
     */
    it("names who on the account has got furthest with each faction", () => {
      show();

      expect(rowFor("Reputation", "Cavern Cartographers").textContent).toContain(
        "Brin-Hearth · Revered",
      );
    });

    /** The name is the heading of the page; repeating it would read as somebody else's. */
    it("says 'this character' where they are the one in front", () => {
      show();

      const row = rowFor("Reputation", "Deepwater Wardens");
      expect(row.textContent).toContain("This character · Exalted");
      expect(row.textContent).not.toContain("Aster-Vale");
    });

    it("draws where they stand inside their own level", () => {
      show();

      const bar = screen.getByRole("progressbar", { name: /Cavern Cartographers/ });
      expect(bar).toHaveProperty("value", 4_200);
      expect(bar).toHaveProperty("max", 12_000);
    });
  });

  describe("the wardrobe", () => {
    /** A question this app has not asked is not an answer, and says nothing at all. */
    it("stays quiet where Chronie has never read one", () => {
      show({ wardrobe: null });

      expect(screen.queryByRole("heading", { name: "Transmog sets" })).toBeNull();
    });

    /** "None" is an answer somebody came here for, and a missing section is not it. */
    it("says so out loud where the character saves nothing in game", () => {
      show({ wardrobe: [] });

      expect(screen.getByText("No sets saved in game.")).toBeTruthy();
    });

    it("names what they have got", () => {
      show({ wardrobe: [SET] });

      expect(screen.getByText("Tideglass")).toBeTruthy();
      expect(screen.getByText(/1 set saved in game/)).toBeTruthy();
    });
  });

  /** A character whose holdings nobody has ever reported has no table rather than an empty one. */
  it("draws no tables for a character nothing is known to be held by", () => {
    const bare = buildCharacters([segment({ character: "Nobody-Vale" })])[0]!;
    show({ profile: bare });

    expect(screen.queryByRole("table", { name: "Currencies" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Reputation" })).toBeNull();
  });
});
