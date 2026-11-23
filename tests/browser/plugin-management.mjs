import { chromium, expect } from "@playwright/test";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import JSZip from "jszip";
import { defaultInventoryUrl } from "@jocki/platform/plugin-sdk/inventory";
import { createWorkspace, navigate } from "./navigation-helpers.mjs";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function pack(
  id,
  name,
  description,
  version = "1.0.0",
  publisher = "example",
  signingKey = keys.privateKey,
) {
  const manifest = {
    id,
    name,
    description,
    version,
    publisher,
    license: "MIT",
    platformApi: "^1.0.0",
    fieldSchemaApi: "^1.0.0",
    entrypoints: { core: "core.mjs" },
    ui: { mode: "none" },
    storage: { local: { mode: "none", collections: [] } },
    permissions: [],
    dependencies: [],
    features: {},
    sharedServices: [{ id: "core.settings", version: "^1", optional: false }],
    provides: { commands: [], events: [] },
    consumes: { commands: [], events: [] },
  };
  const files = {
    "plugin.json": Buffer.from(JSON.stringify(manifest)),
    "schemas.json": Buffer.from("[]"),
    LICENSE: Buffer.from("MIT"),
    "core.mjs": Buffer.from(
      'export default {async activate(context){await context.services.require("core.settings").set("activated",true);}};',
    ),
  };
  const index = Buffer.from(
    JSON.stringify({
      format: 1,
      publisher,
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [
          name,
          { size: bytes.length, sha256: hash(bytes) },
        ]),
      ),
    }),
  );
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
  zip.file("package-index.json", index);
  zip.file(
    "package-signature",
    sign(null, index, signingKey).toString("base64"),
  );
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  return {
    bytes,
    entry: {
      id,
      name,
      description,
      version,
      publisher,
      license: "MIT",
      downloadUrl: `https://plugins.test/${id}-${version}.zip`,
      sha256: hash(bytes),
      permissions: [],
      dependencies: [],
      grants: ["core.settings"],
    },
  };
}
const first = await pack(
  "example.camera",
  "Camera and archive notes",
  "Organize the photo archive.",
);
const update = await pack(
  "example.camera",
  "Camera and archive notes",
  "Organize the photo archive.",
  "1.1.0",
);
const second = await pack(
  "example.time",
  "Time notes",
  "Track field observations.",
);
const latest = await pack(
  "example.camera",
  "Camera and archive notes",
  "Organize the photo archive.",
  "1.2.0",
);
let offerLatest = false;
const imported = await pack(
  "example.field",
  "Field notes",
  "Imported from a local ZIP.",
);
const invalid = await pack(
  "example.invalid",
  "Invalid notes",
  "Must never be installed.",
);
const tampered = await JSZip.loadAsync(invalid.bytes);
tampered.file("core.mjs", "modified code");
const badBytes = await tampered.generateAsync({ type: "nodebuffer" });
const untrusted = await pack(
  "unknown.notes",
  "Unknown notes",
  "Untrusted publisher.",
  "1.0.0",
  "unknown",
  generateKeyPairSync("ed25519").privateKey,
);
const inventory = (plugins) => ({
  schemaVersion: 1,
  name: "Test plugins",
  publishers: { example: publicKey },
  plugins: plugins.map((p) => p.entry),
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const headers = {
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  await context.route(defaultInventoryUrl, (route) =>
    route.fulfill({ json: inventory([first]), headers }),
  );
  await context.route("https://plugins.test/second.json", (route) =>
    route.fulfill({
      json: inventory([offerLatest ? latest : update, second]),
      headers,
    }),
  );
  await context.route("https://plugins.test/unavailable.json", (route) =>
    route.fulfill({ status: 503, body: "Unavailable", headers }),
  );
  for (const pkg of [first, update, second, latest])
    await context.route(pkg.entry.downloadUrl, (route) =>
      route.fulfill({
        body: pkg.bytes,
        contentType: "application/zip",
        headers,
      }),
    );
  await context.addInitScript(() =>
    localStorage.setItem(
      "jocki.automerge.connection",
      JSON.stringify({ endpoints: [], syncServer: "keyhive" }),
    ),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4198");
  await createWorkspace(page);
  await navigate(page, "Plugins");
  const optional = page.getByRole("region", { name: "Plugins", exact: true });
  const core = page.getByRole("region", { name: "Required core", exact: true });
  const row = (name) =>
    optional
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
  const camera = row("Camera and archive notes");
  await expect(camera).toBeVisible();
  await expect(
    page.getByText("Optional features", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/Choose the tools for your workspace/),
  ).toHaveCount(0);
  const group = page.getByRole("group", {
    name: "Plugin inventory",
    exact: true,
  });
  await expect(group).toHaveAttribute("data-slot", "button-group");
  await expect(group.getByRole("button").first()).toHaveText("Sync");
  await expect(group.getByRole("button").last()).toHaveAccessibleName(
    "Plugin sources",
  );
  await camera
    .getByRole("button", {
      name: "Package details and permissions",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText("core.settings");
  await page.keyboard.press("Escape");
  const provider = core.getByRole("row").nth(1);
  await expect(
    provider.getByRole("button", { name: "Disable", exact: true }),
  ).toBeDisabled();
  await expect(
    provider.getByRole("button", { name: "Uninstall", exact: true }),
  ).toBeDisabled();
  await provider
    .getByRole("button", {
      name: "Package details and permissions",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Included with Jocki",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Plugin sources", exact: true })
    .click();
  await expect(page.getByLabel("Plugin source 1", { exact: true })).toHaveValue(
    defaultInventoryUrl,
  );
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Plugin source 2", { exact: true })
    .fill("https://plugins.test/second.json");
  await page
    .getByRole("button", { name: "Save and sync", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row("Time notes")).toBeVisible();
  await expect(camera).toContainText("1.1.0");
  const search = page.getByRole("searchbox", {
    name: "Search plugins",
    exact: true,
  });
  await search.fill("photo archive");
  await expect(camera).toBeVisible();
  await expect(row("Time notes")).toHaveCount(0);
  await search.fill("TIME NOTES");
  await expect(camera).toHaveCount(0);
  await expect(row("Time notes")).toBeVisible();
  await search.fill("");
  await camera.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(camera.getByText("Enabled", { exact: true })).toBeVisible();
  const disable = await camera
    .getByRole("button", { name: "Disable", exact: true })
    .boundingBox();
  const uninstall = await camera
    .getByRole("button", { name: "Uninstall", exact: true })
    .boundingBox();
  expect(uninstall.x).toBeGreaterThan(disable.x + disable.width);
  await camera.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(camera.getByText("Disabled", { exact: true })).toBeVisible();
  await camera.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(camera.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeEnabled();
  offerLatest = true;
  await page.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeEnabled();
  await camera
    .getByRole("button", {
      name: "Package details and permissions",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Update to 1.2.0", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("1.2.0", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);
  await expect(camera).toContainText("1.2.0");
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Plugin sources", exact: true })
    .click();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Plugin source 3", { exact: true })
    .fill("https://plugins.test/unavailable.json");
  await page
    .getByRole("button", { name: "Save and sync", exact: true })
    .click();
  await expect(
    page.getByText("Download returned HTTP 503", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await navigate(page, "Plugins");
  await page
    .getByRole("button", { name: "Plugin sources", exact: true })
    .click();
  await expect(page.getByLabel("Plugin source 2", { exact: true })).toHaveValue(
    "https://plugins.test/second.json",
  );
  await expect(page.getByLabel("Plugin source 3", { exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/jocki-plugin-management-desktop.png",
  });
  await context.setOffline(true);
  const file = page.getByLabel("Import plugin package", { exact: true });
  await file.setInputFiles({
    name: "field-notes.zip",
    mimeType: "application/zip",
    buffer: imported.bytes,
  });
  await expect(
    row("Field notes").getByText("Enabled", { exact: true }),
  ).toBeVisible();
  await file.setInputFiles({
    name: "bad-notes.zip",
    mimeType: "application/zip",
    buffer: badBytes,
  });
  await expect(
    page.getByText("Package entry size changed", { exact: true }),
  ).toBeVisible();
  await expect(row("Invalid notes")).toHaveCount(0);
  await file.setInputFiles({
    name: "unknown-notes.zip",
    mimeType: "application/zip",
    buffer: untrusted.bytes,
  });
  await expect(
    page.getByText("Publisher signature is not trusted", { exact: true }),
  ).toBeVisible();
  await expect(row("Unknown notes")).toHaveCount(0);
  await context.setOffline(false);
  await page.reload();
  await navigate(page, "Plugins");
  await expect(
    row("Field notes").getByText("Enabled", { exact: true }),
  ).toBeVisible();
  await expect(row("Invalid notes")).toHaveCount(0);
  await expect(row("Unknown notes")).toHaveCount(0);
  await row("Field notes")
    .getByRole("button", { name: "Uninstall", exact: true })
    .click();
  await expect(
    row("Field notes").getByRole("button", { name: "Install", exact: true }),
  ).toBeVisible();
  await row("Field notes")
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await expect(
    row("Field notes").getByText("Enabled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    row("Field notes").getByRole("button", {
      name: "Package details and permissions",
      exact: true,
    }),
  ).toBeInViewport();
  await page.screenshot({
    path: "/tmp/jocki-plugin-management-mobile.png",
  });
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeVisible();
  expect(failures).toEqual([]);
  console.log(
    "Search, core rows, info dialogs, immediate install, source merge/persistence/rollback, offline ZIP import, invalid-package rejection and mobile controls passed.",
  );
} finally {
  await browser.close();
}
