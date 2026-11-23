import { validateReferences } from "@jocki/platform/core/field-references";
import { CacheDatabase, liveQuery, type Table } from "./cache";
import type { SearchDocument } from "@jocki/platform/plugin-sdk/navigation";
import {
  generatedValues,
  collectionColumns,
  fieldBindings,
  customValues,
  templateValues,
} from "@jocki/platform/core/collection-tables";
import type {
  Mutation,
  Principal,
  ResourceRecord,
} from "@jocki/platform/plugin-sdk";
import {
  getSchema,
  manifestById,
  isRequiredCore,
} from "@jocki/platform/core/catalog";
import { invariant } from "@jocki/platform/core/errors";
import {
  validateRecord,
  queryRecords,
  type Query,
} from "@jocki/platform/field-types";
import type { PluginState } from "@jocki/platform/core/registry";
import {
  tableFields,
  validateDynamicData,
  validateTableValues,
} from "@jocki/platform/core/dynamic-fields";

export interface PendingMutation extends Mutation {
  sequence?: number;
  state: "pending" | "sending" | "conflict" | "rejected";
  error?: string;
  serverRecord?: ResourceRecord;
}
export interface FileVersion {
  id: string;
  fileId: string;
  parentVersionId: string | null;
  blob: Blob;
  createdAt: string;
  synced: boolean;
  error?: string;
  recoveryFileId?: string;
}
interface Metadata {
  key: string;
  value: unknown;
}
export class LocalDatabase extends CacheDatabase {
  replicaBridge?: {
    canWrite(): boolean;
    put(
      collection: string,
      data: unknown,
      id: string,
      managedBy?: string,
    ): Promise<ResourceRecord>;
    delete(id: string): Promise<void>;
    saveFile(id: string, blob: Blob, parent: string | null): Promise<string>;
  };
  declare records: Table<ResourceRecord, string>;
  declare outbox: Table<PendingMutation, number>;
  declare metadata: Table<Metadata, string>;
  declare plugins: Table<PluginState, string>;
  declare fileVersions: Table<FileVersion, string>;
  declare searchDocuments: Table<SearchDocument, string>;
  constructor(
    public readonly workspaceId: string,
    public readonly userId: string,
    name?: string,
  ) {
    super(name ?? `jocki-duckdb-cache-v2-${userId}-${workspaceId}`, {
      records: { key: "id", volatile: true },
      outbox: { key: "sequence", auto: true },
      metadata: { key: "key" },
      plugins: { key: "id" },
      fileVersions: { key: "id" },
      searchDocuments: { key: "id" },
    });
  }
  pluginPersistence() {
    return {
      load: () => this.plugins.toArray(),
      save: async (state: PluginState) => {
        await this.plugins.put(state);
      },
    };
  }
  async getMetadata<T>(key: string): Promise<T | undefined> {
    return (await this.metadata.get(key))?.value as T | undefined;
  }
  async setMetadata(key: string, value: unknown) {
    await this.metadata.put({ key, value });
  }
  async canWrite(record?: ResourceRecord) {
    if (this.replicaBridge) return this.replicaBridge.canWrite();
    const snapshot = await this.getMetadata<{
      writableIds: string[];
      workspaceWrite: boolean;
      checkedAt: number;
    }>("access.snapshot");
    if (!snapshot) return !record || record.ownerId === this.userId;
    if (!snapshot.workspaceWrite || Date.now() - snapshot.checkedAt > 86400000)
      return false;
    return (
      !record ||
      (record.revision === 0 && record.ownerId === this.userId) ||
      snapshot.writableIds.includes(record.id)
    );
  }
  scoped(
    principal: Principal,
    pluginId: string,
    sync: "synced" | "local-only" | "cache" = "local-only",
  ) {
    invariant(
      principal.userId === this.userId &&
        principal.workspaceId === this.workspaceId,
      "PERMISSION_DENIED",
      "Storage scope mismatch",
    );
    const manifest = manifestById.get(pluginId);
    invariant(
      manifest && manifest.storage.local.mode !== "none",
      "UNDECLARED_CAPABILITY",
      "Plugin did not declare local persistence",
    );
    const collection = (id: string) => {
      invariant(
        manifest.storage.local.collections.includes(id),
        "UNDECLARED_COLLECTION",
        `Collection ${id} is not declared by ${pluginId}`,
      );
      const schema = getSchema(id);
      const authorize = async (database: LocalDatabase = this) => {
        const state = await database.plugins.get(pluginId);
        invariant(
          isRequiredCore(pluginId) || state?.enabled,
          "FEATURE_DISABLED",
          `${pluginId} is disabled`,
        );
      };
      const list = async (query: Query = {}) => {
        await authorize();
        const rows = (
          await this.records.where("collection").equals(id).toArray()
        ).filter(
          (r) => !r.deletedAt && r.workspaceId === principal.workspaceId,
        );
        return queryRecords(rows, schema, query);
      };
      return {
        list,
        observe: (query: Query = {}) => liveQuery(() => list(query)),
        get: async (resourceId: string) => {
          await authorize();
          const record = await this.records.get(resourceId);
          invariant(
            !record || record.collection === id,
            "PERMISSION_DENIED",
            "Resource belongs to another collection",
          );
          return record;
        },
        put: async (
          input: unknown,
          resourceId: string = crypto.randomUUID(),
        ) => {
          invariant(
            sync !== "cache",
            "READ_ONLY",
            "Cache projections are ingestion-only",
          );
          const old = (await this.records.get(resourceId))?.data;
          let prepared = generatedValues(schema, input, old);
          if (this.replicaBridge) {
            await authorize();
            const managedBy =
              ["tables", "files", "variables", "credentials"].includes(id) &&
              !isRequiredCore(principal.pluginId) &&
              principal.pluginId !== "core"
                ? principal.pluginId
                : undefined;
            return this.replicaBridge.put(id, prepared, resourceId, managedBy);
          }
          const table =
            schema.tables && prepared.table_id
              ? await this.records.get(String(prepared.table_id))
              : undefined;
          if (table?.data.collection_id === id)
            prepared = templateValues(
              schema,
              table.data.columns,
              prepared,
              old,
              table.data.bindings ?? {},
            );
          const data = validateRecord(schema, prepared);
          const now = new Date().toISOString();
          return this.transaction(
            "rw",
            this.records,
            this.outbox,
            this.plugins,
            this.metadata,
            async (tx) => {
              await authorize(tx);
              validateDynamicData(id, data);
              if (id === "tables" && data.collection_id) {
                const target = getSchema(String(data.collection_id));
                invariant(
                  target.tables && target.pluginId === principal.pluginId,
                  "PERMISSION_DENIED",
                  "Plugin tables belong to their owning plugin",
                );
                collectionColumns(target, data.columns);
                fieldBindings(target, data.columns, data.bindings ?? {});
                const existing = await tx.records.get(resourceId);
                invariant(
                  !existing ||
                    (existing.data.collection_id === data.collection_id &&
                      Boolean(existing.data.is_default) ===
                        Boolean(data.is_default)),
                  "INVALID_TABLE",
                  "A table's collection and default status cannot change",
                );
                for (const row of await tx.records
                  .where("collection")
                  .equals(target.id)
                  .filter((r) => !r.deletedAt && r.data.table_id === resourceId)
                  .toArray())
                  customValues(
                    target,
                    data.columns,
                    row.data.custom_fields,
                    row.data,
                  );
              }
              if (schema.tables && data.table_id) {
                const definition = await tx.records.get(String(data.table_id));
                invariant(
                  definition?.collection === "tables" &&
                    !definition.deletedAt &&
                    definition.data.collection_id === id &&
                    definition.managedBy === schema.pluginId,
                  "INVALID_TABLE",
                  "Choose a table belonging to this collection",
                );
                data.custom_fields = customValues(
                  schema,
                  definition.data.columns,
                  data.custom_fields,
                  data,
                );
              }
              if (schema.tables && !data.table_id)
                invariant(
                  !data.custom_fields ||
                    !Object.keys(data.custom_fields).length,
                  "INVALID_TABLE",
                  "Custom fields require a table",
                );
              if (id === "time" && !data.ended_at) {
                const active = await tx.records
                  .where("collection")
                  .equals("time")
                  .filter(
                    (r) =>
                      !r.deletedAt &&
                      r.ownerId === principal.userId &&
                      !r.data.ended_at &&
                      r.id !== resourceId,
                  )
                  .first();
                invariant(
                  !active,
                  "TIMER_ALREADY_RUNNING",
                  "Stop the active timer before starting another",
                );
              }
              if (id === "table_rows") {
                const definition = await tx.records.get(String(data.table_id));
                invariant(
                  definition?.collection === "tables" && !definition.deletedAt,
                  "NOT_FOUND",
                  "Table definition was not found",
                );
                data.values = validateTableValues(
                  definition.data.columns,
                  data.values,
                );
              }
              const previous = await tx.records.get(resourceId);
              invariant(
                await tx.canWrite(previous),
                "PERMISSION_DENIED",
                "Editing access is unavailable; reconnect to refresh permissions",
              );
              invariant(
                !previous ||
                  (previous.collection === id && (await tx.canWrite(previous))),
                "PERMISSION_DENIED",
                "Cannot replace this resource",
              );
              const record: ResourceRecord = {
                ...(previous?.managedBy
                  ? { managedBy: previous.managedBy }
                  : !previous &&
                      ["tables", "variables", "credentials", "files"].includes(
                        id,
                      ) &&
                      !isRequiredCore(principal.pluginId) &&
                      principal.pluginId !== "core"
                    ? { managedBy: principal.pluginId }
                    : {}),
                id: resourceId,
                workspaceId: principal.workspaceId,
                ownerId: previous?.ownerId ?? principal.userId,
                pluginId,
                collection: id,
                revision: previous?.revision ?? 0,
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
                deletedAt: null,
                data,
              };
              const all = await tx.records.toArray();
              validateReferences(record, previous, all, (row) => {
                const definition = all.find((r) => r.id === row.data.table_id);
                if (row.collection === "table_rows")
                  return definition ? tableFields(definition.data.columns) : [];
                const contract = getSchema(row.collection);
                return definition && contract.tables
                  ? collectionColumns(contract, definition.data.columns)
                  : contract.fields;
              });
              await tx.records.put(record);
              if (sync === "synced")
                await tx.outbox.add({
                  id: crypto.randomUUID(),
                  resourceId,
                  pluginId,
                  collection: id,
                  operation: "put",
                  baseRevision: record.revision,
                  data,
                  createdAt: now,
                  state: "pending",
                });
              return record;
            },
          );
        },
        delete: async (resourceId: string) => {
          if (this.replicaBridge) {
            await authorize();
            const old = await this.records.get(resourceId);
            invariant(
              old?.collection === id,
              "PERMISSION_DENIED",
              "Resource belongs to another collection",
            );
            return this.replicaBridge.delete(resourceId);
          }
          invariant(
            sync !== "cache",
            "READ_ONLY",
            "Cache projections are ingestion-only",
          );
          return this.transaction(
            "rw",
            this.records,
            this.outbox,
            this.plugins,
            this.metadata,
            async (tx) => {
              await authorize(tx);
              const old = await tx.records.get(resourceId);
              invariant(
                old?.collection === id && (await tx.canWrite(old)),
                "PERMISSION_DENIED",
                "Cannot delete this resource",
              );
              const now = new Date().toISOString();
              await tx.records.put({
                ...old,
                deletedAt: now,
                updatedAt: now,
              });
              if (sync === "synced")
                await tx.outbox.add({
                  id: crypto.randomUUID(),
                  resourceId,
                  pluginId,
                  collection: id,
                  operation: "delete",
                  baseRevision: old.revision,
                  data: {},
                  createdAt: now,
                  state: "pending",
                });
            },
          );
        },
      };
    };
    return { collection };
  }
  async saveFile(
    principal: Principal,
    fileId: string,
    blob: Blob,
    parentVersionId: string | null,
  ) {
    invariant(
      principal.userId === this.userId &&
        principal.workspaceId === this.workspaceId,
      "PERMISSION_DENIED",
      "Storage scope mismatch",
    );
    if (this.replicaBridge)
      return this.replicaBridge.saveFile(fileId, blob, parentVersionId);
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    // Blob and metadata share an DuckDB transaction. Failure cannot acknowledge a partial save.
    await this.transaction(
      "rw",
      this.records,
      this.fileVersions,
      this.metadata,
      async (tx) => {
        const resource = await tx.records.get(fileId);
        invariant(
          resource?.collection === "files" && (await tx.canWrite(resource)),
          "PERMISSION_DENIED",
          "File access denied",
        );
        invariant(
          (resource.data.version_id ?? null) === parentVersionId,
          "REVISION_CONFLICT",
          "File changed since it was opened",
        );
        await tx.fileVersions.add({
          id,
          fileId,
          parentVersionId,
          blob,
          createdAt: now,
          synced: false,
        });
        await tx.records.put({
          ...resource,
          updatedAt: now,
          data: {
            ...resource.data,
            size: String(blob.size),
            media_type: blob.type || "application/octet-stream",
            version_id: id,
          },
        });
      },
    );
    return id;
  }
  async ingest(records: ResourceRecord[], cursor: string) {
    await this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.metadata,
      this.fileVersions,
      async (tx) => {
        for (const record of records) {
          invariant(
            record.workspaceId === tx.workspaceId,
            "PERMISSION_DENIED",
            "Ingestion scope mismatch",
          );
          const pending = await tx.outbox
            .where("resourceId")
            .equals(record.id)
            .count();
          if (!pending) await tx.mergeServerRecord(record);
          else
            await tx.outbox
              .where("resourceId")
              .equals(record.id)
              .modify((entry) => {
                if (entry.state === "conflict") entry.serverRecord = record;
              });
        }
        await tx.metadata.put({ key: "sync.cursor", value: cursor });
      },
    );
  }
  async acknowledge(mutationId: string, record: ResourceRecord) {
    await this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.fileVersions,
      async (tx) => {
        const mutation = await tx.outbox.where("id").equals(mutationId).first();
        if (!mutation) return;
        await tx.outbox.delete(mutation.sequence!);
        const later = await tx.outbox
          .where("resourceId")
          .equals(record.id)
          .sortBy("sequence");
        if (!later.length) await tx.mergeServerRecord(record);
        else {
          await tx.outbox.update(later[0].sequence!, {
            baseRevision: record.revision,
          });
          const local = await tx.records.get(record.id);
          if (local)
            await tx.records.put({ ...local, revision: record.revision });
        }
      },
    );
  }
  private async mergeServerRecord(record: ResourceRecord) {
    const local = await this.records.get(record.id);
    const current =
      local?.collection === "files" && local.data.version_id
        ? await this.fileVersions.get(String(local.data.version_id))
        : undefined;
    if (current && !current.synced && !current.recoveryFileId && local) {
      await this.records.put({
        ...record,
        data: {
          ...record.data,
          version_id: current.id,
          size: String(current.blob.size),
          media_type: current.blob.type || String(local.data.media_type),
          upload_state: "local",
        },
      });
    } else await this.records.put(record);
  }
  async acknowledgeFile(versionId: string, record: ResourceRecord) {
    await this.transaction(
      "rw",
      this.records,
      this.fileVersions,
      this.outbox,
      async (tx) => {
        const version = await tx.fileVersions.get(versionId);
        invariant(
          version?.fileId === record.id,
          "INVALID_RESPONSE",
          "File acknowledgement does not match the local version",
        );
        await tx.fileVersions.update(versionId, {
          synced: true,
          error: undefined,
        });
        await tx.mergeServerRecord(record);
        const next = await tx.outbox
          .where("resourceId")
          .equals(record.id)
          .first();
        if (next)
          await tx.outbox.update(next.sequence!, {
            baseRevision: record.revision,
          });
      },
    );
  }
  async reconcileAccess(ids: string[]) {
    const allowed = new Set(ids);
    await this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.fileVersions,
      this.searchDocuments,
      async (tx) => {
        const revoked = await tx.records
          .filter((r) => r.revision > 0 && !allowed.has(r.id))
          .toArray();
        for (const record of revoked) {
          await tx.records.delete(record.id);
          await tx.searchDocuments.delete(record.id);
          await tx.fileVersions.where("fileId").equals(record.id).delete();
          await tx.outbox.where("resourceId").equals(record.id).modify({
            state: "rejected",
            data: {},
            error: "Access was revoked; cached content has been removed",
          });
        }
      },
    );
  }
  async resolveConflict(
    resourceId: string,
    resolution: "server" | "local",
    revision: number,
  ) {
    return this.transaction(
      "rw",
      this.records,
      this.outbox,
      this.metadata,
      this.fileVersions,
      async (tx) => {
        const pending = await tx.outbox
            .where("resourceId")
            .equals(resourceId)
            .sortBy("sequence"),
          entry = pending[0],
          local = await tx.records.get(resourceId),
          server = entry?.serverRecord;
        invariant(
          entry?.state === "conflict" && server && local,
          "NOT_FOUND",
          "Synchronize to load both versions before resolving",
        );
        invariant(
          server.revision === revision,
          "REVISION_CONFLICT",
          "The server changed again; review the latest version",
        );
        if (resolution === "local")
          invariant(
            await tx.canWrite(server),
            "PERMISSION_DENIED",
            "Write permission is unavailable",
          );
        await tx.outbox.where("resourceId").equals(resourceId).delete();
        if (resolution === "server") {
          await tx.mergeServerRecord(server);
          return;
        }
        invariant(
          !server.deletedAt,
          "REVISION_CONFLICT",
          "The server deleted this record; export or copy the local values first",
        );
        const now = new Date().toISOString();
        await tx.records.put({
          ...local,
          revision: server.revision,
          updatedAt: now,
        });
        await tx.outbox.add({
          id: crypto.randomUUID(),
          resourceId,
          pluginId: local.pluginId,
          collection: local.collection,
          operation: local.deletedAt ? "delete" : "put",
          baseRevision: server.revision,
          data: local.deletedAt ? {} : local.data,
          createdAt: now,
          state: "pending",
        });
      },
    );
  }
}
