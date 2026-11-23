import { reviewInventory } from "./inventory-helpers.mjs";
import { createInlineEntry, entryByName } from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  await reviewInventory(page.context());
  page.on("pageerror", (e) => errors.push(e.message));
  const click = (name) =>
    page
      .getByRole("button", { name, exact: true })
      .click()
      .catch(async (e) => {
        console.error(await page.locator("body").innerText());
        throw e;
      });
  let editingRow;
  const choose = async (label, value) => {
    await editingRow.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4177");
  await createWorkspace(page);
  await navigate(page, "Tables");
  await createInlineEntry(page, { Name: "Typed selections" });
  await entryByName(page, "Typed selections")
    .getByRole("button", { name: "Open entry", exact: true })
    .click();
  await expect(page.locator("th[data-field]")).toHaveCount(0);
  const column = async () => {
    if (!(await page.locator("[data-new-column]").isVisible()))
      await click("Edit columns");
    editingRow = page.locator("[data-new-column]");
    await editingRow.getByLabel("Column ID", { exact: true }).fill("scores");
    await editingRow.getByLabel("Label", { exact: true }).fill("Scores");
    await choose("Base type", "integer");
    await choose("Input mode", "Multiple selections");
    for (const value of ["1", "2", "3"]) {
      await editingRow
        .getByLabel("Column options", { exact: true })
        .fill(value);
      await page.getByRole("option", { name: "Create", exact: true }).click();
    }
    await page.keyboard.press("Escape");
    await editingRow.getByLabel("Minimum inputs", { exact: true }).fill("1");
    await editingRow.getByLabel("Maximum inputs", { exact: true }).fill("2");
    await page
      .locator("[data-new-column]")
      .getByRole("button", { name: "Add column", exact: true })
      .click();
    await expect(
      page
        .locator("[data-new-column]")
        .getByLabel("Column ID", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByRole("region", { name: "Column editor" }),
    ).toHaveCount(0);
  };
  await column();
  const scores = page
    .locator("[data-create-row]")
    .getByLabel("Scores", { exact: true });
  await scores.click();
  await page.getByRole("option", { name: "1", exact: true }).click();
  await page.getByRole("option", { name: "3", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "2", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await click("Add entry");
  await expect(
    page.locator(
      '[data-record-id] td[data-field="scores"] [data-slot="combobox-chip"]',
    ),
  ).toHaveText(["1", "3"]);
  await expect(
    page.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await click("Remove Scores column");
  await expect(page.locator('td[data-field="scores"]')).toHaveCount(0);
  // Re-adding the same ID restores its values.
  await column();
  await expect(
    page.locator(
      '[data-record-id] td[data-field="scores"] [data-slot="combobox-chip"]',
    ),
  ).toHaveText(["1", "3"]);
  editingRow = page.locator('[data-column-id="scores"]');
  const saveScores = editingRow.getByRole("button", {
    name: "Save Scores column",
    exact: true,
  });
  const discardScores = editingRow.getByRole("button", {
    name: "Discard Scores column changes",
    exact: true,
  });
  await expect(saveScores).toHaveCount(0);
  await expect(discardScores).toHaveCount(0);
  await editingRow.getByLabel("Label", { exact: true }).fill("Changed");
  await expect(saveScores).toBeEnabled();
  await expect(discardScores).toBeEnabled();
  await editingRow.getByLabel("Label", { exact: true }).fill("Scores");
  await expect(saveScores).toHaveCount(0);
  await expect(discardScores).toHaveCount(0);
  await choose("Column visibility", "Read only");
  await click("Save Scores column");
  await expect(
    page.locator('[data-record-id] td[data-field="scores"]'),
  ).toContainText("1, 3");
  await expect(
    page.locator('[data-record-id] td[data-field="scores"] input'),
  ).toHaveCount(0);
  await choose("Column visibility", "Hidden");
  await click("Save Scores column");
  await expect(page.locator('td[data-field="scores"]')).toHaveCount(0);
  const columnsMenu = page
    .locator("[data-record-collection]")
    .getByRole("button", { name: "Columns", exact: true });
  await columnsMenu.click();
  const showScores = page.getByRole("switch", {
    name: "Show column Scores",
    exact: true,
  });
  await expect(showScores).not.toBeChecked();
  await showScores.check();
  await expect(page.locator('td[data-field="scores"]')).toHaveCount(2);
  await click("Reset columns");
  await expect(showScores).not.toBeChecked();
  await expect(page.locator('td[data-field="scores"]')).toHaveCount(0);
  await columnsMenu.click();
  await editingRow.getByLabel("Label", { exact: true }).fill("Unsaved label");
  await click("Discard Scores column changes");
  await expect(editingRow.getByLabel("Label", { exact: true })).toHaveValue(
    "Scores",
  );
  await editingRow
    .getByLabel("Column options", { exact: true })
    .fill("invalid JSON");
  await page.getByRole("option", { name: "Create", exact: true }).click();
  await page.keyboard.press("Escape");
  await click("Save Scores column");
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]').first(),
  ).toBeVisible();
  await expect(
    editingRow.getByLabel("Column options", { exact: true }),
  ).toHaveValue("invalid JSON");
  await click("Discard Scores column changes");
  await expect(editingRow.getByRole("alert")).toHaveCount(0);
  await expect(saveScores).toHaveCount(0);
  await expect(discardScores).toHaveCount(0);
  if (!(await page.locator("[data-new-column]").isVisible()))
    await click("Edit columns");
  const duplicate = page.locator("[data-new-column]");
  await duplicate.getByLabel("Column ID", { exact: true }).fill("scores");
  await duplicate.getByLabel("Label", { exact: true }).fill("Duplicate");
  await page
    .locator("[data-new-column]")
    .getByRole("button", { name: "Add column", exact: true })
    .click();
  await expect(
    page
      .locator('[data-sonner-toast][data-type="error"]')
      .filter({ hasText: "already exists" }),
  ).toBeVisible();
  await click("Clear new column");
  await expect(
    page.locator("[data-new-column]").getByLabel("Column ID", { exact: true }),
  ).toHaveValue("");
  await page.screenshot({
    path: "/tmp/jocki-inline-columns.png",
    fullPage: true,
  });
  await navigate(page, "Plugins");
  const plugin = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await plugin.getByRole("button", { name: "Install", exact: true }).click();

  await plugin.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await addColumnTemplates(page, "Tasks", ["Title", "Status"]);
  await click("Open plugins menu");
  await click("Tasks pages");
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("button", { name: "Columns", exact: true })
    .click();
  const uid = page.locator('[data-column-id="uid"]');
  await expect(uid.getByLabel("Base type", { exact: true })).toBeDisabled();
  await expect(
    uid.getByRole("button", { name: /^Remove .* column$/ }),
  ).toBeDisabled();
  editingRow = uid;
  await expect(
    uid.getByLabel("Column visibility", { exact: true }),
  ).toBeEnabled();
  await uid.getByLabel("Column visibility", { exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Editable", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "Add when needed", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "Hidden", exact: true }).click();
  await click("Save UID column");
  await expect(
    uid.getByLabel("Column visibility", { exact: true }),
  ).toContainText("Hidden");
  await expect(
    uid.getByLabel("Column visibility", { exact: true }),
  ).toBeEnabled();
  editingRow = page.locator('[data-column-id="status"]');
  await choose("Status plugin feature", "Not mapped");
  await choose("Base type", "integer");
  await choose("Input mode", "One value");
  await editingRow
    .getByRole("switch", { name: "Default value", exact: true })
    .click();
  await click("Save Status column");
  await expect(
    editingRow.getByRole("button", { name: "Save Status column", exact: true }),
  ).toHaveCount(0);
  await navigate(page, "Tasks");
  await expect(page.locator('th[data-field="uid"]')).toHaveCount(0);
  await createInlineEntry(page, { Title: "Independent template", Status: "7" });
  const completion = page.getByRole("button", {
    name: "Toggle task completion",
    exact: true,
  });
  await expect(completion).toHaveCount(0);
  await expect(
    page.locator('[data-record-id] td[data-field="status"] input'),
  ).toHaveValue("7");
  const row = page.locator("[data-record-id]");
  await expect(row.locator("td").first()).toHaveAttribute(
    "data-table-actions",
    "true",
  );
  const buttons = await row.locator("[data-table-actions] button").all();
  const boxes = await Promise.all(
    buttons.map((button) => button.boundingBox()),
  );
  expect(
    new Set(
      boxes.filter(Boolean).map((box) => Math.round(box.y + box.height / 2)),
    ).size,
  ).toBe(1);
  await page.screenshot({
    path: "/tmp/jocki-inline-records.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "Shared column editor, typed multiple inputs, count limits, removed-value preservation and read-only controls passed.",
  );
} finally {
  await browser.close();
}
