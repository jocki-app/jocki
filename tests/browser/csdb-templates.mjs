import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import {
  createWorkspace,
  internalVaultDirectory,
  writeVaultFiles,
} from "./vault-ui-helpers.mjs";

const fixture = CSDBDatabase.create("template_fixture");
fixture.createSchema("public");
fixture.createTable({
  schema: "public",
  name: "entries",
  columns: { name: "text", quantity: "integer", date: "timestamp" },
  required: ["name", "quantity"],
  defaults: { date: "now()" },
  visibility: { date: "hidden" },
});
fixture.table("public.entries").insert([
  { name: "First", quantity: 3, date: null },
  { name: "Second", quantity: 3, date: null },
]);
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true });
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  await createWorkspace(page);
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Templates");
  await button("Create").click();
  const request = page.getByRole("dialog", {
    name: "Add a templates folder?",
    exact: true,
  });
  await request.getByRole("button", { name: "Add path", exact: true }).click();
  for (const title of ["Copy Note?", "Copy Task list?"]) {
    await page
      .getByRole("dialog", { name: title, exact: true })
      .getByRole("button", { name: "Skip", exact: true })
      .click();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A user-owned file is registered independently of the bundled template list.
  await writeVaultFiles(page, "Templates", [
    { name: "templates/Entries.csdb", buffer: Buffer.from(fixture.toString()) },
  ]);
  const folder = page
    .locator('[data-explorer-path="templates"]')
    .getByRole("button", { name: "templates", exact: true });
  if ((await folder.getAttribute("aria-expanded")) === "false")
    await folder.click();
  await page
    .locator('[data-explorer-path="templates/Entries.csdb"]')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Use as template", exact: true })
    .click();
  const rootName = await internalVaultDirectory(page, "Templates");
  const read = (path) =>
    page.evaluate(
      async ({ rootName, path }) => {
        const app = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki");
        let dir = await app.getDirectoryHandle(rootName);
        const parts = path.split("/");
        for (const folder of parts.slice(0, -1))
          dir = await dir.getDirectoryHandle(folder);
        return await (
          await (await dir.getFileHandle(parts.at(-1))).getFile()
        ).text();
      },
      { rootName, path },
    );
  for (const copy of [1, 2]) {
    await button("Actions for Templates").click();
    await page.getByRole("menuitem", { name: "New file", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Template", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Copy", exact: true }).hover();
    await page
      .getByRole("menuitem", { name: "Entries.csdb", exact: true })
      .click();
    const rename = page.getByRole("textbox", {
      name: "File name",
      exact: true,
    });
    await rename.fill(`Copy ${copy}.csdb`);
    await rename.press("Enter");
    const table = page
      .locator('[data-record-collection="public.entries"]')
      .filter({ visible: true });
    await expect(table).toBeVisible();
    await expect(table.locator('[data-field="date"]')).toHaveCount(0);
    await table
      .locator('[data-record-id="0"] [data-field="quantity"] input')
      .fill("4");
    await button("Save").click();
    await expect(button("Save: Saved on this device")).toBeVisible();
    const rows = CSDBDatabase.parse(await read(`Copy ${copy}.csdb`))
      .table("public.entries")
      .all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].quantity, 4);
    assert.equal(rows[1].quantity, 3);
    assert(rows.every((row) => Number.isFinite(Date.parse(row.date))));
    assert.deepEqual(Object.keys(rows[0]).sort(), ["date", "name", "quantity"]);
    // Unkeyed deletion preserves the remaining row and its original timestamp.
    await table.getByRole("button", { name: "Delete 0", exact: true }).click();
    await button("Save").click();
    await expect(button("Save: Saved on this device")).toBeVisible();
    assert.deepEqual(
      CSDBDatabase.parse(await read(`Copy ${copy}.csdb`))
        .table("public.entries")
        .all(),
      rows.slice(1),
    );
  }
  assert(
    CSDBDatabase.parse(await read("templates/Entries.csdb"))
      .table("public.entries")
      .all()
      .every((row) => row.date === null),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Verified only Note and Task list are offered by default; user-owned CSDB templates copy with fresh hidden dates and support unkeyed editing/deletion.",
  );
} catch (error) {
  if (page) {
    console.error(await page.locator("body").innerText());
    await page.screenshot({
      path: "/tmp/jocki-csdb-templates-error.png",
      fullPage: true,
    });
  }
  throw error;
} finally {
  await browser.close();
}
