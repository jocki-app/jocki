import path from "node:path";
import { rm } from "node:fs/promises";
import {
  requireExecution,
  executionRecord,
  executionActive,
  executionSlots,
  executionReady,
} from "../core/execution";
import { DeviceCore, type WorkspaceNode } from "../core/device";
import { deviceRecordId } from "../core/records";
import { membership } from "../core/membership";
import { WorkspacePlugins } from "../core/workspace-plugins";
import { reconcilePluginActivation } from "../core/plugin-activation";
import { canonical, utf8, digest, base64 } from "../core/crypto";
import { NativeTerminal } from "./terminal";
import { openDatabase, type Database } from "./compat/database";
import { migrate } from "./compat/schema";
import {
  projectWorkspace,
  stopWorkspaceProjections,
  deleteWorkspaceProjection,
} from "./compat/projection";
import { Repository } from "./compat/repository";
import { routerFor, registryFor } from "./compat/api";
import { serverPluginHost } from "./compat/plugin-host";
import { loadPackageCatalog } from "./compat/plugin-packages";
import {
  availablePlugins,
  installInventoryPlugin,
} from "./compat/plugin-inventory";
import { pluginHttp, pluginTick } from "./compat/plugin-runtime";
import { workflowTriggers, reminders } from "../core/schedules";
import { operationId } from "../core/schedules";
import { assertPublishedVersion } from "../core/workflows";
import { LocalState } from "../core/local-state";
import { releaseService } from "../core/services";
import { processBackground } from "./compat/background";
import { JobService } from "./compat/jobs";
import {
  createAutomationEngine,
  runTypeScript,
  type AutomationEngine,
  type WorkflowExecution,
} from "@jocki/platform/automation/engine";
import { validateGraph } from "@jocki/platform/core/workflows";
import { manifestById, isRequiredCore } from "@jocki/platform/core/catalog";
import type { Principal } from "@jocki/platform/plugin-sdk";
import type { Value } from "@jocki/platform/field-types";
import { invariant } from "@jocki/platform/core/errors";
export interface NativeOptions {
  storageOnly?: boolean;
  directory: string;
  terminal: boolean;
  automation: boolean;
  trustedCode: boolean;
  background: boolean;
  plugins: boolean;
}
interface NativeIntent {
  execution: WorkflowExecution;
  requestedBy: string;
  workflowId: string;
  version: number;
  engineRunId?: string;
}
export class NativeServices {
  private db!: Database;
  private closeDatabase?: () => Promise<void>;
  private terminal = new NativeTerminal();
  private engines = new Map<string, AutomationEngine>();
  private itemOperations = new Map<string, Set<Promise<unknown>>>();
  private async itemOperation<T>(
    node: WorkspaceNode,
    routed: ReturnType<typeof executionRecord>,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!routed) return work();
    const key = node.replica.workspaceId + ":" + routed.record.id;
    const active = this.itemOperations.get(key) ?? new Set<Promise<unknown>>();
    this.itemOperations.set(key, active);
    const operation = (async () => {
      await requireExecution(node, routed.record, routed.slot);
      const status = (await this.execute(
        node.replica.workspaceId,
        "core.plugins.status",
        {},
        { deviceId: this.core.identity.id, requestId: crypto.randomUUID() },
      )) as import("@jocki/platform/plugin-sdk/execution").DevicePluginStatus;
      invariant(
        executionReady(routed.record, routed.slot, status),
        "PLUGIN_NOT_READY",
        "Enable required plugins and capabilities on this computer",
      );
      return work();
    })();
    active.add(operation);
    try {
      return await operation;
    } finally {
      active.delete(operation);
      if (!active.size) this.itemOperations.delete(key);
    }
  }
  private projected = new Map<string, string>();
  private ticking = false;
  private pluginCommands: string[] = [];
  private pluginSelectionKeys = new Map<string, string>();
  private pluginInstallErrors = new Map<string, Map<string, string>>();
  private async reconcileWorkspacePlugins(node: WorkspaceNode) {
    if (!this.options.plugins) return;
    const workspace = new WorkspacePlugins(node.replica);
    const id = node.replica.workspaceId,
      choices = workspace.choices(),
      key = canonical([...choices].sort());
    if (this.pluginSelectionKeys.get(id) === key) return;
    const packages = await loadPackageCatalog();
    const registry = registryFor(
      new Repository(this.db),
      this.actor(id, this.core.identity.id),
      { deviceLocal: true },
    );
    await registry.initialize();
    const errors = await reconcilePluginActivation(
      registry,
      choices,
      async (pluginId) => {
        let installed = packages.find((p) => p.manifest.id === pluginId);
        if (!installed) {
          const entry = (await availablePlugins()).plugins.find(
            (p) => p.id === pluginId,
          );
          invariant(
            entry,
            "PLUGIN_NOT_FOUND",
            `Plugin ${pluginId} is unavailable`,
          );
          await installInventoryPlugin(
            {
              id: pluginId,
              version: entry.version,
              sha256: entry.sha256,
              grants: entry.grants,
            },
            this.db,
          );
          installed = (await loadPackageCatalog()).find(
            (p) => p.manifest.id === pluginId,
          );
        }
        invariant(
          installed,
          "PLUGIN_NOT_FOUND",
          `Plugin ${pluginId} is unavailable`,
        );
        registry.manifests.set(pluginId, installed.manifest);
      },
    );
    this.pluginInstallErrors.set(id, errors);
    if (!errors.size) this.pluginSelectionKeys.set(id, key);
    this.pluginCommands = (await loadPackageCatalog()).flatMap(
      (p) => p.manifest.provides.commands,
    );
  }
  constructor(
    readonly core: DeviceCore,
    readonly options: NativeOptions,
  ) {}
  capabilities() {
    if (this.options.storageOnly) return ["storage.peer"];
    return [
      "core.http",
      "core.plugins.status",
      "plugins.native",
      ...(this.options.background ? ["background.execute"] : []),
      ...(this.options.automation && this.options.trustedCode
        ? ["automation.typescript"]
        : []),
      "core.services.release",
      "credentials.refresh",
      ...this.pluginCommands,
      ...(this.options.plugins ? ["core.plugins.install"] : []),
      ...(this.options.terminal ? ["terminal.*", "terminal.host"] : []),
      ...(this.options.automation
        ? ["automation.*", "automation.execute"]
        : []),
    ];
  }
  async initialize(workspaceIds = this.core.profiles().map((p) => p.id)) {
    if (this.options.storageOnly) {
      invariant(
        !this.options.plugins &&
          !this.options.automation &&
          !this.options.terminal &&
          !this.options.background,
        "INVALID_CONFIG",
        "Turn off storage-only mode before enabling native execution services",
      );
      for (const id of workspaceIds) await this.core.workspace(id);
      return this;
    }
    process.env.PLUGIN_PATH = path.join(this.options.directory, "plugins");
    const opened = await openDatabase(
      path.join(this.options.directory, "plugin-projection-v3"),
      this.core,
    );
    this.db = opened.database;
    this.closeDatabase = opened.close;
    this.pluginCommands = (await loadPackageCatalog()).flatMap(
      (p) => p.manifest.provides.commands,
    );
    await migrate(this.db);
    for (const id of workspaceIds) await this.attachWorkspace(id);
    await this.project();
    return this;
  }
  async attachWorkspace(id: string, options: { maintenance?: boolean } = {}) {
    try {
      await this.core.workspace(id, (command, input, context) =>
        this.execute(id, command, input, context),
      );
      await this.project();
      this.core.resumeAutomaticSync(id);
    } catch (error) {
      // A busy workspace belongs to another lifecycle operation. During
      // maintenance, closing core here would await the operation restoring us.
      if (
        !["BUSY", "DEVICE_CLOSED"].includes(
          (error as { kind?: string }).kind ?? "",
        )
      ) {
        if (options.maintenance) await this.stopWorkspaceServices(id);
        else await this.detachWorkspace(id);
      }
      throw error;
    }
  }
  async quiesceWorkspace(id: string) {
    const node = this.core.workspaces.get(id);
    // Refuse new network commands, then let acknowledged work finish before closing storage.
    this.core.protocols.delete(id);
    await node?.pauseAutomaticSync();
    await node?.protocol.close();
    await this.stopWorkspaceServices(id);
  }
  private async stopWorkspaceServices(id: string) {
    await this.engines.get(id)?.stop();
    this.engines.delete(id);
    this.terminal.sweep((workspaceId) => workspaceId !== id);
    for (const [key, operations] of this.itemOperations)
      if (key.startsWith(id + ":")) await Promise.allSettled([...operations]);
    this.projected.delete("presence:" + id);
  }
  async detachWorkspace(id: string) {
    await this.quiesceWorkspace(id);
    await this.core.closeWorkspace(id);
    if (this.db) stopWorkspaceProjections(this.db, id);
  }
  async removeWorkspace(id: string) {
    invariant(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      ),
      "INVALID_WORKSPACE",
      "Invalid workspace ID",
    );
    await this.detachWorkspace(id);
    if (!this.options.storageOnly) await deleteWorkspaceProjection(this.db, id);
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      await rm(
        path.join(this.options.directory, `workflow-${id}.sqlite${suffix}`),
        { force: true },
      );
    await this.core.removeWorkspace(id);
    for (const key of this.projected.keys())
      if (key === "presence:" + id || key.startsWith(id + ":"))
        this.projected.delete(key);
  }
  actor(
    workspaceId: string,
    deviceId: string,
    pluginId = "records",
  ): Principal {
    const node = this.core.workspaces.get(workspaceId),
      member = node && membership(node.replica.access).members[deviceId];
    invariant(member, "PERMISSION_DENIED", "Device membership is unavailable");
    return {
      workspaceId,
      userId: member.userId,
      deviceId: deviceRecordId(deviceId),
      pluginId,
      permissions: manifestById.get(pluginId)?.permissions ?? [],
    };
  }
  async project() {
    if (this.options.storageOnly) return;
    for (const node of this.core.workspaces.values()) {
      await projectWorkspace(this.db, node);
    }
  }
  async install(
    workspaceId: string,
    input: { id: string; version: string; sha256: string; grants: string[] },
  ) {
    invariant(
      !this.options.storageOnly,
      "CAPABILITY_UNAVAILABLE",
      "Storage-only mode does not run plugins",
    );
    const actor = this.actor(workspaceId, this.core.identity.id),
      repo = new Repository(this.db);
    await installInventoryPlugin(input, this.db);
    const registry = registryFor(repo, actor);
    await registry.initialize();
    const install = async (id: string, seen = new Set<string>()) => {
      invariant(!seen.has(id), "DEPENDENCY_CYCLE", "Plugin dependency cycle");
      seen.add(id);
      for (const dep of registry.manifests.get(id)?.dependencies ?? [])
        if (!registry.enabled(dep)) await install(dep, new Set(seen));
      await registry.install(id);
      await registry.enable(id);
      if (!isRequiredCore(id))
        await new WorkspacePlugins(
          this.core.workspaces.get(workspaceId)!.replica,
        ).set(id, { installed: true, enabled: true });
    };
    await install(input.id);
    this.pluginCommands = (await loadPackageCatalog()).flatMap(
      (p) => p.manifest.provides.commands,
    );
    await this.project();
    return { ok: true };
  }
  async execute(
    workspaceId: string,
    command: string,
    input: unknown,
    context: { deviceId: string; requestId: string },
  ) {
    invariant(
      !this.options.storageOnly,
      "CAPABILITY_UNSUPPORTED",
      "This peer only provides storage and synchronization",
    );
    const node = this.core.workspaces.get(workspaceId)!;
    if (command === "core.plugins.status") {
      const registry = registryFor(
        new Repository(this.db),
        this.actor(workspaceId, context.deviceId),
      );
      await registry.initialize();
      return {
        deviceId: this.core.identity.id,
        capabilities: this.capabilities(),
        canInstall: this.options.plugins,
        plugins: registry.list().map(({ manifest, state }) => ({
          id: manifest.id,
          version: state.version,
          installed: state.installed,
          enabled: state.enabled,
          ...((this.pluginInstallErrors.get(workspaceId)?.get(manifest.id) ??
          state.error)
            ? {
                error:
                  this.pluginInstallErrors.get(workspaceId)?.get(manifest.id) ??
                  state.error,
              }
            : {}),
        })),
      };
    }
    invariant(
      membership(node.replica.access).members[context.deviceId]?.access !==
        "read",
      "PERMISSION_DENIED",
      "Read-only devices cannot execute native commands",
    );
    if (command === "credentials.refresh") {
      const request = input as {
        id: string;
        pluginId: string;
        destination: string;
      };
      await node.vault.refresh(
        request.id,
        request.pluginId,
        request.destination,
      );
      return { ok: true };
    }
    if (command === "core.services.release") {
      const request = input as {
        id: string;
        token: string;
        successor?: { deviceId: string; generation: string };
      };
      await releaseService(
        node,
        request.id,
        request.token,
        async () => {
          while (this.ticking)
            await new Promise((resolve) => setTimeout(resolve, 25));
          if (request.id.startsWith("execution.")) {
            const resourceId = request.id.split(".")[1];
            await Promise.allSettled([
              ...(this.itemOperations.get(workspaceId + ":" + resourceId) ??
                []),
            ]);
            const intents = new LocalState(node.replica, "native-workflows");
            for (const id of await intents.ids()) {
              const intent = await intents.get<NativeIntent>(id);
              const record = node.records.get(id);
              if (
                intent?.workflowId === resourceId &&
                intent.engineRunId &&
                record &&
                !["completed", "failed", "cancelled"].includes(
                  String(record.data.status),
                )
              ) {
                await this.controlEngine(node, (engine) =>
                  engine.engine.cancelWorkflowRun(intent.engineRunId!),
                );
                await node.records.put(
                  "workflow_runs",
                  {
                    ...record.data,
                    status: "cancelled",
                    ended_at: new Date().toISOString(),
                  },
                  id,
                );
              }
            }
            const engine = this.engines.get(workspaceId);
            if (engine) {
              await engine.stop();
              this.engines.delete(workspaceId);
            }
          }
        },
        request.successor,
      );
      return { ok: true };
    }
    if (command.startsWith("terminal.")) {
      invariant(
        this.options.terminal,
        "CAPABILITY_UNSUPPORTED",
        "Terminal hosting is disabled on this computer",
      );
      return this.terminal.command(
        command,
        (input ?? {}) as Record<string, unknown>,
        context.deviceId,
        workspaceId,
        context.requestId,
      );
    }
    if (command === "core.plugins.install") {
      invariant(
        this.options.plugins,
        "CAPABILITY_UNSUPPORTED",
        "Native plugin installation is disabled on this computer",
      );
      invariant(
        membership(node.replica.access).members[context.deviceId]?.access ===
          "write",
        "PERMISSION_DENIED",
        "Write access is required to install native code",
      );
      return this.install(
        workspaceId,
        input as Parameters<NativeServices["install"]>[1],
      );
    }
    if (
      ["automation.run", "automation.cancel", "automation.signal"].includes(
        command,
      )
    )
      return this.http(
        workspaceId,
        { path: command.replace(".", "/"), body: input, method: "POST" },
        context,
      );
    if (command === "core.http")
      return this.http(
        workspaceId,
        input as { path: string; body: unknown; method: string },
        context,
      );
    const routed = executionRecord(node, command, input);
    if (
      !routed &&
      executionSlots().some(
        (s) =>
          s.commands.includes(command) || s.background?.command === command,
      )
    )
      throw new Error("The execution item was not found");
    return this.itemOperation(node, routed, async () => {
      const actor = this.actor(workspaceId, context.deviceId),
        repo = new Repository(this.db),
        router = await routerFor(repo, actor),
        host = await serverPluginHost(repo, actor, router);
      try {
        const result = await router.receive(
          {
            jsonrpc: "2.0",
            id: context.requestId,
            method: command,
            params: input,
          },
          {
            principal: {
              ...actor,
              permissions: [router.permissionFor(command) ?? command],
            },
            signal: AbortSignal.timeout(30000),
            mutationId: context.requestId,
          },
        );
        invariant(
          result && "result" in result,
          "COMMAND_FAILED",
          result?.error?.message ?? "Plugin command failed",
        );
        return result.result;
      } finally {
        await host.close();
      }
    });
  }
  async http(
    workspaceId: string,
    input: { path: string; body: unknown; method: string },
    context: { deviceId: string; requestId: string },
  ) {
    await this.project();
    const actor = this.actor(workspaceId, context.deviceId),
      repo = new Repository(this.db),
      node = this.core.workspaces.get(workspaceId)!,
      body = (input.body ?? {}) as Record<string, any>;
    const url = new URL(input.path, "http://peer.local/api/");
    url.searchParams.set("workspaceId", workspaceId);
    const route = url.pathname.slice(5);
    if (route === "plugins/inventory") return availablePlugins();
    if (route === "jobs")
      return new JobService(repo).enqueue(
        { ...actor, pluginId: body.pluginId },
        body.command,
        body.input,
        { dueAt: body.dueAt, operationId: body.operationId },
      );
    if (route === "automation/run")
      return this.runWorkflow(node, body, context.deviceId);
    if (route === "automation/webhook") {
      const workflow = node.records.get(String(body.id));
      invariant(
        workflow?.collection === "workflows" &&
          workflow.data.trigger_kind === "webhook" &&
          workflow.data.target_device_id ===
            deviceRecordId(this.core.identity.id),
        "WRONG_EXECUTION_TARGET",
        "Create this webhook on its selected automation device",
      );
      await requireExecution(node, workflow);
      const token = base64(crypto.getRandomValues(new Uint8Array(32)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await new LocalState(node.replica, "workflow-hooks").set(workflow.id, {
        tokenHash: await digest(utf8.encode(token)),
      });
      return { path: "/api/automation/hooks/" + workflow.id, token };
    }
    if (route === "automation/cancel") {
      const id = String(body.id),
        state = await new LocalState(
          node.replica,
          "native-workflows",
        ).get<NativeIntent>(id);
      invariant(
        state?.engineRunId,
        "NOT_FOUND",
        "Workflow is not running on this device",
      );
      await this.controlEngine(node, (engine) =>
        engine.engine.cancelWorkflowRun(state.engineRunId!),
      );
      const record = node.records.get(id);
      if (record)
        await node.records.put(
          "workflow_runs",
          {
            ...record.data,
            status: "cancelled",
            ended_at: new Date().toISOString(),
          },
          id,
        );
      return { ok: true };
    }
    if (route === "automation/signal") {
      const state = await new LocalState(
        node.replica,
        "native-workflows",
      ).get<NativeIntent>(String(body.id));
      invariant(state, "NOT_FOUND", "Workflow is not on this device");
      return this.controlEngine(node, (engine) =>
        engine.engine.sendSignal({
          signal: String(body.id) + ":" + String(body.name),
          data: body.data,
        }),
      );
    }
    const routed = executionRecord(node, route, body);
    if (!routed && executionSlots().some((s) => s.routes.includes(route)))
      throw Object.assign(new Error("The execution item was not found"), {
        kind: "NOT_FOUND",
      });
    return this.itemOperation(node, routed, async () => {
      const request = new Request(url, {
        method: input.method,
        ...(input.method !== "GET" && input.method !== "HEAD"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input.body),
            }
          : {}),
      });
      const response = await pluginHttp(
        request,
        route,
        { repo, principal: actor },
        "workspace",
      );
      invariant(
        response,
        "NOT_FOUND",
        "No enabled plugin provides this operation on this device",
      );
      const result = await response.json();
      invariant(
        response.ok,
        "PLUGIN_OPERATION_FAILED",
        result.error?.message ?? "Plugin operation failed",
      );
      return result;
    });
  }
  private async controlEngine<T>(
    node: WorkspaceNode,
    work: (engine: AutomationEngine) => Promise<T>,
  ) {
    const running = this.engines.get(node.replica.workspaceId);
    if (running) return work(running);
    const engine = await createAutomationEngine(
      {
        deviceId: deviceRecordId(this.core.identity.id),
        call: async () => {
          throw Error(
            "Control-only workflow connection cannot execute commands",
          );
        },
      },
      {
        kind: "sqlite",
        path: path.join(
          this.options.directory,
          "workflow-" + node.replica.workspaceId + ".sqlite",
        ),
      },
    );
    try {
      return await work(engine);
    } finally {
      await engine.backend.stop();
    }
  }
  private async engine(node: WorkspaceNode) {
    const workspaceId = node.replica.workspaceId,
      existing = this.engines.get(workspaceId);
    if (existing) return existing;
    invariant(
      this.options.automation,
      "CAPABILITY_UNSUPPORTED",
      "Automation execution is disabled on this computer",
    );
    const deviceId = deviceRecordId(this.core.identity.id);
    const engine = await createAutomationEngine(
      {
        deviceId,
        canRun: async (execution) => {
          const intent = await new LocalState(
            node.replica,
            "native-workflows",
          ).get<NativeIntent>(execution.id);
          const record = intent && node.records.get(intent.workflowId);
          if (
            !record ||
            !this.options.automation ||
            !(await executionActive(node, record))
          )
            return false;
          const status = (await this.execute(
            workspaceId,
            "core.plugins.status",
            {},
            { deviceId: this.core.identity.id, requestId: crypto.randomUUID() },
          )) as import("@jocki/platform/plugin-sdk/execution").DevicePluginStatus;
          return executionReady(
            record,
            executionSlots("automation-runtime")[0],
            status,
          );
        },
        typescript: async (source, input) => {
          invariant(
            this.options.trustedCode,
            "PERMISSION_DENIED",
            "Trusted TypeScript was disabled",
          );
          return runTypeScript(source, input);
        },
        call: async (command, input, operationId) =>
          this.execute(workspaceId, command, input, {
            deviceId: this.core.identity.id,
            requestId: operationId,
          }) as Promise<Value>,
      },
      {
        kind: "sqlite",
        path: path.join(
          this.options.directory,
          "workflow-" + workspaceId + ".sqlite",
        ),
      },
    );
    await engine.worker.start();
    this.engines.set(workspaceId, engine);
    return engine;
  }
  private async runWorkflow(
    node: WorkspaceNode,
    input: Record<string, any>,
    deviceId: string,
  ) {
    invariant(
      this.options.automation,
      "CAPABILITY_UNSUPPORTED",
      "Automation execution is disabled",
    );
    const workflow = node.records.get(input.id);
    invariant(
      workflow?.collection === "workflows" && !workflow.deletedAt,
      "NOT_FOUND",
      "Workflow not found",
    );
    await requireExecution(node, workflow);
    const registry = registryFor(
      new Repository(this.db),
      this.actor(node.replica.workspaceId, deviceId),
    );
    await registry.initialize();
    const status = (await this.execute(
      node.replica.workspaceId,
      "core.plugins.status",
      {},
      { deviceId: this.core.identity.id, requestId: crypto.randomUUID() },
    )) as import("@jocki/platform/plugin-sdk/execution").DevicePluginStatus;
    invariant(
      executionReady(workflow, executionSlots("automation-runtime")[0], status),
      "PLUGIN_NOT_READY",
      "Enable the required plugins and capabilities on the execution computer",
    );
    const target = deviceRecordId(this.core.identity.id);
    invariant(
      input.targetDeviceId === target,
      "WRONG_EXECUTION_TARGET",
      "Workflow was sent to another device",
    );
    invariant(
      Number(workflow.data.published_version) > 0,
      "WORKFLOW_UNPUBLISHED",
      "Publish the workflow before running it",
    );
    const pin = node.replica.read<{ graph: unknown; trusted: boolean }>(
      "setting/workflow." + workflow.id + "." + workflow.data.published_version,
    );
    invariant(
      pin,
      "WORKFLOW_UNPUBLISHED",
      "Published version is not available on this device",
    );
    const graph = validateGraph(pin.graph),
      trusted = pin.trusted;
    assertPublishedVersion(
      node,
      workflow.id,
      Number(workflow.data.published_version),
    );
    invariant(
      !trusted ||
        (this.options.trustedCode && workflow.data.allow_trusted_code === true),
      "PERMISSION_DENIED",
      "Trusted TypeScript execution is disabled on this computer",
    );
    const id = String(input.operationId ?? crypto.randomUUID()),
      intents = new LocalState(node.replica, "native-workflows");
    const execution: WorkflowExecution = {
      id,
      interpreterVersion: 2,
      targetDeviceId: target,
      graph,
      input: input.input ?? {},
      allowTrustedCode: trusted,
    };
    const prior = await intents.get<NativeIntent>(id);
    if (prior) {
      invariant(
        canonical(prior.execution) === canonical(execution),
        "IDEMPOTENCY_CONFLICT",
        "Run ID was reused",
      );
      return node.records.get(id);
    }
    const intent: NativeIntent = {
      execution,
      requestedBy: deviceId,
      workflowId: workflow.id,
      version: Number(workflow.data.published_version),
    };
    await intents.set(id, intent);
    const run = await node.records.put(
      "workflow_runs",
      {
        workflow_id: workflow.id,
        target_device_id: target,
        workflow_version: Number(workflow.data.published_version),
        status: "queued",
        input: execution.input,
      },
      id,
    );
    // Persist intent before handing it to the durable workflow library.
    await node.replica.update("job/" + id, {
      execution,
      requestedBy: deviceId,
      state: "starting",
    });
    const engine = await this.engine(node),
      handle = await engine.run(execution);
    await intents.set(id, { ...intent, engineRunId: handle.workflowRun.id });
    await node.replica.update("job/" + id, {
      execution,
      requestedBy: deviceId,
      state: "running",
      engineRunId: handle.workflowRun.id,
    });
    return run;
  }
  async tick() {
    if (this.options.storageOnly) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.options.automation && this.engines.size) {
        for (const engine of this.engines.values()) await engine.stop();
        this.engines.clear();
      }
      await this.project();
      this.terminal.sweep((workspaceId, owner) =>
        Boolean(
          this.options.terminal &&
          this.core.workspaces.get(workspaceId) &&
          membership(this.core.workspaces.get(workspaceId)!.replica.access)
            .members[owner],
        ),
      );
      for (const node of this.core.workspaces.values()) {
        await this.reconcileWorkspacePlugins(node);
        if (node.replica.member.access === "read") continue;
        if (
          !this.projected.has("presence:" + node.replica.workspaceId) ||
          Date.now() -
            Number(this.projected.get("presence:" + node.replica.workspaceId)) >
            30000
        ) {
          this.projected.set(
            "presence:" + node.replica.workspaceId,
            String(Date.now()),
          );
          const prior = node.records.get(deviceRecordId(this.core.identity.id));
          if (
            !prior ||
            prior.data.name !== this.core.identity.name ||
            JSON.stringify(prior.data.capabilities) !==
              JSON.stringify(this.capabilities())
          )
            await node.records.put(
              "devices",
              {
                name: this.core.identity.name,
                platform: "desktop",
                capabilities: this.capabilities(),
                last_seen: new Date().toISOString(),
              },
              deviceRecordId(this.core.identity.id),
            );
        }
        if (this.options.automation) {
          await workflowTriggers(node, (input) =>
            this.runWorkflow(node, input, this.core.identity.id),
          );
          const intents = new LocalState(node.replica, "native-workflows");
          for (const id of await intents.ids()) {
            const intent = await intents.get<NativeIntent>(id);
            if (
              !intent ||
              !membership(node.replica.access).members[intent.requestedBy]
            )
              continue;
            const state = intent;
            if (!node.records.get(id))
              await node.records.put(
                "workflow_runs",
                {
                  workflow_id: intent.workflowId,
                  target_device_id: intent.execution.targetDeviceId,
                  workflow_version: intent.version,
                  status: "queued",
                  input: intent.execution.input,
                },
                id,
              );
            const engine = await this.engine(node);
            if (!state.engineRunId) {
              const handle = await engine.run(intent.execution);
              state.engineRunId = handle.workflowRun.id;
              await intents.set(id, state);
              await node.replica.update("job/" + id, {
                ...state,
                state: "running",
              });
            }
            const run = await engine.backend.getWorkflowRun({
              workflowRunId: state.engineRunId,
            });
            if (!run) {
              const record = node.records.get(id)!;
              if (record.data.status !== "failed")
                await node.records.put(
                  "workflow_runs",
                  {
                    ...record.data,
                    status: "failed",
                    error:
                      "Execution checkpoint is missing. Review external effects before starting another run.",
                  },
                  id,
                );
              continue;
            }
            if (
              run &&
              ["completed", "succeeded", "failed", "canceled"].includes(
                run.status,
              )
            ) {
              const record = node.records.get(state.execution.id);
              if (
                record &&
                !["completed", "failed", "cancelled"].includes(
                  String(record.data.status),
                )
              )
                await node.records.put(
                  "workflow_runs",
                  {
                    ...record.data,
                    status:
                      run.status === "canceled"
                        ? "cancelled"
                        : run.status === "failed"
                          ? "failed"
                          : "completed",
                    output: (run.output ?? null) as Value,
                    ended_at: new Date().toISOString(),
                  },
                  record.id,
                );
            }
          }
        }
        if (this.options.background) {
          const registry = registryFor(
            new Repository(this.db),
            this.actor(node.replica.workspaceId, this.core.identity.id),
          );
          await registry.initialize();
          await reminders(node, (id) => registry.enabled(id));
          await pluginTick(new Repository(this.db), node.replica.workspaceId);
        }
      }
      if (this.options.background)
        await processBackground(new Repository(this.db));
    } finally {
      this.ticking = false;
    }
  }
  async webhook(id: string, token: string, key: string, input: Value) {
    invariant(
      !this.options.storageOnly,
      "CAPABILITY_UNSUPPORTED",
      "Storage-only peers do not execute webhooks",
    );
    invariant(
      /^[a-zA-Z0-9_.:-]{1,200}$/.test(key),
      "VALIDATION_FAILED",
      "An Idempotency-Key header is required",
    );
    for (const node of this.core.workspaces.values()) {
      const hook = await new LocalState(node.replica, "workflow-hooks").get<{
        tokenHash: string;
      }>(id);
      if (!hook || hook.tokenHash !== (await digest(utf8.encode(token))))
        continue;
      const workflow = node.records.get(id);
      invariant(
        workflow &&
          !workflow.deletedAt &&
          workflow.data.enabled &&
          workflow.data.trigger_kind === "webhook",
        "FEATURE_DISABLED",
        "Webhook workflow is disabled",
      );
      return this.runWorkflow(
        node,
        {
          id,
          targetDeviceId: String(workflow.data.target_device_id),
          operationId: await operationId(id + ":webhook:" + key),
          input,
        },
        this.core.identity.id,
      );
    }
    throw Object.assign(new Error("Webhook credential is invalid"), {
      kind: "PERMISSION_DENIED",
    });
  }
  async close() {
    this.terminal.close();
    for (const engine of this.engines.values()) await engine.stop();
    if (this.db) stopWorkspaceProjections(this.db);
    await this.closeDatabase?.();
  }
}
