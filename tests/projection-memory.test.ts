import { expect, it } from "vitest";
import { field } from "@jocki/platform/field-types";
import { schemaById } from "@jocki/platform/core/catalog";
import { SqlDatabase } from "../packages/storage/database";
import {
  initializeProjection,
  projectDocument,
  projectDocuments,
  userTableName,
  type StoredDocument,
} from "../packages/storage/projection";

function record(
  collection: string,
  data: Record<string, unknown>,
  id = crypto.randomUUID(),
): StoredDocument {
  return {
    id: "record/" + id,
    heads: ["initial"],
    value: {
      id,
      workspaceId: crypto.randomUUID(),
      ownerId: crypto.randomUUID(),
      pluginId: collection === "table_rows" ? "tables" : collection,
      collection,
      schemaVersion: schemaById.get(collection)?.version ?? 1,
      revision: 1,
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z",
      deletedAt: null,
      data,
    },
  };
}

it("loads a complete plugin projection and repeated edits within 64 MB, without rebuilding unrelated rows", async () => {
  const db = await SqlDatabase.open();
  const table = record("tables", {
    name: "Tasks",
    collection_id: "tasks",
    columns: schemaById
      .get("tasks")!
      .fields.filter((field) =>
        ["uid", "dtstamp", "title", "status", "description"].includes(field.id),
      ),
  });
  const tableId = String(table.value.id),
    name = "tables." + userTableName(tableId);
  const tasks = Array.from({ length: 220 }, (_, i) =>
    record("tasks", {
      table_id: tableId,
      title: `Task ${i}`,
      status: "open",
      description: "Notes ".repeat(200),
    }),
  );
  const receipts = Array.from({ length: 1000 }, (_, i) => ({
    id: `setting/receipt-${i}`,
    heads: ["a"],
    value: { version: i },
  }));
  try {
    await db.query("SET memory_limit='64MB'");
    await db.transaction(async (sql) => {
      await initializeProjection(sql);
      // Definitions may follow their rows in signed-history replay order.
      await projectDocuments(sql, [...tasks, ...receipts, table]);
    });
    expect(
      await db.query(`SELECT count(*)::INTEGER AS total FROM ${name}`),
    ).toEqual([{ total: 220 }]);
    await db.transaction(async (sql) => {
      for (let i = 0; i < 100; i++) {
        const original = tasks[0];
        await projectDocument(sql, {
          ...original,
          heads: [String(i)],
          value: {
            ...original.value,
            data: { ...(original.value.data as object), title: `Edit ${i}` },
          },
        });
      }
    });
    expect(
      await db.query(`SELECT title FROM ${name} WHERE _record_id=?`, [
        String(tasks[0].value.id),
      ]),
    ).toEqual([{ title: "Edit 99" }]);
    expect(
      await db.query(`SELECT count(*)::INTEGER AS total FROM ${name}`),
    ).toEqual([{ total: 220 }]);
    expect(
      await db.query(
        "SELECT count(*)::INTEGER AS total FROM jocki.document_index",
      ),
    ).toEqual([{ total: 1221 }]);
  } finally {
    await db.close();
  }
});

it.each(["disk", "memory"] as const)(
  "preserves typed values, moves, deletions, schema changes and rollback with %s projections",
  async (workingStorage) => {
    const db = await SqlDatabase.open({ workingStorage });
    const columns = [
      field("label", "Label"),
      field("amount", "Amount", "numeric"),
      field("bytes", "Bytes", "bytea", { array: true }),
      field("tags", "Tags", "text", { array: true }),
    ];
    const first = record("tables", { name: "First", columns }),
      second = record("tables", { name: "Second", columns });
    const firstId = String(first.value.id),
      secondId = String(second.value.id);
    const firstName = "tables." + userTableName(firstId),
      secondName = "tables." + userTableName(secondId);
    const values = {
      label: "One",
      amount: "12345678901234567890.123456789012345678",
      bytes: ["AAH/"],
      tags: ["a", "b"],
    };
    const row = record("table_rows", { table_id: firstId, values });
    const other = record("table_rows", {
      table_id: firstId,
      values: { ...values, label: "Two" },
    });
    try {
      await db.transaction(async (sql) => {
        await initializeProjection(sql);
        await projectDocuments(sql, [row, other, second, first]);
      });
      expect(
        await db.query(
          `SELECT amount::VARCHAR AS amount,to_base64(bytes[1]) AS bytes,to_json(tags)::VARCHAR AS tags FROM ${firstName} WHERE _record_id=?`,
          [String(row.value.id)],
        ),
      ).toEqual([{ amount: values.amount, bytes: "AAH/", tags: '["a","b"]' }]);
      const moved = {
        ...row,
        heads: ["moved"],
        value: { ...row.value, data: { table_id: secondId, values } },
      };
      await db.transaction((sql) => projectDocument(sql, moved));
      expect(await db.query(`SELECT label FROM ${firstName}`)).toEqual([
        { label: "Two" },
      ]);
      expect(await db.query(`SELECT label FROM ${secondName}`)).toEqual([
        { label: "One" },
      ]);
      await db.transaction((sql) =>
        projectDocument(sql, {
          ...moved,
          heads: ["future"],
          value: { ...moved.value, schemaVersion: 1000 },
        }),
      );
      expect(await db.query(`SELECT label FROM ${secondName}`)).toEqual([]);
      await db.transaction((sql) =>
        projectDocuments(sql, [
          moved,
          {
            ...second,
            heads: ["schema"],
            value: {
              ...second.value,
              data: {
                name: "Second",
                columns: [...columns, field("extra", "Extra")],
              },
            },
          },
        ]),
      );
      expect(await db.query(`SELECT label,extra FROM ${secondName}`)).toEqual([
        { label: "One", extra: null },
      ]);
      const invalid = record("table_rows", {
        table_id: secondId,
        values: { ...values, amount: "not numeric" },
      });
      await expect(
        db.transaction((sql) =>
          projectDocuments(sql, [
            invalid,
            {
              ...moved,
              heads: ["bad-batch"],
              value: { ...moved.value, data: { table_id: firstId, values } },
            },
          ]),
        ),
      ).rejects.toThrow();
      expect(
        await db.query("SELECT id FROM jocki.document_index WHERE id=?", [
          invalid.id,
        ]),
      ).toEqual([]);
      expect(await db.query(`SELECT label FROM ${secondName}`)).toEqual([
        { label: "One" },
      ]);
      await db.transaction((sql) =>
        projectDocument(sql, {
          ...moved,
          heads: ["deleted"],
          value: { ...moved.value, deletedAt: "2026-10-07T01:00:00Z" },
        }),
      );
      expect(await db.query(`SELECT label FROM ${secondName}`)).toEqual([]);
    } finally {
      await db.close();
    }
  },
  60000,
);

it("reprojects deleted records when their collection never had a physical table", async () => {
  const db = await SqlDatabase.open();
  const deleted = record("files", {
    name: "Deleted file",
    media_type: "text/plain",
    size: "0",
  });
  deleted.value.deletedAt = "2026-10-09T00:00:00Z";
  try {
    await db.transaction(initializeProjection);
    await db.transaction((sql) => projectDocument(sql, deleted));
    await db.transaction((sql) => projectDocument(sql, deleted));
    expect(
      await db.query(
        "SELECT table_name FROM jocki.document_index WHERE id=?",
        [deleted.id],
      ),
    ).toEqual([{ table_name: null }]);
    // A previously written index may name a table even though no live row ever created it.
    await db.query(
      "UPDATE jocki.document_index SET table_name='files' WHERE id=?",
      [deleted.id],
    );
    await db.transaction((sql) => projectDocument(sql, deleted));
    expect(
      await db.query(
        "SELECT table_name FROM jocki.table_schemas WHERE table_name='files'",
      ),
    ).toEqual([]);
  } finally {
    await db.close();
  }
});
