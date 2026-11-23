import { useState } from "react";
import { schemaById } from "@jocki/platform/core/catalog";
import { collectionColumns } from "@jocki/platform/core/collection-tables";
import type { ResourceRecord } from "@jocki/platform/plugin-sdk";
import type { Value, RecordSchema } from "@jocki/platform/field-types";
import { schemaColumns } from "../core/item-schemas";
import { Link2, Unlink, Plus, ExternalLink } from "lucide-react";
import { Button } from "../ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
} from "../ui/primitives/popover";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../ui/primitives/table";
import { RecordForm } from "../ui/fields";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import { notify } from "../ui/notifications";
import type { AppRuntime } from "./runtime";

/** Selecting a destination creates only a form draft. Saving opts this item into that plugin. */
export function LinkedItemCreate({
  runtime,
  row,
  disabled,
  readOnly,
  records = [],
}: {
  runtime: AppRuntime;
  row: ResourceRecord;
  disabled?: boolean;
  readOnly?: boolean;
  records?: ResourceRecord[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{
    schema: RecordSchema;
    table: ResourceRecord;
    initial: Record<string, Value>;
  } | null>(null);

  if (!row.data.item_id) return null;
  const table = runtime.node.records.get(String(row.data.table_id));
  if (!table) return null;
  const schemaId = String(table.data.schema_id);
  const targets = [...schemaById.values()].filter(
    (s) =>
      s.tables &&
      s.id !== row.collection &&
      (runtime.registry.enabled(s.pluginId) ||
        records.some(
          (r) =>
            r.collection === s.id &&
            r.data.item_id === row.data.item_id &&
            !r.deletedAt,
        )),
  );
  const links = targets.map((target) => {
    const definition = runtime.node.records
      .list("tables")
      .find(
        (r) =>
          r.data.schema_id === schemaId && r.data.collection_id === target.id,
      );
    return {
      target,
      linked: records.find(
        (r) =>
          !r.deletedAt &&
          r.collection === target.id &&
          r.data.item_id === row.data.item_id &&
          r.data.table_id === definition?.id,
      ),
    };
  });
  const count = links.filter((link) => link.linked).length;
  function create(id: string) {
    void (async () => {
      setOpen(false);
      const target = targets.find((s) => s.id === id)!;
      let definition = runtime.node.records
        .all()
        .find(
          (r) =>
            !r.deletedAt &&
            r.collection === "tables" &&
            r.data.schema_id === schemaId &&
            r.data.collection_id === id,
        );
      if (!definition)
        definition = await runtime.node.records.ensureTable(
          id,
          String(schemaId),
        );
      if (
        runtime.node.records
          .list(id)
          .some(
            (r) =>
              r.data.item_id === row.data.item_id &&
              r.data.table_id === definition.id,
          )
      )
        throw Error("This plugin already has an entry for this item.");
      const fields = collectionColumns(
        target,
        schemaColumns(definition, (id) => runtime.node.records.get(id)),
      );
      const shared = runtime.node.records.get(String(row.data.item_id));
      setDraft({
        schema: { ...target, fields },
        table: definition,
        initial: {
          ...((shared?.data.values as Record<string, Value>) ?? {}),
          item_id: row.data.item_id,
        },
      });
    })().catch(notify.error);
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={`Linked entries (${count})`}
              title={count ? `${count} linked entries` : "No linked entries"}
            />
          }
        >
          {count ? <Link2 /> : <Unlink />}
        </PopoverTrigger>
        <PopoverContent
          className="w-max max-w-[calc(100vw-2rem)] overflow-auto"
          align="start"
        >
          <PopoverTitle>Linked entries</PopoverTitle>
          {links.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {links.map(({ target }) => (
                    <TableHead
                      key={target.id}
                      className="whitespace-nowrap text-center"
                    >
                      {target.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  {links.map(({ target, linked }) => (
                    <TableCell key={target.id} className="text-center">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!linked && readOnly}
                        aria-label={
                          linked
                            ? `Go to ${target.name} entry`
                            : `Create linked ${target.name} entry`
                        }
                        onClick={() => {
                          if (linked) {
                            setOpen(false);
                            void runtime.navigate(
                              target.pluginId,
                              undefined,
                              linked.id,
                            );
                          } else create(target.id);
                        }}
                      >
                        {linked ? <ExternalLink /> : <Plus />}
                      </Button>
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              Enable another plugin to link this item.
            </p>
          )}
        </PopoverContent>
      </Popover>
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Create linked {draft?.schema.name.toLowerCase()} entry
            </DialogTitle>
          </DialogHeader>
          {draft && (
            <RecordForm
              key={draft.table.id + String(row.data.item_id)}
              schema={draft.schema}
              initial={draft.initial}
              onCancel={() => setDraft(null)}
              onSave={async (values) => {
                const data: Record<string, Value> = {
                  table_id: draft.table.id,
                  item_id: row.data.item_id,
                };
                const custom: Record<string, Value> = {};
                const contract = schemaById.get(draft.schema.id)!;
                for (const f of draft.schema.fields) {
                  if (values[f.id] === undefined) continue;
                  if (
                    f.storage === "custom" ||
                    !contract.fields.some((b) => b.id === f.id)
                  )
                    custom[f.id] = values[f.id];
                  else data[f.id] = values[f.id];
                }
                data.item_id = row.data.item_id;
                await runtime
                  .collection(draft.schema.id, true)
                  .put({ ...data, custom_fields: custom });
                setDraft(null);
                notify.success("Linked entry created.");
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
