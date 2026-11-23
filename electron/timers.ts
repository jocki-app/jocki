import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import {
  app,
  ipcMain,
  Menu,
  Notification,
  shell,
  type BrowserWindow,
  type Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  timerElapsed,
  timerSeconds,
  primaryTimer,
  validateTimer,
} from "@jocki/platform/core/timers";
import type {
  SubmittedTimer,
  TimerPresentation,
} from "@jocki/platform/plugin-sdk/timers";
/** afplay needs real files, so extract bundled ASAR assets into a private temp directory. */
export async function prepareTimerSounds(assetRoot: string) {
  const root = await mkdtemp(
    path.join(app.getPath("temp"), "jocki-tones-"),
  );
  try {
    await mkdir(path.join(root, "timer-tones"));
    await Promise.all(
      ["chime", "bell", "gentle"].map(async (tone) =>
        writeFile(
          path.join(root, "timer-tones", tone + ".wav"),
          await readFile(path.join(assetRoot, "timer-tones", tone + ".wav")),
        ),
      ),
    );
    app.on("will-quit", () => {
      void rm(root, { recursive: true, force: true });
    });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export function registerTimers(
  window: () => BrowserWindow | null,
  tray: () => Tray | undefined,
  assetRoot: string,
  authorize: (event: IpcMainInvokeEvent) => void,
) {
  let timers: SubmittedTimer[] = [];
  const announced = new Set<string>(),
    muted = new Set<string>(),
    lastSound = new Map<string, number>();
  const playing = new Map<string, ChildProcess>();
  const key = (t: SubmittedTimer) =>
    t.pluginId + ":" + t.id + ":" + t.startedAt;
  const verify = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window()?.webContents)
      throw Error("Untrusted timer sender");
    authorize(event);
  };
  const dismiss = (t: SubmittedTimer) => {
    muted.add(key(t));
    playing.get(key(t))?.kill();
    window()?.webContents.send("timers:dismiss", {
      id: t.id,
      pluginId: t.pluginId,
    });
    refresh();
  };
  const show = (t?: SubmittedTimer) => {
    window()?.show();
    window()?.focus();
    if (t) window()?.webContents.send("timers:open", { pluginId: t.pluginId });
  };
  const due = (t: SubmittedTimer) =>
    !!t.completedAt ||
    (!t.pausedAt &&
      t.durationMs !== undefined &&
      timerElapsed(t) >= t.durationMs);
  function refresh() {
    const visible = timers.filter((t) => !muted.has(key(t))),
      primary = primaryTimer(visible);
    const clock = (t: SubmittedTimer) => {
      const seconds = timerSeconds(t);
      return `${Math.floor(seconds / 3600)
        .toString()
        .padStart(
          2,
          "0",
        )}:${Math.floor(seconds / 60) % 60 < 10 ? "0" : ""}${Math.floor(seconds / 60) % 60}:${String(seconds % 60).padStart(2, "0")}`;
    };
    if (process.platform === "darwin")
      tray()?.setTitle(
        primary
          ? `${due(primary) ? "◉" : primary.pausedAt ? "Ⅱ" : ""}${clock(primary)}`
          : "",
      );
    tray()?.setToolTip(
      visible.length
        ? visible
            .map((t) => `${t.title}: ${due(t) ? "Finished" : clock(t)}`)
            .join("\n")
        : "Jocki",
    );
    tray()?.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Jocki", click: () => show() },
        ...visible.map((t) => ({
          label: `${t.title} — ${due(t) ? "Finished" : clock(t)}`,
          submenu: [
            { label: "Open timer", click: () => show(t) },
            ...(due(t)
              ? [{ label: "Stop alert", click: () => dismiss(t) }]
              : []),
          ],
        })),
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    for (const t of visible) {
      if (!due(t)) continue;
      const id = key(t);
      if (!announced.has(id)) {
        announced.add(id);
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: "Timer finished",
            body: t.title,
            silent: true,
          });
          notification.on("click", () => show(t));
          notification.show();
        }
      }
      if (
        !t.alert ||
        t.alert.tone === "none" ||
        (t.alert.repeat === "once" && lastSound.has(id)) ||
        Date.now() - (lastSound.get(id) ?? 0) < 2000
      )
        continue;
      lastSound.set(id, Date.now());
      if (process.platform === "darwin") {
        const player = spawn(
          "/usr/bin/afplay",
          [path.join(assetRoot, "timer-tones", t.alert.tone + ".wav")],
          { stdio: "ignore" },
        );
        playing.set(id, player);
        player.on("error", () => shell.beep());
        player.on("exit", (code) => {
          if (playing.get(id) === player) playing.delete(id);
          if (code && !muted.has(id)) shell.beep();
        });
      } else shell.beep();
    }
  }
  ipcMain.handle("timers:permission", (event) => {
    verify(event);
    return Notification.isSupported();
  });
  ipcMain.handle("timers:present", (event, value: TimerPresentation) => {
    verify(event);
    if (!value || !Array.isArray(value.timers) || value.timers.length > 32)
      throw Error("Invalid timers");
    for (const t of value.timers) {
      validateTimer(t);
      if (
        typeof t.pluginId !== "string" ||
        !/^[a-z][a-z0-9.-]*$/.test(t.pluginId) ||
        (t.completedAt !== undefined && !Number.isFinite(t.completedAt))
      )
        throw Error("Invalid timer owner");
    }
    timers = value.timers;
    const active = new Set(timers.map(key));
    for (const [id, player] of playing)
      if (!active.has(id)) {
        player.kill();
        playing.delete(id);
      }
    refresh();
  });
  const interval = setInterval(refresh, 1000);
  interval.unref();
  app.on("before-quit", () => {
    clearInterval(interval);
    for (const player of playing.values()) player.kill();
  });
}
