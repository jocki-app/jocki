import { createInlineEntry, entryByName } from "./navigation-helpers.mjs";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const delayedInventory of [false, true]) {
    const context = await browser.newContext(),
      page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    if (delayedInventory)
      await page.route("**/plugins.json", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
    await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58597");
    await createWorkspace(page);
    await navigate(page, "Plugins");
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText("Tasks", { exact: true }) });
    await row
      .getByRole("button", {
        name: "Package details and permissions",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toContainText("jocki");
    await expect(page.getByRole("dialog")).toContainText("tasks.write");
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
    await navigate(page, "Tasks");
    await addColumnTemplates(page, "Tasks", ["Title"]);
    await createInlineEntry(page, { Title: "Downloaded task plugin" });
    await expect(entryByName(page, "Downloaded task plugin")).toBeVisible({
      timeout: 30000,
    });
    await page.reload();
    await expect(entryByName(page, "Downloaded task plugin")).toBeVisible({
      timeout: 30000,
    });
    await context.setOffline(true);
    await navigate(page, "Plugins");
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    await page
      .getByRole("button", { name: "Open plugins menu", exact: true })
      .click();
    await expect(
      page
        .getByRole("navigation", { name: "Workspace", exact: true })
        .getByRole("button", { name: "Tasks Disabled", exact: true }),
    ).toBeVisible();
    await navigate(page, "Plugins");
    await row.getByRole("button", { name: "Enable", exact: true }).click();
    await navigate(page, "Tasks");
    await expect(entryByName(page, "Downloaded task plugin")).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log(
    "Package info, immediate installation, delayed inventory, offline disable/re-enable and record preservation passed.",
  );
} finally {
  await browser.close();
}
