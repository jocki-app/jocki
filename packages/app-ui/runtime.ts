import { WorkspaceSettings } from "../core/workspace-settings";
import { DocumentProjection } from "../core/projection";
import { reportSyncError } from "../sync/errors";
import { TimerCoordinator } from "@jocki/platform/core/timers";
import type { RegisteredHome } from "@jocki/platform/plugin-sdk/navigation";
import { saveRecordFile } from "../core/files";
import { WorkspacePlugins } from "../core/workspace-plugins";
import { reconcilePluginActivation } from "../core/plugin-activation";
import {
  bindingFor,
  slotFor,
  configureExecution,
  inspectExecution,
  executionRecord,
  executionRequirements,
  executionReady,
  requireExecution,
} from "../core/execution";
import { OptimisticRecords, type OptimisticStore } from "../ui/optimistic";
import { notify } from "../ui/notifications";
import { releaseService } from "../core/services";
import type {
  ExecutionSlot,
  DevicePluginStatus,
} from "@jocki/platform/plugin-sdk/execution";
import {
  defaultInventoryUrl,
  readInventories,
  inventorySources,
  comparePluginVersions,
  boundedDownload,
  type PluginInventory,
  type InventoryEntry,
} from "@jocki/platform/plugin-sdk/inventory";
import {
  verifyArtifact,
  artifactHash,
  inventoryGrants,
} from "@jocki/platform/plugin-sdk/artifact";
import { isRequiredCore } from "@jocki/platform/core/catalog";
import { CacheDatabase, type Table } from "../data-duckdb/cache";
import { coalescedRefresh } from "../data-duckdb/refresh";
import { databasePlatform } from "../storage/database";
import { LocalDatabase } from "../data-duckdb";
import { PluginRegistry } from "@jocki/platform/core/registry";
import { getSchema, registerExtension } from "@jocki/platform/core/catalog";
import { CoreError, invariant } from "@jocki/platform/core/errors";
import type { Principal, ResourceRecord } from "@jocki/platform/plugin-sdk";
import { browserDevice, activateWorkspace } from "../platform-browser/device";
import type { DeviceCore, WorkspaceNode } from "../core/device";
import { deviceRecordId } from "../core/records";
import { ensureCollectionTables, scopedTableStore } from "./collection-tables";
import { WorkspaceSearch } from "./search-index";
import type {
  PluginCommand,
  SearchCollectionOptions,
} from "@jocki/platform/plugin-sdk/navigation";
import { membership } from "../core/membership";
import { workflowTriggers, reminders, operationId } from "../core/schedules";
import { PortableWorkflows } from "../core/workflows";
import { runBrowserTypeScript } from "../platform-browser/typescript";
import { SyncQueue } from "../sync/queue";
import {
  createBrowserPluginHost,
  type ExtensionContract,
  type Surface,
} from "./plugin-host";
import type { PluginHost } from "@jocki/platform/core/host";

export interface WorkspaceProfile {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  /** Device-local save name; never included in workspace replication or exports. */
  localName?: string;
  serverUrl: string;
  connected: boolean;
}
class Bootstrap extends CacheDatabase {
  declare profiles: Table<WorkspaceProfile, string>;
  constructor() {
    super("jocki-workspace-graph-profiles", { profiles: { key: "id" } });
  }
}
export class AppRuntime {
  private pluginQueue: Promise<unknown> = Promise.resolve();
  private pluginSelectionKey = "";
  private withPluginChanges<T>(work: () => Promise<T>) {
    const next = this.pluginQueue.then(work);
    this.pluginQueue = next.catch(() => {});
    return next;
  }
  private async reconcileWorkspacePlugins() {
    return this.withPluginChanges(async () => {
      if (this.closed) return;
      const workspace = new WorkspacePlugins(this.node.replica);
      const choices = workspace.choices();
      const key = JSON.stringify([...choices].sort());
      if (key === this.pluginSelectionKey) return;
      const errors = await reconcilePluginActivation(
        this.registry,
        choices,
        async (id) => {
          if (
            !this.installedPackage(id) &&
            !this.availablePlugins.some((p) => p.id === id)
          )
            await this.refreshInventory();
          await this.ensurePackage(id, undefined, true);
          await this.contractsReady;
        },
      );
      await this.refreshHost();
      await ensureCollectionTables(this);
      if (errors.size)
        this.inventoryError = [...errors]
          .map(([id, error]) => `${id}: ${error}`)
          .join("; ");
      else {
        this.pluginSelectionKey = key;
        this.inventoryError = "";
      }
      this.notifySurfaces();
    });
  }
  get workspaceName() {
    return this.node
      ? membership(this.node.replica.access).name
      : this.profile.name;
  }
  readonly optimistic: OptimisticRecords;
  optimisticStore<T extends OptimisticStore>(
    collection: string,
    source: T,
    scope = "app",
  ) {
    return this.optimistic.wrap(getSchema(collection), source, scope);
  }
  readonly db: LocalDatabase;
  readonly registry: PluginRegistry;
  readonly principal: Principal;
  device!: DeviceCore;
  node!: WorkspaceNode;
  automation!: PortableWorkflows;
  automationOptions = { enabled: false, trustedCode: false };
  allowRemotePlugins = false;
  private projectionQueue: Promise<unknown> = Promise.resolve();
  private pendingProjection?: Promise<void>;
  private recordProjection?: DocumentProjection;
  private projectionListener?: (id: string) => void;
  private projectionRefresh?: ReturnType<typeof coalescedRefresh>;
  private syncQueue = new SyncQueue();
  private pendingWrites = new Set<Promise<unknown>>();
  private maintenance = false;
  /** Keep compound saves alive until the workspace can safely close. */
  async writeOperation<T>(work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work);
    this.pendingWrites.add(operation);
    try {
      return await operation;
    } finally {
      this.pendingWrites.delete(operation);
    }
  }
  /** Wait for compound UI saves before exporting or relocating their durable workspace. */
  async flushWrites() {
    while (this.pendingWrites.size) await Promise.all([...this.pendingWrites]);
  }
  readonly timers = new TimerCoordinator({
    load: async () =>
      this.node?.replica.computerSettings.get<
        import("@jocki/platform/plugin-sdk/timers").SubmittedTimer[]
      >("timers.local") ?? [],
    save: (timers) =>
      this.node.replica.computerSettings.set("timers.local", timers),
  });
  readonly homeDestinations = new Map<string, RegisteredHome>();
  private homeQueue: Promise<unknown> = Promise.resolve();
  chooseInitialHome(key: string) {
    this.homeQueue = this.homeQueue
      .then(async () => {
        if (
          this.homeDestinations.has(key) &&
          this.node.records.canWrite() &&
          new WorkspaceSettings(this.node.replica).read().home === null
        ) {
          await new WorkspaceSettings(this.node.replica).setHome(key);
          await this.project();
        }
      })
      .catch(notify.error);
  }
  setHome(key: string) {
    const work = this.homeQueue.then(async () => {
      await new WorkspaceSettings(this.node.replica).setHome(key);
      await this.project();
    });
    this.homeQueue = work.catch(() => {});
    return work;
  }
  readonly surfaces = new Map<string, Surface>();
  readonly commands = new Map<string, PluginCommand & { pluginId: string }>();
  readonly searchOptions = new Map<string, SearchCollectionOptions>();
  readonly search = new WorkspaceSearch(this);
  navigate: (
    pluginId: string,
    page?: string,
    recordId?: string,
  ) => void | Promise<void> = () => {};
  readonly surfaceListeners = new Set<() => void>();
  surfacesVersion = 0;
  private host?: PluginHost;
  private hostState = "";
  private extensions: ExtensionContract[] = [];
  installedPackage(id: string) {
    return this.extensions.find((extension) => extension.manifest.id === id);
  }
  availablePlugins: InventoryEntry[] = [];
  inventoryUrls = [
    import.meta.env.VITE_PLUGIN_INVENTORY_URL || defaultInventoryUrl,
  ];
  inventoryError = "";
  private inventory?: PluginInventory;
  get inventoryPending() {
    return !this.inventory && !this.inventoryError;
  }
  private closed = false;
  assertActive() {
    invariant(!this.closed, "WORKSPACE_CLOSED", "This workspace is closed");
  }
  async refreshInventory() {
    try {
      const inventory = await readInventories(this.inventoryUrls, {
        allowHttp: import.meta.env.DEV,
        followRedirects: true,
      });
      if (this.closed) return;
      await this.db.setMetadata("core.inventory", inventory);
      this.inventory = inventory;
      this.availablePlugins = inventory.plugins;
      this.inventoryError = "";
    } catch (error) {
      this.inventoryError =
        error instanceof Error ? error.message : "Plugin inventory unavailable";
    }
    this.notifySurfaces();
  }
  async saveInventorySources(input: unknown) {
    const urls = inventorySources(input, import.meta.env.DEV);
    const inventory = await readInventories(urls, {
      allowHttp: import.meta.env.DEV,
      followRedirects: true,
    });
    this.assertActive();
    await this.db.transaction("rw", this.db.metadata, async (tx) => {
      await tx.setMetadata("core.inventorySources", urls);
      await tx.setMetadata("core.inventory", inventory);
    });
    this.inventoryUrls = urls;
    this.inventory = inventory;
    this.availablePlugins = inventory.plugins;
    this.inventoryError = "";
    this.notifySurfaces();
  }
  private contractsReady: Promise<void> = Promise.resolve();
  private registerPackages(extensions: ExtensionContract[]) {
    for (const extension of extensions) {
      const { manifest } = registerExtension(
        extension.manifest,
        extension.schemas,
      );
      this.registry.manifests.set(manifest.id, manifest);
    }
    this.extensions = extensions;
    this.contractsReady = this.contractsReady.then(async () => {
      await window.jockiNative?.repository.extensions(extensions);
    });
  }
  private async ensurePackage(
    id: string,
    reviewedDigest?: string,
    useInstalled = false,
  ) {
    if (isRequiredCore(id)) return;
    const existing = this.extensions.find((e) => e.manifest.id === id);
    const entry = this.availablePlugins.find((p) => p.id === id);
    if (reviewedDigest)
      invariant(
        (useInstalled
          ? existing?.digest
          : (entry?.sha256 ?? existing?.digest)) === reviewedDigest,
        "INVENTORY_CHANGED",
        "The release changed; review it again",
      );
    if (
      existing &&
      (useInstalled || !entry || existing.digest === entry.sha256) &&
      (!existing.manifest.entrypoints.browser ||
        (await this.db.getMetadata(`extension.source.${existing.digest}`))) &&
      (!existing.manifest.entrypoints.core ||
        (await this.db.getMetadata(`extension.core.${existing.digest}`)))
    )
      return;
    invariant(
      entry && this.inventory,
      "PLUGIN_NOT_FOUND",
      "Refresh the inventory to find this plugin",
    );
    const bytes = await boundedDownload(entry.downloadUrl, 50 * 1024 * 1024, {
      allowHttp: import.meta.env.DEV,
      followRedirects: true,
    });
    const verified = await verifyArtifact(
      bytes,
      this.inventory.publishers,
      entry,
    );
    await this.storePackage(verified, entry.grants);
  }
  private async storePackage(
    verified: Awaited<ReturnType<typeof verifyArtifact>>,
    grants: string[],
  ) {
    const browser = verified.manifest.entrypoints.browser,
      core = verified.manifest.entrypoints.core;
    const extension: ExtensionContract = {
      manifest: verified.manifest,
      schemas: verified.contracts,
      grants,
      digest: verified.digest,
      coreDigest: core ? await artifactHash(verified.files[core]) : undefined,
      browserDigest: browser
        ? await artifactHash(verified.files[browser])
        : undefined,
    };
    const extensions = [
      ...this.extensions.filter((e) => e.manifest.id !== verified.manifest.id),
      extension,
    ];
    await this.db.transaction("rw", this.db.metadata, async (tx) => {
      if (core)
        await tx.setMetadata(
          `extension.core.${extension.digest}`,
          new TextDecoder().decode(verified.files[core]),
        );
      if (browser)
        await tx.setMetadata(
          `extension.source.${extension.digest}`,
          new TextDecoder().decode(verified.files[browser]),
        );
      await tx.setMetadata("core.extensions", extensions);
    });
    this.registerPackages(extensions);
  }
  async importPlugin(bytes: Uint8Array) {
    this.assertActive();
    invariant(
      this.node.records.canWrite(),
      "PERMISSION_DENIED",
      "Write access is required to install plugins",
    );
    const verified = await verifyArtifact(
      bytes,
      this.inventory?.publishers ?? {},
    );
    await this.withPluginChanges(async () => {
      this.assertActive();
      const previous = this.installedPackage(verified.manifest.id);
      const owner =
        previous?.manifest.publisher ??
        this.availablePlugins.find((entry) => entry.id === verified.manifest.id)
          ?.publisher ??
        this.registry.manifests.get(verified.manifest.id)?.publisher;
      invariant(
        !owner || owner === verified.manifest.publisher,
        "PUBLISHER_CONFLICT",
        "A different publisher already owns this plugin ID",
      );
      if (previous) {
        invariant(
          comparePluginVersions(
            verified.manifest.version,
            previous.manifest.version,
          ) >= 0,
          "VERSION_DOWNGRADE",
          "Plugin downgrades require an explicit data migration",
        );
        invariant(
          verified.manifest.version !== previous.manifest.version ||
            verified.digest === previous.digest,
          "VERSION_CONFLICT",
          "Publish changed packages with a new version",
        );
      }
      await this.storePackage(verified, inventoryGrants(verified.manifest));
    });
    for (const dependency of verified.manifest.dependencies)
      if (!this.registry.enabled(dependency))
        await this.installAndEnable(dependency);
    await this.pluginAction(
      verified.manifest.id,
      "install",
      verified.digest,
      true,
    );
    await this.pluginAction(verified.manifest.id, "enable");
    return verified.manifest;
  }
  async callPluginCommand(pluginId: string, command: string, input: unknown) {
    const manifest = this.registry.manifests.get(pluginId),
      extension = this.extensions.find((e) => e.manifest.id === pluginId);
    invariant(
      manifest && this.registry.enabled(pluginId),
      "FEATURE_DISABLED",
      "Plugin is disabled",
    );
    invariant(
      manifest.provides.commands.includes(command) ||
        (manifest.consumes.commands.includes(command) &&
          extension?.grants.includes(command)),
      "UNDECLARED_COMMAND",
      "Declare and grant this command",
    );
    invariant(this.host, "PLUGIN_UNAVAILABLE", "Plugin host is unavailable");
    const principal = {
      ...this.principal,
      pluginId,
      permissions: [
        ...manifest.permissions,
        this.host.router.permissionFor(command) ?? command,
      ],
    };
    const request = {
      jsonrpc: "2.0" as const,
      id: crypto.randomUUID(),
      method: command,
      params: input,
    };
    const response =
      this.host.router.has(command) &&
      !executionRecord(this.node, command, input)
        ? await this.host.router.receive(request, {
            principal,
            signal: AbortSignal.timeout(30000),
          })
        : await this.api<{ result?: unknown; error?: { message: string } }>(
            "rpc",
            {
              context: { workspaceId: this.profile.workspaceId, pluginId },
              request,
            },
          );
    invariant(
      response && "result" in response,
      "COMMAND_FAILED",
      response && "error" in response
        ? (response.error?.message ?? "Core command failed")
        : "Core command failed",
    );
    return response.result;
  }
  notifySurfaces() {
    this.surfacesVersion++;
    for (const listener of this.surfaceListeners) listener();
  }
  private async refreshHost() {
    const key = JSON.stringify([
      [...this.registry.states.values()].map((s) => [
        s.id,
        s.version,
        s.enabled,
        s.features,
      ]),
      this.extensions.map((e) => e.digest),
    ]);
    if (this.closed || (this.host && key === this.hostState)) return;
    await this.host?.close();
    this.surfaces.clear();
    this.notifySurfaces();
    this.host = await createBrowserPluginHost(this, this.extensions);
    this.hostState = key;
  }
  constructor(public readonly profile: WorkspaceProfile) {
    this.optimistic = new OptimisticRecords({
      workspaceId: this.profile.workspaceId,
      ownerId: this.profile.userId,
      saved: (id) => this.node?.records.get(id),
      error: notify.error,
      track: (work) => this.writeOperation(work),
    });

    this.db = new LocalDatabase(profile.workspaceId, profile.userId);
    this.registry = new PluginRegistry(this.db.pluginPersistence());
    this.principal = {
      userId: profile.userId,
      workspaceId: profile.workspaceId,
      pluginId: "records",
      permissions: [],
    };
  }

  async initialize(onProgress: (message: string) => void = () => {}) {
    let stage = "Connecting to local storage…";
    try {
      return await this.initializeWorkspace((message) => {
        stage = message;
        onProgress(message);
      });
    } catch (error) {
      throw reportSyncError(error, {
        phase: "workspace-open",
        operation: stage,
        workspaceId: this.profile.workspaceId,
      });
    }
  }
  private async initializeWorkspace(onProgress: (message: string) => void) {
    onProgress("Connecting to local storage…");
    this.device = await browserDevice();
    onProgress(`Opening storage for ${this.profile.name}…`);
    await activateWorkspace(this.profile.workspaceId);
    onProgress("Loading plugin definitions…");
    const extensions =
      (await this.db.getMetadata<ExtensionContract[]>("core.extensions")) ?? [];
    this.registerPackages(extensions);
    this.inventory =
      await this.db.getMetadata<PluginInventory>("core.inventory");
    this.availablePlugins = this.inventory?.plugins ?? [];
    this.inventoryUrls =
      (await this.db.getMetadata<string[]>("core.inventorySources")) ??
      this.inventoryUrls;
    await this.contractsReady;
    onProgress("Starting workspace services…");
    this.node = await this.device.workspace(
      this.profile.workspaceId,
      undefined,
      onProgress,
    );
    if (window.jockiNative?.repository)
      await window.jockiNative.repository.activate(this.node.link);
    this.node.startAutomaticSync();
    this.profile.connected = true;
    this.profile.userId = this.node.replica.member.userId;
    this.principal.userId = this.profile.userId;
    this.principal.deviceId = deviceRecordId(this.device.identity.id);
    this.automationOptions =
      this.node.replica.computerSettings.get("device.automation") ??
      this.automationOptions;
    this.allowRemotePlugins =
      this.node.replica.computerSettings.get<boolean>("device.remotePlugins") ??
      false;
    this.device.setCapabilities(() => [
      "core.plugins.status",
      "core.services.release",
      ...(this.allowRemotePlugins ? ["core.plugins.install"] : []),
      ...(this.automationOptions.enabled && this.automationOptions.trustedCode
        ? ["automation.typescript"]
        : []),
      "records.storage",
      "files.storage",
      "credentials.refresh",
      ...(this.automationOptions.enabled
        ? ["automation.*", "automation.execute"]
        : []),
    ]);
    this.db.replicaBridge = {
      canWrite: () => this.node.records.canWrite(),
      put: async (collection, data, id, managedBy) =>
        this.writeOperation(async () => {
          await this.contractsReady;
          const record = await this.node.records.put(collection, data, id, {
            managedBy,
          });
          const slot = slotFor(record);
          if (
            slot?.targetField &&
            typeof record.data[slot.targetField] === "string"
          ) {
            const current = bindingFor(this.node, slot, record.id);
            const enabled = slot.enabledField
              ? record.data[slot.enabledField] === true
              : (current?.enabled ?? false);
            if (
              !current ||
              deviceRecordId(current.deviceId) !==
                record.data[slot.targetField] ||
              current.enabled !== enabled
            )
              await configureExecution(
                this.node,
                record,
                slot,
                String(record.data[slot.targetField]),
                enabled,
              );
          }
          await this.project();
          return this.node.records.get(record.id)!;
        }),
      delete: async (id) =>
        this.writeOperation(async () => {
          await this.node.records.delete(id);
          await this.project();
        }),
      saveFile: async (id, blob, parent) =>
        this.optimistic.whileSaving(id, async () => {
          const version = await saveRecordFile(
            this.node,
            id,
            new Uint8Array(await blob.arrayBuffer()),
            blob.type || "application/octet-stream",
            parent,
          );
          await this.project();
          return version.id;
        }),
    };
    const invalidated = new Set<string>();
    const projectionFailed = (error: unknown) => {
      this.node.replica.error = reportSyncError(error, {
        phase: "ui-projection",
        workspaceId: this.profile.workspaceId,
      }).message;
      this.notifySurfaces();
    };
    this.projectionRefresh = coalescedRefresh(async () => {
      const changed = [...invalidated];
      invalidated.clear();
      if (
        changed.some(
          (id) =>
            !id ||
            (id.startsWith("record/") &&
              ["item_schemas", "tables"].includes(
                this.node.records.get(id.slice(7))?.collection ?? "",
              )),
        )
      )
        await ensureCollectionTables(this);
      await this.project();
      for (const id of changed) {
        if (id.startsWith("event/") && this.host) {
          const event =
            this.node.replica.read<
              import("@jocki/platform/plugin-sdk").PluginEvent
            >(id);
          if (event) {
            try {
              await this.host.deliver(event);
            } catch (error) {
              projectionFailed(error);
            }
          }
        }
      }
    }, projectionFailed);
    this.projectionListener = (id) => {
      invalidated.add(id);
      this.projectionRefresh!();
    };
    this.node.replica.listeners.add(this.projectionListener);
    onProgress("Loading workspace data…");
    await this.project();
    onProgress("Loading workspace plugins…");
    await this.registry.initialize();
    await this.reconcileWorkspacePlugins();
    await this.refreshHost();
    this.automation = new PortableWorkflows(
      this.node,
      {
        deviceId: this.principal.deviceId!,
        canRun: async (execution) => {
          const run = this.node.records.get(execution.id),
            record = run && this.node.records.get(String(run.data.workflow_id));
          return Boolean(
            record &&
            executionReady(record, slotFor(record)!, this.pluginDeviceStatus()),
          );
        },
        call: async (command, input, operationId) => {
          const routed = executionRecord(this.node, command, input);
          if (routed)
            await requireExecution(this.node, routed.record, routed.slot);
          invariant(
            this.host?.router.has(command),
            "CAPABILITY_UNSUPPORTED",
            "This device does not provide the workflow command",
          );
          const result = await this.host!.router.receive(
            { jsonrpc: "2.0", id: operationId, method: command, params: input },
            {
              principal: {
                ...this.principal,
                permissions: [
                  this.host!.router.permissionFor(command) ?? command,
                ],
              },
              signal: AbortSignal.timeout(30000),
              mutationId: operationId,
            },
          );
          invariant(
            result && "result" in result,
            "COMMAND_FAILED",
            result?.error?.message ?? "Workflow command failed",
          );
          return result.result as import("@jocki/platform/field-types").Value;
        },
        typescript: async (source, input) => {
          invariant(
            this.automationOptions.trustedCode,
            "PERMISSION_DENIED",
            "Trusted TypeScript was disabled",
          );
          return runBrowserTypeScript(source, input);
        },
      },
      () => this.automationOptions,
    );
    this.node.protocol.setHandler(async (command, input, context) => {
      if (
        window.jockiNative?.repository &&
        (command.startsWith("terminal.") || command === "core.http")
      )
        return window.jockiNative.repository.execute(
          this.profile.workspaceId,
          command,
          input,
          context,
        );
      if (command === "core.plugins.status") return this.pluginDeviceStatus();
      if (command === "core.plugins.install") {
        invariant(
          this.allowRemotePlugins,
          "CAPABILITY_UNSUPPORTED",
          "Allow remote plugin installation on this device first",
        );
        const policy = membership(this.node.replica.access);
        invariant(
          policy.members[context.deviceId]?.access === "write",
          "PERMISSION_DENIED",
          "Write access is required to install plugins",
        );
        const pin = input as {
          id: string;
          version: string;
          sha256: string;
          grants: string[];
        };
        await this.refreshInventory();
        const entry = this.availablePlugins.find((p) => p.id === pin.id);
        invariant(
          entry && entry.version === pin.version && entry.sha256 === pin.sha256,
          "INVENTORY_CHANGED",
          "The plugin release changed; review it again",
        );
        invariant(
          entry.grants.every((g) => pin.grants.includes(g)),
          "PERMISSION_DENIED",
          "Review the required permissions",
        );
        await this.pluginAction(pin.id, "install", pin.sha256);
        await this.pluginAction(pin.id, "enable");
        return { ok: true };
      }
      if (command === "core.services.release") {
        const request = input as {
          id: string;
          token: string;
          successor?: { deviceId: string; generation: string };
        };
        invariant(
          request.id.startsWith("execution."),
          "UNSUPPORTED_SERVICE",
          "This app only hosts per-item execution",
        );
        await releaseService(
          this.node,
          request.id,
          request.token,
          () => this.automation.releaseWorkflow(request.id.split(".")[1]),
          request.successor,
        );
        return { ok: true };
      }
      if (command === "credentials.refresh") {
        const request = input as {
          id: string;
          pluginId: string;
          destination: string;
        };
        await this.node.vault.refresh(
          request.id,
          request.pluginId,
          request.destination,
        );
        return { ok: true };
      }
      if (
        !command.startsWith("automation.") &&
        this.host?.router.has(command)
      ) {
        const routed = executionRecord(this.node, command, input);
        if (routed)
          await requireExecution(this.node, routed.record, routed.slot);
        const member = membership(this.node.replica.access).members[
          context.deviceId
        ];
        const response = await this.host.router.receive(
          {
            jsonrpc: "2.0",
            id: context.requestId,
            method: command,
            params: input,
          },
          {
            principal: {
              ...this.principal,
              userId: member.userId,
              deviceId: deviceRecordId(context.deviceId),
              permissions: [this.host.router.permissionFor(command) ?? command],
            },
            signal: AbortSignal.timeout(30000),
            mutationId: context.requestId,
          },
        );
        invariant(
          response && "result" in response,
          "COMMAND_FAILED",
          response?.error?.message ?? "Plugin command failed",
        );
        return response.result;
      }
      return this.localAutomation(command, input as Record<string, any>);
    });
    void this.refreshInventory()
      .then(async () => {
        if (this.closed) return;
        // Former built-ins keep their installed/enabled state and stored records.
        for (const state of this.registry.states.values())
          if (
            state.installed &&
            !isRequiredCore(state.id) &&
            !this.extensions.some((e) => e.manifest.id === state.id)
          ) {
            try {
              await this.ensurePackage(state.id);
            } catch (error) {
              this.inventoryError =
                error instanceof Error ? error.message : String(error);
            }
          }
        await this.refreshHost();
        this.notifySurfaces();
      })
      .catch((error) => {
        this.inventoryError = String(error);
        this.notifySurfaces();
      });
    await ensureCollectionTables(this);
    await this.reconcileWorkspacePlugins();
    return this;
  }
  pluginDeviceStatus(): DevicePluginStatus {
    return {
      deviceId: this.device.identity.id,
      capabilities: this.node.protocol.capabilities(),
      canInstall: this.allowRemotePlugins,
      plugins: this.registry.list().map(({ manifest, state }) => ({
        id: manifest.id,
        version: state.version,
        installed: state.installed,
        enabled: state.enabled,
        ...((state.error ?? this.host?.failures.get(manifest.id))
          ? { error: state.error ?? this.host?.failures.get(manifest.id) }
          : {}),
      })),
    };
  }
  async configureRemotePlugins(enabled: boolean) {
    this.allowRemotePlugins = enabled;
    await this.node.replica.computerSettings.set(
      "device.remotePlugins",
      enabled,
    );
    this.notifySurfaces();
  }
  async configureItemExecution(
    record: ResourceRecord,
    slot: ExecutionSlot,
    deviceId: string,
    enabled: boolean,
  ) {
    await configureExecution(this.node, record, slot, deviceId, enabled);
    await this.project();
    await this.node.synchronize();
    this.notifySurfaces();
  }
  async executionInstallPlan(
    record: ResourceRecord,
    slot: ExecutionSlot,
    deviceId: string,
  ) {
    await this.refreshInventory();
    const status = (
      await inspectExecution(this.node, record, slot)
    ).candidates.find((p) => p.id === deviceId || p.recordId === deviceId);
    invariant(
      status?.online && status.statusKnown,
      "DEVICE_UNAVAILABLE",
      "Connect the execution computer before installing plugins",
    );
    invariant(
      status.canInstall,
      "CAPABILITY_UNSUPPORTED",
      "Allow remote plugin installation on that computer first",
    );
    const plan: InventoryEntry[] = [],
      seen = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      invariant(
        !visiting.has(id),
        "DEPENDENCY_CYCLE",
        "Plugin dependencies contain a cycle",
      );
      visiting.add(id);
      const entry = this.availablePlugins.find((p) => p.id === id);
      if (!entry) {
        invariant(
          isRequiredCore(id),
          "PLUGIN_NOT_FOUND",
          `${id} is missing from the plugin inventory`,
        );
        return;
      }
      for (const dependency of entry.dependencies) visit(dependency);
      const installed = status.plugins.find((p) => p.id === id);
      if (
        !installed?.installed ||
        !installed.enabled ||
        installed.version !== entry.version ||
        installed.error
      )
        plan.push(entry);
      visiting.delete(id);
      seen.add(id);
    };
    for (const requirement of executionRequirements(slot, record).plugins) {
      if (requirement.version)
        invariant(
          this.availablePlugins.find((p) => p.id === requirement.id)
            ?.version === requirement.version,
          "PLUGIN_VERSION_UNAVAILABLE",
          `The inventory does not offer required ${requirement.id}@${requirement.version}`,
        );
      visit(requirement.id);
    }
    return plan;
  }
  async installExecutionPlugins(deviceId: string, plan: InventoryEntry[]) {
    for (const entry of plan)
      await this.node.call(
        "core.plugins.install",
        {
          id: entry.id,
          version: entry.version,
          sha256: entry.sha256,
          grants: entry.grants,
        },
        deviceId,
      );
    await this.node.synchronize();
    this.notifySurfaces();
  }
  async configureAutomation(value: { enabled: boolean; trustedCode: boolean }) {
    this.automationOptions = value;
    await this.node.replica.computerSettings.set("device.automation", value);
    await this.announce();
    this.notifySurfaces();
  }
  private localAutomation(command: string, input: Record<string, any>) {
    invariant(
      !this.closed && this.automationOptions.enabled,
      "CAPABILITY_UNSUPPORTED",
      "Automation execution is disabled on this device",
    );
    if (command === "automation.run") {
      const record = this.node.records.get(input.id);
      invariant(record, "NOT_FOUND", "Automation not found");
      const slot = slotFor(record)!;
      invariant(
        executionReady(record, slot, this.pluginDeviceStatus()),
        "PLUGIN_NOT_READY",
        "Enable the required plugins and capabilities on the execution computer",
      );
      return this.automation.start(
        input as Parameters<PortableWorkflows["start"]>[0],
      );
    }
    if (command === "automation.cancel")
      return this.automation.cancel(input.id).then(() => ({ ok: true }));
    if (command === "automation.signal")
      return this.automation.signal(input.id, input.name, input.data);
    throw new CoreError(
      "CAPABILITY_UNSUPPORTED",
      "This operation needs a different device capability",
    );
  }
  private lastAnnouncement = 0;
  private async announce() {
    if (
      !window.jockiNative &&
      this.node.records.canWrite() &&
      Date.now() - this.lastAnnouncement > 30000
    ) {
      const platform = window.jockiNative
        ? "desktop"
        : (await import("@capacitor/core")).Capacitor.getPlatform();
      const data = {
          name: window.jockiNative
            ? "This computer (app)"
            : this.device.identity.name,
          platform: platform === "web" ? "browser" : platform,
          capabilities: this.node.protocol.capabilities(),
        },
        old = this.node.records.get(this.principal.deviceId!);
      if (
        !old ||
        Object.entries(data).some(
          ([key, value]) =>
            JSON.stringify(old.data[key]) !== JSON.stringify(value),
        )
      )
        await this.node.records.put(
          "devices",
          { ...data, last_seen: new Date().toISOString() },
          this.principal.deviceId,
        );
      this.lastAnnouncement = Date.now();
    }
  }
  collection(id: string, allTables = false) {
    const source = this.optimisticStore(id, this.savedCollection(id, true));
    return allTables ? source : scopedTableStore(this, id, source);
  }
  /** Durable-only services for core/background plugin work. */
  savedCollection(id: string, allTables = false) {
    this.assertActive();
    const schema = getSchema(id);
    const source = this.db
      .scoped(
        { ...this.principal, pluginId: schema.pluginId },
        schema.pluginId,
        this.profile.connected ? "synced" : "local-only",
      )
      .collection(id);
    return allTables ? source : scopedTableStore(this, id, source, false);
  }
  private projectedHome?: string | null;
  async project() {
    // Queued refreshes all read the latest replica when they start. Share that
    // pass, but schedule another if a change arrives while one is running.
    if (this.pendingProjection) return this.pendingProjection;
    const work = async () => {
      this.pendingProjection = undefined;
      if (this.closed || !this.node) return;
      const home = new WorkspaceSettings(this.node.replica).read().home;
      if (this.projectedHome !== home) {
        await this.db.setMetadata("navigation.home", home);
        this.projectedHome = home;
      }
      this.recordProjection ??= new DocumentProjection(
        this.node.replica,
        {
          // UI records are volatile. Reconstruct this cache on every mount;
          // durable SQL rows/checkpoints belong to the core projection.
          load: async () =>
            (await this.db.records.toCollection().primaryKeys()).map((id) => ({
              id: "record/" + id,
              source: "",
              heads: [],
              contract: "",
            })),
          apply: async (batch) => {
            const obsolete = batch.removed
              .filter((id) => id.startsWith("record/"))
              .map((id) => id.slice(7));
            const changed = batch.documents
              .filter((doc) => doc.id.startsWith("record/"))
              .flatMap((doc) => {
                const record = this.node.records.get(doc.id.slice(7));
                return record ? [record] : [];
              });
            if (!obsolete.length && !changed.length) return;
            await this.db.transaction(
              "rw",
              this.db.records,
              this.db.searchDocuments,
              async (tx) => {
                if (obsolete.length) await tx.records.bulkDelete(obsolete);
                const removedSearch = [
                  ...obsolete,
                  ...changed
                    .filter((record) => record.deletedAt)
                    .map((record) => record.id),
                ];
                if (removedSearch.length)
                  await tx.searchDocuments.bulkDelete(removedSearch);
                if (changed.length) await tx.records.bulkPut(changed);
              },
            );
          },
        },
        "ui-record-cache-1",
      );
      await this.recordProjection.synchronize();
      const cachedVersions = await this.db.fileVersions.toArray();
      const cachedIds = new Set(cachedVersions.map((v) => v.id));
      const released = cachedVersions.filter(
        (v) => !this.node.protocol.files.retainedVersion(v.id),
      );
      if (released.length) {
        await this.db.fileVersions.bulkDelete(released.map((v) => v.id));
        await this.db.searchDocuments.bulkDelete(released.map((v) => v.fileId));
      }
      for (const version of this.node.protocol.files.manifests()) {
        if (!this.node.protocol.files.retainedVersion(version.id)) continue;
        if (cachedIds.has(version.id)) continue;
        try {
          const available = await this.node.protocol.files.readAvailable(
            version.id,
          );
          if (!available) continue;
          const { bytes } = available;
          await this.db.fileVersions.put({
            id: version.id,
            fileId: version.fileId,
            parentVersionId: version.parentVersionId,
            blob: new Blob([new Uint8Array(bytes)], {
              type: version.mediaType,
            }),
            createdAt: version.createdAt,
            synced: true,
          });
        } catch (error) {
          if ((error as { kind?: string }).kind !== "OFFLINE_UNAVAILABLE")
            throw error;
        }
      }
      this.notifySurfaces();
    };
    const next = this.projectionQueue.then(work);
    this.pendingProjection = next;
    this.projectionQueue = next.catch(() => {});
    return next;
  }
  async api<T = unknown>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    this.assertActive();
    const url = new URL(path, "https://local.invalid/"),
      route = url.pathname.slice(1),
      input = (body ?? {}) as Record<string, any>;
    let result: unknown;
    if (route === "records/get")
      result = this.node.records.get(url.searchParams.get("id")!);
    else if (route === "devices")
      result = await this.db.records
        .where("collection")
        .equals("devices")
        .toArray();
    else if (route === "credentials/secret") {
      await this.node.vault.set(input.id, input.secret, input.deviceIds);
      await this.project();
      result = { ok: true };
    } else if (route === "credentials/revoke") {
      await this.node.vault.revoke(input.id);
      await this.project();
      result = { ok: true };
    } else if (route === "devices/revoke") {
      const id =
        Object.keys(membership(this.node.replica.access).members).find(
          (id) => deviceRecordId(id) === input.id,
        ) ?? input.id;
      await this.device.revoke(this.profile.workspaceId, id);
      result = { ok: true };
    } else if (route === "rpc") {
      const request = input.request;
      const routed = executionRecord(this.node, request.method, request.params);
      const binding =
        routed && bindingFor(this.node, routed.slot, routed.record.id);
      if (routed)
        invariant(
          binding?.enabled,
          "EXECUTION_PAUSED",
          "Choose a computer and enable execution for this item",
        );
      const requested = input.context?.targetDeviceId;
      if (binding && requested)
        invariant(
          [binding.deviceId, deviceRecordId(binding.deviceId)].includes(
            requested,
          ),
          "WRONG_EXECUTION_TARGET",
          "Use the computer assigned to this item",
        );
      const target = binding?.deviceId ?? requested,
        localTarget =
          !target ||
          target === this.principal.deviceId ||
          target === this.device.identity.id;
      if (localTarget && target && !window.jockiNative)
        invariant(
          this.host?.router.has(request.method),
          "CAPABILITY_UNSUPPORTED",
          "This device does not provide that command",
        );
      if (localTarget && this.host?.router.has(request.method))
        result = await this.host.router.receive(request, {
          principal: {
            ...this.principal,
            pluginId: input.context.pluginId,
            permissions: [
              this.host.router.permissionFor(request.method) ?? request.method,
            ],
          },
          signal: AbortSignal.timeout(30000),
        });
      else {
        invariant(
          target,
          "EXECUTION_UNASSIGNED",
          "Select a target for remote commands or declare an item execution slot",
        );
        result = {
          result: await this.node.call(
            request.method,
            request.params,
            target,
            request.id,
          ),
        };
      }
    } else if (route === "access/members")
      result = Object.values(membership(this.node.replica.access).members).map(
        (m) => ({ user_id: m.userId, role: m.access }),
      );
    else if (route === "github/create-task") {
      invariant(
        this.registry.enabled("connector-github") &&
          this.registry.enabled("tasks") &&
          this.registry.states
            .get("connector-github")
            ?.features.includes("taskLinks"),
        "FEATURE_DISABLED",
        "Enable GitHub task links and the Tasks plugin",
      );
      const issue = this.node.records.get(input.id);
      invariant(
        issue?.collection === "github_issues" && !issue.deletedAt,
        "NOT_FOUND",
        "Issue not found",
      );
      const id =
        typeof issue.data.task_id === "string"
          ? issue.data.task_id
          : await operationId(issue.id + ":task");
      result =
        this.node.records.get(id) ??
        (await this.collection("tasks").put(
          {
            title: String(issue.data.title),
            description: `${issue.data.body ?? ""}\n\n${issue.data.url ?? ""}`,
            status: issue.data.state === "closed" ? "done" : "open",
          },
          id,
        ));
      if (issue.data.task_id !== id)
        await this.collection("github_issues").put(
          { ...issue.data, task_id: id },
          issue.id,
        );
    } else if (route === "automation/webhook") {
      const record = this.node.records.get(input.id),
        slot = record && slotFor(record);
      const binding = record && slot && bindingFor(this.node, slot, record.id);
      invariant(
        binding?.enabled,
        "EXECUTION_PAUSED",
        "Choose a computer and enable this automation first",
      );
      const target = deviceRecordId(binding.deviceId);
      invariant(
        typeof target === "string",
        "WRONG_EXECUTION_TARGET",
        "Select a native execution device to receive webhooks",
      );
      await this.node.synchronize();
      result = await this.node.call(
        "core.http",
        { path, body, method },
        target,
      );
    } else if (
      ["automation/run", "automation/cancel", "automation/signal"].includes(
        route,
      )
    ) {
      const item = this.node.records.get(input.id);
      const slot = item && slotFor(item);
      const assignment =
        item && slot ? bindingFor(this.node, slot, item.id) : undefined;
      if (route === "automation/run")
        invariant(
          assignment?.enabled,
          "EXECUTION_PAUSED",
          "Choose a computer and enable this automation before running it",
        );
      const target = assignment
        ? deviceRecordId(assignment.deviceId)
        : item?.data.target_device_id;
      if (input.targetDeviceId)
        invariant(
          input.targetDeviceId === target,
          "WRONG_EXECUTION_TARGET",
          "Use the computer assigned to this item",
        );
      if (route === "automation/run") input.targetDeviceId = target;
      invariant(
        typeof target === "string",
        "WRONG_EXECUTION_TARGET",
        "Select an execution device",
      );
      if (target === this.principal.deviceId && !window.jockiNative)
        result = await this.localAutomation(route.replace("/", "."), input);
      else {
        await this.node.synchronize();
        try {
          result = await this.node.call(
            route.replace("/", "."),
            input,
            target,
            input.operationId,
          );
        } catch (error) {
          const workflow = this.node.records.get(input.id);
          if (
            route !== "automation/run" ||
            workflow?.data.offline_policy !== "waitForDevice" ||
            !["DEVICE_UNAVAILABLE", "OFFLINE"].includes(
              (error as { kind?: string }).kind ?? "",
            )
          )
            throw error;
          const operationId = input.operationId ?? crypto.randomUUID();
          await this.node.enqueue(
            "automation.run",
            { ...input, operationId },
            target,
            operationId,
            Date.now() +
              Math.min(
                86400,
                Number(workflow.data.dispatch_timeout_seconds) || 3600,
              ) *
                1000,
          );
          result = await this.node.records.put(
            "workflow_runs",
            {
              workflow_id: input.id,
              target_device_id: target,
              workflow_version: Number(workflow.data.published_version),
              status: "queued",
              input: input.input ?? {},
            },
            operationId,
          );
        }
        await this.node.synchronize();
        await this.project();
      }
    } else {
      await this.node.synchronize();
      const routed = executionRecord(
        this.node,
        route === "jobs" ? input.command : route,
        route === "jobs" ? input.input : input,
      );
      const assignment =
        routed && bindingFor(this.node, routed.slot, routed.record.id);
      if (routed)
        invariant(
          assignment?.enabled,
          "EXECUTION_PAUSED",
          "Choose a computer and enable execution for this item",
        );
      const target =
        assignment?.deviceId ?? input.targetDeviceId ?? input.deviceId;
      invariant(
        target,
        "EXECUTION_UNASSIGNED",
        "This operation needs an item-specific execution computer",
      );
      result = await this.node.call(
        "core.http",
        { path, body: body ?? null, method },
        target,
      );
      await this.node.synchronize();
      await this.project();
    }
    return result as T;
  }
  async saveWorkspaceSettings(
    value: import("../core/workspace-settings").WorkspaceSettingsValue,
  ) {
    await new WorkspaceSettings(this.node.replica).set(value);
    await this.project();
    await this.reconcileWorkspacePlugins();
    this.notifySurfaces();
  }
  async pluginAction(
    id: string,
    action: "install" | "enable" | "disable" | "uninstall",
    reviewedDigest?: string,
    useInstalled = false,
  ) {
    invariant(
      this.node.records.canWrite(),
      "PERMISSION_DENIED",
      "Write access is required to change active plugins",
    );
    return this.withPluginChanges(async () => {
      this.pluginSelectionKey = "";
      if (action === "install")
        await this.ensurePackage(id, reviewedDigest, useInstalled);
      const result = await this.registry[action](id);
      if (!isRequiredCore(id))
        await new WorkspacePlugins(this.node.replica).set(id, {
          installed: result.installed,
          enabled: result.enabled,
        });
      await this.refreshHost();
      if (action === "enable" || action === "install")
        await ensureCollectionTables(this);
      if (action === "disable" || action === "uninstall")
        await this.db.metadata.put({
          key: `plugin.${id}.disabledAt`,
          value: new Date().toISOString(),
        });
      return result;
    });
  }
  async installAndEnable(
    id: string,
    visiting = new Set<string>(),
    reviewed?: Map<string, string>,
  ) {
    invariant(
      !visiting.has(id),
      "DEPENDENCY_CYCLE",
      "Plugin dependency cycle detected",
    );
    visiting.add(id);
    if (!this.inventory) await this.refreshInventory();
    reviewed ??= new Map([
      ...this.extensions.map(
        (extension) => [extension.manifest.id, extension.digest] as const,
      ),
      ...this.availablePlugins.map(
        (entry) => [entry.id, entry.sha256] as const,
      ),
    ]);
    const entry = this.availablePlugins.find((p) => p.id === id);
    if (reviewed && !isRequiredCore(id))
      invariant(
        reviewed.has(id) &&
          (entry?.sha256 ?? this.installedPackage(id)?.digest) ===
            reviewed.get(id),
        "INVENTORY_CHANGED",
        "The release or dependencies changed; review them again",
      );
    const dependencies =
      entry?.dependencies ??
      this.registry.manifests.get(id)?.dependencies ??
      [];
    for (const dep of dependencies)
      if (!this.registry.enabled(dep))
        await this.installAndEnable(dep, new Set(visiting), reviewed);
    await this.pluginAction(id, "install", reviewed?.get(id));
    await this.pluginAction(id, "enable");
  }
  async configurePlugin(id: string, features: string[]) {
    await this.registry.configure(id, features);
    await this.refreshHost();
  }
  async synchronize() {
    if (this.closed || this.maintenance) return;
    return this.syncQueue.run(async () => {
      if (this.closed || this.maintenance) return;
      let phase = "announce-device";
      try {
        await this.announce();
        phase = "peer-sync";
        await this.node.synchronize();
        phase = "plugin-reconcile";
        await this.reconcileWorkspacePlugins();
        phase = "queued-commands";
        await this.node.flushCommands();
        phase = "automation";
        const nativeAutomation =
          window.jockiNative &&
          (await window.jockiNative.peer.info()).options.automation;
        if (this.automationOptions.enabled && !nativeAutomation)
          await workflowTriggers(this.node, (input) =>
            this.automation.start(
              input as Parameters<PortableWorkflows["start"]>[0],
            ),
          );
        // Existing app-owned runs keep their own checkpoints when background scheduling is enabled.
        await this.automation?.tick();
        if (!window.jockiNative)
          await reminders(this.node, (id) => this.registry.enabled(id));
        phase = "ui-projection";
        await this.project();
      } catch (error) {
        throw reportSyncError(error, {
          phase,
          workspaceId: this.profile.workspaceId,
        });
      }
    });
  }
  async fileBytes(fileId: string) {
    this.assertActive();
    const file = this.node.records.get(fileId);
    invariant(file?.data.version_id, "NOT_FOUND", "File has no saved version");
    const { manifest, bytes } = await this.node.protocol.files.read(
      String(file.data.version_id),
    );
    return {
      id: manifest.id,
      fileId,
      parentVersionId: manifest.parentVersionId,
      blob: new Blob([new Uint8Array(bytes)], { type: manifest.mediaType }),
      createdAt: manifest.createdAt,
      synced: true,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.syncQueue.idle().catch(() => {});
      await this.pluginQueue;
      await this.automation?.close();
      while (this.pendingWrites.size)
        await Promise.allSettled([...this.pendingWrites]);
      if (this.projectionListener)
        this.node?.replica.listeners.delete(this.projectionListener);
      this.projectionRefresh?.stop();
      await this.projectionRefresh?.idle();
      await this.projectionQueue;
      this.recordProjection?.stop();
      await this.host?.close();
      this.surfaces.clear();
      this.notifySurfaces();
    } finally {
      try {
        await this.db.close();
      } finally {
        // Initialization may have mounted storage without returning a node.
        await this.device?.closeWorkspace(this.profile.workspaceId);
      }
    }
  }
}
export async function profiles() {
  const db = new Bootstrap();
  try {
    return await db.profiles.toArray();
  } finally {
    await db.close();
  }
}
export async function saveProfile(profile: WorkspaceProfile) {
  const db = new Bootstrap();
  try {
    await db.profiles.put(profile);
  } finally {
    await db.close();
  }
}
export async function deleteSavedWorkspace(profile: WorkspaceProfile) {
  const device = await browserDevice();
  await window.jockiNative?.repository.remove(profile.workspaceId);
  await device.removeWorkspace(profile.workspaceId);
  // Clear every user's disposable view of this workspace, including files and search.
  for (const name of await databasePlatform().names())
    if (
      name.startsWith("jocki-duckdb-cache-") &&
      name.endsWith("-" + profile.workspaceId)
    )
      await databasePlatform().remove(name);
  const db = new Bootstrap();
  try {
    await db.profiles
      .filter((value) => value.workspaceId === profile.workspaceId)
      .delete();
  } finally {
    await db.close();
  }
  for (const key of Object.keys(localStorage))
    if (key.startsWith(`jocki.view.${profile.id}.`))
      localStorage.removeItem(key);
  if (localStorage.getItem("jocki.active-workspace") === profile.id)
    localStorage.removeItem("jocki.active-workspace");
}
export async function createLocalWorkspace(name: string) {
  const device = await browserDevice(),
    node = await device.createWorkspace(name);
  return profileForNode(node);
}
export type JoinDestination = { kind: "internal"; name: string };
export async function joinWorkspace(
  invitation: string,
  destination: JoinDestination,
) {
  const device = await browserDevice();
  const node = await device.join(invitation);
  return profileForNode(node, {
    localName: destination.name.trim() || node.link.name,
  });
}
export async function profileForNode(
  node: WorkspaceNode,
  savedAs: Pick<WorkspaceProfile, "localName"> = {},
) {
  const db = new Bootstrap();
  try {
    const existing = await db.profiles.get(node.replica.workspaceId);
    const name = membership(node.replica.access).name;
    const profile: WorkspaceProfile = {
      id: node.replica.workspaceId,
      workspaceId: node.replica.workspaceId,
      userId: node.replica.member.userId,
      name,
      localName: existing?.localName ?? existing?.name ?? name,
      serverUrl: "",
      connected: true,
      ...savedAs,
    };
    await db.profiles.put(profile);
    return profile;
  } finally {
    await db.close();
  }
}
export { browserDevice };
