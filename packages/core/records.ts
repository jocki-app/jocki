import {
  pluginTableId,
  schemaColumns,
  joinedItemRecord,
  initialPluginColumns,
} from "./item-schemas";
import { validateReferences } from "@jocki/platform/core/field-references";
import { tableFields } from "@jocki/platform/core/dynamic-fields";
import type { Replica } from "./replica";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { getSchema } from "@jocki/platform/core/catalog";
import {
  queryRecords,
  validateRecord,
  type Query,
  type Value,
} from "@jocki/platform/field-types";
import {
  validateDynamicData,
  validateTableValues,
} from "@jocki/platform/core/dynamic-fields";
import { invariant } from "@jocki/platform/core/errors";
import { validateGraph, allNodes } from "@jocki/platform/core/workflows";
import { domainEvent } from "@jocki/platform/core/messages";
import {
  collectionColumns,
  fieldBindings,
  customValues,
  generatedValues,
  templateValues,
} from "@jocki/platform/core/collection-tables";
export function deviceRecordId(identityId: string) {
  return `${identityId.slice(0, 8)}-${identityId.slice(8, 12)}-4${identityId.slice(13, 16)}-8${identityId.slice(17, 20)}-${identityId.slice(20, 32)}`;
}
export class ReplicaRecords {
  private static writes = new WeakMap<Replica, Map<string, Promise<unknown>>>();
  constructor(readonly replica: Replica) {}
  private raw(id: string) {
    return this.replica.read<ResourceRecord>("record/" + id);
  }
  get(id: string): ResourceRecord | undefined {
    const row = this.raw(id);
    return row ? joinedItemRecord(row, (id) => this.raw(id)) : undefined;
  }
  async ensureSchema(id?: string, name = "Default", isDefault = true) {
    id ??= this.replica.graph.defaultSchemaId;
    const existing = this.get(id);
    if (existing && !existing.deletedAt) return existing;
    invariant(
      existing || this.replica.readiness("record/" + id) === "missing",
      "COPY_PENDING",
      "Schema data is still downloading. Reconnect to finish synchronization.",
    );
    return this.put(
      "item_schemas",
      { name, columns: [], is_default: isDefault },
      id,
      isDefault ? this.schemaMetadata() : {},
    );
  }
  private schemaMetadata() {
    const policy = this.replica.access.membership;
    return {
      createdAt: "1970-01-01T00:00:00.000Z",
      ownerId: policy.userId,
    };
  }
  async ensureTable(collection: string, schemaId?: string) {
    const space = schemaId ? this.get(schemaId) : await this.ensureSchema();
    invariant(
      space?.collection === "item_schemas" && !space.deletedAt,
      "INVALID_SCHEMA",
      "Choose an existing schema",
    );
    const id = await pluginTableId(
      this.replica.workspaceId,
      space.id,
      collection,
    );
    const existing = this.get(id);
    if (existing && !existing.deletedAt) return existing;
    invariant(
      existing || this.replica.readiness("record/" + id) === "missing",
      "COPY_PENDING",
      "Table data is still downloading. Reconnect to finish synchronization.",
    );
    const contract = getSchema(collection);
    return this.put(
      "tables",
      {
        name: contract.name,
        schema_id: space.id,
        collection_id: collection,
        is_default: Boolean(space.data.is_default),
        columns: initialPluginColumns(collection) as unknown as Value,
      },
      id,
      { ...this.schemaMetadata(), managedBy: contract.pluginId },
    );
  }
  all() {
    return this.replica
      .ids("record/")
      .flatMap((id) => this.replica.read<ResourceRecord>(id) ?? [])
      .map((row) => joinedItemRecord(row, (id) => this.raw(id)));
  }
  list(collection: string, query: Query = {}) {
    return queryRecords(
      this.all().filter((r) => r.collection === collection && !r.deletedAt),
      getSchema(collection),
      query,
    );
  }
  metadataReady() {
    return this.replica.metadataReady();
  }
  canWrite() {
    return Boolean(
      this.replica.member &&
      this.replica.member.access !== "read" &&
      this.metadataReady(),
    );
  }
  put(
    collection: string,
    input: unknown,
    id: string = crypto.randomUUID(),
    options: {
      ownerId?: string;
      createdAt?: string;
      eventId?: string;
      managedBy?: string;
    } = {},
  ): Promise<ResourceRecord> {
    // Read immutable metadata inside the same record's write queue. Announcements
    // and UI saves can otherwise both see a missing record and invent timestamps.
    let writes = ReplicaRecords.writes.get(this.replica);
    if (!writes) ReplicaRecords.writes.set(this.replica, (writes = new Map()));
    const work = (writes.get(id) ?? Promise.resolve()).then(() =>
      this.putInternal(collection, input, id, options),
    );
    const settled = work.catch(() => {});
    writes.set(id, settled);
    void settled.then(() => {
      if (writes!.get(id) === settled) writes!.delete(id);
    });
    return work;
  }
  private async putInternal(
    collection: string,
    input: unknown,
    id: string = crypto.randomUUID(),
    options: {
      ownerId?: string;
      createdAt?: string;
      eventId?: string;
      managedBy?: string;
    } = {},
  ) {
    invariant(
      this.replica.member?.access === "write",
      "PERMISSION_DENIED",
      "Workspace is read only",
    );
    invariant(
      this.metadataReady(),
      "COPY_PENDING",
      "Workspace metadata is still downloading",
    );
    const schema = getSchema(collection),
      old = this.get(id);
    let prepared = generatedValues(schema, input, old?.data);
    if (
      collection === "tables" &&
      prepared.collection_id &&
      !prepared.schema_id
    )
      prepared.schema_id = (
        await this.ensureSchema(
          crypto.randomUUID(),
          String(prepared.name),
          false,
        )
      ).id;
    if (schema.tables && !prepared.table_id)
      prepared.table_id = (await this.ensureTable(collection)).id;
    const definition =
      schema.tables && prepared.table_id
        ? this.get(String(prepared.table_id))
        : undefined;
    if (schema.tables && prepared.item_id) {
      const item = this.raw(String(prepared.item_id));
      if (item?.collection === "items" && !item.deletedAt)
        prepared.custom_fields = {
          ...(item.data.values as Record<string, Value>),
          ...((prepared.custom_fields as Record<string, Value>) ?? {}),
        };
    }
    if (
      definition?.collection === "tables" &&
      definition.data.collection_id === collection
    )
      prepared = templateValues(
        schema,
        schemaColumns(definition, (id) => this.get(id)),
        prepared,
        old?.data,
        definition.data.bindings ?? {},
      );
    const data = validateRecord(schema, prepared);
    invariant(this.canWrite(), "PERMISSION_DENIED", "Workspace is read only");
    invariant(
      !old || old.collection === collection,
      "PERMISSION_DENIED",
      "Resource kind cannot change",
    );
    invariant(
      !old || schema.version >= (old.schemaVersion ?? 1),
      "SCHEMA_UPGRADE_REQUIRED",
      "Update this plugin before editing newer data",
    );
    this.validateData(
      collection,
      data,
      id,
      old ? old.managedBy : options.managedBy,
    );
    if (collection === "workflows" && Number(data.published_version) > 0) {
      invariant(
        data.target_device_id,
        "VALIDATION_FAILED",
        "Published workflows require an explicit device",
      );
      const graph = validateGraph(data.graph),
        trusted = allNodes(graph).some((n) => n.type === "typescript");
      invariant(
        !trusted || data.allow_trusted_code === true,
        "PERMISSION_DENIED",
        "Enable trusted TypeScript before publishing code nodes",
      );
      const pin = "setting/workflow." + id + "." + data.published_version;
      if (!this.replica.read(pin))
        await this.replica.update(pin, {
          graph,
          targetDeviceId: data.target_device_id,
          trusted,
          version: data.published_version,
        });
    }
    const now = new Date().toISOString();
    const record: ResourceRecord = {
      ...((old ? old.managedBy : options.managedBy)
        ? { managedBy: old ? old.managedBy : options.managedBy }
        : {}),
      schemaVersion: schema.version,
      id,
      workspaceId: this.replica.workspaceId,
      ownerId: old?.ownerId ?? options.ownerId ?? this.replica.member.userId,
      pluginId: schema.pluginId,
      collection,
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? options.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      data,
    };
    this.validateReferences(record, old);
    if (schema.tables && definition) {
      const itemId = String(data.item_id);
      invariant(
        !old || old.data.item_id === data.item_id,
        "INVALID_ITEM",
        "An entry cannot change its shared item ID",
      );
      const item = this.raw(itemId);
      invariant(
        !item ||
          (!item.deletedAt &&
            item.collection === "items" &&
            item.data.schema_id === definition.data.schema_id),
        "INVALID_ITEM",
        "Choose an item in this schema",
      );
      invariant(
        !this.all().some(
          (r) =>
            r.id !== id &&
            !r.deletedAt &&
            r.collection === collection &&
            r.data.table_id === data.table_id &&
            r.data.item_id === itemId,
        ),
        "DUPLICATE_ITEM",
        "This plugin already has an entry for this item",
      );
      const custom = {
        ...((data.custom_fields as Record<string, Value>) ?? {}),
      };
      const values = {
        ...((item?.data.values as Record<string, Value>) ?? {}),
      };
      for (const f of schemaColumns(definition, (id) => this.get(id)).filter(
        (f) => f.scope === "shared",
      )) {
        if (Object.hasOwn(custom, f.id)) values[f.id] = custom[f.id];
        delete custom[f.id];
      }
      const sharedIds = new Set(
        schemaColumns(definition, (id) => this.get(id))
          .filter((f) => f.scope === "shared")
          .map((f) => f.id),
      );
      for (const [role, source] of Object.entries(
        (definition.data.bindings as Record<string, string>) ?? {},
      ))
        if (sharedIds.has(source)) data[role] = null;
      data.custom_fields = custom;
      if (!item || JSON.stringify(values) !== JSON.stringify(item.data.values))
        await this.put(
          "items",
          { schema_id: definition.data.schema_id, values },
          itemId,
        );
    }
    await this.replica.update(
      "record/" + id,
      record as unknown as Record<string, unknown>,
    );
    await this.event(record, "put", options.eventId);
    if (
      collection === "tables" &&
      data.collection_id &&
      old &&
      JSON.stringify(old.data.bindings ?? {}) !==
        JSON.stringify(data.bindings ?? {})
    ) {
      const target = getSchema(String(data.collection_id));
      for (const row of this.all().filter(
        (row) =>
          !row.deletedAt &&
          row.collection === target.id &&
          row.data.table_id === id,
      )) {
        const mapped = templateValues(
          target,
          data.columns,
          row.data,
          row.data,
          data.bindings ?? {},
        );
        if (JSON.stringify(mapped) !== JSON.stringify(row.data))
          await this.put(row.collection, mapped, row.id);
      }
    }
    return this.get(id)!;
  }
  async delete(id: string, eventId?: string) {
    const old = this.get(id);
    invariant(old, "NOT_FOUND", "Record not found");
    if (old.collection === "items")
      invariant(
        !this.all().some((r) => !r.deletedAt && r.data.item_id === id),
        "ITEM_IN_USE",
        "Remove linked plugin entries before deleting their shared item",
      );
    if (old.collection === "item_schemas") {
      invariant(
        !old.data.is_default,
        "DEFAULT_SCHEMA",
        "The default schema cannot be deleted",
      );
      invariant(
        !this.all().some((r) => !r.deletedAt && r.data.schema_id === id),
        "SCHEMA_NOT_EMPTY",
        "Remove the schema's items and tables first",
      );
    }
    if (old.collection === "tables") {
      invariant(
        !old.data.is_default,
        "DEFAULT_TABLE",
        "The default table cannot be deleted",
      );
      invariant(
        !this.all().some((r) => !r.deletedAt && r.data.table_id === id),
        "TABLE_NOT_EMPTY",
        "Move or delete this table's entries first",
      );
    }
    await this.replica.update("record/" + id, {
      ...old,
      deletedAt: new Date().toISOString(),
      revision: old.revision + 1,
    });
    await this.event(this.get(id)!, "delete", eventId);
  }
  private validateData(
    collection: string,
    data: Record<string, Value>,
    id: string,
    managedBy?: string,
  ) {
    invariant(
      this.replica.member?.access === "write",
      "PERMISSION_DENIED",
      "Workspace is read only",
    );
    invariant(
      this.metadataReady(),
      "COPY_PENDING",
      "Workspace metadata is still downloading",
    );
    const schema = getSchema(collection),
      old = this.get(id);
    validateDynamicData(collection, data);
    if (collection === "item_schemas") {
      const shared = tableFields(data.columns);
      invariant(
        shared.every(
          (f) =>
            f.storage === "custom" &&
            f.scope === "shared" &&
            f.id !== "item_id",
        ),
        "INVALID_SCHEMA",
        "Shared columns must use shared storage",
      );
      for (const table of this.all().filter(
        (r) =>
          !r.deletedAt && r.collection === "tables" && r.data.schema_id === id,
      )) {
        const privateFields = tableFields(table.data.columns);
        invariant(
          !shared.some((f) => privateFields.some((p) => p.id === f.id)),
          "DUPLICATE_COLUMN",
          "Shared and plugin column IDs must be distinct",
        );
      }
      for (const item of this.all().filter(
        (r) =>
          !r.deletedAt && r.collection === "items" && r.data.schema_id === id,
      ))
        validateTableValues(data.columns, item.data.values);
    }
    if (collection === "items") {
      const space = this.get(String(data.schema_id));
      invariant(
        space?.collection === "item_schemas" && !space.deletedAt,
        "INVALID_SCHEMA",
        "Choose an existing schema",
      );
      invariant(
        !old || old.data.schema_id === data.schema_id,
        "INVALID_SCHEMA",
        "An item cannot change schemas",
      );
      data.values = validateTableValues(space.data.columns, data.values);
    }
    if (collection === "tables" && old) {
      invariant(
        old.data.collection_id === data.collection_id &&
          Boolean(old.data.is_default) === Boolean(data.is_default),
        "INVALID_TABLE",
        "A table's collection and default status cannot change",
      );
    }
    if (collection === "tables" && data.collection_id) {
      const target = getSchema(String(data.collection_id));
      invariant(
        target.tables && managedBy === target.pluginId,
        "PERMISSION_DENIED",
        "Plugin tables must be created through their owning plugin",
      );
      const space = this.get(String(data.schema_id));
      invariant(
        space?.collection === "item_schemas" && !space.deletedAt,
        "INVALID_SCHEMA",
        "Choose an existing schema",
      );
      invariant(
        !old || old.data.schema_id === data.schema_id,
        "INVALID_SCHEMA",
        "A table cannot change schemas",
      );
      invariant(
        !this.all().some(
          (r) =>
            r.id !== id &&
            !r.deletedAt &&
            r.collection === "tables" &&
            r.data.schema_id === data.schema_id &&
            r.data.collection_id === data.collection_id,
        ),
        "DUPLICATE_TABLE",
        "A schema has one table per plugin collection",
      );
      invariant(
        tableFields(data.columns).every((f) => f.scope !== "shared"),
        "INVALID_SCHEMA",
        "Shared columns belong to the schema, not a plugin table",
      );
      const columns = [
        ...tableFields(data.columns),
        ...tableFields(space.data.columns),
      ];
      collectionColumns(target, columns);
      fieldBindings(target, columns, data.bindings ?? {});
      // Schema changes cannot invalidate existing rows or silently drop stored values.
      for (const row of this.all().filter(
        (r) =>
          !r.deletedAt && r.collection === target.id && r.data.table_id === id,
      ))
        validateRecord(
          target,
          templateValues(
            target,
            columns,
            row.data,
            row.data,
            data.bindings ?? {},
          ),
        );
    }
    if (collection === "tables" && !data.collection_id)
      for (const row of this.all().filter(
        (r) =>
          !r.deletedAt &&
          r.collection === "table_rows" &&
          r.data.table_id === id,
      ))
        validateTableValues(data.columns, row.data.values);
    if (schema.tables) {
      const definition = data.table_id
        ? this.get(String(data.table_id))
        : undefined;
      invariant(
        !data.table_id ||
          (definition?.collection === "tables" &&
            !definition.deletedAt &&
            definition.data.collection_id === collection &&
            definition.managedBy === schema.pluginId),
        "INVALID_TABLE",
        "Choose a table belonging to this collection",
      );
      if (definition)
        data.custom_fields = customValues(
          schema,
          schemaColumns(definition, (id) => this.get(id)),
          data.custom_fields,
          data,
        );
      else
        invariant(
          !data.custom_fields || !Object.keys(data.custom_fields).length,
          "INVALID_TABLE",
          "Custom fields require a table",
        );
    }
    if (collection === "table_rows") {
      const definition = this.get(String(data.table_id));
      invariant(
        definition?.collection === "tables" && !definition.deletedAt,
        "NOT_FOUND",
        "Table definition was not found",
      );
      data.values = validateTableValues(
        schemaColumns(definition, (id) => this.get(id)),
        {
          ...((old?.data.values as Record<string, Value>) ?? {}),
          ...(data.values as Record<string, Value>),
        },
      );
    }
  }
  private validateReferences(
    record: ResourceRecord,
    previous?: ResourceRecord,
  ) {
    validateReferences(record, previous, this.all(), (row) => {
      const definition = row.data.table_id
        ? this.get(String(row.data.table_id))
        : undefined;
      if (row.collection === "table_rows")
        return definition ? tableFields(definition.data.columns) : [];
      try {
        const contract = getSchema(row.collection);
        return definition && contract.tables
          ? collectionColumns(
              contract,
              schemaColumns(definition, (id) => this.get(id)),
            )
          : contract.fields;
      } catch {
        return [];
      }
    });
  }
  private async event(
    record: ResourceRecord,
    operation: string,
    id: string = crypto.randomUUID(),
  ) {
    if (record.collection === "devices") return;
    const event = domainEvent(
      {
        workspaceId: this.replica.workspaceId,
        userId: this.replica.member.userId,
        pluginId: record.pluginId,
        permissions: [],
      },
      record.collection + ".changed",
      record.id,
      record.revision,
      { operation },
      id,
    );
    if (!this.replica.read("event/" + id))
      await this.replica.update(
        "event/" + id,
        event as unknown as Record<string, unknown>,
      );
  }
  async resolve(id: string, field: string, value: Value) {
    const record = this.get(id);
    invariant(record, "NOT_FOUND", "Record not found");
    const schema = getSchema(record.collection);
    let prepared = { ...record.data, [field]: value };
    const definition =
      schema.tables && prepared.table_id
        ? this.get(String(prepared.table_id))
        : undefined;
    if (definition)
      prepared = templateValues(
        schema,
        schemaColumns(definition, (id) => this.get(id)),
        prepared,
        record.data,
        definition.data.bindings ?? {},
      );
    const data = validateRecord(schema, prepared);
    this.validateData(record.collection, data, id, record.managedBy);
    this.validateReferences({ ...record, data }, record);
    if (schema.tables) {
      await this.put(record.collection, data, id);
      await this.replica.update(
        "record/" + id,
        this.raw(id)! as unknown as Record<string, unknown>,
        ["data." + field],
      );
      return this.get(id)!;
    }
    await this.replica.update(
      "record/" + id,
      {
        ...record,
        data,
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      },
      ["data." + field],
    );
    return this.get(id)!;
  }
}
