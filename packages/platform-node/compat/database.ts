import "../duckdb";
import path from "node:path";
import {
  SqlDatabase,
  type SqlConnection,
  type SqlValue,
} from "../../storage/database";
import type { WorkspaceNode } from "../../core/device";
import type { DeviceCore } from "../../core/device";
export interface Database {
  core: DeviceCore;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}
export async function openDatabase(directory: string, core: DeviceCore) {
  const db = await SqlDatabase.open({
    path: path.join(directory, "services-v2.duckdb"),
  });
  function wrap(client: SqlConnection, inside = false): Database {
    return {
      core,
      async query<T extends Record<string, unknown>>(
        sql: string,
        values: unknown[] = [],
      ) {
        const parameters = values.map((value) =>
          value === undefined
            ? null
            : typeof value === "bigint"
              ? String(value)
              : value instanceof Date
                ? value.toISOString()
                : value && typeof value === "object"
                  ? JSON.stringify(value)
                  : value,
        ) as SqlValue[];
        const execute = async (connection: SqlConnection) => {
          const rows = await connection.query<T>(sql, parameters);
          return {
            rows,
            rowCount:
              rows.length === 1 && "Count" in rows[0]
                ? Number(rows[0].Count)
                : rows.length,
          };
        };
        // The connection queue replaces PostgreSQL row/advisory locks. Every service write checkpoints before acknowledgement.
        return inside ? execute(client) : db.transaction(execute);
      },
      transaction: (fn) =>
        inside
          ? fn(wrap(client, true))
          : db.transaction((tx) => fn(wrap(tx, true))),
    };
  }
  return { database: wrap(db), close: () => db.close() };
}
export function nodeFor(db: Database, workspaceId: string): WorkspaceNode {
  const node = db.core.workspaces.get(workspaceId);
  if (!node) throw Error("Workspace is not linked to this device");
  return node;
}
