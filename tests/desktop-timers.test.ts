import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  quit: [] as Function[],
  spawn: vi.fn(),
  beep: vi.fn(),
  notification: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    on: (name: string, callback: Function) => {
      if (name === "before-quit") mocks.quit.push(callback);
    },
    quit: vi.fn(),
  },
  ipcMain: {
    handle: (name: string, callback: Function) =>
      mocks.handlers.set(name, callback),
  },
  Menu: { buildFromTemplate: (template: any) => template },
  shell: { beep: mocks.beep },
  Notification: class {
    static isSupported() {
      return true;
    }
    constructor(value: any) {
      mocks.notification(value);
    }
    on() {}
    show() {}
  },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { registerTimers } from "../electron/timers";
afterEach(() => {
  for (const dispose of mocks.quit.splice(0)) dispose();
  mocks.handlers.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("shows both native timers, prioritizes Time, repeats alarms and dismisses from the tray", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const killed = vi.fn();
  mocks.spawn.mockReturnValue({ on: vi.fn(), kill: killed });
  const send = vi.fn(),
    webContents = { send },
    window = { webContents, show: vi.fn(), focus: vi.fn() },
    tray = { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn() };
  registerTimers(
    () => window as any,
    () => tray as any,
    "/assets",
    vi.fn(),
  );
  const track = {
    id: "track",
    pluginId: "track",
    title: "Track",
    startedAt: 90000,
    priority: 10,
  };
  const time = {
    id: "time",
    pluginId: "time",
    title: "Time",
    startedAt: 100000,
    durationMs: 1000,
    priority: 100,
    alert: { tone: "bell", repeat: "indefinite" },
  };
  const present = mocks.handlers.get("timers:present")!;
  present({ sender: webContents }, { timers: [track, time] });
  if (process.platform === "darwin")
    expect(tray.setTitle).toHaveBeenLastCalledWith("00:00:01");
  expect(tray.setToolTip).toHaveBeenLastCalledWith(
    expect.stringContaining("Track:"),
  );
  expect(tray.setToolTip).toHaveBeenLastCalledWith(
    expect.stringContaining("Time:"),
  );
  vi.advanceTimersByTime(3000);
  expect(mocks.notification).toHaveBeenCalledOnce();
  expect(
    process.platform === "darwin" ? mocks.spawn : mocks.beep,
  ).toHaveBeenCalledTimes(2);
  const menu = tray.setContextMenu.mock.calls.at(-1)![0];
  menu
    .find((item: any) => item.label?.startsWith("Time —"))
    .submenu.find((item: any) => item.label === "Stop alert")
    .click();
  expect(send).toHaveBeenCalledWith("timers:dismiss", {
    id: "time",
    pluginId: "time",
  });
  if (process.platform === "darwin") {
    expect(killed).toHaveBeenCalled();
    expect(tray.setTitle).toHaveBeenLastCalledWith("00:00:13");
  }
  vi.advanceTimersByTime(4000);
  expect(
    process.platform === "darwin" ? mocks.spawn : mocks.beep,
  ).toHaveBeenCalledTimes(2);
  expect(() => present({ sender: {} }, { timers: [] })).toThrow("Untrusted");
  expect(() =>
    present({ sender: webContents }, { timers: [{ ...time, startedAt: NaN }] }),
  ).toThrow();
});
