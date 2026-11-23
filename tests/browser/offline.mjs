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
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://localhost:8080");
  await createWorkspace(page);
  await navigate(page, "Plugins");
  await page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) })
    .getByRole("button", { name: "Install", exact: true })
    .click();

  await page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) })
    .getByRole("button", { name: "Disable", exact: true })
    .waitFor({ timeout: 30000 });
  await navigate(page, "Tasks");
  await addColumnTemplates(page, "Tasks", ["Title"]);
  await createInlineEntry(page, { Title: "Cold offline task" });
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (await navigator.serviceWorker.getRegistration())?.active?.state,
        ),
      { timeout: 45000 },
    )
    .toBe("activated");
  await context.setOffline(true);
  await page.reload();
  await entryByName(page, "Cold offline task").waitFor({ timeout: 30000 });
  await createInlineEntry(page, { Title: "Created after offline startup" });
  await entryByName(page, "Created after offline startup").waitFor();
  await page.reload();
  await entryByName(page, "Created after offline startup").waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Production service-worker cold startup, existing records, offline creation and second reload passed",
  );
} finally {
  await browser.close();
}
