import { reviewInventory } from "./inventory-helpers.mjs";
import { _electron as electron, expect as baseExpect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWorkspace,
  navigate,
  createInlineEntry,
  entryByName,
} from "./navigation-helpers.mjs";
const expect = baseExpect.configure({ timeout: 60000 });
const directory = await mkdtemp(
  path.join(os.tmpdir(), "jocki-shared-schemas-"),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    ...(env.JOCKI_DESKTOP_EXECUTABLE
      ? { executablePath: env.JOCKI_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(env.JOCKI_DESKTOP_EXECUTABLE ? [] : [process.cwd()]),
      "--use-mock-keychain",
      `--user-data-dir=${directory}`,
    ],
    env,
  });
  const page = await app.firstWindow();
  await reviewInventory(page.context());
  page.setDefaultTimeout(60000);
  await createWorkspace(page, "Shared schema test");
  await page.evaluate(async () => {
    if (!window.jockiNative?.timers)
      throw Error("Native timers unavailable");
    await window.jockiNative.timers.present({ timers: [] });
    const granted = await window.jockiNative.timers.requestPermission();
    if (typeof granted !== "boolean")
      throw Error("Invalid timer capability response");
  });
  await navigate(page, "Plugins");
  for (const name of ["Tasks", "Track"]) {
    const plugin = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await plugin.getByRole("button", { name: "Install", exact: true }).click();

    await plugin
      .getByRole("button", { name: "Disable", exact: true })
      .waitFor();
  }
  await navigate(page, "Tasks");
  const schemaRoute = page.url();
  await page.getByRole("combobox", { name: "Schema", exact: true }).click();
  await page.getByRole("button", { name: "New schema", exact: true }).click();
  await page.getByLabel("Schema name", { exact: true }).fill("Unified");
  await page
    .getByRole("button", { name: "Create schema", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Schema", exact: true }),
  ).toContainText("Unified");
  expect(page.url()).toBe(schemaRoute);
  await page.getByRole("combobox", { name: "Schema", exact: true }).click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  expect(page.url()).toBe(schemaRoute);
  await page.getByRole("combobox", { name: "Schema", exact: true }).click();
  await page.getByRole("option", { name: "Unified", exact: true }).click();
  await page
    .getByRole("button", { name: "Open plugins menu", exact: true })
    .click();
  const footerSchema = page
    .locator('[data-slot="sheet-content"]')
    .getByRole("combobox", { name: "Schema", exact: true });
  await expect(footerSchema).toContainText("Unified");
  await footerSchema.click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await expect(footerSchema).toContainText("Default");
  expect(page.url()).toBe(schemaRoute);
  await footerSchema.click();
  await page.getByRole("option", { name: "Unified", exact: true }).click();
  await expect(footerSchema).toContainText("Unified");
  const menu = page.getByRole("navigation", { name: "Workspace", exact: true });
  await menu.getByRole("button", { name: "Tasks pages", exact: true }).click();
  await menu.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("button", { name: "Title", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove Title column", exact: true }),
  ).toHaveCount(0);
  await page
    .locator("[data-new-column]")
    .getByRole("combobox", { name: "Column storage", exact: true })
    .click();
  await page.getByRole("option", { name: "Shared item", exact: true }).click();
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove Title column", exact: true })
    .waitFor();
  await expect(
    page.getByRole("columnheader", { name: "Storage", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove Item ID column", exact: true }),
  ).toBeDisabled();
  await navigate(page, "Tasks");
  await createInlineEntry(page, { Title: "Linked item" });
  await navigate(page, "Track");
  await expect(
    page.getByRole("combobox", { name: "Schema", exact: true }),
  ).toContainText("Unified");
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  const openDraft = async () => {
    await navigate(page, "Tasks");
    await entryByName(page, "Linked item")
      .getByRole("button", { name: "Linked entries (0)", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create linked Track entry", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(
      "Linked item",
    );
    return dialog;
  };
  await (
    await openDraft()
  )
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await navigate(page, "Track");
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  await (
    await openDraft()
  )
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate(page, "Track");
  await expect(entryByName(page, "Linked item")).toHaveCount(1);
  const linkedId = await entryByName(page, "Linked item").getAttribute(
    "data-record-id",
  );
  const linked = page.locator(`[data-record-id="${linkedId}"]`);
  await linked.getByLabel("Title", { exact: true }).fill("Shared edit");
  await linked.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await navigate(page, "Tasks");
  await expect(entryByName(page, "Shared edit")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Schema", exact: true }).click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  await navigate(page, "Track");
  await expect(
    page.getByRole("combobox", { name: "Schema", exact: true }),
  ).toContainText("Default");
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  console.log(
    "Shared schema selection, column storage, optional linked drafts, cancellation and shared edits passed.",
  );
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
