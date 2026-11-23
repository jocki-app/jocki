import path from "node:path";
import os from "node:os";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileVault } from "../core/vaults/vault";
import { WorkspaceStore } from "../core/vaults/workspace";
import { WorkspaceLibrary } from "../core/vaults/workspace-library";
import {
  ProtectedFileSync,
  type ShareKind,
} from "../core/vaults/protected-sync";
import { VaultSearch } from "../core/vaults/search";
import type { Repository } from "../core/repository";
import { relayConnection, type RelayConnection } from "../core/relay-settings";
import { digest, text, utf8 } from "../core/crypto";
import { NodeVaultFiles } from "./vault-files";
import { Libgit2RenameMatcher } from "./vault-renames";
import { lockDirectory } from "./lock";
import { openNodeRepository } from "./repository";
import { localFiles } from "../core/vaults/local-files";
import { VaultWatcher } from "./vault-watch";

interface Catalog {
  computer: string;
  roots: Record<string, { path: string; name: string }>;
}
export interface FileRuntimeOptions {
  directory: string;
  name?: string;
  vaults?: string[];
  sync?: RelayConnection;
  intervalMs?: number;
  renameExecutable?: string;
  onError?(error: unknown): void;
}
/** Headless owns its selected folders. Served web clients are separate replicas. */
export class NodeFileRuntime {
  readonly vaults = new Map<string, FileVault>();
  readonly search = new VaultSearch();
  private leases = new Map<string, () => Promise<void>>();
  private watchers = new Map<string, VaultWatcher>();
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;
  private stopped = false;
  private watchTasks = new Set<Promise<unknown>>();
  private constructor(
    readonly storage: NodeVaultFiles,
    readonly library: WorkspaceLibrary,
    readonly repository: Repository,
    readonly sync: ProtectedFileSync,
    private catalog: Catalog,
    private matcher: Libgit2RenameMatcher,
    private unlock: () => Promise<void>,
    readonly options: FileRuntimeOptions,
  ) {}
  get workspace(): WorkspaceStore {
    return this.library.current;
  }
  get computer() {
    return this.catalog.computer;
  }
  static async open(options: FileRuntimeOptions) {
    const interval = options.intervalMs ?? 30000;
    if (!Number.isSafeInteger(interval) || interval < 250 || interval > 3600000)
      throw Error("Invalid scan interval");
    const storage = await NodeVaultFiles.open(path.resolve(options.directory)),
      unlock = await lockDirectory(storage.root);
    let runtime: NodeFileRuntime | undefined,
      repository: Repository | undefined;
    try {
      const saved = await storage.read("capabilities.json"),
        catalog: Catalog = saved
          ? JSON.parse(text.decode(saved))
          : { computer: crypto.randomUUID(), roots: {} };
      await storage.writeAtomic(
        "capabilities.json",
        utf8.encode(JSON.stringify(catalog)),
      );
      const library = await WorkspaceLibrary.open(
        await NodeVaultFiles.open(path.join(storage.root, "workspace")),
        catalog.computer,
        options.name ?? os.hostname(),
      );
      const workspace = library.current;
      repository = await openNodeRepository(
        path.join(storage.root, "replica-cache"),
        relayConnection(
          options.sync ?? { endpoints: [], syncServer: "keyhive" },
        ),
      );
      const sync = await ProtectedFileSync.open(
        repository,
        library.storage,
        workspace,
        options.onError ?? console.error,
      );
      const candidates = options.renameExecutable
        ? [options.renameExecutable]
        : [
            path.join(
              path.dirname(fileURLToPath(import.meta.url)),
              "native",
              "jocki-renames" +
                (process.platform === "win32" ? ".exe" : ""),
            ),
            path.resolve(
              "build/native-renames/package/jocki-renames" +
                (process.platform === "win32" ? ".exe" : ""),
            ),
          ];
      let executable: string | undefined;
      for (const candidate of candidates) {
        try {
          await access(candidate);
          executable = candidate;
          break;
        } catch {}
      }
      if (!executable)
        throw Error(
          "Build the libgit2 rename helper with npm run build:vault-native",
        );
      runtime = new NodeFileRuntime(
        storage,
        library,
        repository,
        sync,
        catalog,
        new Libgit2RenameMatcher(executable),
        unlock,
        options,
      );
      for (const [id, token] of Object.entries(
        workspace.settings(catalog.computer).vaults,
      )) {
        const root = catalog.roots[token];
        if (!root) continue;
        await access(root.path);
        const vault = await runtime.mount(root.path, root.name);
        if (vault.id !== id) throw Error("Mounted vault identity changed");
      }
      for (const root of options.vaults ?? []) await runtime.add(root);
      await runtime.scan();
      runtime.timer = setInterval(() => {
        void runtime!.scan().catch(options.onError ?? console.error);
      }, interval);
      return runtime;
    } catch (error) {
      if (runtime) await runtime.close();
      else {
        await repository?.close();
        await unlock();
      }
      throw error;
    }
  }
  private async mount(directory: string, name?: string) {
    const fs = await NodeVaultFiles.open(directory, { create: false });
    if (
      fs.root === this.storage.root ||
      this.storage.root.startsWith(fs.root + path.sep) ||
      fs.root.startsWith(this.storage.root + path.sep)
    )
      throw Error("Vaults and application data must be separate folders");
    const existing = [...this.vaults.values()].find(
      (vault) => (vault.fs as NodeVaultFiles).root === fs.root,
    );
    if (existing) return existing;
    if (
      [...this.vaults.values()].some((vault) => {
        const other = (vault.fs as NodeVaultFiles).root;
        return (
          other.startsWith(fs.root + path.sep) ||
          fs.root.startsWith(other + path.sep)
        );
      })
    )
      throw Error(
        "Open separate vault folders; one vault cannot contain another open vault",
      );
    const release = await fs.acquireWriter();
    try {
      const vault = await FileVault.open(fs, this.computer, {
        features: this.workspace.features,
        name: name ?? path.basename(fs.root),
        renames: this.matcher,
        lazy: true,
        local: localFiles(
          this.storage,
          "state/roots/" + (await digest(utf8.encode(fs.root))),
        ),
      });
      if (this.vaults.has(vault.id))
        throw Error("This vault identity is already mounted");
      this.leases.set(vault.id, release);
      this.vaults.set(vault.id, vault);
      await this.sync.attach(vault);
      this.watchers.set(
        vault.id,
        await VaultWatcher.open(
          fs.root,
          (changes) => {
            const pending = vault
              .reconcile(changes)
              .then(() => this.search.update(vault));
            this.watchTasks.add(pending);
            void pending
              .catch(this.options.onError ?? console.error)
              .finally(() => this.watchTasks.delete(pending));
          },
          this.options.onError,
        ),
      );
      return vault;
    } catch (error) {
      await release();
      throw error;
    }
  }
  async add(directory: string) {
    const vault = await this.mount(path.resolve(directory)),
      root = (vault.fs as NodeVaultFiles).root;
    const token =
      Object.entries(this.catalog.roots).find(
        ([, value]) => value.path === root,
      )?.[0] ?? crypto.randomUUID();
    this.catalog.roots[token] = { path: root, name: vault.name };
    await this.storage.writeAtomic(
      "capabilities.json",
      utf8.encode(JSON.stringify(this.catalog)),
    );
    await this.workspace.update((d) => {
      d.computers[this.computer].vaults ??= structuredClone(
        this.workspace.settings(this.computer).vaults,
      );
      d.computers[this.computer].vaults![vault.id] = token;
      d.defaults.rootNames[vault.id] = vault.name;
    });
    return vault;
  }
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.scanning ??= (async () => {
      for (const vault of this.vaults.values()) {
        await vault.inheritFeatures(this.workspace.features);
        await vault.reconcile();
        for (const file of vault.list()) await vault.compactLocal(file.id);
        await this.search.update(vault);
      }
    })().finally(() => {
      this.scanning = undefined;
    }));
  }
  async share(vault: string, kind: ShareKind, prefix = "") {
    if (kind === "workspace")
      return this.sync.createWorkspace([...this.vaults.values()]);
    const selected = this.vaults.get(vault);
    if (!selected) throw Error("Unknown vault");
    return this.sync.create(selected, kind, prefix);
  }
  async join(value: string, vault: FileVault, prefix = "") {
    return this.sync.join(value, vault, prefix);
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.watchers.values()].map((watcher) => watcher.close()),
    );
    await this.scanning?.catch(() => {});
    await Promise.all([...this.watchTasks]);
    await this.sync.close();
    await Promise.all([...this.vaults.values()].map((vault) => vault.flush()));
    await this.repository.close();
    await Promise.all([...this.leases.values()].map((release) => release()));
    await this.unlock();
  }
}
