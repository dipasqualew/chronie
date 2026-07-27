import { describe, expect, it } from "vitest";
import { fileSize, offerSentence, receiptSentence, receiveSentence } from "./wifi";
import type { WifiOffer, WifiReceiveStatus } from "./types";

const offer = (overrides: Partial<WifiOffer> = {}): WifiOffer => ({
  protocol: 1,
  device: "Desktop",
  segmentCount: 1204,
  characterCount: 3,
  newestDay: "2026-07-26",
  bytes: 4_404_019,
  ...overrides,
});

const status = (overrides: Partial<WifiReceiveStatus> = {}): WifiReceiveStatus => ({
  listening: false,
  device: "Laptop",
  addresses: [],
  port: 51571,
  offer: null,
  outcome: null,
  ...overrides,
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

describe("offerSentence", () => {
  // The whole feature turns on this sentence being read before the button beside it is
  // pressed, so it has to say what arrives and what goes, in that order.
  it("names the sender, what it holds, and what accepting costs", () => {
    const sentence = offerSentence(offer(), "192.168.1.20");

    expect(sentence).toContain("Desktop (192.168.1.20)");
    expect(sentence).toContain("1204 segments across 3 characters");
    expect(sentence).toContain("up to 2026-07-26");
    expect(sentence).toContain("4.2 MB");
    expect(sentence).toContain("replaces everything this Chronie has collected");
  });

  it("leaves the date out rather than inventing one for a history with nothing in it", () => {
    const sentence = offerSentence(
      offer({ segmentCount: 0, characterCount: 1, newestDay: null }),
      "192.168.1.20",
    );

    expect(sentence).toContain("0 segments across 1 character");
    expect(sentence).not.toContain("up to");
  });
});

describe("receiveSentence", () => {
  it("says a machine that is not waiting cannot be sent to", () => {
    expect(receiveSentence(status())).toContain("Not waiting");
  });

  it("says where a sender can reach a machine that is", () => {
    const sentence = receiveSentence(status({
      listening: true,
      addresses: ["192.168.1.31:51571"],
    }));

    expect(sentence).toContain("“Laptop”");
    expect(sentence).toContain("192.168.1.31:51571");
  });

  // A machine on a network that will not say which address is its own is still reachable,
  // and the port is the half of the answer it does have.
  it("falls back to the port when it cannot name an address", () => {
    expect(receiveSentence(status({ listening: true }))).toContain("port 51571");
  });

  it("leads with the offer on the table over anything else it could say", () => {
    const waiting = { offer: offer(), from: "192.168.1.20", receiving: false };

    expect(receiveSentence(status({ listening: true, offer: waiting })))
      .toBe("A Chronie is waiting for an answer.");
    expect(receiveSentence(status({ listening: true, offer: { ...waiting, receiving: true } })))
      .toBe("Receiving the database…");
  });

  it("keeps reporting what happened after the sender has gone", () => {
    const sentence = receiveSentence(status({
      listening: true,
      outcome: { stored: true, message: "Replaced this history with Desktop's: 1204 segments." },
    }));

    expect(sentence).toContain("Replaced this history");
  });
});

describe("receiptSentence", () => {
  it("reports what the other machine ended up holding", () => {
    expect(receiptSentence({ stored: true, reason: "", segmentCount: 1204 }, "192.168.1.31"))
      .toBe("Sent to 192.168.1.31: it now holds 1204 segments.");
  });

  // A refusal is the other person's answer, not a failure of this machine's, so what they
  // said is what gets shown.
  it("passes on the reason a database was not taken", () => {
    expect(receiptSentence(
      { stored: false, reason: "The database was turned down.", segmentCount: 0 },
      "192.168.1.31",
    )).toBe("The database was turned down.");

    expect(receiptSentence({ stored: false, reason: "", segmentCount: 0 }, "192.168.1.31"))
      .toBe("192.168.1.31 did not take the database.");
  });
});
