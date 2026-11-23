import { createWorkspace, openSavedWorkspace } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { skipVaultSetup, writeVaultFiles } from "./vault-ui-helpers.mjs";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
const db = CSDBDatabase.create("tree_tasks");
db.createSchema("public");
db.createTable({
  schema: "public",
  name: "tasks",
  columns: {
    id: "text",
    uid: "text",
    dtstamp: "timestamp",
    title: "text",
    parent_id: "text",
    sort: "text",
    body: "text",
  },
  required: ["id", "uid", "dtstamp"],
  primary_key: { columns: ["id"] },
  visibility: {
    uid: "hidden",
    dtstamp: "hidden",
    parent_id: "hidden",
    sort: "hidden",
    body: "hidden",
  },
  foreign_keys: [
    {
      name: "parent",
      columns: ["parent_id"],
      references: { table: "public.tasks", columns: ["id"] },
      label_field: "title",
      relationship: "parent",
    },
  ],
  comments: {
    "jocki.fields": {
      parent_id: {
        label: "Parent",
      },
      sort: { label: "Sorting", control: "sorting" },
      body: { label: "Notes" },
    },
  },
});
db.table("public.tasks").insert(
  [
    { id: "leaf", title: "Grandchild", parent_id: "child", sort: "c" },
    { id: "other", title: "Separate root", parent_id: null, sort: "d" },
    { id: "child", title: "Child", parent_id: "root", sort: "b" },
    { id: "root", title: "Root", parent_id: null, sort: "a" },
  ].map((row) => ({
    ...row,
    uid: "uid-" + row.id,
    dtstamp: "2026-01-01T00:00:00Z",
    body: null,
  })),
);
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  await createWorkspace(page);
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Tree test");
  await button("Create").click();
  await skipVaultSetup(page);
  await writeVaultFiles(page, "Tree test", [
    { name: "Tasks.csdb", buffer: Buffer.from(db.toString()) },
    {
      name: "Strategy.md",
      buffer: Buffer.from(
        "Tidal planning brings the project together.\n\n#planning",
      ),
    },
  ]);
  // Select the initial editor explicitly; this fixture has no saved content type yet.
  await page
    .locator('[data-explorer-path="Tasks.csdb"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Core", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Properties", exact: true }).click();
  const choose = async (view) => {
    await button("View for Tasks.csdb")
      .filter({ visible: true })
      .first()
      .click();
    await page
      .getByRole("dialog", { name: "File views" })
      .getByRole("button", { name: view, exact: true })
      .click();
  };
  await page.getByLabel("Content type", { exact: true }).click();
  await page.getByRole("option", { name: "Task list", exact: true }).click();
  await button("Save").click();
  await choose("Tasks");
  const rows = page.locator("[data-record-id]");
  await expect(rows).toHaveCount(4);
  assert.deepEqual(
    await rows.evaluateAll((nodes) =>
      nodes.map((node) => [node.dataset.recordId, node.dataset.recordDepth]),
    ),
    [
      ["root", "0"],
      ["child", "1"],
      ["leaf", "2"],
      ["other", "0"],
    ],
  );
  const positions = await page
    .locator('[data-record-id] [data-field="title"] input')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().left),
    );
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  // Reproduce the saved Notes + materialized Parent + Recursive combination.
  await button("Group").click();
  await page.getByLabel("Group field 1", { exact: true }).click();
  await page.getByRole("option", { name: "Notes", exact: true }).click();
  await page.getByLabel("Group label 1", { exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", {
      name: "Materialize Parent group 1",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Group field 1", { exact: true })).toContainText(
    "Parent",
  );
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(4);
  await page.getByRole("button", { name: /^Collapse Parent: root$/ }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: /^Expand Parent: root$/ }).click();
  await expect(rows).toHaveCount(4);
  await page.screenshot({
    path: "/tmp/jocki-tree-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await openSavedWorkspace(page);
  await expect(rows).toHaveCount(4);
  await button("Browse Search").click();
  const pane = page.locator("[data-file-search]").filter({ visible: true });
  const search = pane.getByRole("textbox", {
    name: "Search all vaults",
    exact: true,
  });
  await expect(pane).toContainText("Search file names and contents");
  await expect(pane.locator("[data-search-result]")).toHaveCount(0);
  await search.fill("Tidal");
  await expect(pane.getByRole("status")).toHaveText("1 matching file");
  await expect(pane.locator("[data-search-result]")).toContainText(
    "Strategy.md",
  );
  await expect(pane.locator("[data-search-result]")).toContainText(
    "Tidal planning",
  );
  await search.press("ArrowDown");
  await expect(pane.locator("[data-search-result]")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toContainText("Tidal planning");
  await search.fill("path:Strategy metadata:planning");
  await expect(pane.locator("[data-search-result]")).toHaveCount(1);
  await search.fill("nothingmatches");
  await expect(pane).toContainText("No matching files");
  await pane.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toBeEmpty();
  await expect(search).toBeFocused();
  await search.fill("Tidal");
  await page.screenshot({
    path: "/tmp/jocki-search-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await button("Toggle navigation pane").click();
  await expect(pane).toBeVisible();
  await expect(pane.locator("[data-search-result]")).toBeInViewport();
  assert.equal(
    await pane.evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  await page.screenshot({
    path: "/tmp/jocki-search-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Verified native task ID ancestry, recursive label repair, sorted tree, indentation, collapse/restart, search keyboard opening, filters, empty/clear states and mobile layout.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-tree-search-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
