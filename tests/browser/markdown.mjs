import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  createInlineEntry,
  entryByName,
} from "./navigation-helpers.mjs";

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1050 },
  });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4173");
  await createWorkspace(page, "Markdown fields");
  await navigate(page, "Tables");
  await createInlineEntry(page, { Name: "Markdown notes" });
  const openTable = () =>
    entryByName(page, "Markdown notes")
      .getByRole("button", { name: "Open entry", exact: true })
      .click();
  await openTable();
  const choose = async (scope, label, value) => {
    await scope.getByRole("combobox", { name: label, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  await page.getByRole("button", { name: "Edit columns", exact: true }).click();
  const column = page.locator("[data-new-column]");
  await column.getByLabel("Column ID", { exact: true }).fill("notes");
  await column.getByLabel("Label", { exact: true }).fill("Notes");
  await choose(column, "Input mode", "Multiple values");
  await choose(column, "Base type", "Markdown");
  await expect(
    column.getByRole("combobox", { name: "Input mode", exact: true }),
  ).toBeDisabled();
  await expect(
    column.getByRole("combobox", { name: "Input mode", exact: true }),
  ).toContainText("One value");
  await column
    .getByRole("switch", { name: "Default value", exact: true })
    .click();
  const defaults = "**Default note**\n\n- [ ] Review";
  await column
    .getByRole("textbox", { name: "Default value", exact: true })
    .fill(defaults);
  await column.getByLabel("Label", { exact: true }).click();
  await expect(column.locator(".cm-atomic-strong")).toBeVisible();
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await expect(
    page.locator("[data-new-column]").getByLabel("Column ID", { exact: true }),
  ).toHaveValue("");
  const newRecord = page.locator("[data-create-row]");
  await expect(
    newRecord.getByRole("textbox", { name: "Notes", exact: true }),
  ).toContainText("Default note");
  await expect(newRecord.locator("[data-markdown-field] button")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  const record = page.locator("[data-record-id]");
  await expect(record).toHaveCount(1);
  const input = () =>
    record.getByRole("textbox", { name: "Notes", exact: true });
  await input().fill("Discard this");
  await record
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await expect(input()).toContainText("Default note");
  const saved =
    "# Saved heading\n\n**Bold text** and _italic_.\n\n- [ ] Review";
  await input().fill(saved);
  await input().press("End");
  await input().pressSequentially(" later", { delay: 15 });
  await expect(input()).toBeFocused();
  await expect(input()).toContainText("Review later");
  await input().press("Tab");
  await expect(input()).not.toBeFocused();
  await expect(record.locator(".cm-atomic-strong")).toBeVisible();
  const height = await record
    .locator("[data-markdown-field]")
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(36);
  expect(height).toBeLessThan(300);
  await record.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(
    record.getByRole("button", { name: "Save entry", exact: true }),
  ).toHaveCount(0);
  await expect(
    record.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await openTable();
  await expect(input()).toContainText("Saved heading");
  await expect(input()).toContainText("Review later");
  await page.getByRole("button", { name: "Edit columns", exact: true }).click();
  const savedColumn = page.locator('[data-column-id="notes"]');
  await choose(savedColumn, "Column visibility", "Read only");
  await savedColumn
    .getByRole("button", { name: "Save Notes column", exact: true })
    .click();
  await expect(input()).toHaveAttribute("contenteditable", "false");
  const checkbox = record.locator(
    'input[type="checkbox"].cm-atomic-task-checkbox',
  );
  await checkbox.evaluate((el) => el.click());
  await expect(checkbox).not.toBeChecked();
  await expect(
    record.getByRole("button", { name: "Save entry", exact: true }),
  ).toHaveCount(0);
  await expect(record.locator(".cm-atomic-strong")).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-markdown.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "Markdown defaults, live editing, focus, discard, save/reload and read-only rendering passed.",
  );
} finally {
  await browser.close();
}
