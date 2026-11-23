import { webkit, expect as baseExpect } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 60000 });
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const width of [320, 390]) {
  const directory = await mkdtemp(join(tmpdir(), "jocki-mobile-form-"));
  const context = await webkit.launchPersistentContext(directory, {
    headless: true,
    viewport: { width, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.copiedRequest = value;
          },
        },
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      console.error("Mobile page error:", error.message),
    );
    page.setDefaultTimeout(60000);
    await page.goto(process.env.TEST_APP_URL ?? "http://127.0.0.1:58630");
    await page.getByRole("button", { name: "Join", exact: true }).click();
    const request = page.getByRole("textbox", {
      name: "Device request",
      exact: true,
    });
    await expect(request).not.toHaveValue("");
    const metrics = await request.evaluate((input) => ({
      tag: input.tagName,
      height: input.getBoundingClientRect().height,
      right: input.getBoundingClientRect().right,
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      multiline: input.value.includes("\n"),
    }));
    expect(metrics.tag).toBe("INPUT");
    expect(metrics.height).toBeLessThanOrEqual(44);
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.width);
    expect(metrics.right).toBeLessThanOrEqual(metrics.width);
    expect(metrics.multiline).toBe(false);
    await expect(
      page.getByText("Save workspace to", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Save as on this device" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Copy device request" }).click();
    expect(await page.evaluate(() => JSON.parse(window.copiedRequest))).toEqual(
      JSON.parse(await request.inputValue()),
    );
    await page.screenshot({
      path: `/tmp/jocki-mobile-join-${width}.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(
  "320px/390px mobile WebKit: one-line bounded request, full copy and single-destination form passed.",
);
