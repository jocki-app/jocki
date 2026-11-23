import { Companions } from "../packages/core/vaults/companions";
import { it, expect } from "vitest";
import { mkdtemp, rm, symlink, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeVaultFiles } from "../packages/platform-node/vault-files";
import { Libgit2RenameMatcher } from "../packages/platform-node/vault-renames";
import { utf8, text } from "../packages/core/crypto";

it("persists complete files and blocks traversal and symlink escapes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jocki-vault-test-"));
  try {
    const fs = await NodeVaultFiles.open(path.join(directory, "vault"));
    await fs.writeAtomic("folder/note.md", utf8.encode("old"));
    await fs.writeAtomic("folder/note.md", utf8.encode("new"));
    expect(text.decode((await fs.read("folder/note.md"))!)).toBe("new");
    await expect(fs.read("../secret")).rejects.toThrow();
    await mkdir(path.join(directory, "outside"));
    await symlink(
      path.join(directory, "outside"),
      path.join(fs.root, "escape"),
    );
    await expect(
      fs.writeAtomic("escape/file.txt", utf8.encode("secret")),
    ).rejects.toThrow("symlink");
    expect(await fs.list()).toEqual(["folder/note.md"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("does not recreate a missing selected folder", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "jocki-missing-root-"),
  );
  try {
    const missing = path.join(directory, "moved");
    await expect(
      NodeVaultFiles.open(missing, { create: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(missing)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("excludes concurrent local vault writers and releases the device lease", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "jocki-vault-lease-"),
  );
  try {
    const fs = await NodeVaultFiles.open(directory),
      other = await NodeVaultFiles.open(directory),
      release = await fs.acquireWriter();
    try {
      await expect(other.acquireWriter()).rejects.toThrow("already open");
    } finally {
      await release();
    }
    const next = await other.acquireWriter();
    await next();
    expect(await fs.list()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses libgit2 for a rename with edits, including spaces and Unicode paths", async () => {
  const executable = path.resolve(
    "build/native-renames",
    process.platform === "win32"
      ? "Release/jocki-renames.exe"
      : "jocki-renames",
  );
  await access(executable); // Required native integration: build:vault-native precedes this test.
  const old = Array.from(
    { length: 100 },
    (_, i) => `line ${i}: repeated useful text\n`,
  ).join("");
  const matches = await new Libgit2RenameMatcher(executable).match(
    [{ path: "old note.md", bytes: utf8.encode(old) }],
    [
      {
        path: "notes/新 note.md",
        bytes: utf8.encode(old.replace("line 50:", "line fifty:")),
      },
    ],
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({
    from: "old note.md",
    to: "notes/新 note.md",
  });
  expect(matches[0].similarity).toBeGreaterThanOrEqual(70);
});

it("keeps empty folders after restart, preserves IDs on folder moves and clears only selected history", async () => {
  const { FileVault } = await import("../packages/core/vaults/vault");
  const directory = await mkdtemp(path.join(tmpdir(), "jocki-folders-"));
  try {
    const fs = await NodeVaultFiles.open(directory),
      vault = await FileVault.open(fs, "test");
    await vault.configure({ history: true });
    await vault.createFolder("Projects/Empty");
    const id = await vault.create("Projects/note.md", utf8.encode("first")),
      other = await vault.create("other.md", utf8.encode("other"));
    let draft = vault.draft(id);
    draft.text = "second";
    draft = await vault.save(draft);
    vault.release(draft);
    expect(vault.history(id).length).toBeGreaterThan(1);
    const notifications: string[][] = [];
    const unsubscribe = vault.subscribe(() =>
      notifications.push(vault.directories()),
    );
    await fs.mkdir("External");
    await vault.reconcile();
    expect(notifications.at(-1)).toContain("External");
    unsubscribe();
    await vault.moveFolder("Projects", "Work");
    expect(vault.entry(id).path).toBe("Work/note.md");
    const restarted = await FileVault.open(fs, "test");
    expect(restarted.directories()).toContain("Work/Empty");
    expect(restarted.find("Work/note.md")?.id).toBe(id);
    await restarted.setFileHistory(id, false);
    expect(restarted.historyEnabled(id)).toBe(false);
    expect(restarted.historyEnabled(other)).toBe(true);
    expect(
      await new Companions(fs).read("Work/note.md", "content.automerge"),
    ).toBeUndefined();
    expect(
      await new Companions(fs).read("other.md", "content.automerge"),
    ).toBeDefined();
    await expect(fs.mkdir("../outside")).rejects.toThrow();
    await expect(fs.removeDirectory("Work")).rejects.toThrow("contains files");
    await restarted.removeFolder("Work");
    expect(await fs.directories()).not.toContain("Work");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("deletes only explicitly selected Jocki metadata and rejects symlink escapes", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "jocki-metadata-delete-"),
  );
  try {
    const fs = await NodeVaultFiles.open(path.join(directory, "vault"));
    await fs.writeAtomic("note.md", utf8.encode("ordinary file"));
    await new Companions(fs).write(
      "note.md",
      "resource.json",
      utf8.encode("{}"),
    );
    await new Companions(fs).write(
      "other.md",
      "descriptor.json",
      utf8.encode("{}"),
    );
    await new Companions(fs).write(
      "note.md",
      "content.automerge",
      new Uint8Array([1, 2, 3]),
    );
    await expect(fs.removeTree("note.md")).rejects.toThrow(
      "Only Jocki metadata",
    );
    await fs.removeTree(".note.md.saddle");
    await expect(
      access(path.join(fs.root, ".note.md.saddle")),
    ).rejects.toThrow();
    expect(text.decode(await fs.read("note.md"))).toBe("ordinary file");
    expect(
      await new Companions(fs).read("other.md", "descriptor.json"),
    ).toBeDefined();
    await mkdir(path.join(directory, "outside"));
    await symlink(
      path.join(directory, "outside"),
      path.join(fs.root, ".note.md.saddle"),
    );
    await expect(fs.removeTree(".note.md.saddle")).rejects.toThrow(
      "symlink",
    );
    await access(path.join(directory, "outside"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
