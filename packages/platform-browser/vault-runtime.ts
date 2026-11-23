import { RecordFiles } from "../core/vaults/record-container";
import * as A from "@automerge/automerge";
import wasmUrl from "@automerge/automerge/automerge.wasm?url";
import { FileVault } from "../core/vaults/vault";
import { contentTypes } from "../core/vaults/content-types";
import {
  WorkspaceStore,
  workspaceSchema,
  resolveSettings,
} from "../core/vaults/workspace";
import {
  WorkspaceCatalog,
  WorkspaceLibrary,
  scopedStorage,
  type SavedWorkspace,
} from "../core/vaults/workspace-library";
import { LocalLogStore, logError, logger } from "../core/local-logs";
import type {
  VaultFileSystem,
  FileSystemChange,
  FileSystemEntry,
  RenameMatcher,
  RenameCandidate,
  RenameMatch,
} from "../core/vaults/contracts";
import { BrowserVaultFiles, localCapability } from "./vault-files";
import {
  ProtectedFileSync,
  type ShareDocument,
} from "../core/vaults/protected-sync";
import { FileExtensionHost } from "../platform/src/file-sdk/host";
import { VaultEditors } from "../core/vaults/editors";
import {
  registerBundledFileExtensions,
  bundledTemplateSource,
} from "../app-ui/vault-extensions";
import { FileExtensionPackages } from "../core/vaults/extensions";
import { browserExtensionModule } from "./file-extension-host";
import {
  repositorySettings,
  saveRepositorySettings,
} from "./repository-settings";
import {
  defaultRepositorySettings,
  validateRepositorySettings,
  type RepositorySettings,
} from "../core/relay-settings";
import { digest, utf8 } from "../core/crypto";
import { localFiles } from "../core/vaults/local-files";
import { acquireWriter } from "./writer-lock";

export interface NativeVaultBridge {
  sandboxedExtensions?: boolean;
  fileInventory?: boolean;
  rootCompanions?: boolean;
  positionedFiles?: boolean;
  rangedReads?: boolean;
  selectParent?(token: string): Promise<void>;
  release?(token: string): Promise<void>;
  onWillClose?(handler: () => Promise<boolean>): () => void;
  onFilesChanged?(
    handler: (token: string, changes?: FileSystemChange[]) => void,
  ): () => void;
  workspace(): Promise<{ computer: string }>;
  select(): Promise<{ token: string; name: string; path?: string } | null>;
  selectWorkspace?(
    create: boolean,
  ): Promise<{ token: string; name: string; path: string } | null>;
  roots(): Promise<Array<{ token: string; name: string; path?: string }>>;
  files(
    token: string,
    operation: string,
    path?: string,
    bytes?: Uint8Array,
  ): Promise<unknown>;
  renames?(
    before: RenameCandidate[],
    after: RenameCandidate[],
  ): Promise<RenameMatch[]>;
}
declare global {
  interface Window {
    jockiVaults?: NativeVaultBridge;
  }
}
class BridgeFiles implements VaultFileSystem {
  async release() {
    await this.bridge.release?.(this.token);
  }
  constructor(
    readonly bridge: NativeVaultBridge,
    readonly token: string,
    private rootSidecar = false,
  ) {}
  private operation(name: string) {
    return this.rootSidecar ? "root-" + name : name;
  }
  async removeCompanionRoot() {
    await this.companionRoot?.(true);
    await this.bridge.files(this.token, "delete-root-companion");
  }
  get companionRoot() {
    if (!this.bridge.rootCompanions) return undefined;
    return async (create = false) => {
      if (create && !(await this.bridge.files(this.token, "root-access"))) {
        if (!this.bridge.selectParent)
          throw Error("Grant access to the opened folder’s parent");
        await this.bridge.selectParent(this.token);
      }
      return new RecordFiles(
        new BridgeFiles(this.bridge, this.token, true),
        "container",
      );
    };
  }
  get scan() {
    return this.bridge.fileInventory
      ? async (path?: string) =>
          (await this.bridge.files(
            this.token,
            this.operation("scan"),
            path,
          )) as FileSystemEntry[]
      : undefined;
  }
  get stat() {
    return this.bridge.fileInventory
      ? async (path: string) =>
          ((await this.bridge.files(
            this.token,
            this.operation("stat"),
            path,
          )) ?? undefined) as FileSystemEntry | undefined
      : undefined;
  }
  async move(from: string, to: string) {
    await this.bridge.files(
      this.token,
      this.operation("move"),
      from,
      utf8.encode(to),
    );
  }
  async read(path: string) {
    const value = await this.bridge.files(
      this.token,
      this.operation("read"),
      path,
    );
    return value ? new Uint8Array(value as Uint8Array) : undefined;
  }
  get readRange() {
    return this.bridge.positionedFiles || this.bridge.rangedReads
      ? async (path: string, offset: number, length: number) => {
          const value = await this.bridge.files(
            this.token,
            this.operation("read-range"),
            path,
            utf8.encode(JSON.stringify([offset, length])),
          );
          return value ? new Uint8Array(value as Uint8Array) : undefined;
        }
      : undefined;
  }
  get writeAt() {
    return this.bridge.positionedFiles
      ? async (path: string, offset: number, bytes: Uint8Array) => {
          const data = new Uint8Array(bytes.length + 8);
          new DataView(data.buffer).setBigUint64(0, BigInt(offset), true);
          data.set(bytes, 8);
          await this.bridge.files(
            this.token,
            this.operation("write-at"),
            path,
            data,
          );
        }
      : undefined;
  }
  async writeAtomic(path: string, bytes: Uint8Array) {
    await this.bridge.files(this.token, this.operation("write"), path, bytes);
  }
  async remove(path: string) {
    await this.bridge.files(this.token, this.operation("remove"), path);
  }
  async mkdir(path: string) {
    await this.bridge.files(this.token, this.operation("mkdir"), path);
  }
  async removeTree(path: string) {
    await this.bridge.files(this.token, this.operation("reset"), path);
  }
  async removeDirectory(path: string) {
    await this.bridge.files(this.token, this.operation("rmdir"), path);
  }
  async directories() {
    return (await this.bridge.files(
      this.token,
      this.operation("directories"),
    )) as string[];
  }
  async list() {
    return (await this.bridge.files(
      this.token,
      this.operation("list"),
    )) as string[];
  }
}
export class VaultRuntime {
  openError = "";
  private openListeners = new Set<() => void>();
  subscribeOpenErrors(listener: () => void) {
    this.openListeners.add(listener);
    return () => {
      this.openListeners.delete(listener);
    };
  }
  private reportOpenError(error: unknown) {
    this.openError =
      "Could not open vault: " +
      (error instanceof Error ? error.message : String(error));
    for (const listener of this.openListeners) listener();
  }
  private async attemptOpen<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.reportOpenError(error);
      throw error;
    }
  }
  private requestQueue: Array<{
    kind: "path" | "template";
    extension: string;
    request: Record<string, unknown>;
    resolve(value: boolean): void;
  }> = [];
  private requestListeners = new Set<() => void>();
  get currentRequest() {
    return this.requestQueue[0];
  }
  subscribeRequests(listener: () => void) {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }
  private ask(
    kind: "path" | "template",
    extension: string,
    request: Record<string, unknown>,
  ) {
    return new Promise<boolean>((resolve) => {
      this.requestQueue.push({ kind, extension, request, resolve });
      this.requestListeners.forEach((listener) => listener());
    });
  }
  finishRequest(accepted: boolean) {
    this.requestQueue.shift()?.resolve(accepted);
    this.requestListeners.forEach((listener) => listener());
  }
  async requestNamedPath(
    extension: string,
    request: {
      key: string;
      path?: string;
      kind: "file" | "folder";
      title?: string;
    },
  ) {
    return this.ask("path", extension, request);
  }
  async requestTemplate(
    extension: string,
    request: { template: string; vault?: string },
  ) {
    return this.ask("template", extension, request);
  }
  async addNamedPath(request: {
    vault: string;
    key: string;
    path: string;
    kind: "file" | "folder";
  }) {
    const vault = this.vaults.get(request.vault);
    if (!vault) throw Error("Select an open vault");
    if (
      request.kind === "folder" &&
      request.path.replace(/^\//, "") !== "" &&
      !vault.directories().includes(request.path.replace(/^\//, ""))
    )
      await vault.createFolder(request.path.replace(/^\//, ""));
    await vault.setNamedPath(request.key, request.path, request.kind);
  }
  async copyTemplate(
    extension: string,
    template: string,
    vaultId: string,
    destination?: string,
  ) {
    const declaration = this.extensions
      .installed()
      .find((item) => item.manifest.id === extension)
      ?.manifest.contributes.templates.find((item) => item.id === template);
    const vault = this.vaults.get(vaultId),
      folders = Object.values(vault?.namedPaths ?? {}).filter(
        (item) => item.key === "templates" && item.kind === "folder",
      ),
      folder = destination
        ? folders.find((item) => item.id === destination)
        : folders.length === 1
          ? folders[0]
          : undefined;
    if (!declaration || !vault || folder?.kind !== "folder")
      throw Error("Add a templates named folder in the selected vault first");
    const path =
      (folder.path ? folder.path + "/" : "") +
      declaration.title.replace(/[/\\\x00-\x1f]/g, "-") +
      declaration.extension;
    const plugin = this.extensions
      .installed()
      .find((item) => item.manifest.id === extension)!;
    const source =
      declaration.text ??
      (plugin.builtin
        ? bundledTemplateSource(declaration.file!)
        : new TextDecoder("utf-8", { fatal: true }).decode(
            (await this.packages.load(extension)).files[declaration.file!],
          ));
    await vault.create(path, new TextEncoder().encode(source), {
      contentType: declaration.contentType ?? null,
    });
    await vault.setTemplate(path, declaration.title);
  }
  installedContentTypes() {
    const names = new Set(
      this.extensions
        .installed()
        .flatMap(({ manifest }) => manifest.contentTypes),
    );
    return contentTypes.filter(
      (type) => names.has(type.id) || names.has(type.name),
    );
  }
  private async onVaultAdded(vault: FileVault) {
    await vault.inheritFeatures(this.workspace.features);
    const settings = this.workspace.current.defaults.plugins["core.paths"] as
      { askedTemplates?: boolean } | undefined;
    if (this.vaults.size === 1 && !settings?.askedTemplates) {
      await this.workspace.update((doc) => {
        doc.defaults.plugins["core.paths"] = { askedTemplates: true };
      });
      void this.requestNamedPath("core", {
        key: "templates",
        path: "/templates",
        kind: "folder",
        title: "Add a templates folder?",
      });
    }
    await this.offerTemplates(vault.id);
  }
  private async offerTemplates(vault?: string) {
    if (!this.vaults.size) return;
    for (const plugin of this.extensions.manifests()) {
      if (!plugin.contributes.templates.length) continue;
      const preferences = this.workspace.current.defaults.plugins[plugin.id] as
        { templatesOffered?: boolean } | undefined;
      if (preferences?.templatesOffered) continue;
      await this.workspace.update((doc) => {
        const prior = doc.defaults.plugins[plugin.id] as
          Record<string, unknown> | undefined;
        doc.defaults.plugins[plugin.id] = { ...prior, templatesOffered: true };
      });
      for (const template of plugin.contributes.templates)
        void this.requestTemplate(plugin.id, { template: template.id, vault });
    }
  }
  readonly vaults = new Map<string, FileVault>();
  sync?: ProtectedFileSync;
  private startingSync?: Promise<ProtectedFileSync>;
  private connectionQueue: Promise<void> = Promise.resolve();
  private connection = defaultRepositorySettings();
  private connectionListeners = new Set<() => void>();
  get connectionSettings() {
    return this.connection;
  }
  subscribeConnection(listener: () => void) {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }
  private connectionChanged(settings: RepositorySettings) {
    this.connection = settings;
    this.connectionListeners.forEach((listener) => listener());
  }
  readonly extensions: FileExtensionHost;
  readonly editors: VaultEditors;
  packages!: FileExtensionPackages;
  private releaseWriter?: () => Promise<void>;
  private unsubscribeWorkspace?: () => void;
  private closing?: Promise<void>;
  confirmClose?: () => Promise<boolean>;
  navigate?: (destination: { id?: string; name?: string }) => Promise<void>;
  private preferences: Promise<void> = Promise.resolve();
  private constructor(
    readonly library: WorkspaceLibrary,
    readonly logs: LocalLogStore,
    readonly computer: string,
    readonly localRoot?: FileSystemDirectoryHandle,
  ) {
    this.extensions = new FileExtensionHost({
      namedPaths: async () =>
        [...this.vaults.values()].flatMap((vault) =>
          Object.values(vault.namedPaths).map((value) => ({
            vault: vault.id,
            ...value,
          })),
        ),
      requestNamedPath: (extension, request) =>
        this.requestNamedPath(extension, request),
      addNamedPath: (request) => this.addNamedPath(request),
      requestTemplate: (extension, request) =>
        this.requestTemplate(extension, request),
      log: (extension, level, message) =>
        logger("extension." + extension)[level]("{message}", { message }),
      folders: () =>
        [...this.vaults.values()].map((v) => ({ id: v.id, name: v.name })),
      documents: () => this.editors.documents(),
      updateDocument: async (_extension, vault, id, edits, instance) =>
        this.editors.update(vault, id, edits, instance),
      getConfiguration: (extension, key) => {
        const section = this.workspace.settings(this.computer).plugins[
          extension
        ] as { configuration?: Record<string, unknown> } | undefined;
        return section?.configuration?.[key];
      },
      updateConfiguration: async (extension, key, value) =>
        this.workspace.update((d) => {
          const declaration = this.extensions
            .configurationContributions()
            .find(
              (setting) =>
                setting.extension === extension && setting.key === key,
            );
          const destination =
            declaration?.scope === "computer"
              ? d.computers[this.computer]
              : d.defaults;
          destination.plugins ??= {};
          destination.plugins[extension] ??= {
            enabled: true,
            configuration: {},
          };
          const settings = destination.plugins[extension] as {
            configuration?: Record<string, unknown>;
          };
          settings.configuration ??= {};
          settings.configuration[key] = value;
        }),
    });
    this.editors = new VaultEditors(this.vaults, this.extensions);
    registerBundledFileExtensions(this.extensions);
    const configurationKey = () =>
      JSON.stringify(
        Object.entries(this.workspace.settings(this.computer).plugins).map(
          ([id, settings]) => {
            const value = settings as {
              enabled?: boolean;
              configuration?: unknown;
            } | null;
            return [id, value?.enabled, value?.configuration];
          },
        ),
      );
    let previous = configurationKey();
    this.unsubscribeWorkspace = this.workspace.subscribe(() => {
      for (const vault of this.vaults.values())
        void vault
          .inheritFeatures(this.workspace.features)
          .catch((error) => logError(error, "features"));
      const next = configurationKey();
      if (next === previous) return;
      previous = next;
      this.extensions.didChangeConfiguration();
      void this.applyExtensionPreferences().catch((error) =>
        logError(error, "extensions"),
      );
    });
  }
  get workspace(): WorkspaceStore {
    return this.library.current;
  }
  static async open(
    id?: string,
    createName?: string,
    diagnostics?: LocalLogStore,
  ) {
    if (!id && !createName) throw Error("Choose a workspace to open");
    await A.initializeWasm(wasmUrl);
    const releaseWriter = await acquireWriter();
    let runtime: VaultRuntime | undefined;
    let logs: LocalLogStore | undefined;
    try {
      const { storage, localRoot, computer } = await workspaceStorage(true);
      if (createName) {
        const catalog = await WorkspaceCatalog.open(storage);
        id = await catalog.create(computer!, createName);
      }
      logs = diagnostics ?? (await LocalLogStore.open(storage));
      logs.configure();
      runtime = new VaultRuntime(
        await WorkspaceLibrary.open(
          storage,
          computer!,
          "Workspace",
          id,
          resolveWorkspace,
        ),
        logs,
        computer!,
        localRoot,
      );
      runtime.releaseWriter = releaseWriter;
      runtime.connection = await repositorySettings();
      await runtime.reopen();
      await runtime.activateExtensions();
      await runtime.resumeSync();
      return runtime;
    } catch (error) {
      if (runtime)
        await runtime
          .shutdown()
          .catch((cleanup) =>
            console.error("Workspace cleanup failed", cleanup),
          );
      else {
        await logs?.flush();

        await window.jockiVaults?.release?.("workspace");
        await releaseWriter();
      }
      throw error;
    }
  }
  /** Release the session without removing any saved workspace or vault reference. */
  shutdown() {
    return (this.closing ??= (async () => {
      this.assertWorkspaceCanChange();
      this.unsubscribeWorkspace?.();
      this.unsubscribeWorkspace = undefined;
      while (this.requestQueue.length) this.finishRequest(false);
      const failures: unknown[] = [];
      const finish = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          failures.push(error);
        }
      };
      try {
        await finish(() => this.connectionQueue);
        await finish(() => this.preferences);
        await finish(() => this.extensions.dispose());
        for (const session of this.editors.documents())
          await finish(() =>
            this.editors.close(
              session.vault,
              session.id,
              false,
              session.instance,
            ),
          );
        await finish(() => this.flush());
        if (this.startingSync) await finish(() => this.startingSync!);
        if (this.sync) {
          await finish(() => this.sync!.close());
          await finish(() => this.sync!.repository.close());
        }
        await finish(() => this.library.rememberCurrent());
        for (const id of this.vaults.keys()) {
          const token = this.workspace.settings(this.computer).vaults[id];
          if (token)
            await finish(async () => window.jockiVaults?.release?.(token));
        }
      } finally {
        this.vaults.clear();
        this.sync = undefined;
        this.startingSync = undefined;
        this.openListeners.clear();
        this.connectionListeners.clear();
        this.confirmClose = undefined;
        this.navigate = undefined;

        await finish(async () =>
          window.jockiVaults?.release?.("workspace"),
        );
        await finish(async () => this.workspace.storage.release?.());
        await this.releaseWriter?.();
        this.releaseWriter = undefined;
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Could not finish closing the workspace",
        );
    })());
  }
  async reopen() {
    const locations = this.workspace.settings(this.computer).vaults;
    for (const [id, location] of Object.entries(locations)) {
      if (this.vaults.has(id)) continue;
      try {
        const fs = await vaultLocation(location, this.localRoot);
        if (!fs) throw Error("Select this folder again to grant local access");
        const renames: RenameMatcher | undefined = window.jockiVaults
          ?.renames
          ? {
              name: "libgit2",
              match: (a, b) => window.jockiVaults!.renames!(a, b),
            }
          : undefined;
        const vault = await FileVault.open(fs, this.computer, {
          id,
          name: this.workspace.settings(this.computer).rootNames[id],
          lazy: true,
          local: localFiles(
            this.library.storage,
            "state/roots/" + (await digest(utf8.encode(location))),
          ),
          renames,
          features: this.workspace.features,
        });
        if (vault.id !== id) throw Error("Selected vault identity changed");
        this.vaults.set(id, vault);
        await this.onVaultAdded(vault);
        this.extensions.didChangeVaultFolders([{ id, name: vault.name }], []);
        if (this.packages) await this.extensions.activateEvent("onVaultOpen");
        if (this.sync) await this.sync.attach(vault);
      } catch (error) {
        this.sync?.detach(id);
        await window.jockiVaults
          ?.release?.(location)
          .catch((cleanup) => logError(cleanup, "vault-open-cleanup"));
        throw Error(
          "Could not open vault: " +
            (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
    }
  }
  async switchWorkspace(id: string) {
    this.assertWorkspaceCanChange();
    if (!this.navigate) throw Error("Workspace navigation is unavailable");
    await this.navigate({ id });
  }
  async createWorkspace(name: string) {
    this.assertWorkspaceCanChange();
    if (!this.navigate) throw Error("Workspace navigation is unavailable");
    await this.navigate({ name });
  }
  mountKnownVault(id: string, location: string) {
    return this.attemptOpen(() => this.mountVault(id, location));
  }
  private async mountVault(id: string, location: string) {
    if (this.vaults.has(id)) return;
    const fs = await vaultLocation(location, this.localRoot);
    if (!fs) throw Error("Select this folder again to grant local access");
    if (fs instanceof BrowserVaultFiles)
      for (const mounted of this.vaults.values()) {
        if (
          mounted.fs instanceof BrowserVaultFiles &&
          ((await fs.root.resolve(mounted.fs.root)) ||
            (await mounted.fs.root.resolve(fs.root)))
        )
          throw Error(
            "Open separate vault folders; vaults cannot contain one another",
          );
      }
    const renames: RenameMatcher | undefined = window.jockiVaults?.renames
      ? {
          name: "libgit2",
          match: (a, b) => window.jockiVaults!.renames!(a, b),
        }
      : undefined;
    let vault: FileVault;
    try {
      vault = await FileVault.open(fs, this.computer, {
        id,
        name: this.workspace.settings(this.computer).rootNames[id],
        lazy: true,
        local: localFiles(
          this.library.storage,
          "state/roots/" + (await digest(utf8.encode(location))),
        ),
        renames,
        features: this.workspace.features,
      });
      if (vault.id !== id) throw Error("Selected vault identity changed");
    } catch (error) {
      await window.jockiVaults
        ?.release?.(location)
        .catch((cleanup) => logError(cleanup, "vault-open-cleanup"));
      throw error;
    }
    await this.workspace.update((d) => {
      d.computers[this.computer].vaults ??= structuredClone(
        this.workspace.settings(this.computer).vaults,
      );
      d.computers[this.computer].vaults![id] = location;
    });
    this.vaults.set(id, vault);
    await this.onVaultAdded(vault);
    this.extensions.didChangeVaultFolders([{ id, name: vault.name }], []);
    await this.extensions.activateEvent("onVaultOpen");
    if (this.sync) await this.sync.attach(vault);
  }
  add(privateName?: string) {
    return this.attemptOpen(() => this.addVault(privateName));
  }
  private async addVault(
    privateName?: string,
    chosen?: { location: string; name: string },
  ) {
    let location: string, name: string, fs: VaultFileSystem;
    if (chosen) {
      location = chosen.location;
      name = chosen.name;
      const selected = await vaultLocation(location, this.localRoot);
      if (!selected)
        throw Error("Select the vault folder again to grant access");
      fs = selected;
    } else if (privateName) {
      const selected = await createInternalVault(privateName);
      location = selected.location;
      name = selected.name;
      fs = (await vaultLocation(location, this.localRoot))!;
    } else if (window.jockiVaults) {
      const selected = await window.jockiVaults.select();
      if (!selected) return;
      location = selected.token;
      name = selected.name;
      fs = new BridgeFiles(window.jockiVaults, location);
    } else {
      const picker = (
        window as unknown as {
          showDirectoryPicker?: (options: {
            mode: string;
          }) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      if (!picker)
        throw Error(
          "This browser cannot open external folders. Create a browser vault or use the native app.",
        );
      const handle = await picker({ mode: "readwrite" });
      location = crypto.randomUUID();
      name = handle.name;
      await localCapability("vault:" + location, handle);
      fs = (await vaultLocation(location, this.localRoot))!;
    }
    const mountedId = Object.entries(
      this.workspace.settings(this.computer).vaults,
    ).find(([, token]) => token === location)?.[0];
    if (mountedId && this.vaults.has(mountedId))
      return this.vaults.get(mountedId)!;
    if (fs instanceof BrowserVaultFiles)
      for (const vault of this.vaults.values()) {
        const other = vault.fs;
        if (other instanceof BrowserVaultFiles) {
          if (await fs.root.isSameEntry(other.root)) return vault;
          if (
            (await fs.root.resolve(other.root)) ||
            (await other.root.resolve(fs.root))
          )
            throw Error(
              "Open separate vault folders; one vault cannot contain another open vault",
            );
        }
      }
    let vault: FileVault;
    try {
      const renames: RenameMatcher | undefined = window.jockiVaults?.renames
        ? {
            name: "libgit2",
            match: (a, b) => window.jockiVaults!.renames!(a, b),
          }
        : undefined;
      vault = await FileVault.open(fs, this.computer, {
        name,
        id: mountedId,
        lazy: true,
        local: localFiles(
          this.library.storage,
          "state/roots/" + (await digest(utf8.encode(location))),
        ),
        renames,
        features: this.workspace.features,
      });
    } catch (error) {
      await window.jockiVaults
        ?.release?.(location)
        .catch((cleanup) => logError(cleanup, "vault-open-cleanup"));
      throw error;
    }
    await this.workspace.update((d) => {
      d.computers[this.computer].vaults ??= structuredClone(
        this.workspace.settings(this.computer).vaults,
      );
      d.computers[this.computer].vaults![vault.id] = location;
      d.defaults.rootNames[vault.id] = vault.name;
    });
    this.vaults.set(vault.id, vault);
    await this.onVaultAdded(vault);
    this.extensions.didChangeVaultFolders(
      [{ id: vault.id, name: vault.name }],
      [],
    );
    await this.extensions.activateEvent("onVaultOpen");
    if (this.sync) await this.sync.attach(vault);
    return vault;
  }
  addSelectedVault(selection: { location: string; name: string }) {
    return this.addVault(undefined, selection);
  }
  async close(
    id: string,
    location = this.workspace.settings(this.computer).vaults[id],
  ) {
    for (const session of this.editors.sessions.values())
      if (session.vault === id && session.draft.dirty)
        throw Error("Save or discard this vault's drafts before closing it");
    for (const session of [...this.editors.sessions.values()])
      if (session.vault === id)
        await this.editors.close(id, session.id, true, session.instance);
    const vault = this.vaults.get(id);
    await this.workspace.update((d) => {
      d.computers[this.computer].vaults ??= structuredClone(
        this.workspace.settings(this.computer).vaults,
      );
      delete d.computers[this.computer].vaults![id];
    });
    this.vaults.delete(id);
    this.sync?.detach(id);
    if (location) await window.jockiVaults?.release?.(location);
    if (vault)
      this.extensions.didChangeVaultFolders([], [{ id, name: vault.name }]);
  }
  async activateExtensions() {
    this.packages = await FileExtensionPackages.open(this.library.storage);
    for (const pkg of this.packages.list()) {
      try {
        const verified = await this.packages.load(pkg.id);
        this.registerPackage(verified);
      } catch (error) {
        this.extensions.failures.set(pkg.id, String(error));
        logError(error, "extensions");
      }
    }
    const plugins = this.workspace.settings(this.computer).plugins;
    for (const manifest of this.extensions.manifests())
      if (
        (plugins[manifest.id] as { enabled?: boolean } | undefined)?.enabled ===
        false
      )
        await this.extensions.setEnabled(manifest.id, false);
    await this.extensions.activateEvent("onStartupFinished");
    if (this.vaults.size) await this.extensions.activateEvent("onVaultOpen");
    await this.offerTemplates();
  }
  private async resumeSync() {
    if (
      this.connection.broadcast ||
      this.workspace.features.sync ||
      [...this.vaults.values()].some((v) => v.syncActive)
    )
      await this.startSync();
  }
  async configureVault(vault: FileVault, policy: Partial<FileVault["policy"]>) {
    await this.configureScope(vault, "vault", "", policy);
  }
  async configureScope(
    vault: FileVault,
    kind: "vault" | "folder" | "file",
    target: string,
    policy: Partial<FileVault["policy"]>,
  ) {
    await vault.configureScope(kind, target, policy);
    if (vault.syncActive) await (await this.startSync()).attach(vault);
    // Keep disabled shares listed for open roots. Feature guards stop exchange;
    // closing the root, rather than changing an override, detaches its references.
    if (this.sync) {
      await this.sync.flush();
    }
  }
  async configureWorkspace(features: Partial<FileVault["policy"]>) {
    await this.workspace.configure(features);
    for (const vault of this.vaults.values()) {
      await vault.inheritFeatures(this.workspace.features);
      if (vault.syncActive) await (await this.startSync()).attach(vault);
    }
  }
  async joinShare(value: string, destination: FileVault, prefix?: string) {
    const sync = await this.startSync();
    return sync.join(value, destination, prefix);
  }
  assertWorkspaceCanChange() {
    if (
      [...this.editors.sessions.values()].some((session) => session.draft.dirty)
    )
      throw Error("Save or discard open drafts before switching workspaces");
  }
  async joinWorkspace(value: string, vaultLocations: Record<string, string>) {
    this.assertWorkspaceCanChange();
    const locations = this.workspace.settings(this.computer).vaults,
      sync = await this.startSync();
    await sync.joinWorkspace(value, this.computer, vaultLocations);
    await this.library.rememberCurrent();
    for (const id of [...this.vaults.keys()])
      if (!vaultLocations[id]) await this.close(id, locations[id]);
  }
  private registerPackage(
    verified: Awaited<ReturnType<FileExtensionPackages["load"]>>,
  ) {
    const manifest = verified.manifest;
    this.extensions.installVerified(manifest, async () => {
      if (window.jockiVaults?.sandboxedExtensions === false)
        throw Error(
          "Update Android System WebView before running file extensions",
        );
      const verified = await this.packages.load(manifest.id);
      const entry =
        manifest.entrypoints.browser ?? manifest.entrypoints.workspace;
      if (!entry)
        throw Error(
          "This extension requires an explicitly enabled native host",
        );
      return browserExtensionModule(
        manifest,
        new TextDecoder().decode(verified.files[entry]),
      );
    });
  }
  async installExtension(
    bytes: Uint8Array,
    trust: Record<string, string>,
    expected?: { id: string; version: string; sha256: string },
  ) {
    const verified = await this.packages.install(
      bytes,
      trust,
      expected,
      (manifest) => {
        if (manifest.id === "core" || manifest.id.startsWith("core."))
          throw Error("The core namespace is reserved for bundled features");
        if (
          this.extensions
            .installed()
            .some(
              (extension) =>
                extension.builtin && extension.manifest.id === manifest.id,
            )
        )
          throw Error("A package cannot replace a bundled extension");
      },
    );
    const previouslyInstalled = this.extensions
      .installed()
      .some((e) => e.manifest.id === verified.manifest.id);
    if (previouslyInstalled)
      await this.extensions.uninstall(verified.manifest.id);
    this.registerPackage(verified);
    if (!previouslyInstalled) await this.offerTemplates();
    await this.applyExtensionPreferences();
    await this.extensions.activateEvent("onStartupFinished");
    return verified.manifest;
  }
  async removeExtension(id: string) {
    if (this.extensions.installed().some((e) => e.manifest.id === id))
      await this.extensions.uninstall(id);
    await this.packages.remove(id);
  }
  async setExtensionEnabled(
    id: string,
    enabled: boolean | null,
    target = "defaults",
  ) {
    await this.workspace.update((d) => {
      const destination =
        target === "defaults" ? d.defaults : d.computers[target];
      destination.plugins ??= {};
      const section = (destination.plugins[id] ??= { configuration: {} }) as {
        enabled?: boolean | null;
      };
      section.enabled = enabled;
    });
    await this.applyExtensionPreferences();
  }
  private applyExtensionPreferences() {
    const pending = this.preferences.then(async () => {
      const settings = this.workspace.settings(this.computer).plugins;
      for (const extension of this.extensions.installed()) {
        const enabled =
          (settings[extension.manifest.id] as { enabled?: boolean } | undefined)
            ?.enabled !== false;
        if (enabled !== extension.enabled) {
          await this.extensions.setEnabled(extension.manifest.id, enabled);
          if (enabled) await this.extensions.activateEvent("onStartupFinished");
        }
      }
    });
    this.preferences = pending.catch(() => {});
    return pending;
  }
  /** Reconnect only the sync service; vaults, drafts and editor sessions stay open. */
  configureConnection(input: RepositorySettings) {
    const next = validateRepositorySettings(input);
    const changing = this.connectionQueue.then(async () => {
      if (this.closing) throw Error("This workspace is closing");
      const previous = await repositorySettings();
      if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
      const active = this.startingSync ? await this.startingSync : this.sync;
      await active?.flush();
      await saveRepositorySettings(next);
      if (!active && !next.broadcast) {
        this.connectionChanged(next);
        return next;
      }
      this.sync = undefined;
      this.startingSync = undefined;
      try {
        try {
          await active?.close();
        } finally {
          await active?.repository.close();
        }
        await this.openSync();
        this.connectionChanged(next);
      } catch (error) {
        try {
          await saveRepositorySettings(previous);
          await this.openSync();
          this.connectionChanged(previous);
        } catch (recovery) {
          throw new AggregateError(
            [error, recovery],
            "Could not change the sync connection or restore its previous connection",
          );
        }
        throw error;
      }
      return next;
    });
    this.connectionQueue = changing.then(
      () => {},
      () => {},
    );
    return changing;
  }
  startSync() {
    return this.connectionQueue.then(() => {
      if (this.closing) throw Error("This workspace is closing");
      return this.openSync();
    });
  }
  private openSync() {
    return (this.startingSync ??= (async () => {
      const { openBrowserRepository } = await import("./repository");
      const repository = await openBrowserRepository("jocki-file-repo");
      let sync: ProtectedFileSync | undefined;
      try {
        sync = await ProtectedFileSync.open(
          repository,
          this.library.storage,
          this.workspace,
          (error) => logError(error, "sync"),
        );
        for (const vault of this.vaults.values()) await sync.attach(vault);
        this.sync = sync;
        return sync;
      } catch (error) {
        try {
          await sync?.close();
        } finally {
          await repository.close();
        }
        throw error;
      }
    })().catch((error) => {
      this.startingSync = undefined;
      throw error;
    }));
  }
  async flush() {
    await Promise.all([
      this.workspace.flush(),
      ...[...this.vaults.values()].map((vault) => vault.flush()),
    ]);
    await this.sync?.flush();
    await this.logs.flush();
  }
}

export type LocalSelection = { location: string; name: string; path: string };
export type VaultSelection = {
  kind: "none" | "folder" | "internal";
  name: string;
  selected?: LocalSelection;
};
export type WorkspaceCreation = {
  kind: "folder" | "internal";
  name: string;
  selected?: LocalSelection;
  vault?: VaultSelection;
};
export type LauncherJoin = {
  link: string;
  workspace: WorkspaceCreation;
  vault?: VaultSelection;
  existing?: { workspace: string; id: string; location: string };
  children?: Record<string, VaultSelection>;
};

async function permitted(handle: FileSystemDirectoryHandle) {
  const access = handle as FileSystemDirectoryHandle & {
    queryPermission?(options: { mode: string }): Promise<string>;
    requestPermission?(options: { mode: string }): Promise<string>;
  };
  if (!access.queryPermission) return true;
  return (await access.queryPermission({ mode: "readwrite" })) === "granted";
}
async function browserRoot() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(
    "jocki",
    { create: true },
  );
}
async function vaultLocation(
  location: string,
  localRoot?: FileSystemDirectoryHandle,
): Promise<VaultFileSystem | undefined> {
  if (location.startsWith("internal:")) {
    const id = location.slice(9);
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw Error("Invalid internal vault location");
    if (window.jockiVaults)
      return scopedStorage(
        new BridgeFiles(window.jockiVaults, "workspace"),
        "vaults/" + id,
      );
    const parent = localRoot ?? (await browserRoot());
    return new BrowserVaultFiles(await parent.getDirectoryHandle(id), parent);
  }
  if (window.jockiVaults)
    return new BridgeFiles(window.jockiVaults, location);
  const handle = await localCapability<FileSystemDirectoryHandle>(
    "vault:" + location,
  );
  return handle && (await permitted(handle))
    ? new BrowserVaultFiles(
        handle,
        await localCapability<FileSystemDirectoryHandle>(
          "vault-parent:" + location,
        ),
        async () => {
          const picker = (
            window as unknown as {
              showDirectoryPicker?: (options: {
                mode: string;
              }) => Promise<FileSystemDirectoryHandle>;
            }
          ).showDirectoryPicker;
          if (!picker)
            throw Error(
              "Open the parent folder to manage this root’s companion",
            );
          const parent = await picker({ mode: "readwrite" });
          if ((await parent.resolve(handle))?.length !== 1)
            throw Error("Select the direct parent of " + handle.name);
          await localCapability("vault-parent:" + location, parent);
          return parent;
        },
      )
    : undefined;
}
async function resolveWorkspace(
  entry: SavedWorkspace,
): Promise<VaultFileSystem> {
  if (window.jockiVaults)
    return new BridgeFiles(window.jockiVaults, entry.root);
  const handle = await localCapability<FileSystemDirectoryHandle>(
    "workspace:" + entry.root,
  );
  if (!handle || !(await permitted(handle)))
    throw Error("Select the workspace folder again to grant access");
  return new BrowserVaultFiles(handle);
}
async function createInternalVault(name: string): Promise<LocalSelection> {
  if (!name.trim()) throw Error("Choose a vault name");
  const id = crypto.randomUUID();
  if (!window.jockiVaults)
    await (await browserRoot()).getDirectoryHandle(id, { create: true });
  return { location: "internal:" + id, name: name.trim(), path: "" };
}

/** The launcher retains the saved list and diagnostics, never an open workspace. */
export class VaultLauncher {
  private loadedCatalog?: WorkspaceCatalog;
  private loadError: unknown = Error("The saved workspace list is unavailable");
  private persistentLogs = false;
  private constructor(private currentLogs: LocalLogStore) {}
  get logs() {
    return this.currentLogs;
  }
  private get catalog() {
    if (!this.loadedCatalog) throw this.loadError;
    return this.loadedCatalog;
  }
  get capabilities() {
    return {
      workspaceFolder:
        !!window.jockiVaults?.selectWorkspace ||
        (!window.jockiVaults &&
          typeof (window as unknown as { showDirectoryPicker?: unknown })
            .showDirectoryPicker === "function"),
      vaultFolder:
        !!window.jockiVaults ||
        typeof (window as unknown as { showDirectoryPicker?: unknown })
          .showDirectoryPicker === "function",
    };
  }
  static async open() {
    // Keep the home screen and its diagnostics available even when device storage
    // or the saved list cannot be opened. No workspace data is reset or rewritten.
    const files = new Map<string, Uint8Array>();
    const launcher = new VaultLauncher(
      await LocalLogStore.open({
        read: async (path) => files.get(path),
        writeAtomic: async (path, bytes) => {
          files.set(path, bytes);
        },
        remove: async (path) => {
          files.delete(path);
        },
        list: async () => [...files.keys()],
      }),
    );
    launcher.logs.configure();
    try {
      await launcher.refresh();
    } catch (error) {
      logError(error, "startup");
    }
    return launcher;
  }
  list() {
    return this.loadedCatalog?.list() ?? [];
  }
  async refresh() {
    try {
      const { storage } = await workspaceStorage(false);
      if (!this.persistentLogs) {
        const logs = await LocalLogStore.open(storage);
        for (const record of await this.logs.list()) await logs.append(record);
        this.currentLogs = logs;
        this.persistentLogs = true;
      }
      this.logs.configure();
      try {
        this.loadedCatalog = await WorkspaceCatalog.open(
          storage,
          resolveWorkspace,
        );
      } catch (error) {
        throw Error(
          "Could not read the saved workspace list (workspaces.json).\n" +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    } catch (error) {
      this.loadError = error;
      throw error;
    } finally {
      await window.jockiVaults?.release?.("workspace");
    }
  }
  open(id: string) {
    return VaultRuntime.open(id, undefined, this.logs);
  }
  async selectWorkspace(create: boolean): Promise<LocalSelection | undefined> {
    const bridge = window.jockiVaults;
    if (bridge) {
      const result = await bridge.selectWorkspace?.(create);
      return result
        ? { location: result.token, name: result.name, path: result.path }
        : undefined;
    }
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (options: {
          mode: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (!picker)
      throw Error("Folder workspaces are unavailable in this browser");
    const handle = await picker({ mode: "readwrite" });
    let location: string = crypto.randomUUID();
    for (const entry of this.catalog
      .list()
      .filter((item) => item.kind === "folder")) {
      const prior = await localCapability<FileSystemDirectoryHandle>(
        "workspace:" + entry.root,
      );
      if (prior && (await handle.isSameEntry(prior))) {
        location = entry.root;
        break;
      }
    }
    await localCapability("workspace:" + location, handle);
    return {
      location,
      name: handle.name,
      path: handle.name + "/workspace.json",
    };
  }
  async selectVault(): Promise<LocalSelection | undefined> {
    if (window.jockiVaults) {
      const result = await window.jockiVaults.select();
      return result
        ? {
            location: result.token,
            name: result.name,
            path: result.path ?? result.name,
          }
        : undefined;
    }
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (options: {
          mode: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (!picker) throw Error("Folder vaults are unavailable in this browser");
    const handle = await picker({ mode: "readwrite" });
    const location = crypto.randomUUID();
    await localCapability("vault:" + location, handle);
    return { location, name: handle.name, path: handle.name };
  }
  async importWorkspace(selected: LocalSelection) {
    const release = await acquireWriter();
    const entry: SavedWorkspace = {
      id: crypto.randomUUID(),
      name: selected.name,
      kind: "folder",
      root: selected.location,
      path: selected.path,
    };
    try {
      const bytes = await (
        await resolveWorkspace(entry)
      ).read("workspace.json");
      if (!bytes) throw Error("No workspace.json exists in this folder");
      const doc = workspaceSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      entry.id = doc.id;
      entry.name = doc.name;
      await this.refresh();
      await this.catalog.register(entry);
      return entry.id;
    } finally {
      await window.jockiVaults?.release?.(selected.location);
      await window.jockiVaults?.release?.("workspace");
      await release();
    }
  }
  private async createDefinition(input: WorkspaceCreation) {
    await A.initializeWasm(wasmUrl);
    const { computer } = await workspaceStorage(true);
    const external = input.kind === "folder" ? input.selected : undefined;
    if (input.kind === "folder" && !external)
      throw Error("Choose a workspace file location");
    const entry: SavedWorkspace | undefined = external
      ? {
          id: crypto.randomUUID(),
          name: input.name,
          kind: "folder",
          root: external.location,
          path: external.path,
        }
      : undefined;
    const id = await this.catalog.create(
      computer!,
      input.name,
      entry
        ? {
            root: entry.root,
            path: entry.path,
            storage: await resolveWorkspace(entry),
          }
        : undefined,
    );
    return id;
  }
  private async createVault(runtime: VaultRuntime, input?: VaultSelection) {
    if (!input || input.kind === "none") return;
    const selected =
      input.kind === "internal"
        ? await createInternalVault(input.name)
        : input.selected;
    if (!selected) throw Error("Choose a vault folder");
    return runtime.addSelectedVault(selected);
  }
  async create(input: WorkspaceCreation | string) {
    if (typeof input === "string") input = { kind: "internal", name: input };
    let runtime: VaultRuntime | undefined;
    try {
      const release = await acquireWriter();
      let id: string;
      try {
        await this.refresh();
        id = await this.createDefinition(input);
      } finally {
        await release();
      }
      runtime = await this.open(id);
      await this.createVault(runtime, input.vault);
      return runtime;
    } catch (error) {
      await runtime?.shutdown();
      if (input.selected)
        await window.jockiVaults?.release?.(input.selected.location);
      throw error;
    } finally {
      await this.refresh();
    }
  }
  async inspect(link: string): Promise<ShareDocument> {
    const { openBrowserRepository } = await import("./repository");
    const connection = await repositorySettings();
    const release = await acquireWriter();
    let repository: Awaited<ReturnType<typeof openBrowserRepository>>;
    try {
      repository = await openBrowserRepository("jocki-file-repo", {
        endpoints: connection.endpoints,
      });
    } catch (error) {
      await release();
      throw error;
    }
    try {
      return A.toJS(
        (await ProtectedFileSync.inspect(repository, link)).doc(),
      ) as ShareDocument;
    } finally {
      try {
        await repository.close();
      } finally {
        await release();
      }
    }
  }
  async join(input: LauncherJoin) {
    const inspected = await this.inspect(input.link);
    let runtime: VaultRuntime | undefined;
    try {
      runtime = input.existing
        ? await this.open(input.existing.workspace)
        : await this.create({ ...input.workspace, vault: undefined });
      // Joining is an explicit request to connect; history remains independently controlled.
      await runtime.configureConnection({
        ...runtime.connectionSettings,
        broadcast: true,
      });
      if (inspected.kind === "workspace") {
        const locations: Record<string, string> = {};
        const { shareLink } = await import("../core/vaults/share-invitation");
        for (const [id, choice] of Object.entries(input.children ?? {})) {
          const child = inspected.vaults[id];
          if (!child) throw Error("Unknown shared vault destination");
          const vault = await this.createVault(runtime, choice);
          if (vault) {
            await runtime.joinShare(
              shareLink({
                format: "saddle-share-invitation/1",
                url: child.url,
                name: child.name,
                kind: "vault",
              }),
              vault,
            );
            locations[id] = runtime.workspace.settings(runtime.computer).vaults[
              vault.id
            ];
          }
        }
        await runtime.joinWorkspace(input.link, locations);
        await runtime.reopen();
        if (!Object.keys(input.children ?? {}).length)
          await this.createVault(runtime, input.workspace.vault);
      } else {
        let vault: FileVault | undefined;
        if (input.existing) {
          await runtime.mountKnownVault(
            input.existing.id,
            input.existing.location,
          );
          vault = runtime.vaults.get(input.existing.id);
        } else vault = await this.createVault(runtime, input.vault);
        if (!vault) throw Error("Choose a destination vault");
        await runtime.joinShare(input.link, vault);
      }
      await runtime.library.rememberCurrent();
      return runtime;
    } catch (error) {
      await runtime?.shutdown();
      throw error;
    } finally {
      await this.refresh();
    }
  }
  async references() {
    const { computer } = await workspaceStorage(true);
    const refs: Array<{
      workspace: string;
      workspaceName: string;
      id: string;
      location: string;
      name: string;
    }> = [];
    try {
      for (const entry of this.catalog.list()) {
        const doc = await this.catalog.read(entry.id);
        for (const [id, location] of Object.entries(
          resolveSettings(doc, computer!).vaults,
        )) {
          const fs = await vaultLocation(location);
          const name =
            resolveSettings(doc, computer!).rootNames[id] ?? location;
          refs.push({
            workspace: entry.id,
            workspaceName: doc.name,
            id,
            location,
            name,
          });
          await window.jockiVaults?.release?.(location);
        }
        if (entry.kind === "folder")
          await window.jockiVaults?.release?.(entry.root);
      }
      return refs;
    } finally {
      await window.jockiVaults?.release?.("workspace");
    }
  }
  async deletionPlan(id: string) {
    const entry = this.catalog.entry(id);
    const { computer } = await workspaceStorage(true);
    try {
      const doc = await this.catalog.read(id);
      const vaults = [];
      for (const [id, location] of Object.entries(
        resolveSettings(doc, computer!).vaults,
      )) {
        try {
          const fs = await vaultLocation(location);

          vaults.push({
            id,
            location,
            name: resolveSettings(doc, computer!).rootNames[id] ?? location,
            available: !!fs,
          });
        } catch {
          vaults.push({ id, location, name: location, available: false });
        } finally {
          await window.jockiVaults?.release?.(location);
        }
      }
      return { entry, name: doc.name, vaults };
    } finally {
      if (entry.kind === "folder")
        await window.jockiVaults?.release?.(entry.root);
      await window.jockiVaults?.release?.("workspace");
    }
  }
  async delete(
    id: string,
    name: string,
    workspace: boolean,
    vaultIds: string[],
  ) {
    const release = await acquireWriter();
    try {
      await this.refresh();
      return await this.deleteSelected(id, name, workspace, vaultIds);
    } finally {
      await release();
    }
  }
  private async deleteSelected(
    id: string,
    name: string,
    workspace: boolean,
    vaultIds: string[],
  ) {
    const plan = await this.deletionPlan(id);
    if (name !== plan.name) throw Error("Enter the workspace name exactly");
    if (vaultIds.some((id) => !plan.vaults.some((vault) => vault.id === id)))
      throw Error("Unknown vault selected for deletion");
    try {
      for (const vault of plan.vaults.filter((vault) =>
        vaultIds.includes(vault.id),
      )) {
        const fs = await vaultLocation(vault.location);
        if (!fs?.removeTree)
          throw Error("This platform cannot delete vault metadata");
        try {
          const packages = fs.scan
            ? (await fs.scan())
                .filter((entry) => entry.kind === "companion")
                .map((entry) => entry.path)
            : (await fs.list()).filter((path) => path.endsWith(".saddle"));
          for (const path of packages) await fs.removeTree(path);
          await fs.removeCompanionRoot?.();
        } finally {
          await window.jockiVaults?.release?.(vault.location);
        }
      }
      if (!workspace && vaultIds.length) {
        await A.initializeWasm(wasmUrl);
        const { computer } = await workspaceStorage(true);
        const fs = await this.catalog.resolve(plan.entry);
        const store = await WorkspaceStore.open(fs, computer!);
        await store.update((doc) => {
          const remaining = { ...store.settings(computer!).vaults };
          for (const id of vaultIds) delete remaining[id];
          doc.computers[computer!].vaults = remaining;
        });
      }
      if (workspace) {
        const fs = await this.catalog.resolve(plan.entry);
        await fs.remove("workspace.automerge");
        await fs.remove("workspace.json");
        await this.catalog.forget(id);
      }
    } finally {
      if (plan.entry.kind === "folder")
        await window.jockiVaults?.release?.(plan.entry.root);
      await window.jockiVaults?.release?.("workspace");
    }
  }
  async forget(id: string) {
    const entry = this.catalog.entry(id);
    if (entry.kind === "internal") {
      const plan = await this.deletionPlan(id);
      return this.delete(id, plan.name, true, []);
    }
    const release = await acquireWriter();
    try {
      await this.refresh();
      await this.catalog.forget(id);
    } finally {
      await window.jockiVaults?.release?.("workspace");
      await release();
    }
  }
}
async function workspaceStorage(identity: boolean) {
  const bridge = (window.jockiVaults ??= await (
    await import("./mobile-vaults")
  ).mobileVaultBridge());
  if (bridge) {
    const computer = identity ? (await bridge.workspace()).computer : undefined;
    return {
      storage: new BridgeFiles(bridge, "workspace"),
      computer,
      localRoot: undefined,
    };
  }
  const localRoot = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle("jocki", { create: true });
  const root = await localRoot.getDirectoryHandle("workspace", {
    create: true,
  });
  let computer: string | undefined;
  if (identity) {
    computer = await localCapability<string>("computer");
    if (!computer) {
      computer = crypto.randomUUID();
      await localCapability("computer", computer);
    }
  }
  return { storage: new BrowserVaultFiles(root), computer, localRoot };
}
