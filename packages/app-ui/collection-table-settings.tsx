import { notify } from "../ui/notifications";
import { ColumnsTable } from "../ui/columns-table";
import { useState } from "react";
import { useLiveQuery } from "../data-duckdb/react";
import { getSchema } from "@jocki/platform/core/catalog";
import {
  collectionColumns,
  tableStandard,
  pluginFeatureFields,
} from "@jocki/platform/core/collection-tables";
import {
  fieldTemplate,
  sharedFieldTemplates,
  type Field,
  type Value,
} from "@jocki/platform/field-types";
import { ChoiceSelect } from "../ui/choice-select";
import { selectedCollectionTable } from "./collection-tables";
import type { AppRuntime } from "./runtime";

export function CollectionTableSettings({
  runtime,
  collection,
}: {
  runtime: AppRuntime;
  collection: string;
}) {
  const schema = getSchema(collection),
    standard = tableStandard(schema);
  const table = useLiveQuery(
    () => selectedCollectionTable(runtime, collection),
    [runtime, collection],
  );
  const [busy, setBusy] = useState(false);
  if (!table)
    return (
      <p>Open this plugin after enabling it to create its default table.</p>
    );
  const features = pluginFeatureFields(schema);
  const columns = collectionColumns(schema, table.data.columns),
    presets = [
      ...collectionColumns(schema),
      ...sharedFieldTemplates.filter(
        (f) => !schema.fields.some((existing) => existing.id === f.id),
      ),
    ];
  const writable = runtime.node.records.canWrite();
  const rawStore = runtime.db
    .scoped({ ...runtime.principal, pluginId: schema.pluginId }, "tables")
    .collection("tables");
  const store = runtime.optimisticStore("tables", rawStore, schema.pluginId);
  const save = async (
    next: Field[],
    bindings: Record<string, Value> = (table.data.bindings as Record<
      string,
      Value
    >) ?? {},
  ) => {
    collectionColumns(schema, next);
    setBusy(true);
    try {
      const space = runtime.node.records.get(String(table.data.schema_id));
      if (!space) throw Error("Schema is unavailable");
      const shared = next.filter((f) => f.scope === "shared");
      if (JSON.stringify(shared) !== JSON.stringify(space.data.columns))
        await runtime
          .collection("item_schemas", true)
          .put(
            { ...space.data, columns: shared as unknown as Value },
            space.id,
          );
      await store.put(
        {
          ...table.data,
          column_order: next.map((f) => f.id),
          columns: next.filter((f) => f.scope !== "shared") as unknown as Value,
          bindings: Object.fromEntries(
            Object.entries(bindings).filter(([role, id]) =>
              next.some(
                (f) =>
                  f.id === id &&
                  features.some(
                    (target) =>
                      target.id === role &&
                      target.pgType === f.pgType &&
                      target.array === f.array,
                  ),
              ),
            ),
          ),
        },
        table.id,
      );
      notify.success("Columns saved.");
    } catch (error) {
      notify.error(error);
      throw error;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {standard.url ? (
          <a
            className="underline"
            href={standard.url}
            target="_blank"
            rel="noreferrer"
          >
            {standard.name}
          </a>
        ) : (
          standard.name
        )}
        . Required standard contracts are locked. Optional templates become your
        own columns with independent types, input modes, defaults, and
        visibility. UID and DTSTAMP are generated automatically.
      </p>
      {collection === "reminders" && (
        <p className="text-sm text-muted-foreground">
          DISPLAY requires Description. EMAIL also requires Summary and
          Attendees. Relative triggers require a parent. Repeat and Duration
          must be used together; core validates these when saving an entry.
        </p>
      )}
      {collection === "mail" && (
        <p className="text-sm text-muted-foreground">
          Drafts can be incomplete. Sending validates the account and
          recipients; the mail library supplies the Date and From headers.
        </p>
      )}
      <ColumnsTable
        key={table.id}
        columns={columns}
        allowShared
        onSave={save}
        locked={[...standard.required, "item_id"]}
        disabled={!writable || busy}
        templates={presets.map((template) => ({
          ...fieldTemplate(template),
          scope: "plugin",
        }))}
        featureCell={
          features.length
            ? (column) => (
                <ChoiceSelect
                  aria-label={column.label + " plugin feature"}
                  placeholder="Not mapped"
                  disabled={!writable || busy}
                  value={
                    Object.entries(
                      (table.data.bindings as Record<string, Value>) ?? {},
                    ).find(([, id]) => id === column.id)?.[0] ?? ""
                  }
                  options={[
                    { value: "", label: "Not mapped" },
                    ...features
                      .filter(
                        (role) =>
                          !role.required &&
                          !["table_id", "custom_fields", "item_id"].includes(
                            role.id,
                          ) &&
                          role.pgType === column.pgType &&
                          role.array === column.array,
                      )
                      .map((role) => ({ value: role.id, label: role.label })),
                  ]}
                  onValueChange={(role) => {
                    const bindings = Object.fromEntries(
                      Object.entries(
                        (table.data.bindings as Record<string, Value>) ?? {},
                      ).filter(([, id]) => id !== column.id),
                    );
                    if (role) bindings[role] = column.id;
                    void save(columns, bindings).catch(() => {});
                  }}
                />
              )
            : undefined
        }
      />
    </div>
  );
}
