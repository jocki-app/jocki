import { notify } from "../ui/notifications";
import { ColumnsTable } from "../ui/columns-table";
import { SharedInput } from "../ui/html-controls";
import { useState, useMemo } from "react";
import { useLiveQuery } from "../data-duckdb/react";
import { Upload, Download, ArrowLeft } from "lucide-react";
import type { AppRuntime } from "./runtime";
import { RecordTable } from "./record-table";
import { download } from "./download";
import { Button } from "../ui/primitives/button";
import {
  fieldDescriptor,
  type RecordSchema,
  type Value,
} from "@jocki/platform/field-types";
import { validateTableValues } from "@jocki/platform/core/dynamic-fields";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import { schemaById } from "@jocki/platform/core/catalog";
import { belongsToTable } from "./collection-tables";

export function FilesView({ runtime }: { runtime: AppRuntime }) {
  const [busy, setBusy] = useState(false);
  async function upload(
    file: globalThis.File,
    store: ReturnType<AppRuntime["collection"]>,
  ) {
    setBusy(true);
    try {
      await runtime.writeOperation(async () => {
        const metadata = await store.put({
          name: file.name,
          media_type: file.type || "application/octet-stream",
          size: String(file.size),
        });
        await runtime.db.saveFile(runtime.principal, metadata.id, file, null);
      });
      notify.success("File uploaded.");
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }
  async function retrieve(record: ResourceRecord) {
    try {
      const version = record.data.version_id
        ? await runtime.db.fileVersions.get(String(record.data.version_id))
        : undefined;
      if (version) download(String(record.data.name), version.blob);
      else {
        await runtime.synchronize();
        download(
          String(record.data.name),
          (await runtime.fileBytes(record.id)).blob,
        );
      }
    } catch (e) {
      notify.error(e);
    }
  }
  return (
    <div className="space-y-4">
      <RecordTable
        runtime={runtime}
        collection="files"
        hideCreate
        toolbar={
          <label className="upload-button">
            <Upload size={14} />
            {busy ? "Saving…" : "Upload files"}
            <SharedInput
              hidden
              type="file"
              multiple
              disabled={busy}
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                const store = runtime.collection("files");
                await runtime.writeOperation(async () => {
                  for (const file of files) await upload(file, store);
                });
                e.target.value = "";
              }}
            />
          </label>
        }
        onOpen={(record) => void retrieve(record)}
        renderActions={(record) => (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Download file"
            onClick={() => void retrieve(record)}
          >
            <Download size={14} />
          </Button>
        )}
      />
    </div>
  );
}
export { default as CredentialsView } from "./credentials-view";
export function TablesView({ runtime }: { runtime: AppRuntime }) {
  const [selected, setSelected] = useState<ResourceRecord | null>(null);
  return selected ? (
    selected.data.collection_id ? (
      <ManagedCollectionTable
        runtime={runtime}
        table={selected}
        onBack={() => setSelected(null)}
      />
    ) : (
      <UserTable
        runtime={runtime}
        table={selected}
        onBack={() => setSelected(null)}
      />
    )
  ) : (
    <>
      <RecordTable runtime={runtime} collection="tables" onOpen={setSelected} />
    </>
  );
}
function UserTable({
  runtime,
  table: initial,
  onBack,
}: {
  runtime: AppRuntime;
  table: ResourceRecord;
  onBack: () => void;
}) {
  const table =
    useLiveQuery(
      () => runtime.collection("tables").get(initial.id),
      [runtime, initial.id],
    ) ?? initial;
  const [showColumns, setShowColumns] = useState(false);
  const columns = useMemo(() => {
    try {
      return fieldDescriptor.array().parse(table.data.columns);
    } catch {
      return [];
    }
  }, [table.data.columns]);
  const schema = useMemo<RecordSchema>(
    () => ({
      id: table.id,
      pluginId: "tables",
      name: String(table.data.name),
      version: 1,
      fields: columns,
      tables: true,
    }),
    [table.id, table.data.name, columns],
  );
  const store = useMemo(
    () => ({
      list: async () =>
        (await runtime.collection("table_rows").list())
          .filter((r) => r.data.table_id === table.id)
          .map((r) => ({ ...r, data: r.data.values as Record<string, Value> })),
      put: async (data: unknown, id?: string) => {
        const row = await runtime
          .collection("table_rows")
          .put(
            { table_id: table.id, values: validateTableValues(columns, data) },
            id,
          );
        return { ...row, data: row.data.values as Record<string, Value> };
      },
      delete: (id: string) => runtime.collection("table_rows").delete(id),
    }),
    [runtime, table.id, schema],
  );
  return (
    <div className="space-y-4">
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} />
          Tables
        </Button>
        <h2 className="font-semibold">{String(table.data.name)}</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setShowColumns(!showColumns)}
          >
            Edit columns
          </Button>
        </div>
      </div>
      {showColumns && (
        <ColumnsTable
          columns={columns}
          disabled={
            Boolean(table.managedBy) || !runtime.node.records.canWrite()
          }
          onSave={async (next) => {
            await runtime
              .collection("tables")
              .put(
                { ...table.data, columns: next as unknown as Value },
                table.id,
              );
            notify.success("Columns saved.");
          }}
        />
      )}

      <RecordTable
        runtime={runtime}
        collection="table_rows"
        viewKey={"table." + table.id}
        schemaOverride={schema}
        storeOverride={store}
        readOnly={Boolean(table.managedBy)}
      />
    </div>
  );
}
export { PeerDevicesView as DevicesView } from "./peer-devices";

function ManagedCollectionTable({
  runtime,
  table,
  onBack,
}: {
  runtime: AppRuntime;
  table: ResourceRecord;
  onBack: () => void;
}) {
  const collection = String(table.data.collection_id);
  const fields = fieldDescriptor.array().parse(table.data.columns);
  const base = schemaById.get(collection);
  const schema: RecordSchema = {
    id: collection,
    pluginId: table.managedBy ?? "tables",
    name: String(table.data.name),
    version: base?.version ?? 1,
    fields,
  };
  const store = useMemo(
    () => ({
      list: async () =>
        (
          await runtime.db.records
            .where("collection")
            .equals(collection)
            .filter((r) => !r.deletedAt)
            .toArray()
        )
          .filter((r) => belongsToTable(r, table))
          .map((r) => ({
            ...r,
            data: {
              ...r.data,
              ...((r.data.custom_fields as Record<string, Value>) ?? {}),
            },
          })),
      put: async (): Promise<ResourceRecord> => {
        throw Error("Edit this table in its owning plugin");
      },
      delete: async () => {
        throw Error("Edit this table in its owning plugin");
      },
    }),
    [runtime, collection, table],
  );
  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft />
        Tables
      </Button>
      <p className="text-sm text-muted-foreground">
        Managed by {table.managedBy}. Open that plugin to edit its columns and
        entries.
      </p>
      <RecordTable
        runtime={runtime}
        collection={base ? collection : "table_rows"}
        schemaOverride={schema}
        storeOverride={store}
        readOnly
        viewKey={"storage." + table.id}
      />
    </div>
  );
}
