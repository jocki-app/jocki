import { expect, it, vi } from "vitest";
import {
  TimerCoordinator,
  primaryTimer,
  timerSeconds,
} from "@jocki/platform/core/timers";
import type { SubmittedTimer } from "@jocki/platform/plugin-sdk/timers";
import { finishLocalTimeTimers } from "../packages/app-ui/timer-completion";
const sample = {
  id: "timer",
  title: "Focus",
  startedAt: 1000,
  durationMs: 5000,
  priority: 100,
  alert: { tone: "chime" as const, repeat: "indefinite" as const },
};
it("persists submissions before acknowledging or publishing, and rolls back failures", async () => {
  let resolve!: () => void;
  const slow = new Promise<void>((yes) => {
    resolve = yes;
  });
  const save = vi.fn(() => slow),
    coordinator = new TimerCoordinator({ load: async () => [], save });
  await coordinator.initialize();
  const changed = vi.fn();
  coordinator.subscribe(changed);
  const pending = coordinator.forPlugin("time").submit(sample);
  await new Promise((yes) => setTimeout(yes, 0));
  expect(coordinator.list()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
  resolve();
  await pending;
  expect(coordinator.list()).toHaveLength(1);
  expect(changed).toHaveBeenCalledOnce();
  save.mockRejectedValueOnce(new Error("Disk full"));
  await expect(coordinator.forPlugin("time").remove("timer")).rejects.toThrow(
    "Disk full",
  );
  expect(coordinator.list()).toHaveLength(1);
});
it("restores local timers, scopes plugins, pauses and completes without executing commands", async () => {
  let stored: SubmittedTimer[] = [];
  const coordinator = new TimerCoordinator({
    load: async () => stored,
    save: async (t) => {
      stored = t;
    },
  });
  await coordinator.forPlugin("time").submit(sample);
  await coordinator
    .forPlugin("track")
    .submit({ id: "elapsed", title: "Track", startedAt: 0, priority: 10 });
  expect(primaryTimer(coordinator.list())?.pluginId).toBe("time");
  expect(coordinator.forPlugin("track").list()).toHaveLength(1);
  await coordinator.forPlugin("track").remove("timer");
  expect(coordinator.list()).toHaveLength(2);
  await coordinator.tick(6000);
  expect(coordinator.forPlugin("time").list()[0].completedAt).toBe(6000);
  const restored = new TimerCoordinator({
    load: async () => stored,
    save: async () => {},
  });
  await restored.initialize();
  expect(restored.list()).toHaveLength(2);
  expect(
    timerSeconds({ ...sample, pausedAt: 3000, pausedMs: 1000 }, 99000),
  ).toBe(4);
  await coordinator.forPlugin("time").dismiss("timer");
  expect(primaryTimer(coordinator.list())?.pluginId).toBe("track");
});
it("rejects invalid timestamps, tones and priorities without changing storage", async () => {
  const save = vi.fn(async () => {}),
    c = new TimerCoordinator({ load: async () => [], save });
  for (const patch of [
    { startedAt: NaN },
    { durationMs: -1 },
    { priority: Infinity },
    { alert: { tone: "file:///secret", repeat: "indefinite" } },
  ])
    await expect(
      c.forPlugin("time").submit({ ...sample, ...patch } as any),
    ).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
});
it("only completes a locally submitted matching Time record and awaits its durable write", async () => {
  const put = vi.fn(async () => {}),
    row = {
      id: "timer",
      collection: "time",
      data: { started_at: new Date(1000).toISOString(), target_seconds: 5 },
    };
  const runtime = {
    timers: {
      list: () => [{ ...sample, pluginId: "time", completedAt: 6000 }],
    },
    registry: { enabled: () => true },
    node: { records: { canWrite: () => true } },
    collection: () => ({ list: async () => [row], put }),
  } as any;
  await finishLocalTimeTimers(runtime);
  expect(put).toHaveBeenCalledWith(
    { ...row.data, ended_at: new Date(6000).toISOString(), paused_at: null },
    "timer",
  );
  put.mockClear();
  runtime.timers.list = () => [];
  await finishLocalTimeTimers(runtime);
  expect(put).not.toHaveBeenCalled();
  runtime.timers.list = () => [
    { ...sample, startedAt: 2000, pluginId: "time", completedAt: 6000 },
  ];
  await finishLocalTimeTimers(runtime);
  expect(put).not.toHaveBeenCalled();
});
it("isolates failing plugin observers after a durable timer write", async () => {
  const save = vi.fn(async () => {}),
    coordinator = new TimerCoordinator({ load: async () => [], save });
  await coordinator.initialize();
  const failed = vi.fn(() => {
      throw Error("Plugin failure");
    }),
    healthy = vi.fn();
  coordinator.subscribe(failed);
  coordinator.subscribe(healthy);
  await expect(
    coordinator.forPlugin("time").submit(sample),
  ).resolves.toBeUndefined();
  expect(save).toHaveBeenCalledOnce();
  expect(healthy).toHaveBeenCalledOnce();
  await coordinator
    .forPlugin("track")
    .submit({ id: "track", title: "Track", startedAt: 1000 });
  expect(failed).toHaveBeenCalledOnce();
  expect(healthy).toHaveBeenCalledTimes(2);
});
