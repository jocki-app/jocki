import { Companions, companionPath } from "../packages/core/vaults/companions";
import { expect, it, vi } from "vitest";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileVault, fileText } from "../packages/core/vaults/vault";
import { NodeVaultFiles } from "../packages/platform-node/vault-files";
import { Libgit2RenameMatcher } from "../packages/platform-node/vault-renames";
import { utf8 } from "../packages/core/crypto";
import { MessageChannel } from "node:worker_threads";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import {
  ProtectedFileSync,
  type ShareDocument,
} from "../packages/core/vaults/protected-sync";
import { WorkspaceStore } from "../packages/core/vaults/workspace";
import { shareLink } from "../packages/core/vaults/share-invitation";
import { MemoryStorage } from "../packages/storage";
import { testRepository } from "./fixtures/repository";
import { CompanionFiles } from "./fixtures/companion-files";
import type { VaultFileSystem } from "../packages/core/vaults/contracts";

// Model a platform granting just a file and its companion, without its parent.
function fileCapability(fs: VaultFileSystem, file: string): VaultFileSystem {
  const permitted = (path: string) =>
    path === file || path === companionPath(file);
  const check = (path: string) => {
    if (!permitted(path)) throw Error("Outside selected file");
    return path;
  };
  return {
    read: (path) => fs.read(check(path)),
    writeAtomic: (path, bytes) => fs.writeAtomic(check(path), bytes),
    remove: (path) => fs.remove(check(path)),
    list: async () => (await fs.list()).filter(permitted),
    stat: fs.stat && ((path) => fs.stat!(check(path))),
    scan:
      fs.scan &&
      (async () => (await fs.scan!()).filter((entry) => permitted(entry.path))),
  };
}

async function fixture(
  run: (
    root: string,
    open: (folder: string, cache: string, lazy?: boolean) => Promise<FileVault>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "jocki-roots-"));
  const root = path.join(directory, "tree");
  const open = async (folder: string, cache: string, lazy = true) =>
    FileVault.open(
      await NodeVaultFiles.open(path.join(root, folder)),
      "device",
      {
        local: await NodeVaultFiles.open(path.join(directory, "state", cache)),
        lazy,
        renames: new Libgit2RenameMatcher(
          path.resolve(
            "build/native-renames",
            process.platform === "win32"
              ? "Release/jocki-renames.exe"
              : "jocki-renames",
          ),
        ),
      },
    );
  try {
    await run(root, open);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("opens a nested folder independently, keeping file identity, metadata and its own history", async () =>
  fixture(async (_, open) => {
    const parent = await open("", "parent");
    await parent.createFolder("Projects");
    await parent.configureScope("folder", "Projects", { history: true });
    const id = await parent.create("Projects/note.md", utf8.encode("first"), {
      contentType: "example.note",
    });
    const draft = parent.draft(id);
    draft.text = "second";
    const saved = await parent.save(draft);
    parent.release(saved);
    await parent.flush();

    const child = await open("Projects", "child");
    expect(child.id).not.toBe(parent.id);
    expect(child.list().map((file) => file.path)).toEqual(["note.md"]);
    expect(child.find("note.md")?.id).toBe(id);
    await child.load(id);
    expect(child.contentType(id)).toBe("example.note");
    expect(
      child
        .history(id)
        .map((version) => new TextDecoder().decode(version.bytes)),
    ).toContain("first");
    const edit = child.draft(id);
    edit.text = "third";
    const result = await child.save(edit);
    child.release(result);
    const reopened = await open("", "parent-again");
    await reopened.load(id);
    expect(fileText(reopened.doc(id))).toBe("third");
    expect(
      reopened
        .history(id)
        .map((version) => new TextDecoder().decode(version.bytes)),
    ).toContain("first");
    const descriptor = await child.companions.descriptor("note.md");
    expect(descriptor?.materialized?.path).toBe("note.md");
    expect(descriptor?.materialized?.sidecar?.path).toBe("resource.json");
  }));

it("cleans unshared history no longer inherited inside a child boundary, leaving ancestors untouched", async () =>
  fixture(async (_, open) => {
    const parent = await open("", "parent");
    await parent.createFolder("Projects");
    await parent.configure({ history: true });
    const id = await parent.create("Projects/note.md", utf8.encode("first"));
    const draft = parent.draft(id);
    draft.text = "second";
    const saved = await parent.save(draft);
    parent.release(saved);
    const parentRule = await parent.companions.read("", "descriptor.json");
    await parent.flush();

    const child = await open("Projects", "child");
    const sibling = vi.spyOn(child.fs, "companionRoot");
    expect(child.policy).toEqual({ history: false, sync: false });
    expect(child.features(id)).toEqual({ history: false, sync: false });
    expect(
      await new Companions(child.fs).read("note.md", "content.automerge"),
    ).toBeUndefined();
    await child.load(id);
    expect(() => child.history(id)).toThrow("disabled");
    const edit = child.draft(id);
    edit.text = "third without parent history";
    const result = await child.save(edit);
    child.release(result);
    child.unload(id);
    expect(child.isLoaded(id)).toBe(false);
    await child.load(id);
    expect(fileText(child.doc(id))).toBe("third without parent history");
    const restartedChild = await open("Projects", "child");
    await restartedChild.load(id);
    expect(fileText(restartedChild.doc(id))).toBe(
      "third without parent history",
    );
    expect(
      await new Companions(child.fs).read("note.md", "content.automerge"),
    ).toBeUndefined();
    expect(await parent.companions.read("", "descriptor.json")).toEqual(
      parentRule,
    );
    expect(sibling.mock.calls.every((args) => args[0] !== true)).toBe(true);

    const reopened = await open("", "parent-again", false);
    const currentId = reopened.find("Projects/note.md")!.id;
    expect(fileText(reopened.doc(currentId))).toBe(
      "third without parent history",
    );
    expect(
      reopened
        .history(currentId)
        .map((version) => new TextDecoder().decode(version.bytes)),
    ).not.toContain("first");
  }));

it("uses only a selected file's own companion when the platform grants a file capability", async () =>
  fixture(async (root, open) => {
    const parent = await open("", "parent");
    await parent.configure({ history: true, sync: true });
    const id = await parent.create("Projects/note.md", utf8.encode("first"), {
      contentType: "example.note",
    });
    await parent.create("Projects/private.md", utf8.encode("private"));
    await parent.configureScope("file", id, { history: true });
    const draft = parent.draft(id);
    draft.text = "second";
    parent.release(await parent.save(draft));
    const fs = await NodeVaultFiles.open(path.join(root, "Projects"));
    const selected = await FileVault.open(
      fileCapability(fs, "note.md"),
      "device",
      { local: new CompanionFiles(), lazy: true },
    );
    expect(selected.list().map((file) => file.path)).toEqual(["note.md"]);
    expect(selected.features(id)).toEqual({ history: true, sync: false });
    await selected.load(id);
    expect(selected.contentType(id)).toBe("example.note");
    expect(
      selected
        .history(id)
        .map((version) => new TextDecoder().decode(version.bytes)),
    ).toContain("first");
    const edit = selected.draft(id);
    edit.text = "edited alone";
    selected.release(await selected.save(edit));
    const again = await open("", "parent-again");
    await again.load(id);
    expect(fileText(again.doc(id))).toBe("edited alone");
    expect(new TextDecoder().decode(await fs.read("private.md"))).toBe(
      "private",
    );
  }));

it("preserves lower overrides and retained deletions when the selected root changes", async () =>
  fixture(async (_, open) => {
    const parent = await open("", "parent");
    await parent.configure({ history: true });
    await parent.createFolder("Projects/Off");
    await parent.configureScope("folder", "Projects/Off", { history: false });
    await parent.create("Projects/Off/excluded.md", utf8.encode("ordinary"));
    const explicit = await parent.create(
      "Projects/Off/explicit.md",
      utf8.encode("retained"),
    );
    await parent.configureScope("file", explicit, { history: true });
    const deleted = await parent.create(
      "Projects/Old/deleted.md",
      utf8.encode("removed"),
    );
    await parent.configureScope("file", deleted, { history: true });
    await parent.removeFolder("Projects/Old");
    const child = await open("Projects", "child");
    const childExcluded = child.find("Off/excluded.md")!.id;
    expect(child.features(childExcluded).history).toBe(false);
    expect(child.features(explicit).history).toBe(true);
    expect(child.entry(deleted)).toMatchObject({
      path: "Old/deleted.md",
      deleted: true,
    });
    await child.load(deleted);
    expect(
      child
        .history(deleted)
        .map((version) => new TextDecoder().decode(version.bytes)),
    ).toContain("removed");
    await child.configureScope("folder", "Off", { history: undefined });
    await child.configure({ history: true });
    expect(child.features(childExcluded).history).toBe(true);
    const again = await open("", "parent-again");
    expect(again.features(childExcluded).history).toBe(true);
    expect(again.scopePolicies.folders["Projects/Off"]).toBeUndefined();
    expect(again.entry(deleted).path).toBe("Projects/Old/deleted.md");
  }));

it("does not treat companion references as invitations or accept changed unit identities", async () =>
  fixture(async (_, open) => {
    const repository = await testRepository(new MemoryStorage());
    const workspace = await WorkspaceStore.open(new CompanionFiles(), "a");
    const settings = new CompanionFiles(),
      errors: unknown[] = [];
    let sync = await ProtectedFileSync.open(
      repository,
      settings,
      workspace,
      (error) => errors.push(error),
    );
    try {
      const parent = await open("", "parent");
      await parent.create("Projects/Shared/note.md", utf8.encode("shared"));
      await sync.attach(parent);
      await sync.create(parent, "folder", "Projects/Shared");
      await sync.flush();
      await sync.close();
      const child = await open("Projects", "child");
      const fresh = await ProtectedFileSync.open(
        repository,
        new CompanionFiles(),
        workspace,
        (error) => errors.push(error),
      );
      try {
        const load = vi.spyOn(repository, "load");
        await fresh.attach(child);
        expect(await fresh.listShares()).toEqual([]);
        expect(load).not.toHaveBeenCalled();
        load.mockRestore();
      } finally {
        await fresh.close();
      }
      const descriptor = (await child.companions.descriptor("Shared"))!;
      await child.companions.describe("Shared", {
        ...descriptor,
        id: crypto.randomUUID(),
      });
      sync = await ProtectedFileSync.open(
        repository,
        settings,
        workspace,
        (error) => errors.push(error),
      );
      await expect(open("Projects", "changed")).rejects.toThrow(
        "Folder archive identity mismatch",
      );
      await child.companions.describe("Shared", descriptor);
      await child.companions.describe("Duplicate", descriptor);
      await expect(open("Projects", "duplicate")).rejects.toThrow(
        "multiple companion locations",
      );
      expect(errors).toEqual([]);
    } finally {
      await sync.close();
      await repository.close();
    }
  }));

it(
  "resumes only the shares defined inside a newly opened folder, keeping their grants and routes",
  async () =>
    fixture(async (root, open) => {
      const a = await testRepository(new MemoryStorage()),
        b = await testRepository(new MemoryStorage());
      const settings = new CompanionFiles(),
        errors: unknown[] = [];
      const workspace = await WorkspaceStore.open(new CompanionFiles(), "a");
      let one = await ProtectedFileSync.open(a, settings, workspace, (error) =>
        errors.push(error),
      );
      const two = await ProtectedFileSync.open(
        b,
        new CompanionFiles(),
        await WorkspaceStore.open(new CompanionFiles(), "b"),
        (error) => errors.push(error),
      );
      const { port1, port2 } = new MessageChannel();
      const left = a.hive.createKeyhiveNetworkAdapter(
        new MessageChannelNetworkAdapter(port1 as unknown as MessagePort),
        { periodicallyRequestSync: true, syncRequestInterval: 100 },
      );
      const right = b.hive.createKeyhiveNetworkAdapter(
        new MessageChannelNetworkAdapter(port2 as unknown as MessagePort),
        { periodicallyRequestSync: true, syncRequestInterval: 100 },
      );
      left.on("ingest-remote", () => a.repo.shareConfigChanged());
      right.on("ingest-remote", () => b.repo.shareConfigChanged());
      a.repo.networkSubsystem.addNetworkAdapter(left);
      b.repo.networkSubsystem.addNetworkAdapter(right);
      try {
        const parent = await open("", "parent");
        await parent.configure({ history: true });
        const inner = await parent.create(
          "Projects/Shared/note.md",
          utf8.encode("shared"),
        );
        const single = await parent.create(
          "Projects/direct.md",
          utf8.encode("single"),
        );
        const inherited = await parent.create(
          "Projects/loose.md",
          utf8.encode("inherited"),
        );
        const outside = await parent.create(
          "private.md",
          utf8.encode("outside"),
        );
        await one.attach(parent);
        const top = await one.create(parent, "vault");
        const folder = await one.create(parent, "folder", "Projects/Shared");
        const file = await one.create(parent, "file", "Projects/direct.md");
        await one.grant(top, b.contactCard, "edit");
        const target = await FileVault.open(new CompanionFiles(), "b");
        await two.join(shareLink(top), target);
        await one.grant(folder, b.contactCard, "edit");
        const nestedTarget = await FileVault.open(new CompanionFiles(), "b");
        await two.join(shareLink(folder), nestedTarget);
        const originalURL = (await a.load<ShareDocument>(folder.url)).doc()
          .files[inner].url;
        await one.flush();
        one.detach(parent.id);
        await one.close();
        await rename(
          path.join(root, "Projects/Shared/note.md"),
          path.join(root, "Projects/Shared/renamed.md"),
        );

        // A new manager and root index must rediscover inside scopes through their
        // companions; neither the old workspace root nor its ancestor rule is used.
        one = await ProtectedFileSync.open(a, settings, workspace, (error) =>
          errors.push(error),
        );
        const child = await open("Projects", "child");
        await one.attach(child);
        await expect
          .poll(() => nestedTarget.find("Shared/renamed.md")?.id, {
            timeout: 10000,
          })
          .toBe(inner);
        expect(child.find("Shared/note.md")).toBeUndefined();
        expect(
          (await one.listShares()).map((share) => share.invitation.url).sort(),
        ).toEqual([folder.url, file.url].sort());
        expect(child.features(inner)).toEqual({ history: false, sync: true });
        expect(child.features(inherited)).toEqual({
          history: false,
          sync: false,
        });
        expect(child.list().some((entry) => entry.id === outside)).toBe(false);
        const edit = child.draft(inner);
        edit.text = "child update";
        child.release(await child.save(edit));
        await one.flush();
        await expect
          .poll(() => target.doc(inner).text, { timeout: 10000 })
          .toBe("child update");
        expect(
          (await a.load<ShareDocument>(folder.url)).doc().files[inner],
        ).toMatchObject({ path: "renamed.md", url: originalURL });
        const direct = child.draft(single);
        direct.text = "file share update";
        child.release(await child.save(direct));
        await one.flush();
        await expect
          .poll(() => target.doc(single).text, { timeout: 10000 })
          .toBe("file share update");
        const incoming = target.draft(inner);
        incoming.text = "peer update";
        target.release(await target.save(incoming));
        await expect
          .poll(() => child.doc(inner).text, { timeout: 10000 })
          .toBe("peer update");
        const privateEdit = target.draft(outside);
        privateEdit.text = "outside peer update";
        target.release(await target.save(privateEdit));
        await two.flush();
        await one.flush();
        expect(
          new TextDecoder().decode(await parent.fs.read("private.md")),
        ).toBe("outside");
        expect(
          (await a.load<ShareDocument>(folder.url)).doc().files[inherited],
        ).toBeUndefined();

        one.detach(child.id);
        const parentAgain = await open("", "parent-again");
        await one.attach(parentAgain);
        await expect
          .poll(() => parentAgain.doc(outside).text, { timeout: 10000 })
          .toBe("outside peer update");
        expect(
          parentAgain
            .history(inner)
            .map((version) => new TextDecoder().decode(version.bytes)),
        ).toContain("shared");
        expect(
          (await one.listShares()).map((share) => share.invitation.url).sort(),
        ).toEqual([top.url, folder.url, file.url].sort());

        // A share created for an opened root must not expand when that unit later
        // appears as a child of a broader root, even though its signed kind is vault.
        one.detach(parentAgain.id);
        const sharedRoot = await open("Projects/Shared", "shared-root");
        await one.attach(sharedRoot);
        const unit = await one.create(sharedRoot, "vault");
        await one.flush();
        one.detach(sharedRoot.id);
        const broader = await open("", "broader");
        await one.attach(broader);
        await one.flush();
        expect(
          (await one.listShares()).find(
            (share) => share.invitation.url === unit.url,
          )?.prefix,
        ).toBe("Projects/Shared");
        expect(
          Object.keys((await a.load<ShareDocument>(unit.url)).doc().files),
        ).toEqual([inner]);
        expect(
          (await a.load<ShareDocument>(unit.url)).doc().files[inner].path,
        ).toBe("renamed.md");
        expect(errors).toEqual([]);
      } finally {
        left.disconnect();
        right.disconnect();
        port1.close();
        port2.close();
        await one.close();
        await two.close();
        await a.close();
        await b.close();
      }
    }),
  30000,
);

it("keeps duplicate named folders, template declarations and linked sources independent of the opened root", async () =>
  fixture(async (_, open) => {
    const parent = await open("", "parent");
    await parent.createFolder("Templates/One");
    await parent.createFolder("Templates/Two");
    await parent.setNamedPath("templates", "Templates/One", "folder");
    await parent.setNamedPath("templates", "Templates/Two", "folder");
    const source = await parent.create(
      "Templates/One/source.md",
      utf8.encode("template"),
    );
    await parent.setTemplate("Templates/One/source.md", "Example");
    const copy = await parent.create("Templates/linked.md");
    const draft = parent.draft(copy);
    draft.template = {
      file: source,
      hint: "One/source.md",
      baseline: "template",
    };
    parent.release(await parent.save(draft));
    expect(await parent.companions.descriptor("")).toBeUndefined();
    expect(await parent.companions.descriptor("Templates")).toBeUndefined();
    const child = await open("Templates", "fresh");
    expect(
      Object.values(child.namedPaths)
        .filter((item) => item.key === "templates")
        .map((item) => item.path)
        .sort(),
    ).toEqual(["One", "Two"]);
    expect(child.templates["One/source.md"]).toMatchObject({
      name: "Example",
      enabled: true,
    });
    expect(child.find("One/source.md")?.id).toBe(source);
    await child.load(copy);
    expect(child.doc(copy).template).toEqual({
      file: source,
      hint: "One/source.md",
      baseline: "template",
    });
    const sourceIdentity = (await child.companions.descriptor("One/source.md"))!
      .id;
    await child.move(source, "Two/renamed.md");
    expect((await child.companions.descriptor("Two/renamed.md"))!.id).toBe(
      sourceIdentity,
    );
    const again = await open("", "fresh-parent");
    expect(again.find("Templates/Two/renamed.md")?.id).toBe(source);
    expect(again.templates["Templates/Two/renamed.md"]?.name).toBe("Example");
  }));

for (const hadHistory of [false, true])
  it(`recognizes metadata-only renames with edits using a portable baseline and an empty device cache (previous history: ${hadHistory})`, async () =>
    fixture(async (root, open) => {
      const vault = await open("", "old");
      const original = Array.from(
        { length: 100 },
        (_, i) => `line ${i}: content that libgit2 can match\n`,
      ).join("");
      const id = await vault.create("old.md", utf8.encode(original), {
        contentType: "example.note",
      });
      if (hadHistory) {
        await vault.configureScope("file", id, { history: true });
        await vault.configureScope("file", id, { history: false, sync: false });
      }
      expect(
        await vault.companions.read("old.md", "content.automerge"),
      ).toBeUndefined();
      expect(
        await vault.companions.read("old.md", "baseline.bin"),
      ).toBeDefined();
      await rename(path.join(root, "old.md"), path.join(root, "new.md"));
      await vault.fs.writeAtomic(
        "new.md",
        utf8.encode(original.replace("line 20:", "line twenty:")),
      );
      const fresh = await open("", "empty-cache");
      expect(fresh.find("new.md")?.id).toBe(id);
      await fresh.load(id);
      expect(fresh.contentType(id)).toBe("example.note");
      expect(fileText(fresh.doc(id))).toContain("line twenty:");
    }));

it("stores folder declarations and history in that folder's binary companion", async () =>
  fixture(async (_, open) => {
    const vault = await open("", "one");
    await vault.createFolder("Templates");
    await vault.configureScope("folder", "Templates", { history: true });
    await vault.setNamedPath("templates", "Templates", "folder");
    await vault.folderSnapshots("Templates");
    expect(await vault.companions.descriptor("")).toBeUndefined();
    const child = await open("Templates", "empty-cache");
    expect(Object.values(child.namedPaths)).toContainEqual(
      expect.objectContaining({ key: "templates", path: "" }),
    );
    expect(child.folderHistory("").length).toBeGreaterThan(1);
    await child.configure({ history: false, sync: false });
    expect(await child.companions.read("", "folder.automerge")).toBeUndefined();
    expect((await child.companions.descriptor(""))?.namedKeys).toEqual([
      "templates",
    ]);
  }));

it("follows offline folder moves for named folders without explicit feature overrides", async () =>
  fixture(async (root, open) => {
    const original = await open("", "original");
    await original.createFolder("Templates");
    await original.setNamedPath("templates", "Templates", "folder");
    const id = await original.create(
      "Templates/source.md",
      utf8.encode("portable template"),
    );
    await original.setTemplate("Templates/source.md", "Example");
    const folderId = (await original.companions.descriptor("Templates"))!.id;
    await rename(path.join(root, "Templates"), path.join(root, "Moved"));
    const fresh = await open("", "fresh");
    expect(fresh.find("Moved/source.md")?.id).toBe(id);
    expect((await fresh.companions.descriptor("Moved"))?.id).toBe(folderId);
    expect(await fresh.companions.descriptor("Templates")).toBeUndefined();
    expect(Object.values(fresh.namedPaths)).toContainEqual(
      expect.objectContaining({
        id: folderId,
        key: "templates",
        path: "Moved",
      }),
    );
    expect(fresh.templates["Moved/source.md"]?.name).toBe("Example");
  }));
