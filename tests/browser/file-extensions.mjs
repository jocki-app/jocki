import { createWorkspace } from "./vault-ui-helpers.mjs";
import { createVaultFile, skipVaultSetup } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createHash } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const files = {};
for (const name of ["extension.json", "extension.mjs", "LICENSE"])
  files[name] = await readFile(`examples/file-extension/${name}`);
const index = {
  format: 1,
  publisher: "example",
  files: Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      },
    ]),
  ),
};
const zip = new JSZip(),
  payload = Buffer.from(JSON.stringify(index));
zip.file("package-index.json", payload);
zip.file(
  "package-signature",
  sign(null, payload, privateKey).toString("base64"),
);
for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
const artifact = await zip.generateAsync({ type: "nodebuffer" });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  const workers = [];
  page.on("worker", (worker) => workers.push(worker));
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5173");
  await createWorkspace(page);
  await page
    .getByRole("button", { name: "Create browser vault", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Extension test");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await skipVaultSetup(page);
  await page
    .getByRole("cell", { name: "Extension test", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Plugins", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Install a signed ZIP", exact: true })
    .click();
  await page.getByLabel("Publisher ID", { exact: true }).fill("example");
  await page
    .getByLabel("Trusted publisher public key (PEM)", { exact: true })
    .fill(publicKey.export({ format: "pem", type: "spki" }).toString());
  await page.getByLabel("Package", { exact: true }).setInputFiles({
    name: "example.zip",
    mimeType: "application/zip",
    buffer: artifact,
  });
  await page.getByText("Example text editor", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator('iframe[title="Example text editor extension host"]')
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await createVaultFile(page, "Extension test", "sample.txt", "Text file");
  const frame = page.frameLocator('iframe[title="Extension editor"]');
  try {
    await frame.getByLabel("Extension text").waitFor({ timeout: 15000 });
  } catch (error) {
    console.error(
      "Extension activation failed",
      errors,
      await page.getByRole("alert").allTextContents(),
    );
    throw error;
  }
  await frame
    .getByText("Changes remain in the tab until Save.", { exact: true })
    .waitFor();
  await frame.getByLabel("Extension text").fill("Plugin draft   ");
  assert.equal(workers.length, 1);
  assert.deepEqual(
    await workers[0].evaluate(() => ({
      origin: globalThis.origin,
      document: typeof document,
      native: "jockiVaults" in globalThis,
    })),
    { origin: "null", document: "undefined", native: false },
  );
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  const readFileValue = () =>
    page.evaluate(async () => {
      const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki");
      for await (const [name, handle] of app.entries())
        if (name !== "workspace" && handle.kind === "directory") {
          try {
            return await (
              await (await handle.getFileHandle("sample.txt")).getFile()
            ).text();
          } catch {}
        }
    });
  assert.equal(await readFileValue(), "");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(readFileValue).toBe("Plugin draft"); // Extension's will-save hook trimmed whitespace.
  const isolation = await page
    .frames()
    .find(
      (f) =>
        f.name() === "" && f.url() === "about:srcdoc" && f !== page.mainFrame(),
    )
    ?.evaluate(() => {
      let parentAccessible = false,
        storageAccessible = false;
      try {
        void parent.document.body;
        parentAccessible = true;
      } catch {}
      try {
        void localStorage.length;
        storageAccessible = true;
      } catch {}
      return {
        parentAccessible,
        storageAccessible,
        native: "jockiNative" in window,
      };
    });
  assert.deepEqual(isolation, {
    parentAccessible: false,
    storageAccessible: false,
    native: false,
  });
  await page.keyboard.press("ControlOrMeta+p");
  await page
    .getByRole("dialog", { name: "Commands" })
    .getByRole("button", { name: "Uppercase text", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  assert.equal(await readFileValue(), "Plugin draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(readFileValue).toBe("PLUGIN DRAFT");
  await expect(
    page
      .locator("[data-document-toolbar]")
      .getByRole("button", { name: "Uppercase text", exact: true }),
  ).toBeVisible();
  await page
    .locator("[data-document-toolbar]")
    .getByRole("button", { name: "Text tools", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Uppercase from tools", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Browse Example files", exact: true })
    .click();
  await expect(
    page
      .locator("[data-navigation-pane]")
      .getByRole("button", { name: "sample.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Browse Files", exact: true }).click();
  await page.getByText("Example text files", { exact: true }).click();
  await page
    .locator(".vault-extension-view")
    .getByRole("button", { name: "sample.txt", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Browse Search", exact: true })
    .click();
  await page
    .locator("[data-navigation-pane]")
    .getByRole("textbox", { name: "Search all vaults", exact: true })
    .fill("extension-extracted");
  await expect(
    page
      .locator("[data-navigation-pane]")
      .locator("[data-search-result]")
      .filter({ hasText: "sample.txt" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Browse Files", exact: true }).click();
  await page
    .locator('[data-explorer-path="sample.txt"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Example text editor", exact: true })
    .hover();
  await page
    .getByRole("menuitem", { name: "Text preview", exact: true })
    .click();
  const preview = page
      .locator("[data-dock-tab]")
      .filter({ has: page.locator('[title="Current view: Text preview"]') })
      .getByRole("tab"),
    area = await page.locator("[data-dock-wrapper]").boundingBox();
  await preview.hover();
  await page.mouse.down();
  await page.mouse.move(
    area.x + area.width * 0.12,
    area.y + area.height * 0.5,
    { steps: 20 },
  );
  await page.mouse.up();
  await expect(page.locator("[data-dock-pane]")).toHaveCount(2);
  await expect(
    page
      .locator("[data-dock-pane]")
      .filter({
        has: page.locator('[title="Current view: Text preview"]'),
      })
      .frameLocator('iframe[title="Extension editor"]')
      .getByLabel("Text preview"),
  ).toHaveText("PLUGIN DRAFT");
  assert.deepEqual(errors, []);
  console.log(
    "Verified signed extension install, lazy host activation, isolated custom editor, draft-only updates, command, and will-save hook.",
  );
} finally {
  await browser.close();
}
