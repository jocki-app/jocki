import { validateWorkspaceSettings } from "./workspace-settings";
import { schemaById } from "@jocki/platform/core/catalog";
import { validateRecord } from "@jocki/platform/field-types";
import * as A from "@automerge/automerge";
import { ComputerSettings } from "./computer-settings";
import { DocumentProjection } from "./projection";
import { DocumentGraph } from "./document-graph";
import type { DocHandle } from "@automerge/automerge-repo";
import type { DurableStorage } from "../storage";
import type { Identity } from "./crypto";
import { canonical } from "./crypto";
import {
  refreshMembership,
  type WorkspaceAccess,
  type WorkspaceDocument,
} from "./membership";
import { serviceToken } from "./services";
import { invariant } from "@jocki/platform/core/errors";

export type DocumentReadiness = "loading" | "ready" | "deleted" | "missing";
export interface ReplicaStatus {
  documents: number;
  changes: number;
  ready: boolean;
  peers: number;
  error?: string;
}
/** Domain records are individual Repo documents, indexed by plugin/schema and schema documents. */
export class Replica {
  readonly listeners = new Set<(id: string) => void>();
  readonly membershipListeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private active = true;
  private writable = true;
  private notifying = false;
  lastMutation = Date.now();
  get peers() {
    return (
      this.access.repository.repo.peers.length +
      (this.access.repository.repo.isSubductionConnected() ? 1 : 0)
    );
  }
  error = "";
  readonly handle: DocHandle<WorkspaceDocument>;
  readonly graph: DocumentGraph;
  readonly computerSettings: ComputerSettings;
  readonly projection: DocumentProjection;
  constructor(
    readonly identity: Identity,
    public access: WorkspaceAccess,
    public storage: DurableStorage,
  ) {
    this.handle = access.handle;
    this.graph = new DocumentGraph(access, (id) => this.changed(id));
    this.projection = new DocumentProjection(
      this,
      {
        load: () =>
          storage.projectionCheckpoints?.(this.workspaceId) ??
          Promise.resolve([]),
        apply: (batch) =>
          storage.applyProjection?.(this.workspaceId, batch) ??
          Promise.resolve(),
      },
      "core-sql-1",
      false,
    );
    this.computerSettings = new ComputerSettings(
      access.computer,
      access.repository,
    );
    this.access.repository.hive.emitter.on("update", this.membershipChanged);
  }
  get workspaceId() {
    return this.handle.doc()!.id;
  }
  get member() {
    return this.access.membership.members[this.identity.id];
  }
  private assertActive() {
    invariant(this.active, "WORKSPACE_CLOSED", "This workspace is closed");
  }
  private remoteScheduled = false;
  private dirty = new Set<string>();
  private membershipScheduled = false;
  private changed = (id = "") => {
    this.projection.invalidate(id);
    if (!this.active || !this.writable || this.notifying) return;
    this.dirty.add(id);
    if (this.remoteScheduled) return;
    this.remoteScheduled = true;
    const next = this.queue.then(async () => {
      this.remoteScheduled = false;
      const ids = [...this.dirty];
      this.dirty.clear();
      await this.publish(ids);
    });
    this.queue = next.catch((error) => {
      if (this.writable) this.error = String(error);
    });
  };
  private membershipChanged = () => {
    if (!this.active || !this.writable || this.membershipScheduled) return;
    this.membershipScheduled = true;
    const next = this.queue.then(async () => {
      this.membershipScheduled = false;
      const before = canonical(this.access.membership);
      await refreshMembership(this.access);
      if (before === canonical(this.access.membership)) return;
      this.projection.invalidate();
      await this.publish([""]);
      for (const listener of this.membershipListeners) listener();
    });
    this.queue = next.catch((error) => {
      if (this.writable) this.error = String(error);
    });
  };
  private async publish(ids: string[] = []) {
    await this.graph.refresh();
    await refreshMembership(this.access);
    await this.access.repository.flush();
    const batch = await this.projection.synchronize();
    this.lastMutation = Date.now();
    for (const key of new Set([
      ...ids,
      ...batch.documents.map((doc) => doc.id),
      ...batch.removed,
    ]))
      for (const listener of this.listeners) listener(key);
  }
  async open(progress: (message: string) => void = () => {}) {
    progress("Loading Automerge workspace…");
    await this.graph.refresh();
    await refreshMembership(this.access);
    await this.projection.synchronize();
    return this;
  }
  ids(prefix = "") {
    this.assertActive();
    return this.graph.ids(prefix);
  }
  read<T = Record<string, unknown>>(id: string): T | undefined {
    this.assertActive();
    return this.graph.read<T>(id);
  }
  heads(id: string) {
    return this.graph.heads(id);
  }
  hasHeads(_id: string, heads: string[]) {
    return heads.every((head) =>
      this.graph
        .sharedHandles()
        .some((handle) => A.hasHeads(handle.doc()!, [head])),
    );
  }
  metadataReady() {
    return this.graph.isReady();
  }
  readiness(id: string): DocumentReadiness {
    const value = this.read(id);
    return !this.metadataReady()
      ? "loading"
      : value?.deletedAt
        ? "deleted"
        : value
          ? "ready"
          : "missing";
  }
  conflicts(id: string, field: string, nested = false) {
    const value = this.graph.target(id);
    const plugins = id === "setting/workspace" && field.startsWith("plugins.");
    const target = nested ? value?.data : plugins ? value?.plugins : value;
    return target
      ? (A.getConflicts(
          target as Record<string, unknown>,
          plugins ? field.slice(8) : field,
        ) ?? {})
      : {};
  }
  update(
    id: string,
    value: Record<string, unknown>,
    resolveFields: string[] = [],
    location?: { schemaId: string; pluginId: string },
  ) {
    this.assertActive();
    invariant(this.writable, "BUSY", "Workspace is closing");
    const next = this.queue.then(async () => {
      await this.graph.refresh();
      await refreshMembership(this.access);
      invariant(
        this.member?.access === "write",
        "PERMISSION_DENIED",
        "Workspace is read only",
      );
      invariant(
        /^(record|setting|file|event|job|vault|blob)\/[a-zA-Z0-9_.:-]{1,256}$/.test(
          id,
        ) ||
          /^state\/[a-z0-9.-]+\/[a-zA-Z0-9-]+\/[a-z0-9.-]+\/[a-zA-Z0-9_.:-]{1,256}$/.test(
            id,
          ),
        "INVALID_DOCUMENT",
        "Invalid document identifier",
      );
      const previous = this.read(id);
      if (id === "setting/workspace") validateWorkspaceSettings(value);
      if (id.startsWith("record/")) {
        invariant(
          value.id === id.slice(7) && value.workspaceId === this.workspaceId,
          "INVALID_RECORD",
          "Record identity does not match its workspace document",
        );
        const schema = schemaById.get(String(value.collection));
        if (schema && Number(value.schemaVersion ?? 1) <= schema.version)
          validateRecord(schema, value.data);
        if (previous) {
          for (const field of [
            "id",
            "workspaceId",
            "ownerId",
            "pluginId",
            "collection",
            "createdAt",
            "managedBy",
          ])
            invariant(
              canonical(previous[field]) === canonical(value[field]),
              "INVALID_RECORD",
              `Immutable record field changed: ${field}`,
            );
          const before = previous.data as Record<string, unknown>,
            after = value.data as Record<string, unknown>;
          if (before?.item_id)
            invariant(
              before.item_id === after?.item_id,
              "INVALID_RECORD",
              "A plugin entry's shared item is immutable",
            );
          if (["items", "tables"].includes(String(value.collection)))
            invariant(
              before?.schema_id === after?.schema_id,
              "INVALID_RECORD",
              "An existing item or table cannot change schemas",
            );
        }
      }
      if (id.startsWith("setting/service.") && previous) {
        if (previous.deviceId === value.deviceId)
          invariant(
            previous.generation === value.generation,
            "INVALID_EXECUTION",
            "A generation changes only when an item moves to another computer",
          );
        else {
          const token = await serviceToken(previous),
            release = this.read<{
              deviceId: string;
              successor?: { deviceId: string; generation: string };
            }>(`setting/service-release.${id.slice(16)}.${token}`);
          invariant(
            release && release.deviceId === previous.deviceId,
            "SERVICE_BUSY",
            "The previous device must release this service before it can move",
          );
          if (value.resourceId)
            invariant(
              release.successor?.deviceId === value.deviceId &&
                release.successor?.generation === value.generation,
              "SERVICE_CHANGED",
              "The previous computer released this item to a different assignment",
            );
        }
      }
      if (id.startsWith("setting/service-release.")) {
        invariant(
          value.deviceId === this.identity.id,
          "PERMISSION_DENIED",
          "Only the assigned device can release its service",
        );
        invariant(
          !previous || canonical(previous) === canonical(value),
          "INVALID_CHANGE",
          "Service releases are immutable",
        );
      }
      this.notifying = true;
      try {
        const patch = (target: Record<string, unknown>) => {
          for (const key of new Set([
            ...Object.keys(target),
            ...Object.keys(value),
          ])) {
            if (!(key in value) || value[key] === undefined) {
              delete target[key];
              continue;
            }
            if (
              (key === "data" || key === "plugins") &&
              value[key] &&
              typeof value[key] === "object" &&
              !Array.isArray(value[key])
            ) {
              target[key] ??= {};
              const inner = target[key] as Record<string, unknown>,
                incoming = value[key] as Record<string, unknown>;
              for (const field of new Set([
                ...Object.keys(inner),
                ...Object.keys(incoming),
              ])) {
                if (!(field in incoming) || incoming[field] === undefined)
                  delete inner[field];
                else if (
                  canonical(inner[field]) !== canonical(incoming[field]) ||
                  resolveFields.includes(key + "." + field)
                )
                  inner[field] = structuredClone(incoming[field]);
              }
            } else if (
              canonical(target[key]) !== canonical(value[key]) ||
              resolveFields.includes(key)
            )
              target[key] = structuredClone(value[key]);
          }
        };
        if (id === "setting/workspace" || id.startsWith("setting/plugin.")) {
          this.graph.sharedSettings().change((doc) => {
            doc.values[id] ??= {};
            patch(doc.values[id]);
          });
        } else {
          const handle = await this.graph.ensureItem(id, value, location);
          handle.change((doc) => patch(doc.value));
        }
      } finally {
        this.notifying = false;
      }
      await this.publish([id]);
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async editGraph<T>(work: () => Promise<T>) {
    this.assertActive();
    invariant(this.writable, "BUSY", "Workspace is closing");
    const next = this.queue.then(async () => {
      await this.graph.refresh();
      this.notifying = true;
      let value: T;
      try {
        value = await work();
      } finally {
        this.notifying = false;
      }
      await this.publish();
      return value;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async updateMany(updates: { id: string; value: Record<string, unknown> }[]) {
    for (const update of updates) await this.update(update.id, update.value);
  }
  status(): ReplicaStatus {
    return {
      documents: this.ids().filter((id) => !id.startsWith("blob/")).length,
      changes: this.graph
        .sharedHandles()
        .reduce(
          (count, handle) => count + A.stats(handle.doc()!).numChanges,
          0,
        ),
      ready: this.metadataReady(),
      peers: this.peers,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  async whenDocument<T = Record<string, unknown>>(
    id: string,
    timeout = 15000,
  ): Promise<T> {
    const existing = this.read<T>(id);
    if (existing) return existing;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(Error("The required workspace update has not arrived"));
      }, timeout);
      const check = () => {
        const value = this.read<T>(id);
        if (value) {
          clearTimeout(timer);
          this.listeners.delete(check);
          resolve(value);
        }
      };
      this.listeners.add(check);
      check();
    });
  }
  async freezeWrites() {
    this.writable = false;
    await this.flush();
  }
  /** Rebuild this device's SQL view without changing shared documents/history. */
  rebuildProjection() {
    this.assertActive();
    const next = this.queue.then(async () => {
      await this.graph.refresh();
      await refreshMembership(this.access);
      await this.access.repository.flush();
      await this.projection.synchronize(true);
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async flush() {
    await this.queue;
    await this.computerSettings.flush();
    if (this.writable) await this.publish();
    else await this.access.repository.flush();
  }
  deactivate() {
    this.active = false;
    this.graph.stop();
    this.projection.stop();
    this.access.repository.hive.emitter.off("update", this.membershipChanged);
    this.listeners.clear();
    this.membershipListeners.clear();
  }
}
