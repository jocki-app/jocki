import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { schemaById } from "@jocki/platform/core/catalog";
import { tableFields } from "@jocki/platform/core/dynamic-fields";
import {
  field,
  type Field,
  sqlType as duckType,
} from "@jocki/platform/field-types";
import {
  identifier as quote,
  type SqlConnection,
  type SqlValue,
} from "./database";
export { sqlType as duckType } from "@jocki/platform/field-types";
export interface StoredDocument {
  id: string;
  value: Record<string, unknown>;
  heads: string[];
  related?: StoredDocument[];
}
export const userTableName = (id: string) => "table_" + id.replaceAll("-", "");
const itemTableName = (id: string) => "items_" + id.replaceAll("-", "");
const metadata =
  "_record_id UUID PRIMARY KEY, _owner_id UUID, _plugin_id VARCHAR, _created_at TIMESTAMPTZ, _updated_at TIMESTAMPTZ, _revision BIGINT, _workspace_id UUID, _schema_version INTEGER, _managed_by VARCHAR";
const metaNames = [
  "_record_id",
  "_owner_id",
  "_plugin_id",
  "_created_at",
  "_updated_at",
  "_revision",
  "_workspace_id",
  "_schema_version",
  "_managed_by",
];
type Table = {
  table_name: string;
  collection: string;
  definition_id: string | null;
  fields: string;
};

export async function initializeProjection(sql: SqlConnection) {
  const old = await sql.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='jocki' AND table_name='documents'",
  );
  if (old.length)
    throw Error(
      "This workspace uses the previous JSON record format. Create a workspace in the new schema format; automatic migration is not supported.",
    );
  await sql.query(`CREATE SCHEMA IF NOT EXISTS jocki;
    CREATE SCHEMA IF NOT EXISTS item_data; CREATE SCHEMA IF NOT EXISTS collections; CREATE SCHEMA IF NOT EXISTS tables;
    CREATE TABLE IF NOT EXISTS jocki.document_index (id VARCHAR PRIMARY KEY, heads VARCHAR[] NOT NULL, collection VARCHAR, table_name VARCHAR, record_id UUID);
    CREATE TABLE IF NOT EXISTS jocki.table_schemas (table_name VARCHAR PRIMARY KEY, collection VARCHAR NOT NULL, definition_id UUID, fields JSON NOT NULL);
    CREATE TABLE IF NOT EXISTS jocki.workspace_settings (singleton BOOLEAN PRIMARY KEY CHECK(singleton), value JSON NOT NULL);
    CREATE TABLE IF NOT EXISTS jocki.file_versions (id UUID PRIMARY KEY, file_id UUID NOT NULL, parent_version_id UUID, media_type VARCHAR NOT NULL, size BIGINT NOT NULL, checksum VARCHAR NOT NULL, chunks VARCHAR[] NOT NULL, created_at TIMESTAMPTZ NOT NULL);`);
}
export function scalar(field: Field, value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (field.array)
    return JSON.stringify(
      field.pgType === "interval"
        ? (value as unknown[]).map((item) =>
            scalar({ ...field, array: false }, item),
          )
        : value,
    );
  if (field.pgType === "jsonb") return JSON.stringify(value);
  if (
    field.pgType === "interval" &&
    typeof value === "string" &&
    /^-?P/.test(value)
  ) {
    const match =
      /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
        value,
      );
    if (!match) throw Error("Invalid ISO interval");
    const units = ["year", "month", "week", "day", "hour", "minute", "second"];
    return (
      match
        .slice(2)
        .flatMap((v, index) =>
          v ? [`${match[1] ?? ""}${v} ${units[index]}`] : [],
        )
        .join(" ") || "0 seconds"
    );
  }
  return typeof value === "boolean" || typeof value === "number"
    ? value
    : String(value);
}

async function catalog(sql: SqlConnection) {
  return sql.query<Table>(
    "SELECT table_name, collection, definition_id::VARCHAR AS definition_id, fields::VARCHAR AS fields FROM jocki.table_schemas",
  );
}
async function definition(sql: SqlConnection, collection: string, id: string) {
  if (!(await catalog(sql)).some((t) => t.table_name === collection))
    return undefined;
  return (
    await sql.query<Record<string, unknown>>(
      `SELECT * FROM item_data.${quote(collection)} WHERE _record_id=?::UUID`,
      [id],
    )
  )[0];
}
const physicalFields = (value: unknown) => parse(value) as Field[];
const featureColumn = (id: string) => "_feature_" + id;
const pluginFields = (base: Field[], columns: Field[]) => [
  ...base
    .filter((f) => !["custom_fields", "values"].includes(f.id))
    .map((f) =>
      columns.some((c) => c.id === f.id && c.storage === "custom")
        ? { ...f, id: featureColumn(f.id) }
        : f,
    )
    .filter((f) => !columns.some((c) => c.id === f.id)),
  ...columns,
];
const parse = (value: unknown) =>
  typeof value === "string" ? JSON.parse(value) : value;
async function ensureTable(
  sql: SqlConnection,
  name: string,
  collection: string,
  definitionId: string | null,
  requested: Field[],
) {
  const before = (await catalog(sql)).find((t) => t.table_name === name);
  const fields: Field[] = before ? parse(before.fields) : [];
  if (!before)
    await sql.query(`CREATE TABLE item_data.${quote(name)} (${metadata})`);
  let changed = !before;
  for (const f of requested) {
    const old = fields.find((v) => v.id === f.id);
    if (!old) {
      await sql.query(
        `ALTER TABLE item_data.${quote(name)} ADD COLUMN ${quote(f.id)} ${duckType(f)}`,
      );
      fields.push(f);
      changed = true;
    } else if (duckType(old) !== duckType(f)) {
      await sql.query(
        `ALTER TABLE item_data.${quote(name)} ALTER COLUMN ${quote(f.id)} TYPE ${duckType(f)} USING CAST(${quote(f.id)} AS ${duckType(f)})`,
      );
      fields[fields.indexOf(old)] = f;
      changed = true;
    }
  }
  // Removed/hidden fields are retained. No plugin code is needed to preserve a table.
  if (changed)
    await sql.query(
      "INSERT OR REPLACE INTO jocki.table_schemas VALUES (?, ?, ?::UUID, ?::JSON)",
      [name, collection, definitionId, JSON.stringify(fields)],
    );
  return changed;
}

async function insertRows(
  sql: SqlConnection,
  name: string,
  fields: Field[],
  rows: ResourceRecord[],
  values: (row: ResourceRecord) => Record<string, unknown>,
) {
  const expressions = fields.map((f) =>
    f.pgType === "bytea"
      ? f.array
        ? "list_transform(CAST(? AS VARCHAR[]), x -> from_base64(x))"
        : "from_base64(?)"
      : `CAST(? AS ${duckType(f)})`,
  );
  const names = [...metaNames, ...fields.map((f) => f.id)];
  const expression = `(?::UUID,?::UUID,?,?::TIMESTAMPTZ,?::TIMESTAMPTZ,?::BIGINT,?::UUID,?::INTEGER,?${expressions.length ? "," + expressions.join(",") : ""})`;
  for (let i = 0; i < rows.length; i += 64) {
    const batch = rows.slice(i, i + 64);
    await sql.query(
      `INSERT INTO item_data.${quote(name)} (${names.map(quote).join(",")}) VALUES ${batch.map(() => expression).join(",")} ON CONFLICT (_record_id) DO UPDATE SET ${names
        .slice(1)
        .map((n) => `${quote(n)}=excluded.${quote(n)}`)
        .join(",")}`,
      batch.flatMap((r) => [
        r.id,
        r.ownerId,
        r.pluginId,
        r.createdAt,
        r.updatedAt,
        r.revision,
        r.workspaceId,
        r.schemaVersion ?? 1,
        r.managedBy ?? null,
        ...fields.map((f) => scalar(f, values(r)[f.id])),
      ]),
    );
  }
}
async function refreshViews(sql: SqlConnection) {
  const tables = await catalog(sql);
  for (const collection of new Set(tables.map((t) => t.collection))) {
    const contract = schemaById.get(collection);
    const members = tables.filter((t) => t.collection === collection);
    const fields =
      contract?.fields.filter(
        (f) => !["custom_fields", "values"].includes(f.id),
      ) ?? physicalFields(members[0].fields);
    const selects: string[] = [];
    for (const t of members) {
      const stored = physicalFields(t.fields);
      const def =
        t.definition_id && t.collection !== "items"
          ? await definition(sql, "tables", t.definition_id)
          : undefined;
      const sharedDefinition = def?.schema_id
        ? await definition(sql, "item_schemas", String(def.schema_id))
        : undefined;
      const shared = sharedDefinition
        ? tables.find(
            (v) => v.table_name === itemTableName(String(def!.schema_id)),
          )
        : undefined;
      const sharedFields = sharedDefinition
        ? tableFields(parse(sharedDefinition.columns))
        : [];
      const bindings = def?.bindings
        ? (parse(def.bindings) as Record<string, string>)
        : {};
      const joined = shared && stored.some((f) => f.id === "item_id");
      const expressions = fields.map((f) => {
        const source = bindings[f.id];
        const overridden =
          def &&
          tableFields(parse(def.columns)).some(
            (c) => c.id === f.id && c.storage === "custom",
          );
        const storedId =
          overridden && stored.some((c) => c.id === featureColumn(f.id))
            ? featureColumn(f.id)
            : f.id;
        const expression =
          joined && source && sharedFields.some((c) => c.id === source)
            ? `i.${quote(source)}`
            : stored.some((p) => p.id === storedId)
              ? `p.${quote(storedId)}`
              : `CAST(NULL AS ${duckType(f)})`;
        return `${expression} AS ${quote(f.id)}`;
      });
      selects.push(
        `SELECT ${[...metaNames.map((n) => `p.${quote(n)}`), ...expressions].join(",")} FROM item_data.${quote(t.table_name)} p${joined ? ` LEFT JOIN item_data.${quote(shared!.table_name)} i ON p.item_id=i._record_id` : ""}`,
      );
    }
    await sql.query(
      `CREATE OR REPLACE VIEW collections.${quote(collection)} AS ${selects.join(" UNION ALL ")}`,
    );
  }
  for (const shared of tables.filter(
    (t) => t.collection === "items" && t.definition_id,
  )) {
    const namespace = "schema_" + shared.definition_id!.replaceAll("-", "");
    await sql.query(`CREATE SCHEMA IF NOT EXISTS ${quote(namespace)}`);
    await sql.query(
      `CREATE OR REPLACE VIEW ${quote(namespace)}.items AS SELECT _record_id AS item_id, * EXCLUDE (_record_id, schema_id) FROM item_data.${quote(shared.table_name)}`,
    );
  }
  for (const t of tables.filter((t) => t.definition_id)) {
    if (t.collection === "items") continue;
    const def = await definition(sql, "tables", t.definition_id!);
    if (!def) continue;
    const stored = physicalFields(t.fields);
    const fields = tableFields(parse(def.columns));
    const shared = def.schema_id
      ? tables.find(
          (v) => v.table_name === itemTableName(String(def.schema_id)),
        )
      : undefined;
    const sharedDefinition = shared
      ? await definition(sql, "item_schemas", String(def.schema_id))
      : undefined;
    const sharedFields = sharedDefinition
      ? tableFields(parse(sharedDefinition.columns))
      : [];
    const select = [
      ...metaNames.map((n) => `p.${quote(n)}`),
      ...fields
        .filter((f) => stored.some((v) => v.id === f.id))
        .map((f) => `p.${quote(f.id)}`),
      ...sharedFields.map((f) => `i.${quote(f.id)}`),
    ];
    const join =
      shared && stored.some((f) => f.id === "item_id")
        ? ` LEFT JOIN item_data.${quote(shared.table_name)} i ON p.item_id=i._record_id`
        : "";
    await sql.query(
      `CREATE OR REPLACE VIEW tables.${quote(t.table_name)} AS SELECT ${select.join(",")} FROM item_data.${quote(t.table_name)} p${join}`,
    );
    if (def.schema_id) {
      const namespace = "schema_" + String(def.schema_id).replaceAll("-", "");
      await sql.query(`CREATE SCHEMA IF NOT EXISTS ${quote(namespace)}`);
      await sql.query(
        `CREATE OR REPLACE VIEW ${quote(namespace)}.${quote(t.collection)} AS SELECT * FROM tables.${quote(t.table_name)}`,
      );
    }
  }
}

export async function projectDocument(
  sql: SqlConnection,
  document: StoredDocument,
) {
  await projectDocuments(sql, [document]);
}
/** Typed current state is stored once. Views provide collection and shared-item joins.
 * The caller commits the projection in one local SQL transaction. */
export async function projectDocuments(
  sql: SqlConnection,
  documents: StoredDocument[],
) {
  // A received batch often contains dozens of rows in the same table. Reuse
  // its schema/definition reads until a write can change them.
  const source = sql,
    reads = new Map<string, Promise<Record<string, unknown>[]>>();
  sql = {
    query: <T extends Record<string, unknown>>(
      query: string,
      values: SqlValue[] = [],
    ): Promise<T[]> => {
      const reusable =
        query.startsWith("SELECT table_name, collection, definition_id") ||
        /^SELECT \* FROM item_data\./.test(query);
      if (!/^SELECT\b/i.test(query)) reads.clear();
      if (!reusable) return source.query<T>(query, values);
      const key = query + JSON.stringify(values);
      let rows = reads.get(key);
      if (!rows) {
        rows = source.query(query, values);
        reads.set(key, rows);
      }
      return rows as Promise<T[]>;
    },
  };
  documents = [
    ...new Map(
      documents.flatMap((d) => [...(d.related ?? []), d]).map((d) => [d.id, d]),
    ).values(),
  ];
  let changed = false;
  const indexes: Array<{
    id: string;
    heads: string[];
    collection: string | null;
    table_name: string | null;
    record_id: string | null;
  }> = [];
  const recordDocs = documents.filter((d) => d.id.startsWith("record/"));
  // Definitions precede their rows even when the records arrived out of order.
  const priority = (d: StoredDocument) =>
    ["item_schemas", "tables", "items"].indexOf(String(d.value.collection));
  recordDocs.sort(
    (a, b) =>
      (priority(a) < 0 ? 3 : priority(a)) - (priority(b) < 0 ? 3 : priority(b)),
  );
  const batches = new Map<
    string,
    { fields: Field[]; rows: ResourceRecord[] }
  >();
  const flush = async () => {
    for (const [name, batch] of batches)
      await insertRows(sql, name, batch.fields, batch.rows, (row) => row.data);
    batches.clear();
  };
  for (const doc of recordDocs) {
    const row = doc.value as unknown as ResourceRecord;
    const existing = (
      await sql.query<{ table_name: string | null }>(
        "SELECT table_name FROM jocki.document_index WHERE id=?",
        [doc.id],
      )
    )[0];
    let contract = schemaById.get(row.collection);
    let name = row.collection;
    let fields = contract?.fields ?? [];
    let values: Record<string, unknown> = { ...row.data };
    let definitionId: string | null = null;
    if (row.collection === "items") {
      definitionId = String(row.data.schema_id);
      const def = await definition(sql, "item_schemas", definitionId);
      name = itemTableName(definitionId);
      if (def)
        fields = [
          field("schema_id", "Schema", "uuid"),
          ...tableFields(parse(def.columns)),
        ];
      else fields = [];
      values = {
        schema_id: row.data.schema_id,
        ...(row.data.values as Record<string, unknown>),
      };
    } else if (
      (contract?.tables || row.collection === "table_rows" || !contract) &&
      row.data.table_id
    ) {
      definitionId = String(row.data.table_id);
      name = userTableName(definitionId);
      const def = await definition(sql, "tables", definitionId);
      if (def) {
        const columns = tableFields(parse(def.columns));
        fields = pluginFields(fields, columns);
      } else fields = [];
      values = {
        ...row.data,
        ...((row.data.custom_fields as Record<string, unknown>) ?? {}),
        ...((row.data.values as Record<string, unknown>) ?? {}),
      };
    }
    const schemas = await catalog(sql);
    const previousSchema = schemas.find((t) => t.table_name === name);
    if ((!fields.length || !contract) && previousSchema)
      fields = physicalFields(previousSchema.fields);
    for (const f of fields.filter((f) => f.id.startsWith("_feature_")))
      values[f.id] = row.data[f.id.slice(9)];
    const supported =
      fields.length > 0 &&
      (!contract || (row.schemaVersion ?? 1) <= contract.version);
    if (
      existing?.table_name &&
      schemas.some((table) => table.table_name === existing.table_name) &&
      (existing.table_name !== name || row.deletedAt || !supported)
    ) {
      await flush();
      await sql.query(
        `DELETE FROM item_data.${quote(existing.table_name)} WHERE _record_id=?::UUID`,
        [row.id],
      );
    }
    if (supported && !row.deletedAt) {
      changed =
        (await ensureTable(sql, name, row.collection, definitionId, fields)) ||
        changed;
      const batch = batches.get(name) ?? { fields, rows: [] };
      batch.rows.push({ ...row, data: values as ResourceRecord["data"] });
      batches.set(name, batch);
      if (["item_schemas", "tables"].includes(row.collection)) {
        await flush();
        changed = true;
      }
    }
    indexes.push({
      id: doc.id,
      heads: doc.heads,
      collection: row.collection,
      table_name: supported && !row.deletedAt ? name : null,
      record_id: row.id,
    });
  }
  await flush();
  for (const doc of documents.filter((d) => !d.id.startsWith("record/"))) {
    // Shared app preferences have an explicit JSON projection for inspection/export.
    // Other internal controls/events need only their Automerge state and index.
    if (doc.id === "setting/workspace")
      await sql.query(
        "INSERT OR REPLACE INTO jocki.workspace_settings VALUES (true, ?::JSON)",
        [JSON.stringify(doc.value)],
      );
    indexes.push({
      id: doc.id,
      heads: doc.heads,
      collection: null,
      table_name: null,
      record_id: null,
    });
    if (doc.id.startsWith("file/")) {
      const v = doc.value;
      await sql.query(
        "INSERT OR REPLACE INTO jocki.file_versions VALUES (?::UUID,?::UUID,?::UUID,?,?::BIGINT,?,?::VARCHAR[],?::TIMESTAMPTZ)",
        [
          String(v.id),
          String(v.fileId),
          v.parentVersionId ? String(v.parentVersionId) : null,
          String(v.mediaType),
          String(v.size),
          String(v.checksum),
          JSON.stringify(v.chunks),
          String(v.createdAt),
        ],
      );
    }
  }
  for (let i = 0; i < indexes.length; i += 128)
    await sql.query(
      `INSERT OR REPLACE INTO jocki.document_index SELECT json_extract_string(value,'$.id'), CAST(json_extract(value,'$.heads') AS VARCHAR[]), json_extract_string(value,'$.collection'), json_extract_string(value,'$.table_name'), CAST(json_extract_string(value,'$.record_id') AS UUID) FROM json_each(?::JSON)`,
      [JSON.stringify(indexes.slice(i, i + 128))],
    );
  if (changed) {
    // Empty tables and schema-only changes also have physical, typed columns.
    for (const doc of recordDocs.filter((d) => !d.value.deletedAt)) {
      const r = doc.value as unknown as ResourceRecord;
      if (r.collection === "item_schemas")
        await ensureTable(sql, itemTableName(r.id), "items", r.id, [
          field("schema_id", "Schema", "uuid"),
          ...tableFields(r.data.columns),
        ]);
      if (r.collection === "tables") {
        const contract = schemaById.get(
          String(r.data.collection_id || "table_rows"),
        );
        const columns = tableFields(r.data.columns);
        const allFields = pluginFields(contract?.fields ?? [], columns);
        await ensureTable(
          sql,
          userTableName(r.id),
          String(r.data.collection_id || "table_rows"),
          r.id,
          allFields,
        );
      }
    }
    await refreshViews(sql);
  }
}
export async function removeDocument(sql: SqlConnection, id: string) {
  if (id === "setting/workspace")
    await sql.query("DELETE FROM jocki.workspace_settings");
  const entry = (
    await sql.query<{
      table_name: string | null;
      record_id: string;
      collection: string | null;
    }>(
      "SELECT table_name, record_id::VARCHAR AS record_id, collection FROM jocki.document_index WHERE id=?",
      [id],
    )
  )[0];
  if (
    entry?.table_name &&
    (await catalog(sql)).some((table) => table.table_name === entry.table_name)
  )
    await sql.query(
      `DELETE FROM item_data.${quote(entry.table_name)} WHERE _record_id=?::UUID`,
      [entry.record_id],
    );
  if (id.startsWith("file/"))
    await sql.query("DELETE FROM jocki.file_versions WHERE id=?::UUID", [
      id.slice(5),
    ]);
  await sql.query("DELETE FROM jocki.document_index WHERE id=?", [id]);
  if (entry && ["tables", "item_schemas"].includes(entry.collection ?? ""))
    await refreshViews(sql);
}
