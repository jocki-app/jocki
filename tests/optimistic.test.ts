import { expect, it, vi } from "vitest";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { field, type RecordSchema } from "@jocki/platform/field-types";
import { OptimisticRecords } from "../packages/ui/optimistic";
const schema: RecordSchema = {
  id: "items",
  pluginId: "example",
  version: 1,
  name: "Items",
  fields: [field("name", "Name"), field("custom_fields", "Custom", "jsonb")],
};
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const saved = new Map<string, ResourceRecord>();
  const record = (
    id: string,
    data: ResourceRecord["data"],
  ): ResourceRecord => ({
    id,
    data,
    collection: "items",
    workspaceId: "workspace",
    ownerId: "owner",
    pluginId: "example",
    revision: 1,
    createdAt: "2026-10-06",
    updatedAt: "2026-10-06",
    deletedAt: null,
  });
  saved.set(
    "one",
    record("one", { name: "Saved", custom_fields: { a: 1, b: 1 } }),
  );
  const gates: ReturnType<typeof deferred>[] = [],
    errors = vi.fn();
  const source = {
    list: vi.fn(async () => [...saved.values()]),
    get: async (id: string) => saved.get(id),
    put: vi.fn(async (data: ResourceRecord["data"], id = "new") => {
      const gate = gates.shift();
      if (gate) await gate.promise;
      const next = record(id, data);
      saved.set(id, next);
      return next;
    }),
    delete: vi.fn(async (id: string) => {
      const gate = gates.shift();
      if (gate) await gate.promise;
      saved.delete(id);
    }),
  };
  const pending = new OptimisticRecords({
    workspaceId: "workspace",
    ownerId: "owner",
    saved: (id) => saved.get(id),
    error: errors,
    track: (work) => work(),
  });
  return {
    saved,
    gates,
    source,
    errors,
    pending,
    store: pending.wrap(schema, source, "plugin"),
    record,
  };
}
it("shows creates, edits and deletes before persistence without acknowledging or changing durable data", async () => {
  const { saved, gates, store, pending } = fixture();
  await store.list();
  const gate = deferred();
  gates.push(gate);
  let acknowledged = false;
  const writing = store.put({ name: "Preview" }, "new").then(() => {
    acknowledged = true;
  });
  expect(pending.count("new")).toBe(1);
  expect((await store.list()).find((row) => row.id === "new")?.data.name).toBe(
    "Preview",
  );
  expect(saved.has("new")).toBe(false);
  expect(acknowledged).toBe(false);
  gate.resolve();
  await writing;
  expect(saved.get("new")?.data.name).toBe("Preview");
  expect(pending.count("new")).toBe(0);
  await store.list();
  const deletion = deferred();
  gates.push(deletion);
  const deleting = store.delete("new");
  expect((await store.list()).some((row) => row.id === "new")).toBe(false);
  expect(saved.has("new")).toBe(true);
  deletion.reject(Error("Permission changed"));
  await expect(deleting).rejects.toThrow("Permission changed");
  expect((await store.list()).find((row) => row.id === "new")?.data.name).toBe(
    "Preview",
  );
});
it("serializes same-row edits and rebases a later edit after an earlier failure, including custom columns", async () => {
  const { saved, gates, store, pending, source, errors } = fixture();
  await store.list();
  const first = deferred(),
    second = deferred();
  gates.push(first, second);
  const writing = store.put(
    { name: "Rejected", custom_fields: { a: 2, b: 1 } },
    "one",
  );
  const prior = (await store.list())[0];
  const later = store.put(
    { ...prior.data, custom_fields: { a: 2, b: 3 } },
    "one",
  );
  expect(pending.count("one")).toBe(2);
  await vi.waitFor(() => expect(source.put).toHaveBeenCalledTimes(1));
  first.reject(Error("Invalid first edit"));
  await expect(writing).rejects.toThrow("Invalid first edit");
  expect(pending.count("one")).toBe(1);
  expect((await store.list())[0].data).toEqual({
    name: "Saved",
    custom_fields: { a: 1, b: 3 },
  });
  second.resolve();
  await later;
  expect(saved.get("one")?.data).toEqual({
    name: "Saved",
    custom_fields: { a: 1, b: 3 },
  });
  expect(errors).toHaveBeenCalledTimes(1);
});
it("applies filters, sorting and limits to previews, and isolates workspaces and access scopes", async () => {
  const first = fixture(),
    other = fixture();
  await first.store.list();
  const gate = deferred();
  first.gates.push(gate);
  const writing = first.store.put({ name: "AAA" }, "new");
  const query = {
    sorts: [{ field: "name", direction: "asc" as const, enabled: true }],
    limit: 1,
  };
  expect((await first.store.list(query))[0].id).toBe("new");
  expect((await other.store.list())[0].id).toBe("one");
  // A new facade with no authorized cached list must still check its source.
  const denied = first.pending.wrap(
    schema,
    {
      ...first.source,
      list: async () => {
        throw Error("Disabled");
      },
    },
    "denied",
  );
  await expect(denied.list()).rejects.toThrow("Disabled");
  const missing = first.pending.wrap(
    schema,
    { ...first.source, get: async () => undefined },
    "missing",
  );
  expect(await missing.get("one")).toBeUndefined();
  gate.resolve();
  await writing;
});
it("does not wait for a blocked durable list to show a pending update from an already authorized view", async () => {
  const { store, source, gates, pending } = fixture();
  await store.list();
  const gate = deferred();
  gates.push(gate);
  source.list.mockImplementationOnce(() => new Promise(() => {}));
  const writing = store.put({ name: "Immediate" }, "one");
  expect((await store.list())[0].data.name).toBe("Immediate");
  expect(pending.count("one")).toBe(1);
  gate.resolve();
  await writing;
});

it("keeps content saves pending and preserves their new metadata when a queued edit finishes", async () => {
  const { saved, store, pending } = fixture();
  await store.list();
  const gate = deferred();
  const content = pending.whileSaving("one", async () => {
    await gate.promise;
    saved.set("one", {
      ...saved.get("one")!,
      data: { ...saved.get("one")!.data, version_id: "new-version" },
    });
  });
  const rename = store.put(
    { ...saved.get("one")!.data, name: "Renamed" },
    "one",
  );
  expect(pending.count("one")).toBe(2);
  expect(saved.get("one")!.data.name).toBe("Saved");
  gate.resolve();
  await content;
  await rename;
  expect(saved.get("one")!.data).toMatchObject({
    name: "Renamed",
    version_id: "new-version",
  });
  expect(pending.count("one")).toBe(0);
});
