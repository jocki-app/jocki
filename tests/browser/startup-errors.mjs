import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createWorkspace } from "./vault-ui-helpers.mjs";

const browser = await chromium.launch({ headless: true });
const url = process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187";
let page;
try {
  page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const home = async () => {
    for (const name of ["Create", "Join", "Manage"])
      await expect(button(name)).toBeVisible();
    await expect(button("Try again")).toHaveCount(0);
    await expect(button("Choose workspace")).toHaveCount(0);
    assert.equal(
      await page.evaluate(
        async () => (await navigator.locks.query()).held.length,
      ),
      0,
    );
  };
  await page.goto(url);
  await home();
  const invalid = JSON.stringify({
    entries: [{ id: crypto.randomUUID(), name: "Preserved", root: "" }],
  });
  const catalog = async (source) =>
    page.evaluate(async (source) => {
      const storage = await (
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki")
      ).getDirectoryHandle("workspace");
      const file = await storage.getFileHandle("workspaces.json", {
        create: true,
      });
      if (source !== undefined) {
        const writer = await file.createWritable();
        await writer.write(source);
        await writer.close();
      }
      return (await file.getFile()).text();
    }, source);
  await catalog(invalid);
  await page.reload();
  await home();
  const failure = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Could not read the saved workspace list" });
  await expect(failure).toBeVisible();
  assert.equal(await catalog(), invalid);
  await failure.getByRole("button", { name: "View logs", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Local logs", exact: true });
  await expect(dialog).toContainText("invalid_value");
  await expect(dialog).toContainText('"kind"');

  // A complete Zod error must stay readable and clickable above a modal.
  await page.evaluate(async () => {
    const { z } = await import("/node_modules/zod/index.js");
    const result = z
      .object({
        entries: z.array(z.object({ kind: z.enum(["internal", "folder"]) })),
      })
      .safeParse({ entries: [{}] });
    window.dispatchEvent(new ErrorEvent("error", { error: result.error }));
  });
  const validation = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Validation failed: entries.0.kind:" });
  await expect(validation).toBeVisible();
  assert.equal(
    await validation.evaluate((node) => {
      const button = node.querySelector("[data-close-button]");
      const rect = button.getBoundingClientRect();
      return (
        !button.closest("[inert]") &&
        button.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        )
      );
    }),
    true,
  );
  await validation
    .getByRole("button", { name: "Close toast", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await button("Manage").click();
  await home();
  assert.equal(await catalog(), invalid);
  await button("Create").click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Blocked create");
  await button("Create workspace").click();
  await home();
  assert.equal(await catalog(), invalid);
  // Correcting the underlying failure allows normal navigation without a restart.
  await catalog(JSON.stringify({ entries: [] }));
  await button("Manage").click();
  await expect(
    page.getByRole("combobox", { name: "Saved workspaces", exact: true }),
  ).toBeVisible();
  await button("Back").click();
  await createWorkspace(page, "Recovered");
  await expect(button("Choose workspace")).toContainText("Recovered");
  await page.close();

  // If OPFS itself fails, keep home and in-memory diagnostics available.
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = navigator.storage.getDirectory.bind(navigator.storage);
    navigator.storage.getDirectory = async () => {
      throw Error("Device storage temporarily unavailable");
    };
    window.restoreStorage = () => {
      navigator.storage.getDirectory = original;
    };
  });
  await page.goto(url);
  await home();
  const storageError = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Device storage temporarily unavailable" });
  await expect(storageError).toBeVisible();
  await storageError
    .getByRole("button", { name: "View logs", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Local logs", exact: true }),
  ).toContainText("Device storage temporarily unavailable");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.evaluate(() => window.restoreStorage());
  await button("Manage").click();
  await expect(
    page.getByRole("combobox", { name: "Saved workspaces", exact: true }),
  ).toBeVisible();
  await button("Back").click();
  await home();
  assert.equal(
    await page.evaluate(async () => {
      const storage = await (
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki")
      ).getDirectoryHandle("workspace");
      const logs = await storage.getDirectoryHandle("logs");
      for await (const file of logs.values())
        if (
          (await (await file.getFile()).text()).includes(
            "Device storage temporarily unavailable",
          )
        )
          return true;
      return false;
    }),
    true,
  );
  await page.screenshot({
    path: "/tmp/jocki-startup-recovery.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Verified startup failures return home, invalid catalogs remain unchanged, structured errors stay readable above dialogs, and storage recovery works without restarting.",
  );
} catch (error) {
  console.error(
    await page
      ?.locator("body")
      .innerText()
      .catch(() => "Page closed"),
  );
  await page
    ?.screenshot({
      path: "/tmp/jocki-startup-error-failure.png",
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
