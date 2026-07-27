/**
 * The two halves of moving a history between machines, as they appear in Setup.
 *
 * Sending is a list of the Chronies found waiting, plus somewhere to type an address for the
 * networks where a broadcast never arrives. Receiving is a switch that starts a machine
 * waiting and an offer that turns up on it — and the offer is the important screen in the
 * whole feature, because saying yes to it destroys everything this machine has collected.
 * So it is spelled out rather than summarised: who is sending, how much, and what goes.
 *
 * Everything below is drawing and wording. The backend keeps the state, the panel asks for
 * all of it on a timer and redraws from the answer, so what is on screen is what the station
 * actually thinks rather than what a click hoped it did.
 */

import { escapeHtml, plural } from "./format";
import type { WifiOffer, WifiPeer, WifiReceipt, WifiReceiveStatus } from "./types";

export interface WifiElements {
  find: HTMLButtonElement;
  peers: HTMLElement;
  address: HTMLInputElement;
  send: HTMLButtonElement;
  sendStatus: HTMLElement;
  wait: HTMLButtonElement;
  receiveStatus: HTMLElement;
  offer: HTMLElement;
  offerText: HTMLElement;
  accept: HTMLButtonElement;
  decline: HTMLButtonElement;
}

export interface WifiActions {
  discover: () => Promise<WifiPeer[]>;
  send: (address: string) => Promise<WifiReceipt>;
  startWaiting: () => Promise<WifiReceiveStatus>;
  stopWaiting: () => Promise<WifiReceiveStatus>;
  status: () => Promise<WifiReceiveStatus>;
  answer: (accepted: boolean) => Promise<WifiReceiveStatus>;
  /** Called once a database has landed, because every view on screen is now of a history
   * that no longer exists. */
  onReplaced: () => void;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

/** A database's size the way a person judges "is that mine?" — never more than three digits. */
export function fileSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = Math.max(bytes || 0, 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * What a machine is being asked to accept, and what accepting costs it.
 *
 * The second sentence is the one that matters and it is deliberately blunt: everything about
 * this exchange is reversible except the moment somebody clicks Accept without reading.
 */
export function offerSentence(offer: WifiOffer, from: string): string {
  const upTo = offer.newestDay ? `, up to ${offer.newestDay}` : "";
  return `${offer.device} (${from}) is offering a history of ` +
    `${plural(offer.segmentCount, "segment")} across ` +
    `${plural(offer.characterCount, "character")}${upTo} — ${fileSize(offer.bytes)}. ` +
    "Accepting replaces everything this Chronie has collected.";
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

export function createWifiSync(options: {
  elements: WifiElements;
  actions: WifiActions;
}): { refresh: () => Promise<void>; watch: (visible: () => boolean) => void } {
  const { elements, actions } = options;
  let peers: WifiPeer[] = [];
  let listening = false;
  /** Set while a database has just landed, so the reload is asked for exactly once. */
  let replaced = false;

  function drawPeers(): void {
    elements.peers.innerHTML = peers.map((peer) => `
      <button type="button" class="wifi-peer" data-address="${escapeHtml(peer.address)}">
        <span class="wifi-peer-name">${escapeHtml(peer.device)}</span>
        <span class="wifi-peer-address">${escapeHtml(peer.address)}</span>
      </button>`).join("");
    elements.peers.querySelectorAll<HTMLButtonElement>(".wifi-peer").forEach((button) => {
      button.addEventListener("click", () => {
        // Choosing one fills the address in rather than sending to it. A click that both
        // picks a machine and hands it a history is a click nobody can take back.
        elements.address.value = button.dataset.address || "";
        elements.address.focus();
      });
    });
  }

  function drawReceiving(status: WifiReceiveStatus): void {
    listening = status.listening;
    elements.wait.textContent = status.listening ? "Stop waiting" : "Wait for a database";
    elements.wait.classList.toggle("primary", !status.listening);
    elements.receiveStatus.textContent = receiveSentence(status);
    const waiting = status.offer;
    // An offer that has been accepted is no longer a question, so the buttons go and the
    // line above says what is happening instead.
    elements.offer.hidden = !waiting || waiting.receiving;
    if (waiting && !waiting.receiving) {
      elements.offerText.textContent = offerSentence(waiting.offer, waiting.from);
    }
    if (status.outcome?.stored && !replaced) {
      replaced = true;
      actions.onReplaced();
    }
  }

  async function refresh(): Promise<void> {
    try {
      drawReceiving(await actions.status());
    } catch (error) {
      elements.receiveStatus.textContent = actions.onError(error);
    }
  }

  /**
   * Runs one button's work, reporting whatever went wrong under the half of the panel that
   * button belongs to — a refused offer is not news about sending, and the reverse.
   */
  async function run(
    button: HTMLButtonElement,
    status: HTMLElement,
    action: () => Promise<void>,
  ): Promise<void> {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      status.textContent = actions.onError(error);
    } finally {
      button.disabled = false;
    }
  }

  const sending = (button: HTMLButtonElement, action: () => Promise<void>): Promise<void> =>
    run(button, elements.sendStatus, action);
  const receiving = (button: HTMLButtonElement, action: () => Promise<void>): Promise<void> =>
    run(button, elements.receiveStatus, action);

  elements.find.addEventListener("click", () => void sending(elements.find, async () => {
    elements.sendStatus.textContent = "Looking for other Chronies…";
    peers = await actions.discover();
    drawPeers();
    elements.sendStatus.textContent = peers.length
      ? `Found ${plural(peers.length, "Chronie", "Chronies")} waiting.`
      : "No Chronie on this network is waiting for a database. Start one waiting on the " +
        "other machine, then look again.";
  }));

  elements.send.addEventListener("click", () => void sending(elements.send, async () => {
    const address = elements.address.value.trim();
    if (!address) {
      elements.sendStatus.textContent = "Choose a Chronie to send to, or type its address.";
      return;
    }
    elements.sendStatus.textContent = `Offering this history to ${address}…`;
    elements.sendStatus.textContent = receiptSentence(await actions.send(address), address);
  }));

  elements.wait.addEventListener("click", () => void receiving(elements.wait, async () => {
    replaced = false;
    drawReceiving(listening ? await actions.stopWaiting() : await actions.startWaiting());
  }));

  elements.accept.addEventListener("click", () => void receiving(elements.accept, async () => {
    drawReceiving(await actions.answer(true));
  }));

  elements.decline.addEventListener("click", () => void receiving(elements.decline, async () => {
    drawReceiving(await actions.answer(false));
  }));

  return {
    refresh,
    /**
     * Asks the station what it is doing, over and over.
     *
     * A poll rather than an event because the thing being waited for arrives from another
     * machine on its own schedule, and a second's delay in noticing it costs nothing next to
     * the walk between the two computers. Only while somebody could act on the answer,
     * though: `visible` is the panel being on screen, and a machine left waiting is watched
     * wherever the reader has wandered to, because what lands on it replaces every view.
     */
    watch(visible: () => boolean): void {
      setInterval(() => {
        if (visible() || listening) void refresh();
      }, 1000);
    },
  };
}
