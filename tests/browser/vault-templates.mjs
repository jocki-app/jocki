import { createWorkspace } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createVaultFile } from "./vault-ui-helpers.mjs";
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5175");
  await createWorkspace(page);
  await page
    .getByRole("button", { name: "Create browser vault", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Templates");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: "Templates", exact: true }),
    })
    .getByRole("button", { name: "Enable history", exact: true })
    .click();
  await page.getByRole("dialog", { name: "History", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await createVaultFile(page, "Templates", "Source.md");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill("# Source\n\nold\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", { name: "Actions for Source.md", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Use as template", exact: true })
    .click();
  const fromTemplate = async (mode, name) => {
    await page
      .getByRole("button", { name: "Actions for Templates", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Template", exact: true }).hover();
    await page.getByRole("menuitem", { name: mode, exact: true }).hover();
    await page
      .getByRole("menuitem", { name: "Source.md", exact: true })
      .click();
    const filename = page.getByRole("textbox", {
      name: "File name",
      exact: true,
    });
    await filename.fill(name);
    await filename.press("Enter");
  };
  await fromTemplate("Copy", "Copy.md");
  await expect(editor).toContainText("old");
  await fromTemplate("Link", "Linked.md");
  await page
    .getByRole("button", { name: "Close Linked.md", exact: true })
    .click();
  await page.getByRole("button", { name: "Source.md", exact: true }).click();
  await editor.fill("# Source\n\nnew\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const read = async (path) =>
    page.evaluate(async (path) => {
      const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki");
      for await (const [name, handle] of app.entries())
        if (name !== "workspace" && handle.kind === "directory")
          try {
            return await (
              await (await handle.getFileHandle(path)).getFile()
            ).text();
          } catch {}
    }, path);
  assert.match(await read("Copy.md"), /old/);
  assert.match(await read("Linked.md"), /old/);
  await page.getByRole("button", { name: "Linked.md", exact: true }).click();
  await expect(editor).toContainText("new");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  assert.match(await read("Linked.md"), /old/);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => read("Linked.md")).toMatch(/new/);
  await page
    .getByRole("button", { name: "Actions for Linked.md", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Remove history", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Remove history?", exact: true })
    .getByRole("button", { name: "Remove history", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "History", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Source.md", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "History", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Markdown", exact: true })
    .click();
  await page.getByLabel("Enable template Source.md", { exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Actions for Templates", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Template", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).hover();
  await expect(
    page.getByRole("menuitem", { name: "Source.md", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(
    "Verified designated templates, copy-once and linked files, on-open-only draft updates, per-plugin template management and single-file history removal.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-template-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
