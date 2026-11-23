import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:4195");
  const join = () =>
    page.getByRole("button", { name: "Join", exact: true }).click();
  const relay = () =>
    page.getByRole("combobox", { name: "Sync relay", exact: true });
  const save = async () => {
    const loaded = page.waitForEvent("load");
    await page
      .getByRole("button", { name: "Save and reload", exact: true })
      .click();
    await loaded;
    await join();
  };
  await join();
  const identity = JSON.parse(
    await page
      .getByRole("textbox", { name: "Device request", exact: true })
      .inputValue(),
  ).identity.id;
  await expect(relay()).toHaveValue("automerge");
  await expect(
    page.getByText("wss://keyhive.sync.automerge.org", { exact: true }),
  ).toBeVisible();
  await relay().selectOption("custom");
  await page.getByLabel("Connection name", { exact: true }).fill("Saved relay");
  await page
    .getByLabel("Relay WebSocket endpoints", { exact: true })
    .fill("wss://keyhive.sync.automerge.org");
  await page
    .getByRole("combobox", { name: "Relay identity", exact: true })
    .selectOption("keyhive");
  await save();
  await expect(page.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Saved relay",
  );
  const savedId = await relay().inputValue();
  await expect(relay().locator('option[value="offline"]')).toHaveCount(0);
  await relay().selectOption(savedId);
  await expect(page.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Saved relay",
  );
  await relay().selectOption("automerge");
  await save();
  await expect(relay()).toHaveValue("automerge");
  await relay().selectOption(savedId);
  await expect(
    page.getByLabel("Relay WebSocket endpoints", { exact: true }),
  ).toHaveValue("wss://keyhive.sync.automerge.org");
  await relay().selectOption("custom");
  await page
    .getByRole("button", { name: "Save and reload", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("WebSocket endpoint");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("jocki.automerge.connection"))
          .selected,
    ),
  ).toBe("automerge");
  expect(
    JSON.parse(
      await page
        .getByRole("textbox", { name: "Device request", exact: true })
        .inputValue(),
    ).identity.id,
  ).toBe(identity);
  console.log(
    "Default relay, saved connections, switching, reload persistence and invalid-input handling passed.",
  );
} finally {
  await browser.close();
}
