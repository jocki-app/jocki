import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { fieldTypes, type Field } from "@jocki/platform/field-types";
import { EditActions } from "./edit-actions";
import { ColumnEditor } from "./column-editor";
import { notify } from "./notifications";
import { Button } from "./primitives/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./primitives/table";

const headings = {
  id: "Column ID",
  label: "Label",
  type: "Type / reference",
  input: "Input / options",
  required: "Requirement",
  visibility: "Visibility",
  default: "Default",
};

/** Shared inline schema editor. Persistence and optional plugin feature cells belong to the caller. */
export function ColumnsTable({
  columns,
  onSave,
  locked = [],
  disabled = false,
  templates = [],
  featureCell,
  allowShared = false,
  types,
  typeIds,
  referenceTargets,
}: {
  allowShared?: boolean;
  types?: typeof fieldTypes;
  typeIds?: Record<string, string>;
  referenceTargets?: Record<string, string[]>;
  columns: Field[];
  onSave: (columns: Field[]) => Promise<void>;
  locked?: readonly string[];
  disabled?: boolean;
  templates?: Field[];
  featureCell?: (column: Field) => ReactNode;
}) {
  const [draft, setDraft] = useState<Field>();
  const [draftVersion, setDraftVersion] = useState(0);
  const clearDraft = () => {
    setDraft(undefined);
    setDraftVersion((v) => v + 1);
  };
  const [busy, setBusy] = useState(false);
  const [resets, setResets] = useState<Record<string, number>>({});

  const persist = async (next: Field[]) => {
    setBusy(true);
    try {
      await onSave(next);
    } finally {
      setBusy(false);
    }
  };
  const change = (next: Field[]) => void persist(next).catch(notify.error);
  return (
    <div className="space-y-2" data-columns-table>
      {templates.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Field templates</p>
          <div className="flex flex-wrap gap-2">
            {templates
              .filter((t) => !columns.some((c) => c.id === t.id))
              .map((template) => (
                <Button
                  key={template.id}
                  variant="outline"
                  disabled={disabled || busy}
                  onClick={() => {
                    setDraft({ ...template, scope: "plugin" });
                    setDraftVersion((v) => v + 1);
                  }}
                >
                  {template.label}
                </Button>
              ))}
          </div>
        </div>
      )}
      <Table className="min-w-full w-max">
        <TableHeader>
          <TableRow>
            <TableHead data-table-actions>Actions</TableHead>
            {Object.entries(headings).map(([id, label]) => (
              <TableHead key={id}>{label}</TableHead>
            ))}
            {allowShared && <TableHead>Storage</TableHead>}
            {featureCell && <TableHead>Plugin feature</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {[undefined, ...columns].map((column, index) => {
            const id = column?.id ?? "$new";
            const lockedColumn = !!column && locked.includes(column.id);
            return (
              <ColumnEditor
                key={
                  id +
                  JSON.stringify(column) +
                  (column ? (resets[id] ?? 0) : draftVersion)
                }
                types={types}
                referenceTargets={referenceTargets}
                initialType={typeIds?.[id]}
                initial={column ?? draft}
                isNew={!column}
                allowShared={allowShared}
                standard={lockedColumn}
                disabled={disabled || busy}
                onSave={async (next) => {
                  if (
                    !column &&
                    columns.some((existing) => existing.id === next.id)
                  )
                    throw Error("This column ID already exists.");
                  await persist(
                    column
                      ? columns.map((existing) =>
                          existing.id === column.id ? next : existing,
                        )
                      : [...columns, next],
                  );
                  if (!column) clearDraft();
                }}
                render={({ cells, save, dirty }) => (
                  <TableRow
                    data-column-id={column?.id}
                    data-new-column={!column || undefined}
                  >
                    <TableCell className="align-top" data-table-actions>
                      <div className="flex flex-nowrap items-center justify-start gap-1 whitespace-nowrap [&>*]:shrink-0">
                        {!column ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Add column"
                              disabled={disabled || busy}
                              onClick={() => void save()}
                            >
                              <Plus />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Clear new column"
                              disabled={disabled || busy}
                              onClick={clearDraft}
                            >
                              <X />
                            </Button>
                          </>
                        ) : (
                          <EditActions
                            dirty={dirty || !column}
                            saveDisabled={!dirty}
                            disabled={disabled || busy}
                            onSave={() => void save()}
                            onCancel={() =>
                              column
                                ? setResets((value) => ({
                                    ...value,
                                    [id]: (value[id] ?? 0) + 1,
                                  }))
                                : clearDraft()
                            }
                            onDelete={
                              column
                                ? () =>
                                    change(
                                      columns.filter(
                                        (existing) => existing.id !== column.id,
                                      ),
                                    )
                                : undefined
                            }
                            deleteDisabled={lockedColumn}
                            labels={{
                              save: column
                                ? `Save ${column.label} column`
                                : "Save column",
                              cancel: column
                                ? `Discard ${column.label} column changes`
                                : "Cancel new column",
                              delete: column
                                ? `Remove ${column.label} column`
                                : "Remove column",
                            }}
                          />
                        )}
                        {column && (
                          <>
                            {[-1, 1].map((offset) => (
                              <Button
                                key={offset}
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Move ${column.label} ${offset < 0 ? "up" : "down"}`}
                                disabled={
                                  disabled ||
                                  busy ||
                                  index - 1 + offset < 0 ||
                                  index - 1 + offset >= columns.length
                                }
                                onClick={() => {
                                  const next = [...columns];
                                  [next[index - 1], next[index - 1 + offset]] =
                                    [next[index - 1 + offset], next[index - 1]];
                                  change(next);
                                }}
                              >
                                {offset < 0 ? <ArrowUp /> : <ArrowDown />}
                              </Button>
                            ))}
                          </>
                        )}
                      </div>
                    </TableCell>
                    {Object.entries(cells).map(([name, cell]) => (
                      <TableCell
                        key={name}
                        className="align-top min-w-40 [&_.field-row]:text-xs"
                      >
                        {cell}
                      </TableCell>
                    ))}
                    {featureCell && (
                      <TableCell className="align-top">
                        {column && featureCell(column)}
                      </TableCell>
                    )}
                  </TableRow>
                )}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
