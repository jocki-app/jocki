import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { getSchema, schemaById } from "@jocki/platform/core/catalog";
import { tableFields } from "@jocki/platform/core/dynamic-fields";
import { collectionColumns } from "@jocki/platform/core/collection-tables";
import type { Field, Value } from "@jocki/platform/field-types";
import { digest, utf8 } from "./crypto";

export async function schemaResourceId(workspace: string, key: string) {
  const hash = await digest(utf8.encode(workspace + "/" + key));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export const pluginTableId = (
  workspace: string,
  schema: string,
  collection: string,
) => schemaResourceId(workspace, `schema/${schema}/${collection}`);

/** Shared fields have one definition and one owner, regardless of the viewing plugin. */
export function schemaColumns(
  table: ResourceRecord,
  get: (id: string) => ResourceRecord | undefined,
): Field[] {
  const shared = table.data.schema_id
    ? get(String(table.data.schema_id))
    : undefined;
  const fields = [
    ...tableFields(table.data.columns ?? []),
    ...tableFields(shared?.data.columns ?? []).map((f) => ({
      ...f,
      scope: "shared" as const,
      storage: "custom" as const,
    })),
  ];
  const order = Array.isArray(table.data.column_order)
    ? (table.data.column_order as string[])
    : [];
  return fields.sort(
    (a, b) =>
      (order.includes(a.id) ? order.indexOf(a.id) : order.length) -
      (order.includes(b.id) ? order.indexOf(b.id) : order.length),
  );
}

export function joinedItemRecord(
  row: ResourceRecord,
  get: (id: string) => ResourceRecord | undefined,
): ResourceRecord {
  if (!row.data.item_id) return row;
  const item = get(String(row.data.item_id));
  if (!item || item.deletedAt || item.collection !== "items") return row;
  const custom = {
    ...((row.data.custom_fields as Record<string, Value>) ?? {}),
    ...((item.data.values as Record<string, Value>) ?? {}),
  };
  const data: Record<string, Value> = { ...row.data, custom_fields: custom };
  const table = get(String(row.data.table_id));
  const contract = schemaById.get(row.collection);
  if (table && contract) {
    const sharedIds = new Set(
      schemaColumns(table, get)
        .filter((f) => f.scope === "shared")
        .map((f) => f.id),
    );
    for (const [role, source] of Object.entries(
      (table.data.bindings as Record<string, string>) ?? {},
    ))
      if (sharedIds.has(source) && Object.hasOwn(custom, source))
        data[role] = custom[source];
  }
  return { ...row, data };
}

export function initialPluginColumns(collection: string) {
  return collectionColumns(getSchema(collection)).filter((f) => f.required);
}
