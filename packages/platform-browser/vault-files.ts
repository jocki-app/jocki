import { RecordFiles } from "../core/vaults/record-container";
import type {
  FileSystemEntry,
  VaultFileSystem,
} from "../core/vaults/contracts";

type Directory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
/** createWritable publishes its temporary file on close, including external folders. */
export class BrowserVaultFiles implements VaultFileSystem {
  constructor(
    readonly root: FileSystemDirectoryHandle,
    private parentRoot?: FileSystemDirectoryHandle,
    private grantParent?: () => Promise<FileSystemDirectoryHandle>,
  ) {}
  private async parent(path: string, create = false) {
    const parts = path.split("/");
    if (
      !path ||
      path.includes("\\") ||
      /[\x00-\x1f:]/.test(path) ||
      parts.some((p) => !p || p === "." || p === "..")
    )
      throw Error("Invalid relative path");
    let directory = this.root;
    for (const part of parts.slice(0, -1))
      directory = await directory.getDirectoryHandle(part, { create });
    return { directory, name: parts.at(-1)! };
  }
  async read(path: string) {
    try {
      const { directory, name } = await this.parent(path);
      const file = await (await directory.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if ((error as DOMException).name === "NotFoundError") return undefined;
      throw error;
    }
  }
  async writeAtomic(path: string, bytes: Uint8Array) {
    const { directory, name } = await this.parent(path, true);
    const handle = await directory.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    try {
      await writer.write(new Uint8Array(bytes));
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  }
  async remove(path: string) {
    try {
      const { directory, name } = await this.parent(path);
      await directory.removeEntry(name);
    } catch (error) {
      if ((error as DOMException).name !== "NotFoundError") throw error;
    }
  }
  async mkdir(path: string) {
    const { directory, name } = await this.parent(path, true);
    await directory.getDirectoryHandle(name, { create: true });
  }
  async removeTree(path: string) {
    if (!path.split("/").at(-1)?.endsWith(".saddle"))
      throw Error("Only Jocki metadata can be deleted recursively");
    try {
      const { directory, name } = await this.parent(path);
      await directory.removeEntry(name, { recursive: true });
    } catch (error) {
      if ((error as DOMException).name !== "NotFoundError") throw error;
    }
  }
  async removeDirectory(path: string) {
    const { directory, name } = await this.parent(path),
      folder = await directory.getDirectoryHandle(name);
    for await (const [child, handle] of (folder as Directory).entries()) {
      if (handle.kind !== "directory")
        throw Error("Folder contains files; rescan before deleting");
      await this.removeDirectory(path + "/" + child);
    }
    await directory.removeEntry(name);
  }
  async removeCompanionRoot() {
    const companion = await this.companionRoot(false);
    if (companion && this.parentRoot)
      await new BrowserVaultFiles(this.parentRoot).remove(
        "." + this.root.name + ".saddle",
      );
  }
  async companionRoot(create = false): Promise<VaultFileSystem | undefined> {
    if (!this.parentRoot) {
      const origin = await navigator.storage.getDirectory();
      const relative = await origin.resolve(this.root);
      if (relative?.length) {
        let parent = origin;
        for (const part of relative.slice(0, -1))
          parent = await parent.getDirectoryHandle(part);
        this.parentRoot = parent;
      } else if (create && this.grantParent)
        this.parentRoot = await this.grantParent();
    }
    if (!this.parentRoot) return;
    return new RecordFiles(
      new BrowserVaultFiles(this.parentRoot),
      "." + this.root.name + ".saddle",
    );
  }
  async readRange(path: string, offset: number, length: number) {
    try {
      const { directory, name } = await this.parent(path);
      const file = await (await directory.getFileHandle(name)).getFile();
      return new Uint8Array(
        await file.slice(offset, offset + length).arrayBuffer(),
      );
    } catch (error) {
      if ((error as DOMException).name === "NotFoundError") return;
      throw error;
    }
  }
  async writeAt(path: string, offset: number, bytes: Uint8Array) {
    const { directory, name } = await this.parent(path),
      handle = await directory.getFileHandle(name);
    const writer = await handle.createWritable({ keepExistingData: true });
    try {
      await writer.write({
        type: "write",
        position: offset,
        data: new Uint8Array(bytes),
      });
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  }
  async move(from: string, to: string) {
    const source = await this.parent(from),
      destination = await this.parent(to, true);
    let exists = false;
    try {
      await destination.directory.getFileHandle(destination.name);
      exists = true;
    } catch (error) {
      if (
        !["NotFoundError", "TypeMismatchError"].includes(
          (error as DOMException).name,
        )
      )
        throw error;
    }
    try {
      await destination.directory.getDirectoryHandle(destination.name);
      exists = true;
    } catch (error) {
      if (
        !["NotFoundError", "TypeMismatchError"].includes(
          (error as DOMException).name,
        )
      )
        throw error;
    }
    if (exists) throw Error("Move destination already exists");
    let folder: FileSystemDirectoryHandle | undefined;
    try {
      folder = await source.directory.getDirectoryHandle(source.name);
    } catch (error) {
      if ((error as DOMException).name !== "TypeMismatchError") throw error;
    }
    const copyFile = async (
      src: FileSystemFileHandle,
      dir: FileSystemDirectoryHandle,
      name: string,
    ) => {
      const file = await src.getFile(),
        target = await dir.getFileHandle(name, { create: true }),
        writer = await target.createWritable();
      await file.stream().pipeTo(writer);
    };
    if (folder) {
      const pending: Array<
        [FileSystemDirectoryHandle, FileSystemDirectoryHandle]
      > = [
        [
          folder,
          await destination.directory.getDirectoryHandle(destination.name, {
            create: true,
          }),
        ],
      ];
      while (pending.length) {
        const [src, dest] = pending.pop()!;
        for await (const [name, handle] of (src as Directory).entries()) {
          if (handle.kind === "directory")
            pending.push([
              handle as FileSystemDirectoryHandle,
              await dest.getDirectoryHandle(name, { create: true }),
            ]);
          else await copyFile(handle as FileSystemFileHandle, dest, name);
        }
      }
    } else
      await copyFile(
        await source.directory.getFileHandle(source.name),
        destination.directory,
        destination.name,
      );
    await source.directory.removeEntry(source.name, { recursive: !!folder });
  }
  async stat(path: string): Promise<FileSystemEntry | undefined> {
    try {
      const { directory, name } = await this.parent(path);
      try {
        const file = await (await directory.getFileHandle(name)).getFile();
        return {
          path,
          kind: name.endsWith(".saddle") ? "companion" : "file",
          size: file.size,
          stamp: `${file.size}:${file.lastModified}`,
        };
      } catch (error) {
        if ((error as DOMException).name !== "TypeMismatchError") throw error;
        await directory.getDirectoryHandle(name);
        return {
          path,
          kind: name.endsWith(".saddle") ? "companion" : "folder",
          size: 0,
          stamp: "directory",
        };
      }
    } catch (error) {
      if ((error as DOMException).name !== "NotFoundError") throw error;
    }
  }
  async scan(root = ""): Promise<FileSystemEntry[]> {
    const entries: FileSystemEntry[] = [],
      pending: Array<[FileSystemDirectoryHandle, string]> = [];
    let folder = this.root;
    if (root) {
      try {
        for (const name of root.replace(/\/$/, "").split("/"))
          folder = await folder.getDirectoryHandle(name);
      } catch (error) {
        if ((error as DOMException).name === "NotFoundError") return [];
        throw error;
      }
    }
    pending.push([folder, root ? root.replace(/\/$/, "") + "/" : ""]);
    while (pending.length) {
      const [directory, prefix] = pending.pop()!;
      for await (const [name, handle] of (directory as Directory).entries()) {
        if (
          [".git", ".saddle"].includes(name) ||
          name.startsWith(".jocki-write-")
        )
          continue;
        const path = prefix + name;
        const kind = name.endsWith(".saddle")
          ? "companion"
          : handle.kind === "directory"
            ? "folder"
            : "file";
        if (handle.kind === "directory")
          entries.push({ path, kind, size: 0, stamp: "directory" });
        else {
          const file = await (handle as FileSystemFileHandle).getFile();
          entries.push({
            path,
            kind,
            size: file.size,
            stamp: `${file.size}:${file.lastModified}`,
          });
        }
        if (kind === "folder")
          pending.push([handle as FileSystemDirectoryHandle, path + "/"]);
      }
    }
    return entries;
  }
  async directories() {
    return (await this.scan())
      .filter((e) => e.kind === "folder")
      .map((e) => e.path)
      .sort();
  }
  async list() {
    return (await this.scan())
      .filter((e) => e.kind !== "folder")
      .map((e) => e.path)
      .sort();
  }
}

/** Handles are local capabilities in IndexedDB, never replicated workspace data. */
export async function localCapability<T>(
  key: string,
  value?: T,
): Promise<T | undefined> {
  // OPFS locations have a stable path from the origin root. Persist that path,
  // avoiding needless structured cloning of a browser-owned OPFS handle.
  let stored: unknown = value;
  if (
    typeof FileSystemDirectoryHandle !== "undefined" &&
    value instanceof FileSystemDirectoryHandle
  ) {
    const relative = await (
      await navigator.storage.getDirectory()
    ).resolve(value);
    if (relative)
      stored = { format: "jocki-local-directory/1", path: relative };
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("jocki-file-capabilities", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("capabilities");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(
        "capabilities",
        value === undefined ? "readonly" : "readwrite",
      );
      const store = tx.objectStore("capabilities"),
        request = value === undefined ? store.get(key) : store.put(stored, key);
      tx.oncomplete = () =>
        resolve(
          value === undefined ? (request.result as T | undefined) : value,
        );
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    if (
      result &&
      typeof result === "object" &&
      "format" in result &&
      result.format === "jocki-local-directory/1" &&
      "path" in result
    ) {
      const parts = result.path;
      if (
        !Array.isArray(parts) ||
        parts.some(
          (part) =>
            typeof part !== "string" ||
            !part ||
            part.includes("/") ||
            part === "." ||
            part === "..",
        )
      )
        throw Error("Invalid local directory capability");
      let directory = await navigator.storage.getDirectory();
      for (const part of parts)
        directory = await directory.getDirectoryHandle(part);
      return directory as T;
    }
    return result as T | undefined;
  } finally {
    db.close();
  }
}
