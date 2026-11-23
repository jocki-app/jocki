import { expect, it } from "vitest";
import { DeviceCore } from "./fixtures/device";

import { DuckStorage } from "../packages/storage/duckdb";
import { field } from "@jocki/platform/field-types";
import { schemaById } from "@jocki/platform/core/catalog";
import { userTableName } from "../packages/storage/projection";
import { Replica } from "../packages/core/replica";
import { ReplicaRecords } from "../packages/core/records";

it("stores shared values once, joins optional plugin entries, preserves typed tables without a plugin, and reads Repo-backed state", async () => {
  const storage = new DuckStorage();
  const device = await DeviceCore.open(storage, "Schema test");
  const node = await device.createWorkspace("Linked items");
  const space = await node.records.ensureSchema();
  const shared = field("subject", "Subject", "text", {
    scope: "shared",
    storage: "custom",
  });
  await node.records.put(
    "item_schemas",
    { ...space.data, columns: [shared] },
    space.id,
  );
  const tasks = await node.records.ensureTable("tasks", space.id);
  await node.records.put(
    "tables",
    { ...tasks.data, bindings: { title: "subject" } },
    tasks.id,
  );
  const calendar = await node.records.ensureTable("calendar", space.id);
  const task = await node.records.put("tasks", {
    table_id: tasks.id,
    custom_fields: { subject: "One item" },
  });
  expect(node.records.list("calendar")).toHaveLength(0);
  const event = await node.records.put("calendar", {
    table_id: calendar.id,
    item_id: task.data.item_id,
    dtstart: "2026-10-07T12:00:00Z",
  });
  expect(event.data.custom_fields).toMatchObject({ subject: "One item" });
  await node.records.put(
    "calendar",
    { ...event.data, custom_fields: { subject: "Edited from calendar" } },
    event.id,
  );
  expect(node.records.get(task.id)?.data.custom_fields).toMatchObject({
    subject: "Edited from calendar",
  });
  expect(node.records.get(task.id)?.data.title).toBe("Edited from calendar");
  const raw = node.replica.read<any>("record/" + task.id);
  expect(raw.data.title).toBeNull();
  expect(raw.data.custom_fields).not.toHaveProperty("subject");
  const db = await storage.database();
  expect(await db.query("SELECT title FROM collections.tasks")).toEqual([
    { title: "Edited from calendar" },
  ]);
  expect(
    await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='jocki' AND table_name='documents'",
    ),
  ).toEqual([]);
  expect(
    await db.query(
      `SELECT subject, item_id::VARCHAR AS item_id FROM tables.${userTableName(tasks.id)}`,
    ),
  ).toEqual([{ subject: "Edited from calendar", item_id: task.data.item_id }]);
  expect(
    await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='item_data' AND table_name=? AND column_name='subject'`,
      [userTableName(tasks.id)],
    ),
  ).toEqual([]);
  await expect(
    node.records.put("calendar", { ...event.data }),
  ).rejects.toMatchObject({ kind: "DUPLICATE_ITEM" });
  await expect(
    node.replica.update("record/" + task.id, {
      ...raw,
      data: { ...raw.data, item_id: crypto.randomUUID() },
    }),
  ).rejects.toMatchObject({ kind: "INVALID_RECORD" });
  await expect(
    node.records.delete(String(task.data.item_id)),
  ).rejects.toMatchObject({ kind: "ITEM_IN_USE" });
  const another = await node.records.ensureSchema(
    crypto.randomUUID(),
    "Other",
    false,
  );
  const otherTable = await node.records.ensureTable("calendar", another.id);
  await expect(
    node.records.put("calendar", { ...event.data, table_id: otherTable.id }),
  ).rejects.toMatchObject({ kind: "INVALID_ITEM" });
  const contract = schemaById.get("tasks")!;
  schemaById.delete("tasks");
  try {
    await storage.applyProjection(node.replica.workspaceId, {
      documents: [
        {
          id: "record/" + task.id,
          heads: node.replica.heads("record/" + task.id),
          value: raw,
        },
      ],
      removed: [],
      checkpoints: [],
    });
    expect(
      await db.query(
        `SELECT item_id::VARCHAR AS item_id FROM tables.${userTableName(tasks.id)}`,
      ),
    ).toEqual([{ item_id: task.data.item_id }]);
  } finally {
    schemaById.set("tasks", contract);
  }
  // A second domain service reads the same native Repo handle.
  const reopened = await new Replica(
    node.replica.identity,
    node.replica.access,
    storage,
  ).open();
  const records = new ReplicaRecords(reopened);
  expect(records.get(task.id)?.data.custom_fields).toMatchObject({
    subject: "Edited from calendar",
  });
  await records.delete(event.id);
  expect(records.get(task.id)?.deletedAt).toBeNull();
  expect(records.get(String(task.data.item_id))?.deletedAt).toBeNull();
  await device.close();
  await storage.close();
});

it("keeps a custom column type independent of an unmapped plugin feature with the same ID", async () => {
  const storage = new DuckStorage();
  const device = await DeviceCore.open(storage, "Typed features");
  try {
    const node = await device.createWorkspace("Typed columns");
    const table = await node.records.ensureTable("tasks");
    await node.records.put(
      "tables",
      {
        ...table.data,
        columns: [
          ...(table.data.columns as any[]),
          field("title", "Custom flag", "boolean", { storage: "custom" }),
        ],
      },
      table.id,
    );
    const row = await node.records.put("tasks", {
      table_id: table.id,
      title: "Plugin feature",
      custom_fields: { title: true },
    });
    const db = await storage.database();
    expect(
      await db.query(`SELECT title FROM tables.${userTableName(table.id)}`),
    ).toEqual([{ title: true }]);
    expect(await db.query("SELECT title FROM collections.tasks")).toEqual([
      { title: "Plugin feature" },
    ]);
    await node.records.put(
      "tasks",
      {
        ...row.data,
        title: "Updated feature",
        custom_fields: { title: false },
      },
      row.id,
    );
    expect(
      await db.query(`SELECT title FROM tables.${userTableName(table.id)}`),
    ).toEqual([{ title: false }]);
    expect(await db.query("SELECT title FROM collections.tasks")).toEqual([
      { title: "Updated feature" },
    ]);
  } finally {
    await device.close();
    await storage.close();
  }
});
