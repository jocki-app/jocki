import { RecordFiles } from "../packages/core/vaults/record-container";
import { Companions } from "../packages/core/vaults/companions";
import { CompanionFiles } from "./fixtures/companion-files";
import { expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { FileVault, fileText } from "../packages/core/vaults/vault";
import { WorkspaceStore } from "../packages/core/vaults/workspace";
import {
  importMetadata,
  newResource,
  parseResource,
  serializeResource,
  sidecarPath,
} from "../packages/core/vaults/metadata";
import type { VaultFileSystem } from "../packages/core/vaults/contracts";
import { utf8, text } from "../packages/core/crypto";
import { VaultSearch } from "../packages/core/vaults/search";
import { applyTemplate } from "../packages/core/vaults/templates";
import { VaultEditors } from "../packages/core/vaults/editors";
import { FileExtensionHost } from "../packages/platform/src/file-sdk/host";
class Files extends CompanionFiles {}
const documents = async (fs: Files) => {
  const result: string[] = [];
  for (const path of await fs.list())
    if (path.endsWith(".saddle")) {
      const records = await new RecordFiles(fs, path).list();
      result.push(
        ...records
          .filter((name) => name.endsWith(".automerge"))
          .map((name) => path + "/" + name),
      );
    }
  return result;
};
it("preserves optional companion packages, derives content type and never persists it as a file field", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  const id = await vault.create("note.md", utf8.encode("hello"));
  expect(await fs.read(sidecarPath("note.md"))).toBeUndefined();
  expect(await documents(fs)).toEqual([]);
  const draft = vault.draft(id);
  draft.contentType = "example.note";
  await vault.save(draft);
  expect(
    parseResource(
      text.decode((await new Companions(fs).read("note.md", "resource.json"))!),
    ).saddle?.contentType,
  ).toBe("example.note");
  expect(Object.hasOwn(A.toJS(vault.doc(id)), "contentType")).toBe(false);
  expect(await documents(fs)).toEqual([]);
  const reopened = await FileVault.open(fs, "one");
  expect(reopened.contentType(id)).toBe("example.note");
  expect(reopened.list()).toHaveLength(1);
});
for (const scope of ["workspace", "vault", "folder", "file"] as const)
  for (const features of [
    { history: true, sync: false },
    { history: false, sync: true },
    { history: true, sync: true },
  ])
    it(`creates/removes protected storage for ${scope} ${JSON.stringify(features)} and retains the file/sidecar`, async () => {
      const fs = new Files(),
        vault = await FileVault.open(fs, "one");
      const first = await vault.create("shared/one.md", utf8.encode("one"), {
        contentType: "example.note",
      });
      const second = await vault.create("other.md", utf8.encode("other"));
      const workspaceFS = new Files(),
        workspace = await WorkspaceStore.open(workspaceFS, "one");
      if (scope === "workspace") {
        await workspace.configure(features);
        await vault.inheritFeatures(workspace.features);
      } else
        await vault.configureScope(
          scope,
          scope === "file" ? first : scope === "folder" ? "shared" : "",
          features,
        );
      expect(vault.features(first)).toEqual(features);
      expect(
        !!(await new Companions(fs).read("shared/one.md", "content.automerge")),
      ).toBe(true);
      expect(
        !!(await new Companions(fs).read("other.md", "content.automerge")),
      ).toBe(scope === "workspace" || scope === "vault");
      const draft = vault.draft(first);
      draft.text = "changed";
      draft.resource!.metadata = { priority: "high" };
      await vault.save(draft);
      if (features.history)
        expect(vault.history(first).length).toBeGreaterThan(1);
      const enabled = await FileVault.open(fs, "restart", {
        features: scope === "workspace" ? workspace.features : undefined,
      });
      expect(enabled.features(first)).toEqual(features);
      expect(enabled.metadata(first).properties.priority).toBe("high");
      if (features.history)
        expect(enabled.history(first).length).toBeGreaterThan(1);
      if (scope === "workspace") {
        await workspace.configure({ history: false, sync: false });
        await vault.inheritFeatures(workspace.features);
      } else
        await vault.configureScope(
          scope,
          scope === "file" ? first : scope === "folder" ? "shared" : "",
          { history: false, sync: false },
        );
      expect(await documents(fs)).toEqual([]);
      expect(await documents(workspaceFS)).toEqual([]);
      const reopened = await FileVault.open(fs, "one");
      expect(fileText(reopened.doc(first))).toBe("changed");
      expect(reopened.metadata(first).properties.priority).toBe("high");
      expect(reopened.contentType(first)).toBe("example.note");
    });
it("inherits independent features and allows explicit file exceptions", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one"),
    id = await vault.create("shared/a.md");
  await vault.configure({ history: true, sync: true });
  await vault.configureScope("file", id, { history: false });
  expect(vault.features(id)).toEqual({ history: false, sync: true });
  expect(
    await new Companions(fs).read("shared/a.md", "content.automerge"),
  ).toBeDefined();
  await vault.configureScope("file", id, { sync: false });
  expect(
    await new Companions(fs).read("shared/a.md", "content.automerge"),
  ).toBeUndefined();
});
it("moves the main file and sidecar together and drops archives when leaving a scoped folder", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  await vault.configureScope("folder", "shared", { history: true });
  const id = await vault.create("shared/note.md", utf8.encode("note"), {
    contentType: "example.note",
  });
  const draft = vault.draft(id);
  draft.resource!.metadata = { owner: "me" };
  await vault.save(draft);
  vault.release(draft);
  await vault.move(id, "renamed.md");
  expect(await fs.read("shared/note.md")).toBeUndefined();
  expect(
    await new Companions(fs).read("shared/note.md", "resource.json"),
  ).toBeUndefined();
  expect(
    await new Companions(fs).read("renamed.md", "content.automerge"),
  ).toBeUndefined();
  const reopened = await FileVault.open(fs, "two");
  expect(reopened.doc(id).resource?.path).toBe("renamed.md");
  expect(reopened.metadata(id).properties.owner).toBe("me");
});
it("keeps linked template references in ordinary-file sidecars across restarts", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one"),
    id = await vault.create("note.md");
  const draft = vault.draft(id);
  applyTemplate(
    draft,
    { hint: "source.md", file: "source", text: "# Template" },
    "reference",
  );
  await vault.save(draft);
  const reopened = await FileVault.open(fs, "one");
  expect(reopened.doc(id).template).toEqual({
    hint: "source.md",
    file: "source",
    baseline: "# Template",
  });
  expect(await documents(fs)).toEqual([]);
});
it("indexes sidecar metadata for ordinary and metadata-prefixed searches", async () => {
  const vault = await FileVault.open(new Files(), "one"),
    id = await vault.create("report.pdf", utf8.encode("binary"), {
      resource: {
        name: "report",
        path: "report.pdf",
        metadata: { owner: "Lindiwe" },
      },
    });
  const search = new VaultSearch();
  await search.update(vault);
  expect(search.search("Lindiwe").map((hit) => hit.file.id)).toEqual([id]);
  expect(search.search("metadata:owner").map((hit) => hit.file.id)).toEqual([
    id,
  ]);
});
it("emits successive metadata-only draft edits and preserves metadata in saved copies", async () => {
  const vault = await FileVault.open(new Files(), "one"),
    id = await vault.create("one.md", utf8.encode("body"), {
      resource: { name: "one", path: "one.md", metadata: { owner: "initial" } },
    });
  const host = new FileExtensionHost({
    folders: () => [],
    documents: () => editors.documents(),
    updateDocument: async () => {},
    getConfiguration: () => undefined,
    updateConfiguration: async () => {},
  });
  const editors: VaultEditors = new VaultEditors(
    new Map([[vault.id, vault]]),
    host,
  );
  const session = await editors.open(vault.id, id);
  session.draft.resource!.metadata = { owner: "first" };
  editors.changed(vault.id, id);
  const version = editors.snapshot(vault.id, id).version;
  session.draft.resource!.metadata = { owner: "second" };
  editors.changed(vault.id, id);
  expect(editors.snapshot(vault.id, id).version).toBeGreaterThan(version);
  const copy = await editors.saveCopy(vault.id, id, vault.id, "two.md");
  expect(vault.doc(copy).resource?.path).toBe("two.md");
  expect(vault.metadata(copy).properties.owner).toBe("second");
  await host.dispose();
});
it("initializes a root reference from ordinary files and optional sidecars", async () => {
  const fs = new Files();
  await fs.writeAtomic("note.md", utf8.encode("# Note"));
  await new Companions(fs).write(
    "note.md",
    "resource.json",
    utf8.encode(
      JSON.stringify({
        name: "note",
        path: "note.md",
        metadata: { project: "Tide" },
      }),
    ),
  );
  const vault = await FileVault.open(fs, "one");
  const [file] = vault.list();
  expect(vault.metadata(file.id).properties.project).toBe("Tide");
  expect(
    JSON.parse(text.decode((await vault.local.read("root-index.json"))!))
      .format,
  ).toBe("saddle-root-index/1");
  expect(vault.doc(file.id).format).toBe("saddle-file/1");
  expect(await documents(fs)).toEqual([]);
});
it("serializes inherited policy transitions and waits for durable descendant storage", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one"),
    id = await vault.create("a.md");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const write = fs.writeAtomic.bind(fs);
  let block = true;
  fs.writeAtomic = async (path, bytes) => {
    if (block && path === ".a.md.saddle") {
      block = false;
      entered();
      await gate;
    }
    await write(path, bytes);
  };
  const first = vault.inheritFeatures({ history: true, sync: false });
  await started;
  let acknowledged = false;
  const second = vault
    .inheritFeatures({ history: true, sync: false })
    .then(() => {
      acknowledged = true;
    });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(
    await new Companions(fs).read("a.md", "content.automerge"),
  ).toBeDefined();
  await Promise.all([
    vault.inheritFeatures({ history: false, sync: true }),
    vault.inheritFeatures({ history: false, sync: false }),
  ]);
  expect(await documents(fs)).toEqual([]);
});
it("applies inherited history transitions to the shared retention policy", async () => {
  const vault = await FileVault.open(new Files(), "one"),
    id = await vault.create("a.md");
  await vault.inheritFeatures({ history: true, sync: true });
  await vault.inheritFeatures({ history: false, sync: true });
  expect(vault.doc(id).retainHistory).toBe(false);
  expect(vault.historyEnabled(id)).toBe(false);
  await vault.inheritFeatures({ history: true, sync: true });
  expect(vault.doc(id).retainHistory).toBe(true);
  expect(vault.historyEnabled(id)).toBe(true);
});
it("rejects all metadata on overlap and clears local errors after correction/recheck", async () => {
  const fs = new Files();
  await fs.writeAtomic(
    "note.md",
    utf8.encode("---\npriority: high\n---\nBody"),
  );
  await new Companions(fs).write(
    "note.md",
    "resource.json",
    utf8.encode(
      serializeResource({
        ...newResource("note.md"),
        metadata: { priority: "low" },
        saddle: { contentType: "example.note" },
      }),
    ),
  );
  const vault = await FileVault.open(fs, "one"),
    id = vault.list()[0].id;
  expect(vault.metadata(id).properties).toEqual({});
  expect(vault.contentType(id)).toBeNull();
  expect(vault.list()[0].metadataError).toContain("priority");
  expect(
    text.decode((await vault.local.read("metadata-errors.json"))!),
  ).toContain("priority");
  await new Companions(fs).write(
    "note.md",
    "resource.json",
    utf8.encode(
      serializeResource({
        ...newResource("note.md"),
        metadata: { owner: "me" },
      }),
    ),
  );
  await vault.recheckMetadata(id);
  expect(vault.metadata(id).properties).toMatchObject({
    owner: "me",
    priority: "high",
  });
  expect(vault.metadataErrors.entries.size).toBe(0);
  expect(vault.list()[0].metadataError).toBeUndefined();
  expect(Object.hasOwn(vault.doc(id), "metadataErrors")).toBe(false);
});
it("restores content and sidecar together through one history entry", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  const id = await vault.create("note.md", utf8.encode("old"), {
    contentType: "example.old",
  });
  await vault.configureScope("file", id, { history: true });
  const heads = A.getHeads(vault.doc(id));
  const draft = vault.draft(id);
  draft.text = "new";
  draft.contentType = "example.new";
  await vault.save(draft);
  await vault.save(vault.restore(id, heads));
  expect(text.decode((await fs.read("note.md"))!)).toBe("old");
  expect(
    parseResource(
      text.decode((await new Companions(fs).read("note.md", "resource.json"))!),
    ).saddle?.contentType,
  ).toBe("example.old");
  expect(
    (await documents(fs)).filter((name) => name.endsWith("/content.automerge")),
  ).toHaveLength(1);
});
it("recovers an interrupted ordinary-file/sidecar save without creating Automerge storage", async () => {
  const fs = new Files(),
    vault = await FileVault.open(fs, "one");
  const id = await vault.create("note.md", utf8.encode("old"));
  const draft = vault.draft(id);
  draft.text = "new";
  draft.contentType = "example.note";
  fs.fail = ".note.md.saddle";
  await expect(vault.save(draft)).rejects.toThrow("Disk full");
  fs.fail = undefined;
  const reopened = await FileVault.open(fs, "one");
  expect(fileText(reopened.doc(id))).toBe("new");
  expect(reopened.contentType(id)).toBe("example.note");
  expect(await documents(fs)).toEqual([]);
  expect(
    [...fs.values.keys()].filter((name) => name.includes("/pending/")),
  ).toEqual([]);
});
it("supports generic Data Resources, URL/path arrays, inline data and custom properties", () => {
  expect(sidecarPath("notes.md")).toBe(".notes.md.saddle");
  for (const descriptor of [
    {
      name: "remote",
      path: "https://example.org/data.csv",
      metadata: { tags: ["work"], count: 2 },
    },
    {
      name: "multiple",
      path: ["one.csv", "two.csv"],
      custom: { supported: true },
    },
    { name: "inline", data: "a,b\n1,2", format: "csv" },
    { name: "inline-json", data: [{ a: 1 }] },
  ])
    expect(parseResource(JSON.stringify(descriptor))).toEqual(descriptor);
  expect(() => parseResource('{"name":"bad","path":"../private"}')).toThrow(
    "Invalid",
  );
  expect(() =>
    importMetadata("a.md", "text/markdown", "---\ntitle: Inline\n---\n", {
      name: "a",
      path: "a.md",
      title: "Sidecar",
    }),
  ).toThrow("conflict");
});

for (const feature of ["history", "sync"] as const)
  it(`persists all three ${feature} states and honors future descendants and parent enables`, async () => {
    const fs = new Files();
    let vault = await FileVault.open(fs, "one");
    const id = await vault.create("parent/child/note.md", utf8.encode("note"));
    await vault.configureScope("folder", "parent/child", { [feature]: false });
    await vault.configureScope("folder", "parent", { [feature]: true });
    expect(vault.features(id)[feature]).toBe(false);
    const future = await vault.create(
      "parent/child/future.md",
      utf8.encode("future"),
    );
    expect(vault.features(future)[feature]).toBe(false);
    vault = await FileVault.open(fs, "reopen");
    expect(vault.features(future)[feature]).toBe(false);
    await vault.configureScope("folder", "parent/child", {
      [feature]: undefined,
    });
    expect(
      Object.hasOwn(vault.scopePolicies.folders["parent/child"] ?? {}, feature),
    ).toBe(false);
    expect(vault.features(id)[feature]).toBe(true);
    expect(vault.features(future)[feature]).toBe(true);
    await vault.configureScope("file", id, { [feature]: true });
    await vault.configureScope("folder", "parent", { [feature]: false });
    expect(vault.features(id)[feature]).toBe(true);
    expect(vault.features(future)[feature]).toBe(false);
    // Unsetting also updates history retention while sharing keeps the document alive.
    await vault.configureScope("file", id, { sync: true });
    await vault.configureScope("file", id, { [feature]: undefined });
    expect(vault.features(id)[feature]).toBe(false);
    if (feature === "history") expect(vault.doc(id).retainHistory).toBe(false);
  });

it("distinguishes workspace Unset from Disabled without storing undefined Automerge values", async () => {
  const fs = new Files();
  let workspace = await WorkspaceStore.open(fs, "one");
  expect(workspace.current.features).toEqual({});
  expect(workspace.features).toEqual({ history: false, sync: false });
  await workspace.configure({ history: true, sync: true });
  await workspace.configure({ history: undefined, sync: false });
  expect(workspace.current.features).toEqual({ sync: false });
  workspace = await WorkspaceStore.open(fs, "one");
  expect(workspace.current.features).toEqual({ sync: false });
  expect(workspace.features).toEqual({ history: false, sync: false });
});
