import { createVaultFile } from "./vault-ui-helpers.mjs";
import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const directory = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "jocki-launch-desktop-")),
);
const profile = path.join(directory, "profile"),
  vault = path.join(directory, "vault"),
  workspace = path.join(directory, "project.json");
await mkdir(vault);
await writeFile(path.join(vault, "keep.md"), "Keep this ordinary file");
const env = { ...process.env };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
delete env.JOCKI_NATIVE;
let app, page;
try {
  app = await electron.launch({
    args: [process.cwd(), "--user-data-dir=" + profile],
    env,
  });
  await app.evaluate(
    ({ dialog }, { vault, workspace }) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: workspace,
      });
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: [
          options.properties.includes("openFile") ? workspace : vault,
        ],
      });
    },
    { vault, workspace },
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(25000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  await page
    .getByRole("group", { name: "Workspace storage", exact: true })
    .getByRole("button", { name: "Folder", exact: true })
    .click();
  await button("Browse").click();
  await expect(
    page.getByLabel("Workspace JSON path", { exact: true }),
  ).toHaveValue(workspace);
  await page
    .getByRole("group", { name: "Vault", exact: true })
    .getByRole("button", { name: "Folder", exact: true })
    .click();
  await page
    .locator("label")
    .filter({ has: page.getByLabel("Vault folder path", { exact: true }) })
    .getByRole("button", { name: "Browse", exact: true })
    .click();
  await expect(
    page.getByLabel("Vault folder path", { exact: true }),
  ).toHaveValue(vault);
  await button("Create workspace").click();
  for (let i = 0; i < 3; i++) await button("Skip").click();
  await close();
  const doc = JSON.parse(await readFile(workspace, "utf8"));
  assert.equal(doc.format, "saddle-workspace/1");
  assert.equal(doc.name, "project");
  await assert.rejects(access(path.join(vault, ".saddle")));
  await button("Manage").click();
  const dropdown = () =>
    page.getByRole("combobox", { name: "Saved workspaces", exact: true });
  await dropdown().click();
  await button("Unlink project").click();
  await page.keyboard.press("Escape");
  await access(workspace);
  await button("Open workspace file").click();
  await expect(button("Choose workspace")).toBeVisible();
  await close();
  await button("Manage").click();
  await dropdown().click();
  await button("Delete project").click();
  const dialog = page.getByRole("dialog", {
    name: "Delete workspace settings?",
    exact: true,
  });
  await expect(
    dialog.getByRole("switch", { name: "Delete workspace JSON", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("switch", { name: "Delete metadata for vault", exact: true })
    .click();
  await dialog
    .getByLabel("Workspace name to confirm deletion", { exact: true })
    .fill("project");
  await dialog
    .getByRole("button", { name: "Delete selected settings", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await assert.rejects(access(workspace));
  await assert.rejects(access(path.join(vault, ".saddle")));
  assert.equal(
    await readFile(path.join(vault, "keep.md"), "utf8"),
    "Keep this ordinary file",
  );
  await button("Back").click();
  await button("Create").click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Native internal");
  await page
    .getByRole("group", { name: "Vault", exact: true })
    .getByRole("button", { name: "Internal", exact: true })
    .click();
  await page.getByLabel("Vault name", { exact: true }).fill("Private vault");
  await button("Create workspace").click();
  for (let i = 0; i < 3; i++) await button("Skip").click();
  await createVaultFile(page, "Private vault", "private.md");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill("Stored in native internal vault");
  await button("Save").click();
  await close();
  const internal = JSON.parse(
    await readFile(
      path.join(profile, "file-workspaces/workspace/workspace.json"),
      "utf8",
    ),
  );
  const location = Object.values(internal.computers)[0].vaults;
  const token = Object.values(location)[0];
  assert.match(token, /^internal:/);
  assert.equal(
    await readFile(
      path.join(
        profile,
        "file-workspaces/workspace/vaults",
        token.slice(9),
        "private.md",
      ),
      "utf8",
    ),
    "Stored in native internal vault",
  );
  await button("Manage").click();
  await dropdown().click();
  await page
    .getByRole("option", { name: "Native internal", exact: true })
    .click();
  await button("Open workspace").click();
  await button("private.md").click();
  await expect(editor).toHaveText("Stored in native internal vault");
  await close();
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: "/tmp/jocki-launch-desktop.png",
    fullPage: true,
  });
  console.log(
    "Verified native workspace save/open file pickers, full folder paths, persistent external references, unlink/reopen, confirmed metadata deletion and preservation of ordinary files.",
  );
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
      path: "/tmp/jocki-launch-desktop-failure.png",
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
