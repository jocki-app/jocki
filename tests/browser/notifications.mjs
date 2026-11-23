import { chromium, expect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  createInlineEntry,
  entryByName,
} from "./navigation-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4178");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await page
    .getByLabel("Save as on this device", { exact: true })
    .fill("Local workspace");
  await page
    .getByLabel("Workspace invitation", { exact: true })
    .fill('{"format":"invalid"}');
  await page
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]'),
  ).toBeVisible();
  await expect(page.locator("main [role=alert]")).toHaveCount(0);
  await page
    .locator('[data-sonner-toast][data-type="error"] [data-close-button]')
    .click();
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await createWorkspace(page, "Toast checks");
  await expect(
    page
      .locator('[data-sonner-toast][data-type="success"]')
      .filter({ hasText: "Workspace created." }),
  ).toBeVisible();
  await navigate(page, "Tables");
  await createInlineEntry(page, { Name: "Toast table" });
  await expect(
    page
      .locator('[data-sonner-toast][data-type="success"]')
      .filter({ hasText: "Entry created." }),
  ).toBeVisible();
  await entryByName(page, "Toast table")
    .getByRole("button", { name: "Delete entry", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page
      .locator('[data-sonner-toast][data-type="success"]')
      .filter({ hasText: "Entry deleted." }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, "Settings");
  await context.setOffline(true);
  const warning = page.locator('[data-sonner-toast][data-type="warning"]');
  await expect(warning).toContainText("You are offline");
  await expect(warning).toHaveAttribute("data-mounted", "true");
  await expect
    .poll(async () => {
      const bounds = await warning.boundingBox();
      return bounds.y >= 0 && bounds.y + bounds.height <= 780;
    })
    .toBe(true);
  const box = await warning.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/jocki-toast-mobile.png" });
  await context.setOffline(false);
  await expect(
    page.locator('[data-sonner-toast][data-type="info"]'),
  ).toContainText("Connection restored");
  expect(errors).toEqual([]);
  console.log(
    "Global error/success toasts, dismissal, navigation, committed CRUD and mobile connection notices passed.",
  );
} finally {
  await browser.close();
}
