import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlDatabase, duckdbFile } from "../packages/storage/database";

import {
  initializeProjection,
  projectDocument,
  userTableName,
} from "../packages/storage/projection";
import { field, pgTypes, decodeField } from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";

import { CacheDatabase, liveQuery } from "../packages/data-duckdb/cache";
import { schemaById } from "@jocki/platform/core/catalog";

it("reuses a bounded Wasm parameter buffer across a long transaction, rolls back, and binds exact scalar values", async () => {
  const db = await SqlDatabase.open({ workingStorage: "memory" });
  try {
    await db.query("SET memory_limit='64MB'");
    const values = Array.from(
      { length: 128 },
      (_, i) => `quoted ' value $1 ? ${i} ` + "x".repeat(100),
    );
    const statement =
      "SELECT " + values.map((_, i) => `?::VARCHAR AS p${i}`).join(",");
    await db.transaction(async (sql) => {
      for (let i = 0; i < 60; i++) {
        const rows = await sql.query(statement, values);
        expect(rows[0].p127).toBe(values[127]);
      }
      const buffers = await sql.query(
        "SELECT count(*)::INTEGER AS count FROM information_schema.tables WHERE starts_with(table_name, '_jocki_parameters_')",
      );
      expect(buffers[0].count).toBe(1);
    });
    const long = "🦖'\\\"".repeat(3000);
    await expect(
      db.transaction(async (sql) => {
        await sql.query("SELECT ?::INTEGER", [long]);
      }),
    ).rejects.toThrow();
    const [row] = await db.query(
      "SELECT ?::VARCHAR AS text, ?::DOUBLE AS number, ?::BOOLEAN AS flag, ?::VARCHAR AS empty, ?::DOUBLE AS nan, ?::DOUBLE AS infinity",
      [long, -42.5, true, null, NaN, -Infinity],
    );
    expect(row).toEqual({
      text: long,
      number: -42.5,
      flag: true,
      empty: null,
      nan: NaN,
      infinity: -Infinity,
    });
  } finally {
    await db.close();
  }
});

it("keeps newer plugin records opaque and materializes them when a compatible schema is installed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jocki-schema-version-"));
  const db = await SqlDatabase.open({
    path: join(directory, "records.duckdb"),
  });
  const schema = schemaById.get("variables")!;
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const value = {
    id,
    workspaceId: crypto.randomUUID(),
    ownerId: crypto.randomUUID(),
    pluginId: "variables",
    collection: "variables",
    schemaVersion: schema.version,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    data: { name: "Versioned", value_type: "text", value: "before" },
  };
  const project = (value: Record<string, unknown>, head: string) =>
    db.transaction((sql) =>
      projectDocument(sql, { id: "record/" + id, value, heads: [head] }),
    );
  try {
    await db.transaction(initializeProjection);
    await project(value, "a");
    expect((await db.query("SELECT * FROM collections.variables")).length).toBe(
      1,
    );
    const future = {
      ...value,
      schemaVersion: schema.version + 1,
      data: { ...value.data, value: "after" },
    };
    await project(future, "b");
    expect(await db.query("SELECT * FROM collections.variables")).toEqual([]);
    expect(
      await db.query(
        "SELECT table_name FROM jocki.document_index WHERE id=?",
        ["record/" + id],
      ),
    ).toEqual([{ table_name: null }]);
    schemaById.set("variables", { ...schema, version: schema.version + 1 });
    await project(future, "b"); // No new Automerge change is required for materialization.
    expect(await db.query("SELECT name FROM collections.variables")).toEqual([
      { name: "Versioned" },
    ]);
  } finally {
    schemaById.set("variables", schema);
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("lets subscriptions finish closing a workspace while other databases change", async () => {
  const a = new CacheDatabase("closing-" + crypto.randomUUID(), {});
  const b = new CacheDatabase("active-" + crypto.randomUUID(), {});
  const errors: unknown[] = [],
    values: unknown[] = [];
  const subscription = liveQuery(() =>
    a.read((sql) => sql.query("SELECT 1 AS value")),
  ).subscribe({
    next: (value) => values.push(value),
    error: (error) => errors.push(error),
  });
  try {
    await vi.waitFor(() => expect(values).toHaveLength(1));
    await a.close();
    await b.write((sql) => sql.query("CREATE TABLE unrelated (id INTEGER)"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([]);
    expect(values).toHaveLength(1);
  } finally {
    subscription.unsubscribe();
    await a.delete();
    await b.delete();
  }
});

it("writes multi-megabyte Wasm parameters without interpolation or temporary-table leaks", async () => {
  const db = await SqlDatabase.open({ workingStorage: "memory" });
  try {
    const payload = "? $1 ' \" /* */ --\n" + "🙂".repeat(600000);
    await db.transaction(async (sql) => {
      await sql.query(
        "CREATE TABLE large_payload (text VARCHAR, bytes BLOB, enabled BOOLEAN, optional VARCHAR)",
      );
      await sql.query(
        "INSERT INTO large_payload VALUES (?,from_base64(?),?,?)",
        [payload, "AP8B", true, null],
      );
    });
    expect(
      await db.query(
        "SELECT text,to_base64(bytes) AS bytes,enabled,optional,'? $1' AS literal FROM large_payload",
      ),
    ).toEqual([
      {
        text: payload,
        bytes: "AP8B",
        enabled: true,
        optional: null,
        literal: "? $1",
      },
    ]);
    await expect(
      db.transaction((sql) =>
        sql.query(
          "INSERT INTO large_payload VALUES (?, ?, ?, CAST(? AS INTEGER))",
          [payload, "x", true, "bad"],
        ),
      ),
    ).rejects.toThrow();
    const buffers = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE starts_with(table_name,'_jocki_parameters_')",
    );
    expect(buffers).toHaveLength(1);
    expect(
      await db.query(
        `SELECT count(*)::INTEGER AS count FROM "${buffers[0].table_name}"`,
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await db.query(
        "SELECT name FROM duckdb_variables() WHERE starts_with(name, '_jocki_parameters_')",
      ),
    ).toEqual([]);
    expect(
      await db.query("SELECT count(*)::INTEGER AS count FROM large_payload"),
    ).toEqual([{ count: 1 }]);
  } finally {
    await db.close();
  }
});

it("preserves native decimal and time precision in lists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jocki-native-types-"));
  const db = await SqlDatabase.open({ path: join(directory, "types.duckdb") });
  try {
    expect(
      await db.query(
        "SELECT [12345678901234567890.123456789012345678::DECIMAL(38,18)] AS decimals, [TIME '12:30:45.123456'] AS times",
      ),
    ).toEqual([
      {
        decimals: ["12345678901234567890.123456789012345678"],
        times: ["12:30:45.123456"],
      },
    ]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("stores all field types and lists as SQL columns without losing decimal, integer, or binary values", async () => {
  const db = await SqlDatabase.open();
  const id = crypto.randomUUID(),
    owner = crypto.randomUUID(),
    workspace = crypto.randomUUID();
  const examples: unknown[] = [
    "text",
    "varchar",
    crypto.randomUUID(),
    true,
    12,
    123,
    "9223372036854775807",
    "12345678901234567890.123456789012345678",
    1.25,
    "2026-10-04",
    "12:30:45.123456",
    "2026-10-04T12:30:45.123456",
    "2026-10-04T12:30:45.123456Z",
    "P1DT2H",
    { a: 1 },
    "AAH/",
  ];
  expect(examples.length).toBe(pgTypes.length);
  const columns = pgTypes.flatMap((type, i) => [
    field("f" + i, type, type),
    field("l" + i, type + " list", type, { array: true }),
  ]);
  const values = Object.fromEntries(
    pgTypes.flatMap((type, i) => [
      ["f" + i, decodeField(columns[i * 2], examples[i])],
      ["l" + i, decodeField(columns[i * 2 + 1], [examples[i]])],
    ]),
  );
  const record = (
    collection: string,
    rid: string,
    data: any,
  ): ResourceRecord => ({
    id: rid,
    workspaceId: workspace,
    ownerId: owner,
    collection,
    pluginId: "tables",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    data,
  });
  try {
    await db.transaction(async (sql) => {
      await initializeProjection(sql);
      await projectDocument(sql, {
        id: "record/" + id,
        heads: ["a"],
        value: record("tables", id, { name: "Types", columns }) as any,
      });
      const row = crypto.randomUUID();
      await projectDocument(sql, {
        id: "record/" + row,
        heads: ["b"],
        value: record("table_rows", row, { table_id: id, values }) as any,
      });
    });
    const table = "tables." + userTableName(id);
    const rows = await db.query(
      `SELECT f6::VARCHAR AS bigint_value,f7::VARCHAR AS decimal_value,to_base64(f15) AS bytes,to_base64(l15[1]) AS list_bytes,json_extract_string(f14,'$.a') AS json_value FROM ${table}`,
    );
    expect(rows).toEqual([
      {
        bigint_value: examples[6],
        decimal_value: examples[7],
        bytes: "AAH/",
        list_bytes: "AAH/",
        json_value: "1",
      },
    ]);
    const bytes = await db.export();
    expect(duckdbFile(bytes)).toBe(true);
    const reopened = await SqlDatabase.open({ bytes });
    try {
      expect(await reopened.query(`SELECT f0 FROM ${table}`)).toEqual([
        { f0: "text" },
      ]);
    } finally {
      await reopened.close();
    }
  } finally {
    await db.close();
  }
});
