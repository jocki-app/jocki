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
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4178");
  await createWorkspace(page, "Chip controls");
  await navigate(page, "Tables");
  await createInlineEntry(page, { Name: "Chip values" });
  await entryByName(page, "Chip values")
    .getByRole("button", { name: "Open entry", exact: true })
    .click();
  const choose = async (scope, label, value) => {
    const option = page.getByRole("option", { name: value, exact: true });
    if (!(await option.isVisible()))
      await scope.getByRole("combobox", { name: label, exact: true }).click();
    await option.click();
  };
  const createChip = async (scope, label, value, keyboard = false) => {
    const input = scope.getByRole("combobox", { name: label, exact: true });
    await input.fill(value);
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(
      page.getByRole("option", { name: "Create", exact: true }),
    ).toBeVisible();
    if (keyboard) await input.press("Enter");
    else
      await page.getByRole("option", { name: "Create", exact: true }).click();
    await expect(input).toHaveValue("");
    await page.keyboard.press("Escape");
  };
  const addColumn = async (id, label, type, mode, options, defaults) => {
    if (!(await page.locator("[data-new-column]").isVisible()))
      await page
        .getByRole("button", { name: "Edit columns", exact: true })
        .click();
    const row = page.locator("[data-new-column]");
    await row.getByLabel("Column ID", { exact: true }).fill(id);
    await row.getByLabel("Label", { exact: true }).fill(label);
    await choose(row, "Base type", type);
    await choose(row, "Input mode", mode);
    for (const value of options)
      await createChip(row, "Column options", value, true);
    await row
      .getByRole("switch", { name: "Default value", exact: true })
      .click();
    if (mode === "One selection") {
      await expect(
        row.getByRole("combobox", { name: "Default value", exact: true }),
      ).toHaveAttribute("data-slot", "select-trigger");
      await choose(row, "Default value", defaults[0]);
    } else if (mode === "Multiple selections") {
      for (const value of defaults) await choose(row, "Default value", value);
      await page.keyboard.press("Escape");
    } else
      for (const value of defaults)
        await createChip(row, "Default value", value);
    await page
      .locator("[data-new-column]")
      .getByRole("button", { name: "Add column", exact: true })
      .click();
    await expect(
      page
        .locator("[data-new-column]")
        .getByLabel("Column ID", { exact: true }),
    ).toHaveValue("");
  };
  await addColumn(
    "scores",
    "Scores",
    "integer",
    "Multiple selections",
    ["1", "2", "3"],
    ["1", "3"],
  );
  await addColumn(
    "labels",
    "Labels",
    "text",
    "Multiple values",
    [],
    ["alpha", "alpha"],
  );
  await addColumn(
    "object",
    "Object",
    "jsonb",
    "One selection",
    ['{"a":1}', '{"b":2}'],
    ['{"a":1}'],
  );
  await addColumn(
    "flags",
    "Flags",
    "boolean",
    "Multiple selections",
    ["true", "false"],
    ["false"],
  );
  const create = page.locator("[data-create-row]");
  await expect(create.locator('[data-slot="combobox-chip"]')).toHaveText([
    "1",
    "3",
    "alpha",
    "alpha",
    "false",
  ]);
  await expect(create.getByLabel("Object", { exact: true })).toHaveAttribute(
    "data-slot",
    "select-trigger",
  );
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  const record = page.locator("[data-record-id]");
  await expect(record).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await createChip(record, "Labels", "beta", true);
  await expect(
    record.locator('td[data-field="labels"] [data-slot="combobox-chip"]'),
  ).toHaveText(["alpha", "alpha", "beta"]);
  await record
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await expect(
    record.locator('td[data-field="labels"] [data-slot="combobox-chip"]'),
  ).toHaveText(["alpha", "alpha"]);
  await createChip(record, "Labels", "saved", true);
  await record.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(
    record.getByRole("button", { name: "Save entry", exact: true }),
  ).toHaveCount(0);
  await expect(
    record.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: "/tmp/jocki-chips.png", fullPage: true });
  await page.reload();
  // Reopen the generic table after navigation restores its collection page.
  await entryByName(page, "Chip values")
    .getByRole("button", { name: "Open entry", exact: true })
    .click();
  await expect(
    page.locator(
      '[data-record-id] td[data-field="labels"] [data-slot="combobox-chip"]',
    ),
  ).toHaveText(["alpha", "alpha", "saved"]);
  await expect(
    page.locator(
      '[data-record-id] td[data-field="scores"] [data-slot="combobox-chip"]',
    ),
  ).toHaveText(["1", "3"]);
  expect(errors).toEqual([]);
  console.log(
    "Create-only options, keyboard creation, typed defaults, duplicate list values, discard and durable reload passed.",
  );
} finally {
  await browser.close();
}
