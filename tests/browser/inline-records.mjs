import { chromium, expect as baseExpect } from "@playwright/test";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
} from "./navigation-helpers.mjs";
import { reviewInventory } from "./inventory-helpers.mjs";
const expect = baseExpect.configure({ timeout: 25000 });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
await reviewInventory(context);
const page = await context.newPage();
page.setDefaultTimeout(25000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const choose = async (scope, label, value) => {
  await scope.getByLabel(label, { exact: true }).click();
  await page
    .locator("[data-slot=select-content][data-open]")
    .getByRole("option", { name: value, exact: true })
    .click();
};
try {
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:5188");
  await createWorkspace(page, "Inline tables");
  await navigate(page, "Plugins");
  const install = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await install.getByRole("button", { name: "Install", exact: true }).click();

  await install.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await navigate(page, "Tasks");
  await addColumnTemplates(page, "Tasks", [
    "Title",
    "Status",
    "Description",
    "Parent",
  ]);
  const table = page.locator("[data-record-collection=tasks]");
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  // Explicitly enable Parent; new columns already default to visible.
  await page
    .getByRole("switch", { name: "Show column Parent", exact: true })
    .check()
    .catch(async () => {
      const labels = await page
        .getByRole("switch")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
      throw Error("Column labels: " + JSON.stringify(labels));
    });
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  const create = table.locator("[data-create-row]");
  for (const name of ["Root", "Child"]) {
    await create.getByLabel("Title", { exact: true }).fill(name);
    await choose(create, "Status", "open");
    if (name === "Child") await choose(create, "Parent", "Root");
    await create
      .getByRole("button", { name: "Add entry", exact: true })
      .click();
    await expect(table.locator("[data-record-id]")).toHaveCount(
      name === "Root" ? 1 : 2,
    );
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const root = table.locator("[data-record-id]").filter({
    has: page
      .getByRole("textbox", { name: "Title", exact: true })
      .and(page.locator('input[value="Root"]')),
  });
  const child = table
    .locator("[data-record-id]")
    .filter({ has: page.locator('input[value="Child"]') });
  await choose(root, "Parent", "Child");
  await root.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]'),
  ).toContainText("cycle");
  await root
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await root.getByLabel("Title", { exact: true }).fill("Root revised");
  await child
    .getByLabel("Description", { exact: true })
    .fill("Inline child notes");
  await table
    .getByRole("checkbox", { name: "Select all visible entries", exact: true })
    .check();
  await table
    .getByRole("button", { name: "Save selected entries", exact: true })
    .click();
  await expect(
    table.getByRole("button", { name: "Save selected entries", exact: true }),
  ).toHaveCount(0);
  await expect(
    create.getByRole("button", { name: "Add entry", exact: true }),
  ).toBeEnabled();
  await expect(table.getByRole("alert")).toHaveCount(0);
  await expect(
    table.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("navigation", { name: "Current page" }).waitFor();
  await expect(table.locator("[data-record-id]")).toHaveCount(2);
  await expect(table.locator('input[value="Root revised"]')).toHaveCount(1);
  await expect(
    table.getByLabel("Description", { exact: true }).filter({ visible: true }),
  ).toHaveCount(3);
  await page.screenshot({
    path: "/tmp/jocki-inline-saved.png",
    fullPage: true,
  });
  for (const mode of [
    "Board",
    "Short table folder",
    "Long table folder",
    "Board folder",
    "Short table",
  ]) {
    await table.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitemradio", { name: mode, exact: true }).click();
    await expect(table.locator("[data-record-id]")).toHaveCount(2);
    await expect(table.locator("[data-create-row]")).toHaveCount(1);
    await expect(
      table.locator('[data-record-id] input[aria-label="Title"]'),
    ).toHaveCount(2);
  }
  await table
    .getByRole("checkbox", { name: "Select all visible entries", exact: true })
    .check();
  await table
    .getByRole("button", { name: "Delete selected entries", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(table.locator("[data-record-id]")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/jocki-inline-records.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "Inline creation, shared reference input, cycle rejection, bulk saving, reload and bulk deletion passed",
  );
} catch (error) {
  await page.screenshot({
    path: "/tmp/jocki-inline-failure.png",
    fullPage: true,
  });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
