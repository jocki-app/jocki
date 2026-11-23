/** Navigate through the same responsive menus on desktop and mobile. */
export async function approveDevice(page, request) {
  const { expect } = await import("@playwright/test");
  await navigate(page, "Devices");
  await page.getByRole("button", { name: "Add device", exact: true }).click();
  const popup = page.getByRole("dialog");
  await popup
    .getByRole("textbox", { name: "Device request", exact: true })
    .fill(request);
  await expect(
    popup.getByText(/is requesting (read|write) access to/),
  ).toBeVisible();
  await popup.getByRole("button", { name: "Approve", exact: true }).click();
  const invitation = page.getByRole("textbox", {
    name: "Invitation JSON",
    exact: true,
  });
  await expect(invitation).not.toHaveValue("");
  const value = await invitation.inputValue();
  await page.keyboard.press("Escape");
  await expect(invitation).toHaveCount(0);
  return value;
}
export async function navigate(page, name) {
  const right = [
    "Files",
    "Tables",
    "Variables",
    "Credentials",
    "Devices",
    "Notifications",
    "Jobs",
    "Settings",
  ].includes(name);
  const menu = page.getByRole("navigation", {
    name: right ? "Settings and tools" : "Workspace",
    exact: true,
  });
  if (!(await menu.isVisible()))
    await page
      .getByRole("button", {
        name: right ? "Open settings menu" : "Open plugins menu",
        exact: true,
      })
      .click();
  await menu.getByRole("button", { name, exact: true }).click();
  await menu.waitFor({ state: "hidden" });
}
/** Add ordinary columns, then explicitly assign matching plugin features for these fixtures. */
export async function addColumnTemplates(page, plugin, labels) {
  await navigate(page, plugin);
  await page
    .getByRole("button", { name: "Open plugins menu", exact: true })
    .click();
  const menu = page.getByRole("navigation", { name: "Workspace", exact: true });
  await menu
    .getByRole("button", { name: `${plugin} pages`, exact: true })
    .click();
  await menu.getByRole("button", { name: "Columns", exact: true }).click();
  for (const label of labels) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("button", { name: "Add column", exact: true }).click();
    await page
      .getByRole("button", { name: `Remove ${label} column`, exact: true })
      .waitFor();
    const feature = page.getByLabel(`${label} plugin feature`, { exact: true });
    const { expect } = await import("@playwright/test");
    if (!(await feature.count())) continue;
    await expect(feature).toContainText("Not mapped");
    await feature.click();
    await page
      .getByRole("option", { name: "Not mapped", exact: true })
      .waitFor();
    const option = page.getByRole("option", { name: label, exact: true });
    if (await option.count()) await option.click();
    else await page.keyboard.press("Escape");
    await expect(feature).toHaveAttribute("aria-expanded", "false");
  }
  await navigate(page, plugin);
}

/** Exercise the real welcome flow; every test owns an explicitly named workspace. */
export async function createWorkspace(page, name = "My workspace") {
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page.getByRole("navigation", { name: "Current page" }).waitFor();
}
export async function leaveWorkspace(page) {
  await page
    .getByRole("button", { name: "Open settings menu", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Switch workspace", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).waitFor();
}

/** Shared inline CRUD helpers; wait for the durable write before navigating. */
/** @param {import("@playwright/test").Page} page @param {string} value */
export function entryByName(page, value) {
  return page.locator("[data-record-id]").filter({
    has: page
      .locator(`input[value=${JSON.stringify(value)}]`)
      .or(page.getByText(value, { exact: true })),
  });
}
/** @param {import("@playwright/test").Page} page @param {Record<string, unknown>} values */
export async function createInlineEntry(page, values, collection = "") {
  const { expect: baseExpect } = await import("@playwright/test");
  const expect = baseExpect.configure({ timeout: 30000 });
  const table = collection
    ? page.locator(`[data-record-collection=${collection}]`)
    : page.locator("[data-record-collection]").first();
  const row = table.locator("[data-create-row]");
  await row.waitFor({ state: "visible" });
  const count = await table.locator("[data-record-id]").count();
  for (const [label, value] of Object.entries(values)) {
    const input = row.getByLabel(label, { exact: true });
    if (!(await input.count())) {
      await table.getByRole("button", { name: "Columns", exact: true }).click();
      await page
        .getByRole("switch", { name: "Show column " + label, exact: true })
        .check();
      await table.getByRole("button", { name: "Columns", exact: true }).click();
    }
    if (await input.evaluate((element) => element.tagName === "BUTTON")) {
      await input.click();
      await page
        .getByRole("option", { name: String(value), exact: true })
        .click();
    } else await input.fill(String(value));
  }
  await row.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(table.locator("[data-record-id]")).toHaveCount(count + 1);
  await expect(
    table.getByRole("button", { name: "Saving changes", exact: true }),
  ).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Add entry", exact: true }),
  ).toBeEnabled();
}
