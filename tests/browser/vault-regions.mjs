import { createWorkspace, openSavedWorkspace } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import {
  createVaultFile,
  skipVaultSetup,
  writeVaultFiles,
} from "./vault-ui-helpers.mjs";
const db = CSDBDatabase.create("tasks");
db.createSchema("public");
db.createTable({
  schema: "public",
  name: "tasks",
  columns: {
    id: "text",
    uid: "text",
    dtstamp: "timestamp",
    title: "text",
    status: { type: "enum", options: ["open", "done"] },
  },
  required: ["id", "uid", "dtstamp"],
  primary_key: { columns: ["id"] },
});
db.table("public.tasks").insert([
  {
    id: "a",
    uid: "ua",
    dtstamp: "2026-01-01T00:00:00Z",
    title: "First",
    status: "open",
  },
  {
    id: "b",
    uid: "ub",
    dtstamp: "2026-01-01T00:00:00Z",
    title: "Second",
    status: "open",
  },
]);
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  await createWorkspace(page);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Regions");
  await button("Create").click();
  await skipVaultSetup(page);
  await button("Actions for Regions").click();
  await page.getByRole("menuitem", { name: "New folder", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Folder name", exact: true })
    .fill("Projects");
  await page
    .getByRole("textbox", { name: "Folder name", exact: true })
    .press("Enter");
  await writeVaultFiles(
    page,
    "Regions",
    [{ name: "Tasks.csdb", buffer: Buffer.from(db.toString()) }],
    "Projects",
  );
  await button("Tasks.csdb").click();
  const fileTabs = () =>
    page
      .locator("[data-dock-tab]")
      .filter({ has: page.getByRole("tab", { name: /^Tasks\.csdb/ }) });
  const chooseView = async (name) => {
    await button("View for Tasks.csdb")
      .filter({ visible: true })
      .first()
      .click();
    if (name === "SQL")
      await page.screenshot({
        path: "/tmp/jocki-regions-picker.png",
        animations: "disabled",
      });
    await page
      .getByRole("dialog", { name: "File views" })
      .getByRole("button", { name, exact: true })
      .click();
  };
  await chooseView("Properties");
  await page.getByLabel("Content type", { exact: true }).click();
  await page.getByRole("option", { name: "Task list", exact: true }).click();
  await button("Save").click();
  await chooseView("Tasks");
  await expect(page.locator('[data-status-item="tasks.count"]')).toHaveText(
    "2 tasks",
  );
  await expect(page.locator("[data-vault-statusbar]")).toHaveCount(1);
  await expect(page.locator("[data-vault-topbar] button")).toHaveCount(2);
  await expect(
    page
      .locator("[data-document-toolbar]")
      .getByRole("button", { name: "Filter", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-file-breadcrumb]")).toContainText(
    "Projects",
  );
  await expect(page.locator("[data-file-breadcrumb]")).toContainText(
    "Tasks.csdb",
  );
  await expect(
    page
      .getByLabel("File browser", { exact: true })
      .getByRole("button", { name: "Regions", exact: true }),
  ).toBeVisible();
  const workspaceFooter = () =>
    page.locator("[data-navigation-footer]").filter({ visible: true });
  await expect(workspaceFooter()).toHaveCount(1);
  await expect(
    workspaceFooter().getByRole("button", {
      name: "Choose workspace",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByLabel("File browser", { exact: true })
      .getByRole("button", { name: "Choose workspace", exact: true }),
  ).toHaveCount(0);
  const before = await fileTabs().count();
  await chooseView("SQL");
  await expect(page.getByLabel("SQL statement", { exact: true })).toBeVisible();
  await expect(fileTabs()).toHaveCount(before);
  const openWith = async (view, plugin = "Core") => {
    await page
      .locator('[data-explorer-path="Projects/Tasks.csdb"]')
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Open with", exact: true })
      .hover();
    await page.getByRole("menuitem", { name: plugin, exact: true }).hover();
    await page.getByRole("menuitem", { name: view, exact: true }).click();
  };
  await openWith("Properties");
  await expect(fileTabs()).toHaveCount(before + 1);
  await openWith("Properties");
  await expect(fileTabs()).toHaveCount(before + 1);
  await button("Tasks.csdb").click();
  await expect(page.getByLabel("SQL statement", { exact: true })).toBeVisible();
  await chooseView("Tasks");
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .first()
    .fill("First independently edited");
  await page
    .getByRole("tab", { name: /^Tasks\.csdb/ })
    .nth(1)
    .click();
  const resource = page.getByRole("textbox", {
    name: "Resource metadata",
    exact: true,
  });
  const descriptor = JSON.parse(await resource.inputValue());
  descriptor.metadata = { owner: "Independent metadata view" };
  await resource.fill(JSON.stringify(descriptor));
  await resource.press("Tab");
  await button("Save").click();
  await page
    .getByRole("tab", { name: /^Tasks\.csdb/ })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }).first(),
  ).toHaveValue("First independently edited");
  await button("Save").click();
  await expect(
    page
      .getByRole("button", { name: "Save: Saved on this device", exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  await page.reload();
  await openSavedWorkspace(page);
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }).first(),
  ).toHaveValue("First independently edited");
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }).nth(1),
  ).toHaveValue("Second");
  await page
    .getByRole("tab", { name: /^Tasks\.csdb/ })
    .nth(1)
    .click();
  await expect(
    page.getByRole("textbox", { name: "Resource metadata", exact: true }),
  ).toContainText("Independent metadata view");
  await page
    .getByRole("tab", { name: /^Tasks\.csdb/ })
    .first()
    .click();
  await expect(fileTabs()).toHaveCount(2);
  await expect(page.locator('[data-status-item="tasks.count"]')).toHaveText(
    "2 tasks",
  );
  await button("Browse Search").click();
  await expect(workspaceFooter()).toBeVisible();
  await expect(
    page.locator("[data-navigation-pane] input").first(),
  ).toBeVisible();
  await button("Browse Graph").click();
  await expect(workspaceFooter()).toBeVisible();
  await expect(
    page.locator("[data-navigation-pane] .react-flow"),
  ).toBeVisible();
  await button("Browse Files").click();
  await expect(button("Tasks.csdb")).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-regions-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await createVaultFile(page, "Regions", "Count.md");
  await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .fill("one two");
  await expect(
    page.locator('[data-status-item="word-count.status"]'),
  ).toHaveText("2 words · 7 characters");
  await button("Save").click();
  await button("Tasks.csdb").click();
  await expect(page.locator('[data-status-item="tasks.count"]')).toHaveText(
    "2 tasks",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-vault-statusbar]")).toBeVisible();
  await expect(
    page.locator('[data-status-item="tasks.count"]'),
  ).toBeInViewport();
  await button("Toggle navigation pane").click();
  await expect(button("Browse Files")).toBeVisible();
  await expect(workspaceFooter()).toHaveCount(1);
  await expect(workspaceFooter()).toBeInViewport();
  await expect(
    workspaceFooter().getByRole("button", {
      name: "Choose workspace",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-regions-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Verified registered view switching, nested Open with, file/view reuse, independent drafts and merged saves, restart, toolbar placement, unified status, navigation and mobile layout.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-regions-failure.png",
    fullPage: true,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
