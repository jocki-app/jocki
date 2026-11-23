import { createInlineEntry, entryByName } from "./navigation-helpers.mjs";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://localhost:4173");
  await createWorkspace(page);
  await navigate(page, "Plugins");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await row
    .getByRole("button", { name: "Install", exact: true })
    .click({ timeout: 30000 });

  await expect(row.getByText("Enabled", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await navigate(page, "Tasks");
  await addColumnTemplates(page, "Tasks", ["Title"]);
  await createInlineEntry(page, { Title: "Offline downloaded plugin" });
  await expect(entryByName(page, "Offline downloaded plugin")).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(entryByName(page, "Offline downloaded plugin")).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(entryByName(page, "Offline downloaded plugin")).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Board", exact: true }).click();
  await expect(entryByName(page, "Offline downloaded plugin")).toBeVisible();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Public HTTPS download, signed browser module, production service worker and full offline reload passed",
  );
  await context.close();
} finally {
  await browser.close();
}
