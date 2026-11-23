import { it, expect } from "vitest";
import type { VaultFileSystem } from "../packages/core/vaults/contracts";
import {
  WorkspaceCatalog,
  WorkspaceLibrary,
} from "../packages/core/vaults/workspace-library";
import { LocalLogStore, redactLog } from "../packages/core/local-logs";
import { utf8, text } from "../packages/core/crypto";
import { UIContributionRegistry } from "../packages/platform/src/file-sdk/ui-registry";
class Files implements VaultFileSystem {
  values = new Map<string, Uint8Array>();
  async read(p: string) {
    return this.values.get(p)?.slice();
  }
  async writeAtomic(p: string, b: Uint8Array) {
    this.values.set(p, b.slice());
  }
  async remove(p: string) {
    this.values.delete(p);
  }
  async list() {
    return [...this.values.keys()];
  }
}
it("opens explicitly selected workspaces with independent settings and shared vault references", async () => {
  const fs = new Files(),
    first = await WorkspaceLibrary.open(fs, "computer");
  const firstId = first.current.current.id;
  await first.current.update((d) => {
    d.name = "Writing";
    d.defaults.vim = true;
    d.computers.computer.vaults = { shared: "local-folder-token" };
  });
  const secondId = await first.create("Research");
  expect(first.current.current.id).toBe(firstId);
  await first.rememberCurrent();
  const second = await WorkspaceLibrary.open(
    fs,
    "computer",
    "Workspace",
    secondId,
  );
  expect(second.current.current.id).toBe(secondId);
  expect(second.current.settings("computer").vim).toBe(false);
  expect(await second.references()).toContainEqual({
    id: "shared",
    location: "local-folder-token",
    workspace: "Writing",
  });
  await second.current.update((d) => {
    d.computers.computer.vaults = { shared: "local-folder-token" };
  });
  await second.rememberCurrent();
  const reopened = await WorkspaceLibrary.open(
    fs,
    "computer",
    "Workspace",
    firstId,
  );
  expect(reopened.current.current.name).toBe("Writing");
  expect(reopened.current.settings("computer").vim).toBe(true);
  expect(reopened.list()).toHaveLength(2);
  expect(reopened.current.settings("computer").vaults.shared).toBe(
    "local-folder-token",
  );
});
it("expires local diagnostic shards, bounds storage and redacts secrets without Automerge", async () => {
  const fs = new Files(),
    now = Date.UTC(2026, 10, 13, 12);
  fs.values.set("logs/2026-10-01.jsonl", utf8.encode("old\n"));
  fs.values.set("unrelated.json", utf8.encode("keep"));
  const store = await LocalLogStore.open(fs, () => now);
  const message = redactLog(
    'token="private-token" authorization=Bearer-secret automerge:abc123 https://example.test/?secret=hello',
  );
  expect(message).not.toContain("private-token");
  expect(message).not.toContain("Bearer-secret");
  expect(message).not.toContain("abc123");
  await store.append({
    id: "one",
    time: now,
    level: "error",
    category: "test",
    message,
  });
  expect(await store.list()).toHaveLength(1);
  expect(await fs.read("logs/2026-10-01.jsonl")).toBeUndefined();
  expect(text.decode(await fs.read("unrelated.json"))).toBe("keep");
  expect((await fs.list()).some((p) => p.endsWith(".automerge"))).toBe(false);
  for (let i = 0; i < 280; i++)
    await store.append({
      id: String(i),
      time: now,
      level: "info",
      category: "test",
      message: "x".repeat(8000),
    });
  expect((await fs.read("logs/2026-11-13.jsonl"))!.length).toBeLessThanOrEqual(
    2 * 1024 * 1024,
  );
  await store.clear();
  expect(await store.list()).toEqual([]);
});
it("composes core and extension menu entries with stable ordering and resource conditions", () => {
  const registry = new UIContributionRegistry();
  registry.replace("core", [
    {
      id: "core.rename",
      command: "core.rename",
      title: "Rename",
      location: "explorer/context",
      group: "10",
      when: { kinds: ["file", "folder"] },
    },
  ]);
  const extension = registry.replace("example.notes", [
    {
      id: "example.notes.action",
      command: "example.notes.format",
      title: "Format note",
      location: "explorer/context",
      group: "20",
      when: { kinds: ["file"], mime: "text/markdown" },
    },
  ]);
  expect(
    registry
      .items("explorer/context", { kind: "file", mime: "text/markdown" })
      .map((e) => e.owner),
  ).toEqual(["core", "example.notes"]);
  expect(
    registry.items("explorer/context", { kind: "folder" }).map((e) => e.title),
  ).toEqual(["Rename"]);
  expect(registry.items("explorer/context", { kind: "vault" })).toEqual([]);
  expect(() =>
    registry.replace("evil", [
      {
        id: "core.rename",
        command: "evil.rename",
        title: "Overwrite",
        location: "explorer/context",
      },
    ]),
  ).toThrow(/namespace/);
  extension.dispose();
  expect(registry.items("explorer/context", { kind: "file" })).toHaveLength(1);
});

it("routes LogTape errors to the local sink and its UI subscribers", async () => {
  const store = await LocalLogStore.open(new Files());
  store.configure();
  const received: string[] = [];
  store.subscribe((record) => received.push(record.message));
  const { logError } = await import("../packages/core/local-logs");
  logError(new Error("expected diagnostic"), "test");
  await store.flush();
  expect(received.join()).toContain("expected diagnostic");
  expect((await store.list()).at(0)?.message).toContain("expected diagnostic");
});

it("lists saved vault references while the active workspace snapshot is being published", async () => {
  const fs = new Files(),
    first = await WorkspaceLibrary.open(fs, "computer");
  await first.current.update((d) => {
    d.name = "Writing";
    d.computers.computer.vaults = { shared: "folder-token" };
  });
  const id = await first.create("Research");
  const second = await WorkspaceLibrary.open(fs, "computer", "Workspace", id);
  const read = fs.read.bind(fs);
  fs.read = async (path) => {
    if (path === `workspaces/${id}/workspace.automerge`)
      throw new DOMException(
        "The active File snapshot changed during publication",
        "NotReadableError",
      );
    return read(path);
  };
  expect(await second.references()).toContainEqual({
    id: "shared",
    location: "folder-token",
    workspace: "Writing",
  });
});

it("reads only the workspace list without opening or creating a workspace or retaining a selection", async () => {
  const fs = new Files();
  const empty = await WorkspaceCatalog.open(fs);
  expect(empty.list()).toEqual([]);
  expect(await fs.list()).toEqual([]);
  const workspace = await WorkspaceLibrary.open(fs, "computer");
  const id = workspace.current.current.id;
  const before = new Map(fs.values);
  const reads: string[] = [];
  const read = fs.read.bind(fs);
  fs.read = async (path) => {
    reads.push(path);
    return read(path);
  };
  const catalog = await WorkspaceCatalog.open(fs);
  expect(reads).toEqual(["workspaces.json"]);
  expect(catalog.list()).toEqual([
    expect.objectContaining({ id, name: "Workspace", kind: "internal" }),
  ]);
  expect(fs.values).toEqual(before);
  expect(
    Object.keys(JSON.parse(text.decode((await read("workspaces.json"))!))),
  ).toEqual(["entries"]);
});

it("rejects obsolete catalog fields instead of retaining session state", async () => {
  const fs = new Files();
  await WorkspaceLibrary.open(fs, "computer");
  const saved = JSON.parse(text.decode((await fs.read("workspaces.json"))!));
  await fs.writeAtomic(
    "workspaces.json",
    utf8.encode(JSON.stringify({ ...saved, active: saved.entries[0].id })),
  );
  await expect(WorkspaceCatalog.open(fs)).rejects.toThrow();
});

it("creates and reopens external JSON through a granted capability without moving it into app storage", async () => {
  const app = new Files(),
    external = new Files();
  const resolve = async () => external;
  const catalog = await WorkspaceCatalog.open(app, resolve);
  const id = await catalog.create("computer", "Project", {
    root: "folder-token",
    path: "/projects/workspace.json",
    storage: external,
  });
  expect(await app.read("workspace.json")).toBeUndefined();
  expect(await external.read("workspace.json")).toBeDefined();
  const library = await WorkspaceLibrary.open(
    app,
    "computer",
    "Workspace",
    id,
    resolve,
  );
  await library.current.configure({ history: true });
  expect(await external.read("workspace.automerge")).toBeDefined();
  expect(await app.read("workspace.automerge")).toBeUndefined();
  await library.current.update((doc) => {
    doc.name = "Renamed";
  });
  await library.rememberCurrent();
  expect(catalog.list()[0].path).toBe("/projects/workspace.json");
  const fresh = await WorkspaceCatalog.open(app, resolve);
  expect(fresh.list()[0].name).toBe("Renamed");
  await fresh.forget(id);
  expect(fresh.list()).toEqual([]);
  expect(await external.read("workspace.json")).toBeDefined();
  await expect(
    WorkspaceCatalog.open(app).then((index) =>
      index.register({
        id,
        name: "Broken",
        root: "arbitrary",
        path: "",
        kind: "folder",
      }),
    ),
  ).resolves.toBeUndefined();
  await expect(
    WorkspaceLibrary.open(app, "computer", "Workspace", id),
  ).rejects.toThrow("unavailable");
});

it("reads retained workspace versions only while workspace history is enabled", async () => {
  const fs = new Files(),
    workspace = (await WorkspaceLibrary.open(fs, "computer")).current;
  expect(() => workspace.history()).toThrow(/disabled/);
  await workspace.configure({ history: true });
  await workspace.update((doc) => {
    doc.name = "Before rename";
  });
  const previous = workspace.history().at(-1)!;
  await workspace.update((doc) => {
    doc.name = "After rename";
  });
  expect(workspace.historySnapshot(previous.hash).name).toBe("Before rename");
  expect(workspace.current.name).toBe("After rename");
  await workspace.configure({ history: false });
  expect(() => workspace.historySnapshot(previous.hash)).toThrow(/disabled/);
  expect(await fs.read("workspace.automerge")).toBeUndefined();
});

it("unlinking internal workspaces always deletes their JSON and archive", async () => {
  const files = new Files();
  const library = await WorkspaceLibrary.open(files, "computer");
  await library.current.configure({ history: true });
  expect(await files.read("workspace.automerge")).toBeDefined();
  await library.index.forget(library.current.current.id);
  expect(library.index.list()).toEqual([]);
  expect(await files.read("workspace.json")).toBeUndefined();
  expect(await files.read("workspace.automerge")).toBeUndefined();
});
