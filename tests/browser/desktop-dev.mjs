import {
  createWorkspace,
  openSavedWorkspace,
  documentAction,
  skipVaultSetup,
} from "./vault-ui-helpers.mjs";
// Build Electron first with npm run build:desktop.
// JOCKI_TEST_PRODUCTION=1 exercises the built renderer without a dev server.
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  open,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { tryLock, unlock } from "fs-native-extensions";
import { createHash } from "node:crypto";
const directory = await mkdtemp(
  path.join(os.tmpdir(), "jocki-file-desktop-"),
);
const vault = path.join(directory, "vault"),
  profile = path.join(directory, "profile");
await mkdir(vault);
await writeFile(path.join(vault, "notes.md"), "# Native note\n");
const entry = path.resolve("packages/app-ui/vault-app.tsx");
const cache = path.resolve("node_modules", ".vite-" + path.basename(directory));
const production = process.env.JOCKI_TEST_PRODUCTION === "1";
let revision = "Before update",
  server,
  app,
  exited = false;
const native = process.env.JOCKI_NATIVE;
delete process.env.JOCKI_NATIVE;
try {
  if (!production) {
    server = await createServer({
      cacheDir: cache,
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "file-workspace-refresh-probe",
          enforce: "pre",
          transform(code, id) {
            if (id.split("?")[0] === entry)
              return code.replace(
                '<main className="vault-app">',
                '<main data-refresh-probe="' +
                  revision +
                  '" className="vault-app">',
              );
          },
        },
      ],
    });
    await server.listen();
  }
  const env = {
    ...process.env,
  };
  if (production) delete env.VITE_DEV_SERVER_URL;
  else
    env.VITE_DEV_SERVER_URL =
      "http://127.0.0.1:" + server.httpServer.address().port;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [process.cwd(), "--user-data-dir=" + profile],
    env,
  });
  app.on("close", () => {
    exited = true;
  });
  await app.evaluate(({ dialog }, vault) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [vault],
    });
  }, vault);
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await createWorkspace(page);
  if (production)
    await expect(page.getByRole("main")).toBeVisible({ timeout: 45000 });
  else
    await expect(page.getByRole("main")).toHaveAttribute(
      "data-refresh-probe",
      revision,
      { timeout: 45000 },
    );
  await page.getByRole("button", { name: "Open folder", exact: true }).click();
  await skipVaultSetup(page);
  await page.getByRole("button", { name: "notes.md", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill("# Native note\nUnsaved in tab\n");
  assert.equal(
    await readFile(path.join(vault, "notes.md"), "utf8"),
    "# Native note\n",
  );
  if (!production) {
    const boot = await page.evaluate(
      () => (window.refreshProbe = crypto.randomUUID()),
    );
    revision = "After update";
    const module = server.moduleGraph.getModuleById(entry);
    if (!module) throw Error("Vault module did not load");
    await server.reloadModule(module);
    await expect(page.getByRole("main")).toHaveAttribute(
      "data-refresh-probe",
      revision,
    );
    await expect(editor).toContainText("Unsaved in tab");
    assert.equal(await page.evaluate(() => window.refreshProbe), boot);
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => readFile(path.join(vault, "notes.md"), "utf8"))
    .toContain("Unsaved in tab");
  await documentAction(page, "Enable history");
  await expect(
    page.getByRole("dialog", { name: "History", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  assert.equal(
    (await readFile(path.join(vault, ".notes.md.saddle")))
      .subarray(0, 8)
      .toString(),
    "SADDLE01",
  );
  await page
    .getByRole("button", { name: "Actions for vault", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Enable history", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "History", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  assert.equal(
    (await readFile(path.join(directory, ".vault.saddle")))
      .subarray(0, 8)
      .toString(),
    "SADDLE01",
  );
  await page
    .getByRole("button", { name: "Choose workspace", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Close workspace", exact: true })
    .click();
  await expect(page.locator("[data-start-screen]")).toBeVisible();
  await expect(editor).toHaveCount(0);
  for (const root of [vault, path.join(profile, "file-workspaces/workspace")]) {
    const handle = await open(
      path.join(
        os.tmpdir(),
        "jocki-writer-locks",
        "locks",
        createHash("sha256").update(root).digest("hex") + ".lock",
      ),
      "a+",
    );
    try {
      assert.equal(
        tryLock(handle.fd),
        true,
        "Starting page must release every native writer lease",
      );
      unlock(handle.fd);
    } finally {
      await handle.close();
    }
  }
  await page.reload();
  await expect(page.locator("[data-start-screen]")).toBeVisible();
  await openSavedWorkspace(page);
  await page.getByRole("button", { name: "notes.md", exact: true }).click();
  await expect(editor).toContainText("Unsaved in tab");
  const opened = app.waitForEvent("window");
  await documentAction(page, "Pop out");
  const child = await opened;
  await child
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .waitFor();
  await child.close();
  await editor.waitFor();
  await editor.fill("# Native note\nQuit draft\n");
  await app.evaluate(({ app }) => app.quit());
  const dialog = page.getByRole("dialog", {
    name: "Save changes before closing the workspace?",
  });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.evaluate(() => window.jockiVaults.workspace());
  assert.equal(exited, false);
  await app.evaluate(({ app }) => app.quit());
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Save all", exact: true }).click();
  try {
    await expect.poll(() => exited, { timeout: 10000 }).toBe(true);
  } catch (error) {
    console.error(
      "Quit state",
      await page.getByRole("alert").allTextContents(),
      await page.getByRole("dialog").allTextContents(),
      await page.locator("[data-vault-topbar]").innerText(),
    );
    throw error;
  }
  assert.match(
    await readFile(path.join(vault, "notes.md"), "utf8"),
    /Quit draft/,
  );
  assert.deepEqual(errors, []);
  console.log(
    `Verified ${production ? "production startup" : "HMR preservation"}, native folder capability, empty startup, released native leases, draft durability, pop-out editor and Save/Cancel on quit.`,
  );
} finally {
  if (app && !exited)
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await server?.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await rm(cache, { recursive: true, force: true });
  if (native !== undefined) process.env.JOCKI_NATIVE = native;
}
