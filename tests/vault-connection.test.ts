// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { VaultRuntime } from "../packages/platform-browser/vault-runtime";
import { WorkspaceLibrary } from "../packages/core/vaults/workspace-library";
import { LocalLogStore } from "../packages/core/local-logs";
import { FileVault } from "../packages/core/vaults/vault";
import { ProtectedFileSync } from "../packages/core/vaults/protected-sync";
import {
  defaultRepositorySettings,
  saveRelay,
} from "../packages/core/relay-settings";
import { repositorySettings } from "../packages/platform-browser/repository-settings";
import { utf8 } from "../packages/core/crypto";
import type { VaultFileSystem } from "../packages/core/vaults/contracts";
vi.mock("../packages/platform-browser/file-extension-host", () => ({
  browserExtensionModule: vi.fn(),
}));
vi.mock("../packages/platform-browser/repository", () => ({
  openBrowserRepository: vi.fn(),
}));
import { openBrowserRepository } from "../packages/platform-browser/repository";
class Files implements VaultFileSystem {
  values = new Map<string, Uint8Array>();
  async read(path: string) {
    return this.values.get(path)?.slice();
  }
  async writeAtomic(path: string, bytes: Uint8Array) {
    this.values.set(path, bytes.slice());
  }
  async remove(path: string) {
    this.values.delete(path);
  }
  async list() {
    return [...this.values.keys()];
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(openBrowserRepository).mockReset();
  localStorage.clear();
});
it("reconnects broadcasting without replacing editor drafts and restores settings after a failed connection change", async () => {
  const files = new Files(),
    library = await WorkspaceLibrary.open(files, "computer"),
    logs = await LocalLogStore.open(files);
  const runtime = Reflect.construct(VaultRuntime, [
    library,
    logs,
    "computer",
  ]) as VaultRuntime;
  const events: string[] = [];
  vi.mocked(openBrowserRepository).mockImplementation(async () => {
    const settings = await repositorySettings();
    events.push(`open:${settings.selected}:${settings.broadcast}`);
    if (settings.selected === "broken") throw Error("Cannot open connection");
    return {
      close: vi.fn(async () => {
        events.push("close");
      }),
    } as any;
  });
  vi.spyOn(ProtectedFileSync, "open").mockImplementation(
    async (repository) =>
      ({
        repository,
        attach: vi.fn(async () => {}),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }) as any,
  );
  try {
    const vault = await FileVault.open(new Files(), "computer");
    runtime.vaults.set(vault.id, vault);
    const id = await vault.create("note.md", utf8.encode("saved"));
    const session = await runtime.editors.open(vault.id, id);
    session.draft.text = "unsaved";
    runtime.editors.changed(vault.id, id, "edit");
    await runtime.startSync();
    const initial = runtime.sync;
    await runtime.configureConnection({
      ...defaultRepositorySettings(),
      broadcast: true,
    });
    expect(runtime.sync).not.toBe(initial);
    expect(runtime.editors.sessions.get(vault.id + "/" + id)).toBe(session);
    expect(session.draft.text).toBe("unsaved");
    expect(session.draft.dirty).toBe(true);
    expect(vault.doc(id).text).toBe("saved");
    await runtime.configureConnection({
      ...runtime.connectionSettings,
      broadcast: false,
    });
    expect(runtime.connectionSettings.broadcast).toBe(false);
    const broken = saveRelay(runtime.connectionSettings, {
      id: "broken",
      name: "Broken",
      endpoints: ["wss://broken.example.test"],
      syncServer: "keyhive",
    });
    await expect(runtime.configureConnection(broken)).rejects.toThrow(
      "Cannot open connection",
    );
    expect((await repositorySettings()).selected).toBe("automerge");
    expect(runtime.connectionSettings.broadcast).toBe(false);
    expect(runtime.sync).toBeDefined();
    expect(events).toEqual([
      "open:automerge:false",
      "close",
      "open:automerge:true",
      "close",
      "open:automerge:false",
      "close",
      "open:broken:false",
      "open:automerge:false",
    ]);
  } finally {
    runtime.editors.discard(
      [...runtime.vaults.keys()][0],
      [...runtime.editors.sessions.values()][0].id,
    );
    await runtime.shutdown();
  }
});
