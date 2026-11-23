import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  internalVaultDirectory,
  createWorkspace,
  openSavedWorkspace,
  createVaultFile,
  skipVaultSetup,
} from "./vault-ui-helpers.mjs";
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const start = page.locator("[data-start-screen]");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  const closed = async () => {
    await expect(start).toBeVisible();
    await expect(editor).toHaveCount(0);
    await expect(button("Choose workspace")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await navigator.locks.query()).held.some(
            (lock) => lock.name === "jocki-device-writer",
          ),
        ),
      )
      .toBe(false);
    await expect(button("Continue current workspace")).toHaveCount(0);
  };
  const close = async () => {
    await button("Choose workspace").click();
    await page
      .getByRole("menuitem", { name: "Close workspace", exact: true })
      .click();
  };
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  await closed();
  assert.deepEqual(
    await page.evaluate(async () => {
      const storage = await (
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki")
      ).getDirectoryHandle("workspace");
      const names = [];
      for await (const name of storage.keys()) names.push(name);
      return names;
    }),
    [],
  );
  await createWorkspace(page, "Writing");
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Recovery");
  await button("Create").click();
  await skipVaultSetup(page);
  await createVaultFile(page, "Recovery", "notes.md");
  await editor.fill("Saved note");
  await button("Save").click();
  await button("Enable history").click();
  await expect(
    page.getByRole("dialog", { name: "History", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "History", exact: true }),
  ).toHaveCount(0);
  await close();
  await closed();
  assert.deepEqual(
    await page.evaluate(async () => {
      const storage = await (
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki")
      ).getDirectoryHandle("workspace");
      return Object.keys(
        JSON.parse(
          await (
            await (await storage.getFileHandle("workspaces.json")).getFile()
          ).text(),
        ),
      );
    }),
    ["entries"],
  );
  const rootName = await internalVaultDirectory(page, "Recovery");
  const saved = await page.evaluate(async (name) => {
    const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki"),
      root = await app.getDirectoryHandle(name);
    const { Companions } = await import("/packages/core/vaults/companions.ts");
    const { BrowserVaultFiles } =
      await import("/packages/platform-browser/vault-files.ts");
    const companions = new Companions(new BrowserVaultFiles(root));
    const source = new TextDecoder().decode(
      await companions.read("notes.md", "descriptor.json"),
    );
    await companions.write(
      "notes.md",
      "descriptor.json",
      new TextEncoder().encode("{ invalid JSON"),
    );
    return { name, source };
  }, rootName);
  await page.reload();
  await closed();
  // A broken saved vault is never touched on launch.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await openSavedWorkspace(page, "Writing");
  await closed();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "JSON" }).first(),
  ).toContainText("JSON");
  await openSavedWorkspace(page, "Writing");
  await closed();
  await page.screenshot({
    path: "/tmp/jocki-start-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await start.evaluate((node) => node.scrollWidth <= innerWidth));
  await page.screenshot({
    path: "/tmp/jocki-start-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async ({ name, source }) => {
    const root = await (
      await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki")
    ).getDirectoryHandle(name);
    const { Companions } = await import("/packages/core/vaults/companions.ts");
    const { BrowserVaultFiles } =
      await import("/packages/platform-browser/vault-files.ts");
    await new Companions(new BrowserVaultFiles(root)).write(
      "notes.md",
      "descriptor.json",
      new TextEncoder().encode(source),
    );
  }, saved);
  await openSavedWorkspace(page, "Writing");
  await button("notes.md").click();
  await expect(editor).toHaveText("Saved note");
  await editor.fill("Discard this draft");
  await close();
  const dialog = page.getByRole("dialog", {
    name: "Save changes before closing the workspace?",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(start).toHaveCount(0);
  await expect(editor).toHaveText("Discard this draft");
  await close();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await closed();
  await openSavedWorkspace(page, "Writing");
  await button("notes.md").click();
  await expect(editor).toHaveText("Saved note");
  await editor.fill("Saved on exit");
  await close();
  await dialog.getByRole("button", { name: "Save all", exact: true }).click();
  await closed();
  await openSavedWorkspace(page, "Writing");
  await button("notes.md").click();
  await expect(editor).toHaveText("Saved on exit");
  await page.evaluate(() => {
    window.showDirectoryPicker = async () => {
      throw Error("Selected folder unavailable");
    };
  });
  await button("Settings").click();
  await button("Workspace").click();
  await button("Open folder").click();
  await closed();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Selected folder unavailable" })
      .first(),
  ).toContainText("Selected folder unavailable");
  await createWorkspace(page, "Research");
  await close();
  await closed();
  await button("Manage").click();
  await page
    .getByRole("combobox", { name: "Saved workspaces", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "Writing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Research", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await button("Back").click();
  await openSavedWorkspace(page, "Writing");
  await button("Choose workspace").click();
  await page
    .getByRole("menuitem", { name: "Writing", exact: true })
    .press("Escape");
  await button("notes.md").click();
  await editor.fill("Discard on switch");
  await button("Choose workspace").click();
  await page.getByRole("menuitem", { name: "Research", exact: true }).click();
  await page
    .getByRole("dialog", {
      name: "Save changes before switching workspaces?",
      exact: true,
    })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(button("Choose workspace")).toContainText("Research");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "Verified empty startup, explicit workspace selection, no persisted active workspace, released writer locks, failed-open cleanup, fresh reopening, Save/Discard/Cancel, saved-workspace dropdown and mobile layout.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-start-failure.png",
    fullPage: true,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
