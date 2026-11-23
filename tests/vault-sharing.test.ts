import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import {
  mergeCSDBImport,
  defaultCSDBImportSettings,
} from "../packages/core/vaults/csdb-import";
import { fileText } from "../packages/core/vaults/vault";
import { Companions } from "../packages/core/vaults/companions";
import { CompanionFiles } from "./fixtures/companion-files";
import { shareLink } from "../packages/core/vaults/share-invitation";
import { it, expect } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { FileVault } from "../packages/core/vaults/vault";
import { WorkspaceStore } from "../packages/core/vaults/workspace";
import {
  ProtectedFileSync,
  type ShareDocument,
} from "../packages/core/vaults/protected-sync";
import type { VaultFileSystem } from "../packages/core/vaults/contracts";
import { MemoryStorage } from "../packages/storage";
import { testRepository } from "./fixtures/repository";
import { utf8 } from "../packages/core/crypto";
import * as A from "@automerge/automerge";
import type { Repository } from "../packages/core/repository";

class Files extends CompanionFiles {}
it("waits for an offline reader before replacing history and preserves typing made during the freeze", async () => {
  await peers(
    async ({
      a,
      b,
      one,
      two,
      source,
      target,
      disconnect,
      reconnect,
      errors,
    }) => {
      const id = await source.create("note.md", utf8.encode("hello"));
      const draft = source.draft(id);
      draft.text = "hello!";
      source.release(await source.save(draft));
      source.release(draft);
      const hash = A.getHeads(source.doc(id))[0];
      const invite = await one.create(source, "file", "note.md");
      await one.grant(invite, b.contactCard, "read");
      await two.join(shareLink(invite), target);
      await expect(
        two.rewriteHistory(target, { id }, { kind: "reset", time: 100 }),
      ).rejects.toThrow("Editing access is required");
      const scope = await a.load<ShareDocument>(invite.url);
      const previous = scope.doc().files[id].url;
      const control = await a.load<
        import("../packages/core/vaults/retention").RetentionDocument
      >(scope.doc().files[id].retention);
      disconnect();
      const editor = source.draft(id);
      await one.rewriteHistory(source, { id }, { kind: "drop", hash });
      expect(control.doc().proposal?.phase).toBe("prepare");
      expect(source.doc(id).text).toBe("hello!");
      expect(
        A.getAllChanges((await a.load(previous)).doc()).length,
      ).toBeGreaterThan(1);
      editor.text = "hello! draft";
      reconnect();
      await expect
        .poll(() => target.doc(id).text, { timeout: 15000 })
        .toBe("hello");
      expect(editor.text).toBe("hello draft");
      expect(editor.dirty).toBe(true);
      expect(source.history(id)).toHaveLength(1);
      source.release(editor);
      expect(errors).toEqual([]);
    },
  );
}, 30000);
it("replays shared folder declarations without changing child file contents", async () => {
  await peers(async ({ b, one, two, source, target, errors }) => {
    await source.create("shared/note.md", utf8.encode("unchanged"));
    const resource = (owner: string, note = "") => ({
      name: "shared",
      data: [],
      metadata: { owner, note },
    });
    await source.setFolderResource("shared", resource("original"));
    await source.setFolderResource("shared", resource("removed"));
    const hash = A.getHeads(source.folderDocument("shared")!)[0];
    await source.setFolderResource("shared", resource("removed", "later"));
    const invite = await one.create(source, "folder", "shared");
    await one.grant(invite, b.contactCard, "edit");
    await two.join(shareLink(invite), target);
    await target.configureScope("folder", "shared", { history: true });
    await one.rewriteHistory(
      source,
      { path: "shared" },
      { kind: "drop", hash },
    );
    await expect
      .poll(() => target.folderDocument("shared")?.resource?.metadata, {
        timeout: 15000,
      })
      .toEqual({ owner: "original", note: "later" });
    expect(target.doc(target.find("shared/note.md")!.id).text).toBe(
      "unchanged",
    );
    await expect
      .poll(() => source.getFreeze(source.folderDocument("shared")!.id), {
        timeout: 10000,
      })
      .toBeUndefined();
    await one.flush();
    await two.flush();
    await two.rewriteHistory(
      target,
      { path: "shared" },
      { kind: "reset", time: 100 },
    );
    await expect
      .poll(() => target.folderHistory("shared").length, { timeout: 15000 })
      .toBe(1);
    expect(target.folderHistory("shared")[0].event).toBe("Folder created");
    expect(errors).toEqual([]);
  });
}, 40000);
it("rewrites shared workspace settings through the same authenticated history barrier", async () => {
  await peers(async ({ a, b, one, two, errors }) => {
    await one.workspace.configure({ history: true });
    await one.workspace.update((d) => {
      d.defaults.vim = true;
    });
    const hash = A.getHeads(one.workspace.document())[0];
    await one.workspace.update((d) => {
      d.name = "Retained name";
    });
    const invite = await one.createWorkspace([]);
    await one.grant(invite, b.contactCard, "edit");
    await two.joinWorkspace(shareLink(invite), "b", {});
    await one.flushWorkspace();
    await two.flushWorkspace();
    await one.rewriteWorkspaceHistory({ kind: "drop", hash });
    await expect
      .poll(() => two.workspace.current.defaults.vim, { timeout: 15000 })
      .toBe(false);
    expect(two.workspace.current.name).toBe("Retained name");
    await expect
      .poll(() => one.workspace.historyOperationPending, { timeout: 10000 })
      .toBe(false);
    await one.flush();
    await two.flush();
    const scope = await a.load<ShareDocument>(invite.url);
    const control = await a.load<
      import("../packages/core/vaults/retention").RetentionDocument
    >(scope.doc().workspaceRetention!);
    await expect
      .poll(
        () => {
          const proposal = control.doc().proposal;
          return (
            proposal?.phase === "commit" &&
            Object.keys(proposal.acknowledgements).length ===
              proposal.participants.length
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
    await two.rewriteWorkspaceHistory({ kind: "reset", time: 100 });
    await expect
      .poll(() => one.workspace.history().length, { timeout: 15000 })
      .toBe(1);
    expect(one.workspace.current.name).toBe("Retained name");
    expect(errors).toEqual([]);
  });
}, 40000);
it("deletes a shared version and lets another editing computer reset the rewritten history", async () => {
  await peers(async ({ a, b, one, two, source, target, errors }) => {
    const id = await source.create("note.md", utf8.encode("hello"));
    const save = async (text: string) => {
      const draft = source.draft(id);
      draft.text = text;
      source.release(await source.save(draft));
      source.release(draft);
    };
    await save("hello!");
    const removed = A.getHeads(source.doc(id))[0];
    await save("hello! world");
    const invite = await one.create(source, "file", "note.md");
    await one.grant(invite, b.contactCard, "edit");
    await two.join(shareLink(invite), target);
    await target.configureScope("file", id, { history: true });
    const editor = target.draft(id);
    await one.rewriteHistory(source, { id }, { kind: "drop", hash: removed });
    // The durable document is installed before open drafts finish rebasing.
    await expect
      .poll(() => [target.doc(id).text, editor.text, editor.dirty], {
        timeout: 15000,
      })
      .toEqual(["hello world", "hello world", false]);
    expect(source.doc(id).text).toBe("hello world");
    await expect
      .poll(() => source.history(id).length, { timeout: 10000 })
      .toBe(2);
    await expect
      .poll(
        () =>
          source.historyProtection(id)?.reference.document ===
          target.historyProtection(id)?.reference.document,
        { timeout: 10000 },
      )
      .toBe(true);
    await expect
      .poll(() => source.getFreeze(id), { timeout: 10000 })
      .toBeUndefined();
    await one.flush();
    await two.flush();
    await two.rewriteHistory(target, { id }, { kind: "reset", time: 100 });
    await expect
      .poll(() => source.history(id).length, { timeout: 15000 })
      .toBe(1);
    await expect
      .poll(() => target.history(id).length, { timeout: 15000 })
      .toBe(1);
    expect(source.history(id)[0].event).toBe("File created");
    expect(source.doc(id).text).toBe("hello world");
    expect(errors).toEqual([]);
  });
}, 40000);
function connect(a: Repository, b: Repository) {
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
  return () => {
    left.disconnect();
    right.disconnect();
    port1.close();
    port2.close();
  };
}
it("shares and restores the main file and its sidecar as one protected document", async () => {
  await peers(async ({ b, one, two, source, target, errors }) => {
    const id = await source.create("note.md", utf8.encode("original"), {
      resource: {
        name: "note",
        path: "note.md",
        metadata: { owner: "one" },
        saddle: { contentType: "example.note" },
      },
    });
    await source.create("private.md", utf8.encode("private"));
    const baseline = A.getHeads(source.doc(id));
    const invite = await one.create(source, "file", "note.md");
    await one.grant(invite, b.contactCard, "edit");
    await two.join(shareLink(invite), target);
    expect(target.list().map((file) => file.path)).toEqual(["note.md"]);
    expect(target.metadata(id).properties.owner).toBe("one");
    expect(target.contentType(id)).toBe("example.note");
    const draft = target.draft(id);
    draft.text = "edited";
    draft.resource!.metadata = { owner: "two" };
    await target.save(draft);
    await expect
      .poll(() => source.metadata(id).properties.owner, { timeout: 10000 })
      .toBe("two");
    expect(source.doc(id).text).toBe("edited");
    await source.save(source.restore(id, baseline));
    await expect
      .poll(() => target.metadata(id).properties.owner, { timeout: 10000 })
      .toBe("one");
    expect(target.doc(id).text).toBe("original");
    await expect
      .poll(async () => {
        const resource = JSON.parse(
          new TextDecoder().decode(
            await new Companions(target.fs).read("note.md", "resource.json"),
          ),
        );
        return resource.metadata.owner;
      })
      .toBe("one");
    expect(Object.hasOwn(A.toJS(target.doc(id)), "contentType")).toBe(false);
    expect(errors).toEqual([]);
  });
}, 20000);
it("synchronizes imported CSDB rows, native form metadata and history restoration", async () => {
  await peers(async ({ b, one, two, source, target, errors }) => {
    const db = CSDBDatabase.create("rows");
    db.createSchema("public");
    db.createTable({
      schema: "public",
      name: "tasks",
      columns: {
        id: "text",
        title: "text",
        parent_id: "text",
        tags: "text[]",
        date: "datetime",
      },
      defaults: { date: "now()" },
      formats: { date: "%d/%m/%Y %H:%M:%S.%f %:z" },
      required: ["id"],
      primary_key: { columns: ["id"] },
      visibility: {
        id: "hidden",
        date: "hidden",
        title: "editable",
        tags: "arbitrary consumer text",
      },
      foreign_keys: [
        {
          name: "parent",
          columns: ["parent_id"],
          references: { table: "public.tasks", columns: ["id"] },
          label_field: "title",
        },
      ],
    });
    const id = await source.create("rows.csdb", utf8.encode(db.toString())),
      baseline = A.getHeads(source.doc(id));
    const invite = await one.create(source, "file", "rows.csdb");
    await one.grant(invite, b.contactCard, "edit");
    await two.join(shareLink(invite), target);
    db.table("public.tasks").insert([
      { id: "child", title: "Child", parent_id: "parent", tags: ["a", "b"] },
      { id: "parent", title: "Parent" },
    ]);
    const draft = target.draft(id);
    draft.text = mergeCSDBImport(
      draft.text,
      [db.toString()],
      defaultCSDBImportSettings().profiles[0],
    ).text;
    target.release(await target.save(draft));
    target.release(draft);
    await expect
      .poll(
        () =>
          CSDBDatabase.parse(fileText(source.doc(id)))
            .table("public.tasks")
            .all().length,
        { timeout: 15000 },
      )
      .toBe(2);
    const saved = CSDBDatabase.parse(fileText(source.doc(id))),
      table = saved.document.tables.get("public.tasks")!;
    expect(saved.table("public.tasks").byPrimaryKey("child")?.tags).toEqual([
      "a",
      "b",
    ]);
    expect(table.rows[0].date).toBe(db.table("public.tasks").all()[0].date);
    expect(table.schema.formats?.date).toBe("%d/%m/%Y %H:%M:%S.%f %:z");
    expect(table.schema.defaults.date).toBe("now()");
    expect(table.schema.foreign_keys[0].label_field).toBe("title");
    expect(saved.getVisibility("public.tasks", "tags")).toBe(
      "arbitrary consumer text",
    );
    const restore = source.restore(id, baseline);
    source.release(await source.save(restore));
    source.release(restore);
    await expect
      .poll(
        () =>
          CSDBDatabase.parse(fileText(target.doc(id)))
            .table("public.tasks")
            .all().length,
        { timeout: 15000 },
      )
      .toBe(0);
    expect(errors).toEqual([]);
  });
}, 30000);
async function peers(
  run: (context: {
    a: Repository;
    b: Repository;
    one: ProtectedFileSync;
    two: ProtectedFileSync;
    source: FileVault;
    target: FileVault;
    errors: unknown[];
    disconnect(): void;
    reconnect(): void;
  }) => Promise<void>,
) {
  const a = await testRepository(new MemoryStorage()),
    b = await testRepository(new MemoryStorage()),
    errors: unknown[] = [];
  const source = await FileVault.open(new Files(), "a"),
    target = await FileVault.open(new Files(), "b");
  await source.configure({ history: true });
  const one = await ProtectedFileSync.open(
      a,
      new Files(),
      await WorkspaceStore.open(new Files(), "a"),
      (error) => errors.push(error),
    ),
    two = await ProtectedFileSync.open(
      b,
      new Files(),
      await WorkspaceStore.open(new Files(), "b"),
      (error) => errors.push(error),
    );
  await one.attach(source);
  await two.attach(target);
  let disconnect = connect(a, b);
  try {
    await run({
      a,
      b,
      one,
      two,
      source,
      target,
      errors,
      disconnect: () => disconnect(),
      reconnect: () => {
        disconnect();
        disconnect = connect(a, b);
      },
    });
  } finally {
    disconnect();
    await one.close();
    await two.close();
    await a.close();
    await b.close();
  }
}
it(
  "preserves concurrent folder additions while another peer publishes edits",
  async () =>
    peers(async ({ b, one, two, source, target, errors }) => {
      const id = await source.create("shared/first.md", utf8.encode("first"));
      const invite = await one.create(source, "folder", "shared");
      await one.grant(invite, b.contactCard, "edit");
      await two.join(shareLink(invite), target);
      const draft = source.draft(id);
      draft.text = "edited concurrently";
      const [, added] = await Promise.all([
        source.save(draft),
        target.create("shared/second.md", utf8.encode("new peer file")),
      ]);
      await one.flush();
      await two.flush();
      await expect
        .poll(() => source.find("shared/second.md")?.id, { timeout: 10000 })
        .toBe(added);
      await expect
        .poll(() => target.doc(id).text, { timeout: 10000 })
        .toBe("edited concurrently");
      expect(source.doc(added).text).toBe("new peer file");
      expect(errors).toEqual([]);
    }),
  20000,
);
it(
  "keeps transport bindings separate when independent vaults reuse a file ID",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      const id = await source.create("first.md", utf8.encode("first vault"));
      const other = await FileVault.open(new Files(), "a");
      await other.configure({ history: true });
      const independent = A.from({
        ...A.toJS(source.doc(id)),
        generation: crypto.randomUUID(),
        text: "independent second vault",
      });
      await other.receiveSharedFile(
        { id, path: "second.md", deleted: false },
        A.save(independent),
      );
      await one.attach(other);
      const first = await one.create(source, "vault"),
        second = await one.create(other, "vault");
      const firstURL = (await a.load<ShareDocument>(first.url)).doc().files[id]
        .url;
      const secondURL = (await a.load<ShareDocument>(second.url)).doc().files[
        id
      ].url;
      expect(firstURL).not.toBe(secondURL);
      await one.grant(second, b.contactCard, "edit");
      await two.join(shareLink(second), target);
      expect(target.doc(id).text).toBe("independent second vault");
      const draft = other.draft(id);
      draft.text = "second updated";
      await other.save(draft);
      await expect
        .poll(() => target.doc(id).text, { timeout: 10000 })
        .toBe("second updated");
      expect(source.doc(id).text).toBe("first vault");
      expect((await a.load<{ text: string }>(firstURL)).doc().text).toBe(
        "first vault",
      );
      expect(errors).toEqual([]);
    }),
  20000,
);
it(
  "keeps a single-file grant bound to identity when its former path is reused",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      const id = await source.create("note.md", utf8.encode("shared")),
        invite = await one.create(source, "file", "note.md");
      await one.grant(invite, b.contactCard, "edit");
      await two.join(shareLink(invite), target);
      await source.move(id, "moved.md");
      const replacement = await source.create(
        "note.md",
        utf8.encode("private replacement"),
      );
      const draft = source.draft(id);
      draft.text = "shared update";
      await source.save(draft);
      await one.flush();
      await expect
        .poll(() => target.find("moved.md")?.id, { timeout: 10000 })
        .toBe(id);
      await expect
        .poll(() => target.doc(id).text, { timeout: 10000 })
        .toBe("shared update");
      expect(target.list().some((file) => file.id === replacement)).toBe(false);
      expect(
        Object.keys((await a.load<ShareDocument>(invite.url)).doc().files),
      ).toEqual([id]);
      expect(errors).toEqual([]);
    }),
  20000,
);
it(
  "isolates edits after a file leaves a shared folder, including overlapping vault shares",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      const id = await source.create(
        "public/note.md",
        utf8.encode("public content"),
      );
      const full = await one.create(source, "vault"),
        folder = await one.create(source, "folder", "public");
      await one.grant(folder, b.contactCard, "edit");
      await two.join(shareLink(folder), target);
      expect(target.find("public/note.md")?.id).toBe(id);
      const edit = target.draft(id);
      edit.text = "public peer edit";
      await target.save(edit);
      await expect
        .poll(() => source.doc(id).text, { timeout: 10000 })
        .toBe("public peer edit");
      const shared = await a.load<ShareDocument>(folder.url),
        oldURL = shared.doc().files[id].url,
        remoteOld = await b.load<{ text: string }>(oldURL);
      // Pause an old manifest during its asynchronous authorization check.
      // A local move and save must survive when that stale snapshot resumes.
      let release!: () => void,
        blocked = true;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        canRead = a.groupCanRead.bind(a);
      a.groupCanRead = async (group, url) => {
        if (blocked && url === oldURL) {
          blocked = false;
          await gate;
        }
        return canRead(group, url);
      };
      const fullScope = await a.load<ShareDocument>(full.url);
      fullScope.change((doc) => {
        doc.name += " refreshed";
      });
      try {
        await expect.poll(() => blocked, { timeout: 5000 }).toBe(false);
        await source.move(id, "private/note.md");
        const privateEdit = source.draft(id);
        privateEdit.text = "private future edit";
        await source.save(privateEdit);
      } finally {
        release();
        a.groupCanRead = canRead;
      }
      await one.flush();
      await expect
        .poll(() => target.list().length, { timeout: 10000 })
        .toBe(0)
        .catch((error) => {
          console.error("Folder retirement state", {
            source: source.entry(id),
            target: target.entry(id),
            scope: shared.doc().files,
            full: fullScope.doc().files,
            one: (one as unknown as { catalog: unknown }).catalog,
            two: (two as unknown as { catalog: unknown }).catalog,
            errors,
          });
          throw error;
        });
      const nextURL = fullScope.doc().files[id].url;
      expect(nextURL).not.toBe(oldURL);
      expect(await a.groupCanRead(shared.doc().group, nextURL)).toBe(false);
      expect((await a.load<{ text: string }>(nextURL)).doc().text).toBe(
        "private future edit",
      );
      expect(remoteOld.doc().text).toBe("public peer edit");
      expect(errors).toEqual([]);
    }),
  20000,
);
it(
  "rejects an editor forging a wider share contract",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      const id = await source.create("public.md", utf8.encode("public")),
        privateId = await source.create("private.md", utf8.encode("secret"));
      const invite = await one.create(source, "file", "public.md");
      await one.grant(invite, b.contactCard, "edit");
      await two.join(shareLink(invite), target);
      const remote = await b.load<ShareDocument>(invite.url);
      remote.change((doc) => {
        doc.kind = "vault";
        doc.rootFile = null;
      });
      await b.flush();
      await expect
        .poll(
          async () => (await a.load<ShareDocument>(invite.url)).doc().kind,
          { timeout: 10000 },
        )
        .toBe("vault");
      await expect(one.inspectInvitation(shareLink(invite))).rejects.toThrow(
        "contract",
      );
      const updated = source.draft(privateId);
      updated.text = "still private";
      await source.save(updated);
      await one.flush();
      expect(target.list().map((file) => file.id)).toEqual([id]);
      expect(source.doc(privateId).text).toBe("still private");
      expect(
        Object.keys((await a.load<ShareDocument>(invite.url)).doc().files),
      ).toEqual([id]);
    }),
  20000,
);
it(
  "rejects a forged folder entry that reuses an unrelated private file identity",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      await source.create("public/note.md", utf8.encode("public"));
      const privateId = await source.create(
        "private.md",
        utf8.encode("private secret"),
      );
      const invite = await one.create(source, "folder", "public");
      await one.grant(invite, b.contactCard, "edit");
      await two.join(shareLink(invite), target);
      const scope = await b.load<ShareDocument>(invite.url),
        group = scope.doc().group;
      const fake = await b.importProtected(
        A.save(
          A.from({ ...A.toJS(source.doc(privateId)), text: "attacker input" }),
        ),
      );
      const control = await b.create({
        format: "saddle-retention/1",
        file: privateId,
        owner: b.identityId,
        proposal: null,
      });
      await b.grantDocumentGroup(fake, group, "edit");
      await b.grantDocumentGroup(control, group, "read");
      await a.load(fake.url);
      scope.change((doc) => {
        doc.files[privateId] = {
          id: privateId,
          path: "stolen.md",
          url: fake.url,
          deleted: false,
          epoch: 0,
          retention: control.url,
        };
      });
      await b.flush();
      await expect
        .poll(
          () =>
            errors.some((error) => String(error).includes("collides outside")),
          { timeout: 10000 },
        )
        .toBe(true);
      expect(source.entry(privateId).path).toBe("private.md");
      expect(source.doc(privateId).text).toBe("private secret");
      expect(target.doc(privateId).text).not.toContain("private secret");
      expect((fake.doc() as { text: string }).text).toBe("attacker input");
    }),
  20000,
);
it("shares workspace settings and grants future vault files through inherited groups", async () => {
  const a = await testRepository(new MemoryStorage()),
    b = await testRepository(new MemoryStorage()),
    errors: unknown[] = [];
  let one: ProtectedFileSync | undefined,
    two: ProtectedFileSync | undefined,
    disconnect = () => {};
  try {
    const wsA = await WorkspaceStore.open(new Files(), "a"),
      wsB = await WorkspaceStore.open(new Files(), "b");
    const source = await FileVault.open(new Files(), "a"),
      target = await FileVault.open(new Files(), "b");
    await source.create("first.md", utf8.encode("first"));
    one = await ProtectedFileSync.open(a, new Files(), wsA, (e) =>
      errors.push(e),
    );
    two = await ProtectedFileSync.open(b, new Files(), wsB, (e) =>
      errors.push(e),
    );
    await one.attach(source);
    const invitation = await one.createWorkspace([source]);
    await one.grant(invitation, b.contactCard, "edit");
    disconnect = connect(a, b);
    const share = await two.joinWorkspace(shareLink(invitation), "b", {});
    expect(wsB.current.id).toBe(wsA.current.id);
    expect(target.id).not.toBe(source.id);
    await two.join(
      shareLink({
        format: "saddle-share-invitation/1",
        name: source.name,
        kind: "vault",
        url: share.vaults[source.id].url,
      }),
      target,
    );
    await expect.poll(() => target.list().length, { timeout: 10000 }).toBe(1);
    const future = await source.create(
      "future.md",
      utf8.encode("created after invitation"),
    );
    await expect
      .poll(() => target.list().some((f) => f.id === future), {
        timeout: 10000,
      })
      .toBe(true);
    expect(target.doc(future).text).toBe("created after invitation");
    await wsA.update((d) => {
      d.defaults.vim = true;
    });
    await expect
      .poll(() => wsB.settings("b").vim, { timeout: 10000 })
      .toBe(true);
    await wsB.update((d) => {
      d.computers.a.hotkeys = { save: "F2" };
    });
    await expect
      .poll(() => wsA.settings("a").hotkeys.save, { timeout: 10000 })
      .toBe("F2");
    const addedVault = await FileVault.open(new Files(), "a");
    await addedVault.create("new.md", utf8.encode("newly shared vault"));
    await addedVault.configure({ sync: true, history: true });
    await one.attach(addedVault);
    await one.flush();
    const root = await b.load<ShareDocument>(invitation.url);
    await expect
      .poll(() => root.doc().vaults[addedVault.id]?.url, { timeout: 10000 })
      .toBeTruthy();
    const child = await b.load<ShareDocument>(
      root.doc().vaults[addedVault.id].url,
    );
    await expect
      .poll(() => Object.keys(child.doc().files).length, { timeout: 10000 })
      .toBe(1);
    expect(
      (
        await b.load<{ text: string }>(Object.values(child.doc().files)[0].url)
      ).doc().text,
    ).toBe("newly shared vault");
    expect(target.list()).toHaveLength(2); // A new share does not mount a folder implicitly.
    expect(errors).toEqual([]);
  } finally {
    disconnect();
    await one?.close();
    await two?.close();
    await a.close();
    await b.close();
  }
}, 30000);
it("shares a single file without granting access to the vault or unrelated files", async () => {
  const a = await testRepository(new MemoryStorage()),
    b = await testRepository(new MemoryStorage());
  let disconnect = () => {};
  const errors: unknown[] = [];
  let one: ProtectedFileSync | undefined, two: ProtectedFileSync | undefined;
  try {
    const wsA = await WorkspaceStore.open(new Files(), "a"),
      wsB = await WorkspaceStore.open(new Files(), "b");
    const source = await FileVault.open(new Files(), "a"),
      target = await FileVault.open(new Files(), "b");
    const publicId = await source.create(
      "shared/note.md",
      utf8.encode("first\nlast\n"),
    );
    await source.create("private.md", utf8.encode("not shared"));
    one = await ProtectedFileSync.open(a, new Files(), wsA, (e) =>
      errors.push(e),
    );
    two = await ProtectedFileSync.open(b, new Files(), wsB, (e) =>
      errors.push(e),
    );
    await one.attach(source);
    await two.attach(target);
    const invitation = await one.create(source, "file", "shared/note.md");
    await one.grant(invitation, b.contactCard, "edit");
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
    disconnect = () => {
      left.disconnect();
      right.disconnect();
      port1.close();
      port2.close();
    };
    await two.join(shareLink(invitation), target);
    await expect
      .poll(() => target.list().map((f) => f.path), { timeout: 10000 })
      .toEqual(["note.md"]);
    expect(target.doc(publicId).text).toBe("first\nlast\n");
    const draft = target.draft(publicId);
    draft.text = "first edited\nlast\n";
    await target.save(draft);
    await expect
      .poll(() => source.doc(publicId).text, { timeout: 10000 })
      .toBe("first edited\nlast\n");
    expect(source.list()).toHaveLength(2);
    expect(target.list()).toHaveLength(1);
    expect(errors).toEqual([]);
    const initial = source.doc(publicId).generation;
    for (let i = 0; i < 32; i++) {
      const draft = source.draft(publicId);
      draft.text = `first edited\nlast ${i}\n`;
      await source.save(draft);
    }
    await expect
      .poll(() => source.doc(publicId).generation !== initial, {
        timeout: 15000,
      })
      .toBe(true);
    await expect
      .poll(() => target.doc(publicId).generation, { timeout: 15000 })
      .toBe(source.doc(publicId).generation);
    expect(target.doc(publicId).text).toBe("first edited\nlast 31\n");
    expect(errors).toEqual([]);
  } finally {
    disconnect();
    await one?.close();
    await two?.close();
    await Promise.all([a.close(), b.close()]);
  }
}, 60000);

it("clears one shared file's history through the barrier while keeping the vault history enabled", async () => {
  await peers(async ({ a, b, one, two, source, target, errors }) => {
    await target.configure({ history: true });
    const id = await source.create("note.md", utf8.encode("first")),
      other = await source.create("other.md", utf8.encode("keep"));
    const invitation = await one.create(source, "file", "note.md");
    await one.grant(invitation, b.contactCard, "edit");
    await two.join(shareLink(invitation), target);
    await expect.poll(() => target.list().length, { timeout: 10000 }).toBe(1);
    const draft = source.draft(id);
    draft.text = "second";
    const saved = await source.save(draft);
    source.release(saved);
    await expect
      .poll(() => target.doc(id).text, { timeout: 10000 })
      .toBe("second");
    const generation = source.doc(id).generation;
    await source.setFileHistory(id, false);
    await expect
      .poll(() => source.doc(id).generation !== generation, { timeout: 15000 })
      .toBe(true);
    await expect
      .poll(() => target.doc(id).generation, { timeout: 15000 })
      .toBe(source.doc(id).generation);
    expect(target.doc(id).text).toBe("second");
    expect(source.policy.history).toBe(true);
    expect(target.policy.history).toBe(true);
    expect(source.historyEnabled(other)).toBe(true);
    expect(target.historyEnabled(id)).toBe(false);
    expect(errors).toEqual([]);
  });
}, 45000);

it(
  "disconnects sharing without deleting files and lets the recipient re-share an independent retained branch",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      const id = await source.create(
        "Original/note.md",
        utf8.encode("retained"),
      );
      const invitation = await one.create(source, "folder", "Original");
      await one.grant(invitation, b.contactCard, "edit");
      await two.join(shareLink(invitation), target, "Chosen location");
      expect(target.find("Chosen location/note.md")?.id).toBe(id);
      await two.disconnect(invitation);
      expect(target.doc(id).text).toBe("retained");
      expect(await target.fs.read("Chosen location/note.md")).toEqual(
        utf8.encode("retained"),
      );
      expect(await two.listShares()).toEqual([]);
      const draft = target.draft(id);
      draft.text = "independent retained copy";
      await target.save(draft);
      const third = await testRepository(new MemoryStorage()),
        thirdVault = await FileVault.open(new Files(), "c"),
        thirdSync = await ProtectedFileSync.open(
          third,
          new Files(),
          await WorkspaceStore.open(new Files(), "c"),
          (e) => errors.push(e),
        );
      const disconnect = connect(b, third);
      try {
        const own = await two.create(target, "file", "Chosen location/note.md");
        await two.grant(own, third.contactCard, "edit");
        await thirdSync.attach(thirdVault);
        await thirdSync.join(shareLink(own), thirdVault, "Inbox");
        await expect
          .poll(() => thirdVault.doc(id).text, { timeout: 10000 })
          .toBe("independent retained copy");
        const sourceDraft = source.draft(id);
        sourceDraft.text = "source moved on";
        await source.save(sourceDraft);
        await one.flush();
        await two.flush();
        expect(thirdVault.find("Inbox/note.md")?.id).toBe(id);
        expect(target.doc(id).text).toBe("independent retained copy");
        expect(source.doc(id).text).toBe("source moved on");
        expect(errors).toEqual([]);
      } finally {
        disconnect();
        await thirdSync.close();
        await third.close();
      }
    }),
  30000,
);

it(
  "revokes future access without issuing file deletions to the other computer",
  async () =>
    peers(async ({ b, one, two, source, target, errors }) => {
      const id = await source.create("note.md", utf8.encode("keep this"));
      const invitation = await one.create(source, "file", "note.md");
      await one.grant(invitation, b.contactCard, "edit");
      await two.join(shareLink(invitation), target);
      await one.revoke(invitation, b.identityId);
      await expect
        .poll(() => b.documentAccess(invitation.url), { timeout: 10000 })
        .toBeUndefined();
      expect(target.doc(id).text).toBe("keep this");
      expect(await target.fs.read("note.md")).toEqual(utf8.encode("keep this"));
      const draft = target.draft(id);
      draft.text = "mine after removal";
      await target.save(draft);
      await two.flush();
      expect(target.doc(id).text).toBe("mine after removal");
      expect(source.doc(id).text).toBe("keep this");
      expect(errors).toEqual([]);
    }),
  30000,
);

it(
  "keeps an overlapping share live after another share is disconnected",
  async () =>
    peers(async ({ b, one, two, source, target, errors }) => {
      const id = await source.create("Shared/note.md", utf8.encode("first"));
      const folder = await one.create(source, "folder", "Shared"),
        file = await one.create(source, "file", "Shared/note.md");
      await one.grant(folder, b.contactCard, "edit");
      await one.grant(file, b.contactCard, "edit");
      await two.join(shareLink(folder), target);
      await two.join(shareLink(file), target, "Shared");
      await one.disconnect(folder);
      const draft = source.draft(id);
      draft.text = "still shared by file";
      await source.save(draft);
      await expect
        .poll(() => target.doc(id).text, { timeout: 10000 })
        .toBe("still shared by file");
      expect(target.find("Shared/note.md")?.id).toBe(id);
      expect(errors).toEqual([]);
    }),
  30000,
);

it(
  "changes current-item membership access without changing the file",
  async () =>
    peers(async ({ b, one, two, source, target, errors }) => {
      const id = await source.create("note.md", utf8.encode("shared"));
      const invitation = await one.create(source, "file", "note.md");
      await one.grant(invitation, b.contactCard, "edit");
      await two.join(shareLink(invitation), target);
      await one.setAccess(invitation, b.identityId, "read");
      await expect
        .poll(() => b.documentAccess(invitation.url), { timeout: 10000 })
        .toBe("read");
      await one.setAccess(invitation, b.identityId, "edit");
      await expect
        .poll(() => b.documentAccess(invitation.url), { timeout: 10000 })
        .toBe("edit");
      expect(target.doc(id).text).toBe("shared");
      expect(errors).toEqual([]);
    }),
  30000,
);

it(
  "keeps vault routes across workspace switches without merging or expanding the inactive workspace",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      const id = await source.create("note.md", utf8.encode("first"));
      const invitation = await one.createWorkspace([source]);
      await one.grant(invitation, b.contactCard, "edit");
      const root = await one.inspectInvitation(shareLink(invitation));
      const child = root.doc().vaults[source.id];
      await two.join(
        shareLink({
          format: "saddle-share-invitation/1",
          name: child.name,
          kind: "vault",
          url: child.url,
        }),
        target,
      );
      const nextWorkspace = await WorkspaceStore.open(
        new Files(),
        "a",
        "Different workspace",
      );
      await one.close();
      const switched = await ProtectedFileSync.open(
        a,
        one.local,
        nextWorkspace,
        (e) => errors.push(e),
      );
      try {
        await switched.attach(source);
        const unrelated = await FileVault.open(new Files(), "a");
        await unrelated.configure({ sync: true });
        await switched.attach(unrelated);
        const draft = source.draft(id);
        draft.text = "edited from another workspace";
        await source.save(draft);
        await expect
          .poll(() => target.doc(id).text, { timeout: 10000 })
          .toBe("edited from another workspace");
        expect(nextWorkspace.current.name).toBe("Different workspace");
        expect(nextWorkspace.current.id).not.toBe(one.workspace.current.id);
        expect(root.doc().vaults[unrelated.id]).toBeUndefined();
        expect(errors).toEqual([]);
      } finally {
        await switched.close();
      }
    }),
  30000,
);

it(
  "reopens revoked routes as retained local files after an offline restart",
  async () =>
    peers(async ({ b, one, two, source, target, errors }) => {
      const id = await source.create("note.md", utf8.encode("still here")),
        invitation = await one.create(source, "file", "note.md");
      await one.grant(invitation, b.contactCard, "edit");
      await two.join(shareLink(invitation), target);
      await one.revoke(invitation, b.identityId);
      await expect
        .poll(() => b.documentAccess(invitation.url), { timeout: 10000 })
        .toBeUndefined();
      await two.close();
      const restarted = await ProtectedFileSync.open(
        b,
        two.local,
        two.workspace,
        (e) => errors.push(e),
      );
      try {
        await restarted.attach(target);
        expect(target.doc(id).text).toBe("still here");
        expect(await restarted.listShares()).toEqual([]);
        const draft = target.draft(id);
        draft.text = "my retained file";
        await target.save(draft);
        await restarted.flush();
        expect(target.doc(id).text).toBe("my retained file");
        expect(errors).toEqual([]);
      } finally {
        await restarted.close();
      }
    }),
  30000,
);

it(
  "keeps a revoked workspace's settings and files available after restart",
  async () =>
    peers(async ({ a, b, one, two, source, target, errors }) => {
      const id = await source.create(
        "note.md",
        utf8.encode("retained workspace file"),
      );
      const invitation = await one.createWorkspace([source]);
      await one.grant(invitation, b.contactCard, "edit");
      const scope = await two.inspectInvitation(shareLink(invitation));
      const child = scope.doc().vaults[source.id];
      await two.join(
        shareLink({
          format: "saddle-share-invitation/1",
          name: child.name,
          kind: "vault",
          url: child.url,
        }),
        target,
      );
      await two.joinWorkspace(shareLink(invitation), "b", {});
      await one.revoke(invitation, b.identityId);
      await expect
        .poll(() => b.documentAccess(invitation.url), { timeout: 10000 })
        .toBeUndefined();
      await two.close();
      const restarted = await ProtectedFileSync.open(
        b,
        two.local,
        two.workspace,
        (e) => errors.push(e),
      );
      try {
        await restarted.attach(target);
        expect(target.doc(id).text).toBe("retained workspace file");
        expect(restarted.workspace.current.id).toBe(one.workspace.current.id);
        expect(await restarted.listShares()).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await restarted.close();
      }
    }),
  30000,
);

it(
  "pauses a share locally without changing its grants or the other share, then resumes pending edits",
  async () =>
    peers(async ({ b, one, two, source, target, errors }) => {
      const first = await source.create("first.md", utf8.encode("first")),
        second = await source.create("second.md", utf8.encode("second"));
      const firstInvite = await one.create(source, "file", "first.md"),
        secondInvite = await one.create(source, "file", "second.md");
      for (const invite of [firstInvite, secondInvite]) {
        await one.grant(invite, b.contactCard, "edit");
        await two.join(shareLink(invite), target);
      }
      const edit = async (id: string, text: string) => {
        const draft = source.draft(id);
        draft.text = text;
        await source.save(draft);
        source.release(draft);
      };
      await one.setBroadcast(firstInvite, false);
      await edit(first, "held while outgoing paused");
      await edit(second, "still broadcasting");
      await expect
        .poll(() => target.doc(second).text, { timeout: 10000 })
        .toBe("still broadcasting");
      expect(target.doc(first).text).toBe("first");
      expect(source.syncEnabled(first)).toBe(true);
      expect(
        (await one.listShares()).find(
          (share) => share.invitation.url === firstInvite.url,
        )?.broadcast,
      ).toBe(false);
      expect(await b.documentAccess(firstInvite.url)).toBe("edit");
      await one.setBroadcast(firstInvite, true);
      await expect
        .poll(() => target.doc(first).text, { timeout: 10000 })
        .toBe("held while outgoing paused");
      await two.setBroadcast(firstInvite, false);
      await edit(first, "held while incoming paused");
      await edit(second, "other share continues");
      await expect
        .poll(() => target.doc(second).text, { timeout: 10000 })
        .toBe("other share continues");
      expect(target.doc(first).text).toBe("held while outgoing paused");
      await two.setBroadcast(firstInvite, true);
      await expect
        .poll(() => target.doc(first).text, { timeout: 10000 })
        .toBe("held while incoming paused");
      expect(target.entry(first).deleted).toBe(false);
      expect(errors).toEqual([]);
    }),
  40000,
);

it(
  "pauses workspace settings at the workspace share while an independent file share continues",
  async () =>
    peers(async ({ b, one, two, source, target, errors }) => {
      const id = await source.create("note.md", utf8.encode("first"));
      const root = await one.createWorkspace([source]);
      await one.grant(root, b.contactCard, "edit");
      const scope = (await one.inspectInvitation(shareLink(root))).doc();
      await two.join(
        shareLink({
          format: "saddle-share-invitation/1",
          name: source.name,
          kind: "vault",
          url: scope.vaults[source.id].url,
        }),
        target,
      );
      await two.joinWorkspace(shareLink(root), "b", {});
      const original = two.workspace.current.name;
      await one.setBroadcast(root, false);
      await one.workspace.update((doc) => {
        doc.name = "Paused workspace name";
      });
      const draft = source.draft(id);
      draft.text = "File share stays active";
      await source.save(draft);
      source.release(draft);
      await expect
        .poll(() => target.doc(id).text, { timeout: 10000 })
        .toBe("File share stays active");
      expect(two.workspace.current.name).toBe(original);
      await one.setBroadcast(root, true);
      await expect
        .poll(() => two.workspace.current.name, { timeout: 10000 })
        .toBe("Paused workspace name");
      expect(errors).toEqual([]);
    }),
  40000,
);

it("checks a link's advertised kind against the signed share before admission or materialization", async () => {
  await peers(async ({ one, two, source, target, b }) => {
    await source.create("note.md", utf8.encode("private scope"));
    const invitation = await one.create(source, "file", "note.md");
    await one.grant(invitation, b.contactCard, "edit");
    const forged = shareLink({ ...invitation, kind: "vault" });
    await expect(ProtectedFileSync.inspect(b, forged)).rejects.toThrow(
      "scope differs",
    );
    await expect(two.join(forged, target)).rejects.toThrow("scope differs");
    expect(target.list()).toEqual([]);
    expect(await two.listShares()).toEqual([]);
  });
});

it("shares folder-owned keys and file-owned template settings, including later edits in both directions", async () => {
  await peers(async ({ b, one, two, source, target, errors }) => {
    await source.createFolder("Templates");
    await source.setNamedPath("templates", "Templates", "folder");
    const id = await source.create(
      "Templates/source.md",
      utf8.encode("template"),
    );
    await source.setTemplate("Templates/source.md", "Example");
    const invitation = await one.create(source, "folder", "Templates");
    await one.grant(invitation, b.contactCard, "edit");
    await two.join(shareLink(invitation), target);
    expect(Object.values(target.namedPaths)).toContainEqual(
      expect.objectContaining({ key: "templates", path: "Templates" }),
    );
    expect(target.templates["Templates/source.md"]?.name).toBe("Example");
    await target.setNamedPath("notes", "Templates", "folder");
    await two.flush();
    await expect
      .poll(
        () =>
          Object.values(source.namedPaths).some((item) => item.key === "notes"),
        { timeout: 10000 },
      )
      .toBe(true);
    await target.setTemplate("Templates/source.md", "Updated");
    await two.flush();
    await expect
      .poll(() => source.doc(id).resource?.saddle?.templateDefinition, {
        timeout: 10000,
      })
      .toEqual({ name: "Updated", enabled: true });
    expect(errors).toEqual([]);
  });
}, 25000);

it("retires folder metadata transports when a folder leaves a parent share while its own share remains", async () => {
  await peers(async ({ a, b, one, two, source, target, errors }) => {
    await source.createFolder("public/Child");
    await source.setNamedPath("templates", "public/Child", "folder");
    await source.create("public/Child/note.md", utf8.encode("note"));
    const parent = await one.create(source, "folder", "public");
    const child = await one.create(source, "folder", "public/Child");
    await one.grant(parent, b.contactCard, "edit");
    await two.join(shareLink(parent), target);
    const before = (await a.load<ShareDocument>(child.url)).doc();
    const unit = before.unit!.id,
      oldURL = before.folders[unit].url;
    await source.moveFolder("public/Child", "Outside");
    await source.setNamedPath("notes", "Outside", "folder");
    await one.flush();
    const after = (await a.load<ShareDocument>(child.url)).doc().folders[unit]
      .url;
    expect(after).not.toBe(oldURL);
    expect(await b.documentAccess(after)).toBeUndefined();
    const old = await b.load<{ namedKeys: string[] }>(oldURL);
    expect(old.doc().namedKeys).not.toContain("notes");
    expect(errors).toEqual([]);
  });
}, 25000);

it("keeps explicitly disabled descendants out of later parent shares until their override is unset", async () => {
  await peers(async ({ b, one, two, source, target, errors }) => {
    const visible = await source.create(
      "parent/visible.md",
      utf8.encode("visible"),
    );
    const blocked = await source.create(
      "parent/blocked/note.md",
      utf8.encode("private"),
    );
    await source.configureScope("folder", "parent/blocked", { sync: false });
    const invitation = await one.create(source, "folder", "parent");
    await one.grant(invitation, b.contactCard, "edit");
    await two.join(shareLink(invitation), target);
    expect(target.list().map((file) => file.id)).toEqual([visible]);
    const future = await source.create(
      "parent/blocked/future.md",
      utf8.encode("also private"),
    );
    await one.flush();
    const scope = await one.inspectInvitation(shareLink(invitation));
    expect(Object.keys(scope.doc().files)).toEqual([visible]);
    expect(target.hasEntry(blocked)).toBe(false);
    expect(target.hasEntry(future)).toBe(false);
    await source.configureScope("folder", "parent/blocked", {
      sync: undefined,
    });
    await one.flush();
    await expect
      .poll(
        () =>
          target
            .list()
            .map((file) => file.id)
            .sort(),
        { timeout: 10000 },
      )
      .toEqual([visible, blocked, future].sort());
    expect(errors).toEqual([]);
  });
}, 20000);

it("rejects a folder document readable through individual access before materializing its forged route", async () => {
  await peers(async ({ a, b, one, two, source, target, errors }) => {
    await source.create("public/note.md", utf8.encode("public"));
    const invitation = await one.create(source, "folder", "public");
    await one.grant(invitation, b.contactCard, "edit");
    await two.join(shareLink(invitation), target);
    const id = crypto.randomUUID();
    const outside = await b.importProtected(
      A.save(
        A.from({
          format: "saddle-folder/1",
          id,
          features: { sync: true },
          namedKeys: [],
          resource: null,
          children: {},
        }),
      ),
    );
    await b.grant(outside, a.contactCard, "edit");
    await a.load(outside.url);
    const scope = await b.load<ShareDocument>(invitation.url);
    scope.change((doc) => {
      doc.folders[id] = {
        id,
        path: "injected",
        url: outside.url,
        retention: outside.url,
      };
    });
    await b.flush();
    await expect
      .poll(
        () =>
          errors.some((error) =>
            String(error).includes(
              "Shared folder is outside its authenticated access group",
            ),
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    expect(source.directories()).not.toContain("public/injected");
    expect(target.directories()).not.toContain("public/injected");
  });
}, 20000);

it("keeps disabled shared folder versions until the offline computer agrees, then removes both old archives", async () => {
  await peers(
    async ({
      a,
      b,
      one,
      two,
      source,
      target,
      disconnect,
      reconnect,
      errors,
    }) => {
      await source.createFolder("shared");
      await source.setFolderResource("shared", {
        name: "shared",
        data: [],
        metadata: { revision: "first" },
      });
      await source.setFolderResource("shared", {
        name: "shared",
        data: [],
        metadata: { revision: "second" },
      });
      const invite = await one.create(source, "folder", "shared");
      await one.grant(invite, b.contactCard, "edit");
      await two.join(shareLink(invite), target);
      const scope = await a.load<ShareDocument>(invite.url);
      const unit = scope.doc().unit!.id;
      const previous = scope.doc().folders[unit].url;
      const control = await a.load<
        import("../packages/core/vaults/retention").RetentionDocument
      >(scope.doc().folders[unit].retention);
      expect(source.historyProtection(unit)).toBeDefined();
      disconnect();
      await source.configureScope("folder", "shared", { history: false });
      await one.flush();
      await expect
        .poll(() => control.doc().proposal?.phase, { timeout: 5000 })
        .toBe("prepare");
      expect(source.folderHistory("shared")).toEqual([]);
      expect(
        A.stats((await source.folderSnapshots("shared"))[0].doc).numChanges,
      ).toBeGreaterThan(1);
      expect(scope.doc().folders[unit].url).toBe(previous);
      reconnect();
      await expect
        .poll(() => control.doc().proposal?.phase, { timeout: 15000 })
        .toBe("commit");
      await expect
        .poll(
          async () =>
            A.stats((await source.folderSnapshots("shared"))[0].doc).numChanges,
          { timeout: 10000 },
        )
        .toBe(1);
      await expect
        .poll(
          async () =>
            A.stats((await target.folderSnapshots("shared"))[0].doc).numChanges,
          { timeout: 10000 },
        )
        .toBe(1);
      expect(source.folderHistory("shared")).toEqual([]);
      expect(target.folderHistory("shared")).toEqual([]);
      expect(errors.map(String)).not.toContain(
        expect.stringContaining("checkpoint does not match"),
      );
    },
  );
}, 30000);

it.each(["file", "folder"] as const)(
  "finishes %s cleanup after history and sharing are disabled, waiting for the offline peer",
  async (kind) => {
    await peers(
      async ({
        a,
        b,
        one,
        source,
        target,
        two,
        disconnect,
        reconnect,
        errors,
      }) => {
        const id = await source.create("shared/note.md", utf8.encode("first"));
        const draft = source.draft(id);
        draft.text = "final shared content";
        source.release(await source.save(draft));
        source.release(draft);
        const path = kind === "file" ? "shared/note.md" : "shared";
        const invite = await one.create(source, kind, path);
        await one.grant(invite, b.contactCard, "edit");
        await two.join(shareLink(invite), target);
        const scope = await a.load<ShareDocument>(invite.url);
        const unit = scope.doc().unit!.id;
        const reference =
          kind === "file" ? scope.doc().files[unit] : scope.doc().folders[unit];
        const control = await a.load<
          import("../packages/core/vaults/retention").RetentionDocument
        >(reference.retention);
        disconnect();
        await source.configureScope(kind, kind === "file" ? id : path, {
          history: false,
          sync: false,
        });
        await target.configureScope(kind, kind === "file" ? id : path, {
          history: false,
          sync: false,
        });
        await one.flush();
        expect(source.historyProtection(unit)).toBeDefined();
        await expect
          .poll(() => control.doc().proposal?.phase, { timeout: 5000 })
          .toBe("prepare");
        reconnect();
        await expect
          .poll(() => source.historyProtection(unit), { timeout: 15000 })
          .toBeUndefined();
        await expect
          .poll(() => target.historyProtection(unit), { timeout: 10000 })
          .toBeUndefined();
        const sourceRecord =
          kind === "file" ? "content.automerge" : "folder.automerge";
        await expect
          .poll(() => source.companions.read(path, sourceRecord))
          .toBeUndefined();
        const targetPath = kind === "file" ? "note.md" : "shared";
        await expect
          .poll(() => target.companions.read(targetPath, sourceRecord))
          .toBeUndefined();
        expect(source.doc(id).text).toBe("final shared content");
        expect(target.doc(id).text).toBe("final shared content");
        expect(errors).toEqual([]);
      },
    );
  },
  30000,
);

it("Unset inherits parent access, blocks direct grants and stops publishing to its own dormant share", async () => {
  await peers(async ({ b, one, two, source, target, errors }) => {
    const guest = await testRepository(new MemoryStorage());
    try {
      const id = await source.create("shared/note.md", utf8.encode("before"));
      const parent = await one.create(source, "folder", "shared");
      await one.grant(parent, b.contactCard, "edit");
      await two.join(shareLink(parent), target);
      const direct = await one.create(source, "file", "shared/note.md");
      await one.grant(direct, guest.contactCard, "read");
      const directScope = await one.repository.load<ShareDocument>(direct.url);
      const oldURL = directScope.doc().files[id].url;
      const old =
        await one.repository.load<
          import("../packages/core/vaults/contracts").FileDocument
        >(oldURL);
      await source.configureScope("file", id, { sync: undefined });
      await one.flush();
      expect(source.syncEnabled(id)).toBe(true);
      await expect(
        one.grant(direct, guest.contactCard, "read"),
      ).rejects.toThrow("Enable Sharing");
      const draft = source.draft(id);
      draft.text = "parent access only";
      source.release(await source.save(draft));
      source.release(draft);
      await one.flush();
      await expect
        .poll(() => target.doc(id).text, { timeout: 10000 })
        .toBe("parent access only");
      expect(old.doc().text).toBe("before");
      expect(errors).toEqual([]);
    } finally {
      await guest.close();
    }
  });
}, 25000);

it.each(["file", "folder"] as const)(
  "resumes %s sharing private edits after disabled history has been fully cleaned and reopened",
  async (kind) => {
    await peers(async ({ b, one, two, source, target, errors }) => {
      const id = await source.create("shared/note.md", utf8.encode("shared"));
      const path = kind === "file" ? "shared/note.md" : "shared";
      const invite = await one.create(source, kind, path);
      await one.grant(invite, b.contactCard, "edit");
      await two.join(shareLink(invite), target);
      await source.configureScope(kind, kind === "file" ? id : path, {
        history: false,
        sync: false,
      });
      await target.configureScope(kind, kind === "file" ? id : path, {
        history: false,
        sync: false,
      });
      await one.flush();
      await expect
        .poll(() => source.historyProtections().length, { timeout: 15000 })
        .toBe(0);
      await expect
        .poll(() => target.historyProtections().length, { timeout: 10000 })
        .toBe(0);
      const draft = source.draft(id);
      draft.text = "private edit";
      source.release(await source.save(draft));
      source.release(draft);
      await source.compactLocal(id);
      expect(target.doc(id).text).toBe("shared");
      if (kind === "folder")
        await source.setFolderResource(path, {
          name: "shared",
          data: [],
          metadata: { owner: "private" },
        });
      one.detach(source.id);
      two.detach(target.id);
      const reopened = await FileVault.open(source.fs, source.id);
      const destination = await FileVault.open(target.fs, target.id);
      await one.attach(reopened);
      await two.attach(destination);
      await destination.configureScope(kind, kind === "file" ? id : path, {
        sync: true,
      });
      await reopened.configureScope(kind, kind === "file" ? id : path, {
        sync: true,
      });
      await one.flush();
      await expect
        .poll(() => destination.doc(id).text, { timeout: 15000 })
        .toBe("private edit");
      if (kind === "folder")
        await expect
          .poll(
            () => destination.folderDocument(path)?.resource?.metadata?.owner,
            {
              timeout: 10000,
            },
          )
          .toBe("private");
      expect(errors).toEqual([]);
    });
  },
  40000,
);

it.each(["file", "folder"] as const)(
  "prunes %s archives and retired transport bytes immediately after the last guest is removed",
  async (kind) => {
    await peers(
      async ({ a, b, one, two, source, target, disconnect, errors }) => {
        const id = await source.create("shared/note.md", utf8.encode("first"));
        const draft = source.draft(id);
        draft.text = "saved";
        source.release(await source.save(draft));
        source.release(draft);
        const path = kind === "file" ? "shared/note.md" : "shared";
        const invite = await one.create(source, kind, path);
        await one.grant(invite, b.contactCard, "edit");
        await two.join(shareLink(invite), target);
        const scope = await a.load<ShareDocument>(invite.url),
          unit = scope.doc().unit!.id;
        const previous =
          kind === "file"
            ? scope.doc().files[unit].url
            : scope.doc().folders[unit].url;
        const old = await a.load(previous);
        disconnect();
        await source.configureScope(kind, kind === "file" ? id : path, {
          history: false,
        });
        await one.flush();
        expect(source.historyProtection(unit)).toBeDefined();
        await one.revoke(invite, b.identityId);
        expect(source.historyProtection(unit)).toBeUndefined();
        expect(source.getFreeze(unit)).toBeUndefined();
        expect(old.state).toBe("deleted");
        expect(source.doc(id).text).toBe("saved");
        expect(A.stats(source.doc(id)).numChanges).toBe(1);
        if (kind === "folder")
          expect(A.stats(source.folderDocument(path)!).numChanges).toBe(1);
        expect(errors).toEqual([]);
      },
    );
  },
  25000,
);
