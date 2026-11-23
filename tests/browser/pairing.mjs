import { chromium, expect as baseExpect } from "@playwright/test";
import { createWorkspace, navigate } from "./navigation-helpers.mjs";

const expect = baseExpect.configure({ timeout: 60000 });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const first = await browser.newContext(),
    second = await browser.newContext(),
    writer = await first.newPage(),
    phone = await second.newPage();
  for (const page of [writer, phone]) {
    page.setDefaultTimeout(60000);
    await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58620");
  }
  await createWorkspace(writer, "Pairing layout");
  await navigate(writer, "Devices");
  await phone.getByRole("button", { name: "Join", exact: true }).click();
  await phone
    .getByRole("textbox", { name: "Device name", exact: true })
    .fill("Test phone");
  const request = phone.getByRole("textbox", {
    name: "Device request",
    exact: true,
  });
  await expect(request).not.toHaveValue("");
  const value = await request.inputValue(),
    json = JSON.parse(value);
  expect(json.name).toBe("Test phone");
  expect(json.access).toBe("write");
  expect(json).not.toHaveProperty("format");
  expect(json).not.toHaveProperty("id");
  expect(Object.keys(json.publicKey)).toEqual(["x", "y"]);
  await writer.getByRole("button", { name: "Add device", exact: true }).click();
  await writer
    .getByRole("textbox", { name: "Device request", exact: true })
    .fill(value);
  await expect(
    writer.getByText(
      "Test phone is requesting write access to Pairing layout.",
    ),
  ).toBeVisible();
  await writer.getByRole("button", { name: "Approve", exact: true }).click();
  const invitation = writer.getByRole("textbox", {
    name: "Encrypted invitation",
    exact: true,
  });
  await expect(invitation).not.toHaveValue("");
  const code = await invitation.inputValue();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 375, height: 667 },
    { width: 844, height: 390 },
    { width: 320, height: 320 },
  ]) {
    await writer.setViewportSize(viewport);
    const dialog = writer.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Exercise an invitation that has grown after many approved devices too.
    await invitation.evaluate((element, text) => {
      element.value = text.repeat(200);
    }, code);
    await expect(async () => {
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    }).toPass();
    await writer
      .getByRole("button", { name: "Copy invitation", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      writer.getByRole("button", { name: "Copy invitation", exact: true }),
    ).toBeInViewport();
  }
  await writer.keyboard.press("Escape");
  await phone
    .getByRole("textbox", { name: "Workspace invitation", exact: true })
    .fill(code);
  await phone
    .getByLabel("Save as on this device", { exact: true })
    .fill("Joined planner");
  await phone
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  await expect(
    phone.getByRole("navigation", { name: "Current page" }),
  ).toContainText("Pairing layout");
  await navigate(phone, "Devices");
  await expect(
    phone.getByRole("button", { name: "Add device", exact: true }),
  ).toBeVisible();
  console.log(
    "Plain JSON request, Write approval/join, and invitation viewport limits passed.",
  );
} finally {
  await browser.close();
}
