import { createWorkspace, openSavedWorkspace } from "./vault-ui-helpers.mjs";
import { createVaultFile, documentAction } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => {
    errors.push(String(error));
    console.error(error);
  });
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5173");
  await createWorkspace(page);
  await page
    .getByRole("button", { name: "Create browser vault", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Writing");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("cell", { name: "Writing", exact: true }).waitFor();
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Writing", exact: true }) })
    .getByRole("button", { name: "Enable history", exact: true })
    .click();
  await page.getByRole("dialog", { name: "History", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("row")
      .filter({
        has: page.getByRole("button", { name: "Writing", exact: true }),
      })
      .getByRole("button", { name: "History", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create browser vault", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Work");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("cell", { name: "Work", exact: true }).waitFor();
  await createVaultFile(page, "Writing", "notes.md");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.waitFor();
  const readNote = () =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory(),
        app = await root.getDirectoryHandle("jocki");
      for await (const [name, handle] of app.entries()) {
        if (name === "workspace" || handle.kind !== "directory") continue;
        try {
          return await (
            await (await handle.getFileHandle("notes.md")).getFile()
          ).text();
        } catch {}
      }
    });
  await editor.fill(
    "# A note\n\nUnsaved text\n\n    | Name | Value |\n    | --- | --- |\n    | Milk | 2 |\n",
  );
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  assert.equal(await readNote(), "");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(readNote).toMatch(/Unsaved text/);
  await page.getByLabel("Table row 2 column 2", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(readNote).toMatch(/    \| Milk \| 3 \|/);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Private draft");
  await page
    .getByRole("button", { name: "Close notes.md", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Save changes before closing?" })
    .waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.doesNotMatch(await readNote(), /Private draft/);
  await page
    .getByRole("button", { name: "Close notes.md", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await page.reload();
  await openSavedWorkspace(page);
  await page.getByRole("button", { name: "notes.md", exact: true }).click();
  await editor.waitFor();
  assert.doesNotMatch(await readNote(), /Private draft/);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".monaco-diff-editor").waitFor();
  await page.locator(".vault-history-versions button").last().click();
  await page
    .getByRole("button", {
      name: "Restore selected version to draft",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  assert.match(await readNote(), /Milk/);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await documentAction(page, "Save copy as…");
  const copy = page.getByRole("dialog", { name: "Save copy as", exact: true });
  await copy.getByLabel("Copy destination vault", { exact: true }).click();
  await page.getByRole("option", { name: "Work", exact: true }).click();
  await copy.getByLabel("Copy file path", { exact: true }).fill("copy.md");
  await copy.getByRole("button", { name: "Save copy", exact: true }).click();
  await page
    .getByRole("button", { name: "Close copy.md", exact: true })
    .waitFor();
  await page.evaluate(async () => {
    const app = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("jocki");
    for await (const [name, handle] of app.entries()) {
      if (name === "workspace" || handle.kind !== "directory") continue;
      try {
        await handle.removeEntry("notes.md");
      } catch {}
    }
  });
  await page.getByRole("button", { name: "Vaults", exact: true }).click();
  const writing = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "Writing", exact: true }) });
  await writing
    .getByRole("button", { name: "Rescan Writing", exact: true })
    .click();
  await writing
    .getByRole("button", {
      name: "Recover deleted files in Writing",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Deleted file recovery", exact: true })
    .getByRole("button", { name: "notes.md", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Recovered file path", { exact: true })
    .fill("recovered.md");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save recovered copy", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close recovered.md", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: "/tmp/jocki-vault-browser.png",
    fullPage: true,
  });
  console.log(
    "Verified multiple vaults, durable Save, indented tables, dirty close, restart, history previews, independent copies and deleted-file recovery.",
  );
  await context.close();
} finally {
  await browser.close();
}
