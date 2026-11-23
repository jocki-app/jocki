import { createWorkspace, openSavedWorkspace } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ headless: true });
const url = process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5175";
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error);
  });
  console.log("Opening", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await createWorkspace(page);
  console.log("Loaded");
  await page
    .getByRole("button", { name: "Create browser vault", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Studio");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("cell", { name: "Studio", exact: true }).waitFor();
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "Studio", exact: true }) })
    .getByRole("button", { name: "Enable history", exact: true })
    .click();
  await page.getByRole("dialog", { name: "History", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const rootActions = () =>
    page.getByRole("button", { name: "Actions for Studio", exact: true });
  await rootActions().click();
  await page.getByRole("menuitem", { name: "New folder", exact: true }).click();
  const folder = page.getByRole("textbox", {
    name: "Folder name",
    exact: true,
  });
  await folder.fill("Projects");
  await folder.press("Enter");
  await page
    .getByRole("button", { name: "Actions for Projects", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "New file", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Task list", exact: true }).click();
  const filename = page.getByRole("textbox", {
    name: "File name",
    exact: true,
  });
  await filename.waitFor();
  assert.deepEqual(
    await filename.evaluate((input) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
    [0, 6],
  );
  await filename.fill("Tasks.csdb");
  await filename.press("Enter");
  await page
    .getByRole("textbox", { name: "New task", exact: true })
    .fill("Buy milk");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByRole("textbox", { name: "New task", exact: true })
    .fill("Book train");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.screenshot({
    path: "/tmp/jocki-restored-tasks.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  await page.getByLabel("Filter field 1", { exact: true }).click();
  await page.getByRole("option", { name: "Title", exact: true }).click();
  await page.getByLabel("Filter operator 1", { exact: true }).click();
  await page.getByRole("option", { name: "Contains", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Filter value 1", exact: true })
    .fill("milk");
  await page
    .getByRole("textbox", { name: "Filter value 1", exact: true })
    .press("Tab");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Columns", exact: true })
    .first()
    .click(); // collection visibility chooser
  await page.getByLabel("Show column Status", { exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("select").count(), 0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Plugins", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Plugins", exact: true })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Details for Tasks", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Plugin file glob", exact: true })
    .fill("**/*.csdb\n!Archive/**");
  await page
    .getByRole("button", { name: "Save file glob", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await rootActions().click();
  await page.getByRole("menuitem", { name: "New file", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Markdown", exact: true }).click();
  await filename.fill("Notes.md");
  await filename.press("Enter");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill(
    "# Project notes\n\n[[Projects/Tasks.csdb]]\n\n## Next\nPlan the journey.",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("tab", { name: "Notes.md", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Tasks", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(editor).toBeVisible();
  const outline = page.getByRole("button", { name: "Outline", exact: true }),
    box = await page.locator("[data-dock-wrapper]").boundingBox();
  await outline.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2, {
    steps: 20,
  });
  await page.mouse.up();
  await expect(page.locator("[data-dock-pane]")).toHaveCount(2);
  const pane = page
    .locator("[data-dock-pane]")
    .filter({ has: page.getByRole("tab", { name: "Outline", exact: true }) });
  const paneBox = await pane.boundingBox();
  assert.ok(Math.abs(paneBox.width / box.width - 0.5) < 0.03);
  assert.ok(Math.abs(paneBox.height / box.height - 0.5) < 0.03);
  await page.screenshot({
    path: "/tmp/jocki-restored-desktop.png",
    fullPage: true,
  });
  await page.reload();
  await openSavedWorkspace(page);
  await page.getByRole("tab", { name: "Notes.md", exact: true }).waitFor();
  await expect(page.locator("[data-dock-pane]")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Document tools", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Document tools", exact: true })
    .waitFor();
  await expect(
    page
      .getByRole("button", { name: "Links and backlinks", exact: true })
      .last(),
  ).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "/tmp/jocki-restored-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit", exact: true }).last().click();
  await expect(
    page.getByRole("heading", { name: "Document tools", exact: true }),
  ).toBeHidden();
  const mobilePane = await page
    .locator("[data-dock-focused=true]")
    .boundingBox();
  assert.ok(mobilePane.width > 380);
  await page
    .getByRole("button", { name: "Document tools", exact: true })
    .click();
  const touch = page
      .getByRole("button", { name: "History", exact: true })
      .last(),
    touchBox = await touch.boundingBox(),
    wrapper = await page.locator("[data-dock-wrapper]").boundingBox();
  await touch.dispatchEvent("pointerdown", {
    pointerId: 42,
    pointerType: "touch",
    clientX: touchBox.x + 10,
    clientY: touchBox.y + 10,
  });
  await page.evaluate(
    ({ x, y }) => {
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 42,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerId: 42,
          pointerType: "touch",
          clientX: x,
          clientY: y,
        }),
      );
    },
    { x: wrapper.x + wrapper.width * 0.8, y: wrapper.y + wrapper.height * 0.8 },
  );
  await expect(
    page.getByRole("heading", { name: "Document tools", exact: true }),
  ).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator("[data-dock-pane]")).toHaveCount(3);
  assert.deepEqual(errors, []);
  console.log(
    "Verified shadcn explorer, folder/file creation, original task filters and columns, plugin glob settings, quarter docking, saved layout and mobile tools drawer.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-shell-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
