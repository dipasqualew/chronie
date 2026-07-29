/**
 * What moving a history between machines says, in words.
 *
 * The important one is the offer: saying yes to it destroys everything the receiving machine
 * has collected, so it is spelled out rather than summarised — who is sending, how much, and
 * what goes. The panel that shows these is `wifiPanel.tsx`.
 */

import { fileSize, plural } from "./format";
import type { WifiOffer, WifiReceipt, WifiReceiveStatus } from "./types";

/**
 * What a machine is being asked to accept, and what accepting costs it.
 *
 * The second sentence is the one that matters and it is deliberately blunt: everything about
 * this exchange is reversible except the moment somebody clicks Accept without reading.
 */
export function offerSentence(offer: WifiOffer, from: string): string {
  const upTo = offer.newestDay ? `, up to ${offer.newestDay}` : "";
  return (
    `${offer.device} (${from}) is offering a history of ` +
    `${plural(offer.segmentCount, "segment")} across ` +
    `${plural(offer.characterCount, "character")}${upTo} — ${fileSize(offer.bytes)}. ` +
    "Accepting replaces everything this Chronie has collected."
  );
}

/** What the receiving half is doing, in one line. */
export function receiveSentence(status: WifiReceiveStatus): string {
  if (status.offer?.receiving) return "Receiving the database…";
  if (status.offer) return "A Chronie is waiting for an answer.";
  if (status.outcome) return status.outcome.message;
  if (!status.listening) {
    return "Not waiting. Nothing can be sent to this Chronie until it is.";
  }
  const where = status.addresses.length
    ? `Reachable at ${status.addresses.join(" or ")}.`
    : `Listening on port ${status.port}.`;
  return `Waiting as “${status.device}”. ${where}`;
}

/** What a send came back with, told from the sender's side. */
export function receiptSentence(receipt: WifiReceipt, address: string): string {
  if (receipt.stored) {
    return `Sent to ${address}: it now holds ${plural(receipt.segmentCount, "segment")}.`;
  }
  return receipt.reason || `${address} did not take the database.`;
}
