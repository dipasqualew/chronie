/**
 * The two halves of moving a history between machines, as they appear in Setup.
 *
 * Sending is a list of the Chronies found waiting, plus somewhere to type an address for the
 * networks where a broadcast never arrives. Receiving is a switch that starts a machine
 * waiting and an offer that turns up on it — and the offer is the important screen in the
 * whole feature, because saying yes to it destroys everything this machine has collected.
 *
 * The backend keeps the state. The panel asks for all of it on a timer and redraws from the
 * answer, so what is on screen is what the station actually thinks rather than what a click
 * hoped it did. `wifi.ts` is where the wording lives.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { plural } from "./format";
import { offerSentence, receiptSentence, receiveSentence } from "./wifi";
import type { WifiPeer, WifiReceipt, WifiReceiveStatus } from "./types";

export interface WifiActions {
  discover: () => Promise<WifiPeer[]>;
  send: (address: string) => Promise<WifiReceipt>;
  startWaiting: () => Promise<WifiReceiveStatus>;
  stopWaiting: () => Promise<WifiReceiveStatus>;
  status: () => Promise<WifiReceiveStatus>;
  answer: (accepted: boolean) => Promise<WifiReceiveStatus>;
  /** Called once a database has landed, because every view on screen is now of a history that
   * no longer exists. */
  onReplaced: () => void;
  /** Anything that went wrong, in the words the backend used. */
  onError: (error: unknown) => string;
}

export interface WifiPanelProps {
  actions: WifiActions;
  /** Whether Setup is on screen. A machine left waiting is watched wherever the reader has
   * wandered to, because what lands on it replaces every view. */
  visible: boolean;
}

/**
 * How often the station is asked what it is doing.
 *
 * A poll rather than an event because the thing being waited for arrives from another machine
 * on its own schedule, and a second's delay in noticing it costs nothing next to the walk
 * between the two computers.
 */
const POLL_MS = 1000;

export function WifiPanel({ actions, visible }: WifiPanelProps): ReactNode {
  const [peers, setPeers] = useState<WifiPeer[]>([]);
  const [address, setAddress] = useState("");
  const [sendStatus, setSendStatus] = useState("");
  const [receiveStatus, setReceiveStatus] = useState<WifiReceiveStatus | null>(null);
  const [receiveSaying, setReceiveSaying] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const addressBox = useRef<HTMLInputElement>(null);
  /** Set once a database has landed, so the reload is asked for exactly once. */
  const replaced = useRef(false);

  const listening = receiveStatus?.listening ?? false;

  function took(status: WifiReceiveStatus): void {
    setReceiveStatus(status);
    setReceiveSaying("");
    if (status.outcome?.stored && !replaced.current) {
      replaced.current = true;
      actions.onReplaced();
    }
  }

  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      try {
        const answer = await actions.status();
        if (!alive) return;
        setReceiveStatus(answer);
        setReceiveSaying("");
        if (answer.outcome?.stored && !replaced.current) {
          replaced.current = true;
          actions.onReplaced();
        }
      } catch (error) {
        if (alive) setReceiveSaying(actions.onError(error));
      }
    };
    void refresh();
    // Only while somebody could act on the answer — or while this machine is waiting, because
    // then the answer arrives from elsewhere and replaces everything on screen.
    if (!visible && !listening) return () => { alive = false; };
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [actions, visible, listening]);

  /**
   * Runs one button's work, reporting whatever went wrong under the half of the panel that
   * button belongs to — a refused offer is not news about sending, and the reverse.
   */
  async function run(
    name: string, say: (message: string) => void, action: () => Promise<void>,
  ): Promise<void> {
    setBusy(name);
    try {
      await action();
    } catch (error) {
      say(actions.onError(error));
    } finally {
      setBusy(null);
    }
  }

  const find = (): Promise<void> => run("find", setSendStatus, async () => {
    setSendStatus("Looking for other Chronies…");
    const found = await actions.discover();
    setPeers(found);
    setSendStatus(found.length
      ? `Found ${plural(found.length, "Chronie", "Chronies")} waiting.`
      : "No Chronie on this network is waiting for a database. Start one waiting on the " +
        "other machine, then look again.");
  });

  const send = (): Promise<void> => run("send", setSendStatus, async () => {
    const to = address.trim();
    if (!to) {
      setSendStatus("Choose a Chronie to send to, or type its address.");
      return;
    }
    setSendStatus(`Offering this history to ${to}…`);
    setSendStatus(receiptSentence(await actions.send(to), to));
  });

  const waitOrStop = (): Promise<void> => run("wait", setReceiveSaying, async () => {
    replaced.current = false;
    took(listening ? await actions.stopWaiting() : await actions.startWaiting());
  });

  const answer = (accepted: boolean): Promise<void> =>
    run(accepted ? "accept" : "decline", setReceiveSaying, async () => {
      took(await actions.answer(accepted));
    });

  const waiting = receiveStatus?.offer;
  // An offer that has been accepted is no longer a question, so the buttons go and the line
  // above says what is happening instead.
  const asking = waiting && !waiting.receiving ? waiting : null;

  return (
    <div className="panel setup">
      <h2>Sync over WiFi</h2>
      <p className="sub">Chronie can hand its whole history to another Chronie on this network —
        a desktop&apos;s collection onto a laptop, or a spare machine kept as a copy. The one
        receiving it loses what it had, so somebody there has to agree first.</p>
      <div className="wifi-halves">
        <section className="wifi-half" aria-labelledby="wifi-send-heading">
          <h3 id="wifi-send-heading">Send this history</h3>
          <p className="sub">Start the other Chronie waiting, then look for it here.</p>
          <div className="actions">
            <button type="button" disabled={busy === "find"} onClick={() => void find()}>
              Look for Chronies
            </button>
          </div>
          <div id="wifi-peers" className="wifi-peers">
            {peers.map((peer) => (
              <button
                key={peer.address} type="button" className="wifi-peer"
                // Choosing one fills the address in rather than sending to it. A click that
                // both picks a machine and hands it a history is a click nobody can take back.
                onClick={() => {
                  setAddress(peer.address);
                  addressBox.current?.focus();
                }}
              >
                <span className="wifi-peer-name">{peer.device}</span>
                <span className="wifi-peer-address">{peer.address}</span>
              </button>
            ))}
          </div>
          <div className="setup-grid">
            <label htmlFor="wifi-address">Address
              <span className="path-row">
                <input
                  id="wifi-address" type="text" placeholder="192.168.1.20" ref={addressBox}
                  value={address} onChange={(event) => setAddress(event.target.value)}
                />
              </span>
            </label>
            <button type="button" disabled={busy === "send"} onClick={() => void send()}>
              Send history
            </button>
          </div>
          <p id="wifi-send-status" className="status" role="status">{sendStatus}</p>
        </section>

        <section className="wifi-half" aria-labelledby="wifi-receive-heading">
          <h3 id="wifi-receive-heading">Receive a history</h3>
          <p className="sub">Nothing can be sent to this Chronie unless it is waiting, and
            nothing is replaced until the offer below is accepted.</p>
          <div className="actions">
            <button
              type="button" className={listening ? undefined : "primary"}
              disabled={busy === "wait"} onClick={() => void waitOrStop()}
            >{listening ? "Stop waiting" : "Wait for a database"}</button>
          </div>
          <p id="wifi-receive-status" className="status" role="status">
            {receiveSaying || (receiveStatus ? receiveSentence(receiveStatus) : "")}
          </p>
          {/* The one screen in the app that destroys data if it is answered without reading. */}
          <div
            id="wifi-offer" className="wifi-offer" role="group"
            aria-labelledby="wifi-offer-text" hidden={!asking}
          >
            <p id="wifi-offer-text">{asking ? offerSentence(asking.offer, asking.from) : ""}</p>
            <div className="actions">
              <button
                type="button" className="primary" disabled={busy === "accept"}
                onClick={() => void answer(true)}
              >Accept and replace</button>
              <button
                type="button" disabled={busy === "decline"} onClick={() => void answer(false)}
              >Decline</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
