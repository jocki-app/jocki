import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  createWorkspace,
  createVaultFile,
  skipVaultSetup,
  writeVaultFiles,
} from "./vault-ui-helpers.mjs";
const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    localStorage.setItem(
      "jocki.automerge.connection",
      JSON.stringify({
        selected: "automerge",
        broadcast: false,
        saved: [],
        endpoints: ["wss://keyhive.sync.automerge.org"],
        syncServer: "keyhive",
      }),
    ),
  );
  await page.goto(process.env.JOCKI_TEST_URL ?? "http://127.0.0.1:5187");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const popup = (name = "History") =>
    page.getByRole("dialog", { name, exact: true });
  const setting = (feature = "History") =>
    popup(feature).getByRole("group", {
      name: feature + " setting",
      exact: true,
    });
  const choose = async (value, feature = "History") => {
    const control = setting(feature).getByRole("button", {
      name: value,
      exact: true,
    });
    await control.click();
    await expect(control).toHaveAttribute("aria-pressed", "true");
  };
  const node = (path, feature = "History") =>
    popup(feature).locator(`[data-scope-tree] [data-scope-path="${path}"]`);
  const loadLevels = async (count, feature = "History") => {
    for (let index = 0; index < count; index++) {
      await popup(feature)
        .getByRole("button", { name: "Load next level", exact: true })
        .click();
    }
  };
  const paintedColors = (cell) =>
    cell.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const rgba = (value) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const style = getComputedStyle(element);
      return {
        background: rgba(style.backgroundColor),
        text: rgba(style.color),
      };
    });
  const luminance = (rgb) =>
    rgb
      .slice(0, 3)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce(
        (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
        0,
      );
  const contrast = (a, b) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) /
    (Math.min(luminance(a), luminance(b)) + 0.05);
  const verifyCurrentLabel = async (cell) => {
    const result = await cell.evaluate((element) => {
      const geometry = () => {
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height];
      };
      const label = element.querySelector(".vault-scope-label");
      const iconStroke = parseFloat(
        getComputedStyle(element.querySelector("svg")).strokeWidth,
      );
      const before = geometry();
      const weight = getComputedStyle(label).fontWeight;
      const fill = getComputedStyle(element).backgroundColor;
      element.removeAttribute("data-scope-current");
      const after = geometry();
      const regularWeight = getComputedStyle(label).fontWeight;
      const inactiveFill = getComputedStyle(element).backgroundColor;
      element.setAttribute("data-scope-current", "true");
      return {
        before,
        after,
        weight,
        regularWeight,
        fill,
        inactiveFill,
        iconStroke,
      };
    });
    assert.ok(
      Number(result.weight) >= 700 && Number(result.regularWeight) < 700,
      "Only the current label must be bold",
    );
    assert.ok(
      result.iconStroke >= 3,
      "The current item's icon must have a bolder stroke",
    );
    assert.deepEqual(
      result.before,
      result.after,
      "Bold text must not change the cell's position or dimensions",
    );
    assert.equal(
      result.fill,
      result.inactiveFill,
      "Current must not change its setting's fill",
    );
  };
  const verifyRowCorners = async (feature = "History") => {
    const result = await popup(feature)
      .locator("[data-scope-cake]")
      .evaluate((element) => {
        const grid = element.querySelector("[data-scope-cells]");
        const cells = [...grid.querySelectorAll(".vault-scope-cell")];
        const bottom = Math.max(
          ...cells.map((cell) => Number(cell.parentElement.dataset.scopeLayer)),
        );
        const last = cells.filter(
          (cell) => Number(cell.parentElement.dataset.scopeLayer) === bottom,
        );
        const corners = cells.map((cell) => {
          const style = getComputedStyle(cell);
          return {
            left: parseFloat(style.borderBottomLeftRadius),
            right: parseFloat(style.borderBottomRightRadius),
            first: cell === last[0],
            last: cell === last.at(-1),
          };
        });
        const more = element.querySelector('[aria-label="Load next level"]');
        return {
          corners,
          outerRadius: parseFloat(getComputedStyle(element).borderRadius),
          topRadius: parseFloat(getComputedStyle(grid).borderTopLeftRadius),
          ellipsisOutside:
            !more ||
            (!grid.contains(more) &&
              more.getBoundingClientRect().top >=
                grid.getBoundingClientRect().bottom - 1),
        };
      });
    assert.equal(
      result.outerRadius,
      0,
      "The scroll container must not own the rounded corners",
    );
    assert.ok(result.topRadius > 0, "Keep the outside top corners rounded");
    for (const cell of result.corners) {
      assert.equal(
        cell.left > 0,
        cell.first,
        "Only the first cell in the deepest visible row has the bottom-left corner",
      );
      assert.equal(
        cell.right > 0,
        cell.last,
        "Only the last cell in the deepest visible row has the bottom-right corner",
      );
    }
    assert.ok(
      result.ellipsisOutside,
      "The ellipsis must sit below and outside the rounded file/folder cells",
    );
  };
  const verifyBottomHierarchy = async (feature = "History") => {
    const difference = await popup(feature)
      .locator("[data-feature-overview]")
      .evaluate((element) => {
        const container = element.getBoundingClientRect();
        const tree = element
          .querySelector("[data-scope-tree]")
          .getBoundingClientRect();
        return Math.abs(container.bottom - tree.bottom);
      });
    assert.ok(
      difference < 1,
      "The shared hierarchy must stay at the bottom of the overview",
    );
    await verifyRowCorners(feature);
    await expect(popup(feature).getByLabel("Hierarchy legend")).toContainText(
      feature === "History" ? "Rollback versions" : "Effective shares",
    );
    await expect(
      popup(feature).locator("[data-scope-quantities]"),
    ).toHaveAttribute("aria-busy", "false");
    assert.equal(
      await popup(feature)
        .locator("[data-scope-cake]")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)",
      "Empty hierarchy space must be transparent",
    );
  };
  const verifyPalette = async (dark) => {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      dark,
    );
    await page.mouse.move(5, 5);
    // Theme changes animate the same color properties as hover.
    await page.waitForTimeout(200);
    const current = node("");
    const enabled = node("Folder/one.md");
    const inherited = node("notes.md");
    const disabled = node("Folder");
    const inheritedDisabled = node("Folder/Deep/two.md");
    await expect(inherited).toHaveAttribute("data-scope-tone", "enabled");
    await expect(inheritedDisabled).toHaveAttribute(
      "data-scope-tone",
      "disabled",
    );
    await expect(popup().locator("[data-scope-quantities]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    const cells = [current, enabled, inherited, disabled, inheritedDisabled];
    const colors = [];
    for (const cell of cells) {
      const count = Number(await cell.getAttribute("data-scope-count"));
      const state = await cell.getAttribute("data-scope-state");
      await expect(cell.locator("[data-scope-setting]")).toHaveAttribute(
        "data-scope-setting",
        ["enabled", "disabled"].includes(state) ? state : "unset",
      );
      const color = await paintedColors(cell);
      const tone = await cell.getAttribute("data-scope-tone");
      colors.push({ ...color, count, tone });
      const { background, text } = color;
      assert.ok(
        contrast(background, text) >= 4.5,
        `${dark ? "Dark" : "Light"} mode text must remain readable`,
      );
      if (tone === "disabled")
        assert.ok(
          background[0] > background[1] && background[0] > background[2],
          "Disabled policies must be red regardless of retained counts",
        );
      else if (count > 0)
        assert.ok(
          background[1] > background[0] && background[1] > background[2],
          "Positive counts must remain green independently of policy icons",
        );
      else
        assert.ok(
          Math.max(...background.slice(0, 3)) -
            Math.min(...background.slice(0, 3)) <
            3,
          "Zero must remain neutral grey",
        );
      await cell.hover();
      await expect
        .poll(async () => luminance((await paintedColors(cell)).background))
        .toBeLessThan(luminance(background));
      assert.ok(
        contrast((await paintedColors(cell)).background, text) >= 4.5,
        "Hovered text must remain readable",
      );
      await page.mouse.move(5, 5);
      await page.waitForTimeout(200);
    }
    const positive = colors
      .filter((color) => color.count > 0 && color.tone !== "disabled")
      .sort((a, b) => a.count - b.count);
    assert.ok(positive.length > 1);
    const red = colors.filter((color) => color.tone === "disabled");
    assert.ok(red.length >= 2);
    const redStrength = (color) =>
      color.background[0] - Math.min(color.background[1], color.background[2]);
    assert.ok(
      redStrength(red[0]) > redStrength(red[1]),
      "Explicit Disabled must be stronger red than inherited Disabled",
    );
    const strength = (color) =>
      Math.max(...color.background.slice(0, 3)) -
      Math.min(...color.background.slice(0, 3));
    for (let i = 1; i < positive.length; i++) {
      if (positive[i].count === positive[i - 1].count)
        assert.deepEqual(
          positive[i].background,
          positive[i - 1].background,
          "Equal counts use identical fills",
        );
      else
        assert.ok(
          strength(positive[i]) > strength(positive[i - 1]),
          "Larger counts must be a stronger green",
        );
    }
    // Check both bounded endpoints (and a midpoint) against the actual theme background.
    const scale = await current.evaluate((element) => {
      const saved = element.getAttribute("style"),
        count = element.dataset.scopeCount;
      const samples = [0, 0.5, 1].map((ratio) => {
        element.dataset.scopeCount = "1";
        element.style.setProperty("--scope-ratio", String(ratio));
        const style = getComputedStyle(element);
        const canvas = document.createElement("canvas"),
          ctx = canvas.getContext("2d");
        canvas.width = canvas.height = 1;
        const rgb = (value) => {
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        return {
          background: rgb(style.getPropertyValue("--scope-background")),
          text: rgb(style.color),
          popup: rgb(style.getPropertyValue("--popover")),
        };
      });
      element.setAttribute("style", saved);
      element.dataset.scopeCount = count;
      return samples;
    });
    for (const sample of scale) {
      assert.ok(
        contrast(sample.background, sample.text) >= 4.5,
        "Scale endpoints and midpoint must have readable text",
      );
      assert.ok(
        Math.max(
          ...sample.background
            .slice(0, 3)
            .map((value, index) => Math.abs(value - sample.popup[index])),
        ) >= 20,
        "Even the lightest tint must remain visibly separate from its theme background",
      );
    }
    await verifyCurrentLabel(current);
    await page.screenshot({
      path: `/tmp/jocki-hierarchy-${dark ? "dark" : "light"}.png`,
    });
  };
  const openScope = async (name, feature = "History", enabled = false) => {
    await button("Actions for " + name).click();
    await page
      .getByRole("menuitem", {
        name: enabled ? feature : "Enable " + feature.toLowerCase(),
        exact: true,
      })
      .click();
    await expect(popup(feature)).toBeVisible();
  };
  await createWorkspace(page);
  await button("Enable history").click();
  await verifyCurrentLabel(popup().locator("[data-scope-current]"));
  await expect(
    setting().getByRole("button", { name: "Enabled", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await popup()
    .getByRole("button", { name: "About history", exact: true })
    .hover();
  await expect(page.getByRole("tooltip")).toContainText("Unset inherits");
  await page.mouse.move(5, 5);
  await popup().locator("[data-history-version]").first().click();
  await expect(popup().locator("[data-history-detail]")).toBeVisible();
  await expect(setting()).toHaveCount(0);
  await popup()
    .getByRole("button", { name: "Back to versions", exact: true })
    .click();
  await choose("Unset");
  await page.keyboard.press("Escape");
  await button("Create browser vault").click();
  await page.getByLabel("Name", { exact: true }).fill("Features");
  await button("Create").click();
  await skipVaultSetup(page);
  await createVaultFile(page, "Features", "notes.md");
  await writeVaultFiles(
    page,
    "Features",
    [
      { name: "one.md", buffer: Buffer.from("Folder note") },
      { name: "Deep/two.md", buffer: Buffer.from("Nested note") },
      {
        name:
          "Tall/" +
          Array.from({ length: 12 }, (_, index) => `Level${index}`).join("/") +
          "/bottom.md",
        buffer: Buffer.from("Deep note"),
      },
    ],
    "Folder",
  );
  await openScope("Features");
  await expect(node("")).toHaveAttribute("data-scope-state", "enabled");
  await expect(node("Folder")).toHaveCount(0);
  await verifyRowCorners();
  await verifyCurrentLabel(node(""));
  const more = popup().getByRole("button", {
    name: "Load next level",
    exact: true,
  });
  const moreGeometry = await more.evaluate((element) => {
    const button = element.getBoundingClientRect();
    const row = element.parentElement.getBoundingClientRect();
    const cell = element
      .closest("[data-scope-tree]")
      .querySelector("[data-scope-current]")
      .getBoundingClientRect();
    return {
      width: button.width,
      height: button.height,
      rowWidth: row.width,
      rowHeight: row.height,
      cellHeight: cell.height,
    };
  });
  assert.ok(
    Math.abs(moreGeometry.height - moreGeometry.cellHeight) < 0.01,
    "The ellipsis button must have the same height as a hierarchy row",
  );
  assert.ok(
    Math.abs(moreGeometry.width - moreGeometry.rowWidth) < 0.01,
    "The ellipsis button must fill the row width",
  );
  await more.hover();
  assert.equal(
    await more.evaluate(
      (el) => getComputedStyle(el.parentElement).backgroundColor,
    ),
    "rgba(0, 0, 0, 0)",
    "The button's surrounding container must stay transparent on hover",
  );
  await expect(popup().locator("[data-scope-quantities]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const initialRatio = await node("").evaluate((el) =>
    el.style.getPropertyValue("--scope-ratio"),
  );
  await loadLevels(1);
  await verifyRowCorners();
  await expect(node("Folder/one.md")).toHaveCount(0);
  await expect(
    popup().getByRole("button", { name: "Load next level", exact: true }),
  ).toHaveText("");
  await loadLevels(2);
  assert.equal(
    await node("").evaluate((el) => el.style.getPropertyValue("--scope-ratio")),
    initialRatio,
    "Loading hidden levels must not rescale the colors",
  );
  await expect(node("notes.md")).toHaveAttribute(
    "data-scope-state",
    "inherited",
  );
  await expect(node("Folder")).toHaveAttribute("data-scope-state", "inherited");
  await expect(
    popup().locator('[data-scope-layer="0"] [data-scope-path]'),
  ).toHaveCount(1);
  await expect(
    popup().locator('[data-scope-layer="1"] [data-scope-path="Folder"]'),
  ).toBeVisible();
  await expect(
    popup().locator('[data-scope-layer="2"] [data-scope-path="Folder/one.md"]'),
  ).toBeVisible();
  await expect(
    popup().locator(
      '[data-scope-layer="3"] [data-scope-path="Folder/Deep/two.md"]',
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // The inherited folder opens History without creating an explicit Enabled override.
  await openScope("Folder", "History", true);
  await expect(
    setting().getByRole("button", { name: "Unset", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(node("Folder")).toHaveAttribute("aria-current", "true");
  await expect(
    popup().locator('[data-scope-unit="workspace"] [data-workspace-icon]'),
  ).toHaveCount(1);
  await expect(popup().locator("[data-scope-context]")).toHaveCount(2);
  await expect(
    popup().locator('[data-scope-context] [data-scope-path=""]'),
  ).toContainText("Features");
  await expect(node("notes.md")).toHaveCount(0);
  await choose("Disabled");
  await expect(popup().locator("[data-scope-context]")).toHaveCount(2);
  await expect(node("")).toHaveAttribute("data-scope-tone", "enabled");
  await loadLevels(2);
  await expect(node("Folder")).toHaveAttribute("data-scope-state", "disabled");
  await expect(node("Folder/one.md")).toHaveAttribute(
    "data-scope-state",
    "inherited",
  );
  // Inspecting a disabled child does not enable it; explicit Enabled can override its parent.
  await node("Folder/one.md").click();
  await expect(popup().getByRole("button", { name: /Back/ })).toHaveCount(0);
  await expect(node("Folder/one.md")).toHaveAttribute("aria-current", "true");
  await expect(
    setting().getByRole("button", { name: "Unset", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(popup()).toContainText("No retained versions");
  await choose("Enabled");
  await expect(popup().locator("[data-scope-context]")).toHaveCount(3);
  await expect(node("")).toHaveAttribute("data-scope-tone", "enabled");
  await expect(node("Folder")).toHaveAttribute("data-scope-tone", "disabled");
  await expect(node("Folder/one.md")).toHaveAttribute(
    "data-scope-state",
    "enabled",
  );
  await page.keyboard.press("Escape");
  await openScope("Features", "History", true);
  await loadLevels(3);
  await expect(node("Folder")).toHaveAttribute("data-scope-state", "disabled");
  await expect(node("Folder/one.md")).toHaveAttribute(
    "data-scope-state",
    "enabled",
  );
  await expect(node("Folder/Deep/two.md")).toHaveAttribute(
    "data-scope-state",
    "inherited",
  );
  await verifyBottomHierarchy();
  await verifyPalette(false);
  await verifyPalette(true);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await node("Folder").click();
  await expect(node("Folder/one.md")).toHaveCount(0);
  await expect(popup().getByRole("button", { name: /Back/ })).toHaveCount(0);
  await choose("Unset");
  await loadLevels(2);
  await expect(node("Folder")).toHaveAttribute("data-scope-state", "inherited");
  await expect(node("Folder/Deep/two.md")).toHaveAttribute(
    "data-scope-state",
    "inherited",
  );
  const cake = await popup()
    .locator("[data-scope-cake]")
    .evaluate((element) => {
      const cells = [...element.querySelectorAll("[data-scope-path]")];
      const first = element
        .querySelector("[data-scope-current]")
        .getBoundingClientRect();
      const left = element
        .querySelector('[data-scope-path="Folder/Deep"]')
        .getBoundingClientRect();
      const right = element
        .querySelector('[data-scope-path="Folder/Tall"]')
        .getBoundingClientRect();
      const nested = element
        .querySelector('[data-scope-path="Folder/Deep/two.md"]')
        .getBoundingClientRect();
      return {
        topRadius: parseFloat(
          getComputedStyle(element.querySelector("[data-scope-cells]"))
            .borderTopLeftRadius,
        ),
        squareCells: cells.every(
          (cell) =>
            getComputedStyle(cell).borderTopLeftRadius === "0px" &&
            getComputedStyle(cell).borderTopWidth === "0px",
        ),
        rowGap: Math.abs(first.bottom - left.top),
        columnGap: Math.abs(left.right - right.left),
        childTop: Math.abs(left.bottom - nested.top),
        childLeft: Math.abs(left.left - nested.left),
        childRight: Math.abs(left.right - nested.right),
      };
    });
  assert.ok(
    cake.topRadius > 0 &&
      cake.squareCells &&
      cake.rowGap < 1 &&
      cake.columnGap < 1 &&
      cake.childTop < 1 &&
      cake.childLeft < 1 &&
      cake.childRight < 1,
    "Children must sit directly under their parent; cells must touch, with only the outer corners rounded",
  );
  const historySize = await popup().boundingBox();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  await verifyCurrentLabel(node("Folder"));
  await verifyRowCorners();
  await page.screenshot({ path: "/tmp/jocki-scope-history.png" });
  const overviewTop = (
    await popup().locator("[data-history-versions]").boundingBox()
  ).y;
  for (let count = 0; count < 20; count++) {
    const more = popup().getByRole("button", {
      name: "Load next level",
      exact: true,
    });
    if (!(await more.count())) break;
    await more.click();
  }
  await expect(
    popup().getByRole("button", { name: "Load next level", exact: true }),
  ).toHaveCount(0);
  const independent = await popup()
    .locator("[data-scope-cake]")
    .evaluate((element) => ({
      scrolls: element.scrollHeight > element.clientHeight,
      overflow: getComputedStyle(element).overflowY,
    }));
  assert.ok(
    independent.scrolls && independent.overflow === "auto",
    "The hierarchy must scroll independently",
  );
  assert.ok(
    Math.abs(
      (await popup().locator("[data-history-versions]").boundingBox()).y -
        overviewTop,
    ) < 1,
    "Loading and scrolling hierarchy levels must not move the versions header",
  );
  await page.keyboard.press("Escape");
  await openScope("notes.md", "History", true);
  await expect(
    setting().getByRole("button", { name: "Unset", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(node("notes.md")).toHaveAttribute(
    "data-scope-state",
    "inherited",
  );
  await expect(node("notes.md")).toHaveAttribute("aria-current", "true");
  await expect(node("notes.md")).toContainText("Current");
  await verifyCurrentLabel(node("notes.md"));
  await expect(popup().locator("[data-scope-quantities]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  assert.equal(
    Number(await node("notes.md").getAttribute("data-scope-count")),
    await popup().locator("[data-history-version]").count(),
    "The hierarchy count must match the rollback versions table",
  );
  const labelGap = await node("notes.md").evaluate((el) => {
    const [label, current] = el.querySelectorAll("span");
    return (
      current.getBoundingClientRect().left - label.getBoundingClientRect().right
    );
  });
  assert.ok(
    labelGap >= 0 && labelGap < 36,
    "Current must follow the item label and its policy icon",
  );
  await expect(
    popup().locator('[data-scope-context] [data-scope-path=""]'),
  ).toContainText("Features");
  await expect(node("Folder")).toHaveCount(0);
  // File history can open its ancestor using the same fresh-popup navigation.
  await node("").click();
  await expect(node("")).toHaveAttribute("aria-current", "true");
  await expect(node("notes.md")).toHaveCount(0);
  await expect(popup().getByRole("button", { name: /Back/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openScope("Features", "Sharing");
  // Wait for the dialog's entrance scale animation before comparing dimensions.
  await expect
    .poll(async () =>
      Math.abs(
        (await popup("Sharing").boundingBox()).width - historySize.width,
      ),
    )
    .toBeLessThan(1);
  const sharingSize = await popup("Sharing").boundingBox();
  assert.ok(
    Math.abs(sharingSize.height - historySize.height) < 1,
    "Sharing and History heights must match",
  );
  await loadLevels(3, "Sharing");
  await expect(popup("Sharing")).not.toContainText("Share this vault");
  await expect(popup("Sharing")).not.toContainText(
    "Broadcast is off for this app",
  );
  await expect(
    popup("Sharing")
      .getByRole("table", { name: "Active shares", exact: true })
      .locator("tbody tr")
      .first(),
  ).toHaveAttribute("data-add-access", "true");
  await expect(
    popup("Sharing")
      .locator("[data-add-access]")
      .getByRole("textbox", { name: "Recipient contact card", exact: true }),
  ).toBeVisible();
  await expect(node("Folder", "Sharing")).toHaveAttribute(
    "data-scope-state",
    "inherited",
  );
  await node("Folder", "Sharing").click();
  await expect(node("Folder/one.md", "Sharing")).toHaveCount(0);
  await expect(
    popup("Sharing").getByRole("button", { name: /Back/ }),
  ).toHaveCount(0);
  await choose("Disabled", "Sharing");
  await expect(
    popup("Sharing").locator('[data-scope-context] [data-scope-path=""]'),
  ).toContainText("Features");
  await expect(node("Folder", "Sharing")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(node("notes.md", "Sharing")).toHaveCount(0);
  await loadLevels(2, "Sharing");
  await expect(node("Folder", "Sharing")).toHaveAttribute(
    "data-scope-state",
    "disabled",
  );
  await expect(node("Folder/Deep/two.md", "Sharing")).toHaveAttribute(
    "data-scope-state",
    "inherited",
  );
  await popup("Sharing")
    .getByRole("button", { name: "About sharing", exact: true })
    .hover();
  await expect(page.getByRole("tooltip")).toContainText("Broadcast switches");
  await page.mouse.move(5, 5);
  await verifyBottomHierarchy("Sharing");
  await page.screenshot({ path: "/tmp/jocki-scope-sharing.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(setting("Sharing")).toBeInViewport();
  const controls = await setting("Sharing").boundingBox();
  assert.ok(
    controls.x >= 0 && controls.x + controls.width <= 390,
    "All three settings must fit on mobile",
  );
  assert.equal(
    await popup("Sharing").evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
    false,
    "Only the sharing table should scroll horizontally",
  );
  await verifyBottomHierarchy("Sharing");
  await page.screenshot({ path: "/tmp/jocki-scope-sharing-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "Verified shared bottom hierarchy layout, quantity-based green shading and policy icons, numeric legend, transparent gaps, readable light/dark palettes and darker hover, fresh hierarchy navigation, all potential ancestors, counts independent of current selection, workspace icons, adjacent Current labels, bold current labels without size changes, bottom row corners above the ellipsis, ellipsis loading, matching popup sizes, progressive touching cells, independent scrolling, compact sharing, and mobile controls.",
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  await page?.screenshot({
    path: "/tmp/jocki-feature-actions-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
