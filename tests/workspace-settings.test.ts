import { expect, it } from "vitest";
import { DeviceCore } from "./fixtures/device";
import { MemoryStorage } from "../packages/storage";
import {
  WorkspaceSettings,
  workspaceSettingsId,
} from "../packages/core/workspace-settings";
it("syncs shared JSON preferences and independent plugin edits without carrying local device settings", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A"),
    b = await DeviceCore.open(new MemoryStorage(), "B");
  try {
    const source = await a.createWorkspace("Preferences");
    const target = await b.join(
      await a.approve(source.link.id, b.pairingRequest()),
    );
    await expect
      .poll(
        () =>
          target.replica.heads("").join() === source.replica.heads("").join(),
        { timeout: 12000 },
      )
      .toBe(true);
    const first = new WorkspaceSettings(source.replica),
      second = new WorkspaceSettings(target.replica);
    await first.setPlugin("tasks", { installed: true, enabled: true });
    await second.setPlugin("track", { installed: true, enabled: true });
    await second.setHome("dashboard:home");
    await expect
      .poll(
        () =>
          target.replica.heads("").join() === source.replica.heads("").join(),
        { timeout: 12000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          target.replica.heads("").join() === source.replica.heads("").join(),
        { timeout: 12000 },
      )
      .toBe(true);
    expect(first.read()).toEqual(second.read());
    expect(first.read()).toEqual({
      plugins: {
        tasks: { installed: true, enabled: true },
        track: { installed: true, enabled: true },
      },
      home: "dashboard:home",
    });
    await expect(
      first.set({ ...first.read(), theme: "dark" } as any),
    ).rejects.toThrow();
  } finally {
    await a.close();
    await b.close();
  }
});
it("preserves simultaneous local changes through separate settings facades and validates replicated JSON", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "A");
  try {
    const node = await core.createWorkspace("Settings");
    await Promise.all([
      new WorkspaceSettings(node.replica).setHome("plugins"),
      new WorkspaceSettings(node.replica).setPlugin("tasks", {
        installed: true,
        enabled: true,
      }),
      new WorkspaceSettings(node.replica).setPlugin("time", {
        installed: true,
        enabled: false,
      }),
    ]);
    const value = new WorkspaceSettings(node.replica).read();
    expect(value.plugins.tasks.enabled).toBe(true);
    expect(value.plugins.time.enabled).toBe(false);
    expect(value.home).toBe("plugins");
    for (const invalid of [
      { plugins: [], home: null },
      { plugins: { bad: { enabled: true, installed: false } }, home: null },
      { plugins: {}, home: "javascript:alert(1)" },
      { plugins: {}, home: null, trustedCode: true },
    ])
      await expect(
        node.replica.update(workspaceSettingsId, invalid),
      ).rejects.toThrow();
    expect(new WorkspaceSettings(node.replica).read()).toEqual(value);
  } finally {
    await core.close();
  }
});
