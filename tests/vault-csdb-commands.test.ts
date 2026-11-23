import { expect, it } from "vitest";
import { field } from "@jocki/platform/field-types";
import {
  CSDBDraft,
  CSDBDatabase,
  newCSDB,
  parseCSDB,
  validateCSDBType,
} from "../packages/core/vaults/csdb";
import { contentTypes } from "../packages/core/vaults/content-types";
import {
  csdbFields,
  csdbTableDefinition,
  csdbFieldTypes,
  taskColumnTemplates,
} from "../packages/app-ui/vault-csdb-fields";
import {
  csdbState,
  csdbText,
  updateCSDB,
} from "../packages/core/vaults/csdb-model";
const tasks = () =>
  newCSDB(contentTypes.find((type) => type.id === "jocki.task-list"));
const required = { id: "a", uid: "ua", dtstamp: "2026-01-01T00:00:00Z" };
it("projects forward and cyclic foreign keys through official table commands", () => {
  const db = CSDBDatabase.create("related-data");
  db.createSchema("public");
  for (const name of ["first", "second"])
    db.createTable({
      schema: "public",
      name,
      columns: { id: "text", related: "text" },
      required: ["id"],
      primary_key: { columns: ["id"] },
    });
  for (const name of ["first", "second"])
    db.table(`public.${name}`).insert({ id: "a", related: "a" });
  for (const [name, target] of [
    ["first", "second"],
    ["second", "first"],
  ])
    db.alterTable({
      ...db.document.tables.get(`public.${name}`)!.schema,
      foreign_keys: [
        {
          name: "related",
          columns: ["related"],
          references: { table: `public.${target}`, columns: ["id"] },
        },
      ],
    });
  const restored = parseCSDB(csdbText(csdbState(db.toString())));
  expect(restored.tableOrder).toEqual(["public.first", "public.second"]);
  expect(
    restored.tables.get("public.first")!.schema.foreign_keys[0].references
      .table,
  ).toBe("public.second");
  expect(restored.tables.get("public.second")!.rows[0].related).toBe("a");
});
it("starts with exactly the old required task identity/time columns, without shared item tables", () => {
  const doc = validateCSDBType(tasks(), contentTypes[0]);
  expect(doc.tableOrder).toEqual(["public.tasks"]);
  expect(Object.keys(doc.tables.get("public.tasks")!.schema.columns)).toEqual([
    "id",
    "uid",
    "dtstamp",
  ]);
  expect(doc.tables.get("public.tasks")!.schema.required).toEqual([
    "id",
    "uid",
    "dtstamp",
  ]);
  expect(() =>
    validateCSDBType(
      tasks().replace("dtstamp: timestamp", "dtstamp: text"),
      contentTypes[0],
    ),
  ).toThrow("timestamp");
});
it("saves columns as native table definitions and rows through official commands", () => {
  const draft = new CSDBDraft(tasks()),
    table = draft.document.tables.get("public.tasks")!;
  draft.table(table.name).insert(required);
  const fields = [
    ...csdbFields(table),
    taskColumnTemplates.find((f) => f.id === "status")!,
    field("scores", "Scores", "integer", {
      array: true,
      inputMode: "multiselect",
      options: [1, 2],
      default: [1],
      minItems: 1,
      maxItems: 2,
    }),
  ];
  draft.alterTable(csdbTableDefinition(table, fields));
  const stored = draft.document.tables.get(table.name)!;
  expect(stored.rows[0]).toMatchObject({ status: "open", scores: [1] });
  expect(stored.schema.columns.scores).toMatchObject({
    type: "integer",
    inputMode: "array",
    options: [1, 2],
  });
  expect(
    (stored.schema.comments["jocki.fields"] as any).scores.pgType,
  ).toBeUndefined();
  const before = draft.toString();
  expect(() =>
    draft
      .table(table.name)
      .where({ id: "a" })
      .update({ scores: [3] }),
  ).toThrow();
  expect(draft.toString()).toBe(before);
  const state = csdbState(draft.toString()),
    reopened = parseCSDB(csdbText(state));
  expect(reopened.tables.get(table.name)!.rows[0].scores).toEqual([1]);
  const next = csdbState(draft.toString());
  updateCSDB(state, next);
  expect(csdbText(state)).toBe(csdbText(next));
  draft.alterTable(
    csdbTableDefinition(
      stored,
      fields.filter((f) => f.id !== "scores"),
    ),
  );
  expect(Object.hasOwn(draft.table(table.name).first()!, "scores")).toBe(false);
});
it("keeps named native types when only display metadata changes", () => {
  const draft = new CSDBDraft(tasks());
  draft.createType("public.priority", {
    type: "enum",
    options: ["low", "high"],
  });
  let table = draft.document.tables.get("public.tasks")!;
  draft.alterTable({
    ...table.schema,
    columns: {
      ...table.schema.columns,
      priority: "priority",
      priorities: "priority[]",
    },
  });
  table = draft.document.tables.get(table.name)!;
  const fields = csdbFields(table).map((f) => ({
    ...f,
    label: f.label + " label",
  }));
  draft.alterTable(csdbTableDefinition(table, fields));
  expect(draft.document.tables.get(table.name)!.schema.columns.priorities).toBe(
    "priority[]",
  );
  expect(csdbText(csdbState(draft.toString()))).toContain("--- schema:public");
  expect(Object.values(csdbFieldTypes).map((type) => type.label)).not.toContain(
    "uuid",
  );
});
