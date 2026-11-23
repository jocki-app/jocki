import { expect, it } from "vitest";
import {
  field,
  decodeField,
  fieldVisibilityOptions,
  fieldTypes,
  fieldTypeId,
} from "@jocki/platform/field-types";
import {
  tableFields,
  validateTableValues,
} from "@jocki/platform/core/dynamic-fields";
import { collectionColumns } from "@jocki/platform/core/collection-tables";
import { getSchema } from "@jocki/platform/core/catalog";
it("stores Markdown as exact single text values and rejects selection/list descriptors", () => {
  const markdown =
    "# Heading\n\n**Bold** and [link](https://example.com)\n- [ ] Task\n";
  const column = field("notes", "Notes", "text", {
    ...fieldTypes.markdown.definition,
    default: markdown,
  });
  expect(fieldTypeId(column)).toBe("markdown");
  expect(tableFields([column])).toEqual([column]);
  expect(decodeField(column, markdown)).toBe(markdown);
  expect(validateTableValues([column], {})).toEqual({ notes: markdown });
  for (const patch of [
    { array: true, inputMode: "list" },
    { inputMode: "select", options: [markdown] },
    { array: true, inputMode: "multiselect", options: [markdown] },
    { pgType: "jsonb" },
  ])
    expect(() => tableFields([{ ...column, ...patch }])).toThrow(
      "one text value",
    );
});
it("keeps scalar type separate from input count and selection options", () => {
  const column = field("scores", "Scores", "integer", {
    array: true,
    inputMode: "multiselect",
    options: [1, 2, 3],
    minItems: 1,
    maxItems: 2,
    default: [1],
    visibility: "editable",
  });
  expect(tableFields([column])).toEqual([column]);
  expect(decodeField(column, [1, 3])).toEqual([1, 3]);
  expect(() => decodeField(column, [1, 1])).toThrow("once");
  expect(() => decodeField(column, [1, 2, 3])).toThrow("too many");
  expect(() => decodeField(column, [])).toThrow("too few");
  expect(() => decodeField(column, ["1"])).toThrow();
  expect(() => decodeField(column, [9])).toThrow("declared option");
  expect(() => tableFields([{ ...column, array: false }])).toThrow(
    "Input count",
  );
});
it("retains values after removing a user column and validates them when it returns", () => {
  const original = { title: "Keep me", count: 3 };
  const hidden = validateTableValues(
    [field("count", "Count", "integer")],
    original,
  );
  expect(hidden).toEqual(original);
  expect(
    validateTableValues(
      [field("title", "Title"), field("count", "Count", "integer")],
      hidden,
    ),
  ).toEqual(original);
  expect(() =>
    validateTableValues([field("title", "Title", "integer")], hidden),
  ).toThrow();
});
it("allows independent template copies but preserves required standard contracts", () => {
  const schema = getSchema("tasks"),
    required = collectionColumns(schema).filter((f) => f.required);
  expect(collectionColumns(schema, required).map((f) => f.id)).toEqual(
    expect.arrayContaining(["uid", "dtstamp"]),
  );
  const template = field("title", "My score", "integer", {
    storage: "custom",
    inputMode: "single",
    default: 3,
  });
  expect(
    collectionColumns(schema, [...required, template]).at(-1)?.pgType,
  ).toBe("integer");
  expect(() =>
    collectionColumns(
      schema,
      required.map((f) =>
        f.id === "uid" ? { ...f, storage: "custom", pgType: "integer" } : f,
      ),
    ),
  ).toThrow();
  expect(tableFields([])).toEqual([]);
});
it("maps explicitly bound columns for plugin interoperability", async () => {
  const { DeviceCore } = await import("./fixtures/device");
  const { MemoryStorage } = await import("../packages/storage");
  const device = await DeviceCore.open(new MemoryStorage(), "Templates");
  const node = await device.createWorkspace("Fields"),
    schema = getSchema("tasks");
  const columns = [
    ...collectionColumns(schema).filter((f) => f.required),
    field("title", "Title", "text", { storage: "custom" }),
    field("status", "Status", "text", {
      storage: "custom",
      inputMode: "select",
      options: ["open", "done"],
    }),
  ];
  const table = await node.records.put(
    "tables",
    {
      name: "Tasks",
      collection_id: "tasks",
      is_default: false,
      columns,
      bindings: { title: "title", status: "status" },
    },
    undefined,
    { managedBy: "tasks" },
  );
  const task = await node.records.put("tasks", {
    table_id: table.id,
    custom_fields: { title: "Portable title", status: "open" },
  });
  expect(task.data.title).toBe("Portable title");
  const completed = await node.records.put(
    "tasks",
    { ...task.data, status: "done" },
    task.id,
  );
  expect(completed.data.custom_fields).toMatchObject({ status: "done" });
  const renamed = await node.records.put(
    "tasks",
    {
      ...completed.data,
      custom_fields: { title: "New title", status: "done" },
    },
    task.id,
  );
  expect(renamed.data.title).toBe("New title");
  await device.close();
});

it("lets required generated columns hide without weakening their contracts", () => {
  const schema = getSchema("tasks");
  const required = collectionColumns(schema).filter((f) => f.required);
  const hidden = required.map((f) => ({ ...f, visibility: "hidden" as const }));
  expect(
    collectionColumns(schema, hidden).every((f) => f.visibility === "hidden"),
  ).toBe(true);
  for (const f of required)
    expect(fieldVisibilityOptions(f)).toEqual(["viewable", "hidden"]);
  expect(() =>
    collectionColumns(
      schema,
      hidden.map((f) => ({ ...f, generated: undefined })),
    ),
  ).toThrow();
  expect(
    fieldVisibilityOptions(field("title", "Title", "text", { required: true })),
  ).toEqual(["editable"]);
  expect(
    fieldVisibilityOptions(
      field("title", "Title", "text", { required: true, default: "Untitled" }),
    ),
  ).toContain("hidden");
  expect(fieldVisibilityOptions(field("notes", "Notes"))).toEqual([
    "editable",
    "viewable",
    "hidden",
    "addable",
  ]);
});

it("validates structured JSON options and defaults with the same typed selection contract", () => {
  const column = field("objects", "Objects", "jsonb", {
    array: true,
    inputMode: "multiselect",
    options: [{ nested: [1, true] }, ["array", 2]],
    default: [{ nested: [1, true] }],
  });
  expect(tableFields([column])).toEqual([column]);
  expect(decodeField(column, [["array", 2]])).toEqual([["array", 2]]);
  expect(() => decodeField(column, [{ unknown: true }])).toThrow(
    "declared option",
  );
  expect(() =>
    tableFields([{ ...column, default: [{ unknown: true }] }]),
  ).toThrow();
  for (const invalid of [
    null,
    { value: Infinity },
    JSON.parse('{"constructor":1}'),
  ])
    expect(() =>
      field("bad", "Bad", "jsonb", { options: [invalid] }),
    ).toThrow();
  let deep: any = true;
  for (let i = 0; i < 42; i++) deep = [deep];
  expect(() => field("bad", "Bad", "jsonb", { options: [deep] })).toThrow();
});
