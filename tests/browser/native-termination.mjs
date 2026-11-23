import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWorkspace } from "./navigation-helpers.mjs";

const directory = await mkdtemp(
  path.join(os.tmpdir(), "jocki-termination-"),
);
const cache = path.resolve("node_modules", ".vite-" + path.basename(directory));
const diagnostics = path.resolve("packages/platform-native/diagnostics.ts");
const native = process.env.JOCKI_NATIVE;
delete process.env.JOCKI_NATIVE;
let server, browser;
try {
  server = await createServer({
    cacheDir: cache,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "native-termination-fixture",
        enforce: "pre",
        transform(_code, id) {
          if (id.split("?")[0] === diagnostics)
            return `export async function consumeNativeRuntimeEvents() {
            const event = sessionStorage.getItem("test.native-termination");
            sessionStorage.removeItem("test.native-termination");
            return event ? [{type:"web-content-terminated",at:event}] : [];
          }`;
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() =>
    localStorage.setItem(
      "jocki.automerge.connection",
      JSON.stringify({ endpoints: [], syncServer: "keyhive" }),
    ),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await createWorkspace(page, "Retained after termination");
  const id = await page.evaluate(() => {
    sessionStorage.setItem("test.native-termination", new Date().toISOString());
    return localStorage.getItem("jocki.active-workspace");
  });
  expect(id).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Workspace reopening is paused" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Current page" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("jocki.active-workspace"),
    ),
  ).toBeNull();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page
    .getByRole("button", { name: "Saved workspaces", exact: true })
    .click();
  await expect(
    page.getByText("Retained after termination", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async (id) => {
      const { browserDevice } =
        await import("/packages/platform-browser/device.ts");
      return (await browserDevice()).profiles().some((link) => link.id === id);
    }, id),
  ).toBe(true);
  console.log(
    "Native termination pauses workspace reopening and retains the saved workspace.",
  );
} finally {
  if (native === undefined) delete process.env.JOCKI_NATIVE;
  else process.env.JOCKI_NATIVE = native;
  await browser?.close();
  await server?.close();
  await rm(cache, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
}
