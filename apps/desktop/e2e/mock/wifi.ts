/**
 * Both ends of a transfer over the network: another Chronie waiting, and one knocking.
 *
 * Its own module because the page under test is the only place the two halves ever meet, and
 * because half of it is state rather than a fixture — sending a database from the page writes
 * here.
 */

import type { E2EMock } from "../../src/types";

// One other Chronie on the network waiting for a database, and one sender knocking at this
// one the moment it starts waiting. Both halves of a transfer are on this page, which is
// the only place the two ever meet in a test.
export const wifi: E2EMock["wifi"] = {
  peers: [{ device: "Study desktop", address: "192.168.1.20:51571" }],
  receipt: { stored: true, reason: "", segmentCount: 1204 },
  status: {
    listening: false,
    device: "Kitchen laptop",
    addresses: ["192.168.1.31:51571"],
    port: 51571,
    offer: null,
    outcome: null,
  },
  incoming: {
    from: "192.168.1.20",
    receiving: false,
    offer: {
      protocol: 1,
      device: "Study desktop",
      segmentCount: 1204,
      characterCount: 3,
      newestDay: "2026-07-26",
      bytes: 4_404_019,
    },
  },
  sentTo: [],
};
