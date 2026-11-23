import { CompanionFiles } from "./fixtures/companion-files";
import { describe, it, expect } from "vitest";
import * as A from "@automerge/automerge";
import { FileVault, fileText } from "../packages/core/vaults/vault";
import { VaultEditors } from "../packages/core/vaults/editors";
import { FileExtensionHost } from "../packages/platform/src/file-sdk/host";
import {
  WorkspaceStore,
  resolveSettings,
  patchSettings,
} from "../packages/core/vaults/workspace";
import {
  filePath,
  type VaultFileSystem,
} from "../packages/core/vaults/contracts";
import { Libgit2RenameMatcher } from "../packages/platform-node/vault-renames";
import path from "node:path";
const renames = new Libgit2RenameMatcher(
  path.resolve(
    "build/native-renames",
    process.platform === "win32"
      ? "Release/jocki-renames.exe"
      : "jocki-renames",
  ),
);
import { CSDBDraft, parseCSDB } from "../packages/core/vaults/csdb";
import { text, utf8 } from "../packages/core/crypto";
import { VaultSearch } from "../packages/core/vaults/search";
import { field } from "@jocki/platform/field-types";
import {
  normalizeView,
  type CollectionViewState,
} from "../packages/ui/collection-view-model";

class MemoryFiles extends CompanionFiles {}
describe("file vault durable drafts", () => {
  it("keeps independent view drafts private and merges their explicitly saved changes", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const id = await vault.create("note.md", utf8.encode("first\nsecond\n"));
    let editors: VaultEditors;
    const host = new FileExtensionHost({
      folders: () => [],
      documents: () => editors.documents(),
      updateDocument: async () => {},
      getConfiguration: () => undefined,
      updateConfiguration: async () => {},
    });
    editors = new VaultEditors(new Map([[vault.id, vault]]), host);
    const first = await editors.open(vault.id, id),
      second = await editors.open(vault.id, id, "other-view");
    expect(await editors.open(vault.id, id, "other-view")).toBe(second);
    expect(first.draft).not.toBe(second.draft);
    first.draft.text = first.draft.text.replace("first", "first local");
    editors.changed(vault.id, id);
    expect(second.draft.text).toBe("first\nsecond\n");
    second.draft.text = second.draft.text.replace("second", "second elsewhere");
    editors.changed(vault.id, id, "edit", "other-view");
    await editors.save(vault.id, id, "other-view");
    expect(editors.snapshot(vault.id, id).dirty).toBe(true);
    expect(fileText(vault.doc(id))).toBe("first\nsecond elsewhere\n");
    await editors.save(vault.id, id);
    expect(fileText(vault.doc(id))).toBe("first local\nsecond elsewhere\n");
    await editors.close(vault.id, id, true, "other-view");
    expect(editors.snapshot(vault.id, id).text).toBe(
      "first local\nsecond elsewhere\n",
    );
    await host.dispose();
  });
  it("keeps drafts private, survives restart, merges concurrent saves", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const id = await vault.create(
      "notes.md",
      utf8.encode("# Notes\n\nfirst\nlast\n"),
    );
    const a = vault.draft(id),
      b = vault.draft(id);
    a.text = a.text.replace("first", "first local");
    b.text = b.text.replace("last", "last remote");
    expect(text.decode((await fs.read("notes.md"))!)).not.toContain("local");
    expect(vault.doc(id).text).not.toContain("local");
    await vault.save(a);
    await vault.save(b);
    const restarted = await FileVault.open(fs, "one");
    expect(restarted.doc(id).text).toContain("first local");
    expect(restarted.doc(id).text).toContain("last remote");
    expect(restarted.list()).toHaveLength(1);
  });
  it("does not acknowledge a failed save and can retry materialization", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const id = await vault.create("note.md", utf8.encode("old"));
    const draft = vault.draft(id);
    draft.text = "new";
    fs.fail = "note.md";
    await expect(vault.save(draft)).rejects.toThrow("Disk full");
    expect(draft.dirty).toBe(true);
    expect(text.decode((await fs.read("note.md"))!)).toBe("old");
    fs.fail = undefined;
    const reopened = await FileVault.open(fs, "one");
    expect(reopened.doc(id).text).toBe("new");
    expect(text.decode((await fs.read("note.md"))!)).toBe("new");
  });
  it("reconciles external edits against checkpoint heads, retaining remote edits", async () => {
    const fs = new MemoryFiles(),
      one = await FileVault.open(fs, "one");
    const id = await one.create("note.md", utf8.encode("first\nlast\n"));
    await one.configure({ sync: true });
    const otherFiles = fs.clone(),
      two = await FileVault.open(otherFiles, "two");
    const remote = two.draft(id);
    remote.text = "first\nlast remote\n";
    await two.save(remote);
    // Incoming CRDT state is durable before a process dies during materialization.
    fs.fail = "note.md";
    await expect(
      one.receiveDocument(id, two.exportDocument(id)),
    ).rejects.toThrow();
    fs.fail = undefined;
    await fs.writeAtomic("note.md", utf8.encode("first local\nlast\n"));
    const reopened = await FileVault.open(fs, "one");
    expect(reopened.doc(id).text).toBe("first local\nlast remote\n");
  });
  it("tracks an external rename and creates a new identity when the old path is reused", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one", { renames });
    const id = await vault.create("old.md", utf8.encode("hello"));
    fs.files.set("folder/new.md", fs.files.get("old.md")!);
    fs.files.delete("old.md");
    await vault.reconcile();
    expect(vault.find("folder/new.md")?.id).toBe(id);
    await fs.writeAtomic("old.md", utf8.encode("another file"));
    await vault.reconcile();
    expect(vault.find("old.md")?.id).not.toBe(id);
    expect(vault.doc(id).text).toBe("hello");
  });
  it("keeps history independent from sync and recovery creates an unsaved draft", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const id = await vault.create("note.md", utf8.encode("old"));
    expect(() => vault.history(id)).toThrow("disabled");
    await vault.configure({ history: true });
    expect(vault.policy.sync).toBe(false);
    const draft = vault.draft(id);
    draft.text = "new";
    await vault.save(draft);
    const restored = vault.restore(id, vault.history(id)[0].heads);
    expect(restored.text).toBe("old");
    expect(restored.dirty).toBe(true);
    expect(vault.doc(id).text).toBe("new");
  });
  it("recovers retained deleted files to new identities without overwriting reused paths", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    await vault.configure({ history: true });
    const id = await vault.create(
      "deleted.md",
      utf8.encode("original contents"),
    );
    const heads = vault.history(id)[0].heads;
    await vault.remove(id);
    const replacement = await vault.create(
      "deleted.md",
      utf8.encode("new private contents"),
    );
    expect(vault.deletedFiles().map((file) => file.id)).toEqual([id]);
    await expect(vault.recoverCopy(id, "deleted.md", heads)).rejects.toThrow(
      "exists",
    );
    const recovered = await vault.recoverCopy(id, "recovered.md", heads);
    expect(recovered).not.toBe(id);
    expect(vault.doc(recovered).text).toBe("original contents");
    expect(vault.doc(replacement).text).toBe("new private contents");
    expect(vault.entry(id).deleted).toBe(true);
    await vault.configure({ history: false });
    expect(vault.deletedFiles()).toEqual([]);
    expect(() => vault.recoverCopy(id, "another.md", heads)).toThrow(
      "disabled",
    );
  });
  it("preserves concurrent binary values as CRDT conflicts", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const id = await vault.create("photo.png", new Uint8Array([1]));
    const a = vault.draft(id),
      b = vault.draft(id);
    a.bytes = new Uint8Array([2]);
    b.bytes = new Uint8Array([3]);
    await vault.save(a);
    await vault.save(b);
    expect(Object.values(A.getConflicts(vault.doc(id), "bytes")!)).toHaveLength(
      2,
    );
  });
  it("merges CSDB edits to separate fields of the same row as independent values", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const value = `--- csdb\nformat: CSDB\nversion: 2\nname: Tasks\nschemas: [public]\ntables: [public.tasks]\n\n--- schema:public\nname: public\ntypes: {}\n\n--- table:public:tasks\nschema: public\nname: tasks\ncolumns: {id: text, uid: text, dtstamp: timestamp, title: text, status: {type: enum, options: [open, in-progress, done, cancelled]}}\nrequired: [id, uid, dtstamp]\nprimary_key: {columns: [id]}\n\n--- data:tasks\nid,uid,dtstamp,title,status\n1,u1,2026-01-01T00:00:00Z,Milk,open\n`;
    const id = await vault.create("tasks.csdb", utf8.encode(value));
    const a = vault.draft(id),
      b = vault.draft(id);
    const left = new CSDBDraft(a.text),
      right = new CSDBDraft(b.text);
    left.sql("UPDATE public.tasks SET title = ? WHERE id = ?", [
      "Milk and bread",
      "1",
    ]);
    right.sql("UPDATE public.tasks SET status = ? WHERE id = ?", ["done", "1"]);
    a.text = left.toString();
    b.text = right.toString();
    await vault.save(a);
    await vault.save(b);
    const parsed = parseCSDB(text.decode((await fs.read("tasks.csdb"))!));
    expect(parsed.tables.get("public.tasks")!.rows).toEqual([
      {
        id: "1",
        uid: "u1",
        dtstamp: "2026-01-01T00:00:00Z",
        title: "Milk and bread",
        status: "done",
      },
    ]);
  });
  it("prunes history-off local documents while preserving a live state and clean drafts", async () => {
    const vault = await FileVault.open(new MemoryFiles(), "one");
    const id = await vault.create("note.md", utf8.encode("initial"));
    let draft = vault.draft(id);
    draft.text = "edited";
    draft = await vault.save(draft);
    vault.release(draft);
    await vault.compactLocal(id);
    expect(A.getHistory(vault.doc(id))).toHaveLength(1);
    expect(draft.dirty).toBe(false);
    expect(vault.doc(id).epoch).toBe(1);
    expect(vault.doc(id).text).toBe("edited");
  });
  it("preserves edits typed while a durable Save is in progress", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const id = await vault.create("note.md", utf8.encode("initial"));
    let release!: () => void;
    const write = fs.writeAtomic.bind(fs);
    let writing!: () => void;
    const started = new Promise<void>((resolve) => {
      writing = resolve;
    });
    fs.writeAtomic = async (path, bytes) => {
      if (path === "note.md") {
        writing();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await write(path, bytes);
    };
    const draft = vault.draft(id);
    draft.text = "submitted";
    const save = vault.save(draft);
    await started;
    draft.text = "submitted, then more typing";
    release();
    const ongoing = await save;
    expect(text.decode((await fs.read("note.md"))!)).toBe("submitted");
    expect(ongoing.text).toBe("submitted, then more typing");
    expect(ongoing.dirty).toBe(true);
  });
  it("requires a durable freeze token and rebases unsaved drafts across a checkpoint", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "one");
    const id = await vault.create("note.md", utf8.encode("first\nlast\n"));
    await vault.configure({ sync: true });
    const other = await FileVault.open(fs.clone(), "two");
    const heads = A.getHeads(vault.doc(id));
    expect(await vault.freezeHistory(id, "barrier", heads)).toBe(true);
    expect(await other.freezeHistory(id, "barrier", heads)).toBe(true);
    const draft = other.draft(id);
    draft.text = "first private\nlast\n";
    await expect(other.save(draft)).rejects.toThrow("checkpoint");
    await expect(
      vault.checkpointHistory(id, heads, "wrong-token"),
    ).rejects.toThrow();
    await vault.checkpointHistory(id, heads, "barrier");
    await Promise.all([
      other.acceptCheckpoint(id, vault.exportDocument(id), "barrier"),
      other.acceptCheckpoint(id, vault.exportDocument(id), "barrier"),
    ]);
    expect(draft.dirty).toBe(true);
    await other.save(draft);
    expect(other.doc(id).text).toBe("first private\nlast\n");
  });
});
describe("workspace settings and paths", () => {
  it("updates only changed preference leaves and skips durable writes for unchanged settings", async () => {
    const fs = new MemoryFiles(),
      store = await WorkspaceStore.open(fs, "computer-a");
    const original = {
      groups: [{ id: "status", field: "status", enabled: true }],
      query: { filters: [], sorts: [] },
      collapsed: [],
    };
    await store.update((d) => {
      d.defaults.plugins["core.csdb"] = { views: { file: original } };
    });
    const before = (store.current.defaults.plugins["core.csdb"] as any).views
      .file;
    const groupId = A.getObjectId(before.groups[0]),
      queryId = A.getObjectId(before.query);
    let writes = 0;
    const write = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path, bytes) => {
      writes++;
      await write(path, bytes);
    };
    await store.update((d) =>
      patchSettings(
        (d.defaults.plugins["core.csdb"] as any).views.file,
        original,
      ),
    );
    expect(writes).toBe(0);
    await store.update((d) =>
      patchSettings((d.defaults.plugins["core.csdb"] as any).views.file, {
        ...original,
        groups: [{ ...original.groups[0], enabled: false }],
      }),
    );
    const after = (store.current.defaults.plugins["core.csdb"] as any).views
      .file;
    expect(A.getObjectId(after.groups[0])).toBe(groupId);
    expect(A.getObjectId(after.query)).toBe(queryId);
    expect(
      A.decodeChange(A.getLastLocalChange(store.current as A.Doc<any>)!).ops,
    ).toHaveLength(1);
    expect(writes).toBe(1);
    const reopened = await WorkspaceStore.open(fs, "computer-a");
    expect(
      (reopened.current.defaults.plugins["core.csdb"] as any).views.file
        .groups[0].enabled,
    ).toBe(false);
  });
  it("persists grouping changes and cleared optional preferences through Automerge and restart", async () => {
    const fs = new MemoryFiles(),
      workspace = await WorkspaceStore.open(fs, "computer-a"),
      schema = {
        id: "public.tasks",
        name: "Tasks",
        pluginId: "tasks",
        version: 1,
        fields: [
          field("title", "Title"),
          field("status", "Status"),
          field("due_at", "Due", "timestamp without time zone"),
        ],
      };
    let view = normalizeView(undefined, schema);
    await workspace.update((d) => {
      d.computers["computer-a"].plugins = { "core.csdb": { views: {} } };
    });
    const patches: Partial<CollectionViewState>[] = [
      { groups: [{ id: "status", field: "status", enabled: true }] },
      {
        groups: [
          {
            id: "status",
            field: "status",
            enabled: true,
            labelField: "title",
            mode: "individual",
          },
        ],
      },
      {
        groups: [
          {
            id: "status",
            field: "status",
            enabled: false,
            labelField: undefined,
            materialize: false,
          },
        ],
      },
      {
        dateField: "due_at",
        query: {
          filters: [
            {
              id: "filter",
              field: "status",
              operator: "eq",
              value: null,
              link: "and",
              enabled: true,
            },
          ],
          sorts: [{ field: "title", direction: "asc", enabled: true }],
        },
      },
      {
        groups: [],
        dateField: undefined,
        query: { filters: undefined, sorts: undefined },
      },
    ];
    for (const patch of patches) {
      view = normalizeView({ ...view, ...patch }, schema);
      await workspace.update((d) => {
        const section = d.computers["computer-a"].plugins!["core.csdb"] as {
          views: Record<string, CollectionViewState>;
        };
        section.views["vault/file"] = view;
      });
      const reopened = await WorkspaceStore.open(fs, "computer-a");
      const stored = reopened.settings("computer-a").plugins["core.csdb"] as {
        views: Record<string, CollectionViewState>;
      };
      expect(stored.views["vault/file"]).toEqual(view);
    }
    expect(view.query).toEqual({});
    expect(view).not.toHaveProperty("dateField");
  });
  it("does not rewrite document checkpoints or indexes when a scan finds no changes", async () => {
    const fs = new MemoryFiles(),
      vault = await FileVault.open(fs, "a");
    await vault.create("note.md", utf8.encode("Stable content"));
    const index = new VaultSearch();
    await index.update(vault);
    let writes = 0,
      events = 0;
    const write = fs.writeAtomic.bind(fs);
    fs.writeAtomic = async (path, bytes) => {
      writes++;
      await write(path, bytes);
    };
    vault.subscribe(() => events++);
    await vault.reconcile();
    await index.update(vault);
    expect(writes).toBe(0);
    expect(events).toBe(0);
  });
  it("indexes all vaults, phrases, tags, binary names and extractor text without cross-vault index leakage", async () => {
    const fsA = new MemoryFiles(),
      fsB = new MemoryFiles(),
      a = await FileVault.open(fsA, "a"),
      b = await FileVault.open(fsB, "b");
    const id = await a.create(
      "milk.md",
      utf8.encode("Buy fresh milk\n#shopping/food"),
    );
    await b.create(
      "private.md",
      utf8.encode("Confidential second-vault words"),
    );
    await a.create("photo.png", new Uint8Array([137, 80, 78, 71]));
    const search = new VaultSearch(async (doc) =>
      doc.path === "photo.png" ? "extracted image caption" : "",
    );
    await Promise.all([search.update(a), search.update(b)]);
    expect(
      search.search('"fresh milk" metadata:shopping').map((hit) => hit.file.id),
    ).toEqual([id]);
    expect(
      search.search("caption mime:image/png").map((hit) => hit.file.path),
    ).toEqual(["photo.png"]);
    expect(search.search("Confidential -path:milk")).toHaveLength(1);
    expect(
      text.decode((await a.local.read("cache/index/search.json"))!),
    ).not.toContain("confidential");
    await a.move(id, "groceries.md");
    await search.update(a);
    expect(search.search("groceries").map((hit) => hit.file.id)).toEqual([id]);
    await a.remove(id);
    await search.update(a);
    expect(search.search("milk")).toEqual([]);
  });
  it("creates null computer overrides and permits shared editing of other computers", async () => {
    const workspace = await WorkspaceStore.open(
      new MemoryFiles(),
      "computer-a",
    );
    expect(workspace.current.computers["computer-a"].vim).toBeNull();
    await workspace.update((d) => {
      d.defaults.vim = true;
      d.computers["computer-b"] = { ...d.computers["computer-a"], vim: false };
    });
    expect(resolveSettings(workspace.current, "computer-a").vim).toBe(true);
    expect(resolveSettings(workspace.current, "computer-b").vim).toBe(false);
  });
  it("inherits nested defaults while preserving one computer's individual overrides", async () => {
    const workspace = await WorkspaceStore.open(
      new MemoryFiles(),
      "computer-a",
    );
    await workspace.update((d) => {
      d.defaults.hotkeys = { save: "Mod+s", search: "Mod+f" };
      d.computers["computer-a"].hotkeys = { save: null, search: "F3" };
      d.computers["computer-a"].layout = { split: true, tabs: null };
    });
    expect(workspace.settings("computer-a").hotkeys).toEqual({
      save: "Mod+s",
      search: "F3",
    });
    expect(workspace.settings("computer-a").layout).toMatchObject({
      tabs: [],
      split: true,
      bookmarks: [],
    });
    await workspace.update((d) => {
      d.defaults.hotkeys.save = "F2";
    });
    expect(workspace.settings("computer-a").hotkeys.save).toBe("F2");
    await expect(
      workspace.update((d) => {
        (d.defaults as unknown as { vim: string }).vim = "invalid";
      }),
    ).rejects.toThrow();
    expect(workspace.settings("computer-a").vim).toBe(false);
  });
  it.each([
    "/etc/passwd",
    "../secret",
    "a/../b",
    "a\\b",
    ".saddle/documents/x",
    "a/.SADDLE/x",
    "a//b",
    "C:/x",
  ])("rejects %s", (path) => {
    expect(() => filePath(path)).toThrow();
  });
  it("does not guess among duplicate content matches", async () => {
    const bytes = utf8.encode("same");
    const matches = await renames.match(
      [
        { path: "a", bytes },
        { path: "b", bytes },
      ],
      [{ path: "c", bytes }],
    );
    expect(matches).toEqual([]);
  });
});
