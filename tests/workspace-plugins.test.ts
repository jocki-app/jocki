import { expect, it } from "vitest";
import { DeviceCore } from "./fixtures/device";
import { MemoryStorage } from "../packages/storage";
import { WorkspacePlugins } from "../packages/core/workspace-plugins";
import { reconcilePluginActivation } from "../packages/core/plugin-activation";
import {
  PluginRegistry,
  type PluginState,
} from "@jocki/platform/core/registry";

it("rejects malformed activation records before they enter the replica", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "A"),
    node = await core.createWorkspace("Workspace");
  await expect(
    node.replica.update("setting/workspace", {
      plugins: { tasks: { enabled: "yes" } },
      home: null,
    }),
  ).rejects.toThrow("Invalid workspace plugin selection");
  await expect(
    node.replica.update("setting/workspace", {
      home: null,
      plugins: {
        tasks: {
          installed: true,
          enabled: true,
          downloadUrl: "https://untrusted.invalid/code",
        },
      },
    }),
  ).rejects.toThrow("Invalid workspace plugin selection");
  expect(node.replica.read("setting/workspace")).toEqual({
    plugins: {},
    home: null,
  });
  await core.close();
});

async function registry() {
  const saved = new Map<string, PluginState>();
  const registry = new PluginRegistry({
    load: async () => [...saved.values()],
    save: async (state) => {
      saved.set(state.id, state);
    },
  });
  await registry.initialize();
  const template = registry.manifests.get("tasks")!;
  registry.manifests.set("sync-child", {
    ...template,
    id: "sync-child",
    dependencies: [],
  });
  registry.manifests.set("sync-parent", {
    ...template,
    id: "sync-parent",
    dependencies: ["sync-child"],
  });
  return registry;
}
it("replicates only plugin choices, then explicitly installs locally and propagates later disables", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A"),
    b = await DeviceCore.open(new MemoryStorage(), "B");
  const source = await a.createWorkspace("Workspace"),
    target = await b.join(
      await a.approve(source.replica.workspaceId, b.pairingRequest()),
    );
  const first = new WorkspacePlugins(source.replica),
    second = new WorkspacePlugins(target.replica);
  await first.set("sync-parent", { installed: true, enabled: true });
  let downloads = 0;
  const local = await registry();
  await expect
    .poll(
      () => target.replica.heads("").join() === source.replica.heads("").join(),
      { timeout: 12000 },
    )
    .toBe(true);
  expect(second.choices().get("sync-parent")).toEqual({
    installed: true,
    enabled: true,
  });
  expect(downloads).toBe(0);
  expect(local.states.has("sync-parent")).toBe(false);
  expect(
    await reconcilePluginActivation(local, second.choices(), async () => {
      downloads++;
    }),
  ).toEqual(new Map());
  expect(downloads).toBe(2);
  expect(local.enabled("sync-parent")).toBe(true);
  expect(local.enabled("sync-child")).toBe(true);
  expect(source.replica.ids("setting/workspace")).toHaveLength(1);
  expect(source.replica.read("setting/workspace")).toEqual({
    home: null,
    plugins: {
      "sync-parent": {
        installed: true,
        enabled: true,
      },
    },
  });
  await second.set("sync-parent", { installed: true, enabled: false });
  await expect
    .poll(
      () => target.replica.heads("").join() === source.replica.heads("").join(),
      { timeout: 12000 },
    )
    .toBe(true);
  expect(first.choices().get("sync-parent")).toEqual({
    installed: true,
    enabled: false,
  });
  await reconcilePluginActivation(local, first.choices(), async () => {});
  expect(local.enabled("sync-parent")).toBe(false);
  expect(local.enabled("sync-child")).toBe(false);
  expect(local.states.get("sync-parent")?.installed).toBe(true);
  expect(first.choices().get("sync-parent")).toEqual({
    installed: true,
    enabled: false,
  });
  await Promise.all([a.close(), b.close()]);
});
it("keeps shared choices on download failure and retries without changing workspace data", async () => {
  const local = await registry(),
    choices = new Map([["sync-parent", { installed: true, enabled: true }]]);
  const failed = await reconcilePluginActivation(local, choices, async () => {
    throw Error("offline");
  });
  expect(failed.get("sync-parent")).toBe("offline");
  expect(local.enabled("sync-parent")).toBe(false);
  expect(choices.get("sync-parent")).toEqual({
    installed: true,
    enabled: true,
  });
  expect(
    await reconcilePluginActivation(local, choices, async () => {}),
  ).toEqual(new Map());
  expect(local.enabled("sync-parent")).toBe(true);
});
it("does not let a read-only device change shared plugin activation", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A"),
    b = await DeviceCore.open(new MemoryStorage(), "B");
  const node = await a.createWorkspace("Workspace"),
    viewer = await b.join(
      await a.approve(
        node.replica.workspaceId,
        b.pairingRequest({ access: "read" }),
      ),
    );
  const plugins = new WorkspacePlugins(viewer.replica);
  await expect(
    plugins.set("tasks", { installed: true, enabled: true }),
  ).rejects.toThrow();
  expect(plugins.choices().size).toBe(0);
  await Promise.all([a.close(), b.close()]);
});

it("installs disabled workspace requirements on a fresh device and removes them when the workspace removes them", async () => {
  const local = await registry();
  const choices = new Map([
    ["sync-parent", { installed: true, enabled: false }],
  ]);
  await reconcilePluginActivation(local, choices, async () => {});
  expect(local.states.get("sync-parent")).toMatchObject({
    installed: true,
    enabled: false,
  });
  expect(local.states.get("sync-child")).toMatchObject({
    installed: true,
    enabled: false,
  });
  await reconcilePluginActivation(local, new Map(), async () => {
    throw Error("no download needed");
  });
  expect(local.states.get("sync-parent")).toMatchObject({
    installed: false,
    enabled: false,
  });
  expect(local.states.get("sync-child")).toMatchObject({
    installed: false,
    enabled: false,
  });
});

it("does not seed an empty workspace from another workspace's locally installed plugins", async () => {
  const device = await DeviceCore.open(new MemoryStorage(), "Device");
  try {
    const first = await device.createWorkspace("First"),
      second = await device.createWorkspace("Second"),
      local = await registry();
    await new WorkspacePlugins(first.replica).set("sync-parent", {
      installed: true,
      enabled: true,
    });
    await reconcilePluginActivation(
      local,
      new WorkspacePlugins(first.replica).choices(),
      async () => {},
    );
    expect(local.enabled("sync-parent")).toBe(true);
    const clean = new WorkspacePlugins(second.replica);
    await reconcilePluginActivation(local, clean.choices(), async () => {});
    expect(clean.choices().size).toBe(0);
    expect(second.replica.read("setting/workspace")).toEqual({
      home: null,
      plugins: {},
    });
    expect(local.enabled("sync-parent")).toBe(false);
    expect(
      new WorkspacePlugins(first.replica).choices().get("sync-parent"),
    ).toEqual({ installed: true, enabled: true });
  } finally {
    await device.close();
  }
});
