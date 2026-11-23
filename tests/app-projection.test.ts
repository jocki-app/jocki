// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { AppRuntime } from "../packages/app-ui/runtime";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let rows = [{ id: "one", deletedAt: null }];
  const records = {
    toCollection: () => ({ primaryKeys: async () => [] }),
    bulkDelete: vi.fn(async () => {}),
    bulkPut: vi.fn(async (_rows: typeof rows) => {}),
  };
  const searchDocuments = { bulkDelete: vi.fn(async () => {}) };
  const fileVersions = {
    toArray: vi.fn(async () => [] as { id: string; fileId: string }[]),
    bulkDelete: vi.fn(async (_ids: string[]) => {}),
    put: vi.fn(async (_version: unknown) => {}),
    get: vi.fn(),
  };
  const files = {
    manifests: vi.fn(() => [] as { id: string; fileId: string }[]),
    retainedVersion: vi.fn((_id: string) => true),
    readAvailable: vi.fn(async (_id: string) => ({
      bytes: new Uint8Array([1]),
    })),
  };
  const replica = {
    member: { access: "write" },
    listeners: new Set<(id: string) => void>(),
    ids: () => rows.map((row) => "record/" + row.id),
    read: (id: string) => rows.find((row) => "record/" + row.id === id),
    heads: (id: string) => [
      JSON.stringify(rows.find((row) => "record/" + row.id === id)),
    ],
    graph: {
      target: (id: string) => rows.find((row) => "record/" + row.id === id),
      source: (id: string) =>
        rows.some((row) => "record/" + row.id === id) ? id : undefined,
    },
  };
  const runtime: AppRuntime = Object.assign(
    Object.create(AppRuntime.prototype),
    {
      projectionQueue: Promise.resolve(),
      closed: false,
      node: {
        replica,
        records: {
          all: () => rows,
          get: (id: string) => rows.find((row) => row.id === id),
        },
        protocol: { files },
      },
      db: {
        setMetadata: vi.fn(async () => {}),
        records,
        searchDocuments,
        fileVersions,
        transaction: async (
          _mode: string,
          _records: unknown,
          _search: unknown,
          work: (tx: unknown) => Promise<void>,
        ) => work({ records, searchDocuments }),
      },
      notifySurfaces: vi.fn(),
    },
  );
  return {
    runtime,
    records,
    fileVersions,
    files,
    searchDocuments,
    setRows: (next: typeof rows) => {
      const changed = new Set(
        [...rows, ...next].map((row) => "record/" + row.id),
      );
      rows = next;
      for (const key of changed)
        for (const listener of replica.listeners) listener(key);
    },
  };
}

it("combines queued refreshes while including changes that arrive during a running projection", async () => {
  const { runtime, records, setRows } = fixture();
  const started = deferred(),
    finish = deferred();
  records.bulkPut.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
  });
  const first = runtime.project();
  const samePass = runtime.project();
  await started.promise;
  expect(records.bulkPut).toHaveBeenCalledTimes(1);
  setRows([{ id: "two", deletedAt: null }]);
  let completed = false;
  const nextPass = runtime.project().then(() => {
    completed = true;
  });
  const alsoNextPass = runtime.project();
  await Promise.resolve();
  expect(completed).toBe(false);
  finish.resolve();
  await Promise.all([first, samePass, nextPass, alsoNextPass]);
  expect(records.bulkPut).toHaveBeenCalledTimes(2);
  expect(records.bulkPut).toHaveBeenLastCalledWith([
    { id: "two", deletedAt: null },
  ]);
});

it("reports projection failures to waiting callers and allows a later retry", async () => {
  const { runtime, records } = fixture();
  records.bulkPut.mockRejectedValueOnce(Error("Cache write failed"));
  const results = await Promise.allSettled([
    runtime.project(),
    runtime.project(),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(records.bulkPut).toHaveBeenCalledTimes(1);
  await runtime.project();
  expect(records.bulkPut).toHaveBeenCalledTimes(2);
});

it("reuses the attachment cache inventory while loading missing files and removing released copies", async () => {
  const { runtime, fileVersions, files, searchDocuments } = fixture();
  fileVersions.toArray.mockResolvedValue([
    { id: "cached", fileId: "existing-file" },
    { id: "released", fileId: "old-file" },
  ]);
  files.manifests.mockReturnValue([
    { id: "cached", fileId: "existing-file" },
    { id: "released", fileId: "old-file" },
    { id: "missing", fileId: "new-file" },
  ]);
  files.retainedVersion.mockImplementation((id) => id !== "released");
  await runtime.project();
  expect(fileVersions.get).not.toHaveBeenCalled();
  expect(files.readAvailable).toHaveBeenCalledExactlyOnceWith("missing");
  expect(fileVersions.put).toHaveBeenCalledWith(
    expect.objectContaining({ id: "missing", fileId: "new-file" }),
  );
  expect(fileVersions.bulkDelete).toHaveBeenCalledWith(["released"]);
  expect(searchDocuments.bulkDelete).toHaveBeenCalledWith(["old-file"]);
});

it("does not recopy every unchanged record for a transfer status update", async () => {
  const { runtime, records, setRows } = fixture();
  await runtime.project();
  await runtime.project();
  expect(records.bulkPut).toHaveBeenCalledTimes(1);
  setRows([
    { id: "one", deletedAt: null },
    { id: "two", deletedAt: null },
  ]);
  await runtime.project();
  expect(records.bulkPut).toHaveBeenLastCalledWith([
    { id: "two", deletedAt: null },
  ]);
});
