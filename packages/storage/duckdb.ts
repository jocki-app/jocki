import type { DurableStorage } from "./index";
import { SqlDatabase, type DatabaseOptions } from "./database";
import {
  initializeProjection,
  projectDocuments,
  removeDocument,
} from "./projection";
import type { ProjectionBatch, ProjectionCheckpoint } from "../core/projection";
import {
  initializeCheckpoints,
  loadCheckpoints,
  saveCheckpoints,
} from "./projection-checkpoints";
import { base64, unbase64 } from "../core/crypto";

/** Local metadata and SQL projections; Automerge Repo owns shared document storage. */
export class DuckStorage implements DurableStorage {
  private queue: Promise<unknown> = Promise.resolve();
  private failed?: unknown;
  private ready: Promise<SqlDatabase>;
  constructor(
    private options: DatabaseOptions = {},
    private persist?: (bytes: Uint8Array) => Promise<void>,
  ) {
    this.options = { ...options };
    delete this.options.bytes;
    this.ready = SqlDatabase.open(options).then(async (db) => {
      try {
        await db.transaction(async (sql) => {
          await sql.query(
            "CREATE SCHEMA IF NOT EXISTS jocki; CREATE TABLE IF NOT EXISTS jocki.entries (key VARCHAR PRIMARY KEY, bytes BLOB NOT NULL)",
          );
          await initializeProjection(sql);
          await initializeCheckpoints(sql);
        });
      } catch (error) {
        await db.close();
        throw error;
      }
      return db;
    });
  }
  database() {
    return this.ready;
  }
  private write<T>(work: () => Promise<T>, save = true) {
    const next = this.queue.then(async () => {
      if (this.failed) throw this.failed;
      const result = await work();
      try {
        if (save) await this.saved();
      } catch (error) {
        this.failed = error;
        throw error;
      }
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private async saved() {
    if (this.persist) await this.persist(await (await this.ready).export());
  }
  async get(key: string) {
    await this.queue;
    const rows = await (
      await this.ready
    ).query<{ bytes: string }>(
      "SELECT to_base64(bytes) AS bytes FROM jocki.entries WHERE key = ?",
      [key],
    );
    return rows[0] ? unbase64(rows[0].bytes) : undefined;
  }
  async set(key: string, bytes: Uint8Array) {
    await this.write(async () => {
      await (
        await this.ready
      ).transaction((sql) =>
        sql.query(
          "INSERT OR REPLACE INTO jocki.entries VALUES (?, from_base64(?))",
          [key, base64(bytes)],
        ),
      );
    });
  }
  async getMany(keys: string[]) {
    await this.queue;
    if (!keys.length) return [];
    const rows = await (
      await this.ready
    ).query<{ key: string; bytes: string }>(
      "SELECT key, to_base64(bytes) AS bytes FROM jocki.entries WHERE key IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))",
      [JSON.stringify(keys)],
    );
    return rows.map(({ key, bytes }) => ({ key, bytes: unbase64(bytes) }));
  }
  async projectionCheckpoints(
    workspaceId: string,
  ): Promise<ProjectionCheckpoint[]> {
    await this.queue;
    const sql = await this.ready,
      checkpoints = await loadCheckpoints(sql, workspaceId);
    const known = new Set(checkpoints.map((value) => value.id));
    // An index without a checkpoint must be rebuilt, including local caches
    // produced by an older projection implementation.
    for (const { id } of await sql.query<{ id: string }>(
      "SELECT id FROM jocki.document_index",
    ))
      if (!known.has(id))
        checkpoints.push({ id, source: "", heads: [], contract: "" });
    return checkpoints;
  }
  async applyProjection(workspaceId: string, batch: ProjectionBatch) {
    return this.write(async () => {
      await (
        await this.ready
      ).transaction(async (sql) => {
        for (const id of batch.removed) await removeDocument(sql, id);
        await projectDocuments(sql, batch.documents);
        await saveCheckpoints(sql, workspaceId, batch);
      });
    });
  }
  async delete(key: string) {
    return this.write(async () => {
      await (
        await this.ready
      ).transaction(async (sql) => {
        await sql.query("DELETE FROM jocki.entries WHERE key = ?", [key]);
      });
    });
  }
  async keys(prefix: string) {
    await this.queue;
    return (
      await (
        await this.ready
      ).query<{ key: string }>(
        "SELECT key FROM jocki.entries WHERE starts_with(key, ?) ORDER BY key",
        [prefix],
      )
    ).map((row) => row.key);
  }
  async snapshot(prefix = "") {
    await this.queue;
    return Object.fromEntries(
      (
        await (
          await this.ready
        ).query<{ key: string; bytes: string }>(
          "SELECT key, to_base64(bytes) AS bytes FROM jocki.entries WHERE starts_with(key, ?) ORDER BY key",
          [prefix],
        )
      ).map((row) => [row.key, unbase64(row.bytes)]),
    );
  }
  async close() {
    await this.queue;
    await (await this.ready).close();
  }
}
