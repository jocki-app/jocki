import { readFileSync } from "node:fs";
import { evaluateDefaults } from "@csvdatabase/csdb/portable";
import {
  applyCSDBFormBuffer,
  type CSDBFormBuffer,
} from "../packages/app-ui/vault-csdb-form-model";
import { csdbComparable } from "../packages/core/vaults/csdb";
import { describe, it, expect } from "vitest";
import { CSDBDatabase } from "@csvdatabase/csdb/portable";
import { CSDBDraft, selectedCSDBRows } from "../packages/core/vaults/csdb";
import {
  defaultCSDBImportSettings,
  instantiateCSDBTemplate,
  mergeCSDBImport,
  validateCSDBImportSettings,
} from "../packages/core/vaults/csdb-import";
import {
  csdbFields,
  csdbTableDefinition,
  csdbReferences,
  taskColumnTemplates,
} from "../packages/app-ui/vault-csdb-fields";
import { pickerAccepts } from "../packages/app-ui/file-picker";
function db(name = "tasks") {
  const db = CSDBDatabase.create(name);
  db.createSchema("public");
  db.createTable({
    schema: "public",
    name,
    columns: {
      id: "text",
      title: "text",
      parent_id: "text",
      status: { type: "enum", options: ["open", "done"] },
      tags: "text[]",
    },
    required: ["id"],
    primary_key: { columns: ["id"] },
    defaults: { status: "open", tags: [] },
    visibility: {
      id: "hidden",
      title: "editable",
      status: "viewable",
      tags: "addable",
    },
    foreign_keys: [
      {
        name: "parent",
        columns: ["parent_id"],
        references: { table: `public.${name}`, columns: ["id"] },
        label_field: "title",
      },
    ],
  });
  return db;
}
describe("native CSDB forms and imports", () => {
  it("uses schema visibility, enums, arrays, defaults and real self references", () => {
    const source = db();
    source.table("public.tasks").insert({ id: "a", title: "Label" });
    const table = source.document.tables.get("public.tasks")!,
      fields = csdbFields(table);
    expect(fields.find((f) => f.id === "status")).toMatchObject({
      options: ["open", "done"],
      default: "open",
      visibility: "viewable",
    });
    expect(fields.find((f) => f.id === "tags")).toMatchObject({
      array: true,
      inputMode: "list",
      visibility: "addable",
      default: [],
    });
    expect(fields.find((f) => f.id === "parent_id")).toMatchObject({
      reference: "public.tasks",
      referenceField: "id",
      referenceLabelField: "title",
      relationship: "parent",
    });
    expect(csdbReferences(source.document)["public.tasks"][0]).toMatchObject({
      label: "Label",
      values: { title: "Label" },
    });
    table.schema.foreign_keys[0].relationship = "ancestor";
    const next = csdbTableDefinition(table, fields);
    expect(next.foreign_keys?.[0].label_field).toBe("title");
    expect(next.foreign_keys?.[0].relationship).toBe("ancestor");
    expect(next.visibility).toEqual(table.schema.visibility);
    expect(
      (next.comments?.["jocki.fields"] as any).parent_id.reference,
    ).toBeUndefined();
  });
  it("adds the task parent template as a native foreign key and preserves arbitrary visibility", () => {
    const source = db(),
      table = source.document.tables.get("public.tasks")!;
    table.schema.foreign_keys = [];
    table.schema.visibility.title = "external rule";
    const fields = csdbFields(table).filter((f) => f.id !== "parent_id");
    fields.push(taskColumnTemplates.find((f) => f.id === "parent_id")!);
    const schema = csdbTableDefinition(table, fields);
    expect(schema.visibility?.title).toBe("external rule");
    expect(schema.foreign_keys?.[0]).toMatchObject({
      columns: ["parent_id"],
      references: { table: "public.tasks", columns: ["id"] },
      label_field: "title",
    });
    source.alterTable(schema);
  });
  it("matches a single source table, stages changed rows, and leaves the source intact", () => {
    const target = db(),
      source = db("imported"),
      profile = defaultCSDBImportSettings().profiles[0];
    source.table("public.imported").insert([
      { id: "child", parent_id: "parent" },
      { id: "parent", title: "Parent", tags: ["a"] },
    ]);
    const original = source.toString();
    const result = mergeCSDBImport(
      target.toString(),
      [source.toString()],
      profile,
    );
    expect(result.rows).toEqual([
      { table: "public.tasks", index: 0 },
      { table: "public.tasks", index: 1 },
    ]);
    expect(new CSDBDraft(result.text).document.tables.size).toBe(1);
    expect(source.toString()).toBe(original);
    expect(target.table("public.tasks").all()).toEqual([]);
    const saved = selectedCSDBRows(target.toString(), result.text, {
      table: "public.tasks",
      ids: ["child", "parent"],
    });
    expect(new CSDBDraft(saved).table("public.tasks").all()).toHaveLength(2);
  });
  it("keeps multi-file imports atomic and validates persisted profiles", () => {
    const target = db(),
      first = db(),
      second = db(),
      profile = defaultCSDBImportSettings().profiles[0];
    first.table("public.tasks").insert({ id: "same" });
    second.table("public.tasks").insert({ id: "same" });
    const original = target.toString();
    expect(() =>
      mergeCSDBImport(original, [first.toString(), second.toString()], profile),
    ).toThrow(/conflict/);
    expect(target.toString()).toBe(original);
    const settings = defaultCSDBImportSettings();
    expect(validateCSDBImportSettings(settings)).toEqual(settings);
    expect(() =>
      validateCSDBImportSettings({ ...settings, default_profile: "missing" }),
    ).toThrow();
    expect(() =>
      validateCSDBImportSettings({
        ...settings,
        profiles: [...settings.profiles, ...settings.profiles],
      }),
    ).toThrow();
  });
  it("filters files and folders independently with case-insensitive extensions", () => {
    expect(
      pickerAccepts(
        { kind: "file", path: "Tasks.CSDB" },
        { extensions: ["csdb"] },
      ),
    ).toBe(true);
    expect(
      pickerAccepts(
        { kind: "file", path: "note.md" },
        { extensions: [".csdb"] },
      ),
    ).toBe(false);
    expect(
      pickerAccepts(
        { kind: "folder", path: "tasks" },
        { kind: "folder", extensions: [".csdb"] },
      ),
    ).toBe(true);
    expect(pickerAccepts({ kind: "folder", path: "tasks" }, {})).toBe(false);
  });
  it("edits a single unkeyed row and rejects stale or incomplete form buffers", () => {
    const source = CSDBDatabase.create("rows");
    source.createSchema("public");
    source.createTable({
      schema: "public",
      name: "rows",
      columns: { value: "text", payload: "json" },
    });
    source.table("public.rows").insert([{ value: "same" }, { value: "same" }]);
    const row = source.table("public.rows").all()[1];
    const buffer: CSDBFormBuffer = {
      key: "rows:1",
      table: "public.rows",
      index: 1,
      values: { value: "Changed", payload: { valid: true } },
      baseline: csdbComparable(row),
      pending: true,
      optional: [],
      inputs: {},
    };
    const result = applyCSDBFormBuffer(source.toString(), buffer);
    expect(
      CSDBDatabase.parse(result.text)
        .table("public.rows")
        .all()
        .map((row) => row.value),
    ).toEqual(["same", "Changed"]);
    expect(() => applyCSDBFormBuffer(result.text, buffer)).toThrow(/changed/);
    buffer.inputs.payload = { text: '{"unfinished":', pending: true };
    expect(() => applyCSDBFormBuffer(source.toString(), buffer)).toThrow(
      /Finish entering/,
    );
  });
  it("preserves exact bigint values in forms and selected row saves", () => {
    const source = db();
    source.alterTable({
      ...source.document.tables.get("public.tasks")!.schema,
      columns: {
        ...source.document.tables.get("public.tasks")!.schema.columns,
        count: "bigint",
      },
    });
    source.table("public.tasks").insert({ id: "a", count: 9007199254740993n });
    const row = source.table("public.tasks").first()!;
    const buffer: CSDBFormBuffer = {
      key: "tasks:0",
      table: "public.tasks",
      index: 0,
      values: {
        ...(Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "bigint" ? String(value) : value,
          ]),
        ) as any),
        title: "Changed",
      },
      baseline: csdbComparable(row),
      pending: true,
      optional: [],
      inputs: {},
    };
    const result = applyCSDBFormBuffer(source.toString(), buffer);
    const saved = selectedCSDBRows(source.toString(), result.text, {
      table: "public.tasks",
      ids: ["a"],
    });
    expect(CSDBDatabase.parse(saved).table("public.tasks").first()!.count).toBe(
      9007199254740993n,
    );
  });
});

describe("workout templates", () => {
  for (const day of [1, 2])
    it(`instantiates Day ${day} with fresh hidden dates through CSDB`, () => {
      const source = readFileSync(
        new URL(
          `../packages/app-ui/templates/Day ${day} - Full body.csdb`,
          import.meta.url,
        ),
        "utf8",
      );
      const original = new CSDBDraft(source).document.tables.get(
        "public.exercises",
      )!;
      expect(Object.keys(original.schema.columns)).toEqual([
        "name",
        "sets",
        "reps",
        "date",
      ]);
      expect(original.rows).toHaveLength(6);
      expect(
        original.rows.every((row) => row.sets === 3 && row.date === null),
      ).toBe(true);
      expect(original.schema.defaults.date).toBe("now()");
      const text = instantiateCSDBTemplate(source),
        table = new CSDBDraft(text).document.tables.get("public.exercises")!;
      expect(
        table.rows.every(
          (row) =>
            typeof row.date === "string" &&
            Number.isFinite(Date.parse(row.date)),
        ),
      ).toBe(true);
      expect(new Set(table.rows.map((row) => row.date)).size).toBe(1);
      expect(
        csdbFields(table).find((field) => field.id === "date")?.visibility,
      ).toBe("hidden");
      expect(instantiateCSDBTemplate(text)).toBe(text);
      expect(
        evaluateDefaults(table, new Date("2030-02-03T12:34:56Z")).date,
      ).toBe("2030-02-03T12:34:56+00:00");
      const profile = defaultCSDBImportSettings().profiles[0];
      const merged = mergeCSDBImport(source, [source], profile);
      const rows = new CSDBDraft(merged.text).document.tables.get(
        "public.exercises",
      )!.rows;
      expect(rows).toHaveLength(12);
      expect(rows.slice(0, 6).every((row) => row.date === null)).toBe(true);
      expect(rows.slice(6).every((row) => typeof row.date === "string")).toBe(
        true,
      );
      const definition = csdbTableDefinition(
        table,
        csdbFields(table).filter((field) => field.id !== "date"),
      );
      expect(definition.formats).toEqual({});
      expect(definition.defaults?.date).toBeUndefined();
    });
});
