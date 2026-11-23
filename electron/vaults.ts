import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { join as joinPath } from "node:path";
import { access } from "node:fs/promises";
import { NodeVaultFiles } from "../packages/platform-node/vault-files";
import { Libgit2RenameMatcher } from "../packages/platform-node/vault-renames";
import { VaultWatcher } from "../packages/platform-node/vault-watch";
import {
  documentId,
  type RenameCandidate,
  type VaultFileSystem,
} from "../packages/core/vaults/contracts";
import { utf8, text } from "../packages/core/crypto";

export async function registerVaultFiles(
  trusted: (event: IpcMainInvokeEvent) => void,
  window: () => BrowserWindow | null,
) {
  const local = await NodeVaultFiles.open(
    path.join(app.getPath("userData"), "file-workspaces"),
  );
  const saved = await local.read("capabilities.json");
  const state: {
    computer: string;
    roots: Record<string, { path: string; name: string; file?: string }>;
  } = saved
    ? JSON.parse(text.decode(saved))
    : { computer: crypto.randomUUID(), roots: {} };
  await local.writeAtomic(
    "capabilities.json",
    utf8.encode(JSON.stringify(state)),
  );
  const workspace = await NodeVaultFiles.open(
    path.join(local.root, "workspace"),
  );
  const roots = new Map<string, NodeVaultFiles>([["workspace", workspace]]);
  const leases = new Map<string, () => Promise<void>>();
  const writers = new Map<string, Promise<void>>();
  const watchers = new Map<string, VaultWatcher>();
  const writer = (token: string, fs: NodeVaultFiles) => {
    let pending = writers.get(token);
    if (!pending) {
      pending = fs
        .acquireWriter()
        .then(async (release) => {
          leases.set(token, release);
          if (token !== "workspace" && !state.roots[token]?.file)
            watchers.set(
              token,
              await VaultWatcher.open(fs.root, (changes) =>
                window()?.webContents.send("vaults:changed", token, changes),
              ),
            );
        })
        .catch(async (error) => {
          await leases.get(token)?.();
          leases.delete(token);
          writers.delete(token);
          throw error;
        });
      writers.set(token, pending);
    }
    return pending;
  };
  for (const [token, root] of Object.entries(state.roots)) {
    try {
      await access(root.path);
      roots.set(
        documentId(token),
        await NodeVaultFiles.open(root.path, { create: false }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Missing/removable disks stay unmounted; their paths are never recreated.
    }
  }
  const executable = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "jocki-renames" + (process.platform === "win32" ? ".exe" : ""),
      )
    : path.join(
        app.getAppPath(),
        "build/native-renames",
        process.platform === "win32"
          ? "Release/jocki-renames.exe"
          : "jocki-renames",
      );
  const matcher = new Libgit2RenameMatcher(executable);
  ipcMain.handle("vaults:workspace", (event) => {
    trusted(event);
    return { computer: state.computer };
  });
  ipcMain.handle("vaults:roots", (event) => {
    trusted(event);
    return Object.entries(state.roots)
      .filter(([, root]) => !root.file)
      .map(([token, root]) => ({
        token,
        name: root.name,
        path: root.path,
      }));
  });
  ipcMain.handle("vaults:select", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window()!, {
      title: "Open vault folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const fs = await NodeVaultFiles.open(result.filePaths[0]);
    if (
      local.root === fs.root ||
      local.root.startsWith(fs.root + path.sep) ||
      fs.root.startsWith(local.root + path.sep)
    )
      throw Error("Choose a vault outside Jocki's application data folder");
    if (
      [...roots].some(
        ([token, other]) =>
          leases.has(token) &&
          token !== "workspace" &&
          !state.roots[token]?.file &&
          (other.root.startsWith(fs.root + path.sep) ||
            fs.root.startsWith(other.root + path.sep)),
      )
    )
      throw Error(
        "Open separate vault folders; one vault cannot contain another open vault",
      );
    const token =
      Object.entries(state.roots).find(
        ([, root]) => !root.file && root.path === fs.root,
      )?.[0] ?? crypto.randomUUID();
    const name = path.basename(fs.root);
    state.roots[token] = { path: fs.root, name };
    roots.set(token, fs);
    await local.writeAtomic(
      "capabilities.json",
      utf8.encode(JSON.stringify(state)),
    );
    return { token, name, path: fs.root };
  });
  ipcMain.handle("vaults:select-workspace", async (event, create: boolean) => {
    trusted(event);
    const result = create
      ? await dialog.showSaveDialog(window()!, {
          title: "Save workspace",
          defaultPath: "workspace.json",
          filters: [{ name: "Jocki workspace", extensions: ["json"] }],
        })
      : await dialog.showOpenDialog(window()!, {
          title: "Open workspace file",
          properties: ["openFile"],
          filters: [{ name: "Jocki workspace", extensions: ["json"] }],
        });
    const selected =
      "filePath" in result
        ? result.filePath
        : "filePaths" in result
          ? result.filePaths[0]
          : undefined;
    if (result.canceled || !selected) return null;
    const fs = await NodeVaultFiles.open(path.dirname(selected));
    if (fs.root === local.root || fs.root.startsWith(local.root + path.sep))
      throw Error("Choose a workspace outside application data");
    const file = path.basename(selected);
    if (!file.endsWith(".json")) throw Error("Choose a JSON workspace file");
    const token =
      Object.entries(state.roots).find(
        ([, root]) => root.path === fs.root && root.file === file,
      )?.[0] ?? crypto.randomUUID();
    state.roots[token] = { path: fs.root, name: file, file };
    roots.set(token, fs);
    await local.writeAtomic(
      "capabilities.json",
      utf8.encode(JSON.stringify(state)),
    );
    return { token, name: file, path: path.join(fs.root, file) };
  });
  ipcMain.handle(
    "vaults:files",
    async (
      event,
      token: string,
      operation: string,
      path?: string,
      bytes?: Uint8Array,
    ) => {
      trusted(event);
      let fs = roots.get(token);
      if (!fs) throw Error("Select this folder locally before opening it");
      const workspaceFile = state.roots[token]?.file;
      if (workspaceFile) {
        // The selected file grants only its JSON and matching history archive.
        if (path !== "workspace.json" && path !== "workspace.automerge")
          throw Error("Invalid workspace operation");
        path =
          path === "workspace.json"
            ? workspaceFile
            : workspaceFile + ".automerge";
        await writer(
          token,
          await NodeVaultFiles.open(
            joinPath(local.root, "workspace-locks", token),
          ),
        );
      } else await writer(token, fs);
      if (operation === "root-access") return !workspaceFile;
      if (operation === "delete-root-companion") {
        if (workspaceFile) throw Error("Invalid workspace operation");
        return fs.removeCompanionRoot();
      }
      let target: VaultFileSystem = fs;
      if (operation.startsWith("root-")) {
        if (workspaceFile)
          throw Error("Workspace file access cannot address folder companions");
        target = fs.companionStorage();
        operation = operation.slice(5);
      }
      if (operation === "scan") return target.scan?.(path);
      if (operation === "stat")
        return typeof path === "string" ? target.stat?.(path) : undefined;
      if (operation === "move" && path && bytes)
        return target.move?.(path, text.decode(bytes));
      if (operation === "list") return target.list();
      if (operation === "directories") return target.directories?.();
      if (typeof path !== "string") throw Error("Missing file path");
      if (operation === "read-range" && bytes) {
        const [offset, length] = JSON.parse(text.decode(bytes));
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 64 * 1024 * 1024
        )
          throw Error("Invalid read range");
        return target.readRange?.(path, offset, length);
      }
      if (operation === "write-at" && bytes && bytes.length >= 8) {
        const offset = Number(
          new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true),
        );
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw Error("Invalid write offset");
        return target.writeAt?.(path, offset, bytes.subarray(8));
      }
      if (operation === "read") return target.read(path);
      if (operation === "mkdir") return target.mkdir?.(path);
      if (operation === "rmdir") return target.removeDirectory?.(path);
      if (operation === "reset") return target.removeTree?.(path);
      if (operation === "remove") return target.remove(path);
      if (operation === "write" && bytes instanceof Uint8Array)
        return target.writeAtomic(path, bytes);
      throw Error("Invalid file operation");
    },
  );
  ipcMain.handle(
    "vaults:renames",
    (event, before: RenameCandidate[], after: RenameCandidate[]) => {
      trusted(event);
      if (
        !Array.isArray(before) ||
        !Array.isArray(after) ||
        before.length + after.length > 100000
      )
        throw Error("Invalid rename snapshots");
      return matcher.match(before, after);
    },
  );
  ipcMain.handle("vaults:release", async (event, token: string) => {
    trusted(event);
    await writers.get(token);
    await watchers.get(token)?.close();
    watchers.delete(token);
    await leases.get(token)?.();
    writers.delete(token);
    leases.delete(token);
  });
  return async () => {
    await Promise.allSettled(writers.values());
    await Promise.all([...watchers.values()].map((watcher) => watcher.close()));
    watchers.clear();
    await Promise.all([...leases.values()].map((release) => release()));
    leases.clear();
    writers.clear();
  };
}
