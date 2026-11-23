import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultRepositorySettings,
  relayPresets,
  relayConnection,
  saveRelay,
  selectRelay,
  validateRepositorySettings,
} from "../packages/core/relay-settings";
import {
  readRepositorySettings,
  writeRepositorySettings,
} from "../packages/platform-node/repository-settings";
import { DeviceCore } from "./fixtures/device";
import { MemoryStorage } from "../packages/storage";

it("starts with broadcasting off and retains a selected relay for enabling sharing", () => {
  const settings = defaultRepositorySettings();
  expect(relayConnection(settings)).toEqual({
    endpoints: ["wss://keyhive.sync.automerge.org"],
    syncServer: "keyhive",
  });
  expect(settings.broadcast).toBe(false);
  expect(relayPresets.map((preset) => preset.id)).toEqual(["automerge"]);
  expect(
    validateRepositorySettings({ ...settings, broadcast: true }).broadcast,
  ).toBe(true);
  expect(() =>
    validateRepositorySettings({ ...settings, endpoints: [] }),
  ).toThrow("WebSocket endpoint");
  settings.endpoints.length = 0;
  expect(defaultRepositorySettings().endpoints).toHaveLength(1);
});
it("keeps named relay options while switching between presets and saved connections", () => {
  const first = saveRelay(defaultRepositorySettings(), {
    id: "office",
    name: "Office",
    endpoints: ["wss://office.example.test"],
    syncServer: "keyhive",
  });
  const second = saveRelay(first, {
    id: "home",
    name: "Home",
    ...relayConnection({
      endpoints: ["ws://home.example.test:8888"],
      syncServer: {
        contactCardJson: '{"public":"card"}',
        peerId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    }),
  });
  const reloaded = validateRepositorySettings(
    JSON.parse(JSON.stringify(selectRelay(second, "automerge"))),
  );
  expect(reloaded.saved.map((relay) => relay.name)).toEqual(["Office", "Home"]);
  expect(selectRelay(reloaded, "office").endpoints).toEqual(first.endpoints);
  expect(selectRelay(reloaded, "home").syncServer).toEqual(second.syncServer);
  expect(
    saveRelay(reloaded, { ...first.saved[0], name: "Office renamed" }).saved,
  ).toHaveLength(2);
});
it("rejects unsafe endpoints, missing relay identities and ambiguous saved choices", () => {
  for (const endpoint of [
    "https://example.test",
    "wss://user:password@example.test",
    "javascript:alert(1)",
  ])
    expect(() => relayConnection({ endpoints: [endpoint] })).toThrow("ws://");
  expect(() =>
    relayConnection({ endpoints: ["wss://example.test"], syncServer: null }),
  ).toThrow("contact card");
  expect(() =>
    relayConnection({ syncServer: { contactCardJson: "bad", peerId: "id" } }),
  ).toThrow("JSON object");
  expect(() =>
    validateRepositorySettings({
      ...defaultRepositorySettings(),
      selected: "missing",
    }),
  ).toThrow("available sync relay");
  const saved = {
    id: "first",
    name: "Office",
    endpoints: ["wss://example.test"],
    syncServer: "keyhive" as const,
  };
  expect(() =>
    validateRepositorySettings({
      ...defaultRepositorySettings(),
      saved: [saved, { ...saved, id: "other", name: "office" }],
    }),
  ).toThrow("unique");
});
it("persists selected and saved options durably and leaves working settings intact on validation failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jocki-relays-"));
  try {
    expect(await readRepositorySettings(directory)).toEqual(
      defaultRepositorySettings(),
    );
    const selected = saveRelay(defaultRepositorySettings(), {
      id: "lab",
      name: "Lab",
      endpoints: ["wss://lab.example.test"],
      syncServer: "keyhive",
    });
    await writeRepositorySettings(directory, selected);
    expect(await readRepositorySettings(directory)).toEqual(selected);
    const before = await readFile(
      path.join(directory, "repository-settings.json"),
    );
    await expect(
      writeRepositorySettings(directory, { endpoints: ["file:///bad"] }),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(directory, "repository-settings.json")),
    ).toEqual(before);
    expect(await readdir(directory)).toEqual(["repository-settings.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("cleans up failed joins and allows the same approved invitation to be retried", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A"),
    b = await DeviceCore.open(new MemoryStorage(), "B");
  const source = await a.createWorkspace("Retry"),
    invitation = await a.approve(source.link.id, b.pairingRequest());
  const wait = vi
    .spyOn(b.repository, "waitForAccess")
    .mockRejectedValueOnce(Error("Access delayed"));
  await expect(b.join(invitation)).rejects.toThrow("Access delayed");
  expect(b.profiles()).toEqual([]);
  wait.mockRestore();
  const target = await b.join(invitation);
  expect(target.link.id).toBe(source.link.id);
  expect(b.profiles()).toHaveLength(1);
});

it("waits for a granted document through native unavailable progress and releases its subscription", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Loader");
  const node = await core.createWorkspace("Progress");
  let state: any = {
    state: "unavailable",
    sources: { subduction: "unavailable" },
  };
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const progress = {
    documentId: node.replica.handle.documentId,
    peek: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };
  const find = vi
    .spyOn(core.repository.repo, "findWithProgress")
    .mockReturnValue(progress as any);
  const resync = vi
    .spyOn(core.repository.repo, "resyncSubduction")
    .mockImplementation(() => {});
  try {
    const loaded = core.repository.load(node.link.url);
    await vi.waitFor(() => expect(resync).toHaveBeenCalled());
    state = { state: "ready", handle: node.replica.handle, sources: {} };
    for (const listener of listeners) listener();
    expect(await loaded).toBe(node.replica.handle);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    const failed = Error("Storage failed");
    state = { state: "failed", error: failed, sources: {} };
    await expect(core.repository.load(node.link.url)).rejects.toBe(failed);
    state = { state: "unavailable", sources: {} };
    const abort = new AbortController();
    const pending = core.repository.load(node.link.url, abort.signal);
    const rejection = expect(pending).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    abort.abort(Error("Cancelled"));
    await rejection;
    expect(listeners.size).toBe(0);
  } finally {
    find.mockRestore();
    resync.mockRestore();
  }
});
