import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const directory = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "jocki-startup-errors-")),
);
const storage = path.join(directory, "file-workspaces", "workspace");
await mkdir(storage, { recursive: true });
const catalog = path.join(storage, "workspaces.json");
const invalid = JSON.stringify({
  entries: [{ id: crypto.randomUUID(), name: "Preserved", root: "" }],
});
const workspace = path.join(storage, "workspace.json");
await writeFile(catalog, invalid);
await writeFile(workspace, "untouched workspace contents");
const env = { ...process.env };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
delete env.JOCKI_NATIVE;
let app;
try {
  app = await electron.launch({
    args: [process.cwd(), "--user-data-dir=" + directory],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const button = (name) => page.getByRole("button", { name, exact: true });
  for (const name of ["Create", "Join", "Manage"])
    await expect(button(name)).toBeVisible();
  await expect(button("Try again")).toHaveCount(0);
  await expect(button("Choose workspace")).toHaveCount(0);
  const failure = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Could not read the saved workspace list" });
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "View logs", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Local logs", exact: true });
  await expect(dialog).toContainText("invalid_value");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await button("Manage").click();
  await expect(button("Create")).toBeVisible();
  assert.equal(await readFile(catalog, "utf8"), invalid);
  assert.equal(
    await readFile(workspace, "utf8"),
    "untouched workspace contents",
  );
  await writeFile(catalog, JSON.stringify({ entries: [] }));
  await button("Manage").click();
  await expect(
    page.getByRole("combobox", { name: "Saved workspaces", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-desktop-startup-recovery.png",
    fullPage: true,
  });
  console.log(
    "Verified desktop startup catalog failure returns home, preserves workspace files and references, and recovers without restart.",
  );
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
