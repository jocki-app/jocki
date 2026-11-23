import { memoryDatabase } from "./duckdb-memory";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  open,
  rename,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  DuckDBInstance,
  DuckDBTypeId,
  JSDuckDBValueConverter,
  type DuckDBValueConverter,
  type JS,
} from "@duckdb/node-api";
import {
  configureDatabase,
  type DatabasePlatform,
  type DatabaseWorkingStorage,
  type SqlRow,
} from "../storage/database";
const cache = path.join(os.tmpdir(), `jocki-duckdb-local-${process.pid}`);
const fileName = (name: string) =>
  createHash("sha256").update(name).digest("hex") + ".duckdb";
let workingStorage: DatabaseWorkingStorage = "disk";
/** Device-local preference; existing connections keep their current backing store. */
export function setDatabaseWorkingStorage(value: DatabaseWorkingStorage) {
  if (value !== "disk" && value !== "memory")
    throw Error("Choose disk or memory database storage");
  workingStorage = value;
}
// Preserve exact decimals and time values at every nesting level, including typed lists.
const convert: DuckDBValueConverter<JS> = (value, type) => {
  if (value === null) return null;
  if (type.alias === "JSON") return JSON.parse(String(value));
  if ([DuckDBTypeId.DECIMAL, DuckDBTypeId.TIME].includes(type.typeId))
    return String(value);
  const converted = JSDuckDBValueConverter(value, type, convert);
  // Node returns Buffer for BLOBs; the portable driver contract uses Uint8Array.
  return converted instanceof Uint8Array
    ? new Uint8Array(converted)
    : converted;
};

/** Official native DuckDB client; shares the Wasm SQL schema and DuckDB file format. */
export const nodeDatabasePlatform: DatabasePlatform = {
  async replace(options, bytes) {
    const filename =
      options.path ??
      (options.name ? path.join(cache, fileName(options.name)) : undefined);
    if (!filename)
      throw Error("A named database is required for atomic replacement");
    const temporary = filename + ".compact-" + crypto.randomUUID();
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (const suffix of [".wal", ".wal.checkpoint", ".wal.recovery"])
        await rm(filename + suffix, { force: true });
      await rename(temporary, filename);
      const directory = await open(path.dirname(filename), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  },
  async open(options) {
    const temporary = !options.path && !options.name;
    if (temporary && (options.workingStorage ?? workingStorage) === "memory")
      return memoryDatabase(options.bytes);
    const scratch = temporary
      ? await mkdtemp(path.join(os.tmpdir(), "jocki-database-"))
      : undefined;
    try {
      let filename = options.path;
      if (scratch) filename = path.join(scratch, "workspace.duckdb");
      if (!filename) {
        await mkdir(cache, { recursive: true, mode: 0o700 });
        filename = path.join(cache, fileName(options.name!));
        await writeFile(filename + ".name", options.name!, { mode: 0o600 });
      }
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      if (options.bytes)
        await writeFile(filename, options.bytes, { mode: 0o600, flag: "wx" });
      const instance = await DuckDBInstance.create(filename, {
        threads: "2",
        memory_limit: "512MB",
        preserve_insertion_order: "false",
      });
      let connection;
      try {
        connection = await instance.connect();
      } catch (error) {
        instance.closeSync();
        throw error;
      }
      const checkpoint = async () => {
        await connection.run("CHECKPOINT");
      };
      return {
        async query<T extends SqlRow>(sql: string, values = []) {
          const result = await connection.runAndReadAll(
            sql,
            values.length ? values : undefined,
          );
          return result.convertRowObjects(convert) as T[];
        },
        checkpoint,
        async export() {
          await checkpoint();
          return new Uint8Array(await readFile(filename!));
        },
        async close() {
          try {
            try {
              await checkpoint();
            } finally {
              connection.closeSync();
              instance.closeSync();
            }
          } finally {
            if (scratch) await rm(scratch, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (scratch) await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  },
  async names() {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    return Promise.all(
      (await readdir(cache))
        .filter((f) => f.endsWith(".name"))
        .map((f) => readFile(path.join(cache, f), "utf8")),
    );
  },
  async remove(name) {
    for (const suffix of [
      "",
      ".wal",
      ".wal.checkpoint",
      ".wal.recovery",
      ".name",
    ])
      await rm(path.join(cache, fileName(name)) + suffix, { force: true });
  },
};
configureDatabase(nodeDatabasePlatform);
