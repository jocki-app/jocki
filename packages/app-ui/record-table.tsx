import { LinkedItemCreate } from "./linked-item-create";
import { LoadingSpinner } from "../ui/loading-spinner";
import { notify } from "../ui/notifications";
import { useOptimisticRecords } from "../ui/optimistic";
import { RecordSyncStatus } from "./record-sync-status";
import { EditActions } from "../ui/edit-actions";
import {
  planRowMove,
  planRowDeletion,
  type RowDrop,
} from "../ui/collection-drag";
import { executionSlots } from "../core/execution";
import { ExecutionTarget } from "./execution-target";
import { selectedCollectionTable, belongsToTable } from "./collection-tables";
import { resourceManagers } from "./managed-resources";
import { collectionColumns } from "@jocki/platform/core/collection-tables";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "../data-duckdb/react";
import { Plus, Monitor, ExternalLink } from "lucide-react";
import { getSchema } from "@jocki/platform/core/catalog";
import {
  queryRecords,
  initialFieldValues,
  decodeField,
  type Field,
  type Value,
  type RecordSchema,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
} from "../ui/primitives/dialog";
import { FieldInput, displayValue } from "../ui/fields";
import { Checkbox } from "../ui/primitives/checkbox";
import { QueryControls } from "../ui/query-controls";
import {
  CollectionView,
  type CellContext,
  type ColumnOptions,
} from "../ui/collection-view";
import {
  defaultVisibleColumns,
  normalizeView,
  visibleRecords,
  groupDefaults,
  type CollectionViewState,
} from "../ui/collection-view-model";

export interface RecordTableProps {
  /** Reuse an already loaded collection snapshot; writes still use the store. */
  rowsOverride?: ResourceRecord[];
  runtime: AppRuntime;
  collection: string;
  toolbar?: ReactNode;
  renderActions?: (
    row: ResourceRecord,
    context: {
      writable: boolean;
      update: (patch: Record<string, Value>) => Promise<void>;
    },
  ) => ReactNode;
  renderBulkActions?: (
    rows: ResourceRecord[],
    context: {
      update: (
        row: ResourceRecord,
        patch: Record<string, Value>,
      ) => Promise<void>;
      busy: boolean;
    },
  ) => ReactNode;
  onOpen?: (row: ResourceRecord) => void;
  hideCreate?: boolean;
  schemaOverride?: RecordSchema;
  storeOverride?: {
    list: () => Promise<ResourceRecord[]>;
    put: (data: any, id?: string) => Promise<ResourceRecord>;
    delete: (id: string) => Promise<unknown>;
  };
  viewKey?: string;
  readOnly?: boolean;
  /** Host supplies the owning plugin when editing managed shared resources. */
  managedAccess?: string;
  defaultView?: Partial<CollectionViewState>;
  renderCell?: (context: CellContext) => ReactNode;
  renderCard?: (row: ResourceRecord, defaultContent: ReactNode) => ReactNode;
  columnOptions?: Record<string, ColumnOptions>;
}
/** Storage/permissions adapter. Every plugin gets the same collection presentation. */
export function RecordTable({
  runtime,
  collection,
  toolbar,
  renderActions,
  renderBulkActions,
  onOpen,
  hideCreate = false,
  schemaOverride,
  storeOverride,
  viewKey,
  readOnly = false,
  managedAccess,
  defaultView,
  renderCell,
  renderCard,
  columnOptions,
  rowsOverride,
}: RecordTableProps) {
  const pending = useOptimisticRecords(runtime.optimistic);
  const baseSchema = getSchema(collection);
  const activeTable = useLiveQuery(
    () =>
      baseSchema.tables && !schemaOverride
        ? selectedCollectionTable(runtime, collection)
        : Promise.resolve(undefined),
    [runtime, collection, Boolean(schemaOverride)],
  );
  const schema = useMemo(
    () =>
      schemaOverride ??
      (activeTable
        ? {
            ...baseSchema,
            fields: collectionColumns(baseSchema, activeTable.data.columns),
          }
        : baseSchema),
    [schemaOverride, activeTable, baseSchema],
  );
  const slots = executionSlots().filter(
    (slot) => slot.collection === collection,
  );
  const [execution, setExecution] = useState<ResourceRecord | null>(null);
  const displaySchema = schema;
  const viewDefaults =
    activeTable || schemaOverride
      ? {
          ...defaultView,
          columns: defaultVisibleColumns(schema.fields),
          columnOrder: schema.fields.map((field) => field.id),
        }
      : defaultView;
  const source = useMemo(
    () => storeOverride ?? runtime.collection(collection, !schemaOverride),
    [runtime, collection, storeOverride, Boolean(schemaOverride)],
  );
  const store = useMemo(
    () =>
      !activeTable || schemaOverride
        ? source
        : {
            list: async () =>
              (await source.list())
                .filter((row) => belongsToTable(row, activeTable))
                .map((row) => ({
                  ...row,
                  data: {
                    ...row.data,
                    ...((row.data.custom_fields as Record<string, Value>) ??
                      {}),
                  },
                })),
            put: async (data: Record<string, Value>, id?: string) => {
              const old = id ? runtime.optimistic.record(id) : undefined;
              const values = { ...old?.data },
                custom = {
                  ...((old?.data.custom_fields as Record<string, Value>) ?? {}),
                };
              for (const [key, value] of Object.entries(data)) {
                if (
                  baseSchema.fields.some((f) => f.id === key) &&
                  !schema.fields.some(
                    (f) => f.id === key && f.storage === "custom",
                  )
                )
                  values[key] = value;
                else custom[key] = value;
              }
              const row = await source.put(
                { ...values, table_id: activeTable.id, custom_fields: custom },
                id,
              );
              return {
                ...row,
                data: {
                  ...row.data,
                  ...((row.data.custom_fields as Record<string, Value>) ?? {}),
                },
              };
            },
            delete: source.delete,
          },
    [runtime, source, activeTable, schemaOverride, baseSchema, schema.fields],
  );
  // Definition snapshots refresh on every storage write. Only a change of
  // source identity should clear rows; refreshes retain the current result.
  const queriedRows = useLiveQuery(
    () =>
      rowsOverride !== undefined ||
      (baseSchema.tables && !schemaOverride && !activeTable)
        ? undefined
        : store.list(),
    [runtime, collection, activeTable?.id, viewKey, rowsOverride !== undefined],
  );
  const rows = rowsOverride ?? queriedRows ?? [];
  const managedRecords =
    useLiveQuery(() => runtime.db.records.toArray(), [runtime]) ?? [];
  const linkedByItem = useMemo(() => {
    const result = new Map<string, ResourceRecord[]>();
    for (const record of managedRecords)
      if (!record.deletedAt && record.data.item_id) {
        const key = String(record.data.item_id);
        const group = result.get(key) ?? [];
        group.push(record);
        result.set(key, group);
      }
    return result;
  }, [managedRecords]);
  const canonicalRows = useMemo(
    () => new Map(managedRecords.map((row) => [row.id, row])),
    [managedRecords],
  );
  const actionRow = (row: ResourceRecord) =>
    activeTable && !schemaOverride ? (canonicalRows.get(row.id) ?? row) : row;
  const managers = useMemo(
    () => resourceManagers(managedRecords),
    [managedRecords],
  );
  const access = useLiveQuery(
    () =>
      runtime.db.getMetadata<{
        writableIds: string[];
        workspaceWrite: boolean;
        checkedAt: number;
      }>("access.snapshot"),
    [runtime],
  );
  const writable = (row?: ResourceRecord) =>
    !readOnly &&
    (!row ||
      !["tables", "variables", "credentials", "files"].includes(collection) ||
      !managers.has(row.id) ||
      managers.get(row.id) === managedAccess) &&
    (!access
      ? !row || row.ownerId === runtime.principal.userId
      : access.workspaceWrite &&
        Date.now() - access.checkedAt < 86400000 &&
        (!row ||
          (row.revision === 0 && row.ownerId === runtime.principal.userId) ||
          access.writableIds.includes(row.id)));
  const key =
    "view." +
    (viewKey ?? (activeTable ? collection + "." + activeTable.id : collection));
  const preferenceKey = `jocki.view.${runtime.profile.id}.${key}`;
  const [state, setState] = useState(() => normalizeView(viewDefaults, schema));
  const schemaFields = JSON.stringify(schema.fields);
  const current = useRef(state),
    writeQueue = useRef(Promise.resolve()),
    edits = useRef(0),
    loadedPreferenceKey = useRef("");

  const [drafts, setDrafts] = useState<Record<string, Record<string, Value>>>(
    {},
  );
  const [newValues, setNewValues] = useState<Record<string, Value>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [resetKeys, setResetKeys] = useState<Record<string, number>>({});
  const [confirmDelete, setConfirmDelete] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDrafts({});
    setSelected([]);
    setNewValues({});
  }, [key]);

  useEffect(() => {
    let canceled = false;
    const revision = ++edits.current;
    let initial = normalizeView(
      loadedPreferenceKey.current === preferenceKey
        ? current.current
        : viewDefaults,
      schema,
    );
    try {
      const local = localStorage.getItem(preferenceKey);
      if (local) initial = normalizeView(JSON.parse(local), schema);
    } catch {
      /* The durable metadata read below remains the fallback. */
    }
    loadedPreferenceKey.current = preferenceKey;
    current.current = initial;
    setState(initial);
    void runtime.db
      .getMetadata<Partial<CollectionViewState>>(key)
      .then(async (saved) => {
        // View preferences are device-only. A synchronous mirror survives a
        // reload that interrupts a pending database write transaction.
        try {
          const local = localStorage.getItem(preferenceKey);
          if (local) saved = JSON.parse(local);
        } catch {
          /* Use DuckDB when localStorage is unavailable. */
        }
        if (!saved && activeTable?.data.is_default)
          saved = await runtime.db.getMetadata<Partial<CollectionViewState>>(
            "view." + collection,
          );
        if (canceled || edits.current !== revision) return;
        const next = normalizeView(saved ?? viewDefaults, schema);
        current.current = next;
        setState(next);
      })
      .catch((e) => {
        if (!canceled) notify.error(e);
      });
    return () => {
      canceled = true;
    };
    // User-defined columns can change without a plugin schema version change.
  }, [
    runtime,
    key,
    schema.id,
    schema.version,
    schemaFields,
    activeTable?.revision,
  ]);
  const change = (patch: Partial<CollectionViewState>) => {
    edits.current++;
    const next = normalizeView({ ...current.current, ...patch }, schema);
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(next));
    } catch {
      /* DuckDB remains the fallback. */
    }
    current.current = next;
    setState(next);
    writeQueue.current = writeQueue.current
      .then(() => runtime.db.setMetadata(key, next))
      .catch((error) => {
        notify.error(error);
      });
  };
  const { filtered, queryError } = useMemo(() => {
    try {
      return {
        filtered: queryRecords(rows, schema, state.query),
        queryError: "",
      };
    } catch (error) {
      return {
        filtered: [] as ResourceRecord[],
        queryError: error instanceof Error ? error.message : String(error),
      };
    }
  }, [rows, schema, state.query]);
  useEffect(() => {
    if (queryError) notify.error(queryError);
  }, [queryError]);
  const open = (row: ResourceRecord) => {
    if (onOpen) onOpen(actionRow(row));
    else
      root.current
        ?.querySelector<HTMLElement>(
          `[data-record-id="${row.id}"] input, [data-record-id="${row.id}"] textarea`,
        )
        ?.focus();
  };
  useEffect(() => {
    const reveal = () => {
      const id = new URLSearchParams(location.hash.split("?")[1]).get("record");
      const row = rows.find((r) => r.id === id);
      if (id && row) {
        history.replaceState(null, "", location.hash.split("?")[0]);
        open(row);
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [rows, onOpen]);
  const update = async (row: ResourceRecord, patch: Record<string, Value>) => {
    try {
      if (!writable(row)) throw Error("This entry is read-only");
      const actionStore = activeTable && !schemaOverride ? source : store;
      const latest = (await actionStore.list()).find((r) => r.id === row.id);
      if (!latest) throw Error("This entry is no longer available");
      const data = { ...latest.data, ...patch };
      if (activeTable && !schemaOverride) {
        const custom = {
          ...((latest.data.custom_fields as Record<string, Value>) ?? {}),
          ...((patch.custom_fields as Record<string, Value>) ?? {}),
        };
        for (const f of schema.fields)
          if (f.storage === "custom" && Object.hasOwn(patch, f.id)) {
            custom[f.id] = patch[f.id];
            delete data[f.id];
          }
        data.custom_fields = custom;
      }
      await actionStore.put(data, row.id);
      notify.success("Entry updated.");
      void runtime.synchronize().catch(notify.error);
    } catch (error) {
      notify.error(error);
      throw error;
    }
  };
  const validInputs = (id?: string) => {
    const scope = root.current?.querySelector(
      id ? `[data-record-id="${id}"]` : "[data-create-row]",
    );
    const invalid = scope?.querySelector<HTMLInputElement>(":invalid");
    if (invalid) {
      invalid.reportValidity();
      throw Error("Correct the invalid field before saving");
    }
  };
  const editable = (f: Field) =>
    !f.generated &&
    f.visibility !== "viewable" &&
    !slots.some(
      (slot) => slot.targetField === f.id || slot.enabledField === f.id,
    );
  const saveRows = async (ids: string[]) => {
    if (busy) return;

    const writes = ids.map(async (id) => {
      const row = (await store.list()).find((row) => row.id === id);
      if (!row || !writable(row) || pending.count(id))
        throw Error("This entry is read-only, saving, or unavailable");
      validInputs(id);
      const patch = drafts[id];
      if (!patch || !Object.keys(patch).length) return;
      for (const f of schema.fields)
        if (Object.hasOwn(patch, f.id)) decodeField(f, patch[f.id]);
      const saving = store.put({ ...row.data, ...patch }, id);
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      try {
        await saving;
      } catch (error) {
        setDrafts((current) => ({
          ...current,
          [id]: { ...patch, ...current[id] },
        }));
        throw error;
      }
    });
    const results = await Promise.allSettled(writes);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      notify.error(failure.reason);
      return;
    }
    notify.success(
      ids.length === 1 ? "Entry saved." : "Selected entries saved.",
    );
    void runtime.synchronize().catch(notify.error);
  };
  const moveRow = async (drop: RowDrop) => {
    if (busy) return;
    setBusy(true);
    try {
      const latest = await store.list();
      const visible = queryRecords(latest, schema, current.current.query);
      const moves = planRowMove(visible, schema, current.current, drop, latest);
      // Validate the whole plan before the first write, including rank repairs.
      for (const { row, patch } of moves) {
        if (!writable(row) || pending.count(row.id))
          throw Error("The move would change a read-only entry.");
        for (const [id, value] of Object.entries(patch)) {
          const field = schema.fields.find((field) => field.id === id);
          if (!field || !editable(field))
            throw Error("The move would change a read-only field.");
          if (Object.hasOwn(drafts[row.id] ?? {}, id))
            throw Error(
              "Save or discard edits to the grouping or Sorting field before dragging.",
            );
          decodeField(field, value);
        }
      }
      const latestRows = new Map(
        (await store.list()).map((row) => [row.id, row]),
      );
      const updates = moves.map(({ row, patch }) => {
        const fresh = latestRows.get(row.id);
        if (
          !fresh ||
          Object.keys(patch).some(
            (id) =>
              JSON.stringify(fresh.data[id] ?? null) !==
              JSON.stringify(row.data[id] ?? null),
          )
        )
          throw Error("An entry changed during the move. Try again.");
        return { id: row.id, data: { ...fresh.data, ...patch } };
      });
      // Publish the whole move before waiting on durable writes.
      const writes = updates.map(({ id, data }) => store.put(data, id));
      setBusy(false);
      const results = await Promise.allSettled(writes);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (moves.length) {
        notify.success("Entry moved.");
        void runtime.synchronize().catch(notify.error);
      }
    } finally {
      setBusy(false);
    }
  };
  const discard = (ids: string[]) => {
    setDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => !ids.includes(id)),
      ),
    );
    setResetKeys((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, (current[id] ?? 0) + 1])),
    }));
  };
  const selectedRows = rows.filter(
    (row) => selected.includes(row.id) && writable(row),
  );
  const selectedIds = selectedRows.map((row) => row.id);
  const visibleIds = visibleRecords(filtered, schema, state)
    .filter(writable)
    .map((row) => row.id);
  const scopedDefaults = groupDefaults(filtered, schema, state);
  const deletePreview = useMemo(
    () => planRowDeletion(rows, schema, state, confirmDelete),
    [rows, schema, state, confirmDelete],
  );
  const descendantCount = deletePreview.filter(
    (row) => !confirmDelete.includes(row.id),
  ).length;
  const isDirty = (id: string) =>
    !!drafts[id] && Object.keys(drafts[id]).length > 0;
  const editingActions = (
    ids: string[],
    header = false,
    idlePrimary?: ReactNode,
  ) => (
    <EditActions
      dirty={ids.some(isDirty)}
      disabled={busy || ids.some((id) => pending.count(id) > 0)}
      idlePrimary={idlePrimary}
      onSave={() => void saveRows(ids.filter(isDirty))}
      onCancel={() => discard(ids)}
      onDelete={() => setConfirmDelete(ids)}
      deleteDisabled={!ids.length}
      labels={{
        save: header ? "Save selected entries" : "Save entry",
        cancel: header ? "Discard selected edits" : "Discard edits",
        delete: header ? "Delete selected entries" : "Delete entry",
      }}
    />
  );
  const actions = (row: ResourceRecord, dragHandle?: ReactNode) => (
    <>
      <Checkbox
        aria-label="Select entry"
        checked={selected.includes(row.id)}
        disabled={busy || !writable(row)}
        onCheckedChange={(checked) =>
          setSelected((current) =>
            checked
              ? [...new Set([...current, row.id])]
              : current.filter((id) => id !== row.id),
          )
        }
      />
      {dragHandle}
      {writable(row) ? (
        editingActions(
          [row.id],
          false,
          <RecordSyncStatus runtime={runtime} record={actionRow(row)} />,
        )
      ) : (
        <RecordSyncStatus runtime={runtime} record={actionRow(row)} />
      )}
      {onOpen && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open entry"
          onClick={() => onOpen(actionRow(row))}
        >
          <ExternalLink />
        </Button>
      )}
      {baseSchema.tables && (
        <LinkedItemCreate
          runtime={runtime}
          row={actionRow(row)}
          disabled={busy}
          readOnly={!writable(row)}
          records={linkedByItem.get(String(row.data.item_id)) ?? []}
        />
      )}
      {renderActions?.(actionRow(row), {
        writable: writable(row) && !busy && !pending.count(row.id),
        update: (patch) => update(row, patch),
      })}
      {slots.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Execution settings"
          onClick={() =>
            setExecution(execution?.id === row.id ? null : actionRow(row))
          }
        >
          <Monitor />
        </Button>
      )}
      {managers.has(row.id) && !managedAccess && (
        <span className="text-xs text-muted-foreground">
          Managed by {managers.get(row.id)}
        </span>
      )}
    </>
  );
  const inlineCell = (context: CellContext) => {
    const { row, field: f } = context;
    const content =
      writable(row) && editable(f) ? (
        <FieldInput
          key={(resetKeys[row.id] ?? 0) + ":" + f.id}
          definition={f}
          onDraftChange={() =>
            setDrafts((current) => ({
              ...current,
              [row.id]: {
                ...current[row.id],
                [f.id]: current[row.id]?.[f.id] ?? row.data[f.id] ?? null,
              },
            }))
          }
          value={
            Object.hasOwn(drafts[row.id] ?? {}, f.id)
              ? drafts[row.id][f.id]
              : row.data[f.id]
          }
          disabled={busy || pending.count(row.id) > 0}
          recordId={row.id}
          onChange={(value) =>
            setDrafts((current) => {
              const patch = { ...current[row.id] };
              if (
                JSON.stringify(value) === JSON.stringify(row.data[f.id] ?? null)
              )
                delete patch[f.id];
              else patch[f.id] = value;
              const next = { ...current };
              if (Object.keys(patch).length) next[row.id] = patch;
              else delete next[row.id];
              return next;
            })
          }
        />
      ) : (
        context.defaultContent
      );
    return renderCell
      ? renderCell({ ...context, defaultContent: content })
      : content;
  };
  const create = async () => {
    if (busy || !writable()) return;
    setBusy(true);

    try {
      validInputs();
      const data = {
        ...initialFieldValues(schema.fields),
        ...scopedDefaults,
        ...newValues,
      };
      for (const f of schema.fields)
        if (data[f.id] !== undefined) decodeField(f, data[f.id]);
      const saving = store.put(data);
      setNewValues({});
      setResetKeys((current) => ({ ...current, new: (current.new ?? 0) + 1 }));
      setBusy(false);
      const saved = await saving.catch((error) => {
        setNewValues((current) =>
          Object.keys(current).length ? current : data,
        );
        throw error;
      });
      notify.success("Entry created.");
      if (slots.length) setExecution(saved);
      void runtime.synchronize().catch(notify.error);
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  };
  // Do not accept drafts against the fallback contract while the selected
  // table is loading. Its identity and columns determine where edits belong.
  if (baseSchema.tables && !schemaOverride && !activeTable)
    return <LoadingSpinner label="Opening table…" />;
  if (rowsOverride === undefined && queriedRows === undefined)
    return <LoadingSpinner label="Loading entries…" />;
  return (
    <div
      ref={root}
      className="min-w-0 space-y-4"
      data-record-collection={collection}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <QueryControls
          defaults={normalizeView(viewDefaults, schema)}
          fields={displaySchema.fields}
          query={state.query}
          onChange={(query) => change({ query })}
          columns={state.columns}
          columnOrder={state.columnOrder}
          onColumns={(columns, columnOrder) => change({ columns, columnOrder })}
          groups={state.groups}
          onGroups={(groups) => change({ groups, path: [], collapsed: [] })}
          mode={state.mode}
          onMode={(mode) => change({ mode })}
        />
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {toolbar}
          {selectedIds.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {selectedIds.length} selected
            </span>
          )}
          {busy && (
            <span role="status" className="text-sm text-muted-foreground">
              Saving…
            </span>
          )}
        </div>
      </div>

      <CollectionView
        schema={displaySchema}
        rows={filtered}
        state={state}
        onChange={change}
        onOpen={onOpen ? open : undefined}
        renderActions={actions}
        onMove={moveRow}
        renderCell={inlineCell}
        headerActions={
          <>
            <Checkbox
              aria-label="Select all visible entries"
              disabled={busy || !visibleIds.length}
              checked={
                visibleIds.length > 0 &&
                visibleIds.every((id) => selected.includes(id))
              }
              indeterminate={
                visibleIds.some((id) => selected.includes(id)) &&
                !visibleIds.every((id) => selected.includes(id))
              }
              onCheckedChange={(checked) =>
                setSelected((current) =>
                  checked
                    ? [...new Set([...current, ...visibleIds])]
                    : current.filter((id) => !visibleIds.includes(id)),
                )
              }
            />
            {editingActions(selectedIds, true)}
            {renderBulkActions?.(selectedRows.map(actionRow), { update, busy })}
          </>
        }
        createRow={
          !hideCreate && writable()
            ? {
                actions: (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add entry"
                    disabled={busy}
                    onClick={() => void create()}
                  >
                    <Plus />
                  </Button>
                ),
                cell: (f) =>
                  editable(f) ? (
                    <FieldInput
                      key={(resetKeys.new ?? 0) + ":" + f.id}
                      definition={f}
                      value={
                        Object.hasOwn(newValues, f.id)
                          ? newValues[f.id]
                          : Object.hasOwn(scopedDefaults, f.id)
                            ? scopedDefaults[f.id]
                            : (f.default as Value | undefined)
                      }
                      disabled={busy}
                      onChange={(value) =>
                        setNewValues((current) => ({
                          ...current,
                          [f.id]: value,
                        }))
                      }
                    />
                  ) : (
                    <span className="text-muted-foreground">
                      {f.generated
                        ? "Automatic"
                        : displayValue(newValues[f.id], f)}
                    </span>
                  ),
              }
            : undefined
        }
        rowDetails={(row) =>
          execution?.id === row.id ? (
            <div className="space-y-3 p-3">
              {slots.map((slot) => (
                <ExecutionTarget
                  key={slot.id}
                  runtime={runtime}
                  resourceId={row.id}
                  slotId={slot.id}
                  readOnly={!writable(row)}
                />
              ))}
            </div>
          ) : null
        }
        renderCard={renderCard}
        columnOptions={columnOptions}
        writable={(row) => writable(row) && !busy && !pending.count(row.id)}
        onUpdate={update}
      />
      <Dialog
        open={confirmDelete.length > 0}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete([]);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deletePreview.length}{" "}
              {deletePreview.length === 1 ? "entry" : "entries"}?
            </DialogTitle>
          </DialogHeader>
          <p>
            {descendantCount > 0 && (
              <>
                This includes {descendantCount} descendant{" "}
                {descendantCount === 1 ? "entry" : "entries"}, including any
                hidden by filters or collapsed groups.{" "}
              </>
            )}
            Entries will be removed from active views. Deletions are
            synchronized when connected.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete([])}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                try {
                  setBusy(true);
                  const latest = await store.list();
                  if (
                    confirmDelete.some(
                      (id) => !latest.some((row) => row.id === id),
                    )
                  )
                    throw Error(
                      "An entry is no longer available. Review the selection before deleting.",
                    );
                  const deleting = planRowDeletion(
                    latest,
                    schema,
                    current.current,
                    confirmDelete,
                  );
                  // Check the complete subtree before staging any optimistic deletion.
                  for (const row of deleting) {
                    if (!writable(row) || pending.count(row.id))
                      throw Error(
                        "An entry or one of its descendants is read-only or still saving.",
                      );
                  }
                  const writes = deleting.map(async ({ id }) => {
                    const saving = store.delete(id);
                    setSelected((current) =>
                      current.filter((value) => value !== id),
                    );
                    discard([id]);
                    setConfirmDelete((current) =>
                      current.filter((value) => value !== id),
                    );
                    await saving;
                  });
                  setConfirmDelete([]);
                  setBusy(false);
                  const results = await Promise.allSettled(writes);
                  const failure = results.find(
                    (result) => result.status === "rejected",
                  );
                  if (failure?.status === "rejected") throw failure.reason;
                  notify.success(
                    deleting.length === 1
                      ? "Entry deleted."
                      : `${deleting.length} entries deleted.`,
                  );
                  void runtime.synchronize().catch(notify.error);
                } catch (e) {
                  notify.error(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
