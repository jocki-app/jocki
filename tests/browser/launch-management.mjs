import { internalVaultDirectory } from "./vault-ui-helpers.mjs";
import { stringifyAutomergeUrl } from "@automerge/automerge-repo";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createWorkspace, openSavedWorkspace } from "./vault-ui-helpers.mjs";
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1320, height: 960 } });
  page.setDefaultTimeout(8000);
  browser.on("disconnected", () =>
    console.log("Browser disconnected", new Date().toISOString()),
  );
  page.on("close", () => console.log("Page closed", new Date().toISOString()));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("crash", () => console.error("Test page crashed"));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.addInitScript(() => {
    delete window.showDirectoryPicker;
  });
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const home = page.locator("[data-start-screen]");
  const close = async () => {
    await button("Choose workspace").click();
    await page
      .getByRole("menuitem", { name: "Close workspace", exact: true })
      .click();
    await expect(home).toBeVisible();
  };
  await button("Create").click();
  await expect(
    page.getByRole("group", { name: "Workspace storage", exact: true }),
  ).toHaveCount(0);
  await expect(button("Folder")).toHaveCount(0);
  await expect(button("None")).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Workspace name", { exact: true }).fill("Empty");
  await button("Create workspace").click();
  await close();
  console.log("Closed workspace");
  assert.equal(
    await page.evaluate(async () => {
      const root = await (
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki")
      ).getDirectoryHandle("workspace");
      const doc = JSON.parse(
        await (
          await (await root.getFileHandle("workspace.json")).getFile()
        ).text(),
      );
      return Object.keys(
        doc.computers[Object.keys(doc.computers)[0]].vaults ?? {},
      ).length;
    }),
    0,
  );
  // Real directory handles exercise durable folder workspace and vault capabilities.
  await page.evaluate(() => {
    FileSystemDirectoryHandle.prototype.queryPermission = async () => "granted";
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(
        window.pickVault ? "ExternalVault" : "Project",
        { create: true },
      );
    };
  });
  await button("Create").click();
  await page
    .getByRole("group", { name: "Workspace storage", exact: true })
    .getByRole("button", { name: "Folder", exact: true })
    .click();
  await button("Browse").click();
  await expect(
    page.getByLabel("Workspace JSON path", { exact: true }),
  ).toHaveValue("Project/workspace.json");
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveCount(
    0,
  );
  await button("Create workspace").click();
  await expect(button("Choose workspace")).toBeVisible({ timeout: 10000 });
  await close();
  console.log("Closed workspace");
  await button("Manage").click();
  const select = () =>
    page.getByRole("combobox", { name: "Saved workspaces", exact: true });
  await select().click();
  await expect(
    page.getByRole("option", { name: "Project/workspace.json", exact: true }),
  ).toBeVisible();
  await button("Unlink Project").click();
  await expect(
    page.getByRole("option", { name: "Project/workspace.json", exact: true }),
  ).toHaveCount(0);
  assert.equal(
    await page.evaluate(async () => {
      const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("Project");
      return JSON.parse(
        await (
          await (await root.getFileHandle("workspace.json")).getFile()
        ).text(),
      ).name;
    }),
    "Project",
  );
  await page.keyboard.press("Escape");
  await button("Open workspace file").click();
  await close();
  console.log("Closed workspace");
  await button("Create").click();
  await page.getByLabel("Workspace name", { exact: true }).fill("Disposable");
  await page
    .getByRole("group", { name: "Vault", exact: true })
    .getByRole("button", { name: "Internal", exact: true })
    .click();
  await page.getByLabel("Vault name", { exact: true }).fill("Keep files");
  await button("Create workspace").click();
  for (let i = 0; i < 3; i++) await button("Skip").click();
  await close();
  console.log("Closed workspace");
  const physical = await internalVaultDirectory(page, "Keep files");
  await page.evaluate(async (name) => {
    const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki"),
      folder = await root.getDirectoryHandle(name);
    const writer = await (
      await folder.getFileHandle("keep.txt", { create: true })
    ).createWritable();
    await writer.write("ordinary contents");
    await writer.close();
  }, physical);
  await button("Manage").click();
  await select().click();
  await button("Delete Disposable").click();
  const dialog = page.getByRole("dialog", {
    name: "Delete workspace settings?",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", {
      name: "Delete selected settings",
      exact: true,
    }),
  ).toBeDisabled();
  await dialog
    .getByRole("switch", {
      name: "Delete metadata for Keep files",
      exact: true,
    })
    .click();
  await dialog
    .getByLabel("Workspace name to confirm deletion", { exact: true })
    .fill("Disposable");
  await dialog
    .getByRole("button", { name: "Delete selected settings", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(
    await page.evaluate(async (name) => {
      const folder = await (
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki")
      ).getDirectoryHandle(name);
      const keys = [];
      for await (const key of folder.keys()) keys.push(key);
      return {
        keys,
        text: await (
          await (await folder.getFileHandle("keep.txt")).getFile()
        ).text(),
      };
    }, physical),
    { keys: ["keep.txt"], text: "ordinary contents" },
  );
  await select().click();
  await expect(button("Delete Disposable")).toHaveCount(0);
  await expect(button("Unlink Empty")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await button("Back").click();
  await button("Join").click();
  await page.getByLabel("Sync link", { exact: true }).fill("invalid sync link");
  await button("Inspect link").click();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Paste a Jocki sync link" }),
  ).toHaveCount(1);
  await expect(home.getByRole("alert")).toHaveCount(0);
  await page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Paste a Jocki sync link" })
    .getByRole("button", { name: "View logs", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("jocki.ui", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByLabel("Sync link", { exact: true }).fill(
    "saddle://share/" +
      Buffer.from(
        JSON.stringify({
          format: "saddle-share-invitation/1",
          kind: "file",
          name: "note.md",
          url: stringifyAutomergeUrl(new Uint8Array(16).fill(7)),
        }),
      ).toString("base64url"),
  );
  await expect(
    page.getByRole("group", { name: "Destination vault", exact: true }),
  ).toBeVisible();
  await button("Select vault").click();
  await expect(
    page.getByRole("combobox", {
      name: "Stored vault references",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-launch-join.png",
    fullPage: true,
  });
  await button("Back").click();
  await button("Create").click();
  await page.screenshot({
    path: "/tmp/jocki-launch-create.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await home.evaluate((node) => node.scrollWidth <= innerWidth));
  await page.screenshot({
    path: "/tmp/jocki-launch-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Verified capability-specific controls, internal/no-vault creation, external workspace JSON/reopen/unlink, selective deletion preserving ordinary files, central Sonner/log integration, join destinations and mobile layout.",
  );
} catch (error) {
  console.error(error);
  console.error(
    await page
      ?.locator("body")
      .innerText()
      .catch(() => "Page closed"),
  );
  await page
    ?.screenshot({ path: "/tmp/jocki-launch-failure.png", fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
