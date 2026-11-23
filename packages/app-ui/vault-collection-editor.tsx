import { ErrorToast, useReportedError } from "./errors";
import { useMemo, useState, type ReactNode } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import {
  initialFieldValues,
  queryRecords,
  type RecordSchema,
  type Value,
} from "@jocki/platform/field-types";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { CSDBEditor } from "./vault-csdb-editor";
import {
  CSDBDraft,
  csdbComparable,
  parseCSDB,
  validateCSDBType,
  selectedCSDBRows,
  type QueryPlan,
} from "../core/vaults/csdb";
import { contentTypes } from "../core/vaults/content-types";
import {
  csdbFields,
  csdbReferences,
  csdbTableDefinition,
  csdbFieldTypes,
  uiValue,
  taskColumnTemplates,
} from "./vault-csdb-fields";
import { resolveType, evaluateDefaults } from "@csvdatabase/csdb/portable";
import { CollectionView } from "../ui/collection-view";
import {
  normalizeView,
  groupDefaults,
  type CollectionViewState,
} from "../ui/collection-view-model";
import { QueryControls } from "../ui/query-controls";
import { FieldInput, ReferenceOptionsContext } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import { Checkbox } from "../ui/primitives/checkbox";
import { ChoiceSelect } from "../ui/choice-select";
import { planRowMove } from "../ui/collection-drag";
import { ColumnsTable } from "../ui/columns-table";
import { SaveStatusButton } from "../ui/save-status-button";

/** The original collection GUI, adapted only at the file-draft boundary. */
export function VaultCollectionEditor({
  value,
  baseline = value,
  onSaveRows,
  canDescribe = false,
  metadataDirty = false,
  onChange,
  tasks = false,
  preferences,
  onPreferences,
  tools,
  part = "edit",
  required = [],
}: {
  value: string;
  baseline?: string;
  onSaveRows?(
    table: string,
    ids: string[],
    description?: string,
    metadata?: boolean,
  ): Promise<void>;
  canDescribe?: boolean;
  metadataDirty?: boolean;
  onChange(value: string): void;
  tasks?: boolean;
  preferences?: Partial<CollectionViewState>;
  onPreferences?(state: CollectionViewState): void;
  tools?(controls: ReactNode): ReactNode;
  part?: "edit" | "columns";
  required?: string[];
}) {
  const [newValues, setNewValues] = useState<Record<string, Value>>({}),
    [selectedRows, setSelectedRows] = useState<string[]>([]),
    [savingRows, setSavingRows] = useState<string[]>([]);
  const [generation, reset] = useState(0);
  const [selected, setSelected] = useState(""),
    [error, setError] = useReportedError("vault-collection-editor");
  const [local, setLocal] = useState<Partial<CollectionViewState>>({});
  const parsed = useMemo(() => {
    try {
      return {
        doc: tasks
          ? validateCSDBType(
              value,
              contentTypes.find((t) => t.id === "jocki.task-list"),
            )
          : parseCSDB(value),
      };
    } catch (error) {
      return { error: String(error) };
    }
  }, [value, generation, tasks]);
  const table =
    parsed.doc?.tables.get(selected) ??
    parsed.doc?.tables.values().next().value;
  const savedTable = useMemo(() => {
    try {
      return parseCSDB(baseline).tables.get(table?.name ?? "");
    } catch {
      return undefined;
    }
  }, [baseline, table?.name]);
  const dirtyRows = useMemo(() => {
    const current = new Map(
        (table?.rows ?? []).map((row) => [String(row.id), csdbComparable(row)]),
      ),
      saved = new Map(
        (savedTable?.rows ?? []).map((row) => [
          String(row.id),
          csdbComparable(row),
        ]),
      );
    return new Set(
      [...new Set([...current.keys(), ...saved.keys()])].filter(
        (id) => current.get(id) !== saved.get(id),
      ),
    );
  }, [table, savedTable]);
  const dirtyRow = (id: string) => dirtyRows.has(id);
  const dirtyIds = [...dirtyRows];
  const saveRows = async (
    ids: string[],
    description?: string,
    metadata = false,
  ) => {
    if (!onSaveRows || !table || (!ids.length && !metadata)) return;
    setSavingRows(ids);
    try {
      await onSaveRows(table.name, ids, description, metadata);
    } finally {
      setSavingRows([]);
    }
  };
  const discardRows = (ids: string[]) => {
    if (!table) return;
    onChange(selectedCSDBRows(value, baseline, { table: table.name, ids }));
    setSelectedRows((prior) => prior.filter((id) => !ids.includes(id)));
  };
  const compatible = Object.keys(table?.schema.columns ?? {}).every((id) =>
    /^[a-z][a-z0-9_]*$/.test(id),
  );
  const schema: RecordSchema = useMemo(
    () => ({
      id: table?.name ?? "data",
      name: tasks ? "Tasks" : (table?.name ?? "Data"),
      pluginId: tasks ? "tasks" : "core.csdb",
      version: 1,
      fields: compatible && table ? csdbFields(table, tasks) : [],
    }),
    [
      table?.name,
      JSON.stringify(table?.schema),
      JSON.stringify(table?.types),
      tasks,
      compatible,
    ],
  );
  const parent = schema.fields.find(
    (field) =>
      field.relationship === "parent" && field.reference && !field.array,
  );
  const sorting = schema.fields.find((field) => field.control === "sorting");
  const defaults: Partial<CollectionViewState> = tasks
    ? {
        groups: parent
          ? [
              {
                id: "task-parent",
                field: parent.id,
                labelField: parent.id,
                enabled: true,
                mode: "recursive",
                materialize: true,
              },
            ]
          : [],
        query: sorting
          ? { sorts: [{ field: sorting.id, direction: "asc", enabled: true }] }
          : {},
      }
    : {};
  const state = normalizeView(
    { ...defaults, ...(preferences ?? local) },
    schema,
  );
  const changeView = (patch: Partial<CollectionViewState>) => {
    const next = normalizeView({ ...state, ...patch }, schema);
    setLocal(next);
    onPreferences?.(next);
  };
  const rows: ResourceRecord[] = (table?.rows ?? []).map((data, index) => ({
    id: String(data.id ?? index),
    workspaceId: "file",
    ownerId: "local",
    pluginId: schema.pluginId,
    collection: schema.id,
    revision: 0,
    createdAt: "",
    updatedAt: "",
    deletedAt: null,
    data: uiValue(data) as Record<string, Value>,
  }));
  let filtered = rows;
  try {
    filtered = queryRecords(rows, schema, state.query);
  } catch {}
  const mutate = (work: (draft: CSDBDraft) => void) => {
    try {
      const draft = new CSDBDraft(value);
      work(draft);
      const next = draft.toString();
      if (tasks)
        validateCSDBType(
          next,
          contentTypes.find((t) => t.id === "jocki.task-list"),
        );
      onChange(next);
      setError("");
    } catch (error) {
      setError(error);
      reset((n) => n + 1);
      throw error;
    }
  };
  const identity = (row: ResourceRecord) => {
    const columns = table!.schema.primary_key?.columns;
    if (!columns?.length)
      throw Error(
        "Editing rows requires a primary key. Add one through the CSDB interface.",
      );
    const data = table!.rows[rows.findIndex((r) => r.id === row.id)];
    return Object.fromEntries(columns.map((column) => [column, data[column]]));
  };
  const updatePlan = (
    row: ResourceRecord,
    patch: Record<string, Value>,
  ): QueryPlan => {
    if (!table!.schema.primary_key?.columns.length) {
      const index = rows.findIndex((candidate) => candidate.id === row.id);
      if (index < 0) throw Error("This row is no longer available");
      return {
        kind: "update",
        table: table!.name,
        row_indices: [index],
        set: patch,
      };
    }
    let where: import("@csvdatabase/csdb/portable").Expr | undefined;
    for (const [name, value] of Object.entries(identity(row))) {
      const next: import("@csvdatabase/csdb/portable").Expr = {
        type: "comparison",
        op: "=",
        left: { type: "identifier", name },
        right: { type: "literal", value },
      };
      where = where ? { type: "and", left: where, right: next } : next;
    }
    return { kind: "update", table: table!.name, set: patch, where };
  };
  const update = async (row: ResourceRecord, patch: Record<string, Value>) => {
    try {
      mutate((draft) => {
        draft.execute(updatePlan(row, patch));
      });
    } catch {}
  };
  const removeRows = (ids: string[]) => {
    mutate((draft) => {
      if (!table!.schema.primary_key?.columns.length) {
        const removed = new Set(ids);
        const retained = table!.rows.filter(
          (_row, index) => !removed.has(rows[index].id),
        );
        draft.batch([
          { kind: "delete", table: table!.name },
          { kind: "insert", table: table!.name, rows: retained },
        ]);
        return;
      }
      draft.batch(
        rows
          .filter((row) => ids.includes(row.id))
          .map(
            (row) => ({ ...updatePlan(row, {}), kind: "delete" }) as QueryPlan,
          ),
      );
    });
    if (tasks && onSaveRows) {
      setSelectedRows(ids);
      void saveRows(ids)
        .then(() => setSelectedRows([]))
        .catch(setError);
    } else setSelectedRows([]);
  };
  const perform = (work: () => void) => {
    try {
      work();
    } catch {}
  };
  if (!table || !parsed.doc)
    return (
      <>
        <ErrorToast error={parsed.error ?? "No table"} source="csdb" />
        <p className="p-4 text-muted-foreground">
          This file needs a valid table before it can be displayed.
        </p>
      </>
    );
  const controls = (
    <QueryControls
      fields={schema.fields}
      query={state.query}
      onChange={(query) => changeView({ query })}
      columns={state.columns}
      columnOrder={state.columnOrder}
      onColumns={(columns, columnOrder) => changeView({ columns, columnOrder })}
      groups={state.groups}
      onGroups={(groups) => changeView({ groups, path: [], collapsed: [] })}
      mode={state.mode}
      onMode={(mode) => changeView({ mode })}
      compact
    />
  );
  if (!compatible) return <CSDBEditor value={value} onChange={onChange} />;
  const addRow = () =>
    perform(() =>
      mutate((draft) => {
        const row: Record<string, Value> = {
          ...initialFieldValues(schema.fields),
          ...(uiValue(evaluateDefaults(table)) as Record<string, Value>),
          ...groupDefaults(filtered, schema, state),
          ...(tasks && table.schema.columns.status ? { status: "open" } : {}),
          ...newValues,
        };
        draft.table(table.name).insert(row);
        setNewValues({});
      }),
    );
  return (
    <ReferenceOptionsContext.Provider value={csdbReferences(parsed.doc!)}>
      <section
        className="min-w-0 space-y-4 p-4"
        data-record-collection={tasks ? "tasks" : table.name}
      >
        {part === "columns" ? (
          <ColumnsTable
            columns={schema.fields}
            locked={required}
            templates={tasks ? taskColumnTemplates : []}
            types={csdbFieldTypes}
            referenceTargets={Object.fromEntries(
              [...parsed.doc!.tables].map(([name, table]) => [
                name,
                Object.keys(table.schema.columns),
              ]),
            )}
            typeIds={Object.fromEntries(
              Object.entries(table.schema.columns).map(([id, definition]) => {
                const resolved = resolveType(
                  definition,
                  table.types,
                  table.schema.schema,
                ) as { type: string; items?: { type: string } };
                return [
                  id,
                  schema.fields.find((field) => field.id === id)?.reference
                    ? schema.fields.find((field) => field.id === id)
                        ?.relationship === "parent"
                      ? "parent"
                      : "reference"
                    : (resolved.type === "array"
                          ? resolved.items?.type
                          : resolved.type) === "enum"
                      ? "enum"
                      : schema.fields.find((f) => f.id === id)!.pgType,
                ];
              }),
            )}
            onSave={async (fields) =>
              mutate((draft) => {
                draft.alterTable(csdbTableDefinition(table, fields));
              })
            }
          />
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {tools ? tools(controls) : controls}

              {parsed.doc.tableOrder.length > 1 && (
                <ChoiceSelect
                  aria-label="Table"
                  className="w-36"
                  value={table.name}
                  options={parsed.doc.tableOrder.map((name) => ({
                    value: name,
                    label: name,
                  }))}
                  onValueChange={setSelected}
                />
              )}
            </div>
            <CollectionView
              schema={schema}
              showRootLabel={!tasks}
              showCount={!tasks}
              rows={filtered}
              state={state}
              onChange={changeView}
              writable={() => true}
              headerActions={
                <div className="flex items-center gap-1">
                  <Checkbox
                    aria-label="Select visible rows"
                    checked={
                      filtered.length > 0 &&
                      filtered.every((r) => selectedRows.includes(r.id))
                    }
                    onCheckedChange={(checked) =>
                      setSelectedRows(checked ? filtered.map((r) => r.id) : [])
                    }
                  />
                  {tasks &&
                    onSaveRows &&
                    (() => {
                      const ids = selectedRows.length
                        ? selectedRows
                        : dirtyIds.length
                          ? dirtyIds
                          : rows.map((row) => row.id);
                      return (
                        <SaveStatusButton
                          label={
                            selectedRows.length ? "Save selected tasks" : "Save"
                          }
                          dirty={metadataDirty || ids.some(dirtyRow)}
                          saving={savingRows.length > 0}
                          disabled={!ids.length && !metadataDirty}
                          canDescribe={canDescribe}
                          onSave={(description) =>
                            saveRows(ids, description, true)
                          }
                        />
                      );
                    })()}
                  {selectedRows.length > 0 && (
                    <>
                      <span className="text-xs">{selectedRows.length}</span>
                      {tasks && table.schema.columns.status && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Complete selected tasks"
                          onClick={() =>
                            perform(() =>
                              mutate((draft) => {
                                draft.batch(
                                  rows
                                    .filter((row) =>
                                      selectedRows.includes(row.id),
                                    )
                                    .map((row) =>
                                      updatePlan(row, { status: "done" }),
                                    ),
                                );
                              }),
                            )
                          }
                        >
                          <Check />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={
                          tasks && selectedRows.some(dirtyRow)
                            ? "Discard selected edits"
                            : "Delete selected rows"
                        }
                        disabled={savingRows.length > 0}
                        onClick={() =>
                          perform(() =>
                            tasks && selectedRows.some(dirtyRow)
                              ? discardRows(selectedRows)
                              : removeRows(selectedRows),
                          )
                        }
                      >
                        {tasks && selectedRows.some(dirtyRow) ? (
                          <X />
                        ) : (
                          <Trash2 />
                        )}
                      </Button>
                    </>
                  )}
                </div>
              }
              createRow={{
                cell: (definition) => (
                  <FieldInput
                    definition={{
                      ...definition,
                      label:
                        tasks && definition.id === "title"
                          ? "New task"
                          : "New " + definition.label,
                    }}
                    value={
                      newValues[definition.id] ??
                      (definition.id === "status" && tasks
                        ? "open"
                        : (uiValue(
                            evaluateDefaults(table)[definition.id],
                          ) as Value)) ??
                      null
                    }
                    onChange={(value) =>
                      setNewValues((prior) => ({
                        ...prior,
                        [definition.id]: value,
                      }))
                    }
                  />
                ),
                actions: (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tasks ? "Add task" : "Add row"}
                    onClick={addRow}
                  >
                    <Plus />
                  </Button>
                ),
              }}
              onUpdate={update}
              onMove={async (drop) => {
                const moves = planRowMove(filtered, schema, state, drop, rows);
                mutate((draft) => {
                  draft.batch(
                    moves.map(({ row, patch }) => updatePlan(row, patch)),
                  );
                });
              }}
              renderActions={(row, dragHandle) => (
                <>
                  <Checkbox
                    aria-label={`Select ${String(row.data.title ?? row.id)}`}
                    checked={selectedRows.includes(row.id)}
                    onCheckedChange={(checked) =>
                      setSelectedRows((prior) =>
                        checked
                          ? [...prior, row.id]
                          : prior.filter((id) => id !== row.id),
                      )
                    }
                  />
                  {dragHandle}
                  {tasks && onSaveRows && (
                    <SaveStatusButton
                      label={`Save task ${String(row.data.title ?? row.id)}`}
                      dirty={dirtyRow(row.id)}
                      saving={savingRows.includes(row.id)}
                      disabled={
                        savingRows.length > 0 && !savingRows.includes(row.id)
                      }
                      canDescribe={canDescribe}
                      onSave={(description) => saveRows([row.id], description)}
                    />
                  )}
                  {tasks && table.schema.columns.status && (
                    <Button
                      variant={
                        row.data.status === "done" ? "secondary" : "ghost"
                      }
                      size="icon-sm"
                      aria-label={`Complete ${String(row.data.title ?? row.id)}`}
                      onClick={() =>
                        void update(row, {
                          status: row.data.status === "done" ? "open" : "done",
                        })
                      }
                    >
                      <Check />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${tasks && dirtyRow(row.id) ? "Discard edits for" : "Delete"} ${String(row.data.title ?? row.id)}`}
                    disabled={savingRows.length > 0}
                    onClick={() =>
                      perform(() =>
                        tasks && dirtyRow(row.id)
                          ? discardRows([row.id])
                          : removeRows([row.id]),
                      )
                    }
                  >
                    {tasks && dirtyRow(row.id) ? <X /> : <Trash2 />}
                  </Button>
                </>
              )}
              renderCell={({ row, field: definition }) => (
                <FieldInput
                  definition={definition}
                  recordId={row.id}
                  value={row.data[definition.id]}
                  onChange={(next) =>
                    void update(row, { [definition.id]: next })
                  }
                />
              )}
            />
          </>
        )}
      </section>
    </ReferenceOptionsContext.Provider>
  );
}
