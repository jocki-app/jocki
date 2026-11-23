import * as A from "@automerge/automerge";
import { Companions } from "../packages/core/vaults/companions";
import { expect, it, vi } from "vitest";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileVault, fileText } from "../packages/core/vaults/vault";
import { NodeVaultFiles } from "../packages/platform-node/vault-files";
import { Libgit2RenameMatcher } from "../packages/platform-node/vault-renames";
import { VaultSearch } from "../packages/core/vaults/search";
import { utf8 } from "../packages/core/crypto";
import type { FileSystemChange } from "../packages/core/vaults/contracts";

const executable = path.resolve(
  "build/native-renames",
  process.platform === "win32"
    ? "Release/jocki-renames.exe"
    : "jocki-renames",
);
async function fixture(
  run: (value: {
    directory: string;
    fs: NodeVaultFiles;
    local: NodeVaultFiles;
    vault: FileVault;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "jocki-companions-"));
  try {
    const fs = await NodeVaultFiles.open(path.join(directory, "files")),
      local = await NodeVaultFiles.open(path.join(directory, "state"));
    const vault = await FileVault.open(fs, "device", {
      local,
      lazy: true,
      renames: new Libgit2RenameMatcher(executable),
    });
    await run({ directory, fs, local, vault });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("leaves ordinary roots untouched and creates companions only for requested features", async () =>
  fixture(async ({ fs, local, vault }) => {
    const id = await vault.create("note.md", utf8.encode("ordinary"));
    expect((await fs.scan()).map((e) => e.path)).toEqual(["note.md"]);
    await expect(access(fs.root + ".saddle")).rejects.toThrow();
    const draft = vault.draft(id);
    draft.contentType = "example.note";
    await vault.save(draft);
    expect(
      await new Companions(fs).read("note.md", "descriptor.json"),
    ).toBeDefined();
    expect(
      await new Companions(fs).read("note.md", "resource.json"),
    ).toBeDefined();
    expect(
      await new Companions(fs).read("note.md", "content.automerge"),
    ).toBeUndefined();
    await new VaultSearch().update(vault);
    expect(await local.read("cache/index/search.json")).toBeDefined();
    await expect(access(path.join(fs.root, ".saddle"))).rejects.toThrow();
  }));

it("moves an orphan companion after an offline rename with edits through libgit2", async () =>
  fixture(async ({ fs, local, vault }) => {
    const original = Array.from(
      { length: 120 },
      (_, i) => `line ${i}: a useful long sentence\n`,
    ).join("");
    const id = await vault.create("old.md", utf8.encode(original), {
      contentType: "example.note",
    });
    await vault.configureScope("file", id, { history: true });
    await unlink(path.join(fs.root, "old.md"));
    await writeFile(
      path.join(fs.root, "new.md"),
      original.replace("line 30:", "line thirty:"),
    );
    const matcher = new Libgit2RenameMatcher(executable),
      match = vi.spyOn(matcher, "match");
    const reopened = await FileVault.open(
      await NodeVaultFiles.open(fs.root),
      "device",
      { local, lazy: true, renames: matcher },
    );
    expect(match).toHaveBeenCalled();
    expect(reopened.find("new.md")?.id).toBe(id);
    await reopened.load(id);
    expect(fileText(reopened.doc(id))).toContain("line thirty:");
    expect(reopened.history(id).length).toBeGreaterThan(1);
    expect(reopened.doc(id).resource?.path).toBe("new.md");
    expect(await fs.stat(".old.md.saddle")).toBeUndefined();
    expect(await fs.stat(".new.md.saddle")).toBeDefined();
  }));

it("uses libgit2 for same-volume renames and propagates matcher errors", async () =>
  fixture(async ({ fs, local, vault }) => {
    const id = await vault.create(
      "old.md",
      utf8.encode("content with a stable baseline"),
    );
    await rename(
      path.join(fs.root, "old.md"),
      path.join(fs.root, "renamed.md"),
    );
    const matcher = new Libgit2RenameMatcher(executable),
      match = vi.spyOn(matcher, "match");
    const reopened = await FileVault.open(fs, "device", {
      local,
      lazy: true,
      renames: matcher,
    });
    expect(match).toHaveBeenCalledTimes(1);
    expect(reopened.find("renamed.md")?.id).toBe(id);
    expect(await fs.stat("renamed.md")).not.toHaveProperty("identity");
    await rename(
      path.join(fs.root, "renamed.md"),
      path.join(fs.root, "again.md"),
    );
    match.mockRejectedValueOnce(Error("Rename engine failed"));
    await expect(
      reopened.reconcile([{ path: "again.md", type: "add" }]),
    ).rejects.toThrow("Rename engine failed");
    expect(reopened.find("renamed.md")?.id).toBe(id);
    expect(reopened.find("again.md")).toBeUndefined();
    await reopened.reconcile();
    expect(reopened.find("again.md")?.id).toBe(id);
  }));

it("does not infer moves from folders or silently use another content matcher", async () =>
  fixture(async ({ fs, local, vault }) => {
    await vault.createFolder("Empty");
    await vault.configureScope("folder", "Empty", { history: true });
    const id = await vault.create("old.md", utf8.encode("content"));
    await rename(path.join(fs.root, "Empty"), path.join(fs.root, "Renamed"));
    await rename(path.join(fs.root, "old.md"), path.join(fs.root, "new.md"));
    const reopened = await FileVault.open(fs, "device", { local, lazy: true });
    expect(reopened.find("new.md")?.id).not.toBe(id);
    expect(reopened.scopePolicies.folders.Renamed).toBeUndefined();
    expect(await fs.stat(".Empty.saddle")).toBeDefined();
    expect(await fs.stat(".Renamed.saddle")).toBeUndefined();
  }));

it("rebuilds identities and history from portable companions without an app index", async () =>
  fixture(async ({ directory, fs, vault }) => {
    await vault.createFolder("Projects");
    await vault.configureScope("folder", "Projects", { history: true });
    const id = await vault.create("Projects/note.md", utf8.encode("first"));
    const draft = vault.draft(id);
    draft.text = "second";
    await vault.save(draft);
    const destination = path.join(directory, "copy");
    await cp(fs.root, destination, { recursive: true });
    const copy = await FileVault.open(
      await NodeVaultFiles.open(destination),
      "other",
      {
        local: await NodeVaultFiles.open(path.join(directory, "other-state")),
        lazy: true,
      },
    );
    expect(copy.find("Projects/note.md")?.id).toBe(id);
    await copy.load(id);
    expect(fileText(copy.doc(id))).toBe("second");
    expect(copy.history(id).length).toBeGreaterThan(1);
  }));

it("compacts history without peers after rebuilding a local index, even with sharing enabled", async () =>
  fixture(async ({ directory, fs, vault }) => {
    await vault.configure({ sync: true });
    const id = await vault.create("shared.md", utf8.encode("first"));
    const draft = vault.draft(id);
    draft.text = "second";
    const saved = await vault.save(draft);
    vault.release(saved);
    const generation = vault.doc(id).generation;
    const reopened = await FileVault.open(fs, "fresh", {
      local: await NodeVaultFiles.open(
        path.join(directory, "fresh-sync-state"),
      ),
    });
    expect(reopened.syncEnabled(id)).toBe(true);
    expect(reopened.doc(id).generation).not.toBe(generation);
    expect(A.stats(reopened.doc(id)).numChanges).toBe(1);
    await reopened.compactLocal(id);
    expect(A.stats(reopened.doc(id)).numChanges).toBe(1);
  }));

it("keeps folder rules and file exceptions through offline folder moves and supports unset", async () =>
  fixture(async ({ fs, local, vault }) => {
    await vault.createFolder("Projects");
    await vault.configureScope("folder", "Projects", { history: true });
    const included = await vault.create(
        "Projects/included.md",
        utf8.encode("included"),
      ),
      excluded = await vault.create(
        "Projects/excluded.md",
        utf8.encode("excluded"),
      );
    await vault.configureScope("file", excluded, { history: false });
    await rename(path.join(fs.root, "Projects"), path.join(fs.root, "Work"));
    const reopened = await FileVault.open(fs, "device", {
      local,
      lazy: true,
      renames: new Libgit2RenameMatcher(executable),
    });
    expect(reopened.entry(included).path).toBe("Work/included.md");
    expect(reopened.features(included).history).toBe(true);
    expect(reopened.features(excluded).history).toBe(false);
    expect(await fs.stat(".Projects.saddle")).toBeUndefined();
    expect(await fs.stat(".Work.saddle")).toBeDefined();
    await reopened.configureScope("file", excluded, { history: undefined });
    expect(reopened.features(excluded).history).toBe(true);
    const third = await reopened.create("Work/new.md");
    expect(reopened.features(third).history).toBe(true);
  }));

it("keeps deleted identities portable when a filename is reused", async () =>
  fixture(async ({ fs, directory, vault }) => {
    await vault.configure({ history: true });
    const first = await vault.create("same.md", utf8.encode("first"));
    await vault.remove(first);
    const second = await vault.create("same.md", utf8.encode("second"));
    expect(second).not.toBe(first);
    const reopened = await FileVault.open(fs, "fresh", {
      local: await NodeVaultFiles.open(path.join(directory, "fresh-state")),
    });
    expect(reopened.deletedFiles().map((file) => file.id)).toContain(first);
    expect(reopened.find("same.md")?.id).toBe(second);
    expect(fileText(reopened.doc(first))).toBe("first");
    expect(fileText(reopened.doc(second))).toBe("second");
  }));

it("discovers large trees without content reads and reconciles only the changed file", async () =>
  fixture(async ({ fs, local }) => {
    await mkdir(path.join(fs.root, "tree"));
    await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        writeFile(path.join(fs.root, "tree", `${i}.txt`), `file ${i}`),
      ),
    );
    const large = await open(path.join(fs.root, "large.bin"), "w");
    await large.truncate(32 * 1024 * 1024);
    await large.close();
    const read = vi.spyOn(fs, "read"),
      scan = vi.spyOn(fs, "scan");
    const vault = await FileVault.open(fs, "device", { local, lazy: true });
    expect(vault.list()).toHaveLength(501);
    expect(vault.fileMime(vault.find("large.bin")!.id)).toBe(
      "application/octet-stream",
    );
    expect(
      read.mock.calls.filter(([name]) => !name.includes(".saddle")),
    ).toEqual([]);
    const file = vault.find("tree/0.txt")!;
    await vault.load(file.id);
    expect(fileText(vault.doc(file.id))).toBe("file 0");
    read.mockClear();
    scan.mockClear();
    await writeFile(path.join(fs.root, "tree/0.txt"), "external edit");
    await vault.reconcile([{ path: "tree/0.txt", type: "change" }]);
    expect(fileText(vault.doc(file.id))).toBe("external edit");
    expect(scan).not.toHaveBeenCalled();
    expect(
      new Set(
        read.mock.calls
          .filter(([name]) => !name.includes(".saddle"))
          .map(([name]) => name),
      ),
    ).toEqual(new Set(["tree/0.txt"]));
    expect(vault.isLoaded(vault.find("large.bin")!.id)).toBe(false);
  }));

it("keeps an edited rename when the directory changes during a scan", async () =>
  fixture(async ({ fs, vault }) => {
    await vault.configure({ history: true });
    const original = Array.from(
      { length: 50 },
      (_, i) => `Line ${i}: stable file contents.\n`,
    ).join("");
    const id = await vault.create("note.md", utf8.encode(original));
    const stat = fs.stat.bind(fs);
    let moved = false;
    vi.spyOn(fs, "stat").mockImplementation(async (relative) => {
      if (relative === "note.md" && !moved) {
        moved = true;
        await rename(
          path.join(fs.root, "note.md"),
          path.join(fs.root, "Moved.md"),
        );
        await writeFile(
          path.join(fs.root, "Moved.md"),
          original + "An external edit.\n",
        );
      }
      return stat(relative);
    });
    await vault.reconcile();
    expect(vault.find("Moved.md")?.id).toBe(id);
    expect(fileText(vault.doc(id))).toContain("An external edit.");
  }));

it.each(["Moved.md", ".note.md.saddle"])(
  "recognizes a rename when a change for %s arrives before structural notifications",
  async (eventPath) =>
    fixture(async ({ fs, vault }) => {
      await vault.configure({ history: true });
      const original = Array.from(
        { length: 50 },
        (_, i) => `Line ${i}: stable file contents.\n`,
      ).join("");
      const id = await vault.create("note.md", utf8.encode(original));
      await rename(
        path.join(fs.root, "note.md"),
        path.join(fs.root, "Moved.md"),
      );
      await writeFile(
        path.join(fs.root, "Moved.md"),
        original + "An external edit.\n",
      );
      await vault.reconcile([{ path: eventPath, type: "change" }]);
      expect(vault.find("Moved.md")?.id).toBe(id);
      expect(fileText(vault.doc(id))).toContain("An external edit.");
    }),
);

it("applies live descriptor overrides and keeps unrelated metadata intact", async () =>
  fixture(async ({ fs, vault }) => {
    const id = await vault.create("note.md", utf8.encode("body"), {
      contentType: "example.note",
    });
    await vault.configureScope("file", id, { history: true });
    const name = ".note.md.saddle";
    const descriptor = JSON.parse(
      new TextDecoder().decode(
        await new Companions(fs).read("note.md", "descriptor.json"),
      ),
    );
    descriptor.features.history = false;
    await new Companions(fs).describe("note.md", descriptor);
    await vault.reconcile([{ path: name, type: "change" }]);
    expect(vault.features(id).history).toBe(false);
    expect(
      await new Companions(fs).read("note.md", "content.automerge"),
    ).toBeUndefined();
    expect(vault.contentType(id)).toBe("example.note");
  }));

it("delivers filesystem changes with paths for immediate tree and editor updates", async () =>
  fixture(async ({ fs, vault }) => {
    const { VaultWatcher } =
      await import("../packages/platform-node/vault-watch");
    const changes: FileSystemChange[] = [];
    const errors: unknown[] = [];
    const watcher = await VaultWatcher.open(
      fs.root,
      (batch) => {
        changes.push(...(batch ?? []));
        void vault.reconcile(batch).catch((error) => errors.push(error));
      },
      (error) => errors.push(error),
    );
    try {
      await writeFile(path.join(fs.root, "external.md"), "visible");
      await expect
        .poll(() => vault.find("external.md"), { timeout: 7000 })
        .toBeDefined();
      const id = vault.find("external.md")!.id;
      await vault.load(id);
      await writeFile(path.join(fs.root, "external.md"), "updated");
      await expect
        .poll(() => fileText(vault.doc(id)), { timeout: 7000 })
        .toBe("updated");
      expect(changes.some((change) => change.path === "external.md")).toBe(
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await watcher.close();
      await vault.flush();
    }
  }));
