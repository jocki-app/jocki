import {
  schemaResourceId,
  pluginTableId,
  schemaColumns,
} from "../core/item-schemas";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import type { Value } from "@jocki/platform/field-types";
import { getSchema, schemaById } from "@jocki/platform/core/catalog";

export const tableSelectionKey = (_collection?: string) => "navigation.schema";
export async function defaultTableId(runtime: AppRuntime, collection: string) {
  const space = await schemaResourceId(
    runtime.profile.workspaceId,
    "default-schema",
  );
  return pluginTableId(runtime.profile.workspaceId, space, collection);
}
export async function schemaDefinitions(runtime: AppRuntime) {
  return runtime.collection("item_schemas", true).list();
}
export async function selectedSchema(runtime: AppRuntime) {
  const id = await runtime.db.getMetadata<string>(tableSelectionKey());
  const definitions = await schemaDefinitions(runtime);
  return (
    definitions.find((s) => s.id === id) ??
    definitions.find((s) => s.data.is_default) ??
    definitions[0]
  );
}
export async function tableDefinitions(
  runtime: AppRuntime,
  collection: string,
  optimistic = true,
) {
  const store = optimistic
    ? runtime.collection("tables", true)
    : runtime.savedCollection("tables", true);
  return (await store.list()).filter(
    (r) => r.data.collection_id === collection,
  );
}
export async function createSchema(runtime: AppRuntime, name: string) {
  const space = await runtime.node.records.ensureSchema(
    crypto.randomUUID(),
    name.trim(),
    false,
  );
  await ensureCollectionTables(runtime);
  await runtime.project();
  return space;
}
export async function createCollectionTable(
  runtime: AppRuntime,
  collection: string,
  name: string,
  isDefault = false,
) {
  const space = await runtime.node.records.ensureSchema(
    isDefault ? undefined : crypto.randomUUID(),
    name,
    isDefault,
  );
  const table = await runtime.node.records.ensureTable(collection, space.id);
  await ensureCollectionTables(runtime);
  await runtime.project();
  return table;
}
export async function ensureCollectionTables(runtime: AppRuntime) {
  if (!runtime.node.records.canWrite() || !runtime.node.records.metadataReady())
    return;
  const spaces = runtime.node.records.list("item_schemas");
  if (!spaces.length) spaces.push(await runtime.node.records.ensureSchema());
  for (const space of spaces)
    for (const schema of schemaById.values())
      if (schema.tables && runtime.registry.enabled(schema.pluginId))
        await runtime.node.records.ensureTable(schema.id, space.id);
}
export async function selectedCollectionTable(
  runtime: AppRuntime,
  collection: string,
  optimistic = true,
): Promise<ResourceRecord | undefined> {
  const space = await selectedSchema(runtime);
  if (!space) return undefined;
  let table = (await tableDefinitions(runtime, collection, optimistic)).find(
    (t) => t.data.schema_id === space.id,
  );
  if (
    !table &&
    runtime.node.records.canWrite() &&
    runtime.node.records.metadataReady()
  ) {
    table = await runtime.node.records.ensureTable(collection, space.id);
  }
  return table
    ? {
        ...table,
        data: {
          ...table.data,
          columns: schemaColumns(table, (id) =>
            id === space.id ? space : runtime.node.records.get(id),
          ) as unknown as Value,
        },
      }
    : undefined;
}
export function belongsToTable(row: ResourceRecord, table?: ResourceRecord) {
  return (
    !table ||
    row.data.table_id === table.id ||
    (!row.data.table_id && Boolean(table.data.is_default))
  );
}
export function scopedTableStore<
  T extends {
    list: (...args: any[]) => Promise<ResourceRecord[]>;
    put: (data: any, id?: string) => Promise<ResourceRecord>;
  },
>(runtime: AppRuntime, collection: string, source: T, optimistic = true): T {
  if (!getSchema(collection).tables) return source;
  return {
    ...source,
    list: async (query?: { limit?: number; [key: string]: unknown }) => {
      const table = await selectedCollectionTable(
        runtime,
        collection,
        optimistic,
      );
      // Apply the limit after table membership; other tables cannot consume it.
      const rows = (
        await source.list(query ? { ...query, limit: undefined } : undefined)
      ).filter((row) => belongsToTable(row, table));
      return query?.limit === undefined ? rows : rows.slice(0, query.limit);
    },
    put: async (input: Record<string, Value>, id?: string) => {
      const old = id
        ? optimistic
          ? runtime.optimistic.record(id)
          : await runtime.db.records.get(id)
        : undefined;
      const table = await selectedCollectionTable(
        runtime,
        collection,
        optimistic,
      );
      return source.put(
        {
          ...input,
          table_id: old
            ? (old.data.table_id ?? null)
            : (input.table_id ?? table?.id ?? null),
          custom_fields: input.custom_fields ?? old?.data.custom_fields ?? {},
        },
        id,
      );
    },
  };
}
