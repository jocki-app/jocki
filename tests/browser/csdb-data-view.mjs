import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import {
  createWorkspace,
  skipVaultSetup,
  writeVaultFiles,
  openSavedWorkspace,
  internalVaultDirectory,
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
  const row = (id) => collection.locator(`[data-record-id="${id}"]`);
  const title = (id) =>
    row(id).getByRole("textbox", { name: "Title", exact: true });
  const save = (id) => row(id).locator("[data-save-state]");
  const rootName = await internalVaultDirectory(page, "Data");
  const disk = async () => {
    const value = await page.evaluate(async (rootName) => {
      const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki");
      try {
        return await (
          await (
            await (
              await app.getDirectoryHandle(rootName)
            ).getFileHandle("Data.csdb")
          ).getFile()
        ).text();
      } catch (error) {
        if (error.name === "NotReadableError") return null;
        throw error;
      }
    }, rootName);
    return value === null
      ? null
      : CSDBDatabase.parse(value)
          .table("public.entries")
          .all()
          .map((row) => row.title);
  };
  // Tables has no task content type: it must still expose the original row actions.
  await expect(save("root")).toHaveAttribute("data-save-state", "saved");
  await expect(save("root").locator(".lucide-hard-drive")).toBeVisible();
  await expect(
    row("root").getByRole("button", { name: "Delete Root", exact: true }),
  ).toBeVisible();
  await save("root").click();
  await expect(
    page.getByRole("dialog", { name: "File storage", exact: true }),
  ).toContainText("Saved on this device");
  await page.keyboard.press("Escape");
  await title("root").fill("Root edited");
  await title("child").fill("Child private");
  await expect(save("root")).toHaveAttribute("data-save-state", "dirty");
  await expect(save("root").locator(".lucide-save")).toBeVisible();
  await expect(
    row("root")
      .getByRole("button", {
        name: "Discard edits for Root edited",
        exact: true,
      })
      .locator(".lucide-x"),
  ).toBeVisible();
  await save("root").click();
  await expect(save("root")).toHaveAttribute("data-save-state", "saved");
  await expect(save("child")).toHaveAttribute("data-save-state", "dirty");
  await expect.poll(disk).toEqual(["Root edited", "Child", "Leaf"]);
  await row("child")
    .getByRole("button", {
      name: "Discard edits for Child private",
      exact: true,
    })
    .click();
  await expect(title("child")).toHaveValue("Child");
  await expect(save("child")).toHaveAttribute("data-save-state", "saved");
  await title("root").fill("Root selected");
  await title("child").fill("Child selected");
  await title("leaf").fill("Leaf private");
  await row("root").getByRole("checkbox").click();
  await row("child").getByRole("checkbox").click();
  await collection
    .getByRole("button", { name: "Save selected rows", exact: true })
    .click();
  await expect.poll(disk).toEqual(["Root selected", "Child selected", "Leaf"]);
  await expect(save("leaf")).toHaveAttribute("data-save-state", "dirty");
  await row("leaf")
    .getByRole("button", {
      name: "Discard edits for Leaf private",
      exact: true,
    })
    .click();
  await row("root").getByRole("checkbox").click();
  await row("child").getByRole("checkbox").click();
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
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(save("root")).toHaveAttribute("data-save-state", "saved");
  await title("root").fill("Root private during delete");
  await row("leaf")
    .getByRole("button", { name: "Delete Leaf", exact: true })
    .click();
  await expect(row("leaf")).toHaveCount(0);
  await expect.poll(disk).toEqual(["Root selected", "Child selected"]);
  await expect(save("root")).toHaveAttribute("data-save-state", "dirty");
  await row("root")
    .getByRole("button", {
      name: "Discard edits for Root private during delete",
      exact: true,
    })
    .click();
  await expect(title("root")).toHaveValue("Root selected");
  assert.deepEqual(errors, []);
  console.log(
    "Verified CSDB row save/status/discard icons, selected saves, durable row isolation and deletion, labels, visibility, Materialize, recursive hierarchy, saved preferences, layout modes and mobile controls.",
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
