import { useSyncExternalStore } from "react";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import {
  queryRecords,
  type RecordSchema,
  type Value,
} from "@jocki/platform/field-types";

const listeners = new Set<() => void>();
/** UI invalidation only: never emits a storage, replica, or plugin event. */
export const subscribeOptimistic = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export interface OptimisticStore {
  list(query?: Parameters<typeof queryRecords>[2]): Promise<ResourceRecord[]>;
  get?(id: string): Promise<ResourceRecord | undefined>;
  put(data: Record<string, Value>, id?: string): Promise<ResourceRecord>;
  delete(id: string): Promise<unknown>;
}
type Data = ResourceRecord["data"];
type Patch = (data: Data) => Data;
function difference(before: Data, after: Data): Patch {
  const changed = Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  const removed = Object.keys(before).filter(
    (key) => !Object.hasOwn(after, key),
  );
  const nested = new Map<string, Patch>();
  // Custom fields and user-table values are independent editable columns.
  for (const key of ["custom_fields", "values"])
    if (
      changed.includes(key) &&
      before[key] &&
      after[key] &&
      typeof before[key] === "object" &&
      typeof after[key] === "object" &&
      !Array.isArray(before[key]) &&
      !Array.isArray(after[key])
    )
      nested.set(key, difference(before[key] as Data, after[key] as Data));
  return (data) => {
    const next = { ...data };
    for (const key of removed) delete next[key];
    for (const key of changed)
      next[key] = nested.has(key)
        ? nested.get(key)!((data[key] as Data) ?? {})
        : after[key];
    return next;
  };
}
interface Pending {
  id: string;
  collection: string;
  preview: ResourceRecord;
  patch?: Patch;
}
/** One UI coordinator per workspace. Promises resolve only after the real store saves.
 * Core storage, authorization, execution and sync never read these previews.
 */
export class OptimisticRecords {
  private pending = new Map<string, Pending[]>();
  private tails = new Map<string, Promise<unknown>>();
  private cache = new Map<string, ResourceRecord[]>();
  private version = 0;
  private subscribers = new Set<() => void>();
  constructor(
    private options: {
      workspaceId: string;
      ownerId: string;
      saved: (id: string) => ResourceRecord | undefined;
      error: (error: unknown) => void;
      track: <T>(work: () => Promise<T>) => Promise<T>;
    },
  ) {}
  subscribe = (listener: () => void) => {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  };
  snapshot = () => this.version;
  count(id: string) {
    return this.pending.get(id)?.length ?? 0;
  }
  private changed() {
    this.version++;
    for (const listener of this.subscribers) listener();
    for (const listener of listeners) listener();
  }
  record(
    id: string,
    saved = this.options.saved(id),
  ): ResourceRecord | undefined {
    let value = saved;
    for (const op of this.pending.get(id) ?? [])
      value = op.patch
        ? {
            ...(value ?? op.preview),
            deletedAt: null,
            data: op.patch(value?.data ?? {}),
          }
        : undefined;
    return value;
  }
  /** Project an already-authorized UI snapshot; never use for core decisions. */
  project(saved: ResourceRecord[]): ResourceRecord[] {
    return this.rows(undefined, saved);
  }
  private rows(collection: string | undefined, saved: ResourceRecord[]) {
    const rows = new Map(saved.map((row) => [row.id, row]));
    for (const [id, ops] of this.pending) {
      if (collection && ops[0].collection !== collection) continue;
      const row = this.record(id, rows.get(id));
      if (row) rows.set(id, row);
      else rows.delete(id);
    }
    return [...rows.values()].filter((row) => !row.deletedAt);
  }
  private run<T>(op: Pending, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(op.id) ?? Promise.resolve();
    this.pending.set(op.id, [...(this.pending.get(op.id) ?? []), op]);
    this.changed();
    const result = this.options.track(async () => {
      await previous.catch(() => {});
      try {
        return await work();
      } catch (error) {
        this.options.error(error);
        throw error;
      } finally {
        const rest = this.pending.get(op.id)!.filter((item) => item !== op);
        if (rest.length) this.pending.set(op.id, rest);
        else this.pending.delete(op.id);
        // Keep other pending rows responsive even if the next durable read is
        // blocked by a write. Reconcile this row in every authorized snapshot.
        const saved = this.options.saved(op.id);
        for (const [key, rows] of this.cache) {
          if (!key.endsWith(":" + op.collection)) continue;
          const present = rows.some((row) => row.id === op.id);
          const next = rows.flatMap((row) =>
            row.id === op.id
              ? saved && !saved.deletedAt
                ? [saved]
                : []
              : [row],
          );
          if (!present && saved && !saved.deletedAt) next.push(saved);
          this.cache.set(key, next);
        }
        this.changed();
      }
    });
    this.tails.set(op.id, result);
    void result
      .finally(() => {
        if (this.tails.get(op.id) === result) this.tails.delete(op.id);
      })
      .catch(() => {});
    return result;
  }
  /** Track compound file/content writes whose editor already holds the local preview. */
  whileSaving<T>(id: string, work: () => Promise<T>): Promise<T> {
    const preview = this.record(id);
    if (!preview) return this.options.track(work);
    return this.run(
      { id, collection: preview.collection, preview, patch: (data) => data },
      work,
    );
  }
  wrap<T extends OptimisticStore>(
    schema: RecordSchema,
    source: T,
    scope: string,
  ): T & Required<OptimisticStore> {
    const cacheKey = scope + ":" + schema.id;
    return {
      ...source,
      list: async (query?: Parameters<typeof queryRecords>[2]) => {
        const cached = this.cache.get(cacheKey);
        const generation = this.version;
        const rows = cached && this.pending.size ? cached : await source.list();
        if (generation === this.version) this.cache.set(cacheKey, rows);
        return queryRecords(this.rows(schema.id, rows), schema, query ?? {});
      },
      get: async (id: string) => {
        const saved = source.get
          ? await source.get(id)
          : (await source.list()).find((row) => row.id === id);
        if (
          !saved &&
          !this.pending
            .get(id)
            ?.some(
              (op) => op.collection === schema.id && op.preview.revision === 0,
            )
        )
          return undefined;
        return this.record(id, saved);
      },
      put: (input: Data, id = crypto.randomUUID()) => {
        const data = structuredClone(input);
        const old = this.record(id);
        const preview: ResourceRecord = old ?? {
          id,
          collection: schema.id,
          pluginId: schema.pluginId,
          workspaceId: this.options.workspaceId,
          ownerId: this.options.ownerId,
          revision: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
          data: {},
        };
        const patch = difference(old?.data ?? {}, data);
        return this.run({ id, collection: schema.id, preview, patch }, () =>
          source.put(patch(this.options.saved(id)?.data ?? {}), id),
        );
      },
      delete: (id: string) => {
        const preview =
          this.record(id) ?? ({ id, collection: schema.id } as ResourceRecord);
        return this.run({ id, collection: schema.id, preview }, () =>
          source.delete(id),
        );
      },
    };
  }
}
export interface OptimisticStatus {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => number;
  count: (id: string) => number;
}
export function useOptimisticRecords<T extends OptimisticStatus>(
  records: T,
): T {
  useSyncExternalStore(records.subscribe, records.snapshot, records.snapshot);
  return records;
}
