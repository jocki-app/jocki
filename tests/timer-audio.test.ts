// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("plays Once once, repeats Indefinite, and stops sounding when dismissed", async () => {
  vi.useFakeTimers();
  const oscillators: any[] = [];
  class Audio {
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {});
    createOscillator() {
      const oscillator = {
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
    }
  }
  vi.stubGlobal("AudioContext", Audio);
  const { prepareTimers, presentTimers } =
    await import("../packages/platform-browser/timers");
  await prepareTimers();
  const once = {
    id: "once",
    pluginId: "time",
    title: "Once",
    startedAt: 1,
    completedAt: 2,
    alert: { tone: "bell" as const, repeat: "once" as const },
  };
  await presentTimers({ timers: [once] }, () => {});
  await presentTimers({ timers: [once] }, () => {});
  vi.advanceTimersByTime(4000);
  expect(oscillators).toHaveLength(1);
  expect(oscillators[0].frequency.value).toBe(880);
  const repeat = {
    ...once,
    id: "repeat",
    alert: { tone: "chime" as const, repeat: "indefinite" as const },
  };
  await presentTimers({ timers: [repeat] }, () => {});
  vi.advanceTimersByTime(4000);
  expect(oscillators).toHaveLength(4);
  await presentTimers({ timers: [] }, () => {});
  expect(oscillators.at(-1).stop).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(4000);
  expect(oscillators).toHaveLength(4);
});
