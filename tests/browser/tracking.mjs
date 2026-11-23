import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
import { reviewInventory } from "./inventory-helpers.mjs";
const browser = await chromium.launch({ headless: true });
try {
  console.log("Browser opened");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await reviewInventory(context);
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58597");
  await createWorkspace(page, "Tracking layout test");
  console.log("Workspace created");
  await navigate(page, "Plugins");
  for (const name of ["Track", "Time"]) {
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole("button", { name: "Install", exact: true }).click();

    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
  }
  console.log("Plugins installed");
  await addColumnTemplates(page, "Track", ["Activity"]);
  console.log("Track fields configured");
  await expect(
    page.getByRole("button", { name: "Start At", exact: true }),
  ).toBeVisible();
  // The Session panel has the same typed field as the configured collection.
  await page
    .getByLabel("Activity", { exact: true })
    .first()
    .fill("Historical layout session");
  await page
    .locator('[data-slot="card"]')
    .first()
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop Session", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop Session", exact: true }).click();
  await expect(
    page
      .locator('[data-slot="card"]')
      .first()
      .getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  for (const name of ["Start", "End", "Duration"])
    await expect(
      page.getByRole("columnheader", { name, exact: true }),
    ).toBeVisible();
  await expect(page.getByLabel("Filter field", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Filter value", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Choose fields", exact: true }),
  ).toHaveCount(0);
  const chooseView = async (name) => {
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  await chooseView("Week");
  await expect(page.locator('[data-collection-display="week"]')).toContainText(
    "1 entry",
  );
  await expect(
    page.getByRole("button", {
      name: "Historical layout session",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Historical layout session", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Edit Entry");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.screenshot({
    path: "/tmp/jocki-track-week.png",
    fullPage: true,
  });
  await chooseView("Month");
  await expect(
    page.getByRole("button", { name: /Historical layout session/ }),
  ).toBeVisible();
  for (const name of ["Time", "Track", "Time", "Track", "Time"]) {
    await navigate(page, name);
    await expect(page.locator("[data-table-picker]")).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Schema", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "New schema", exact: true }),
    ).toHaveCount(0);
  }
  await expect(page.getByRole("timer")).toHaveText("00:15:00");
  await expect(
    page.getByRole("combobox", { name: "Complete Alert Sound", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Vibrate", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "5", exact: true }).click();
  await expect(page.getByRole("timer")).toHaveText("00:05:00");
  await page.getByRole("button", { name: "Break", exact: true }).click();
  await page
    .locator('[data-slot="card"]')
    .first()
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop Session", exact: true }).click();
  await chooseView("Week");
  await expect(page.locator('[data-collection-display="week"]')).toContainText(
    "1 entry",
  );
  await chooseView("Month");
  await expect(page.locator('[data-collection-display="month"]')).toContainText(
    "1 entry",
  );
  await chooseView("List");
  await page.screenshot({ path: "/tmp/jocki-time.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page
      .locator('[data-slot="card"]')
      .first()
      .getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/jocki-time-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "Track session fields, start/stop, calendar editing, Time presets and pause, and mobile layout passed.",
  );
} finally {
  await browser.close();
}
