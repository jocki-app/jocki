import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWorkspace,
  navigate,
  leaveWorkspace,
} from "./navigation-helpers.mjs";
const directory = await mkdtemp(
  path.join(os.tmpdir(), "jocki-browser-repo-"),
);
const workspaceName = "Repo persistence " + crypto.randomUUID();
const persistent = process.env.TEST_BROWSER === "webkit";
const browser = await (persistent
  ? webkit.launchPersistentContext(path.join(directory, "profile"), {
      headless: true,
    })
  : chromium.launch({ channel: "chrome", headless: true }));
try {
  const context = persistent ? browser : await browser.newContext();
  await context.addInitScript(() => {
    window.sqlWorkers = new Set();
    window.Worker = new Proxy(window.Worker, {
      construct(Worker, args) {
        const worker = Reflect.construct(Worker, args);
        if (String(args[0]).includes("duckdb-browser")) {
          window.sqlWorkers.add(worker);
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            window.sqlWorkers.delete(worker);
            terminate();
          };
        }
        return worker;
      },
    });
    localStorage.setItem(
      "jocki.automerge.connection",
      JSON.stringify({ endpoints: [], syncServer: "keyhive" }),
    );
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Page error:", error.message);
  });
  page.setDefaultTimeout(45000);
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4177");
  await expect(
    page.getByRole("img", { name: "Jocki", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button")).toHaveText(["Create", "Join", "Open"]);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Device request", exact: true }),
  ).not.toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Join workspace", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await createWorkspace(page, workspaceName);
  await expect
    .poll(() => page.evaluate(() => window.sqlWorkers.size), {
      timeout: 45000,
    })
    .toBe(2);
  console.log("Created workspace");
  await navigate(page, "Settings");
  await expect(
    page.getByRole("button", { name: "Export Automerge bundle", exact: true }),
  ).toBeVisible();
  console.log("Opened settings");
  await page.reload();
  await navigate(page, "Settings");
  console.log("Reloaded workspace");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export Automerge bundle", exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.automerge$/);
  const filename = path.join(directory, "workspace.automerge");
  await file.saveAs(filename);
  console.log("Exported bundle");
  await leaveWorkspace(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page
    .getByRole("button", { name: "Saved workspaces", exact: true })
    .click();
  await page.getByRole("button", { name: workspaceName, exact: true }).click();
  await page.getByRole("navigation", { name: "Current page" }).waitFor();
  await leaveWorkspace(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page
    .getByLabel("Import Automerge bundle", { exact: true })
    .setInputFiles(filename);
  await page.getByRole("navigation", { name: "Current page" }).waitFor();
  await navigate(page, "Settings");
  await expect(
    page.getByRole("button", { name: "Export Automerge bundle", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Browser IndexedDB reload and Automerge bundle round trip passed.",
  );
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
