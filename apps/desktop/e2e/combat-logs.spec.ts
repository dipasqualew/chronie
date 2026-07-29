/**
 * The combat logs category of Settings: the switch that starts them, and the sweep that
 * deletes them.
 *
 * Two panels on one page, and one scenario: what a combat log costs has to be readable before
 * anybody ticks the box, and what a sweep would take has to be readable — by name — while the
 * switch is still off. Deleting a combat log is the one thing Chronie does that cannot be
 * undone.
 */

import { expect, test } from "./harness";
import { CombatLogging, LogRetention } from "./pages/settings";

test("says what combat logging would cost, and what deleting old logs would take", async ({
  page,
}) => {
  const combat = new CombatLogging(page);
  const retention = new LogRetention(page);
  await combat.open();

  await test.step("combat logging is off, and says what turning it on would cost", async () => {
    await expect(combat.toggle()).not.toBeChecked();
    await expect(combat.state()).toHaveText(
      "Combat logging is off. Nothing is being written and nothing is using disk.",
    );
    await expect(combat.panel).toContainText("a raid night is hundreds of megabytes");
    await expect(combat.panel).toContainText(
      "Chronie deletes nothing out of the game's Logs folder unless the panel",
    );
    await expect(combat.stored()).resolves.toBe(false);
  });

  // Ticking it moves the setting and nothing else: the game's own config already has advanced
  // logging on, and no log has been written, so what the install honestly is now is set up
  // and waiting — which is what the panel has to say rather than "on".
  await test.step("ticking it turns the setting on and reports what that actually leaves", async () => {
    await combat.toggle().check();

    await expect(combat.toggle()).toBeChecked();
    await expect(combat.state()).toContainText("Advanced combat logging is set up");
    await expect(combat.state()).toContainText("no combat log at all yet");
    // The line is coloured from this, and the colour is half of what the sentence means.
    await expect(combat.state()).toHaveAttribute("data-state", "stale");
    await expect(combat.stored()).resolves.toBe(true);
  });

  // The sentence is a claim about this install, so the panel shows what it read it from.
  await test.step("and shows the evidence it read that from", async () => {
    await expect(combat.panel).toContainText("No combat log found in the game's Logs folder.");
    await expect(combat.panel).toContainText(
      "Advanced logging reads on in WTF/Account/EXAMPLE/config-cache.wtf.",
    );
  });

  // A summary printed after the first sweep would be a report of a decision nobody was given
  // the chance to make.
  await test.step("deleting old logs is off, and names what turning it on would take", async () => {
    await expect(retention.toggle()).not.toBeChecked();
    await expect(retention.state()).toContainText("Chronie deletes no combat logs");
    await expect(retention.state()).toContainText("Turning this on at 7 days would delete 2 logs");
    await expect(retention.panel).toContainText("Would go on the next sync:");
    await expect(retention.panel).toContainText("WoWCombatLog-071026_201500.txt");
    await expect(retention.panel).toContainText("WoWCombatLog-071126_193000.txt");
    await expect(retention.stored()).resolves.toBeNull();
  });

  // The gigabyte nothing has ever read is the file this whole feature is careful about. It is
  // never swept, and a tool that skipped it silently would be indistinguishable from one that
  // was not running — so it is named, sized, and handed back to the reader.
  await test.step("and says which old logs it will never delete by itself", async () => {
    await expect(retention.panel).toContainText("1 log, 1.0 GB");
    await expect(retention.panel).toContainText("never been read by Chronie");
    await expect(retention.panel).toContainText(
      "These are never deleted. Removing them is yours to do.",
    );
    await expect(retention.panel).toContainText("Never deleted by Chronie:");
    await expect(retention.panel).toContainText("WoWCombatLog-032526_204500.txt");
  });

  await test.step("turning it on records the window and says what goes next sync", async () => {
    await retention.toggle().check();

    await expect(retention.toggle()).toBeChecked();
    await expect(retention.stored()).resolves.toBe(7);
    await expect(retention.state()).toContainText("older than 7 days");
    await expect(retention.state()).toContainText("2 logs, 384.0 MB go on the next sync");
    await expect(retention.panel).toContainText("Going on the next sync:");
  });

  // A longer window is the same feature with a different number, and it has to reach the
  // setting rather than only the box it was typed into.
  await test.step("and a longer window reaches the setting, not only the box", async () => {
    await retention.days().fill("30");
    await retention.days().blur();

    await expect(retention.stored()).resolves.toBe(30);
    await expect(retention.state()).toContainText("older than 30 days");
  });
});
