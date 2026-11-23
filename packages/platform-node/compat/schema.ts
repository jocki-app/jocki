import type { Database } from "./database";
import { verifyCoreRelease } from "@jocki/platform/core/release";
import { invariant } from "@jocki/platform/core/errors";
import { migrateTypedValues } from "./typed-values";
import { schemas, requiredCoreIds } from "@jocki/platform/core/catalog";
import {
  sqlIdentifier,
  sqlType,
  type Field,
  type RecordSchema,
} from "@jocki/platform/field-types";

export const baseMigration = `
CREATE SCHEMA IF NOT EXISTS jocki;
CREATE TABLE IF NOT EXISTS jocki.projection_checkpoints (scope VARCHAR NOT NULL,id VARCHAR NOT NULL,source VARCHAR NOT NULL,heads VARCHAR[] NOT NULL,contract VARCHAR NOT NULL,PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS jocki.schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS jocki.workspaces (id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, revision bigint NOT NULL DEFAULT 0, access_epoch bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS jocki.memberships (workspace_id uuid NOT NULL,user_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('read','write')),PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS jocki.resources (id uuid PRIMARY KEY,workspace_id uuid NOT NULL,owner_id uuid NOT NULL,plugin_id text NOT NULL,collection text NOT NULL,revision bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE INDEX IF NOT EXISTS resources_scope ON jocki.resources(workspace_id,collection,updated_at);
CREATE TABLE IF NOT EXISTS jocki.grants (resource_id uuid NOT NULL,subject_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('viewer','commenter','editor')),expires_at timestamptz,PRIMARY KEY(resource_id,subject_id));
CREATE TABLE IF NOT EXISTS jocki.mutations (workspace_id uuid NOT NULL,user_id uuid NOT NULL,id uuid NOT NULL,request_hash text NOT NULL,result JSON NOT NULL,PRIMARY KEY(workspace_id,user_id,id));
CREATE TABLE IF NOT EXISTS jocki.changes (workspace_id uuid NOT NULL,sequence bigint NOT NULL,resource_id uuid NOT NULL,event JSON NOT NULL,PRIMARY KEY(workspace_id,sequence));
CREATE TABLE IF NOT EXISTS jocki.plugins (workspace_id uuid NOT NULL,id text NOT NULL,version text NOT NULL,installed boolean NOT NULL,enabled boolean NOT NULL,features JSON NOT NULL DEFAULT '[]',PRIMARY KEY(workspace_id,id));
CREATE TABLE IF NOT EXISTS jocki.secrets (resource_id uuid PRIMARY KEY,ciphertext text NOT NULL,version integer NOT NULL DEFAULT 1,revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS jocki.file_versions (id uuid PRIMARY KEY,file_id uuid NOT NULL,parent_id uuid,object_path text NOT NULL,sha256 text NOT NULL,size bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS jocki.device_keys (device_id uuid PRIMARY KEY,public_key text NOT NULL,token_hash text NOT NULL,revoked_at timestamptz,lease_epoch integer NOT NULL DEFAULT 0,last_seen timestamptz);
CREATE TABLE IF NOT EXISTS jocki.job_leases (job_id uuid PRIMARY KEY,owner text,epoch bigint NOT NULL DEFAULT 0,expires_at timestamptz);
CREATE TABLE IF NOT EXISTS jocki.audit (id uuid PRIMARY KEY,workspace_id uuid NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,resource_id uuid,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS jocki.enrollments(code_hash text PRIMARY KEY,workspace_id uuid NOT NULL,user_id uuid NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS jocki.stream_tickets(id uuid PRIMARY KEY,token_hash text NOT NULL UNIQUE,device_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS jocki.workflow_versions(workflow_id uuid NOT NULL,version integer NOT NULL,graph JSON NOT NULL,target_device_id uuid NOT NULL,trusted_code boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workflow_id,version));
CREATE TABLE IF NOT EXISTS jocki.dispatches(run_id uuid PRIMARY KEY,device_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL DEFAULT 'queued',assignment_epoch bigint NOT NULL DEFAULT 1,expires_at timestamptz,execution JSON NOT NULL,engine_run_id text,cancel_requested boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE SEQUENCE IF NOT EXISTS jocki.event_sequence;
CREATE TABLE IF NOT EXISTS jocki.plugin_events(id text PRIMARY KEY,workspace_id uuid NOT NULL,actor_id uuid NOT NULL,event JSON NOT NULL,sequence BIGINT DEFAULT nextval('jocki.event_sequence'),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS plugin_events_scope ON jocki.plugin_events(workspace_id,sequence);
CREATE TABLE IF NOT EXISTS jocki.event_receipts(event_id text NOT NULL,plugin_id text NOT NULL,attempt integer NOT NULL DEFAULT 0,delivered_at timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(event_id,plugin_id));
CREATE TABLE IF NOT EXISTS jocki.scheduler_cursors(resource_id uuid PRIMARY KEY,through timestamptz,error text);
CREATE TABLE IF NOT EXISTS jocki.workflow_triggers(workflow_id uuid PRIMARY KEY,configuration text,slot bigint NOT NULL DEFAULT -1,event_cursor bigint NOT NULL DEFAULT 0,error text);
CREATE TABLE IF NOT EXISTS jocki.workflow_hooks(workflow_id uuid PRIMARY KEY,token_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS jocki.workflow_signals(id uuid PRIMARY KEY,run_id uuid NOT NULL,name text NOT NULL,data JSON NOT NULL,delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
`;
function checks(f: Field) {
  const column = sqlIdentifier(f.id),
    result: string[] = [];
  if (f.choices) {
    const choices = f.choices
      .map((v) => `'${v.replaceAll("'", "''")}'`)
      .join(",");
    result.push(
      f.array
        ? `${column} <@ ARRAY[${choices}]::${sqlType(f)}`
        : `${column} IN (${choices})`,
    );
  }
  if (f.min !== undefined)
    result.push(
      f.array
        ? `list_min(${column}) >= ${Number(f.min)}`
        : `${column} >= ${Number(f.min)}`,
    );
  if (f.max !== undefined)
    result.push(
      f.array
        ? `list_max(${column}) <= ${Number(f.max)}`
        : `${column} <= ${Number(f.max)}`,
    );
  return result;
}
/** Service indexes contain feature fields, never another serialized item-value container. */
export function serviceFields(schema: RecordSchema) {
  return schema.fields.filter(
    (f) =>
      f.id !== "custom_fields" &&
      !(f.id === "values" && ["items", "table_rows"].includes(schema.id)),
  );
}
export function recordTable(schema: RecordSchema) {
  const columns = serviceFields(schema).map((f) => {
    const id = sqlIdentifier(f.id);
    let sql = `${id} ${sqlType(f)}`;
    if (!f.nullable) sql += " NOT NULL";
    for (const check of checks(f)) sql += ` CHECK (${check})`;
    return sql;
  });
  return `CREATE TABLE IF NOT EXISTS jocki.${sqlIdentifier("p_" + schema.id)} (id uuid PRIMARY KEY,${columns.join(",")});`;
}
export async function migrate(db: Database) {
  verifyCoreRelease();
  await db.transaction(async (tx) => {
    await tx.query(baseMigration);
    for (const schema of schemas) await migrateRecordSchema(tx, schema);
    await migrateTypedValues(tx);
    const workspaces = await tx.query<{ id: string }>(
      "SELECT id FROM jocki.workspaces",
    );
    for (const workspace of workspaces.rows)
      await seedCorePlugins(tx, workspace.id);
    await tx.query(
      "INSERT INTO jocki.schema_version(version) VALUES(1) ON CONFLICT DO NOTHING",
    );
  });
}
export async function seedCorePlugins(db: Database, workspaceId: string) {
  for (const id of requiredCoreIds)
    await db.query(
      "INSERT INTO jocki.plugins(workspace_id,id,version,installed,enabled) VALUES($1,$2,$3,true,true) ON CONFLICT(workspace_id,id) DO UPDATE SET version=EXCLUDED.version,installed=true,enabled=true",
      [workspaceId, id, "1.0.0"],
    );
}

export async function migrateRecordSchema(tx: Database, schema: RecordSchema) {
  await tx.query(recordTable(schema));
  const columns = await tx.query<{
    column_name: string;
    native_type: string;
    required: boolean;
  }>(
    "SELECT column_name, data_type AS native_type, (is_nullable='NO') AS required FROM information_schema.columns WHERE table_schema='jocki' AND table_name=$1",
    ["p_" + schema.id],
  );
  const known = new Set(columns.rows.map((c) => c.column_name));
  for (const field of serviceFields(schema)) {
    const deployed = columns.rows.find((c) => c.column_name === field.id);
    invariant(
      !deployed ||
        (deployed.native_type.replace(
          "TIMESTAMP WITH TIME ZONE",
          "TIMESTAMPTZ",
        ) === sqlType(field) &&
          deployed.required === !field.nullable),
      "SCHEMA_DRIFT",
      `Deployed ${schema.id}.${field.id} differs from the release contract; a reviewed migration is required`,
    );
    if (!known.has(field.id)) {
      if (!field.nullable && field.default === undefined)
        throw new Error(
          `Migration needs a backfill for ${schema.id}.${field.id}`,
        );
      const table = `jocki.${sqlIdentifier("p_" + schema.id)}`,
        column = sqlIdentifier(field.id);
      await tx.query(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType(field)}`,
      );
      if (field.default !== undefined)
        await tx.query(`UPDATE ${table} SET ${column}=$1`, [
          field.pgType === "jsonb"
            ? JSON.stringify(field.default)
            : field.default,
        ]);
      if (!field.nullable)
        await tx.query(
          `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`,
        );
    }
  }
}
