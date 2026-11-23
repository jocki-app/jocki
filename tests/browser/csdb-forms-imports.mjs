import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import {
  createWorkspace,
  skipVaultSetup,
  writeVaultFiles,
  internalVaultDirectory,
} from "./vault-ui-helpers.mjs";
function fixture(rows = []) {
  const db = CSDBDatabase.create("forms");
  db.createSchema("public");
  db.createTable({
    schema: "public",
    name: "tasks",
    columns: {
      id: "text",
      title: "text",
      status: { type: "enum", options: ["open", "done"] },
      tags: "text[]",
      parent_id: "text",
      notes: "text",
      extra: "text",
      payload: "json",
      date: "datetime",
    },
    required: ["id", "title"],
    primary_key: { columns: ["id"] },
    defaults: { status: "open", tags: ["default tag"], date: "now()" },
    formats: { date: "%d/%m/%Y %H:%M:%S%:z" },
    visibility: {
      id: "hidden",
      date: "hidden",
      status: "viewable",
      notes: "hidden",
      extra: "addable",
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
  });
  if (rows.length) db.table("public.tasks").insert(rows);
  return db.toString();
}
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("PAGE ERROR", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error("CONSOLE", message.text());
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  await createWorkspace(page);
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Forms");
  await button("Create").click();
  await skipVaultSetup(page);
  await writeVaultFiles(page, "Forms", [
    {
      name: "Destination.csdb",
      buffer: Buffer.from(fixture([{ id: "parent", title: "Parent label" }])),
    },
    {
      name: "Source.csdb",
      buffer: Buffer.from(
        fixture([
          { id: "a", title: "Imported A" },
          { id: "b", title: "Imported B" },
        ]),
      ),
    },
  ]);
  const context = async () =>
    page
      .locator('[data-explorer-path="Destination.csdb"]')
      .click({ button: "right" });
  await context();
  await page.getByRole("menuitem", { name: "Open with", exact: true }).hover();
  await page.getByRole("menuitem", { name: "CSDB", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Attribute form", exact: true })
    .click();
  const form = page.locator("[data-csdb-attribute-form]");
  await expect(form).toBeVisible();
  await expect(page.getByLabel("Form row", { exact: true })).toContainText(
    "New row",
  );
  await expect(form.getByLabel("ID", { exact: true })).toHaveCount(0);
  await expect(form.getByLabel("Notes", { exact: true })).toHaveCount(0);
  await expect(
    form.getByRole("combobox", { name: "Status", exact: true }),
  ).toBeDisabled();
  await expect(form.getByLabel("Date", { exact: true })).toHaveCount(0);
  const desktop = await form
    .locator("[data-form-fields]")
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  assert.equal(desktop.split(" ").length, 2, desktop);
  await form.getByLabel("Title", { exact: true }).fill("Created through form");
  await form.getByRole("combobox", { name: "Parent id", exact: true }).click();
  await page.getByRole("option", { name: "Parent label", exact: true }).click();
  // A tab switch keeps both valid values and incomplete typed input private.
  await button("Settings").click();
  await button("CSDB imports").click();
  await page.getByRole("tab", { name: /^Destination\.csdb/ }).click();
  await expect(form.getByLabel("Title", { exact: true })).toHaveValue(
    "Created through form",
  );
  await form.getByLabel("Payload", { exact: true }).fill('{"draft":');
  await button("Settings").click();
  await button("CSDB imports").click();
  await page.getByRole("tab", { name: /^Destination\.csdb/ }).click();
  await expect(form.getByLabel("Payload", { exact: true })).toHaveValue(
    '{"draft":',
  );
  await button("Save").click();
  await expect(page.locator("[data-sonner-toast]").last()).toContainText(
    "Finish entering",
  );
  await form.getByLabel("Payload", { exact: true }).fill('{"draft":true}');
  await button("Save").click();
  await expect(button("Save: Saved on this device")).toBeVisible();
  const rootName = await internalVaultDirectory(page, "Forms");
  const read = () =>
    page.evaluate(async (rootName) => {
      const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki");
      const root = await app.getDirectoryHandle(rootName);
      return (
        await (await root.getFileHandle("Destination.csdb")).getFile()
      ).text();
    }, rootName);
  let saved = CSDBDatabase.parse(await read());
  assert.deepEqual(saved.table("public.tasks").all()[1].payload, {
    draft: true,
  });
  assert.equal(saved.table("public.tasks").all().length, 2);
  assert(
    Number.isFinite(Date.parse(saved.table("public.tasks").all()[1].date)),
  );
  assert.match(await read(), /formats:/);
  assert.equal(saved.table("public.tasks").all()[1].parent_id, "parent");
  assert.deepEqual(saved.table("public.tasks").all()[1].tags, ["default tag"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(form).toBeVisible();
  const mobile = await form
    .locator("[data-form-fields]")
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  assert.equal(mobile.split(" ").length, 1, mobile);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Configure the default profile through the user-facing settings page.
  await button("Settings").click();
  await button("CSDB imports").click();
  await expect(page.locator("[data-csdb-settings]")).toBeVisible();
  await page.getByLabel("Import presentation", { exact: true }).click();
  await page
    .getByRole("option", { name: "Attribute form draft", exact: true })
    .click();
  await button("Save import profiles").click();
  // Import a workspace CSDB file via the standardized picker.
  await context();
  await page.getByRole("menuitem", { name: "Add data", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Choose file…", exact: true })
    .click();
  const picker = page.locator("[data-file-picker]");
  await expect(picker).toBeVisible();
  await picker
    .getByRole("option", { name: "Source.csdb", exact: true })
    .click();
  await picker.getByRole("button", { name: "Choose (1)", exact: true }).click();
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Title", { exact: true })).toHaveValue(
    "Imported A",
  );
  await form.getByLabel("Title", { exact: true }).fill("Imported A edited");
  await button("Next row").click();
  await expect(form.getByLabel("Title", { exact: true })).toHaveValue(
    "Imported B",
  );
  await button("Previous row").click();
  await expect(form.getByLabel("Title", { exact: true })).toHaveValue(
    "Imported A edited",
  );
  // A draft import has not touched disk until Save.
  assert.equal(
    CSDBDatabase.parse(await read())
      .table("public.tasks")
      .all().length,
    2,
  );
  await button("Save").click();
  await expect(button("Save: Saved on this device")).toBeVisible();
  saved = CSDBDatabase.parse(await read());
  assert.equal(saved.table("public.tasks").all().length, 4);
  assert.equal(
    saved.table("public.tasks").byPrimaryKey("a").title,
    "Imported A edited",
  );
  // Auto-save imports never open or focus a destination editor.
  await button("Settings").click();
  await button("CSDB imports").click();
  await page.getByLabel("Import presentation", { exact: true }).click();
  await page
    .getByRole("option", { name: "Save automatically", exact: true })
    .click();
  await button("Save import profiles").click();
  const tabCount = await page.locator("[data-dock-tab]").count();
  await context();
  await page.getByRole("menuitem", { name: "Add data", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Choose file…", exact: true })
    .click();
  await picker
    .getByLabel("Choose device files", { exact: true })
    .setInputFiles({
      name: "Extra.csdb",
      mimeType: "application/vnd.csdb",
      buffer: Buffer.from(fixture([{ id: "c", title: "Auto saved" }])),
    });
  await expect(picker).toHaveCount(0);
  assert.equal(await page.locator("[data-dock-tab]").count(), tabCount);
  assert.equal(
    CSDBDatabase.parse(await read())
      .table("public.tasks")
      .all().length,
    5,
  );

  // Templates use the same merge path, including per-profile submenus.
  await writeVaultFiles(page, "Forms", [
    {
      name: "Row template.csdb",
      buffer: Buffer.from(fixture([{ id: "tpl", title: "Template row" }])),
    },
  ]);
  await page
    .locator('[data-explorer-path="Row template.csdb"]')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Use as template", exact: true })
    .click();
  await context();
  await page.getByRole("menuitem", { name: "Add data", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Default", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Template", exact: true })
    .last()
    .hover();
  await page
    .getByRole("menuitem", { name: "Row template.csdb", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        CSDBDatabase.parse(await read())
          .table("public.tasks")
          .all().length,
    )
    .toBe(6);
  // A second profile appears as its own submenu and opens a table draft.
  await button("Settings").click();
  await button("CSDB imports").click();
  await button("Add profile").click();
  await page.getByLabel("Profile name", { exact: true }).fill("Table imports");
  await page.getByLabel("Import presentation", { exact: true }).click();
  await page
    .getByRole("option", { name: "Data table draft", exact: true })
    .click();
  await button("Save import profiles").click();
  await context();
  await page.getByRole("menuitem", { name: "Add data", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Table imports", exact: true })
    .hover();
  await page
    .locator(
      '[data-command^="core.csdb.choose."]:not([data-command="core.csdb.choose.default"])',
    )
    .click();
  await picker
    .getByLabel("Choose device files", { exact: true })
    .setInputFiles({
      name: "Table source.csdb",
      mimeType: "application/vnd.csdb",
      buffer: Buffer.from(
        fixture([{ id: "table", title: "Imported in table" }]),
      ),
    });
  await expect(
    page.locator('[data-record-collection="public.tasks"]'),
  ).toBeVisible();
  assert.equal(
    CSDBDatabase.parse(await read())
      .table("public.tasks")
      .all().length,
    6,
  );
  await button("Save").click();
  await expect(
    button("Save: Saved on this device").filter({ visible: true }),
  ).toBeVisible();
  assert.equal(
    CSDBDatabase.parse(await read())
      .table("public.tasks")
      .all().length,
    7,
  );
  assert.deepEqual(errors, []);
  console.log(
    "CSDB form, native dropdowns/defaults, responsive layout, import profiles, draft merges, row navigation and autosave passed",
  );
} catch (error) {
  if (page) {
    await page.screenshot({
      path: "/tmp/jocki-csdb-import-error.png",
      fullPage: true,
    });
    console.error(await page.locator("body").innerText());
  }
  throw error;
} finally {
  await browser.close();
}
