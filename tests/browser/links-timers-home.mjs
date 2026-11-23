import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
  createInlineEntry,
  entryByName,
} from "./navigation-helpers.mjs";
import { reviewInventory } from "./inventory-helpers.mjs";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await reviewInventory(context);
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58600");
  await createWorkspace(page, "Plugin controls");
  await navigate(page, "Plugins");
  for (const name of ["Tasks", "Track", "Time", "Dashboard"]) {
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole("button", { name: "Install", exact: true }).click();

    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
  }
  console.log("Plugins installed");
  await addColumnTemplates(page, "Tasks", ["Title"]);
  await createInlineEntry(page, { Title: "Task for links" });
  const task = entryByName(page, "Task for links");
  const icon = task.getByRole("button", {
    name: "Linked entries (0)",
    exact: true,
  });
  await expect(icon).toBeVisible();
  expect((await icon.boundingBox()).width).toBeLessThanOrEqual(32);
  await icon.click();
  await expect(
    page.getByRole("columnheader", { name: "Track", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create linked Track entry", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    task.getByRole("button", { name: "Linked entries (1)", exact: true }),
  ).toBeVisible();
  await task
    .getByRole("button", { name: "Linked entries (1)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Go to Track entry", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-linked-icons.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Go to Track entry", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Track");
  if (await page.getByRole("dialog").count())
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Current page" })
    .getByRole("button", { name: "Plugin controls", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Dashboard");
  await navigate(page, "Settings");
  await page
    .getByRole("combobox", { name: "Workspace home", exact: true })
    .click();
  await page.getByRole("option", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Current page" })
    .getByRole("button", { name: "Plugin controls", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Plugins");
  await navigate(page, "Time");
  await page
    .getByRole("combobox", { name: "Complete Alert Sound", exact: true })
    .click();
  const options = page.locator('[data-slot="select-content"][data-open]');
  await expect(options).toContainText("Once");
  await expect(options).toContainText("Indefinite");
  await page
    .getByRole("option", { name: "Chime until stopped", exact: true })
    .click();
  await page.screenshot({
    path: "/tmp/jocki-timer-alerts.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "1", exact: true }).click();
  const start = page
    .locator('[data-slot="card"]')
    .first()
    .getByRole("button", { name: "Start", exact: true });
  await start.click();
  await expect(
    page.getByRole("button", { name: "Stop Session", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("region", { name: "Workspace timers" })
      .or(page.locator('section[aria-label="Workspace timers"]')),
  ).toBeVisible();
  await navigate(page, "Tasks");
  await expect(
    page.locator('section[aria-label="Workspace timers"]'),
  ).toContainText("00:00:");
  expect(errors).toEqual([]);
  console.log(
    "Linked icon states, link popover/create/go, automatic Dashboard home, Plugins override, grouped timer tones and persistent timer UI passed.",
  );
} finally {
  await browser.close();
}
