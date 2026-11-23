import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ headless: true });
let page;
try {
  for (const kind of ["file", "folder", "vault", "workspace", "existing"]) {
    const context = await browser.newContext({
      viewport: { width: 1320, height: 960 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      delete window.showDirectoryPicker;
    });
    await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
    const fixture = await page.evaluate(
      async (kind) =>
        (
          await import(
            "/tests/browser/launcher-sync-fixture.ts?run=" + Date.now()
          )
        ).setup(kind === "existing" ? "file" : kind),
      kind,
    );
    if (kind === "existing") {
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page
        .getByLabel("Workspace name", { exact: true })
        .fill("Recipient workspace");
      await page
        .getByRole("group", { name: "Vault", exact: true })
        .getByRole("button", { name: "Internal", exact: true })
        .click();
      await page
        .getByLabel("Vault name", { exact: true })
        .fill("Existing vault");
      await page
        .getByRole("button", { name: "Create workspace", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Add a templates folder?", exact: true })
        .waitFor();
      for (let i = 0; i < 3; i++)
        await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page
        .getByRole("button", { name: "Choose workspace", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Close workspace", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await page.getByLabel("Sync link", { exact: true }).fill(fixture.link);
    if (kind === "vault") {
      await expect(
        page.getByRole("group", { name: "Vault: Internal", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Folder", exact: true }),
      ).toHaveCount(0);
    }
    await page
      .getByRole("button", { name: "Inspect link", exact: true })
      .click();
    if (kind === "existing") {
      await page
        .getByRole("button", { name: "Select vault", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Stored vault references", exact: true })
        .click();
      await page
        .getByRole("option", {
          name: "Existing vault · Recipient workspace",
          exact: true,
        })
        .click();
    }
    const join = page.getByRole("button", { name: "Join share", exact: true });
    await expect(join).toBeEnabled({ timeout: 30000 });
    await join.click();
    if (kind !== "existing") {
      await page
        .getByRole("dialog", { name: "Add a templates folder?", exact: true })
        .waitFor();
      for (let i = 0; i < 3; i++)
        await page.getByRole("button", { name: "Skip", exact: true }).click();
    }
    await expect(
      page.getByRole("button", { name: "Choose workspace", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    // Read canonical ordinary files rather than inspecting the transport cache.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const root = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle("jocki");
            const matches = [];
            for await (const [name, folder] of root.entries()) {
              if (name === "workspace" || folder.kind !== "directory") continue;
              async function visit(directory) {
                for await (const [name, entry] of directory.entries()) {
                  if (name === ".saddle") continue;
                  if (entry.kind === "directory") await visit(entry);
                  else if (name === "note.md")
                    matches.push(await (await entry.getFile()).text());
                }
              }
              await visit(folder);
            }
            return matches;
          }),
        { timeout: 30000 },
      )
      .toEqual(["# Shared through launcher"]);
    assert.deepEqual(errors, []);
    console.log(
      `Verified ${kind} sync-link inspection, destination form, authenticated join and ordinary-file materialization.`,
    );
    await page.evaluate(() => window.launcherSyncFixture.stop());
    await context.close();
  }
} catch (error) {
  console.error(error);
  console.error(
    await page
      ?.locator("body")
      .innerText()
      .catch(() => "Closed"),
  );
  await page
    ?.screenshot({
      path: "/tmp/jocki-launch-join-failure.png",
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
