import { chromium, expect } from "@playwright/test";
import { createWorkspace, navigate } from "./navigation-helpers.mjs";
import { reviewInventory } from "./inventory-helpers.mjs";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await reviewInventory(context);
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58600");
  await createWorkspace(page, "Mobile and draft fields");
  const plugin = page
    .getByRole("row")
    .filter({ has: page.getByText("Track", { exact: true }) });
  await plugin.getByRole("button", { name: "Install", exact: true }).click();

  await plugin.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await navigate(page, "Track");
  await page
    .getByRole("navigation", { name: "Track page shortcuts" })
    .getByRole("button", { name: "Columns", exact: true })
    .click();
  await expect(page.getByLabel("Schema name", { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel("Field template storage", { exact: true }),
  ).toHaveCount(0);
  const draft = page.locator("[data-new-column]");
  await expect(
    page.locator("[data-columns-table] tbody tr").first(),
  ).toHaveAttribute("data-new-column", "true");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(draft.getByLabel("Column ID", { exact: true })).toHaveValue(
    "notes",
  );
  await expect(
    draft.getByLabel("Column storage", { exact: true }),
  ).toContainText("This plugin");
  await expect(
    draft.getByLabel("Column storage", { exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Remove Notes column", exact: true }),
  ).toHaveCount(0);
  await draft
    .getByRole("button", { name: "Clear new column", exact: true })
    .click();
  await expect(draft.getByLabel("Column ID", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await draft.getByLabel("Column ID", { exact: true }).fill("session_name");
  await draft.getByLabel("Label", { exact: true }).fill("Session name");
  await draft.getByRole("button", { name: "Add column", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove Session name column", exact: true })
    .waitFor();
  await expect(draft.getByLabel("Column ID", { exact: true })).toHaveValue("");
  const feature = page.getByLabel("Session name plugin feature", {
    exact: true,
  });
  await feature.click();
  await expect(
    page.getByRole("option", { name: "Notes", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "Unit", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "Activity", exact: true }).click();
  await page.screenshot({
    path: "/tmp/jocki-draft-templates.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Open settings menu", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose saved tab 1", exact: true })
    .click();
  await page.getByRole("option", { name: "Track", exact: true }).click();
  await page.keyboard.press("Escape");
  await page
    .locator('[data-slot="sheet-content"]')
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .locator('[data-slot="sheet-content"]')
    .waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  const navigation = page.getByRole("navigation", {
    name: "Mobile navigation",
    exact: true,
  });
  await expect(navigation.getByRole("button")).toHaveCount(3);
  for (const button of await navigation.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const icon = await button.locator("svg").boundingBox();
    expect(icon.width).toBeGreaterThanOrEqual(24);
  }
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );
  await page
    .locator('[data-columns-table] [data-slot="table-container"]')
    .evaluate((el) => {
      el.scrollLeft = 0;
    });
  await page.screenshot({
    path: "/tmp/jocki-mobile-navigation.png",
    fullPage: true,
  });
  console.log(
    "Draft templates, clear/edit/save, Storage, feature filtering, and larger mobile tray/saved icons passed.",
  );
} finally {
  await browser.close();
}
