/**
 * Handing a whole history to another Chronie on the network.
 *
 * Two scenarios, because they are two machines: the one that offers and the one that agrees.
 * Both halves happen to be on this page, which is the only place in this suite the two ever
 * meet — and the rule that shapes both is that one click must never be enough.
 */

import { expect, test } from "./harness";
import { Wifi } from "./pages/wifi";

test("finds another Chronie on the network and offers this history to it", async ({ page }) => {
  const wifi = new Wifi(page);
  await wifi.open();

  await test.step("looking finds the one that is waiting", async () => {
    await wifi.button("sending", "Look for Chronies").click();

    await expect(wifi.sendStatus()).toHaveText("Found 1 Chronie waiting.");
    await expect(wifi.button("sending", /Study desktop/)).toBeVisible();
  });

  // Choosing a Chronie fills its address in rather than sending to it, which is the rule worth
  // holding: a click that both picks a machine and hands it a history is one nobody can undo.
  await test.step("choosing one fills its address in, and sends nothing", async () => {
    await wifi.button("sending", /Study desktop/).click();

    await expect(wifi.address()).toHaveValue("192.168.1.20:51571");
    await expect(wifi.sentTo()).resolves.toEqual([]);
  });

  await test.step("and the second click is what hands the history over", async () => {
    await wifi.button("sending", "Send history").click();

    await expect(wifi.sendStatus()).toHaveText(
      "Sent to 192.168.1.20:51571: it now holds 1204 segments.",
    );
    await expect(wifi.sentTo()).resolves.toEqual(["192.168.1.20:51571"]);
  });
});

test("takes a history from another Chronie only once somebody agrees", async ({ page }) => {
  const wifi = new Wifi(page);
  await wifi.open();

  await test.step("nothing can arrive until this Chronie is waiting", async () => {
    await expect(wifi.receiveStatus()).toContainText("Not waiting");
    await expect(wifi.offer()).toBeHidden();
  });

  // What the offer says is asserted rather than only that it appeared: accepting throws away
  // everything this machine has collected, and the sentence above the button is the only thing
  // standing between a reader and that.
  await test.step("waiting brings an offer, which says what accepting would cost", async () => {
    await wifi.button("receiving", "Wait for a database").click();

    await expect(wifi.offer()).toBeVisible();
    await expect(wifi.offer()).toContainText("Study desktop (192.168.1.20)");
    await expect(wifi.offer()).toContainText("1204 segments across 3 characters");
    await expect(wifi.offer()).toContainText("4.2 MB");
    await expect(wifi.offer()).toContainText("replaces everything this Chronie has collected");
  });

  await test.step("declining leaves this history where it was", async () => {
    await wifi.offer().getByRole("button", { name: "Decline" }).click();

    await expect(wifi.offer()).toBeHidden();
    await expect(wifi.receiveStatus()).toContainText(
      "Turned down the database from Study desktop.",
    );
  });

  await test.step("accepting says what replaced what", async () => {
    // Stopping and starting again is how the panel gets a second offer, which is also how
    // somebody would recover from having declined the transfer they actually wanted.
    await wifi.button("receiving", "Stop waiting").click();
    await wifi.button("receiving", "Wait for a database").click();
    await expect(wifi.offer()).toBeVisible();

    await wifi.offer().getByRole("button", { name: "Accept and replace" }).click();

    await expect(wifi.offer()).toBeHidden();
    await expect(wifi.receiveStatus()).toContainText(
      "Replaced this history with Study desktop's: 1204 segments",
    );
  });
});
