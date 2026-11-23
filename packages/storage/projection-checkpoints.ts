import type { SqlConnection } from "./database";
import type { ProjectionBatch, ProjectionCheckpoint } from "../core/projection";

export async function initializeCheckpoints(sql: SqlConnection) {
  await sql.query(
    "CREATE TABLE IF NOT EXISTS jocki.projection_checkpoints (scope VARCHAR NOT NULL, id VARCHAR NOT NULL, source VARCHAR NOT NULL, heads VARCHAR[] NOT NULL, contract VARCHAR NOT NULL, PRIMARY KEY(scope,id))",
  );
}
export async function loadCheckpoints(sql: SqlConnection, scope: string) {
  // SQL lists become Arrow vectors in Wasm. Decode JSON text on both drivers
  // so checkpoint comparison is identical after a browser or native restart.
  const rows = await sql.query<
    Omit<ProjectionCheckpoint, "heads"> & { heads: string }
  >(
    "SELECT id, source, CAST(to_json(heads) AS VARCHAR) AS heads, contract FROM jocki.projection_checkpoints WHERE scope=?",
    [scope],
  );
  return rows.map((row): ProjectionCheckpoint => ({
    ...row,
    heads: JSON.parse(row.heads),
  }));
}
/** Call within the same SQL transaction as the indexed row changes. */
export async function saveCheckpoints(
  sql: SqlConnection,
  scope: string,
  batch: ProjectionBatch,
) {
  for (const id of batch.removed)
    await sql.query(
      "DELETE FROM jocki.projection_checkpoints WHERE scope=? AND id=?",
      [scope, id],
    );
  for (let offset = 0; offset < batch.checkpoints.length; offset += 128) {
    await sql.query(
      "INSERT OR REPLACE INTO jocki.projection_checkpoints SELECT ?, json_extract_string(value,'$.id'), json_extract_string(value,'$.source'), CAST(json_extract(value,'$.heads') AS VARCHAR[]), json_extract_string(value,'$.contract') FROM json_each(?::JSON)",
      [scope, JSON.stringify(batch.checkpoints.slice(offset, offset + 128))],
    );
  }
}
