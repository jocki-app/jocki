import { browserDevice } from "../../packages/platform-browser/device";
import { LocalDatabase } from "../../packages/data-duckdb";
import { schemaColumns } from "../../packages/core/item-schemas";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";

/** Synthetic UI snapshots in a disposable test profile, never core documents. */
export async function seedTableRows(count: number) {
  const device = await browserDevice();
  const node = [...device.workspaces.values()][0];
  const table = node.records
    .list("tables")
    .find((row) => row.data.collection_id === "track")!;
  const activity = schemaColumns(table, (id) => node.records.get(id)).find(
    (field) => field.label === "Activity",
  )!;
  const ownerId = node.replica.member.userId;
  const db = new LocalDatabase(node.replica.workspaceId, ownerId);
  const rows = Array.from({ length: count }, (_, i): ResourceRecord => ({
    id: crypto.randomUUID(),
    collection: "track",
    pluginId: "track",
    workspaceId: node.replica.workspaceId,
    ownerId,
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    deletedAt: null,
    data: {
      table_id: table.id,
      started_at: new Date(Date.now() - 60000).toISOString(),
      ended_at: i === 0 ? null : new Date().toISOString(),
      custom_fields: { [activity.id]: "History " + i },
    },
  }));
  try {
    await db.records.bulkPut(rows);
  } finally {
    await db.close();
  }
}
