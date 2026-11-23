import { createWorkspace, openSavedWorkspace } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  createVaultFile,
  internalVaultDirectory,
} from "./vault-ui-helpers.mjs";
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
  await page.getByLabel("Name", { exact: true }).fill("Metadata");
  await button("Create").click();
  const request = page.getByRole("dialog", {
    name: "Add a templates folder?",
    exact: true,
  });
  await expect(
    request.getByLabel("Named path key", { exact: true }),
  ).toHaveValue("templates");
  await request.getByRole("button", { name: "Add path", exact: true }).click();
  for (const title of ["Copy Note?", "Copy Task list?"])
    await page
      .getByRole("dialog", { name: title, exact: true })
      .getByRole("button", { name: "Copy template", exact: true })
      .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await createVaultFile(page, "Metadata", "notes.md");
  const choose = async (name) => {
    await button("View for notes.md").filter({ visible: true }).first().click();
    await page
      .getByRole("dialog", { name: "File views" })
      .getByRole("button", { name, exact: true })
      .click();
  };
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill("---\nproject: tide\n---\n# Notes\n\nPlanning\n");
  await button("Save").click();
  const rootName = await internalVaultDirectory(page, "Metadata");
  const readDisk = () =>
    page.evaluate(async (rootName) => {
      const app = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki"),
        root = await app.getDirectoryHandle(rootName);
      const paths = [],
        pending = [[root, ""]];
      while (pending.length) {
        const [dir, prefix] = pending.pop();
        for await (const [name, handle] of dir.entries()) {
          const path = prefix + name;
          if (handle.kind === "directory") pending.push([handle, path + "/"]);
          else paths.push(path);
        }
      }
      const { Companions } =
        await import("/packages/core/vaults/companions.ts");
      const { BrowserVaultFiles } =
        await import("/packages/platform-browser/vault-files.ts");
      const bytes = await new Companions(new BrowserVaultFiles(root)).read(
        "notes.md",
        "resource.json",
      );
      const resource = bytes
        ? JSON.parse(new TextDecoder().decode(bytes))
        : null;
      const { RecordFiles } =
        await import("/packages/core/vaults/record-container.ts");
      const fs = new BrowserVaultFiles(root);
      for (const path of [...paths])
        if (path.endsWith(".saddle")) {
          for (const record of await new RecordFiles(fs, path).list())
            paths.push(path + "::" + record);
        }
      return { paths, resource };
    }, rootName);
  const disk = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await readDisk();
      } catch (error) {
        if (attempt === 10) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  assert.equal(
    (await disk()).paths.filter((path) => path.endsWith(".automerge")).length,
    0,
  );
  assert.equal((await disk()).paths.includes(".notes.md.saddle"), false);
  await choose("Properties");
  const metadata = page.getByRole("textbox", {
    name: "Resource metadata",
    exact: true,
  });
  await metadata.fill(
    JSON.stringify(
      { name: "notes", path: "notes.md", metadata: { owner: "me" } },
      null,
      2,
    ),
  );
  await metadata.press("Tab");
  await button("Save").click();
  await expect
    .poll(async () => (await disk()).resource?.metadata.owner)
    .toBe("me");
  assert.equal(
    (await disk()).paths.filter((path) => path.endsWith(".automerge")).length,
    0,
  );
  await metadata.fill(
    JSON.stringify({
      name: "notes",
      path: "notes.md",
      metadata: { project: "conflict" },
    }),
  );
  await metadata.press("Tab");
  await button("Save").click();
  await expect(button("Metadata error for notes.md")).toBeVisible();
  await expect(button("Metadata error for notes.md")).toHaveAttribute(
    "title",
    /project/,
  );
  await metadata.fill(
    JSON.stringify({
      name: "notes",
      path: "notes.md",
      metadata: { owner: "me" },
    }),
  );
  await metadata.press("Tab");
  await button("Save").click();
  await expect(button("Metadata error for notes.md")).toHaveCount(0);
  await button("Browse Search").click();
  await page
    .getByRole("textbox", { name: "Search all vaults", exact: true })
    .fill("metadata:owner");
  await expect(page.locator("[data-search-result]")).toHaveCount(1);
  await expect(page.locator("[data-search-result]")).toContainText("notes.md");
  await button("Browse Graph").click();
  await expect(
    page.getByText("Folder hierarchy", { exact: true }),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Metadata", exact: true }).click();
  await expect(
    page.locator(".react-flow__node").filter({ hasText: "owner" }).first(),
  ).toBeVisible();
  await button("Browse Files").click();
  await choose("Markdown");
  await expect(page.locator("[data-file-breadcrumb]")).toContainText(
    "Metadata",
  );
  await expect(page.locator("[data-file-breadcrumb]")).toContainText(
    "notes.md",
  );
  assert.equal(
    await page
      .locator('[data-dock-tab] [role="tab"]')
      .last()
      .evaluate((node) => getComputedStyle(node).boxShadow),
    "none",
  );
  await expect(page.getByLabel("Attach files", { exact: true })).toHaveCount(0);
  await page
    .locator('[data-explorer-path="notes.md"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Import files", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", {
      name: "History and sharing settings",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Enable history", exact: true })
    .click();
  const history = page.getByRole("dialog", { name: "History", exact: true });
  await expect(history).toBeVisible();
  await expect
    .poll(
      async () =>
        (await disk()).paths.filter((path) => path.endsWith(".automerge"))
          .length,
    )
    .toBe(1);
  await page.keyboard.press("Escape");
  await page
    .locator('[data-explorer-path="notes.md"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "History", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("menuitem", { name: "Enable history", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "History", exact: true }).click();
  await history
    .getByRole("button", { name: "Disable history", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Disable history?", exact: true })
    .getByRole("button", { name: "Disable history", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await disk()).paths.filter((path) => path.endsWith(".automerge"))
          .length,
    )
    .toBe(0);
  const before = await page.locator(".vault-main").boundingBox();
  await button("Settings").click();
  const after = await page.locator(".vault-main").boundingBox(),
    right = await page.locator("[data-settings-pane]").boundingBox();
  assert.ok(after.width < before.width && after.x + after.width <= right.x + 1);
  await button("Word count").click();
  const plugin = page.locator('[data-settings-page="Word count"]');
  await expect(plugin).toContainText("Supported MIME types");
  await expect(plugin).not.toContainText("File glob");
  await expect(plugin).not.toContainText("Templates");
  await expect(plugin).toContainText("no additional settings");
  await page.screenshot({
    path: "/tmp/jocki-metadata-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await button("Settings").click();
  await button("Templates and named paths").click();
  const table = page.locator(
    '[data-settings-page="Templates and named paths"]',
  );
  await expect(table).toContainText("Metadata");
  await expect(table).toContainText("Note");
  await expect(table).toContainText("Task list");
  await page.reload();
  await openSavedWorkspace(page);
  await expect(
    page.locator('[data-settings-page="Templates and named paths"]'),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "Verified optional sidecar metadata, conflict indicators, metadata search/graph, scoped document creation/removal, file templates/named paths, clean plugin settings, direct toolbars and in-layout settings pane.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-metadata-failure.png",
    fullPage: true,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
