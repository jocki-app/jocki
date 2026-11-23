import { wasmQuery } from "../storage/wasm-query";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as duckdb from "@duckdb/duckdb-wasm";
import Worker from "web-worker";
import type { DuckDriver, SqlRow, SqlValue } from "../storage/database";
import { emptyDatabaseBase64 } from "../storage/empty-database";
import { unbase64 } from "../core/crypto";
const require = createRequire(import.meta.url);
/** Temporary plaintext stays inside Wasm memory, including encrypted-file import/export. */
export async function memoryDatabase(bytes?: Uint8Array): Promise<DuckDriver> {
  const worker = new Worker(
    pathToFileURL(require.resolve("@jocki/platform/duckdb/worker")),
    { type: "module" },
  );
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  let connection: duckdb.AsyncDuckDBConnection | undefined;
  const filename = "workspace.duckdb";
  try {
    await db.instantiate(
      require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"),
    );
    await db.registerFileBuffer(
      filename,
      (bytes ?? unbase64(emptyDatabaseBase64)).slice(),
    );
    for (const suffix of [".wal", ".wal.checkpoint", ".wal.recovery"])
      await db.registerFileBuffer(filename + suffix, new Uint8Array());
    await db.open({
      path: filename,
      accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
      maximumThreads: 1,
    });
    connection = await db.connect();
    await connection.query(
      "LOAD 'https://jocki.invalid/duckdb/v1.5.6/wasm_eh/json.duckdb_extension.wasm'",
    );
    const checkpoint = async () => {
      await connection!.query("CHECKPOINT");
      await db.flushFiles();
    };
    return {
      async query<T extends SqlRow>(sql: string, values: SqlValue[] = []) {
        return wasmQuery<T>(connection!, sql, values);
      },
      checkpoint,
      async export() {
        await checkpoint();
        return db.copyFileToBuffer(filename);
      },
      async close() {
        try {
          await connection!.close();
        } finally {
          await db.terminate();
          worker.terminate();
        }
      },
    };
  } catch (error) {
    await connection?.close().catch(() => {});
    await db.terminate().catch(() => {});
    worker.terminate();
    throw error;
  }
}
