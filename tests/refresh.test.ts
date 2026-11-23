import { expect, it, vi } from "vitest";
import { coalescedRefresh } from "../packages/data-duckdb/refresh";

it("collapses a large sync burst and reads the latest state once more after in-flight changes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: number[] = [];
  let version = 0;
  const failed = vi.fn();
  const refresh = coalescedRefresh(async () => {
    observed.push(version);
    if (observed.length === 1) await gate;
  }, failed);
  for (let i = 0; i < 2000; i++) {
    version++;
    refresh();
  }
  await Promise.resolve();
  expect(observed).toEqual([2000]);
  for (let i = 0; i < 2000; i++) {
    version++;
    refresh();
  }
  expect(observed).toEqual([2000]);
  release();
  await refresh.idle();
  expect(observed).toEqual([2000, 4000]);
  expect(failed).not.toHaveBeenCalled();
});

it("reports a failed read, can retry, and cancels queued work when its view closes", async () => {
  const error = Error("Read failed"),
    failed = vi.fn();
  const work = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(undefined);
  const refresh = coalescedRefresh(work, failed);
  refresh();
  await refresh.idle();
  expect(failed).toHaveBeenCalledExactlyOnceWith(error);
  refresh();
  await refresh.idle();
  expect(work).toHaveBeenCalledTimes(2);
  refresh();
  refresh.stop();
  await refresh.idle();
  refresh();
  expect(work).toHaveBeenCalledTimes(2);
});

it("does not rerun or publish a late failure after a view unmounts", async () => {
  let reject!: (error: Error) => void;
  const failed = vi.fn(),
    work = vi.fn(
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    );
  const refresh = coalescedRefresh(work, failed);
  refresh();
  await Promise.resolve();
  refresh();
  refresh.stop();
  reject(Error("Owner closed"));
  await refresh.idle();
  expect(work).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});
