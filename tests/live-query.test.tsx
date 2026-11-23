// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CacheDatabase, type Table } from "../packages/data-duckdb/cache";
import { useLiveQuery } from "../packages/data-duckdb/react";
import { shareQueryResult } from "../packages/data-duckdb/query-result";
import { setDatabaseWorkingStorage } from "../packages/platform-node/duckdb";

class Records extends CacheDatabase {
  declare rows: Table<
    { id: string; collection: string; data: { value: number; note?: string } },
    string
  >;
  constructor() {
    super("query-test-" + crypto.randomUUID(), {
      rows: { key: "id", volatile: true },
    });
  }
}
let db: Records, root: Root, host: HTMLDivElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  await db?.close();
  vi.restoreAllMocks();
  setDatabaseWorkingStorage("disk");
});
function database() {
  setDatabaseWorkingStorage("memory");
  return (db = new Records());
}
function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
}
it("copies only the requested collection and keeps filtering isolated from stored rows", async () => {
  const db = database();
  await db.rows.bulkPut(
    Array.from({ length: 10000 }, (_, i) => ({
      id: String(i),
      collection: i < 100 ? "track" : "tasks",
      data: { value: i, note: "x".repeat(2048) },
    })),
  );
  const copy = vi.spyOn(globalThis, "structuredClone");
  const rows = await db.rows
    .where("collection")
    .equals("track")
    .filter((row) => {
      row.data.note = "edited preview";
      return row.data.value >= 50;
    })
    .toArray();
  expect(rows).toHaveLength(50);
  expect(copy).toHaveBeenCalledTimes(100);
  expect((await db.rows.get("50"))?.data.note).toBe("x".repeat(2048));
});
it("shares unchanged JSON branches without retaining changed or removed fields", () => {
  const previous = [
    { id: "a", data: { value: 1 } },
    { id: "b", data: { value: 2, removed: true } },
  ];
  expect(shareQueryResult(previous, structuredClone(previous))).toBe(previous);
  const next = shareQueryResult(previous, [
    { id: "a", data: { value: 1 } },
    { id: "b", data: { value: 3 } },
  ]);
  expect(next).not.toBe(previous);
  expect(next[0]).toBe(previous[0]);
  expect(next[1]).toEqual({ id: "b", data: { value: 3 } });
  const date = new Date();
  expect(shareQueryResult(new Date(date), date)).toBe(date);
  const proto = JSON.parse('{"__proto__":{"polluted":true}}');
  expect(Object.getPrototypeOf(shareQueryResult({}, proto))).toBe(
    Object.prototype,
  );
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});
it("bounds overlapping live reads and publishes the newest data after a storage burst", async () => {
  const db = database();
  mount();
  let release!: () => void,
    value = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: Array<number | undefined> = [];
  const query = vi.fn(async () => {
    const captured = value;
    if (query.mock.calls.length === 1) await gate;
    return captured;
  });
  function Screen() {
    const value = useLiveQuery(query);
    useEffect(() => {
      observed.push(value);
    }, [value]);
    return <span>{value ?? "Loading"}</span>;
  }
  await act(async () => root.render(<Screen />));
  await act(async () => {
    for (let i = 1; i <= 100; i++) {
      value = i;
      await db.rows.put({ id: "one", collection: "track", data: { value: i } });
    }
  });
  expect(query).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
    await gate;
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe("100");
  expect(observed.at(-1)).toBe(100);
});
it("shows a completed snapshot while more updates and a follow-up read are still pending", async () => {
  const db = database();
  mount();
  let first!: () => void,
    second!: () => void,
    calls = 0;
  const a = new Promise<void>((resolve) => {
    first = resolve;
  });
  const b = new Promise<void>((resolve) => {
    second = resolve;
  });
  async function query() {
    const call = ++calls;
    await (call === 1 ? a : b);
    return call;
  }
  function Screen() {
    const value = useLiveQuery(query);
    return <span>{value ?? "Loading"}</span>;
  }
  await act(async () => root.render(<Screen />));
  await act(async () => {
    await db.rows.put({ id: "one", collection: "track", data: { value: 1 } });
    first();
    await a;
  });
  expect(host.textContent).toBe("1");
  expect(calls).toBe(2);
  await act(async () => {
    second();
    await b;
  });
  expect(host.textContent).toBe("2");
});
it("does not publish a new snapshot for an unrelated write and clears old data when the source changes", async () => {
  const db = database();
  mount();
  const snapshots: unknown[] = [];
  let release!: (value: { id: string }) => void;
  const pending = new Promise<{ id: string }>((resolve) => {
    release = resolve;
  });
  function Screen({ id }: { id: string }) {
    const result = useLiveQuery(() => (id === "a" ? { id } : pending), [id]);
    useEffect(() => {
      snapshots.push(result);
    }, [result]);
    return <span>{result?.id ?? "Loading"}</span>;
  }
  await act(async () => root.render(<Screen id="a" />));
  const count = snapshots.length;
  await act(async () => {
    await db.rows.put({ id: "other", collection: "tasks", data: { value: 1 } });
  });
  expect(snapshots).toHaveLength(count);
  await act(async () => root.render(<Screen id="b" />));
  expect(host.textContent).toBe("Loading");
  await act(async () => {
    release({ id: "b" });
    await pending;
  });
  expect(host.textContent).toBe("b");
});
