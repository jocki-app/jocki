import { afterEach, expect, it, vi } from "vitest";
import { MemoryStorage } from "../packages/storage";
import { DuckStorage } from "../packages/storage/duckdb";
import { SqlDatabase } from "../packages/storage/database";
import {
  initializeCheckpoints,
  loadCheckpoints,
  saveCheckpoints,
} from "../packages/storage/projection-checkpoints";
import {
  DocumentProjection,
  type ProjectionBatch,
} from "../packages/core/projection";
import { DeviceCore } from "./fixtures/device";
import { DeviceCore as Core } from "../packages/core/device";
import { openNodeRepository } from "../packages/platform-node/repository";
import { FileStorage } from "../packages/platform-node/storage";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { field } from "@jocki/platform/field-types";
import { schemaById } from "@jocki/platform/core/catalog";
import { userTableName } from "../packages/storage/projection";
import {
  openDatabase,
  type Database,
} from "../packages/platform-node/compat/database";
import { migrate } from "../packages/platform-node/compat/schema";
import {
  projectWorkspace,
  stopWorkspaceProjections,
} from "../packages/platform-node/compat/projection";

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const value of opened.splice(0)) await value.close();
});
async function fixture(name = "Computer") {
  const sql = new DuckStorage();
  const apply = vi.fn((id: string, batch: ProjectionBatch) =>
    sql.applyProjection(id, batch),
  );
  const storage = Object.assign(new MemoryStorage(), {
    projectionCheckpoints: (id: string) => sql.projectionCheckpoints(id),
    applyProjection: apply,
  });
  const core = await DeviceCore.open(storage, name);
  opened.push(core, sql);
  return { core, sql, apply, db: await sql.database() };
}
const keys = (apply: ReturnType<typeof vi.fn>) =>
  apply.mock.calls.flatMap(([, batch]) =>
    (batch as ProjectionBatch).documents.map((doc) => doc.id),
  );

it.each(["disk", "memory"] as const)(
  "round-trips projection checkpoints through %s DuckDB",
  async (workingStorage) => {
    const db = await SqlDatabase.open({ workingStorage });
    try {
      await db.query("CREATE SCHEMA jocki");
      await initializeCheckpoints(db);
      const checkpoint = {
        id: "record/example",
        source: "automerge:example",
        heads: ["first", "second"],
        contract: '{"version":"test"}',
      };
      await db.transaction((sql) =>
        saveCheckpoints(sql, "workspace", {
          documents: [],
          removed: [],
          checkpoints: [checkpoint],
        }),
      );
      const [loaded] = await loadCheckpoints(db, "workspace");
      // Wasm uses Arrow vectors for SQL lists; checkpoint heads must be plain arrays.
      expect(Array.isArray(loaded.heads)).toBe(true);
      expect(loaded).toEqual(checkpoint);
      expect(await loadCheckpoints(db, "another-workspace")).toEqual([]);
    } finally {
      await db.close();
    }
  },
);

it.each(["tables", "item_schemas"])(
  "updates only affected SQL rows and refreshes joins when a %s definition is removed",
  async (definition) => {
    const { core, db: sql } = await fixture("Native"),
      node = await core.createWorkspace("Native index");
    const space = await node.records.ensureSchema();
    await node.records.put(
      "item_schemas",
      {
        ...space.data,
        columns: [
          field("subject", "Subject", "text", {
            scope: "shared",
            storage: "custom",
          }),
        ],
      },
      space.id,
    );
    const table = await node.records.ensureTable("tasks", space.id);
    await node.records.put(
      "tables",
      { ...table.data, bindings: { title: "subject" } },
      table.id,
    );
    const first = await node.records.put("tasks", {
      table_id: table.id,
      custom_fields: { subject: "First" },
    });
    const other = await node.records.put("tasks", {
      table_id: table.id,
      custom_fields: { subject: "Other" },
    });
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "jocki-native-index-"),
    );
    const database = await openDatabase(directory, core),
      writes: string[] = [];
    const observe = (db: Database): Database => ({
      ...db,
      query: async (statement, values) => {
        if (statement.startsWith("INSERT INTO jocki.resources"))
          writes.push(String(values?.[0]));
        return db.query(statement, values) as any;
      },
      transaction: (work) => db.transaction((tx) => work(observe(tx))),
    });
    const db = observe(database.database);
    try {
      await migrate(db);
      await projectWorkspace(db, node);
      writes.length = 0;
      const sharedId = String(first.data.item_id),
        handle = node.replica.graph.item("record/" + sharedId)!;
      handle.change((doc) => {
        (doc.value.data as any).values.subject = "Changed shared value";
      });
      await node.replica.flush();
      await projectWorkspace(db, node);
      expect(writes.sort()).toEqual([sharedId, first.id].sort());
      expect(writes).not.toContain(other.id);
      expect(
        (await db.query("SELECT title FROM jocki.p_tasks ORDER BY title"))
          .rows,
      ).toEqual([{ title: "Changed shared value" }, { title: "Other" }]);
      writes.length = 0;
      await projectWorkspace(db, node);
      expect(writes).toEqual([]);
      // Removing a binding definition must also remove its derived SQL joins.
      const removedId = definition === "tables" ? table.id : space.id,
        tableHandle = node.replica.graph.item("record/" + removedId)!,
        location = tableHandle.doc()!,
        parent = node.replica.graph.plugin(
          location.schemaId,
          location.pluginId,
        )!;
      parent.change((doc) => {
        delete doc.items["record/" + removedId];
      });
      await node.replica.flush();
      await projectWorkspace(db, node);
      const expected = [first, other]
        .map((record) => ({
          id: record.id,
          title: node.records.get(record.id)!.data.title ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(
        await sql.query(
          "SELECT _record_id::VARCHAR AS id,title FROM collections.tasks ORDER BY id",
        ),
      ).toEqual(expected);
      expect(
        (
          await db.query(
            "SELECT id::VARCHAR AS id,title FROM jocki.p_tasks ORDER BY id",
          )
        ).rows,
      ).toEqual(expected);
    } finally {
      stopWorkspaceProjections(db);
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("projects only a changed leaf and removes rows when index links disappear", async () => {
  const { core, apply, db } = await fixture(),
    node = await core.createWorkspace("Index");
  const first = await node.records.put("variables", { name: "First" }),
    second = await node.records.put("variables", { name: "Second" });
  await node.replica.flush();
  apply.mockClear();
  const enumerate = vi.spyOn(node.replica, "ids");
  const handle = node.replica.graph.item("record/" + first.id)!;
  handle.change((doc) => {
    (doc.value.data as any).name = "Edited";
  });
  await node.replica.flush();
  expect(enumerate).not.toHaveBeenCalled();
  expect(keys(apply)).toEqual(["record/" + first.id]);
  expect(
    await db.query("SELECT name FROM collections.variables ORDER BY name"),
  ).toEqual([{ name: "Edited" }, { name: "Second" }]);
  apply.mockClear();
  await node.replica.flush();
  expect(apply).not.toHaveBeenCalled();
  expect(enumerate).not.toHaveBeenCalled();
  const index = node.replica.graph.plugin(
    node.replica.graph.defaultSchemaId,
    handle.doc()!.pluginId,
  )!;
  index.change((doc) => {
    delete doc.items["record/" + second.id];
  });
  await node.replica.flush();
  expect(await db.query("SELECT name FROM collections.variables")).toEqual([
    { name: "Edited" },
  ]);
  expect(
    await db.query(
      "SELECT id FROM jocki.projection_checkpoints WHERE id=?",
      ["record/" + second.id],
    ),
  ).toEqual([]);
});

it("commits checkpoints with rows, retries failed SQL transactions, and rebuilds from documents", async () => {
  const { core, sql, db } = await fixture(),
    node = await core.createWorkspace("Retry"),
    row = await node.records.put("variables", { name: "Before" });
  const id = "record/" + row.id,
    previous = (await sql.projectionCheckpoints(node.link.id)).find(
      (value) => value.id === id,
    )!;
  const query = db.driver.query.bind(db.driver);
  let failed = false;
  const spy = vi
    .spyOn(db.driver, "query")
    .mockImplementation(async (statement, values) => {
      if (
        !failed &&
        statement.startsWith(
          "INSERT OR REPLACE INTO jocki.projection_checkpoints",
        )
      ) {
        failed = true;
        throw Error("Injected checkpoint failure");
      }
      return query(statement, values);
    });
  const raw = node.replica.read<any>(id)!;
  await expect(
    node.replica.update(id, { ...raw, data: { ...raw.data, name: "After" } }),
  ).rejects.toThrow("Injected checkpoint failure");
  expect(await db.query("SELECT name FROM collections.variables")).toEqual([
    { name: "Before" },
  ]);
  expect(
    (await sql.projectionCheckpoints(node.link.id)).find(
      (value) => value.id === id,
    ),
  ).toEqual(previous);
  spy.mockRestore();
  await node.replica.flush();
  expect(await db.query("SELECT name FROM collections.variables")).toEqual([
    { name: "After" },
  ]);
  const current = (await sql.projectionCheckpoints(node.link.id)).find(
    (value) => value.id === id,
  )!;
  expect(current.heads).toEqual(node.replica.heads(id));
  expect(current.source).toBe(node.replica.graph.item(id)!.url);
  const history = node.replica.heads("");
  await db.query("DELETE FROM item_data.variables");
  await node.replica.rebuildProjection();
  expect(await db.query("SELECT name FROM collections.variables")).toEqual([
    { name: "After" },
  ]);
  expect(node.replica.heads("")).toEqual(history);
});

it("indexes shared-setting patches independently", async () => {
  const { core, apply } = await fixture(),
    node = await core.createWorkspace("Settings");
  await node.replica.update("setting/plugin.tasks.view", { value: "board" });
  await node.replica.update("setting/plugin.time.view", { value: "list" });
  await node.replica.flush();
  apply.mockClear();
  node.replica.graph.sharedSettings().change((doc) => {
    doc.values["setting/plugin.tasks.view"].value = "list";
  });
  await node.replica.flush();
  expect(keys(apply)).toEqual(["setting/plugin.tasks.view"]);
});

it("updates derived SQL after peer document sync and clears it on workspace revocation", async () => {
  const a = await fixture("A"),
    b = await fixture("B"),
    source = await a.core.createWorkspace("Sync");
  const row = await source.records.put("variables", { name: "Original" });
  const target = await b.core.join(
    await a.core.approve(source.link.id, b.core.pairingRequest()),
  );
  await source.replica.flush();
  await target.replica.flush();
  b.apply.mockClear();
  const handle = source.replica.graph.item("record/" + row.id)!;
  handle.change((doc) => {
    (doc.value.data as any).name = "Remote edit";
  });
  await source.replica.flush();
  await expect
    .poll(() => b.db.query("SELECT name FROM collections.variables"), {
      timeout: 12000,
    })
    .toEqual([{ name: "Remote edit" }]);
  expect(keys(b.apply).filter((id) => id.startsWith("record/"))).toEqual([
    "record/" + row.id,
  ]);
  await a.core.revoke(source.link.id, b.core.identity.id);
  await expect
    .poll(() => b.db.query("SELECT name FROM collections.variables"), {
      timeout: 12000,
    })
    .toEqual([]);
  expect(
    await b.db.query("SELECT id FROM jocki.projection_checkpoints"),
  ).toEqual([]);
});

it("catches up a stale filesystem projection after document changes made while core was closed", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jocki-index-restart-"),
  );
  let core: Core | undefined;
  const open = async () =>
    Core.open(
      new FileStorage(directory),
      "Computer",
      () => [],
      await openNodeRepository(path.join(directory, "automerge")),
    );
  try {
    core = await open();
    const node = await core.createWorkspace("Restart"),
      row = await node.records.put("variables", { name: "Before" });
    const id = node.link.id,
      url = node.replica.graph.item("record/" + row.id)!.url;
    await core.close();
    const repo = await openNodeRepository(path.join(directory, "automerge"));
    const handle = await repo.repo.find<any>(url);
    handle.change((doc: any) => {
      doc.value.data.name = "While closed";
    });
    await repo.close();
    core = await open();
    const apply = vi.spyOn(core.storage, "applyProjection");
    const restored = await core.workspace(id);
    expect(keys(apply)).toEqual(["record/" + row.id]);
    expect(restored.records.get(row.id)?.data.name).toBe("While closed");
    apply.mockClear();
    await restored.replica.flush();
    expect(apply).not.toHaveBeenCalled();
  } finally {
    await core?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("reprojects dependent rows when table definitions arrive or change, without touching other tables", async () => {
  const sql = new DuckStorage();
  opened.push(sql);
  const data = new Map<string, any>(),
    listeners = new Set<(id: string) => void>();
  const source = {
    member: { access: "write" },
    listeners,
    ids: () => [...data.keys()],
    read: (id: string) => data.get(id)?.value,
    heads: (id: string) => data.get(id)?.heads ?? [],
    graph: {
      source: (id: string) => (data.has(id) ? id : undefined),
      target: (id: string) => data.get(id)?.value,
    },
  };
  const apply = vi.fn((batch: ProjectionBatch) =>
    sql.applyProjection("test", batch),
  );
  const index = new DocumentProjection(
    source as any,
    { load: () => sql.projectionCheckpoints("test"), apply },
    "test-1",
  );
  const workspaceId = crypto.randomUUID(),
    ownerId = crypto.randomUUID();
  const record = (
    collection: string,
    value: Record<string, unknown>,
    id = crypto.randomUUID(),
  ) => ({
    id: "record/" + id,
    heads: [String(crypto.randomUUID())],
    value: {
      id,
      workspaceId,
      ownerId,
      collection,
      pluginId: collection,
      schemaVersion: schemaById.get(collection)?.version ?? 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      revision: 1,
      data: value,
    },
  });
  const tableId = crypto.randomUUID(),
    otherId = crypto.randomUUID();
  const late = record("table_rows", {
      table_id: tableId,
      values: { label: "Late", extra: "Retained" },
    }),
    other = record("variables", { name: "Other" }, otherId);
  for (const doc of [late, other]) data.set(doc.id, doc);
  await index.synchronize();
  apply.mockClear();
  const table = record(
    "tables",
    { name: "Table", columns: [field("label", "Label")] },
    tableId,
  );
  data.set(table.id, table);
  listeners.forEach((listener) => listener(table.id));
  await index.synchronize();
  expect(
    apply.mock.calls
      .at(-1)![0]
      .documents.map((doc) => doc.id)
      .sort(),
  ).toEqual([table.id, late.id].sort());
  const db = await sql.database(),
    name = "tables." + userTableName(tableId);
  expect(await db.query(`SELECT label FROM ${name}`)).toEqual([
    { label: "Late" },
  ]);
  table.heads = ["schema-change"];
  (table.value.data.columns as unknown[]).push(field("extra", "Extra"));
  listeners.forEach((listener) => listener(table.id));
  await index.synchronize();
  expect(await db.query(`SELECT label,extra FROM ${name}`)).toEqual([
    { label: "Late", extra: "Retained" },
  ]);
  expect(
    apply.mock.calls.at(-1)![0].documents.some((doc) => doc.id === other.id),
  ).toBe(false);
  index.stop();
});
