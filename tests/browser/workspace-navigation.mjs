import { createWorkspace } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createVaultFile, documentAction } from "./vault-ui-helpers.mjs";
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5175");
  await createWorkspace(page);
  await page
    .getByRole("button", { name: "Create browser vault", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Shared vault");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await createVaultFile(page, "Shared vault", "First.md");
  await page
    .getByRole("textbox", { name: "Markdown editor", exact: true })
    .fill("# Note\n\n[[Second.md]]");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const firstRow = page.locator('[data-explorer-path="First.md"]');
  await firstRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(
    0,
  );
  await page
    .locator("[data-vault-topbar]")
    .getByRole("button", { name: "File menu: First.md", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Rename", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "New folder", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Rename", exact: true })
    .press("Escape");
  await expect(
    page.getByRole("menuitem", { name: "Rename", exact: true }),
  ).toBeHidden();
  assert.equal(
    await page
      .locator("[data-vault-topbar]")
      .getByRole("button", { name: "Edit workspace", exact: true })
      .count(),
    0,
  );
  await page
    .locator("[data-vault-topbar]")
    .getByRole("button", { name: "Folder menu: Shared vault", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "New folder", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Graph", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "First.md", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Settings pages" });
  await expect(
    nav.getByRole("button", { name: "Sharing", exact: true }),
  ).toBeVisible();
  assert.equal(await nav.locator("input,textarea,select").count(), 0);
  await nav
    .getByRole("button", { name: "Keyboard shortcuts", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose workspace", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit workspace", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Workspace name", exact: true })
    .fill("Writing");
  await page
    .getByRole("heading", { name: "Workspace", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Choose workspace", exact: true }),
  ).toContainText("Writing");
  await page
    .getByRole("button", { name: "Advanced workspace settings", exact: true })
    .click();
  const json = page.getByRole("textbox", {
      name: "Workspace settings JSON",
      exact: true,
    }),
    valid = await json.inputValue();
  await json.fill("invalid json");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("JSON");
  await json.fill(valid);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await nav.getByRole("button", { name: "Local logs", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Local logs", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: /JSON/ }).first()).toBeVisible();
  await page
    .getByRole("button", { name: "Choose workspace", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "New workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New workspace",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Workspace name", exact: true })
    .fill("Research");
  await dialog
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose workspace", exact: true }),
  ).toContainText("Research");
  await expect(
    page.getByRole("button", { name: "First.md", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Open vault from Writing/ }).click();
  await expect(
    page.getByRole("button", { name: "First.md", exact: true }),
  ).toBeVisible();
  // Drag an unopened explorer file through the exact tab drop protocol.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator('[data-explorer-path="First.md"]')
    .dispatchEvent("dragstart", { dataTransfer: transfer });
  const wrapper = page.locator("[data-dock-wrapper]"),
    rect = await wrapper.boundingBox();
  const point = {
    clientX: rect.x + rect.width * 0.8,
    clientY: rect.y + rect.height * 0.5,
    dataTransfer: transfer,
  };
  await wrapper.dispatchEvent("dragover", point);
  await wrapper.dispatchEvent("drop", point);
  await expect(page.locator("[data-dock-pane]")).toHaveCount(2);
  await expect(
    page.getByRole("textbox", { name: "Markdown editor", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose workspace", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Writing", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Choose workspace", exact: true }),
  ).toContainText("Writing");
  await expect(
    page.getByRole("tab", { name: "Graph", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-registry-desktop.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Verified one active saved workspace, shared vault references, navigation-only settings, app tabs, contextual breadcrumbs, right-click menus, explorer dragging and Sonner/local logs.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-registry-navigation-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
