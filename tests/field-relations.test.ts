import { expect, it } from "vitest";
import { DeviceCore } from "./fixtures/device";
import { MemoryStorage } from "../packages/storage";
import {
  field,
  fieldTypes,
  fieldTemplate,
} from "@jocki/platform/field-types";
import { getSchema } from "@jocki/platform/core/catalog";
import { collectionColumns } from "@jocki/platform/core/collection-tables";

it("uses parent UID references across collections, rejecting cycles, ambiguous UIDs and unavailable items", async () => {
  const device = await DeviceCore.open(new MemoryStorage(), "References");
  const node = await device.createWorkspace("Universal parents");
  const parent = field("parent", "Parent", "text", {
    ...fieldTypes.parent.definition,
    storage: "custom",
  });
  const table = await node.records.put(
    "tables",
    {
      name: "Links",
      collection_id: "tasks",
      columns: [
        ...collectionColumns(getSchema("tasks")).filter((f) => f.required),
        parent,
      ],
    },
    undefined,
    { managedBy: "tasks" },
  );
  const event = await node.records.put("calendar", {
    uid: "external-calendar-uid",
    dtstart: "2026-10-05",
  });
  const first = await node.records.put("tasks", {
    table_id: table.id,
    uid: "parent-task",
    custom_fields: { parent: event.data.uid },
  });
  const child = await node.records.put("tasks", {
    table_id: table.id,
    uid: "child-task",
    custom_fields: { parent: first.data.uid },
  });
  expect(child.data.custom_fields).toMatchObject({ parent: "parent-task" });
  await expect(
    node.records.put(
      "tasks",
      { ...first.data, custom_fields: { parent: child.data.uid } },
      first.id,
    ),
  ).rejects.toThrow("cycle");
  await expect(
    node.records.put(
      "tasks",
      { ...first.data, custom_fields: { parent: first.data.uid } },
      first.id,
    ),
  ).rejects.toThrow("cycle");
  await expect(
    node.records.put("tasks", {
      table_id: table.id,
      custom_fields: { parent: "missing" },
    }),
  ).rejects.toThrow("available item");
  await node.records.put("tasks", { uid: "parent-task" });
  await expect(
    node.records.put("tasks", {
      table_id: table.id,
      custom_fields: { parent: "parent-task" },
    }),
  ).rejects.toThrow("unique identifier");
  await node.records.delete(event.id);
  // A dangling parent stays visible; deleting a parent must not prevent unrelated edits.
  await expect(
    node.records.put(
      "tasks",
      { ...first.data, title: "Still editable" },
      first.id,
    ),
  ).resolves.toBeTruthy();
  await device.close();
});

it("supports parent relationships in arbitrary user tables, scoped to the chosen table", async () => {
  const device = await DeviceCore.open(new MemoryStorage(), "Tables");
  const node = await device.createWorkspace("Hierarchy");
  const table = await node.records.put("tables", {
    name: "Hierarchy",
    columns: [],
  });
  await node.records.put(
    "tables",
    {
      ...table.data,
      columns: [
        field("parent", "Parent", "text", {
          ...fieldTypes.parent.definition,
          reference: "table_rows",
          referenceTable: table.id,
        }),
      ],
    },
    table.id,
  );
  const root = await node.records.put("table_rows", {
    table_id: table.id,
    values: {},
  });
  const child = await node.records.put("table_rows", {
    table_id: table.id,
    values: { parent: root.id },
  });
  await expect(
    node.records.put(
      "table_rows",
      { table_id: table.id, values: { parent: child.id } },
      root.id,
    ),
  ).rejects.toThrow("cycle");
  const outside = await node.records.put("tasks", { title: "Outside" });
  await expect(
    node.records.put("table_rows", {
      table_id: table.id,
      values: { parent: outside.id },
    }),
  ).rejects.toThrow("available item");
  await device.close();
});

it("templates have no name-based behavior; feature mappings can use arbitrary compatible columns", async () => {
  const device = await DeviceCore.open(new MemoryStorage(), "Mappings");
  const node = await device.createWorkspace("Templates");
  const table = await node.records.put(
    "tables",
    {
      name: "Custom",
      collection_id: "tasks",
      columns: [
        ...collectionColumns(getSchema("tasks")).filter((f) => f.required),
        fieldTemplate(field("title", "Unrelated text")),
        fieldTemplate(field("caption", "Caption")),
      ],
      bindings: { title: "caption" },
    },
    undefined,
    { managedBy: "tasks" },
  );
  const task = await node.records.put("tasks", {
    table_id: table.id,
    custom_fields: { title: "Not the task title", caption: "Mapped title" },
  });
  expect(task.data.title).toBe("Mapped title");
  expect((task.data.custom_fields as any).title).toBe("Not the task title");
  const apiEdit = await node.records.put(
    "tasks",
    { ...task.data, title: "Plugin API edit" },
    task.id,
  );
  expect(apiEdit.data.custom_fields).toMatchObject({
    caption: "Plugin API edit",
    title: "Not the task title",
  });
  const createdViaAPI = await node.records.put("tasks", {
    table_id: table.id,
    title: "Programmatic creation",
  });
  expect(createdViaAPI.data.custom_fields).toMatchObject({
    caption: "Programmatic creation",
  });
  await expect(
    node.records.put(
      "tables",
      { ...table.data, bindings: { priority: "caption" } },
      table.id,
    ),
  ).rejects.toThrow("compatible column");
  await device.close();
});

it("rebinds existing rows through core and retains unmapped custom values", async () => {
  const device = await DeviceCore.open(new MemoryStorage(), "Rebinding");
  const node = await device.createWorkspace("Features");
  const table = await node.records.put(
    "tables",
    {
      name: "Tasks",
      collection_id: "tasks",
      columns: [
        ...collectionColumns(getSchema("tasks")).filter((f) => f.required),
        field("caption", "Caption", "text", { storage: "custom" }),
      ],
    },
    undefined,
    { managedBy: "tasks" },
  );
  const task = await node.records.put("tasks", {
    table_id: table.id,
    custom_fields: { caption: "Use this title" },
  });
  expect(task.data.title).toBeNull();
  await node.records.put(
    "tables",
    { ...table.data, bindings: { title: "caption" } },
    table.id,
  );
  expect(node.records.get(task.id)?.data.title).toBe("Use this title");
  expect(node.records.get(task.id)?.revision).toBeGreaterThan(task.revision);
  await device.close();
});

it("lets plugin API writes satisfy required mapped columns", async () => {
  const device = await DeviceCore.open(new MemoryStorage(), "Required mapping");
  const node = await device.createWorkspace("Required fields");
  const table = await node.records.put(
    "tables",
    {
      name: "Tasks",
      collection_id: "tasks",
      columns: [
        ...collectionColumns(getSchema("tasks")).filter((f) => f.required),
        field("caption", "Caption", "text", {
          storage: "custom",
          required: true,
          nullable: false,
        }),
      ],
      bindings: { title: "caption" },
    },
    undefined,
    { managedBy: "tasks" },
  );
  const task = await node.records.put("tasks", {
    table_id: table.id,
    title: "Required title",
  });
  expect(task.data.custom_fields).toMatchObject({ caption: "Required title" });
  await expect(
    node.records.put("tasks", { table_id: table.id }),
  ).rejects.toThrow();
  await device.close();
});
