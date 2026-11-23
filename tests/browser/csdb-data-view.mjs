import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import {
  createWorkspace,
  skipVaultSetup,
  writeVaultFiles,
  openSavedWorkspace,
} from "./vault-ui-helpers.mjs";
const db = CSDBDatabase.create("data_view");
db.createSchema("public");
db.createTable({
  schema: "public",
  name: "entries",
  columns: {
    id: "text",
    title: "text",
    parent_id: "text",
    body: "text",
    sort: "text",
    date: "date",
    status: { type: "enum", options: ["open", "done"] },
  },
  required: ["id"],
  primary_key: { columns: ["id"] },
  visibility: { id: "hidden", parent_id: "hidden", sort: "hidden" },
  foreign_keys: [
    {
      name: "parent",
      columns: ["parent_id"],
      references: { table: "public.entries", columns: ["id"] },
      label_field: "title",
      relationship: "parent",
    },
  ],
  comments: {
    "jocki.fields": {
      body: { label: "Notes", control: "textarea" },
      parent_id: { label: "Parent" },
      sort: { label: "Sorting", control: "sorting" },
    },
  },
});
db.table("public.entries").insert([
  { id: "root", title: "Root", status: "open" },
  { id: "child", title: "Child", parent_id: "root", status: "open" },
  { id: "leaf", title: "Leaf", parent_id: "child", status: "done" },
]);
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  await createWorkspace(page, "Data parity");
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Data");
  await button("Create").click();
  await skipVaultSetup(page);
  await writeVaultFiles(page, "Data", [
    { name: "Data.csdb", buffer: Buffer.from(db.toString()) },
  ]);
  await button("Data.csdb").click();
  const collection = page.locator('[data-record-collection="public.entries"]');
  await expect(collection).toBeVisible();
  await expect(
    collection.getByRole("columnheader", { name: "Notes", exact: true }),
  ).toBeVisible();
  await expect(
    collection.getByRole("columnheader", { name: "Parent", exact: true }),
  ).toHaveCount(0);
  await expect(collection.locator("[data-record-id]")).toHaveCount(3);
  await button("Group").click();
  await button("Add group").click();
  await page.getByLabel("Group field 1", { exact: true }).click();
  await page.getByRole("option", { name: "Notes", exact: true }).click();
  await page.getByLabel("Group label 1", { exact: true }).click();
  const materialize = page.getByRole("menuitemcheckbox", {
    name: "Materialize Parent group 1",
    exact: true,
  });
  await expect(materialize).toBeVisible();
  await materialize.click();
  await page.getByLabel("Group mode 1", { exact: true }).click();
  await page.getByRole("option", { name: "Recursive", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-record-id="root"][data-materialized-group]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-record-id="child"][data-materialized-group]'),
  ).toBeVisible();
  await expect(page.locator('[data-record-id="leaf"]')).toHaveAttribute(
    "data-record-depth",
    "2",
  );
  await button("Save").click();
  await expect(button("Save: Saved on this device")).toBeVisible();
  await page.reload();
  await openSavedWorkspace(page, "Data parity");
  await button("Data.csdb").click();
  await expect(page.locator('[data-record-id="leaf"]')).toHaveAttribute(
    "data-record-depth",
    "2",
  );
  await button("View").click();
  for (const mode of [
    "Short table",
    "Long table",
    "Board",
    "List",
    "Week",
    "Month",
    "Short table folder",
    "Long table folder",
    "Board folder",
  ])
    await expect(
      page.getByRole("menuitemradio", { name: mode, exact: true }),
    ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await button("Group").click();
  await page.getByLabel("Group label 1", { exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", {
      name: "Materialize Parent group 1",
      exact: true,
    }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "Verified CSDB data-view labels, visibility, Materialize, recursive hierarchy, saved preferences, layout modes and mobile controls.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-data-parity-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
