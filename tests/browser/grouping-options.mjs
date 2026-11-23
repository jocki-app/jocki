import { chromium, expect } from "@playwright/test";
import { reviewInventory } from "./inventory-helpers.mjs";
import {
  createWorkspace,
  navigate,
  addColumnTemplates,
  createInlineEntry,
} from "./navigation-helpers.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(20000);
  await reviewInventory(page.context());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  const choose = async (label, name) => {
    await page.getByLabel(label, { exact: true }).click();
    if (label.startsWith("Group label ")) {
      await page.getByRole("menuitemradio", { name, exact: true }).click();
      await expect(
        page.locator('[data-slot="dropdown-menu-content"][data-open]'),
      ).toHaveCount(0);
      return;
    }
    await page
      .locator('[data-slot="select-content"][data-open]')
      .getByRole("option", { name, exact: true })
      .click();
    await expect(
      page.locator('[data-slot="select-content"][data-open]'),
    ).toHaveCount(0);
  };
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4178");
  await createWorkspace(page);
  await navigate(page, "Plugins");
  const plugin = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await plugin.getByRole("button", { name: "Install", exact: true }).click();

  await plugin.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await addColumnTemplates(page, "Tasks", ["Title", "Status", "Parent task"]);
  for (const values of [
    { Title: "Root", Status: "open" },
    { Title: "Child", Status: "open", "Parent task": "Root" },
    { Title: "Grandchild", Status: "done", "Parent task": "Child" },
    { Title: "Sibling", Status: "open", "Parent task": "Root" },
  ])
    await createInlineEntry(page, values);
  await expect(
    page.getByRole("group", { name: "Group expansion levels", exact: true }),
  ).toHaveCount(0);
  const groupButton = page
    .locator("[data-record-collection]")
    .getByRole("button", { name: "Group", exact: true });
  await groupButton.click();
  await click("Add group");
  await choose("Group field 1", "Parent task");
  await choose("Group label 1", "Title");
  await choose("Group mode 1", "Recursive");
  await groupButton.click();
  await expect(
    page.locator('[data-slot="popover-content"]:visible'),
  ).toHaveCount(0);
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  const levels = page.getByRole("group", {
    name: "Group expansion levels",
    exact: true,
  });
  await expect(levels.locator("[data-group-level]")).toHaveCount(2);
  for (const depth of [1, 2]) {
    const control = levels.locator(`[data-group-level="${depth}"]`);
    await expect(control).toHaveAttribute("aria-expanded", "true");
    const icon = await control.locator("svg").boundingBox();
    const rowIcon = await page
      .locator(`[data-group-toggle-level="${depth}"] svg`)
      .first()
      .boundingBox();
    expect(
      Math.abs(icon.x + icon.width / 2 - rowIcon.x - rowIcon.width / 2),
    ).toBeLessThan(1);
  }
  const toolbarBox = await levels.boundingBox();
  const breadcrumbBox = await page
    .getByRole("navigation", { name: "Tasks groups" })
    .boundingBox();
  const headerBox = await page.locator("thead").boundingBox();
  expect(toolbarBox.y).toBeGreaterThanOrEqual(
    breadcrumbBox.y + breadcrumbBox.height,
  );
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(headerBox.y);
  await click("Collapse all groups at level 2");
  await expect(page.locator("[data-record-id]")).toHaveCount(3);
  await click("Collapse all groups at level 1");
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await expect(levels.locator("[data-group-level]")).toHaveCount(2);
  await click("Expand all groups at level 2");
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await click("Expand all groups at level 1");
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  await page.screenshot({
    path: "/tmp/jocki-group-levels.png",
    fullPage: true,
  });
  await expect(page.locator('[data-group-heading="parent_id"]')).toHaveCount(2);
  await expect(
    page
      .locator('[data-group-heading="parent_id"] [data-group-count]')
      .filter({ hasText: /^4$/ }),
  ).toHaveCount(0);
  const childHeading = page.locator('[data-group-heading="parent_id"]').filter({
    has: page.locator("[data-group-count]").filter({ hasText: /^3$/ }),
  });
  const childLabel = (
    await childHeading
      .getByRole("button", { name: /^Collapse / })
      .getAttribute("aria-label")
  ).slice("Collapse ".length);
  expect(
    new Set(childLabel.slice("Parent task: ".length).split(" / ")),
  ).toEqual(new Set(["Child", "Sibling", "Grandchild"]));
  await expect(childHeading).toBeVisible();
  await expect(childHeading.locator("[data-group-count]")).toHaveText("3");
  const arrow = await childHeading.locator("[data-group-open]").boundingBox();
  const count = await childHeading.locator("[data-group-count]").boundingBox();
  expect(count.x).toBeGreaterThan(arrow.x);
  const rootStripe = page
    .locator('[data-group-heading="parent_id"] [data-group-stripes]')
    .first();
  await expect(rootStripe).toHaveAttribute("data-depth", "1");
  await expect(childHeading.locator("[data-group-stripes]")).toHaveAttribute(
    "data-depth",
    "1",
  );
  await click("Collapse " + childLabel);
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await click("Expand " + childLabel);
  const view = async (name) => {
    await click("View");
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  await view("Short table folder");
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await click("Open folder " + childLabel);
  await expect(page.locator("[data-record-id]")).toHaveCount(2);
  await view("Board");
  await expect(page.locator("[data-record-id]")).toHaveCount(3);
  await page
    .getByRole("navigation", { name: "Tasks groups" })
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  await view("Short table");
  await groupButton.click();
  await click("Add group");
  await choose("Group field 2", "Status");
  await groupButton.click();
  await expect(
    page.locator('[data-slot="popover-content"]:visible'),
  ).toHaveCount(0);
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  await expect(page.locator('[data-group-heading="status"]')).toHaveCount(3);
  await expect(levels.locator("[data-group-level]")).toHaveCount(3);
  await click("Collapse all groups at level 2");
  await expect(page.locator('[data-group-toggle-level="2"]')).toHaveCount(2);
  for (const toggle of await page
    .locator('[data-group-toggle-level="2"]')
    .all())
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await click("Expand all groups at level 2");
  await expect(page.locator("[data-record-id]")).toHaveCount(4);

  // A wheel gesture over grouped rows must scroll the page, not a tiny
  // overflow range caused by decorations inside the horizontal table scroller.
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const tableScroller = page.locator('[data-slot="table-container"]');
  const tableBounds = await tableScroller.boundingBox();
  await page.mouse.move(tableBounds.x + 200, tableBounds.y + 100);
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  expect(await tableScroller.evaluate((el) => el.scrollTop)).toBe(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "/tmp/jocki-recursive-groups.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  await groupButton.click();
  await expect(page.getByLabel("Group mode 1", { exact: true })).toContainText(
    "Recursive",
  );
  await expect(page.getByLabel("Group label 1", { exact: true })).toContainText(
    "Title",
  );
  await choose("Group mode 1", "Individual");
  await groupButton.click();
  await expect(
    page.locator('[data-slot="popover-content"]:visible'),
  ).toHaveCount(0);
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  await expect(
    page.getByRole("button", {
      name: /^Collapse Parent task: (Child \/ Sibling|Sibling \/ Child)$/,
      exact: true,
    }),
  ).toBeVisible();
  const rootId = await page
    .locator("[data-record-id]")
    .filter({ has: page.locator('input[aria-label="Title"][value="Root"]') })
    .getAttribute("data-record-id");
  await groupButton.click();
  await choose("Group mode 1", "Recursive");
  await choose("Group label 1", "Group value");
  const toggleMaterialize = async () => {
    await page.getByLabel("Group label 1", { exact: true }).click();
    const checkbox = page.getByRole("menuitemcheckbox", {
      name: "Materialize Parent task group 1",
      exact: true,
    });
    await expect(checkbox).toBeVisible();
    const option = page.locator('[data-group-label-option="parent_id"]');
    await expect(
      option.getByRole("menuitemradio", { name: "Parent task", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-group-label-option="title"]')
        .getByRole("menuitemcheckbox"),
    ).toHaveCount(0);
    const bounds = await option.evaluate((el) => {
      const label = el
        .querySelector('[role="menuitemradio"]')
        .getBoundingClientRect();
      const checkbox = el
        .querySelector('[role="menuitemcheckbox"]')
        .getBoundingClientRect();
      return {
        labelX: label.x,
        checkboxX: checkbox.x,
        overflow:
          checkbox.right -
          el
            .closest('[data-slot="dropdown-menu-content"]')
            .getBoundingClientRect().right,
        offset: Math.abs(
          label.y + label.height / 2 - checkbox.y - checkbox.height / 2,
        ),
      };
    });
    expect(bounds.checkboxX).toBeGreaterThan(bounds.labelX);
    expect(bounds.offset).toBeLessThan(1);
    expect(bounds.overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: "/tmp/jocki-materialize-menu.png",
      animations: "disabled",
    });
    await checkbox.click();
    await expect(
      page.locator('[data-slot="dropdown-menu-content"][data-open]'),
    ).toHaveCount(0);
  };
  await toggleMaterialize();
  await page.getByLabel("Group label 2", { exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", {
      name: "Materialize Status group 2",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await groupButton.click();
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  await expect(
    page.locator(
      "[data-materialized-group][data-record-id], [data-materialized-group] [data-record-id]",
    ),
  ).toHaveCount(2);
  const rootRow = page.locator(`[data-record-id="${rootId}"]`);
  const groupId = await rootRow.getAttribute("data-materialized-group");
  const rootHeading = page.locator(
    `[data-group-id=${JSON.stringify(groupId)}]`,
  );
  const ordinaryRow = page
    .locator("[data-record-id]:not([data-materialized-group])")
    .first();
  const rootCells = await rootRow.locator(":scope > td").evaluateAll((cells) =>
    cells.map((cell) => ({
      x: cell.getBoundingClientRect().x,
      width: cell.getBoundingClientRect().width,
    })),
  );
  const ordinaryCells = await ordinaryRow
    .locator(":scope > td")
    .evaluateAll((cells) =>
      cells.map((cell) => ({
        x: cell.getBoundingClientRect().x,
        width: cell.getBoundingClientRect().width,
      })),
    );
  expect(rootCells).toEqual(ordinaryCells);
  expect(
    await rootRow.evaluate(
      (row) => row.closest("table").querySelectorAll("table").length,
    ),
  ).toBe(0);
  await expect(rootHeading).toHaveCount(1);
  await expect(rootHeading).not.toContainText(rootId);
  const groupValue = JSON.parse(
    JSON.parse(groupId).findLast((segment) => segment.field === "parent_id")
      .key,
  );
  await rootHeading
    .getByRole("button", {
      name: `Open group Parent task: ${groupValue}`,
      exact: true,
    })
    .click();
  const breadcrumb = page.getByRole("navigation", { name: "Tasks groups" });
  await expect(
    breadcrumb.getByText(`Parent task: ${groupValue}`, { exact: true }),
  ).toBeVisible();
  await expect(breadcrumb).not.toContainText("Not set");
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  await breadcrumb.getByRole("button", { name: "Tasks", exact: true }).click();
  await rootHeading.getByRole("button", { name: /^Collapse / }).click();
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await expect(rootRow).toBeVisible();
  await rootHeading.getByRole("button", { name: /^Expand / }).click();
  await rootRow.getByLabel("Title", { exact: true }).fill("Root edited");
  await rootRow
    .getByRole("button", { name: "Save entry", exact: true })
    .click();
  await expect(page.getByText("Entry saved.", { exact: true })).toBeVisible();
  await expect(
    rootRow.getByRole("button", { name: "Save entry", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(rootRow.getByLabel("Title", { exact: true })).toHaveValue(
    "Root edited",
  );
  await expect(
    page.locator(
      "[data-materialized-group][data-record-id], [data-materialized-group] [data-record-id]",
    ),
  ).toHaveCount(2);
  // Only the Group value dropdown owns this setting; table headers stay clean.
  await expect(
    page
      .locator("[data-group-heading]")
      .getByRole("checkbox", { name: /^Materialize / }),
  ).toHaveCount(0);
  await groupButton.click();
  await toggleMaterialize();
  await groupButton.click();
  await expect(page.locator("[data-materialized-group]")).toHaveCount(0);
  await expect(page.locator("[data-record-id]")).toHaveCount(4);
  await groupButton.click();
  await toggleMaterialize();
  await groupButton.click();
  await view("Short table folder");
  // Materialized parents now occupy their natural subgroup, just like leaves.
  await expect(page.locator("[data-record-id]")).toHaveCount(0);
  await click("Open folder Status: open");
  for (const name of [
    "Long table folder",
    "Board folder",
    "Short table folder",
  ]) {
    await view(name);
    await expect(page.locator("[data-record-id]")).toHaveCount(1);
    await expect(rootRow.getByLabel("Title", { exact: true })).toHaveValue(
      "Root edited",
    );
  }
  for (const name of ["Board", "Long table", "Short table"]) {
    await view(name);
    await expect(page.locator("[data-record-id]")).toHaveCount(4);
    await expect(
      page.locator(
        "[data-materialized-group][data-record-id], [data-materialized-group] [data-record-id]",
      ),
    ).toHaveCount(2);
  }
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]:visible'),
  ).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/jocki-materialized-groups.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "Recursive/individual grouping, aggregated labels, nested rules, color strips, collapse, control order and saved preferences passed.",
  );
} finally {
  await browser.close();
}
