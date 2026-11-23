import { LexoRank } from "lexorank";
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
    viewport: { width: 1600, height: 1100 },
  });
  page.setDefaultTimeout(20000);
  await reviewInventory(page.context());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const click = (name) =>
    page.getByRole("button", { name, exact: true }).click();
  const choose = async (label, value) => {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4178");
  await createWorkspace(page);
  await navigate(page, "Plugins");
  const plugin = page
    .getByRole("row")
    .filter({ has: page.getByText("Tasks", { exact: true }) });
  await plugin.getByRole("button", { name: "Install", exact: true }).click();

  await plugin.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await addColumnTemplates(page, "Tasks", [
    "Title",
    "Status",
    "Parent task",
    "Sort order",
  ]);
  for (const values of [
    { Title: "Root", Status: "open" },
    { Title: "Child", Status: "open", "Parent task": "Root" },
    { Title: "Grandchild", Status: "open", "Parent task": "Child" },
    { Title: "Loose", Status: "open" },
    { Title: "Other", Status: "open" },
  ])
    await createInlineEntry(page, values);
  const table = page.locator('[data-record-collection="tasks"]');
  const byTitle = (value) =>
    page.locator("[data-record-id]").filter({
      has: page.locator(
        `input[aria-label="Title"][value=${JSON.stringify(value)}]`,
      ),
    });
  const rootId = await byTitle("Root").getAttribute("data-record-id");
  const root = page.locator(`[data-record-id="${rootId}"]`);
  const child = byTitle("Child"),
    loose = byTitle("Loose"),
    other = byTitle("Other");
  await expect(
    root.getByRole("button", { name: "Save entry", exact: true }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("button", { name: "Delete entry", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Storage copies", exact: true }),
  ).toHaveCount(0);
  await root
    .getByRole("button", { name: "Only this computer confirmed", exact: true })
    .click();
  const popover = page
    .locator('[data-slot="popover-content"]')
    .filter({ has: page.getByText("Item sync status", { exact: true }) });
  await expect(
    popover.getByRole("button", { name: "Storage copies", exact: true }),
  ).toBeVisible();
  const placement = await popover
    .getByRole("button", { name: "Storage copies", exact: true })
    .boundingBox();
  const title = await popover
    .getByText("Item sync status", { exact: true })
    .boundingBox();
  expect(placement.x).toBeGreaterThan(title.x + title.width);
  await page.keyboard.press("Escape");
  await root
    .getByRole("checkbox", { name: "Select entry", exact: true })
    .check();
  await root.getByLabel("Title", { exact: true }).fill("Root draft");
  await expect(
    root.getByRole("button", { name: "Save entry", exact: true }),
  ).toBeVisible();
  await expect(
    root.getByRole("button", { name: "Delete entry", exact: true }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("button", {
      name: "Only this computer confirmed",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    table.getByRole("button", { name: "Save selected entries", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Delete selected entries", exact: true }),
  ).toHaveCount(0);
  await root
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await expect(root.getByLabel("Title", { exact: true })).toHaveValue("Root");
  await expect(
    table.getByRole("button", { name: "Delete selected entries", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Drag entry", exact: true }),
  ).toHaveCount(0);
  await click("Group");
  await click("Add group");
  await choose("Group field 1", "Parent task");
  await choose("Group mode 1", "Recursive");
  await page.getByLabel("Group label 1", { exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", {
      name: "Materialize Parent task group 1",
      exact: true,
    })
    .click();
  await click("Group");
  await expect(
    table.getByRole("button", { name: "Drag entry", exact: true }),
  ).toHaveCount(5);
  const actionOrder = await root
    .locator("[data-table-actions] [aria-label]")
    .evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("aria-label")),
    );
  expect(actionOrder.slice(0, 3)).toEqual([
    "Select entry",
    "Drag entry",
    "Only this computer confirmed",
  ]);
  const childHeader = child.locator("xpath=preceding-sibling::tr[1]");
  // Use actual browser mouse dragging, and inspect the highlight before release.
  const drag = async (source, target, fraction = 0.5, verify) => {
    const handle = source.getByRole("button", {
      name: "Drag entry",
      exact: true,
    });
    await expect(handle).toBeEnabled();
    await handle.scrollIntoViewIfNeeded();
    const from = await handle.boundingBox(),
      to = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y + from.height / 2 + 8, {
      steps: 5,
    });
    await page.mouse.move(
      to.x + Math.min(120, to.width / 2),
      to.y + to.height * fraction,
      { steps: 10 },
    );
    await page.mouse.move(
      to.x + Math.min(120, to.width / 2) + 1,
      to.y + to.height * fraction,
    );
    if (verify) await verify();
    await page.mouse.up();
    await expect(
      table.getByRole("button", { name: "Saving changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      table.getByRole("button", { name: "Drag entry", exact: true }).first(),
    ).toBeEnabled();
  };
  const geometry = () =>
    page.locator("[data-record-id]").evaluateAll((elements) =>
      elements.map((el) => ({
        id: el.dataset.recordId,
        y: el.getBoundingClientRect().y,
        height: el.getBoundingClientRect().height,
      })),
    );
  const before = await geometry();
  await drag(loose, childHeader, 0.5, async () => {
    await expect(childHeader).toHaveAttribute("data-drag-group", "true");
    await expect(child).toHaveAttribute("data-drag-group", "true");
    await expect(byTitle("Grandchild")).toHaveAttribute(
      "data-drag-group",
      "true",
    );
    expect(await geometry()).toEqual(before);
    await expect
      .poll(() =>
        childHeader.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toContain("color(srgb");
    await page.screenshot({
      path: "/tmp/jocki-group-drop.png",
      fullPage: true,
    });
  });
  await expect(loose.getByLabel("Parent task", { exact: true })).toContainText(
    "Child",
  );
  // A leaf is a grouping destination before it has a group heading.
  await drag(other, loose, 0.5, async () => {
    await expect(loose).toHaveAttribute("data-drag-group", "true");
    await expect(loose).not.toHaveAttribute(
      "data-drop-position",
      /before|after/,
    );
  });
  await expect(other.getByLabel("Parent task", { exact: true })).toContainText(
    "Loose",
  );
  await drag(root, childHeader);
  await expect(page.getByText(/cannot be moved under itself/)).toBeVisible();
  await expect(root.getByLabel("Parent task", { exact: true })).toContainText(
    "Choose",
  );
  await drag(loose, page.locator("[data-root-drop]"));
  await expect(loose.getByLabel("Parent task", { exact: true })).toContainText(
    "Choose",
  );
  await click("Sort");
  await click("Add sort");
  await choose("Sort field 1", "Sort order");
  await click("Sort");
  const grandchild = byTitle("Grandchild");
  const preSort = await geometry();
  await drag(loose, grandchild, 0.1, async () => {
    await expect(grandchild).toHaveAttribute("data-drop-position", "before");
    const shadow = await grandchild.evaluate(
      (el) => getComputedStyle(el).boxShadow,
    );
    expect(shadow).toContain("3px");
    expect(await geometry()).toEqual(preSort);
    await expect
      .poll(() =>
        grandchild.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toContain("color(srgb");
    await page.screenshot({
      path: "/tmp/jocki-order-drop.png",
      fullPage: true,
    });
  });
  await expect(loose.getByLabel("Parent task", { exact: true })).toContainText(
    "Child",
  );
  await expect(loose.getByLabel("Sort order", { exact: true })).toHaveValue(
    /^[012]\|/,
  );
  await expect(
    grandchild.getByLabel("Sort order", { exact: true }),
  ).toHaveValue(/^[012]\|/);
  expect((await loose.boundingBox()).y).toBeLessThan(
    (await grandchild.boundingBox()).y,
  );
  await expect(
    table.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(loose.getByLabel("Parent task", { exact: true })).toContainText(
    "Child",
  );
  expect((await loose.boundingBox()).y).toBeLessThan(
    (await grandchild.boundingBox()).y,
  );
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await drag(other, grandchild, 0.9, async () => {
    await expect(grandchild).toHaveAttribute("data-drop-position", "after");
    await expect
      .poll(() =>
        grandchild.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toContain("color(srgb");
    await page.screenshot({
      path: "/tmp/jocki-order-drop-dark.png",
      fullPage: true,
    });
  });
  await expect(other.getByLabel("Parent task", { exact: true })).toContainText(
    "Child",
  );
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  // Sorting alone uses the same handle; persisted text ranks determine the order.
  await click("Group");
  await click("Reset group");
  await click("Group");
  await expect(page.locator("[data-group-heading]")).toHaveCount(0);
  await expect(
    table.getByRole("button", { name: "Drag entry", exact: true }),
  ).toHaveCount(5);
  await drag(other, root, 0.1);
  await expect(other.getByLabel("Sort order", { exact: true })).toHaveValue(
    /^[012]\|/,
  );
  expect((await other.boundingBox()).y).toBeLessThan(
    (await root.boundingBox()).y,
  );
  await expect(
    table.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(other.getByLabel("Sort order", { exact: true })).toHaveValue(
    /^[012]\|/,
  );
  expect((await other.boundingBox()).y).toBeLessThan(
    (await root.boundingBox()).y,
  );
  await click("Sort");
  await click("Reset sort");
  await click("Sort");
  await expect(
    table.getByRole("button", { name: "Drag entry", exact: true }),
  ).toHaveCount(0);
  // Parents and leaves share a sibling ordering, independent of children.
  const rootRank = await root
    .getByLabel("Sort order", { exact: true })
    .inputValue();
  await createInlineEntry(page, {
    Title: "Sibling",
    Status: "open",
    "Sort order": LexoRank.parse(rootRank).genNext().toString(),
  });
  const sibling = byTitle("Sibling");
  await click("Group");
  await click("Add group");
  await choose("Group field 1", "Parent task");
  await choose("Group mode 1", "Recursive");
  await page.getByLabel("Group label 1", { exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", {
      name: "Materialize Parent task group 1",
      exact: true,
    })
    .click();
  await click("Group");
  await click("Sort");
  await click("Add sort");
  await choose("Sort field 1", "Sort order");
  await click("Sort");
  const ranks = () =>
    page
      .locator("[data-record-id]")
      .evaluateAll((rows) =>
        Object.fromEntries(
          rows.map((row) => [
            row.dataset.recordId,
            row.querySelector('[aria-label="Sort order"]').value,
          ]),
        ),
      );
  const beforeRanks = await ranks();
  await drag(root, sibling, 0.9);
  await expect
    .poll(
      async () =>
        (await root.boundingBox()).y - (await sibling.boundingBox()).y,
    )
    .toBeGreaterThan(0);
  const afterRanks = await ranks();
  expect(
    Object.keys(afterRanks).filter((id) => beforeRanks[id] !== afterRanks[id]),
  ).toEqual([rootId]);
  await expect(child.getByLabel("Parent task", { exact: true })).toContainText(
    "Root",
  );
  // With Sorting active, the middle still creates children instead of reordering.
  await drag(sibling, other, 0.5);
  await expect(
    sibling.getByLabel("Parent task", { exact: true }),
  ).toContainText("Other");
  await drag(root, sibling, 0.5);
  await expect(page.getByText(/cannot be moved under itself/)).toBeVisible();
  await click("Collapse all groups at level 2");
  await expect(child).toBeVisible();
  await expect(sibling).toHaveCount(0);
  await child
    .getByRole("button", { name: "Delete entry", exact: true })
    .click();
  const deletion = page.getByRole("dialog");
  await expect(
    deletion.getByRole("heading", { name: "Delete 5 entries?", exact: true }),
  ).toBeVisible();
  await expect(
    deletion.getByText(/includes 4 descendant entries/),
  ).toBeVisible();
  await deletion.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await expect(root).toBeVisible();
  await expect(
    page.getByText("5 entries deleted.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-record-id]")).toHaveCount(1);
  await expect(root).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Action slots, nested group moves, cycle prevention, group highlights, stable insertion lines, LexoRank sorting and reload passed.",
  );
} finally {
  await browser.close();
}
