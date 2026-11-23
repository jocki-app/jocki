import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import {
  createWorkspace,
  internalVaultDirectory,
} from "./vault-ui-helpers.mjs";
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  await createWorkspace(page);
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Workouts");
  await button("Create").click();
  await expect(
    page.getByRole("dialog", { name: "Add a templates folder?", exact: true }),
  ).toBeVisible();
  await button("Add path").click();
  for (let i = 0; i < 4; i++) {
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(/^Copy /);
    const title = await dialog.getByRole("heading").textContent();
    await dialog
      .getByRole("button", {
        name: title.includes("Full body") ? "Copy template" : "Skip",
        exact: true,
      })
      .click();
    await expect(dialog.getByRole("heading")).not.toHaveText(title);
  }
  const rootName = await internalVaultDirectory(page, "Workouts");
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
        return (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
      },
      { rootName, path },
    );
  for (const day of [1, 2]) {
    const template = CSDBDatabase.parse(
      await read(`templates/Day ${day} - Full body.csdb`),
    );
    assert(
      template
        .table("public.exercises")
        .all()
        .every((row) => row.date === null),
    );
    await button("Actions for Workouts").click();
    await page.getByRole("menuitem", { name: "New file", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Template", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Copy", exact: true }).hover();
    await page
      .getByRole("menuitem", { name: `Day ${day} - Full body`, exact: true })
      .click();
    const rename = page.getByRole("textbox", {
      name: "File name",
      exact: true,
    });
    await rename.fill(`Workout ${day}.csdb`);
    await rename.press("Enter");
    const table = page
      .locator('[data-record-collection="public.exercises"]')
      .filter({ visible: true });
    await expect(table).toBeVisible();
    await expect(table.locator('[data-field="date"]')).toHaveCount(0);
    await table
      .locator('[data-record-id="0"] [data-field="sets"] input')
      .fill("4");
    await button("Save").click();
    await expect(
      button("Save: Saved on this device").filter({ visible: true }),
    ).toBeVisible();
    const rows = CSDBDatabase.parse(await read(`Workout ${day}.csdb`))
      .table("public.exercises")
      .all();
    assert.equal(rows.length, 6);
    assert.equal(rows[0].sets, 4);
    assert(rows.slice(1).every((row) => row.sets === 3));
    assert(rows.every((row) => Number.isFinite(Date.parse(row.date))));
    // Unkeyed row deletion preserves the other five rows and their dates.
    await table.getByRole("button", { name: "Delete 0", exact: true }).click();
    await button("Save").click();
    await expect(
      button("Save: Saved on this device").filter({ visible: true }),
    ).toBeVisible();
    const after = CSDBDatabase.parse(await read(`Workout ${day}.csdb`))
      .table("public.exercises")
      .all();
    assert.deepEqual(after, rows.slice(1));
  }
  assert.deepEqual(errors, []);
  console.log(
    "Both bundled workout templates install, copy with fresh hidden dates, and edit/delete without extra ID columns.",
  );
} catch (error) {
  if (page)
    await page.screenshot({
      path: "/tmp/jocki-workout-templates-error.png",
      fullPage: true,
    });
  throw error;
} finally {
  await browser.close();
}
