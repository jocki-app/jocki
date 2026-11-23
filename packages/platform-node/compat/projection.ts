import type { Database } from "./database";
import type { WorkspaceNode } from "../../core/device";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { schemaById } from "@jocki/platform/core/catalog";
import { sqlIdentifier } from "@jocki/platform/field-types";
import { encodeSqlField } from "./field-codecs";
import { membership } from "../../core/membership";
import { recordTable, seedCorePlugins, serviceFields } from "./schema";
import { DocumentProjection } from "../../core/projection";
import { canonical } from "../../core/crypto";
import type { Replica } from "../../core/replica";
import type { SqlConnection, SqlRow } from "../../storage/database";
import {
  initializeCheckpoints,
  loadCheckpoints,
  saveCheckpoints,
} from "../../storage/projection-checkpoints";

const connection = (db: Database): SqlConnection => ({
  query: async <T extends SqlRow>(
    sql: string,
    values?: import("../../storage/database").SqlValue[],
  ) => (await db.query<T>(sql, values)).rows,
});
const projections = new WeakMap<
  Database,
  Map<
    string,
    { replica: Replica; cursor: DocumentProjection; contracts: string }
  >
>();
export function stopWorkspaceProjections(db: Database, workspaceId?: string) {
  const entries = projections.get(db);
  for (const [id, entry] of entries ?? [])
    if (!workspaceId || id === workspaceId) {
      entry.cursor.stop();
      entries!.delete(id);
    }
}
export async function deleteWorkspaceProjection(db: Database, id: string) {
  await db.transaction(async (tx) => {
    await tx.query(
      "DELETE FROM jocki.event_receipts WHERE event_id IN (SELECT id FROM jocki.plugin_events WHERE workspace_id=$1)",
      [id],
    );
    await tx.query(
      "DELETE FROM jocki.workflow_versions WHERE workflow_id IN (SELECT id FROM jocki.resources WHERE workspace_id=$1)",
      [id],
    );
    const tables = await tx.query<{ tablename: string }>(
      "SELECT table_name AS tablename FROM information_schema.tables WHERE table_schema='jocki' AND left(table_name,2)='p_'",
    );
    const references: Array<[string, string]> = [
      ...tables.rows.map(
        ({ tablename }) => [tablename, "id"] as [string, string],
      ),
      ["grants", "resource_id"],
      ["changes", "resource_id"],
      ["secrets", "resource_id"],
      ["file_versions", "file_id"],
      ["device_keys", "device_id"],
      ["job_leases", "job_id"],
      ["scheduler_cursors", "resource_id"],
      ["workflow_triggers", "workflow_id"],
      ["workflow_hooks", "workflow_id"],
      ["workflow_signals", "run_id"],
    ];
    for (const [table, column] of references)
      await tx.query(
        `DELETE FROM jocki.${sqlIdentifier(table)} WHERE ${sqlIdentifier(column)} IN (SELECT id FROM jocki.resources WHERE workspace_id=$1)`,
        [id],
      );
    for (const table of [
      "resources",
      "memberships",
      "plugins",
      "mutations",
      "audit",
      "enrollments",
      "stream_tickets",
      "dispatches",
      "plugin_events",
      "changes",
    ])
      await tx.query(
        `DELETE FROM jocki.${sqlIdentifier(table)} WHERE workspace_id=$1`,
        [id],
      );
    await tx.query("DELETE FROM jocki.workspaces WHERE id=$1", [id]);
    await tx.query(
      "DELETE FROM jocki.projection_checkpoints WHERE scope=$1",
      [id],
    );
  });
}
export async function projectRecord(db: Database, record: ResourceRecord) {
  const schema = schemaById.get(record.collection);
  if (!schema || (record.schemaVersion ?? 1) > schema.version) return;
  await db.transaction(async (tx) => {
    await tx.query(recordTable(schema));
    await writeRecord(tx, record);
  });
}
async function writeRecord(db: Database, record: ResourceRecord) {
  const schema = schemaById.get(record.collection);
  if (!schema || (record.schemaVersion ?? 1) > schema.version) return;
  await db.query(
    "INSERT INTO jocki.resources(id,workspace_id,owner_id,plugin_id,collection,revision,created_at,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at,deleted_at=EXCLUDED.deleted_at",
    [
      record.id,
      record.workspaceId,
      record.ownerId,
      record.pluginId,
      record.collection,
      record.revision,
      record.createdAt,
      record.updatedAt,
      record.deletedAt,
    ],
  );
  const names = serviceFields(schema).map((f) => sqlIdentifier(f.id)),
    values = serviceFields(schema).map((f) =>
      encodeSqlField(f, record.data[f.id]),
    );
  await db.query(
    `INSERT INTO jocki.${sqlIdentifier("p_" + schema.id)}(id,${names.join(",")}) VALUES($1,${values.map((_, i) => "$" + (i + 2)).join(",")}) ON CONFLICT(id) DO UPDATE SET ${names.map((n) => `${n}=EXCLUDED.${n}`).join(",")}`,
    [record.id, ...values],
  );
}
export async function projectWorkspace(db: Database, node: WorkspaceNode) {
  let entries = projections.get(db);
  if (!entries) {
    entries = new Map();
    projections.set(db, entries);
  }
  const id = node.replica.workspaceId;
  let entry = entries.get(id);
  if (entry?.replica !== node.replica) {
    entry?.cursor.stop();
    entry = undefined;
  }
  if (!entry) {
    const cursor = new DocumentProjection(
      node.replica,
      {
        load: async () => {
          await db.transaction((tx) => initializeCheckpoints(connection(tx)));
          const checkpoints = await loadCheckpoints(connection(db), id),
            known = new Set(checkpoints.map((value) => value.id));
          for (const row of (
            await db.query<{ id: string }>(
              "SELECT id::VARCHAR AS id FROM jocki.resources WHERE workspace_id=$1",
              [id],
            )
          ).rows)
            if (!known.has("record/" + row.id))
              checkpoints.push({
                id: "record/" + row.id,
                source: "",
                heads: [],
                contract: "",
              });
          return checkpoints;
        },
        apply: (batch) =>
          db.transaction(async (tx) => {
            const unsupported = batch.documents
              .filter((doc) => {
                if (!doc.id.startsWith("record/")) return false;
                const schema = schemaById.get(String(doc.value.collection));
                return (
                  !schema ||
                  Number(doc.value.schemaVersion ?? 1) > schema.version
                );
              })
              .map((doc) => doc.id);
            const removed = [...new Set([...batch.removed, ...unsupported])]
              .filter((key) => key.startsWith("record/"))
              .map((key) => key.slice(7));
            if (removed.length) {
              const tables = await tx.query<{ tablename: string }>(
                "SELECT table_name AS tablename FROM information_schema.tables WHERE table_schema='jocki' AND left(table_name,2)='p_'",
              );
              for (const { tablename } of tables.rows)
                await tx.query(
                  `DELETE FROM jocki.${sqlIdentifier(tablename)} WHERE id=ANY($1::uuid[])`,
                  [removed],
                );
              await tx.query(
                "DELETE FROM jocki.resources WHERE id=ANY($1::uuid[]) AND workspace_id=$2",
                [removed, id],
              );
            }
            for (const doc of batch.documents) {
              if (doc.id.startsWith("record/")) {
                const record = node.records.get(doc.id.slice(7));
                if (record) await writeRecord(tx, record);
              } else if (doc.id.startsWith("setting/workflow.")) {
                const [workflowId, version] = doc.id
                    .slice("setting/workflow.".length)
                    .split("."),
                  pin = doc.value;
                await tx.query(
                  "INSERT INTO jocki.workflow_versions(workflow_id,version,graph,target_device_id,trusted_code) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workflow_id,version) DO NOTHING",
                  [
                    workflowId,
                    Number(version),
                    JSON.stringify(pin.graph),
                    pin.targetDeviceId,
                    pin.trusted,
                  ],
                );
              } else if (
                doc.id.startsWith("event/") &&
                doc.value.id &&
                (doc.value.data as any)?.resourceId
              ) {
                await tx.query(
                  "INSERT INTO jocki.plugin_events(id,workspace_id,actor_id,event) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
                  [
                    doc.value.id,
                    id,
                    node.replica.member.userId,
                    JSON.stringify(doc.value),
                  ],
                );
              }
            }
            await saveCheckpoints(connection(tx), id, batch);
          }),
      },
      "native-sql-1",
    );
    entry = { replica: node.replica, cursor, contracts: "" };
    entries.set(id, entry);
  }
  const policy = membership(node.replica.access);
  const contracts = canonical([...schemaById]);
  if (entry.contracts !== contracts) {
    await db.transaction(async (tx) => {
      for (const schema of schemaById.values())
        await tx.query(recordTable(schema));
    });
    entry.contracts = contracts;
  }
  await entry.cursor.synchronize();
  if (!node.replica.member) {
    await deleteWorkspaceProjection(db, id);
    return;
  }
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO jocki.workspaces(id,owner_id,name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name",
      [policy.workspaceId, policy.userId, policy.name],
    );
    await tx.query("DELETE FROM jocki.memberships WHERE workspace_id=$1", [
      policy.workspaceId,
    ]);
    const roles = new Map<string, string>();
    for (const m of Object.values(policy.members)) {
      if (roles.get(m.userId) !== "write") roles.set(m.userId, m.access);
    }
    for (const [userId, role] of roles)
      await tx.query(
        "INSERT INTO jocki.memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [policy.workspaceId, userId, role],
      );
    await seedCorePlugins(tx, policy.workspaceId);
  });
}
