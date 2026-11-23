import { reviewInventory } from "./inventory-helpers.mjs";
import { createInlineEntry, entryByName } from "./navigation-helpers.mjs";
import { createWorkspace } from "./navigation-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
});
await reviewInventory(context);
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const click = (name) => page.getByRole("button", { name, exact: true }).click();
const menu = async (side = "plugins") => {
  await page
    .getByRole("button", { name: `Open ${side} menu`, exact: true })
    .click();
};
const navigate = async (name, side = "plugins") => {
  await menu(side);
  await page
    .getByRole("navigation", {
      name: side === "plugins" ? "Workspace" : "Settings and tools",
      exact: true,
    })
    .getByRole("button", { name, exact: true })
    .click();
};
const choose = async (label, value, scope = page) => {
  await scope.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
};
const pageButtons = (plugin) =>
  page.getByRole("navigation", {
    name: `${plugin} page shortcuts`,
    exact: true,
  });
const columns = async () => {
  await pageButtons("Tasks")
    .getByRole("button", { name: "Columns", exact: true })
    .click();
  await expect(
    pageButtons("Tasks").getByRole("button", { name: "Columns", exact: true }),
  ).toHaveCount(0);
  await expect(
    pageButtons("Tasks").getByRole("button", { name: "Tasks", exact: true }),
  ).toBeVisible();
};
const newTask = async (title, extra) => {
  await createInlineEntry(page, {
    Title: title,
    ...(extra ? { Budget: extra } : {}),
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(entryByName(page, title)).toBeVisible();
};
try {
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:5173");
  await createWorkspace(page);
  await expect(
    page.locator(".page-header,.workspace-label,.eyebrow"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("My workspace");
  for (const name of ["Tasks", "Email Client", "Office Editor"]) {
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole("button", { name: "Install", exact: true }).click();

    await row.getByRole("button", { name: "Disable", exact: true }).waitFor();
  }
  await menu();
  const left = page.getByRole("navigation", { name: "Workspace", exact: true });
  await expect(
    left.getByRole("button", { name: "Devices", exact: true }),
  ).toHaveCount(0);
  await expect(
    left.getByRole("button", { name: "Files", exact: true }),
  ).toHaveCount(0);
  await left.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(
    pageButtons("Tasks").getByRole("button", { name: "Tasks", exact: true }),
  ).toHaveCount(0);
  const crumbs = await page
    .getByRole("navigation", { name: "Current page" })
    .boundingBox();
  const links = await pageButtons("Tasks").boundingBox();
  expect(links.x).toBeGreaterThanOrEqual(crumbs.x + crumbs.width);
  await columns();
  await pageButtons("Tasks")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await columns();
  await expect(
    page.getByRole("button", { name: "Remove Title column", exact: true }),
  ).toHaveCount(0);
  await click("Title");
  await click("Add column");
  await navigate("Tasks");
  await newTask("Personal searchable task");
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Schema", exact: true }).click();
  await click("New schema");
  await page.getByLabel("Schema name", { exact: true }).fill("Work tasks");
  await click("Create schema");
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  await columns();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Columns");
  await expect(
    page.getByRole("button", { name: "Remove UID column", exact: true }),
  ).toBeDisabled();
  for (const preset of ["Title", "Status", "Description"]) {
    await click(preset);
    await click("Add column");
    await page
      .getByRole("button", { name: `Remove ${preset} column`, exact: true })
      .waitFor();
    await expect(
      page.getByLabel(`${preset} plugin feature`, { exact: true }),
    ).toContainText("Not mapped");
    if (preset !== "Description")
      await choose(`${preset} plugin feature`, preset);
  }
  await click("Remove Description column");
  await click("Description");
  await click("Clear new column");
  const newColumn = page.locator("[data-new-column]");
  await newColumn.getByLabel("Column ID", { exact: true }).fill("budget");
  await newColumn.getByLabel("Label", { exact: true }).fill("Budget");
  await choose("Base type", "numeric", newColumn);
  await click("Add column");
  await expect(newColumn.getByLabel("Column ID", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await navigate("Tasks");
  await newTask("Work searchable task", "123.45");
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await choose("Schema", "Default");
  await expect(entryByName(page, "Personal searchable task")).toBeVisible();
  await choose("Schema", "Work tasks");
  await menu();
  await click("Search");
  await page
    .getByRole("combobox", { name: "Search content and commands" })
    .fill("Work searchable");
  await page.getByRole("option", { name: /Work searchable task/ }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await expect(
    page.getByRole("combobox", { name: "Schema", exact: true }),
  ).toContainText("Work tasks");
  const result = entryByName(page, "Work searchable task");
  await expect(result).toBeVisible();
  const editing = page.locator(
    `[data-record-id="${await result.getAttribute("data-record-id")}"]`,
  );
  await editing.getByLabel("Title", { exact: true }).fill("Work renamed");
  await editing
    .getByRole("button", { name: "Save entry", exact: true })
    .click();
  await expect(entryByName(page, "Work renamed")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add entry", exact: true }),
  ).toBeEnabled();
  await menu("settings");
  const right = page.getByRole("navigation", {
    name: "Settings and tools",
    exact: true,
  });
  for (const name of [
    "Files",
    "Tables",
    "Variables",
    "Credentials",
    "Devices",
    "Notifications",
    "Jobs",
    "Settings",
  ])
    await expect(
      right.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await click("Choose saved tab 1");
  await page.getByRole("option", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open saved Tasks", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open saved Tasks", exact: true }),
  ).toBeVisible();
  await navigate("Tables", "settings");
  const managed = entryByName(page, "Tasks").filter({ hasText: "budget" });
  await expect(managed).toContainText("Managed by tasks");
  await expect(
    managed.getByRole("button", { name: "Save entry", exact: true }),
  ).toHaveCount(0);
  await managed
    .getByRole("button", { name: "Open entry", exact: true })
    .click();
  await expect(
    page.getByText(
      "Managed by tasks. Open that plugin to edit its columns and entries.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save entry", exact: true }),
  ).toHaveCount(0);
  await navigate("Mail");
  await expect(
    pageButtons("Mail").getByRole("button", { name: "Accounts", exact: true }),
  ).toBeVisible();
  await expect(
    pageButtons("Mail").getByRole("button", {
      name: "Operations",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    pageButtons("Mail").getByRole("button", { name: "Mail", exact: true }),
  ).toHaveCount(0);
  await menu();
  await click("Mail pages");
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("button", { name: "Accounts", exact: true })
    .click();
  await expect(
    page.locator("[data-record-collection=mail_accounts]"),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Accounts");
  await expect(
    pageButtons("Mail").getByRole("button", { name: "Accounts", exact: true }),
  ).toHaveCount(0);
  await pageButtons("Mail")
    .getByRole("button", { name: "Operations", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Operations");
  await expect(
    pageButtons("Mail").getByRole("button", {
      name: "Operations",
      exact: true,
    }),
  ).toHaveCount(0);
  await pageButtons("Mail")
    .getByRole("button", { name: "Mail", exact: true })
    .click();
  await navigate("Settings", "settings");
  await pageButtons("Settings")
    .getByRole("button", { name: "Storage copies", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Storage copies");
  await pageButtons("Settings")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await choose("Color theme", "Dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("button", { name: "Toggle theme", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    timeout: 60000,
    animations: "disabled",
    path: join(tmpdir(), "jocki-navigation-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.getByRole("navigation", {
    name: "Mobile navigation",
    exact: true,
  });
  await expect(mobile).toBeVisible();
  await mobile
    .getByRole("button", { name: "Open saved Tasks", exact: true })
    .click();
  await expect(page.locator("[data-record-collection=tasks]")).toBeVisible();
  await columns();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Columns");
  await pageButtons("Tasks")
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await menu();
  await click("Search");
  await page
    .getByRole("combobox", { name: "Search content and commands" })
    .fill("Open Mail");
  await page.getByRole("option", { name: "Open Mail", exact: true }).click();
  await expect(page.locator("[data-record-collection=mail]")).toBeVisible();
  await page.screenshot({
    timeout: 60000,
    animations: "disabled",
    path: join(tmpdir(), "jocki-navigation-mobile.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "Two menus, breadcrumbs, plugin page buttons on desktop and mobile, shortcuts, theme, unified search, Mail pages, table isolation, custom columns and managed storage passed.",
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  await page.screenshot({
    path: join(tmpdir(), "jocki-navigation-failure.png"),
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
