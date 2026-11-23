import {
  CSDBDatabase,
  parseDocument,
  serializeDocument,
  resolveType,
  type QueryPlan,
} from "@csvdatabase/csdb/portable";
import type { ContentType } from "./contracts";
import { canonical } from "../crypto";

export {
  parseDocument as parseCSDB,
  serializeDocument as serializeCSDB,
  CSDBDatabase,
};
export type {
  CSDBDocument,
  Row,
  RowValue,
  TableSchema,
  ColumnType,
  QueryPlan,
} from "@csvdatabase/csdb/portable";
/** The official CSDB in-memory command API; FileVault owns durable Save. */
export class CSDBDraft extends CSDBDatabase {
  constructor(value: string) {
    super(parseDocument(value));
  }
}
export const taskTable = "public.tasks";
export interface CSDBRowSelection {
  /** Header saves may also persist this file's portable view metadata. */
  metadata?: boolean;
  table: string;
  ids: string[];
}
/** Exact, stable comparison of SDK values, including bigint cells. */
export function csdbComparable(value: unknown): string {
  return canonical(
    JSON.parse(
      JSON.stringify(value ?? null, (_key, item) =>
        typeof item === "bigint" ? { "$csdb.bigint": item.toString() } : item,
      ),
    ),
  );
}
/** Apply selected row edits through CSDB commands, leaving other draft rows private. */
export function selectedCSDBRows(
  original: string,
  working: string,
  selection: CSDBRowSelection,
) {
  const db = new CSDBDraft(original),
    source = parseDocument(working);
  const before = db.document.tables.get(selection.table),
    after = source.tables.get(selection.table);
  if (
    !before ||
    !after ||
    csdbComparable(before.schema) !== csdbComparable(after.schema) ||
    csdbComparable([...db.document.schemas]) !==
      csdbComparable([...source.schemas]) ||
    csdbComparable(db.document.metadata) !== csdbComparable(source.metadata)
  )
    throw Error("Save column and table changes before saving individual tasks");
  if (before.schema.primary_key?.columns.join() !== "id")
    throw Error("Saving individual tasks requires ID as the primary key");
  const plans: QueryPlan[] = [];
  const previousRows = new Map(before.rows.map((row) => [row.id, row])),
    nextRows = new Map(after.rows.map((row) => [row.id, row]));
  for (const id of new Set(selection.ids)) {
    const prior = previousRows.get(id),
      next = nextRows.get(id);
    if (!prior && !next) throw Error("A selected task is no longer available");
    if (csdbComparable(prior ?? null) === csdbComparable(next ?? null))
      continue;
    const where: import("@csvdatabase/csdb/portable").Expr = {
      type: "comparison",
      op: "=",
      left: { type: "identifier", name: "id" },
      right: { type: "literal", value: id },
    };
    if (!next) plans.push({ kind: "delete", table: selection.table, where });
    else if (!prior)
      plans.push({ kind: "insert", table: selection.table, rows: [next] });
    else
      plans.push({ kind: "update", table: selection.table, set: next, where });
  }
  if (plans.length) db.batch(plans);
  return db.toString();
}
export const taskStatuses = ["open", "in-progress", "done", "cancelled"];
export function newCSDB(type?: ContentType) {
  const db = CSDBDatabase.create(type?.id ?? "Data");
  db.createSchema("public");
  for (const [name, contract] of Object.entries(
    type?.tables ?? { data: { required: { id: "text", value: "text" } } },
  )) {
    const [namespace, local] = name.includes(".")
      ? name.split(".")
      : ["public", name];
    if (!db.document.schemas.has(namespace)) db.createSchema(namespace);
    const tasks = type?.id === "jocki.task-list";

    db.createTable({
      schema: namespace,
      name: local,
      columns: contract.required,
      required: Object.keys(contract.required),
      primary_key: { columns: ["id"] },
      defaults: {},
      comments: tasks
        ? {
            "jocki.generated": {
              id: "uuid",
              uid: "uuid",
              dtstamp: "timestamp",
            },
          }
        : {},
    });
  }
  return db.toString();
}
export function validateCSDBType(value: string, type?: ContentType) {
  const doc = parseDocument(value);
  if (type?.id === "jocki.task-list" && doc.tables.size !== 1)
    throw Error("A task list must contain exactly one tasks table.");
  if (type?.id === "jocki.task-list") {
    const table = doc.tables.get(taskTable);
    if (table)
      for (const [column, kind] of [
        ["title", "text"],
        ["status", "enum"],
      ]) {
        if (!table.schema.columns[column]) continue;
        const resolved = resolveType(
          table.schema.columns[column],
          table.types,
          table.schema.schema,
        ) as Exclude<import("@csvdatabase/csdb/portable").ColumnType, string>;
        if (resolved.type !== kind)
          throw Error(`Task ${column} must use native ${kind}.`);
        if (
          column === "status" &&
          !["open", "done"].every((option) =>
            resolved.options?.includes(option),
          )
        )
          throw Error("Task status must allow open and done.");
      }
  }
  for (const [name, contract] of Object.entries(type?.tables ?? {})) {
    const table = doc.tables.get(name);
    if (!table) throw Error(`Content type requires table ${name}`);
    for (const [field, expected] of Object.entries(contract.required)) {
      const actual = table.schema.columns[field];
      if (!actual)
        throw Error(
          `${type!.name} requires the column ${name}.${field} (${expected}). Keep “No content type” to edit this table as it is.`,
        );
      const resolved = resolveType(actual, table.types, table.schema.schema);
      const kind = typeof resolved === "string" ? resolved : resolved.type;
      if (kind !== expected)
        throw Error(`${name}.${field} must have type ${expected}`);
      if (!table.schema.required.includes(field))
        throw Error(`${name}.${field} must be required`);
    }
    if (
      type?.id === "jocki.task-list" &&
      (table.schema.primary_key?.columns.length !== 1 ||
        table.schema.primary_key.columns[0] !== "id")
    )
      throw Error("Task ID must be the primary key.");
  }
  return doc;
}
