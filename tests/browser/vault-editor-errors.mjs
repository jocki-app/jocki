import { createWorkspace, openSavedWorkspace } from "./vault-ui-helpers.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  createVaultFile,
  skipVaultSetup,
  writeVaultFiles,
} from "./vault-ui-helpers.mjs";
const raw = `--- csdb\nformat: CSDB\nversion: 2\nname: imported_tasks\nschemas: [public]\ntables: [public.tasks]\n\n--- schema:public\nname: public\ntypes: {}\n\n--- table:public:tasks\nschema: public\nname: tasks\ncolumns: {_record_id: text, title: text, revision: bigint}\nrequired: [_record_id]\nprimary_key: {columns: [_record_id]}\n\n--- data:tasks\n_record_id,title,revision\na,Imported task,9223372036854775807\n`;
const typed = `--- csdb\nformat: CSDB\nversion: 2\nname: tasks\nschemas: [public]\ntables: [public.tasks]\n\n--- schema:public\nname: public\ntypes: {}\n\n--- table:public:tasks\nschema: public\nname: tasks\ncolumns: {id: text, uid: text, dtstamp: timestamp, title: text, status: {type: enum, options: [open, in-progress, done, cancelled]}}\nrequired: [id,uid,dtstamp]\nprimary_key: {columns: [id]}\n\n--- data:tasks\nid,uid,dtstamp,title,status\na,ua,2026-01-01T00:00:00Z,Typed task,open\n`;
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const chooseView = async (file, view) => {
    await page
      .getByRole("button", { name: `View for ${file}`, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page
      .getByRole("dialog", { name: "File views" })
      .getByRole("button", { name: view, exact: true })
      .click();
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5175");
  await createWorkspace(page);
  await page
    .getByRole("button", { name: "Create browser vault", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Regression");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await skipVaultSetup(page);
  await writeVaultFiles(page, "Regression", [
    { name: "Imported.csdb", buffer: Buffer.from(raw) },
    { name: "Typed.csdb", buffer: Buffer.from(typed) },
  ]);
  await page
    .getByRole("button", { name: "Imported.csdb", exact: true })
    .click();
  const chip = page.locator("[data-dock-tab]").filter({
    has: page.getByRole("tab", { name: "Imported.csdb", exact: true }),
  });
  const spacing = await chip.evaluate((node) => {
    const rect = node.getBoundingClientRect(),
      label = node.querySelector('[role="tab"]'),
      close = node.querySelector('[aria-label="Close Imported.csdb"]'),
      a = label.getBoundingClientRect(),
      b = close.getBoundingClientRect();
    return {
      gaps: [
        b.x - a.right,
        rect.right - b.right,
        b.y - rect.y,
        rect.bottom - b.bottom,
        a.x -
          (node
            .querySelector('[aria-label^="View for "]')
            ?.getBoundingClientRect().right ?? rect.x),
      ],
      labelBorder: getComputedStyle(label).borderRightWidth,
    };
  });
  assert.equal(spacing.labelBorder, "0px");
  assert.ok(
    spacing.gaps.every((n) => Math.abs(n - 4) < 1),
    JSON.stringify(spacing),
  );
  await chooseView("Imported.csdb", "SQL");
  await page
    .getByRole("button", { name: "Run SQL in draft", exact: true })
    .click();
  await expect(page.getByLabel("SQL result", { exact: true })).toContainText(
    '"9223372036854775807"',
  );
  await chooseView("Imported.csdb", "Properties");
  const contentType = page.getByRole("combobox", {
    name: "Content type",
    exact: true,
  });
  await contentType.click();
  await page.getByRole("option", { name: "Task list", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]").last()).toContainText(
    "requires the column public.tasks.id (text)",
  );
  await expect(contentType).toContainText("No content type");
  await chooseView("Imported.csdb", "Tables");
  await page
    .getByRole("textbox", { name: "title row 1", exact: true })
    .fill("Edited imported task");
  await page
    .getByRole("textbox", { name: "title row 1", exact: true })
    .press("Tab");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Typed.csdb", exact: true }).click();
  await chooseView("Typed.csdb", "Properties");
  await contentType.click();
  await page.getByRole("option", { name: "Task list", exact: true }).click();
  await chooseView("Typed.csdb", "Tasks");
  await expect(
    page.getByRole("button", { name: "Add task", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-document-toolbar]")
      .getByRole("button", { name: "Filter", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // The first grouping edit must survive a reload, including creation of its
  // previously absent Automerge preference maps.
  const groupButton = page.getByRole("button", { name: "Group", exact: true });
  await groupButton.click();
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const app = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki");
        const workspace = await app.getDirectoryHandle("workspace");
        const settings = JSON.parse(
          await (
            await (await workspace.getFileHandle("workspace.json")).getFile()
          ).text(),
        );
        return Object.values(settings.computers).some((computer) =>
          Object.values(computer.plugins?.["core.csdb"]?.views ?? {}).some(
            (view) => view.groups?.length === 1,
          ),
        );
      }),
    )
    .toBe(true);
  await page.reload();
  await openSavedWorkspace(page);
  await groupButton.click();
  await expect(page.locator("[data-group-rule]")).toHaveCount(1);
  await page.getByLabel("Group field 1", { exact: true }).click();
  await page.getByRole("option", { name: "Status", exact: true }).click();
  await page.getByLabel("Group label 1", { exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Title", exact: true }).click();
  await page.getByLabel("Group label 1", { exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Group value", exact: true })
    .click();
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await page
    .getByRole("button", { name: "Move group 2 up", exact: true })
    .click();
  await page
    .getByRole("switch", { name: "Enable group 2", exact: true })
    .click();
  await page
    .getByRole("switch", { name: "Enable group 2", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move group 2 up", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove group 2", exact: true })
    .click();
  await groupButton.click();
  await expect(page.locator('[data-group-heading="status"]')).toBeVisible();
  await page.reload();
  await openSavedWorkspace(page);
  await expect(page.locator('[data-group-heading="status"]')).toBeVisible();
  await groupButton.click();
  await expect(page.getByLabel("Group label 1", { exact: true })).toHaveText(
    "Group value",
  );
  await groupButton.click();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .getByRole("tab", { name: "Imported.csdb", exact: true })
    .dispatchEvent("dragstart", { dataTransfer: transfer });
  const dock = page.locator("[data-dock-wrapper]"),
    box = await dock.boundingBox();
  await dock.dispatchEvent("drop", {
    dataTransfer: transfer,
    clientX: box.x + box.width * 0.2,
    clientY: box.y + box.height * 0.5,
  });
  await expect(page.locator("[data-dock-pane]")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Title", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "View for Typed.csdb", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-document-toolbar]")
      .getByRole("button", { name: "Filter", exact: true }),
  ).toHaveCount(1);
  await page.screenshot({
    path: "/tmp/jocki-menu-fixes-desktop.png",
    fullPage: true,
  });

  await createVaultFile(page, "Regression", "Draft.md");
  const markdown = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await markdown.fill("# Save before switching\n");
  const choose = async (name) => {
    await page
      .getByRole("button", { name: "Choose workspace", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  const createWorkspace = async () => {
    await choose("New workspace");
    const dialog = page.getByRole("dialog", {
      name: "New workspace",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Workspace name", exact: true })
      .fill("Review");
    await dialog
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
  };
  const prompt = page.getByRole("dialog", {
    name: "Save changes before switching workspaces?",
    exact: true,
  });
  await createWorkspace();
  await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(markdown).toContainText("Save before switching");
  await createWorkspace();
  await prompt.getByRole("button", { name: "Save all", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Choose workspace", exact: true }),
  ).toContainText("Review");
  await choose("Workspace");
  await page.getByRole("tab", { name: "Draft.md", exact: true }).click();
  await expect(markdown).toContainText("Save before switching");
  await markdown.fill("Discard this edit");
  await choose("Review");
  await prompt.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Choose workspace", exact: true }),
  ).toContainText("Review");
  await choose("Workspace");
  await page.getByRole("tab", { name: "Draft.md", exact: true }).click();
  await expect(markdown).toContainText("Save before switching");

  // Closing the final file/page used to persist activePane: undefined.
  const chips = page.locator("[data-dock-tab]");
  while (await chips.count()) {
    const count = await chips.count();
    await chips
      .first()
      .getByRole("button", { name: /^Close / })
      .click();
    await expect.poll(() => chips.count()).toBeLessThan(count);
  }
  const readState = () =>
    page.evaluate(async () => {
      const app = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("jocki"),
        workspace = await app.getDirectoryHandle("workspace");
      const settings = JSON.parse(
        await (
          await (await workspace.getFileHandle("workspace.json")).getFile()
        ).text(),
      );
      const logs = [];
      const logDir = await workspace.getDirectoryHandle("logs");
      for await (const handle of logDir.values())
        if (handle.kind === "file")
          logs.push(await (await handle.getFile()).text());
      return { computers: settings.computers, logs: logs.join("\n") };
    });
  await expect
    .poll(async () =>
      Object.values((await readState()).computers).every(
        (c) => !c.layout?.dock?.panes?.length,
      ),
    )
    .toBe(true);
  assert.doesNotMatch(
    (await readState()).logs,
    /Cannot assign undefined|serialize a BigInt|no webview presentation|First section must be|Database name .* must use/,
  );
  await page.reload();
  await openSavedWorkspace(page);
  await expect(page.locator("[data-dock-pane]")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "Verified grouping changes and cleared labels persist across reloads, exact BigInt SQL, content-type validation before assignment, built-in alternate views, close-button spacing, Save/Discard/Cancel on workspace changes and durable empty dock layouts.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-menu-fixes-errors-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
