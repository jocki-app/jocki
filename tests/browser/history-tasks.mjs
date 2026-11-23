import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { CSDBDatabase, parseDocument } from "@csvdatabase/csdb/portable";
import {
  internalVaultDirectory,
  createWorkspace,
  openSavedWorkspace,
  skipVaultSetup,
  writeVaultFiles,
} from "./vault-ui-helpers.mjs";

const db = CSDBDatabase.create("Tasks");
db.createSchema("public");
db.createTable({
  schema: "public",
  name: "tasks",
  columns: {
    id: "text",
    uid: "text",
    dtstamp: "timestamp",
    title: "text",
    notes: "text",
    status: { type: "enum", options: ["open", "done"] },
  },
  required: ["id", "uid", "dtstamp"],
  primary_key: { columns: ["id"] },
  visibility: { notes: "hidden" },
});
db.table("public.tasks").insert(
  ["a", "b", "c"].map((id) => ({
    id,
    uid: "uid-" + id,
    dtstamp: "2026-01-01T00:00:00Z",
    title: id.toUpperCase(),
    notes: id === "a" ? "A long task note ".repeat(50) : "",
    status: "open",
  })),
);
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  const button = (name) => page.getByRole("button", { name, exact: true });
  await createWorkspace(page);
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("History test");
  await button("Create").click();
  await skipVaultSetup(page);
  await writeVaultFiles(page, "History test", [
    { name: "Tasks.csdb", buffer: Buffer.from(db.toString()) },
    {
      name: "Tasks.csdb",
      record: "resource.json",
      buffer: Buffer.from(
        JSON.stringify({
          name: "tasks",
          path: "Tasks.csdb",
          jocki: { contentType: "jocki.task-list" },
        }),
      ),
    },
  ]);
  await button("Tasks.csdb").click();
  const row = (id) => page.locator(`[data-record-id="${id}"]`);
  const title = (id) =>
    row(id).getByRole("textbox", { name: "Title", exact: true });
  const save = (id) => row(id).locator("[data-save-state]");
  const history = () =>
    page.getByRole("dialog", { name: "History", exact: true });
  const rootName = await internalVaultDirectory(page, "History test");
  const disk = async () => {
    const value = await page.evaluate(async (rootName) => {
      const app = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("jocki");
      try {
        return await (
          await (
            await (
              await app.getDirectoryHandle(rootName)
            ).getFileHandle("Tasks.csdb")
          ).getFile()
        ).text();
      } catch (error) {
        if (["NotFoundError", "NotReadableError"].includes(error.name))
          return null;
        throw error;
      }
    }, rootName);
    if (value === null) return null;
    return parseDocument(value)
      .tables.get("public.tasks")
      .rows.map((row) => row.title);
  };
  await expect(save("a")).toHaveAttribute("data-save-state", "saved");
  await button("Enable history").click();
  await expect(history().locator("[data-history-overview]")).toBeVisible();
  await expect(history().locator("[data-history-diff]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await title("a").fill("A edited");
  await title("b").fill("B edited");
  await expect(save("a")).toHaveAttribute("data-save-state", "dirty");
  await expect(
    row("a").getByRole("button", {
      name: "Discard edits for A edited",
      exact: true,
    }),
  ).toBeVisible();
  await save("a").click();
  await expect(save("a")).toHaveAttribute("data-save-state", "saved");
  await expect(save("b")).toHaveAttribute("data-save-state", "dirty");
  await expect.poll(disk).toEqual(["A edited", "B", "C"]);
  // Holding Save offers a native message once history is enabled.
  const hold = async (target) => {
    const box = await target.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
  };
  await hold(save("b"));
  const description = page.getByRole("textbox", {
    name: "Version description",
    exact: true,
  });
  await expect(description).toBeVisible();
  await expect.poll(disk).toEqual(["A edited", "B", "C"]);
  await description.fill("Explain task B");
  await button("Save version").click();
  await expect(save("b")).toHaveAttribute("data-save-state", "saved");
  await expect(description).toHaveCount(0);
  await expect.poll(disk).toEqual(["A edited", "B edited", "C"]);
  // Header selection saves multiple tasks in one named commit; C stays private.
  await title("a").fill("A selected");
  await title("b").fill("B selected");
  await title("c").fill("C private");
  await row("a").getByRole("checkbox").click();
  await row("b").getByRole("checkbox").click();
  await hold(button("Save selected tasks"));
  await description.fill("Two selected tasks");
  await button("Save version").click();
  await expect.poll(disk).toEqual(["A selected", "B selected", "C"]);
  await expect(save("c")).toHaveAttribute("data-save-state", "dirty");
  await button("History").click();
  await expect(title("c")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(title("c")).toHaveValue("C private");
  await expect(save("c")).toHaveAttribute("data-save-state", "dirty");
  await row("c")
    .getByRole("button", { name: "Discard edits for C private", exact: true })
    .click();
  await expect(title("c")).toHaveValue("C");
  await expect(save("c")).toHaveAttribute("data-save-state", "saved");
  await button("History").click();
  const versions = history().getByRole("table", {
    name: "Retained versions",
    exact: true,
  });
  await expect(versions.locator("tbody tr")).toHaveCount(5);
  await expect(versions).toContainText("Explain task B");
  await expect(versions).toContainText("Two selected tasks");
  await expect(versions).toContainText("chars");
  await expect(
    history().getByRole("button", { name: "View diff", exact: true }),
  ).toHaveCount(0);
  await expect(versions.getByRole("columnheader")).toHaveText([
    "Name",
    "Time",
    "Event",
    "Changes",
    "",
  ]);
  await expect(
    versions.getByRole("button", { name: "Reset history", exact: true }),
  ).toBeVisible();
  await expect(
    versions.getByRole("button", { name: "Delete version", exact: true }),
  ).toHaveCount(5);
  await expect(history().locator("[data-history-preview]")).toHaveCount(0);
  await expect(page.locator("[data-history-pane]")).toHaveCount(0);
  await expect(title("a")).toBeHidden();
  await page.screenshot({ path: "/tmp/jocki-history-desktop.png" });
  await versions
    .locator("tbody tr")
    .filter({ hasText: "Explain task B" })
    .click();
  await expect(history().locator("[data-history-diff]")).toBeVisible();
  await expect(history().locator("[data-history-diff]")).toContainText(
    "A selected",
  );
  const checkWrapping = async (enabled = true) => {
    for (const side of ["original", "modified"]) {
      const lines = expect.poll(() =>
        history().locator(`.${side}-in-monaco-diff-editor .view-line`).count(),
      );
      if (enabled) await lines.toBeGreaterThan(10);
      else await lines.toBeLessThanOrEqual(10);
    }
  };
  const wrap = history().getByRole("button", {
    name: "Wrap lines",
    exact: true,
  });
  const checkScrollBounds = async () => {
    const overflowing = await history()
      .locator("[data-history-diff]")
      .evaluate((node) => {
        const result = [];
        for (
          let parent = node.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          if (parent.scrollHeight > parent.clientHeight + 1)
            result.push(parent.className);
          if (parent.getAttribute("role") === "dialog") break;
        }
        return result;
      });
    assert.deepEqual(
      overflowing,
      [],
      "Only the diff view should scroll vertically",
    );
    await expect(wrap).toBeInViewport();
    await expect(
      history().getByRole("button", { name: "Back to versions", exact: true }),
    ).toBeInViewport();
    await expect(
      history().getByRole("button", {
        name: "Restore version to draft",
        exact: true,
      }),
    ).toBeInViewport();
  };
  await expect(history()).not.toContainText(
    "Selected version → current saved content.",
  );
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await checkWrapping();
  await checkScrollBounds();
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await checkWrapping(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(history().locator(".monaco-diff-editor")).not.toHaveClass(
    /side-by-side/,
  );
  await checkScrollBounds();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(history().locator(".monaco-diff-editor")).toHaveClass(
    /side-by-side/,
  );
  await checkWrapping(false);
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await checkWrapping();
  await page.setViewportSize({ width: 1440, height: 600 });
  await checkScrollBounds();
  const slider = history().locator(
    ".modified-in-monaco-diff-editor .scrollbar.vertical .slider",
  );
  const sliderTop = (await slider.boundingBox()).y;
  await history().locator(".modified-in-monaco-diff-editor").hover();
  await page.mouse.wheel(0, 500);
  await expect
    .poll(async () => (await slider.boundingBox()).y)
    .toBeGreaterThan(sliderTop);
  await checkScrollBounds();
  await page.screenshot({ path: "/tmp/jocki-history-diff-short.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(versions.locator("tbody tr")).toHaveCount(1);
  await expect(versions).toContainText("Explain task B");
  await expect(
    history().getByRole("group", { name: "History setting", exact: true }),
  ).toHaveCount(0);
  await expect(
    history().getByRole("button", {
      name: "Restore version to draft",
      exact: true,
    }),
  ).toBeVisible();
  const back = history().getByRole("button", {
      name: "Back to versions",
      exact: true,
    }),
    restore = history().getByRole("button", {
      name: "Restore version to draft",
      exact: true,
    });
  await expect(back).toHaveText("");
  await expect(restore).toHaveText("");
  await expect
    .poll(
      async () => {
        const backBox = await back.boundingBox(),
          restoreBox = await restore.boundingBox(),
          wrapBox = await wrap.boundingBox();
        return (
          Math.abs(backBox.y - restoreBox.y) < 1 &&
          restoreBox.x >= backBox.x + backBox.width &&
          restoreBox.x <= backBox.x + backBox.width + 8 &&
          wrapBox.x > restoreBox.x + restoreBox.width
        );
      },
      {
        message:
          "Restore should sit directly beside Back, with wrapping on the right",
      },
    )
    .toBe(true);
  await page.screenshot({ path: "/tmp/jocki-history-diff.png" });
  await history()
    .getByRole("button", { name: "Back to versions", exact: true })
    .click();
  await expect(history().locator("[data-history-diff]")).toHaveCount(0);
  await expect(versions.locator("tbody tr")).toHaveCount(5);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    history().getByRole("group", { name: "History setting", exact: true }),
  ).toBeInViewport();
  await expect(history().locator("[data-history-preview]")).toHaveCount(0);
  assert.ok(
    await versions.evaluate(
      (node) => node.parentElement.scrollWidth > node.parentElement.clientWidth,
    ),
    "Mobile table must scroll horizontally",
  );
  await page.screenshot({ path: "/tmp/jocki-history-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await versions
    .locator("tbody tr")
    .filter({ hasText: "Explain task B" })
    .focus();
  await page.keyboard.press("Enter");
  await history()
    .getByRole("button", { name: "Restore version to draft", exact: true })
    .click();
  await expect(history()).toHaveCount(0);
  await expect(title("a")).toHaveValue("A edited");
  await expect.poll(disk).toEqual(["A selected", "B selected", "C"]);
  // Selection from before restoring stays independent; save just the restored A row.
  await save("a").click();
  await expect.poll(disk).toEqual(["A edited", "B selected", "C"]);
  await button("Discard").click();
  await page.reload();
  await openSavedWorkspace(page);
  await expect(title("a")).toHaveValue("A edited");
  await expect(title("b")).toHaveValue("B selected");
  await button("History").click();
  await expect(history()).toContainText("Two selected tasks");
  await expect(history()).toContainText("Explain task B");
  await page.keyboard.press("Escape");
  await title("a").fill("A private while deleting");
  await row("c").getByRole("button", { name: "Delete C", exact: true }).click();
  await expect(row("c")).toHaveCount(0);
  await expect.poll(disk).toEqual(["A edited", "B selected"]);
  await expect(title("a")).toHaveValue("A private while deleting");
  await expect(save("a")).toHaveAttribute("data-save-state", "dirty");
  await button("Discard").click();
  await expect(title("a")).toHaveValue("A edited");
  await title("b").fill("B removed revision");
  await hold(save("b"));
  await description.fill("Delete this version");
  await button("Save version").click();
  await title("a").fill("A later revision");
  await save("a").click();
  await expect(save("a")).toHaveAttribute("data-save-state", "saved");
  await expect.poll(disk).toEqual(["A later revision", "B removed revision"]);
  await button("History").click();
  const count = await versions.locator("tbody tr").count();
  await versions
    .locator("tbody tr")
    .filter({ hasText: "Delete this version" })
    .getByRole("button", { name: "Delete version", exact: true })
    .click();
  await expect(history().locator("[data-history-diff]")).toHaveCount(0);
  await expect(versions.locator("tbody tr")).toHaveCount(count - 1);
  await expect.poll(disk).toEqual(["A later revision", "B selected"]);
  await versions
    .getByRole("button", { name: "Reset history", exact: true })
    .click();
  await expect(versions.locator("tbody tr")).toHaveCount(1);
  await expect(versions).toContainText("File created");
  await page.keyboard.press("Escape");
  await expect(title("a")).toHaveValue("A later revision");
  await expect(title("b")).toHaveValue("B selected");
  await expect(save("a")).toHaveAttribute("data-save-state", "saved");
  await page.reload();
  await openSavedWorkspace(page);
  await button("History").click();
  await expect(versions.locator("tbody tr")).toHaveCount(1);
  await expect.poll(disk).toEqual(["A later revision", "B selected"]);
  assert.deepEqual(errors, []);
  console.log(
    "Verified per-task save/discard states, held descriptions, selected bulk saves, durable row isolation, overview/diff navigation, restore drafts, mobile horizontal tables and restart.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-history-tasks-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
