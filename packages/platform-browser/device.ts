import { acquireWriter } from "./writer-lock";
import { DeviceCore } from "../core/device";
import { BrowserStorage } from "./storage";
import { openBrowserRepository } from "./repository";
let running: Promise<DeviceCore> | undefined;
let storage: BrowserStorage;
export function browserDevice() {
  return (running ??= (async () => {
    const release = await acquireWriter();
    const repository = await openBrowserRepository().catch((error) => {
      release();
      throw error;
    });
    try {
      storage = new BrowserStorage("jocki-device-local");
      const core = await DeviceCore.open(
        storage,
        "Web browser",
        () => [],
        repository,
        { commandHost: !window.jockiNative?.repository },
      );
      if (window.jockiNative?.repository)
        for (const link of await window.jockiNative.repository.profiles())
          await core.rememberWorkspace(link);
      await storage.releaseDeviceCatalog();
      const wake = () => core.wakeAutomaticSync();
      window.addEventListener("online", wake);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") wake();
      });
      void navigator.storage?.persist?.();
      return core;
    } catch (error) {
      await repository.close();
      release();
      running = undefined;
      throw error;
    }
  })());
}
export async function activateWorkspace(_id: string) {
  await browserDevice();
  await storage.releaseDeviceCatalog();
}
