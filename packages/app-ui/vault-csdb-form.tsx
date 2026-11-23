import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { parseCSDB, csdbComparable } from "../core/vaults/csdb";
import { evaluateDefaults, type Table } from "@csvdatabase/csdb/portable";
import {
  initialFieldValues,
  type Value,
} from "@jocki/platform/field-types";
import {
  applyCSDBFormBuffer,
  type CSDBFormSession,
  type CSDBFormBuffer,
} from "./vault-csdb-form-model";
import { csdbFields, csdbReferences, uiValue } from "./vault-csdb-fields";
import { FieldInput, ReferenceOptionsContext } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import { ChoiceSelect } from "../ui/choice-select";
import { ErrorToast, useReportedError } from "./errors";
export interface FormRow {
  table: string;
  index: number;
}
export interface CSDBFormState {
  pending: boolean;
  flush(): void;
  reset(): void;
}
export function CSDBAttributeForm({
  value,
  tasks = false,
  onChange,
  tools,
  imported,
  onState,
  session: externalSession,
}: {
  session?: CSDBFormSession;
  value: string;
  tasks?: boolean;
  onChange(value: string): void;
  tools?(controls: ReactNode): ReactNode;
  imported?: { token: string; rows: FormRow[] };
  onState?(state: CSDBFormState | undefined): void;
}) {
  const localSession = useRef<CSDBFormSession>({});
  const session = externalSession ?? localSession.current;
  const importing = !!imported && session.token !== imported.token;
  const parsed = useMemo(() => {
    try {
      return { doc: parseCSDB(value) };
    } catch (error) {
      return { error };
    }
  }, [value]);
  const [selected, setSelected] = useState(
      importing ? (imported?.rows[0]?.table ?? "") : (session.table ?? ""),
    ),
    [rowIndex, setRow] = useState(
      importing ? (imported?.rows[0]?.index ?? -1) : (session.index ?? -1),
    );
  session.table = selected;
  session.index = rowIndex;
  const [, report] = useReportedError("csdb-form"),
    child = useRef<CSDBFormState | undefined>(undefined);
  const table =
    parsed.doc?.tables.get(selected) ??
    parsed.doc?.tables.values().next().value;
  useEffect(() => {
    if (imported && session.token !== imported.token) {
      session.token = imported.token;
      session.buffer = undefined;
      setSelected(imported.rows[0]?.table ?? "");
      setRow(imported.rows[0]?.index ?? -1);
    }
  }, [imported?.token]);
  useEffect(() => {
    if (table && rowIndex >= table.rows.length && !child.current?.pending)
      setRow(-1);
  }, [table?.name, table?.rows.length, rowIndex]);
  if (parsed.error)
    return <ErrorToast error={parsed.error} source="csdb-form" />;
  if (!table)
    return (
      <p className="p-4 text-muted-foreground">
        Add a table before creating rows.
      </p>
    );
  const entries = imported?.rows.length
    ? imported.rows
    : table.rows.map((_row, index) => ({ table: table.name, index }));
  const position = entries.findIndex(
    (entry) => entry.table === table.name && entry.index === rowIndex,
  );
  const go = (name: string, index: number) => {
    try {
      child.current?.flush();
      setSelected(name);
      setRow(index);
    } catch (error) {
      report(error);
    }
  };
  const controls = (
    <div className="flex items-center gap-1" data-csdb-form-controls>
      {parsed.doc!.tables.size > 1 && (
        <ChoiceSelect
          aria-label="Form table"
          value={table.name}
          options={[...parsed.doc!.tables.keys()].map((name) => ({
            value: name,
            label: name,
          }))}
          onValueChange={(name) => go(name, -1)}
        />
      )}
      <ChoiceSelect
        aria-label="Form row"
        value={String(rowIndex)}
        options={[
          { value: "-1", label: "New row" },
          ...table.rows.map((row, index) => ({
            value: String(index),
            label: String(
              row.title ?? row.name ?? row.id ?? `Row ${index + 1}`,
            ),
          })),
        ]}
        onValueChange={(index) => go(table.name, Number(index))}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New row"
        onClick={() => go(table.name, -1)}
      >
        <Plus />
      </Button>
      {entries.length > 1 && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous row"
            disabled={position <= 0}
            onClick={() =>
              go(entries[position - 1].table, entries[position - 1].index)
            }
          >
            <ChevronLeft />
          </Button>
          <span className="whitespace-nowrap text-xs tabular-nums">
            {Math.max(0, position + 1)} / {entries.length}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next row"
            disabled={position < 0 || position >= entries.length - 1}
            onClick={() =>
              go(entries[position + 1].table, entries[position + 1].index)
            }
          >
            <ChevronRight />
          </Button>
        </>
      )}
    </div>
  );
  return (
    <ReferenceOptionsContext.Provider value={csdbReferences(parsed.doc!)}>
      <section className="min-w-0 w-full p-4" data-csdb-attribute-form>
        {tools ? tools(controls) : controls}
        <AttributeRow
          session={session}
          key={table.name + ":" + rowIndex + ":" + (imported?.token ?? "")}
          table={table}
          rowIndex={rowIndex}
          tasks={tasks}
          value={value}
          onChange={onChange}
          onApplied={(index) => setRow(index)}
          onState={(state) => {
            child.current = state;
            onState?.(state);
          }}
        />
      </section>
    </ReferenceOptionsContext.Provider>
  );
}
function AttributeRow({
  table,
  rowIndex,
  tasks,
  value,
  onChange,
  onApplied,
  onState,
  session,
}: {
  session: CSDBFormSession;
  table: Table;
  rowIndex: number;
  tasks: boolean;
  value: string;
  onChange(value: string): void;
  onApplied(index: number): void;
  onState(state: CSDBFormState | undefined): void;
}) {
  const fields = useMemo(
    () => csdbFields(table, tasks),
    [csdbComparable(table.schema), csdbComparable(table.types), tasks],
  );
  const original = table.rows[rowIndex];
  const initial = () =>
    original
      ? (uiValue(original) as Record<string, Value>)
      : {
          ...initialFieldValues(fields),
          ...(uiValue(evaluateDefaults(table)) as Record<string, Value>),
        };
  const key = table.name + ":" + rowIndex;
  const [buffer] = useState<CSDBFormBuffer>(() =>
    session.buffer?.key === key
      ? session.buffer
      : {
          key,
          table: table.name,
          index: rowIndex,
          values: initial(),
          pending: false,
          baseline: csdbComparable(original ?? null),
          optional: [],
          inputs: {},
        },
  );
  session.buffer = buffer;
  const [values, setValues] = useState(() =>
      buffer.pending ? buffer.values : initial(),
    ),
    [pending, setPending] = useState(buffer.pending),
    [optional, setOptional] = useState(buffer.optional);
  const [, report] = useReportedError("csdb-form");
  const [inputGeneration, resetInputs] = useState(0);
  buffer.values = values;
  buffer.pending = pending;
  buffer.optional = optional;
  if (!pending) buffer.baseline = csdbComparable(original ?? null);
  const flush = () => {
    if (!buffer.pending) return;
    const result = applyCSDBFormBuffer(value, buffer);
    buffer.pending = false;
    session.index = result.index;
    onChange(result.text);
    setPending(false);
    onApplied(result.index);
  };
  const reset = () => {
    buffer.inputs = {};
    buffer.pending = false;
    resetInputs((value) => value + 1);
    setValues(initial());
    setPending(false);
  };
  // The host Save and close prompts include unsubmitted form values.
  useLayoutEffect(() => {
    onState({ pending, flush, reset });
  });
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => () => onStateRef.current(undefined), []);
  useEffect(() => {
    if (!pending && original)
      setValues(uiValue(original) as Record<string, Value>);
  }, [csdbComparable(original ?? null), pending]);
  const visible = fields.filter(
    (field) =>
      field.visibility !== "hidden" &&
      (field.visibility !== "addable" ||
        values[field.id] != null ||
        optional.includes(field.id)),
  );
  const hiddenOptional = fields.filter(
    (field) =>
      field.visibility === "addable" &&
      values[field.id] == null &&
      !optional.includes(field.id),
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          if (rowIndex < 0 && !pending) buffer.pending = true;
          flush();
        } catch (error) {
          report(error);
        }
      }}
    >
      <div
        className="grid w-full grid-cols-1 gap-4 md:grid-cols-2"
        data-form-fields
      >
        {visible.map((field) => (
          <label key={field.id} className="min-w-0 space-y-1 text-sm">
            <span className="block font-medium">
              {field.label}
              {field.required && " *"}
            </span>
            <FieldInput
              key={field.id + ":" + inputGeneration}
              definition={field}
              value={values[field.id]}
              recordId={String(values.id ?? "")}
              disabled={!!field.generated}
              onDraftChange={() => setPending(true)}
              draftState={(buffer.inputs[field.id] ??= {})}
              onPendingChange={(pending) => {
                (buffer.inputs[field.id] ??= {}).pending = pending;
              }}
              onChange={(next) => {
                setValues((previous) => ({ ...previous, [field.id]: next }));
                setPending(true);
              }}
            />
            {field.description && (
              <span className="block text-xs text-muted-foreground">
                {field.description}
              </span>
            )}
          </label>
        ))}
      </div>
      {!!hiddenOptional.length && (
        <ChoiceSelect
          aria-label="Add optional field"
          value=""
          options={hiddenOptional.map((field) => ({
            value: field.id,
            label: field.label,
          }))}
          placeholder="Add a field…"
          onValueChange={(id) => setOptional((previous) => [...previous, id])}
        />
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={rowIndex >= 0 && !pending}>
          {rowIndex < 0 ? "Add row" : "Apply row changes"}
        </Button>
        {pending && (
          <Button type="button" variant="ghost" onClick={reset}>
            Discard row changes
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {pending
            ? "Unapplied row changes"
            : "Changes are saved with the file."}
        </span>
      </div>
    </form>
  );
}
