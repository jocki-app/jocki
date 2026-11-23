import { CompanionFiles } from "./fixtures/companion-files";
import { expect, it, vi } from "vitest";
import * as A from "@automerge/automerge";
import { FileVault, fileText } from "../packages/core/vaults/vault";
import { textChangeSize } from "../packages/core/vaults/history";
import { CSDBDraft, parseCSDB } from "../packages/core/vaults/csdb";
import { text, utf8 } from "../packages/core/crypto";
import type { VaultFileSystem } from "../packages/core/vaults/contracts";
import { VaultEditors } from "../packages/core/vaults/editors";
import { FileExtensionHost } from "../packages/platform/src/file-sdk/host";

class Files extends CompanionFiles {}
it("counts actual character replacements and Unicode without treating equal sizes as unchanged", () => {
  expect(textChangeSize("one cat\nlast", "one dog\nlast")).toEqual({
    added: 3,
    removed: 3,
  });
  expect(textChangeSize("🦖a", "🦖b")).toEqual({ added: 1, removed: 1 });
  expect(textChangeSize("a 🦖 tail", "a tail")).toEqual({
    added: 0,
    removed: 2,
  });
  expect(textChangeSize("same", "same")).toEqual({ added: 0, removed: 0 });
});
it("stores descriptions in native Automerge change messages, including named checkpoints, and survives restart", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("note.md", utf8.encode("old"));
  let draft = vault.draft(id);
  draft.text = "new";
  draft = await vault.save(draft, "Explain this revision");
  const change = A.getAllChanges(vault.doc(id)).map(A.decodeChange).at(-1)!;
  expect(change.message).toBe("Save file\n\nExplain this revision");
  const first = vault.history(id);
  expect(first.at(-1)).toMatchObject({
    description: "Explain this revision",
    event: "Save file",
    changes: { added: 3, removed: 3 },
  });
  first.reverse();
  expect(vault.history(id).at(-1)?.hash).toBe(change.hash);
  await vault.save(draft, "Approved checkpoint");
  expect(vault.history(id)).toHaveLength(3);
  expect(vault.history(id).at(-1)).toMatchObject({
    description: "Approved checkpoint",
    changes: { added: 0, removed: 0 },
  });
  const reopened = await FileVault.open(fs, "one");
  expect(reopened.history(id).at(-1)?.description).toBe("Approved checkpoint");
  expect(text.decode((await fs.read("note.md"))!)).toBe("new");
  expect(reopened.doc(id)).not.toHaveProperty("description");
});

it("labels enabling retention separately from the initial file creation", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  const id = await vault.create("note.md", utf8.encode("example"));
  await vault.configureScope("file", id, { history: true });
  expect(vault.history(id).map((version) => version.event)).toEqual([
    "File created",
    "Enable history",
  ]);
  expect(vault.history(id).at(-1)?.changes).toEqual({ added: 0, removed: 0 });
  const reopened = await FileVault.open(fs, "one");
  expect(
    reopened.history(id).filter((version) => version.event === "File created"),
  ).toHaveLength(1);
});

function taskFile() {
  const db = CSDBDraft.create("Tasks");
  db.createSchema("public");
  db.createTable({
    schema: "public",
    name: "tasks",
    columns: { id: "text", title: "text", notes: "text" },
    required: ["id"],
    primary_key: { columns: ["id"] },
  });
  db.table("public.tasks").insert([
    { id: "a", title: "A", notes: "" },
    { id: "b", title: "B", notes: "" },
    { id: "c", title: "C", notes: "" },
  ]);
  return db.toString();
}
function changeRows(value: string, patch: Record<string, string>) {
  const db = new CSDBDraft(value);
  for (const [id, title] of Object.entries(patch))
    db.execute({
      kind: "update",
      table: "public.tasks",
      set: { title },
      where: {
        type: "comparison",
        op: "=",
        left: { type: "identifier", name: "id" },
        right: { type: "literal", value: id },
      },
    });
  return db.toString();
}
const titles = (value: string) =>
  parseCSDB(value)
    .tables.get("public.tasks")!
    .rows.map((row) => row.title);
it("replays structured task edits and metadata together, persisting one fresh history on reset", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()), {
    resource: {
      name: "tasks",
      path: "tasks.csdb",
      metadata: { owner: "original" },
    },
  });
  const edit = async (patch: Record<string, string>, owner?: string) => {
    const draft = vault.draft(id);
    draft.text = changeRows(draft.text, patch);
    if (owner) draft.resource!.metadata = { owner };
    vault.release(await vault.save(draft));
    vault.release(draft);
  };
  await edit({ a: "Removed" }, "removed");
  const hash = A.getHeads(vault.doc(id))[0];
  await edit({ b: "Kept" });
  await vault.rewriteFileHistory(id, { kind: "drop", hash });
  expect(titles(text.decode((await fs.read("tasks.csdb"))!))).toEqual([
    "A",
    "Kept",
    "C",
  ]);
  expect(vault.doc(id).resource!.metadata).toEqual({ owner: "original" });
  expect(vault.history(id)).toHaveLength(2);
  await vault.rewriteFileHistory(id, { kind: "reset", time: 100 });
  const reopened = await FileVault.open(fs, "one");
  expect(reopened.history(id)).toHaveLength(1);
  expect(reopened.history(id)[0].event).toBe("File created");
  expect(titles(fileText(reopened.doc(id)))).toEqual(["A", "Kept", "C"]);
});
it("rejects invalid replay and unseen external edits before replacing any saved history", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()));
  const creation = A.getHeads(vault.doc(id))[0];
  const draft = vault.draft(id);
  draft.text = changeRows(draft.text, { a: "Later" });
  vault.release(await vault.save(draft));
  vault.release(draft);
  const heads = A.getHeads(vault.doc(id));
  const saved = await fs.read("tasks.csdb");
  await expect(
    vault.rewriteFileHistory(id, { kind: "drop", hash: creation }),
  ).rejects.toThrow();
  expect(A.getHeads(vault.doc(id))).toEqual(heads);
  expect(await fs.read("tasks.csdb")).toEqual(saved);
  await fs.writeAtomic("tasks.csdb", utf8.encode(taskFile()));
  await expect(
    vault.rewriteFileHistory(id, { kind: "reset", time: 100 }),
  ).rejects.toThrow("Reconcile external edits");
  expect(A.getHeads(vault.doc(id))).toEqual(heads);
});
it("saves selected tasks as one commit while keeping other tasks and metadata in the private draft", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()));
  let draft = vault.draft(id);
  draft.text = changeRows(draft.text, {
    a: "A edited",
    b: "B edited",
    c: "C edited",
  });
  draft.resource = {
    name: "tasks",
    path: "tasks.csdb",
    metadata: { private: "unsaved" },
  };
  draft = await vault.save(draft, "First two tasks", {
    table: "public.tasks",
    ids: ["a", "b"],
  });
  expect(titles(fileText(vault.doc(id)))).toEqual([
    "A edited",
    "B edited",
    "C",
  ]);
  expect(titles(text.decode((await fs.read("tasks.csdb"))!))).toEqual([
    "A edited",
    "B edited",
    "C",
  ]);
  expect(vault.doc(id).resource).toBeNull();
  expect(draft.dirty).toBe(true);
  expect(titles(draft.text)).toEqual(["A edited", "B edited", "C edited"]);
  expect(vault.history(id).at(-1)?.description).toBe("First two tasks");
  draft = await vault.save(draft, "Third task", {
    table: "public.tasks",
    ids: ["c"],
  });
  expect(titles(fileText(vault.doc(id)))).toEqual([
    "A edited",
    "B edited",
    "C edited",
  ]);
  expect(draft.dirty).toBe(true); // resource metadata is still private.
  expect(vault.doc(id).resource).toBeNull();
  await vault.save(draft);
  expect(vault.doc(id).resource?.metadata).toEqual({ private: "unsaved" });
});
it("preserves concurrent saved tasks when completing the remaining selected saves", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()));
  let local = vault.draft(id);
  const other = vault.draft(id);
  local.text = changeRows(local.text, { a: "A local", b: "B local" });
  other.text = changeRows(other.text, { c: "C elsewhere" });
  await vault.save(other);
  local = await vault.save(local, "A", { table: "public.tasks", ids: ["a"] });
  expect(titles(fileText(vault.doc(id)))).toEqual([
    "A local",
    "B",
    "C elsewhere",
  ]);
  local = await vault.save(local, "B", { table: "public.tasks", ids: ["b"] });
  expect(local.dirty).toBe(false);
  expect(titles(local.text)).toEqual(["A local", "B local", "C elsewhere"]);
  const reopened = await FileVault.open(fs, "one");
  expect(titles(fileText(reopened.doc(id)))).toEqual([
    "A local",
    "B local",
    "C elsewhere",
  ]);
});

it("persists selected task creation and deletion without publishing another new task", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()));
  const draft = vault.draft(id),
    working = new CSDBDraft(draft.text);
  working.execute({
    kind: "delete",
    table: "public.tasks",
    where: {
      type: "comparison",
      op: "=",
      left: { type: "identifier", name: "id" },
      right: { type: "literal", value: "a" },
    },
  });
  working.table("public.tasks").insert([
    { id: "d", title: "D saved", notes: "" },
    { id: "e", title: "E private", notes: "" },
  ]);
  draft.text = working.toString();
  const ongoing = await vault.save(draft, "Replace one task", {
    table: "public.tasks",
    ids: ["a", "d"],
  });
  expect(titles(text.decode((await fs.read("tasks.csdb"))!))).toEqual([
    "B",
    "C",
    "D saved",
  ]);
  expect(titles(ongoing.text)).toEqual(["B", "C", "D saved", "E private"]);
  expect(ongoing.dirty).toBe(true);
  const reopened = await FileVault.open(fs, "one");
  expect(titles(fileText(reopened.doc(id)))).toEqual(["B", "C", "D saved"]);
});

it("serializes selected editor saves and retains typing that arrives during durable persistence", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()));
  let editors: VaultEditors;
  const host = new FileExtensionHost({
    folders: () => [],
    documents: () => editors.documents(),
    updateDocument: async () => {},
    getConfiguration: () => undefined,
    updateConfiguration: async () => {},
  });
  editors = new VaultEditors(new Map([[vault.id, vault]]), host);
  const session = await editors.open(vault.id, id);
  session.draft.text = changeRows(session.draft.text, {
    a: "A saved",
    b: "B saved",
  });
  editors.changed(vault.id, id);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
  const write = fs.writeAtomic.bind(fs);
  vi.spyOn(fs, "writeAtomic").mockImplementation(async (path, bytes) => {
    if (path === "tasks.csdb") {
      started();
      await blocked;
    }
    await write(path, bytes);
  });
  const first = editors.save(vault.id, id, undefined, "First row", {
    table: "public.tasks",
    ids: ["a"],
  });
  const second = editors.save(vault.id, id, undefined, "Second row", {
    table: "public.tasks",
    ids: ["b"],
  });
  await waiting;
  session.draft.text = changeRows(session.draft.text, {
    a: "A newer draft",
    c: "C private",
  });
  editors.changed(vault.id, id);
  expect(() => editors.discard(vault.id, id)).toThrow(
    "Wait for the current save",
  );
  expect(titles(text.decode((await fs.read("tasks.csdb"))!))).toEqual([
    "A",
    "B",
    "C",
  ]);
  release();
  await Promise.all([first, second]);
  expect(titles(fileText(vault.doc(id)))).toEqual(["A saved", "B saved", "C"]);
  expect(titles(session.draft.text)).toEqual([
    "A newer draft",
    "B saved",
    "C private",
  ]);
  expect(session.draft.dirty).toBe(true);
  expect(
    vault
      .history(id)
      .slice(-2)
      .map((row) => row.description),
  ).toEqual(["First row", "Second row"]);
  await editors.close(vault.id, id, true);
  await host.dispose();
});

it("keeps failed selected saves retryable without saving other task drafts", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()));
  const draft = vault.draft(id);
  draft.text = changeRows(draft.text, { a: "A edited", b: "B private" });
  const write = fs.writeAtomic.bind(fs);
  const spy = vi
    .spyOn(fs, "writeAtomic")
    .mockImplementation(async (path, bytes) => {
      if (path === "tasks.csdb") throw Error("Disk full");
      await write(path, bytes);
    });
  await expect(
    vault.save(draft, "A revision", { table: "public.tasks", ids: ["a"] }),
  ).rejects.toThrow("Disk full");
  expect(draft.dirty).toBe(true);
  expect(titles(text.decode((await fs.read("tasks.csdb"))!))).toEqual([
    "A",
    "B",
    "C",
  ]);
  spy.mockRestore();
  const ongoing = await vault.save(draft, "A revision", {
    table: "public.tasks",
    ids: ["a"],
  });
  expect(ongoing.dirty).toBe(true);
  expect(titles(text.decode((await fs.read("tasks.csdb"))!))).toEqual([
    "A edited",
    "B",
    "C",
  ]);
  expect(titles(ongoing.text)).toEqual(["A edited", "B private", "C"]);
});

it("persists portable view metadata with a header save while leaving unselected task edits private", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  const id = await vault.create("tasks.csdb", utf8.encode(taskFile()));
  let draft = vault.draft(id);
  draft.text = changeRows(draft.text, { a: "A saved", b: "B private" });
  draft.resource = {
    name: "tasks",
    path: "tasks.csdb",
    jocki: { collectionView: { mode: "cards" } },
  };
  draft = await vault.save(draft, "", {
    table: "public.tasks",
    ids: ["a"],
    metadata: true,
  });
  expect(titles(fileText(vault.doc(id)))).toEqual(["A saved", "B", "C"]);
  expect(draft.dirty).toBe(true);
  expect(titles(draft.text)).toEqual(["A saved", "B private", "C"]);
  const reopened = await FileVault.open(fs.clone(), "fresh");
  expect(reopened.doc(id).resource?.saddle?.collectionView).toEqual({
    mode: "cards",
  });
  draft.resource!.jocki!.collectionView = { mode: "table" };
  await vault.save(draft, "", {
    table: "public.tasks",
    ids: [],
    metadata: true,
  });
  expect(titles(fileText(vault.doc(id)))).toEqual(["A saved", "B", "C"]);
  expect(vault.doc(id).resource?.saddle?.collectionView).toEqual({
    mode: "table",
  });
});

it("loads an archived file before unsetting its history override so its ordinary content survives", async () => {
  const fs = new Files();
  let vault = await FileVault.open(fs, "one");
  const content = "Keep the complete file when its lazy archive is removed.\n";
  const id = await vault.create("note.md", utf8.encode(content));
  await vault.configureScope("file", id, { history: true });
  vault = await FileVault.open(fs, "one", { lazy: true });
  vault.unload(id);
  expect(vault.isLoaded(id)).toBe(false);
  await vault.configureScope("file", id, { history: undefined });
  expect(vault.historyEnabled(id)).toBe(false);
  expect(text.decode((await fs.read("note.md"))!)).toBe(content);
  expect(fileText(await vault.load(id))).toBe(content);
});
