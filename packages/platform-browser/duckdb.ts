import { wasmQuery } from "../storage/wasm-query";
import jsonExtensionUrl from "../platform/assets/duckdb/json.duckdb_extension.wasm?url";
import { emptyDatabaseBase64 } from "../storage/empty-database";
import { unbase64 } from "../core/crypto";
import * as duckdb from "@duckdb/duckdb-wasm";
import wasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import workerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import {
  configureDatabase,
  databaseConfigured,
  type DatabasePlatform,
  type SqlRow,
} from "../storage/database";
const directoryName = "jocki-duckdb-v1";
const directory = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName, {
    create: true,
  });
const fileName = (name: string) => encodeURIComponent(name) + ".duckdb";

export const browserDatabasePlatform: DatabasePlatform = {
  async replace(options, bytes) {
    if (!options.name)
      throw Error("A named database is required for atomic replacement");
    const root = await directory(),
      filename = fileName(options.name);
    for (const suffix of [".wal", ".wal.checkpoint", ".wal.recovery"])
      await root.removeEntry(filename + suffix).catch((error) => {
        if (error.name !== "NotFoundError") throw error;
      });
    const file = await root.getFileHandle(filename, { create: true });
    const writer = await file.createWritable();
    try {
      await writer.write(new Uint8Array(bytes));
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  },
  async open(options) {
    if (options.path)
      throw Error("Native paths require the native file adapter");
    const worker = new Worker(workerUrl);
    const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    let connection: duckdb.AsyncDuckDBConnection | undefined;
    const databaseName = options.name;
    const persistent = Boolean(databaseName);
    const filename = persistent
      ? `opfs://${directoryName}/${fileName(databaseName!)}`
      : `workspace-${crypto.randomUUID()}.duckdb`;
    try {
      await database.instantiate(wasm);
      if (persistent) await directory();
      if (!persistent)
        await database.registerFileBuffer(
          filename,
          (options.bytes ?? unbase64(emptyDatabaseBase64)).slice(),
        );
      else if (options.bytes)
        throw Error("Import data through core into an internal workspace");
      await database.open({
        path: filename,
        accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
        maximumThreads: 1,
      });
      connection = await database.connect();
      // Wasm engines coexist with Automerge and the UI in one WebContent process.
      // DuckDB's host-RAM default is too large for that process, especially on iOS.
      await connection.query("SET memory_limit = '64MB'");
      await connection.query(
        "LOAD '" +
          new URL(jsonExtensionUrl, location.href).href.replaceAll("'", "''") +
          "'",
      );
      const checkpoint = async () => {
        await connection!.query("CHECKPOINT");
        await database.flushFiles();
      };
      return {
        async query<T extends SqlRow>(sql: string, values = []) {
          return wasmQuery<T>(connection!, sql, values);
        },
        checkpoint,
        async export() {
          await checkpoint();
          if (persistent)
            return new Uint8Array(
              await (
                await (
                  await (
                    await directory()
                  ).getFileHandle(fileName(databaseName!))
                ).getFile()
              ).arrayBuffer(),
            );
          return database.copyFileToBuffer(filename);
        },
        async close() {
          try {
            await checkpoint();
          } finally {
            try {
              await connection!.close();
              await database.reset();
              // Explicitly close OPFS sync access handles before replacing or
              // reopening the file. Worker termination alone races on WebKit.
              await database.dropFiles();
            } finally {
              await database.terminate();
              worker.terminate();
            }
          }
        },
      };
    } catch (error) {
      await connection?.close().catch(() => {});
      await database.terminate().catch(() => {});
      worker.terminate();
      throw error;
    }
  },
  async names() {
    const names: string[] = [];
    for await (const name of (
      (await directory()) as FileSystemDirectoryHandle & {
        keys(): AsyncIterable<string>;
      }
    ).keys())
      if (name.endsWith(".duckdb"))
        names.push(decodeURIComponent(name.slice(0, -7)));
    return names;
  },
  async remove(name) {
    const root = await directory();
    for (const suffix of ["", ".wal", ".wal.checkpoint", ".wal.recovery"])
      await root.removeEntry(fileName(name) + suffix).catch((error) => {
        if (error.name !== "NotFoundError") throw error;
      });
  },
};
if (!databaseConfigured()) configureDatabase(browserDatabasePlatform);
