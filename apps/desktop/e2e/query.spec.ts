/**
 * The whole of the Query view, from opening it to being told a column does not exist.
 *
 * The steps are in the order somebody actually meets them, and the first one is the one the
 * feature stands or falls on: the view opens already answered, with a picture of a real
 * question, rather than as an empty box waiting for somebody to know SQL before it will show
 * them anything.
 */

import { expect, test } from "./harness";
import { Workbench } from "./pages/query";

test("asks the history a question and draws the answer", async ({ page }) => {
  const workbench = new Workbench(page);
  await workbench.open();

  await test.step("opens on a question already asked, and a chart of it", async () => {
    await expect(workbench.summary()).toHaveText("3 rows · 2 columns · 3 ms");
    // The chart says what it is drawing in the name it is announced by, which is the only
    // thing a reader who cannot see it would be given.
    await expect(workbench.chart())
      .toHaveAccessibleName("hours by character, as a bar chart of 3 values");
    await expect(workbench.rows()).toHaveCount(3);
    await expect(workbench.rows().first()).toContainText("Aster-Vale");
    await expect(workbench.rows().first()).toContainText("41.5");
  });

  await test.step("redraws the same answer as another shape", async () => {
    await workbench.choice("Chart shape").selectOption("line");
    await expect(workbench.chart())
      .toHaveAccessibleName("hours by character, as a line chart of 3 values");
  });

  await test.step("takes another question from the ones offered", async () => {
    await workbench.recipe("Hours per day").click();

    await expect(workbench.editor()).toHaveValue(/GROUP BY s.ended_day/);
    await expect(workbench.summary()).toHaveText("4 rows · 2 columns · 5 ms");
    // The recipe says what to plot and how, so a question about days over time arrives as a
    // line rather than as whatever the column order happened to suggest.
    await expect(workbench.chart())
      .toHaveAccessibleName("hours by day, as a line chart of 4 values");
    await expect(workbench.rows()).toHaveCount(4);
  });

  await test.step("opens a table from the list and asks for all of it", async () => {
    const characters = await workbench.openTable("characters");
    await expect(characters).toContainText("class_file");

    await characters.getByRole("button", { name: "SELECT * FROM characters" }).click();

    await expect(workbench.editor()).toHaveValue('SELECT * FROM "characters" LIMIT 50');
    await expect(workbench.rows()).toHaveCount(3);
    // Nothing said what to plot, so the convention did: the first column that names things
    // along the bottom, the first that counts them up the side.
    await expect(workbench.chart())
      .toHaveAccessibleName("id by name, as a bar chart of 3 values");
    // The character with no class recorded. An empty cell and a cell holding nothing look
    // identical on screen, and only one of them is what the database said.
    await expect(workbench.rows().last()).toContainText("—");
  });

  await test.step("says why a query was refused, and keeps the rows that worked", async () => {
    await workbench.editor().fill("SELECT charater FROM segments");
    await workbench.run();

    await expect(workbench.failure()).toHaveText("no such column: charater");
    // The last answer is still on screen: a mistyped column is one keystroke from a working
    // query, and taking the rows away to say so would be a punishment for a typo.
    await expect(workbench.rows()).toHaveCount(3);
  });
});
