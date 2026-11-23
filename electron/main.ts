import {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  dialog,
  Menu,
  Tray,
  nativeImage,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerVaultFiles } from "./vaults";
import { registerTimers, prepareTimerSounds } from "./timers";

const here = path.dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "jocki",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      allowServiceWorkers: true,
      corsEnabled: true,
    },
  },
]);
let window: BrowserWindow | null = null,
  tray: Tray | undefined,
  quitting = false,
  quitPending = false,
  releaseFiles: (() => Promise<void>) | undefined;
const requests = new Map<string, (allow: boolean) => void>();
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
const trusted = (event: IpcMainInvokeEvent) => {
  if (
    event.sender !== window?.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw Error("Only the main Jocki window can access native services");
  const url = new URL(event.senderFrame.url),
    dev = process.env.VITE_DEV_SERVER_URL;
  if (
    !(url.protocol === "jocki:" && url.host === "app") &&
    (!dev || url.origin !== new URL(dev).origin)
  )
    throw Error("Untrusted native caller");
};
function requestClose() {
  if (!window || window.isDestroyed()) return Promise.resolve(true);
  window.show();
  return new Promise<boolean>((resolve) => {
    const id = crypto.randomUUID(),
      timer = setTimeout(() => {
        requests.delete(id);
        resolve(false);
      }, 30000);
    requests.set(id, (allow) => {
      clearTimeout(timer);
      requests.delete(id);
      resolve(allow);
    });
    window!.webContents.send("vaults:will-close", id);
  });
}
app
  .whenReady()
  .then(async () => {
    releaseFiles = await registerVaultFiles(trusted, () => window);
    ipcMain.handle(
      "vaults:close-response",
      (event, id: string, allow: boolean) => {
        trusted(event);
        requests.get(id)?.(allow === true);
      },
    );
    protocol.handle("jocki", async (request) => {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      const root = path.resolve(here, "../dist"),
        asset = decodeURIComponent(url.pathname);
      const filename = path.resolve(
        root,
        asset === "/"
          ? "index.html"
          : asset === "/office-engine/cool.html"
            ? "office-editor.html"
            : asset.slice(1),
      );
      if (!filename.startsWith(root + path.sep))
        return new Response("Invalid path", { status: 400 });
      try {
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".wasm": "application/wasm",
          ".svg": "image/svg+xml",
          ".json": "application/json",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        return new Response(new Uint8Array(await readFile(filename)), {
          headers: {
            "Content-Type":
              types[path.extname(filename)] ?? "application/octet-stream",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return new Response("Asset not installed", { status: 404 });
      }
    });
    window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 760,
      minHeight: 600,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(here, "preload.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler((details) => {
      if (details.url === "about:blank")
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              preload: undefined,
            },
          },
        };
      if (/^(https?:|mailto:)/i.test(details.url))
        void shell.openExternal(details.url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, target) => {
      const current = new URL(window!.webContents.getURL()),
        next = new URL(target);
      if (current.origin !== next.origin) {
        event.preventDefault();
        if (/^(https?:|mailto:)/i.test(target)) void shell.openExternal(target);
      }
    });
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.webContents.on("will-prevent-unload", (event) => {
      if (quitting) event.preventDefault();
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window?.hide();
      }
    });
    const timerAssets = await prepareTimerSounds(
      path.join(
        here,
        process.env.VITE_DEV_SERVER_URL ? "../public" : "../dist",
      ),
    );
    registerTimers(
      () => window,
      () => tray,
      timerAssets,
      trusted,
    );
    await window.loadURL(process.env.VITE_DEV_SERVER_URL ?? "jocki://app/");
    tray = new Tray(
      nativeImage
        .createFromPath(path.join(here, "../dist/jocki_icon.png"))
        .resize({ width: 18, height: 18 }),
    );
    tray.setToolTip("Jocki");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Jocki", click: () => window?.show() },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  })
  .catch((error) => {
    console.error("Jocki startup failed", error);
    dialog.showErrorBox(
      "Jocki could not start",
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  });
app.on("activate", () => window?.show());
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-prevent-unload", (event) => {
    if (quitting) event.preventDefault();
  });
});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  void requestClose()
    .then(async (allow) => {
      if (!allow) return;
      quitting = true;
      await releaseFiles?.();
      app.quit();
    })
    .catch((error) => {
      console.error("Workspace shutdown failed", error);
    })
    .finally(() => {
      quitPending = false;
    });
});
