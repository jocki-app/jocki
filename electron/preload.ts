import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("jockiVaults", {
  fileInventory: true,
  rootCompanions: true,
  positionedFiles: true,
  workspace: () => ipcRenderer.invoke("vaults:workspace"),
  roots: () => ipcRenderer.invoke("vaults:roots"),
  select: () => ipcRenderer.invoke("vaults:select"),
  selectWorkspace: (create: boolean) =>
    ipcRenderer.invoke("vaults:select-workspace", create),
  files: (
    token: string,
    operation: string,
    path?: string,
    bytes?: Uint8Array,
  ) => ipcRenderer.invoke("vaults:files", token, operation, path, bytes),
  renames: (before: unknown, after: unknown) =>
    ipcRenderer.invoke("vaults:renames", before, after),
  release: (token: string) => ipcRenderer.invoke("vaults:release", token),
  onFilesChanged: (listener: (token: string, changes?: unknown) => void) => {
    const receive = (_event: unknown, token: string, changes?: unknown) =>
      listener(token, changes);
    ipcRenderer.on("vaults:changed", receive);
    return () => ipcRenderer.removeListener("vaults:changed", receive);
  },
  onWillClose: (listener: () => Promise<boolean>) => {
    const receive = (_event: unknown, id: string) => {
      void Promise.resolve(listener())
        .then((allow) => ipcRenderer.invoke("vaults:close-response", id, allow))
        .catch(() => ipcRenderer.invoke("vaults:close-response", id, false));
    };
    ipcRenderer.on("vaults:will-close", receive);
    return () => ipcRenderer.removeListener("vaults:will-close", receive);
  },
});
contextBridge.exposeInMainWorld("jockiNative", {
  timers: {
    present: (value: unknown) => ipcRenderer.invoke("timers:present", value),
    requestPermission: () => ipcRenderer.invoke("timers:permission"),
    subscribe: (
      listener: (timer: { pluginId: string; id: string }) => void,
    ) => {
      const receive = (
        _event: unknown,
        timer: { pluginId: string; id: string },
      ) => listener(timer);
      ipcRenderer.on("timers:dismiss", receive);
      return () => {
        ipcRenderer.removeListener("timers:dismiss", receive);
      };
    },
  },
});

ipcRenderer.on("timers:open", (_event, timer: { pluginId: string }) => {
  if (/^[a-z][a-z0-9.-]*$/.test(timer.pluginId)) location.hash = timer.pluginId;
});
