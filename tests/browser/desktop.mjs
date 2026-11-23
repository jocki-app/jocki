import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspace, navigate } from "./navigation-helpers.mjs";
const directory = await mkdtemp(
  path.join(os.tmpdir(), "jocki-desktop-repo-"),
);
const env = { ...process.env };
await mkdir(path.join(directory, "peer"), { recursive: true });
await writeFile(
  path.join(directory, "peer/repository-settings.json"),
  JSON.stringify({ endpoints: [], syncServer: "keyhive" }),
);
delete env.ELECTRON_RUN_AS_NODE;
let app;
const launch = () =>
  electron.launch({
    ...(process.env.JOCKI_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.JOCKI_DESKTOP_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.JOCKI_DESKTOP_EXECUTABLE ? [] : [process.cwd()]),
      `--user-data-dir=${directory}`,
    ],
    env,
  });
try {
  console.log("Launching desktop");
  app = await launch();
  console.log("Desktop launched");
  await app.evaluate(() => {
    process.on("uncaughtException", (error) => {
      console.error("Native exception:", error.stack);
      process.exit(1);
    });
  });
  app
    .process()
    .stderr?.on("data", (data) => console.error(String(data).slice(0, 1500)));
  let page = await app.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Renderer:", message.text());
  });
  console.log("Desktop window ready");
  await createWorkspace(page, "Desktop Repo");
  console.log("Desktop workspace created");
  await navigate(page, "Settings");
  await expect(
    page.getByRole("button", { name: "Export Automerge bundle", exact: true }),
  ).toBeVisible();
  const first = await page.evaluate(() => window.jockiNative.peer.info());
  expect(first.workspaces).toHaveLength(1);
  const profiles = await page.evaluate(() =>
    window.jockiNative.repository.profiles(),
  );
  expect(profiles[0].name).toBe("Desktop Repo");
  // Exercise the renderer's native Repo storage capability without exposing bytes.
  expect(
    await page.evaluate(
      async () =>
        (
          await window.jockiNative.repository.storage(
            "documents",
            "loadRange",
            [],
          )
        ).length,
    ),
  ).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await app.close();
  app = await launch();
  app
    .process()
    .stderr?.on("data", (data) => console.error(String(data).slice(0, 1500)));
  page = await app.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(45000);
  await page.getByRole("navigation", { name: "Current page" }).waitFor();
  const second = await page.evaluate(() => window.jockiNative.peer.info());
  expect(second.id).toBe(first.id);
  expect(second.workspaces).toEqual(first.workspaces);
  await navigate(page, "Settings");
  await expect(
    page.getByRole("button", { name: "Export Automerge bundle", exact: true }),
  ).toBeVisible();
  // Full reloads must retain the native workspace and identity.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.reload();
    await page.getByRole("navigation", { name: "Current page" }).waitFor();
    const reloaded = await page.evaluate(() =>
      window.jockiNative.peer.info(),
    );
    expect(reloaded.id).toBe(first.id);
    expect(reloaded.workspaces).toEqual(first.workspaces);
  }
  console.log(
    "Desktop directory storage, IPC, identity, restart and full reloads passed.",
  );
} catch (error) {
  console.error(error);
  if (app)
    console.error(
      (
        await app
          .windows()[0]
          ?.locator("body")
          .innerText({ timeout: 3000 })
          .catch(() => "Window unavailable")
      )?.slice(0, 3500),
    );
  throw error;
} finally {
  if (app) {
    const timeout = setTimeout(() => app.process().kill(), 15000);
    try {
      await app.close();
    } finally {
      clearTimeout(timeout);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
