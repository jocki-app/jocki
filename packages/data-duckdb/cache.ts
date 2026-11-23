import {
  SqlDatabase,
  DatabaseClosedError,
  databasePlatform,
  identifier,
  type SqlConnection,
} from "../storage/database";
import { base64, unbase64 } from "../core/crypto";
import { coalescedRefresh } from "./refresh";

const listeners = new Set<() => void>();
export const subscribeStorage = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const changed = () => {
  for (const listener of listeners) listener();
};
export function liveQuery<T>(query: () => Promise<T>) {
  return {
    subscribe(
      observer:
        | { next?(value: T): void; error?(error: unknown): void }
        | ((value: T) => void),
    ) {
      let stopped = false,
        generation = 0;
      const refresh = coalescedRefresh(
        async () => {
          const current = generation;
          await Promise.resolve()
            .then(query)
            .then(
              (value) => {
                if (!stopped && current === generation)
                  typeof observer === "function"
                    ? observer(value)
                    : observer.next?.(value);
              },
              (error) => {
                if (
                  !stopped &&
                  current === generation &&
                  !(error instanceof DatabaseClosedError) &&
                  typeof observer !== "function"
                )
                  observer.error?.(error);
              },
            );
        },
        (error) => {
          if (!stopped && typeof observer !== "function")
            observer.error?.(error);
        },
      );
      const update = () => {
        generation++;
        refresh();
      };
      const unsubscribe = subscribeStorage(update);
      update();
      return {
        unsubscribe() {
          stopped = true;
          refresh.stop();
          unsubscribe();
        },
      };
    },
  };
}
interface CacheEngine {
  ready: Promise<SqlDatabase>;
  references: number;
  memory: Map<string, Map<string, object>>;
  closing?: Promise<void>;
}
const engines = new Map<string, CacheEngine>();
type Definition = { key: string; auto?: boolean; volatile?: boolean };
/** UI records are an ephemeral object cache; durable current records live only in typed SQL storage. */
export class CacheDatabase {
  readonly name: string;
  private ready: Promise<SqlDatabase>;
  private engine: CacheEngine;
  private closed = false;
  private client?: SqlConnection;
  private definitions: Record<string, Definition>;
  constructor(name: string, definitions: Record<string, Definition>) {
    this.name = name;
    this.definitions = definitions;
    let engine = engines.get(name);
    if (!engine || engine.closing) {
      const closing = engine?.closing;
      engine = {
        references: 0,
        memory: new Map(
          Object.entries(definitions)
            .filter(([, d]) => d.volatile)
            .map(([name]) => [name, new Map()]),
        ),
        ready: (closing ?? Promise.resolve()).then(async () => {
          const db = await SqlDatabase.open({ name });
          try {
            await db.transaction(async (sql) => {
              for (const table of Object.keys(definitions).filter(
                (name) => !definitions[name].volatile,
              ))
                await sql.query(
                  `CREATE TABLE IF NOT EXISTS ${identifier(table)} (key VARCHAR PRIMARY KEY,value JSON NOT NULL,blob BLOB)`,
                );
            });
            return db;
          } catch (error) {
            await db.close();
            throw error;
          }
        }),
      };
      engines.set(name, engine);
    }
    engine.references++;
    this.engine = engine;
    this.ready = engine.ready;
    for (const [table, definition] of Object.entries(definitions))
      Object.assign(this, { [table]: new SqlTable(this, table, definition) });
  }
  memory(name: string) {
    return this.engine.memory.get(name);
  }
  async read<T>(work: (sql: SqlConnection) => Promise<T>) {
    if (this.closed) throw new DatabaseClosedError();
    return work(this.client ?? (await this.ready));
  }
  async write<T>(work: (sql: SqlConnection) => Promise<T>) {
    if (this.closed) throw new DatabaseClosedError();
    if (this.client) return work(this.client);
    const result = await (
      await this.ready
    ).transaction(async (sql) => {
      const before = new Map(
        [...this.engine.memory].map(([name, rows]) => [name, new Map(rows)]),
      );
      try {
        return await work(sql);
      } catch (error) {
        this.engine.memory = before;
        throw error;
      }
    });
    changed();
    return result;
  }
  transaction<T>(
    _mode: string,
    ...args: [...tables: SqlTable<any, any>[], work: (tx: this) => Promise<T>]
  ): Promise<T> {
    const work = args.at(-1) as (tx: this) => Promise<T>;
    if (this.client) return work(this);
    return this.write(async (client) => {
      const tx = Object.create(this) as this;
      tx.client = client;
      for (const [table, definition] of Object.entries(this.definitions))
        Object.assign(tx, { [table]: new SqlTable(tx, table, definition) });
      return work(tx);
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (--this.engine.references === 0) {
      this.engine.closing = this.ready.then(
        (db) => db.close(),
        () => {},
      );
      try {
        await this.engine.closing;
      } finally {
        if (engines.get(this.name) === this.engine) engines.delete(this.name);
      }
    }
  }
  async delete() {
    await this.close();
    await databasePlatform().remove(this.name);
    changed();
  }
}
export class SqlTable<T extends object, K extends string | number = string> {
  constructor(
    readonly db: CacheDatabase,
    readonly name: string,
    readonly definition: Definition,
  ) {}
  private async encode(value: T, key?: K) {
    const copy = { ...value } as Record<string, unknown>;
    const blob = copy.blob instanceof Blob ? copy.blob : undefined;
    if (blob) {
      delete copy.blob;
      copy.__blobType = blob.type;
    }
    if (key !== undefined) copy[this.definition.key] = key;
    return {
      value: copy,
      blob: blob ? base64(new Uint8Array(await blob.arrayBuffer())) : null,
    };
  }
  private decode(row: { value: string; blob: string | null }): T {
    const value = JSON.parse(row.value);
    if (row.blob !== null) {
      value.blob = new Blob([new Uint8Array(unbase64(row.blob))], {
        type: value.__blobType ?? "",
      });
      delete value.__blobType;
    }
    return value;
  }
  async get(key: K): Promise<T | undefined> {
    if (this.definition.volatile)
      return structuredClone(this.db.memory(this.name)?.get(String(key))) as
        T | undefined;
    return this.db.read(async (sql) => {
      const rows = await sql.query<{ value: string; blob: string | null }>(
        `SELECT value::VARCHAR AS value,to_base64(blob) AS blob FROM ${identifier(this.name)} WHERE key=?`,
        [String(key)],
      );
      return rows[0] ? this.decode(rows[0]) : undefined;
    });
  }
  private async save(
    sql: SqlConnection,
    entry: Awaited<ReturnType<SqlTable<T, K>["encode"]>>,
    insert = false,
  ): Promise<K> {
    let key = entry.value[this.definition.key] as K | undefined;
    if (key === undefined && this.definition.auto) {
      const rows = await sql.query<{ next: number }>(
        `SELECT CAST(coalesce(max(try_cast(key AS BIGINT)),0)+1 AS DOUBLE) AS next FROM ${identifier(this.name)}`,
      );
      key = rows[0].next as K;
      entry.value[this.definition.key] = key;
    }
    if (key === undefined) throw Error(`Missing ${this.definition.key}`);
    if (this.definition.volatile) {
      const rows = this.db.memory(this.name)!;
      if (insert && rows.has(String(key))) throw Error("Duplicate cache key");
      rows.set(String(key), structuredClone(entry.value));
      return key;
    }
    await sql.query(
      `INSERT ${insert ? "" : "OR REPLACE "}INTO ${identifier(this.name)} VALUES (?,?::JSON,from_base64(?))`,
      [String(key), JSON.stringify(entry.value), entry.blob],
    );
    return key;
  }
  async put(value: T, key?: K) {
    const entry = await this.encode(value, key);
    return this.db.write((sql) => this.save(sql, entry));
  }
  async add(value: T, key?: K) {
    const entry = await this.encode(value, key);
    return this.db.write((sql) => this.save(sql, entry, true));
  }
  async bulkPut(values: T[]) {
    const entries = await Promise.all(values.map((v) => this.encode(v)));
    await this.db.write(async (sql) => {
      for (const entry of entries) await this.save(sql, entry);
    });
  }
  async bulkDelete(keys: K[]) {
    if (!keys.length) return;
    await this.db.write(async (sql) => {
      for (const key of keys) {
        if (this.definition.volatile) {
          this.db.memory(this.name)!.delete(String(key));
          continue;
        }
        await sql.query(`DELETE FROM ${identifier(this.name)} WHERE key=?`, [
          String(key),
        ]);
      }
    });
  }
  async delete(key: K) {
    await this.bulkDelete([key]);
  }
  async clear() {
    await this.db.write(async (sql) => {
      if (this.definition.volatile) this.db.memory(this.name)!.clear();
      else await sql.query(`DELETE FROM ${identifier(this.name)}`);
    });
  }
  async toArray(
    equalities: ReadonlyArray<readonly [string, unknown]> = [],
  ): Promise<T[]> {
    if (this.definition.volatile)
      return [...this.db.memory(this.name)!.values()]
        .filter((row) =>
          equalities.every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          ),
        )
        .map((r) => structuredClone(r) as T);
    return this.db.read(async (sql) =>
      (
        await sql.query<{ value: string; blob: string | null }>(
          `SELECT value::VARCHAR AS value,to_base64(blob) AS blob FROM ${identifier(this.name)} ORDER BY key`,
        )
      )
        .map((row) => this.decode(row))
        .filter((row) =>
          equalities.every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          ),
        ),
    );
  }
  async count() {
    if (this.definition.volatile) return this.db.memory(this.name)!.size;
    return this.db.read(async (sql) =>
      Number(
        (
          await sql.query<{ count: bigint }>(
            `SELECT count(*) AS count FROM ${identifier(this.name)}`,
          )
        )[0].count,
      ),
    );
  }
  toCollection() {
    return new SqlSelection(this);
  }
  filter(predicate: (value: T) => boolean) {
    return this.toCollection().filter(predicate);
  }
  where(field: keyof T | string) {
    return {
      equals: (value: unknown) =>
        new SqlSelection(this, [], undefined, [[String(field), value]]),
      startsWith: (prefix: string) =>
        this.filter((row) => {
          const value = (row as Record<string, unknown>)[field as string];
          return Array.isArray(value)
            ? value.some((item) => String(item).startsWith(prefix))
            : String(value ?? "").startsWith(prefix);
        }),
    };
  }
  orderBy(field: keyof T | string) {
    return this.toCollection().orderBy(field);
  }
  async update(key: K, changes: Partial<T>) {
    return this.db.transaction("rw", this, async (tx) => {
      const table = (tx as any)[this.name] as SqlTable<T, K>;
      const value = await table.get(key);
      if (!value) return 0;
      await table.put({ ...value, ...changes });
      return 1;
    });
  }
}
export class SqlSelection<T extends object, K extends string | number> {
  constructor(
    private table: SqlTable<T, K>,
    private predicates: ((value: T) => boolean)[] = [],
    private order?: keyof T | string,
    private equalities: ReadonlyArray<readonly [string, unknown]> = [],
  ) {}
  filter(predicate: (value: T) => boolean) {
    return new SqlSelection(
      this.table,
      [...this.predicates, predicate],
      this.order,
      this.equalities,
    );
  }
  orderBy(field: keyof T | string) {
    return new SqlSelection(
      this.table,
      this.predicates,
      field,
      this.equalities,
    );
  }
  async toArray() {
    const rows = (await this.table.toArray(this.equalities)).filter((row) =>
      this.predicates.every((p) => p(row)),
    );
    if (this.order) {
      const field = this.order;
      rows.sort((a, b) => {
        const x = (a as any)[field],
          y = (b as any)[field];
        return x === y ? 0 : x < y ? -1 : 1;
      });
    }
    return rows;
  }
  distinct() {
    return this;
  }
  async sortBy(field: keyof T | string) {
    return this.orderBy(field).toArray();
  }
  async first() {
    return (await this.toArray())[0];
  }
  async count() {
    return (await this.toArray()).length;
  }
  async primaryKeys() {
    return (await this.toArray()).map(
      (row) => (row as any)[this.table.definition.key] as K,
    );
  }
  async delete() {
    const keys = await this.primaryKeys();
    await this.table.bulkDelete(keys);
    return keys.length;
  }
  async modify(change: Partial<T> | ((row: T) => void)) {
    const rows = await this.toArray();
    for (const row of rows)
      typeof change === "function" ? change(row) : Object.assign(row, change);
    await this.table.bulkPut(rows);
  }
}
export type Table<
  T extends object,
  K extends string | number = string,
> = SqlTable<T, K>;
