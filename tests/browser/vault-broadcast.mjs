import { chromium, expect } from "@playwright/test";
import { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Repository } from "../../packages/core/repository.ts";
import { TestRepoStorage } from "../fixtures/repository.ts";
import { MemoryStorage } from "../../packages/storage/index.ts";
import {
  createWorkspace,
  createVaultFile,
  skipVaultSetup,
} from "./vault-ui-helpers.mjs";
const storage = new MemoryStorage();
const recipient = await Repository.open({
  documents: new TestRepoStorage(storage, "docs"),
  identity: new TestRepoStorage(storage, "identity"),
});
const relays = [
  new WebSocketServer({ host: "127.0.0.1", port: 0 }),
  new WebSocketServer({ host: "127.0.0.1", port: 0 }),
];
for (const relay of relays)
  if (!relay.address()) await once(relay, "listening");
const endpoints = relays.map(
  (relay) => `ws://127.0.0.1:${relay.address().port}`,
);
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ endpoints }) => {
      localStorage.setItem(
        "jocki.automerge.connection",
        JSON.stringify({
          broadcast: false,
          selected: "one",
          endpoints: [endpoints[0]],
          syncServer: "keyhive",
          saved: endpoints.map((endpoint, index) => ({
            id: index ? "two" : "one",
            name: index ? "Relay two" : "Relay one",
            endpoints: [endpoint],
            syncServer: "keyhive",
          })),
        }),
      );
      const Channel = window.BroadcastChannel;
      window.testChannels = 0;
      window.BroadcastChannel = class extends Channel {
        constructor(...args) {
          super(...args);
          window.testChannels++;
        }
        close() {
          window.testChannels--;
          super.close();
        }
      };
    },
    { endpoints },
  );
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const popup = () =>
    page.getByRole("dialog", { name: "Sharing", exact: true });
  await createWorkspace(page);
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Broadcast test");
  await button("Create").click();
  await skipVaultSetup(page);
  await createVaultFile(page, "Broadcast test", "note.md");
  await page
    .locator("[data-document-toolbar]")
    .filter({ visible: true })
    .getByRole("button", { name: "Enable sharing", exact: true })
    .click();
  await expect(
    popup().getByRole("switch", {
      name: "Broadcast all sharings",
      exact: true,
    }),
  ).not.toBeChecked();
  assert.equal(relays[0].clients.size, 0);
  assert.equal(await page.evaluate(() => window.testChannels), 0);
  await popup()
    .getByRole("switch", { name: "Broadcast all sharings", exact: true })
    .click();
  await expect.poll(() => relays[0].clients.size).toBe(1);
  await expect.poll(() => page.evaluate(() => window.testChannels)).toBe(1);
  await popup()
    .getByRole("textbox", { name: "Recipient contact card", exact: true })
    .fill(recipient.contactCard);
  await popup()
    .getByRole("button", { name: "Add access", exact: true })
    .click();
  const rowSwitch = () =>
    page.getByRole("switch", { name: "Broadcast file: note.md", exact: true });
  await expect(rowSwitch()).toBeChecked();
  await expect(popup().locator("[data-scope-current]")).toHaveAttribute(
    "data-scope-count",
    "1",
  );
  await rowSwitch().click();
  await expect(rowSwitch()).not.toBeChecked();
  await expect(popup().locator("[data-scope-current]")).toHaveAttribute(
    "data-scope-count",
    "0",
  );
  await expect(popup()).toBeVisible();
  await popup()
    .getByRole("switch", { name: "Broadcast all sharings", exact: true })
    .click();
  await expect.poll(() => relays[0].clients.size).toBe(0);
  await expect.poll(() => page.evaluate(() => window.testChannels)).toBe(0);
  await expect(rowSwitch()).toBeVisible();
  await expect(rowSwitch()).toBeDisabled();
  await popup()
    .getByRole("switch", { name: "Broadcast all sharings", exact: true })
    .click();
  await expect(rowSwitch()).not.toBeChecked();
  await expect(rowSwitch()).toBeEnabled();
  await rowSwitch().click();
  await expect(rowSwitch()).toBeChecked();
  const sharingSetting = popup().getByRole("group", {
    name: "Sharing setting",
    exact: true,
  });
  await sharingSetting
    .getByRole("button", { name: "Disabled", exact: true })
    .click();
  await expect(
    sharingSetting.getByRole("button", { name: "Disabled", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(popup().locator("[data-scope-current]")).toHaveAttribute(
    "data-scope-count",
    "0",
  );
  await expect(popup()).toContainText("Sharing is disabled.");
  await expect(
    popup().getByRole("table", { name: "Active shares", exact: true }),
  ).toHaveCount(0);
  await expect(
    popup().getByRole("textbox", {
      name: "Recipient contact card",
      exact: true,
    }),
  ).toHaveCount(0);
  await sharingSetting
    .getByRole("button", { name: "Unset", exact: true })
    .click();
  await expect(
    sharingSetting.getByRole("button", { name: "Unset", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(popup()).toContainText("No shares defined here.");
  await expect(
    popup().getByRole("table", { name: "Active shares", exact: true }),
  ).toHaveCount(0);
  await sharingSetting
    .getByRole("button", { name: "Enabled", exact: true })
    .click();
  await expect(rowSwitch()).toBeChecked();
  await expect(popup().locator("[data-scope-current]")).toHaveAttribute(
    "data-scope-count",
    "1",
  );
  await page.keyboard.press("Escape");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await editor.fill("Unsaved draft survives changing the relay");
  await button("Settings").click();
  await page
    .getByRole("navigation", { name: "Settings pages", exact: true })
    .getByRole("button", { name: "Sharing", exact: true })
    .click();
  const connection = page.getByRole("combobox", {
    name: "Sync connection",
    exact: true,
  });
  await expect(connection).toContainText("Relay one");
  await connection.click();
  await expect(
    page.getByRole("option", { name: "Offline", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("option", { name: "Relay two", exact: true }).click();
  await expect(connection).toContainText("Relay two");
  await expect.poll(() => relays[0].clients.size).toBe(0);
  await expect.poll(() => relays[1].clients.size).toBe(1);
  await expect(rowSwitch()).toBeChecked();
  await page
    .getByRole("switch", { name: "Broadcast all sharings", exact: true })
    .click();
  await expect.poll(() => relays[1].clients.size).toBe(0);
  await expect.poll(() => page.evaluate(() => window.testChannels)).toBe(0);
  await expect(rowSwitch()).toBeVisible();
  await page.screenshot({
    path: "/tmp/jocki-broadcast-table.png",
    fullPage: true,
  });
  await button("note.md").click();
  await expect(editor).toHaveText("Unsaved draft survives changing the relay");
  await expect(button("Save")).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log(
    "Verified default Broadcast off, per-share pause and resume, row choices retained across the master toggle, relay and local-tab connections stop, live relay switching preserves shares and drafts, and no Offline option.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-broadcast-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
  await recipient.close();
  for (const relay of relays) {
    for (const client of relay.clients) client.terminate();
    await new Promise((resolve) => relay.close(resolve));
  }
}
