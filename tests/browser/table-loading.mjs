import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";

const directory = await mkdtemp(
  path.join(os.tmpdir(), "jocki-table-loading-"),
);
const cache = path.resolve("node_modules", ".vite-" + path.basename(directory));
const trackingView = path.resolve("packages/app-ui/tracking-view.tsx");
const native = process.env.JOCKI_NATIVE;
delete process.env.JOCKI_NATIVE;
let server, browser;
try {
  server = await createServer({
    cacheDir: cache,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "table-render-counter",
        enforce: "pre",
        transform(code, id) {
          if (id.split("?")[0] === trackingView)
            return code.replace(
              "const [entry, setEntry] = useState<ResourceRecord | null>(null);",
              "window.__entriesRenders = (window.__entriesRenders ?? 0) + 1; const [entry, setEntry] = useState<ResourceRecord | null>(null);",
            );
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() =>
    localStorage.setItem(
      "jocki.automerge.connection",
      JSON.stringify({ endpoints: [], syncServer: "keyhive" }),
    ),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseMain;
  const mainGate = new Promise((resolve) => {
    releaseMain = resolve;
  });
  await page.route("**/src/main.tsx", async (route) => {
    await mainGate;
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, {
    waitUntil: "commit",
  });
  const initialSpinner = page.getByRole("status", {
    name: "Loading Jocki…",
    exact: true,
  });
  await expect(initialSpinner.locator("svg")).toBeVisible();
  expect(
    (await initialSpinner.locator("svg").boundingBox()).width,
  ).toBeGreaterThanOrEqual(40);
  releaseMain();
  await createWorkspace(page, "Table loading benchmark");
  await navigate(page, "Plugins");
  for (const name of ["Track", "Time"]) {
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole("button", { name: "Install", exact: true }).click();
    await expect(
      row.getByRole("button", { name: "Disable", exact: true }),
    ).toBeEnabled();
  }
  await addColumnTemplates(page, "Track", ["Activity"]);
  await navigate(page, "Plugins");
  await page.evaluate(async () => {
    const fixture = await import("/tests/browser/table-loading.ts");
    await fixture.seedTableRows(1000);
  });
  const start = Date.now();
  await navigate(page, "Track");
  const table = page.locator('[data-record-collection="track"]');
  await expect(table.locator("[data-record-id]")).toHaveCount(1000, {
    timeout: 45000,
  });
  const elapsed = Date.now() - start;
  console.log(`Track table rendered 1,000 rows in ${elapsed} ms`);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Sort, filter, and review sessions in list, week, and month views.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(page.locator(".page-description:visible")).toHaveCount(0);
  const baseline = await page.evaluate(() => window.__entriesRenders);
  const initial = await page.getByRole("timer").textContent();
  await expect
    .poll(() => page.getByRole("timer").textContent())
    .not.toBe(initial);
  const next = await page.getByRole("timer").textContent();
  await expect.poll(() => page.getByRole("timer").textContent()).not.toBe(next);
  expect((await page.evaluate(() => window.__entriesRenders)) - baseline).toBe(
    0,
  );
  await navigate(page, "Time");
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("timer")).toHaveText("00:15:00");
  expect(errors).toEqual([]);
  console.log(
    `Loaded 1,000 Track entries in ${elapsed} ms; clock ticks did not rebuild the table. Continue actions and tab descriptions are absent.`,
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(cache, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
  if (native === undefined) delete process.env.JOCKI_NATIVE;
  else process.env.JOCKI_NATIVE = native;
}
