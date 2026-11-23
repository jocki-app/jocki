import { expect, it, vi } from "vitest";
import fixtures from "./fixtures/contracts.json";
import { navigationService } from "../packages/app-ui/navigation-service";
import type { AppRuntime } from "../packages/app-ui/runtime";
import type { PluginManifest } from "@jocki/platform/plugin-sdk";
it("allows any plugin to register only its declared home pages and releases its registration", () => {
  const runtime = {
    homeDestinations: new Map(),
    chooseInitialHome: vi.fn(),
    notifySurfaces: vi.fn(),
  } as unknown as AppRuntime;
  const manifest = fixtures.find((entry) => entry.manifest.id === "tasks")!
    .manifest as PluginManifest;
  const ui = navigationService(runtime, manifest),
    dispose = ui.registerHome({
      id: "overview",
      title: "Tasks overview",
      page: manifest.ui.surfaces[0],
    });
  expect(runtime.chooseInitialHome).toHaveBeenCalledWith("tasks:overview");
  expect(runtime.homeDestinations.get("tasks:overview")?.pluginId).toBe(
    "tasks",
  );
  expect(() =>
    ui.registerHome({ id: "invalid", title: "Foreign page", page: "foreign" }),
  ).toThrow("declared page");
  expect(() => ui.registerHome({ id: "overview", title: "Duplicate" })).toThrow(
    "already registered",
  );
  dispose();
  expect(runtime.homeDestinations.size).toBe(0);
});
