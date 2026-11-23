import {
  WorkspaceStore,
  resolveSettings,
  type FileWorkspace,
} from "./workspace";
import { documentId, type VaultFileSystem } from "./contracts";
import { text, utf8 } from "../crypto";
import { z } from "zod";

const catalogSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().max(200),
            kind: z.enum(["internal", "folder"]),
            root: z.string().max(4096),
            path: z.string().max(4096),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
type Catalog = z.infer<typeof catalogSchema>;
export type SavedWorkspace = Catalog["entries"][number];
export type WorkspaceResolver = (
  entry: SavedWorkspace,
) => Promise<VaultFileSystem>;

/** The saved-workspace list has no active selection and opens no workspace. */
export class WorkspaceCatalog {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly storage: VaultFileSystem,
    private catalog: Catalog,
    private resolver?: WorkspaceResolver,
  ) {}
  static async open(storage: VaultFileSystem, resolver?: WorkspaceResolver) {
    const bytes = await storage.read("workspaces.json");
    const saved = bytes ? JSON.parse(text.decode(bytes)) : { entries: [] };
    const catalog = catalogSchema.parse(saved);
    if (
      new Set(catalog.entries.map((e) => e.id)).size !== catalog.entries.length
    )
      throw Error("Duplicate workspace identity in catalog");
    const index = new WorkspaceCatalog(storage, catalog, resolver);
    return index;
  }
  list() {
    return this.catalog.entries.map((entry) => ({ ...entry }));
  }
  resolve(entry: SavedWorkspace) {
    if (entry.kind === "internal") {
      if (!/^(?:workspaces\/[a-f0-9-]{36})?$/.test(entry.root))
        throw Error("Invalid internal workspace location");
      return Promise.resolve(scopedStorage(this.storage, entry.root));
    }
    if (!this.resolver)
      throw Error("Folder workspaces are unavailable on this platform");
    return this.resolver(entry);
  }
  async read(id: string) {
    const fs = await this.resolve(this.entry(id));
    try {
      const bytes = await fs.read("workspace.json");
      if (!bytes) throw Error("Workspace file is missing");
      const { workspaceSchema } = await import("./workspace");
      return workspaceSchema.parse(JSON.parse(text.decode(bytes)));
    } finally {
      await fs.release?.();
    }
  }
  forget(id: string) {
    return this.write(async () => {
      const entry = this.entry(id);
      if (entry.kind === "internal") {
        const fs = await this.resolve(entry);
        await fs.remove("workspace.automerge");
        await fs.remove("workspace.json");
      }
      await this.persist({
        entries: this.catalog.entries.filter((entry) => entry.id !== id),
      });
    });
  }
  entry(id: string) {
    documentId(id);
    const entry = this.catalog.entries.find((e) => e.id === id);
    if (!entry) throw Error("Unknown workspace");
    return { ...entry };
  }
  private async persist(catalog: Catalog) {
    await this.storage.writeAtomic(
      "workspaces.json",
      utf8.encode(JSON.stringify(catalogSchema.parse(catalog), null, 2) + "\n"),
    );
    this.catalog = catalog;
  }
  private write(work: () => Promise<void>) {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async create(
    computer: string,
    name: string,
    external?: { root: string; path: string; storage: VaultFileSystem },
  ) {
    name = name.trim();
    if (!name || name.length > 200)
      throw Error("Choose a workspace name of 1–200 characters");
    let id: string = crypto.randomUUID();
    await this.write(async () => {
      if (this.catalog.entries.length >= 500)
        throw Error("Workspace limit reached");
      const root =
        external?.root ??
        (this.catalog.entries.length ? "workspaces/" + id : "");
      const target = external?.storage ?? scopedStorage(this.storage, root);
      if (await target.read("workspace.json"))
        throw Error(
          "A workspace already exists at this location; open it from Manage",
        );
      const store = await WorkspaceStore.open(target, computer, name, id);
      id = store.current.id;
      await this.persist({
        entries: [
          ...this.catalog.entries,
          {
            id,
            name: store.current.name,
            root,
            kind: external ? "folder" : "internal",
            path: external?.path ?? "",
          },
        ],
      });
    });
    return id;
  }
  register(entry: SavedWorkspace) {
    return this.write(() => {
      const duplicate = this.catalog.entries.find(
        (item) => item.id === entry.id && item.root !== entry.root,
      );
      if (duplicate)
        throw Error("This workspace is already referenced at another location");
      if (
        this.catalog.entries.length >= 500 &&
        !this.catalog.entries.some((item) => item.root === entry.root)
      )
        throw Error("Workspace limit reached");
      return this.persist({
        entries: [
          ...this.catalog.entries.filter((item) => item.root !== entry.root),
          entry,
        ],
      });
    });
  }
  remember(root: string, workspace: FileWorkspace) {
    return this.write(() =>
      this.persist({
        entries: this.catalog.entries.flatMap((entry) =>
          entry.root === root
            ? [{ ...entry, id: workspace.id, name: workspace.name }]
            : entry.id === workspace.id
              ? []
              : [entry],
        ),
      }),
    );
  }
}

/** A workspace is opened only after an explicit selection by the caller. */
export class WorkspaceLibrary {
  private constructor(
    readonly index: WorkspaceCatalog,
    readonly computer: string,
    readonly current: WorkspaceStore,
    private readonly currentRoot: string,
  ) {}
  get storage() {
    return this.index.storage;
  }
  static async open(
    storage: VaultFileSystem,
    computer: string,
    name = "Workspace",
    id?: string,
    resolver?: WorkspaceResolver,
  ) {
    const index = await WorkspaceCatalog.open(storage, resolver);
    // Headless callers choose the first workspace when no ID was supplied.
    id ??= index.list()[0]?.id ?? (await index.create(computer, name));
    const entry = index.entry(id);
    const target = await index.resolve(entry);
    try {
      if (!(await target.read("workspace.json")))
        throw Error("Workspace file is missing");
      const workspace = await WorkspaceStore.open(target, computer, entry.name);
      if (workspace.current.id !== entry.id)
        throw Error("Workspace identity changed");
      return new WorkspaceLibrary(index, computer, workspace, entry.root);
    } catch (error) {
      await target.release?.();
      throw error;
    }
  }
  list() {
    return this.index
      .list()
      .map((e) =>
        e.id === this.current.current.id
          ? { ...e, name: this.current.current.name }
          : e,
      );
  }
  async references() {
    const found = new Map<
      string,
      { id: string; location: string; workspace: string }
    >();
    for (const { id } of this.index.list()) {
      const entry = this.index.entry(id);
      let doc: FileWorkspace;
      if (entry.root === this.currentRoot) doc = this.current.current;
      else doc = await this.index.read(id);
      for (const [id, location] of Object.entries(
        resolveSettings(doc, this.computer).vaults,
      ))
        found.set(id, { id, location, workspace: doc.name });
    }
    return [...found.values()];
  }
  create(name: string) {
    return this.index.create(this.computer, name);
  }
  rememberCurrent() {
    return this.index.remember(this.currentRoot, this.current.current);
  }
}
export function scopedStorage(
  storage: VaultFileSystem,
  root: string,
): VaultFileSystem {
  if (!root) return storage;
  const prefix = root + "/";
  return {
    read: (p) => storage.read(prefix + p),
    writeAtomic: (p, b) => storage.writeAtomic(prefix + p, b),
    remove: (p) => storage.remove(prefix + p),
    ...(storage.mkdir
      ? { mkdir: (p: string) => storage.mkdir!(prefix + p) }
      : {}),
    ...(storage.removeDirectory
      ? { removeDirectory: (p: string) => storage.removeDirectory!(prefix + p) }
      : {}),
    ...(storage.directories
      ? {
          directories: async () =>
            (await storage.directories!())
              .filter((p) => p.startsWith(prefix))
              .map((p) => p.slice(prefix.length)),
        }
      : {}),
    ...(storage.removeTree
      ? { removeTree: (p: string) => storage.removeTree!(prefix + p) }
      : {}),
    ...(storage.stat
      ? {
          stat: async (p: string) => {
            const entry = await storage.stat!(prefix + p);
            return entry
              ? { ...entry, path: entry.path.slice(prefix.length) }
              : undefined;
          },
        }
      : {}),
    ...(storage.scan
      ? {
          scan: async (p = "") =>
            (await storage.scan!(p ? prefix + p : root))
              .filter((e) => e.path.startsWith(prefix))
              .map((e) => ({ ...e, path: e.path.slice(prefix.length) })),
        }
      : {}),
    ...(storage.move
      ? {
          move: (from: string, to: string) =>
            storage.move!(prefix + from, prefix + to),
        }
      : {}),
    companionRoot: async () => scopedStorage(storage, root + ".saddle"),
    ...(storage.removeTree
      ? { removeCompanionRoot: () => storage.removeTree!(root + ".saddle") }
      : {}),
    list: async () =>
      (await storage.list())
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length)),
  };
}
