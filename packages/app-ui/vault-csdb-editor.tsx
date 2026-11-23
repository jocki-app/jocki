import { useReportedError, ErrorToast } from "./errors";
import { useMemo, useState } from "react";
import {
  CSDBDraft,
  parseCSDB,
  type Row,
  type RowValue,
} from "../core/vaults/csdb";
import { columnType, decodeCell, typeInfo } from "@csvdatabase/csdb/portable";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../ui/primitives/table";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { LegacySelect } from "../ui/choice-select";
import { CSDBSQLResult } from "./vault-sql-result";
export { newCSDB } from "../core/vaults/csdb";

/** Generic table editor. Every write goes through the official CSDB command API. */
export function CSDBEditor({
  value,
  onChange,
  tasks = false,
}: {
  value: string;
  onChange(value: string): void;
  tasks?: boolean;
}) {
  const [selected, setSelected] = useState("");
  const [sql, setSQL] = useState(() => {
    try {
      return "SELECT * FROM " + parseCSDB(value).tableOrder[0];
    } catch {
      return "";
    }
  });
  const [result, setResult] = useState<unknown>(),
    [, setError] = useReportedError("vault-csdb-editor"),
    [title, setTitle] = useState("");
  const parsed = useMemo(() => {
    try {
      return { doc: parseCSDB(value) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [value]);
  if (!parsed.doc)
    return (
      <>
        <ErrorToast error={parsed.error} source="csdb-parse" />
        <p className="p-4 text-muted-foreground">
          This file could not be displayed. Details are available in Local logs.
        </p>
      </>
    );
  const doc = parsed.doc,
    table = doc.tables.get(selected) ?? doc.tables.values().next().value;
  const editable = Boolean(table?.schema.primary_key?.columns.length);
  const mutate = (work: (draft: CSDBDraft) => void) => {
    try {
      const draft = new CSDBDraft(value);
      work(draft);
      onChange(draft.toString());
      setError("");
    } catch (error) {
      setError(error);
    }
  };
  const match = (row: Row) =>
    Object.fromEntries(
      table!.schema.primary_key!.columns.map((key) => [key, row[key]]),
    );
  const text = (value: RowValue) =>
    value !== null && typeof value === "object"
      ? JSON.stringify(value, (_key, item) =>
          typeof item === "bigint" ? String(item) : item,
        )
      : String(value ?? "");
  return (
    <section className="vault-csdb">
      <div className="vault-toolbar">
        <label>
          Table{" "}
          <LegacySelect
            value={table?.name ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {doc.tableOrder.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </LegacySelect>
        </label>
        <span>{table?.rows.length ?? 0} rows</span>
      </div>
      {!editable && (
        <p className="p-4 text-muted-foreground">
          Row editing requires a primary key so a command can identify the row.
        </p>
      )}
      {table && (
        <div className="vault-table-scroll">
          <Table>
            <TableHeader>
              <TableRow>
                {Object.keys(table.schema.columns).map((column) => (
                  <TableHead key={column}>{column}</TableHead>
                ))}
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((row, index) => (
                <TableRow key={index}>
                  {Object.keys(table.schema.columns).map((column) => (
                    <TableCell key={column}>
                      <Input
                        aria-label={`${column} row ${index + 1}`}
                        key={text(row[column])}
                        defaultValue={text(row[column])}
                        disabled={!editable}
                        onBlur={(event) => {
                          if (event.target.value === text(row[column])) return;
                          mutate((draft) => {
                            const definition = columnType(table, column),
                              kind = typeInfo(definition).canonical,
                              raw = event.target.value;
                            const next =
                              kind === "array" || kind === "json"
                                ? raw === "" &&
                                  !table.schema.required.includes(column)
                                  ? null
                                  : (JSON.parse(raw) as RowValue)
                                : decodeCell(
                                    column,
                                    definition,
                                    {
                                      text: raw,
                                      quoted:
                                        raw === "" &&
                                        table.schema.required.includes(column),
                                    },
                                    table.schema.required.includes(column),
                                  );
                            draft
                              .table(table.name)
                              .where(match(row))
                              .update({ [column]: next });
                          });
                        }}
                      />
                    </TableCell>
                  ))}
                  <TableCell>
                    <Button
                      aria-label={`Delete row ${index + 1}`}
                      disabled={!editable}
                      onClick={() =>
                        mutate((draft) => {
                          draft.table(table.name).where(match(row)).delete();
                        })
                      }
                    >
                      ×
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {table && (
        <form
          className="vault-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            mutate((draft) => {
              const row: Row = {};
              for (const column of Object.keys(table.schema.columns)) {
                if (column === "id") row[column] = crypto.randomUUID();
                else if (["title", "value", "name"].includes(column))
                  row[column] = title;
              }
              draft.table(table.name).insert(row);
              setTitle("");
            });
          }}
        >
          <Input
            aria-label="New row title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={tasks ? "New task" : "New row value"}
          />
          <Button type="submit">Add {tasks ? "task" : "row"}</Button>
        </form>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const draft = new CSDBDraft(value),
              result = draft.sql(sql);
            setResult(result);
            if (!Array.isArray(result)) onChange(draft.toString());
            setError("");
          } catch (error) {
            setError(error);
          }
        }}
      >
        <Textarea
          aria-label="SQL statement"
          value={sql}
          onChange={(event) => setSQL(event.target.value)}
        />
        <Button type="submit">Run SQL in draft</Button>
      </form>
      {result !== undefined && <CSDBSQLResult value={result} />}
    </section>
  );
}
