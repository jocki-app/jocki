import { expect, it } from "vitest";
import { DeviceCore } from "./fixtures/device";
import { MemoryStorage } from "../packages/storage";
import { documentsService } from "../packages/core/documents-service";
import { pluginSettings } from "../packages/core/plugin-settings";
import {
  exportWorkspace,
  importWorkspace,
} from "../packages/core/workspace-package";
import { Bundle } from "@automerge/automerge-repo-bundles";
import * as A from "@automerge/automerge";

it("indexes individual records under their plugin/schema and schema documents", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Computer"),
    node = await core.createWorkspace("Hierarchy");
  const schema = await node.records.ensureSchema();
  const task = await node.records.put("tasks", { title: "First" });
  const other = await node.records.put("tasks", { title: "Second" });
  await node.records.put("time", {
    title: "Timer",
    started_at: new Date().toISOString(),
    kind: "work",
  });
  const root = node.replica.handle.doc()!;
  expect(root).not.toHaveProperty("documents");
  const schemaDoc = await core.repository.repo.find<any>(
    root.schemas[schema.id],
  );
  expect(schemaDoc.doc().plugins.tasks).toBeDefined();
  expect(schemaDoc.doc().plugins.time).toBeDefined();
  expect(schemaDoc.doc().plugins.tasks).not.toBe(schemaDoc.doc().plugins.time);
  const index = await core.repository.repo.find<any>(
    schemaDoc.doc().plugins.tasks,
  );
  expect(index.doc().items["record/" + task.id]).not.toBe(
    index.doc().items["record/" + other.id],
  );
  const taskHandle = node.replica.graph.item("record/" + task.id)!;
  const before = {
    root: node.replica.handle.heads(),
    schema: schemaDoc.heads(),
    index: index.heads(),
    task: taskHandle.heads(),
    other: node.replica.heads("record/" + other.id),
  };
  await node.records.put("tasks", { ...task.data, title: "Edited" }, task.id);
  expect(node.replica.handle.heads()).toEqual(before.root);
  expect(schemaDoc.heads()).toEqual(before.schema);
  expect(index.heads()).toEqual(before.index);
  expect(taskHandle.heads()).not.toEqual(before.task);
  expect(node.replica.heads("record/" + other.id)).toEqual(before.other);
  const nextSchema = await node.records.ensureSchema(
    crypto.randomUUID(),
    "Other schema",
    false,
  );
  const table = await node.records.ensureTable("tasks", nextSchema.id);
  const third = await node.records.put("tasks", {
    title: "Third",
    table_id: table.id,
  });
  expect(node.replica.graph.item("record/" + third.id)?.doc()?.schemaId).toBe(
    nextSchema.id,
  );
  expect(node.replica.graph.plugin(schema.id, "tasks")?.url).not.toBe(
    node.replica.graph.plugin(nextSchema.id, "tasks")?.url,
  );
});

it("lets each plugin define independent item kinds and contents", async () => {
  const core = await DeviceCore.open(new MemoryStorage(), "Computer"),
    node = await core.createWorkspace("Plugin items");
  const schema = node.replica.graph.defaultSchemaId;
  const tasks = documentsService(node, "tasks"),
    time = documentsService(node, "time");
  const task = await tasks.open(schema, "task", "one", {
    title: "Example",
    notes: [],
  });
  const page = await tasks.open(schema, "page", "two", { text: "Text" });
  const timer = await time.open(schema, "timer", "one", { elapsed: 0 });
  expect(task.documentId).not.toBe(page.documentId);
  expect(task.documentId).not.toBe(timer.documentId);
  expect((await tasks.index(schema)).doc()?.schemaId).toBe(schema);
  expect(await tasks.list(schema)).toHaveLength(2);
  expect(await tasks.list(schema, "page")).toHaveLength(1);
  const listed = (await tasks.list(schema, "task"))[0];
  expect(
    (await tasks.repo.find<{ title: string }>(listed.url)).doc()?.title,
  ).toBe("Example");
  await expect(
    tasks.open(crypto.randomUUID(), "task", "bad", {}),
  ).rejects.toThrow("schema");
});

it("inherits group grants for existing and newly created children while keeping computer settings private", async () => {
  const a = await DeviceCore.open(new MemoryStorage(), "A"),
    b = await DeviceCore.open(new MemoryStorage(), "B");
  const left = await a.createWorkspace("Settings"),
    initial = await left.records.put("variables", { name: "Before grant" });
  const right = await b.join(await a.approve(left.link.id, b.pairingRequest()));
  await expect
    .poll(() => right.records.get(initial.id)?.data.name, { timeout: 12000 })
    .toBe("Before grant");
  const created = await right.records.put("variables", {
    name: "Created by B",
  });
  await expect
    .poll(() => left.records.get(created.id)?.data.name, { timeout: 12000 })
    .toBe("Created by B");
  const first = pluginSettings(left.replica, "tasks"),
    second = pluginSettings(right.replica, "tasks");
  await first.set("view", { mode: "board" });
  await first.computer.set("view", { mode: "list" });
  await second.computer.set("view", { mode: "calendar" });
  await expect
    .poll(() => second.get("view"), { timeout: 12000 })
    .toEqual({ mode: "board" });
  expect(await first.computer.get("view")).toEqual({ mode: "list" });
  expect(await second.computer.get("view")).toEqual({ mode: "calendar" });
  expect(
    await a.repository.hive.bestAccessForDoc(
      a.repository.hive.active.individual.id,
      right.replica.computerSettings.handle.url,
    ),
  ).toBeUndefined();
  expect(
    await b.repository.hive.bestAccessForDoc(
      b.repository.hive.active.individual.id,
      left.replica.computerSettings.handle.url,
    ),
  ).toBeUndefined();
  const bundle = Bundle.decode(await exportWorkspace(left));
  const formats = [...bundle.docs.values()].map(
    (entry) => A.load<any>(entry.data).format,
  );
  expect(formats).not.toContain("jocki-computer-settings");
  expect(formats).toContain("jocki-shared-settings");
  expect(formats).toContain("jocki-schema");
  expect(formats).toContain("jocki-plugin-schema");
  const imported = await importWorkspace(a, await exportWorkspace(left));
  expect(
    imported.replica.computerSettings.get("plugin.tasks.view"),
  ).toBeUndefined();
  expect(await pluginSettings(imported.replica, "tasks").get("view")).toEqual({
    mode: "board",
  });
  await a.revoke(left.link.id, b.identity.id);
  await expect
    .poll(
      () =>
        b.repository.hive.bestAccessForDoc(
          b.repository.hive.active.individual.id,
          right.replica.handle.url,
        ),
      { timeout: 12000 },
    )
    .toBeUndefined();
  for (const handle of left.replica.graph.sharedHandles())
    expect(
      (
        await a.repository.hive.bestAccessForDoc(
          b.repository.hive.active.individual.id,
          handle.url,
        )
      )?.isReader,
      String(handle.doc()?.format) + " " + String(handle.doc()?.key),
    ).not.toBe(true);
  await expect(
    right.records.put("variables", { name: "Denied" }),
  ).rejects.toThrow();
});
